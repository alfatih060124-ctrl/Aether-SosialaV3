const PROVIDER_ORIGIN = 'https://api.geckoterminal.com';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TIMEFRAMES = Object.freeze({
  '5m': { providerPeriod: 'minute', providerAggregate: 5, bucketSeconds: 0, label: '5-minute' },
  '15m': { providerPeriod: 'minute', providerAggregate: 15, bucketSeconds: 0, label: '15-minute' },
  '1h': { providerPeriod: 'hour', providerAggregate: 1, bucketSeconds: 0, label: '1-hour' },
  '4h': { providerPeriod: 'hour', providerAggregate: 1, bucketSeconds: 4 * 60 * 60, label: '4-hour' },
  '1d': { providerPeriod: 'day', providerAggregate: 1, bucketSeconds: 0, label: '1-day' },
  '1w': { providerPeriod: 'day', providerAggregate: 1, bucketSeconds: 7 * 24 * 60 * 60, label: '1-week' },
});

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

function normalizeMint(value) {
  const mint = String(value || '').trim();
  if (!BASE58.test(mint) || decodedBase58ByteLength(mint) !== 32) throw new Error('invalid_token_mint');
  return mint;
}

function normalizeTimeframe(value) {
  const key = String(value || '15m').trim().toLowerCase();
  if (!TIMEFRAMES[key]) throw new Error('invalid_market_timeframe');
  return { key, ...TIMEFRAMES[key] };
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function relationId(pool, side) {
  return pool?.relationships?.[`${side}_token`]?.data?.id || null;
}

function tokenId(mint) {
  return `solana_${mint}`;
}

function normalizePool(pool, mint) {
  const attrs = pool?.attributes || {};
  const target = tokenId(mint);
  let side = null;
  if (relationId(pool, 'base') === target) side = 'base';
  else if (relationId(pool, 'quote') === target) side = 'quote';
  if (!side) return null;
  const address = normalizeMint(attrs.address);
  return {
    address,
    side,
    dex_id: pool?.relationships?.dex?.data?.id || null,
    liquidity_usd: finiteNonNegative(attrs.reserve_in_usd),
    volume_24h_usd: finiteNonNegative(attrs?.volume_usd?.h24),
  };
}

function pickPool(rows, mint) {
  const pools = (Array.isArray(rows) ? rows : []).map(row => {
    try { return normalizePool(row, mint); } catch { return null; }
  }).filter(Boolean);
  pools.sort((a, b) => (b.liquidity_usd ?? -1) - (a.liquidity_usd ?? -1) || (b.volume_24h_usd ?? -1) - (a.volume_24h_usd ?? -1));
  return pools[0] || null;
}

async function providerGet(path) {
  const url = new URL(path, PROVIDER_ORIGIN);
  if (url.origin !== PROVIDER_ORIGIN) throw new Error('market_provider_target_invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json;version=20230203' },
      signal: controller.signal,
      redirect: 'error',
    });
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

function parseCandles(payload) {
  const rows = payload?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return [];
  const result = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const timestamp = Number(row[0]);
    const open = finiteNonNegative(row[1]);
    const high = finiteNonNegative(row[2]);
    const low = finiteNonNegative(row[3]);
    const close = finiteNonNegative(row[4]);
    const volume = finiteNonNegative(row[5]) ?? 0;
    if (!Number.isSafeInteger(timestamp) || [open, high, low, close].some(v => v === null)) continue;
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    result.push({ timestamp, open, high, low, close, volume });
  }
  result.sort((a, b) => a.timestamp - b.timestamp);
  return result;
}

function bucketCandles(rows, bucketSeconds) {
  if (!bucketSeconds) return rows.slice(-96);
  const buckets = new Map();
  for (const candle of rows) {
    const bucket = Math.floor(candle.timestamp / bucketSeconds) * bucketSeconds;
    const current = buckets.get(bucket);
    if (!current) {
      buckets.set(bucket, { timestamp: bucket, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-96);
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-aether-deployment-role', 'PUBLIC_EDGE');
  return res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed', read_only: true, live_execution_authorized: false });
  try {
    const requestUrl = new URL(req.url || '/', 'https://aether.local');
    const mint = normalizeMint(requestUrl.searchParams.get('mint'));
    const timeframe = normalizeTimeframe(requestUrl.searchParams.get('timeframe'));
    const pools = await providerGet(`/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools?include=base_token%2Cquote_token%2Cdex&page=1&sort=h24_volume_usd_liquidity_desc`);
    const pool = pickPool(pools?.data, mint);
    if (!pool) throw new Error('market_token_not_found');
    const providerLimit = timeframe.bucketSeconds ? 96 : 96;
    const ohlcv = await providerGet(`/api/v2/networks/solana/pools/${encodeURIComponent(pool.address)}/ohlcv/${timeframe.providerPeriod}?aggregate=${timeframe.providerAggregate}&limit=${providerLimit}&currency=usd&token=${pool.side}`);
    const candles = bucketCandles(parseCandles(ohlcv), timeframe.bucketSeconds);
    return json(res, 200, {
      mint,
      pool_address: pool.address,
      dex_id: pool.dex_id,
      timeframe: timeframe.key,
      timeframe_label: timeframe.label,
      candles,
      observed_at: new Date().toISOString(),
      source: 'GECKOTERMINAL_PUBLIC',
      read_only: true,
      mode: 'SHADOW',
      live_execution_authorized: false,
    });
  } catch (error) {
    const code = String(error?.message || 'market_chart_unavailable');
    const status = ['invalid_token_mint', 'invalid_market_timeframe'].includes(code) ? 400 : code === 'market_token_not_found' ? 404 : 503;
    return json(res, status, { error: code, read_only: true, mode: 'SHADOW', live_execution_authorized: false });
  }
}
