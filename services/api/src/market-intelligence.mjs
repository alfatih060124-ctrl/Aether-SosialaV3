const PROVIDER_ORIGIN = 'https://api.geckoterminal.com';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CACHE_TTL_MS = 30_000;
const STALE_FALLBACK_MS = 5 * 60_000;

function decodedBase58ByteLength(value) {
  let decoded = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return -1;
    decoded = decoded * 58n + BigInt(digit);
  }
  let significantBytes = 0;
  for (let current = decoded; current > 0n; current >>= 8n) significantBytes += 1;
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') leadingZeroBytes += 1;
  return leadingZeroBytes + significantBytes;
}

export function normalizeSolanaMint(value) {
  const mint = String(value || '').trim();
  if (!BASE58.test(mint) || decodedBase58ByteLength(mint) !== 32) throw new Error('invalid_token_mint');
  return mint;
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function tokenId(mint) { return `solana_${mint}`; }
function relationId(pool, side) { return pool?.relationships?.[`${side}_token`]?.data?.id || null; }

function normalizePool(pool, mint) {
  const attrs = pool?.attributes || {};
  const target = tokenId(mint);
  let side = null;
  if (relationId(pool, 'base') === target) side = 'base';
  else if (relationId(pool, 'quote') === target) side = 'quote';
  if (!side) return null;
  const address = normalizeSolanaMint(attrs.address);
  return {
    raw: pool,
    side,
    address,
    dex_id: pool?.relationships?.dex?.data?.id || null,
    price_usd: finiteNonNegative(attrs[`${side}_token_price_usd`]),
    liquidity_usd: finiteNonNegative(attrs.reserve_in_usd),
    volume_24h_usd: finiteNonNegative(attrs?.volume_usd?.h24),
    pool_created_at: attrs.pool_created_at || null
  };
}

function pickPool(rows, mint) {
  const candidates = (Array.isArray(rows) ? rows : []).map(row => {
    try { return normalizePool(row, mint); } catch { return null; }
  }).filter(Boolean);
  candidates.sort((a, b) => (b.liquidity_usd ?? -1) - (a.liquidity_usd ?? -1) || (b.volume_24h_usd ?? -1) - (a.volume_24h_usd ?? -1));
  return candidates[0] || null;
}

function includedToken(included, mint) {
  const target = tokenId(mint);
  const row = (Array.isArray(included) ? included : []).find(item => item?.type === 'token' && item?.id === target);
  if (!row) return null;
  const attrs = row.attributes || {};
  if (attrs.address && normalizeSolanaMint(attrs.address) !== mint) throw new Error('market_provider_canonical_mismatch');
  return { mint, name: attrs.name || null, symbol: attrs.symbol || null };
}

function tokenIdentity(info, poolsPayload, mint) {
  const infoAttrs = info?.data?.attributes || null;
  if (infoAttrs?.address && normalizeSolanaMint(infoAttrs.address) !== mint) throw new Error('market_provider_canonical_mismatch');
  const fromIncluded = includedToken(poolsPayload?.included, mint);
  return {
    mint,
    name: infoAttrs?.name || fromIncluded?.name || null,
    symbol: infoAttrs?.symbol || fromIncluded?.symbol || null
  };
}

function candles(payload) {
  const rows = payload?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return [];
  const normalized = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const timestamp = Number(row[0]);
    const open = finiteNonNegative(row[1]);
    const high = finiteNonNegative(row[2]);
    const low = finiteNonNegative(row[3]);
    const close = finiteNonNegative(row[4]);
    const volume = finiteNonNegative(row[5]);
    if (!Number.isSafeInteger(timestamp) || [open,high,low,close].some(v => v === null)) continue;
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    normalized.push({ timestamp, open, high, low, close, volume });
  }
  normalized.sort((a, b) => a.timestamp - b.timestamp);
  return normalized.slice(-96);
}

function cloneWithFreshness(value, freshness) {
  return { ...value, freshness: { ...(value.freshness || {}), ...freshness } };
}

export function createMarketIntelligenceService({ fetchImpl = globalThis.fetch, timeoutMs = 6000, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const cache = new Map();

  async function providerGet(path, { allow404 = false } = {}) {
    const url = new URL(path, PROVIDER_ORIGIN);
    if (url.origin !== PROVIDER_ORIGIN) throw new Error('market_provider_target_invalid');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(15_000, Math.max(1000, Number(timeoutMs) || 6000)));
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
      if (response.status === 404 && allow404) return null;
      if (response.status === 429) throw new Error('market_provider_rate_limited');
      if (!response.ok) throw new Error('market_provider_unavailable');
      const body = await response.json();
      if (!body || typeof body !== 'object') throw new Error('invalid_market_provider_payload');
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('market_provider_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchToken(mint) {
    const encoded = encodeURIComponent(mint);
    const [info, poolsPayload] = await Promise.all([
      providerGet(`/api/v2/networks/solana/tokens/${encoded}/info`, { allow404: true }),
      providerGet(`/api/v2/networks/solana/tokens/${encoded}/pools?include=base_token%2Cquote_token%2Cdex&page=1&sort=h24_volume_usd_liquidity_desc`)
    ]);
    const pool = pickPool(poolsPayload?.data, mint);
    if (!pool) throw new Error('market_token_not_found');
    const identity = tokenIdentity(info, poolsPayload, mint);
    const ohlcv = await providerGet(`/api/v2/networks/solana/pools/${encodeURIComponent(pool.address)}/ohlcv/minute?aggregate=15&limit=96&currency=usd&token=${pool.side}`, { allow404: true });
    const observedAt = new Date(now()).toISOString();
    return {
      token: identity,
      mint,
      market: {
        price_usd: pool.price_usd,
        liquidity_usd: pool.liquidity_usd,
        volume_24h_usd: pool.volume_24h_usd,
        pool_address: pool.address,
        dex_id: pool.dex_id,
        pool_created_at: pool.pool_created_at,
        candles: candles(ohlcv)
      },
      risk: {
        label: 'UNASSESSED',
        score: null,
        reason: 'holder_concentration_sell_path_and_token_controls_required'
      },
      signal: {
        label: 'OBSERVE_ONLY',
        state: 'INSUFFICIENT_DATA',
        reason: 'full_signal_quality_snapshot_required'
      },
      freshness: {
        stale: false,
        label: 'Fetched ≤30s · execution unverified',
        observed_at: observedAt,
        execution_ready: false
      },
      source: 'GECKOTERMINAL_PUBLIC',
      mode: 'SHADOW',
      read_only: true,
      live_execution_authorized: false
    };
  }

  return {
    async getToken(value) {
      const mint = normalizeSolanaMint(value);
      const timestamp = now();
      const existing = cache.get(mint);
      if (existing && timestamp < existing.expires_at) {
        return cloneWithFreshness(existing.value, { stale:false, label:'Cached ≤30s · execution unverified', execution_ready:false });
      }
      try {
        const value = await fetchToken(mint);
        cache.set(mint, { value, expires_at: timestamp + CACHE_TTL_MS, stale_until: timestamp + CACHE_TTL_MS + STALE_FALLBACK_MS });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        if (existing && timestamp < existing.stale_until && !['invalid_token_mint','market_provider_canonical_mismatch','market_token_not_found'].includes(error?.message)) {
          return cloneWithFreshness(existing.value, {
            stale:true,
            label:'STALE · provider unavailable',
            execution_ready:false,
            stale_reason:String(error?.message || 'market_provider_unavailable')
          });
        }
        throw error;
      }
    }
  };
}
