import { PublicKey } from '@solana/web3.js';

const ORIGIN = 'https://api.dexscreener.com';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 20_000;

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function canonicalAddress(value, code) {
  try {
    return new PublicKey(String(value || '')).toBase58();
  } catch {
    throw new Error(code);
  }
}

export function createDexScreenerPoolUniverseService({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const cache = new Map();
  let discoveryCache = null;
  const ttlMs = Math.max(1000, Math.min(60_000, Number(cacheTtlMs) || DEFAULT_CACHE_TTL_MS));

  async function getTokenPools(tokenMint) {
    const mint = canonicalAddress(tokenMint, 'dexscreener_token_mint_invalid');
    const now = Date.now();
    const cached = cache.get(mint);
    if (cached && now - cached.observed_at_ms <= ttlMs) {
      return Object.freeze({
        token_mint: mint,
        pools: cached.pools.map(row => ({ ...row })),
        observed_at_ms: cached.observed_at_ms,
        cache_hit: true,
        source: 'DEXSCREENER_PUBLIC'
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    try {
      const url = new URL('/token-pairs/v1/solana/' + encodeURIComponent(mint), ORIGIN);
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error'
      });
      if (response.status === 429) throw new Error('dexscreener_rate_limited');
      if (!response.ok) throw new Error('dexscreener_unavailable');
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('dexscreener_invalid_payload');
      const pools = [];
      for (const pair of body) {
        try {
          const pairAddress = canonicalAddress(pair?.pairAddress, 'dexscreener_pair_invalid');
          const baseMint = canonicalAddress(pair?.baseToken?.address, 'dexscreener_base_invalid');
          const quoteMint = canonicalAddress(pair?.quoteToken?.address, 'dexscreener_quote_invalid');
          if (baseMint !== mint && quoteMint !== mint) continue;
          const basePriceUsd = finitePositive(pair?.priceUsd);
          const basePriceInQuote = finitePositive(pair?.priceNative);
          const tokenPriceUsd = baseMint === mint
            ? basePriceUsd
            : quoteMint === mint && basePriceUsd !== null && basePriceInQuote !== null
              ? basePriceUsd / basePriceInQuote
              : null;
          pools.push(Object.freeze({
            dex_id: String(pair?.dexId || '').trim(),
            pool_address: pairAddress,
            base_mint: baseMint,
            quote_mint: quoteMint,
            base_symbol: pair?.baseToken?.symbol || null,
            base_name: pair?.baseToken?.name || null,
            quote_symbol: pair?.quoteToken?.symbol || null,
            quote_name: pair?.quoteToken?.name || null,
            token_price_usd: tokenPriceUsd,
            liquidity_usd: finiteNonNegative(pair?.liquidity?.usd),
            volume_24h_usd: finiteNonNegative(pair?.volume?.h24),
            pair_created_at_ms: finiteNonNegative(pair?.pairCreatedAt)
          }));
        } catch {}
      }
      pools.sort((a, b) =>
        (b.liquidity_usd ?? -1) - (a.liquidity_usd ?? -1) ||
        (b.volume_24h_usd ?? -1) - (a.volume_24h_usd ?? -1)
      );
      const record = { pools: Object.freeze(pools), observed_at_ms: Date.now() };
      cache.set(mint, record);
      return Object.freeze({
        token_mint: mint,
        pools: pools.map(row => ({ ...row })),
        observed_at_ms: record.observed_at_ms,
        cache_hit: false,
        source: 'DEXSCREENER_PUBLIC'
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('dexscreener_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getDiscoveryTokens({ limit = 30 } = {}) {
    const boundedLimit = Math.max(1, Math.min(60, Number(limit) || 30));
    const now = Date.now();
    if (discoveryCache && now - discoveryCache.observed_at_ms <= ttlMs) {
      return Object.freeze({
        tokens: discoveryCache.tokens.slice(0, boundedLimit).map(row => ({ ...row })),
        observed_at_ms: discoveryCache.observed_at_ms,
        cache_hit: true,
        source: 'DEXSCREENER_DISCOVERY_PUBLIC'
      });
    }

    const paths = ['/token-boosts/top/v1', '/token-profiles/latest/v1'];
    const byMint = new Map();
    for (const path of paths) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      try {
        const response = await fetchImpl(new URL(path, ORIGIN), {
          headers: { accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error'
        });
        if (response.status === 429) throw new Error('dexscreener_rate_limited');
        if (!response.ok) throw new Error('dexscreener_unavailable');
        const body = await response.json();
        for (const row of Array.isArray(body) ? body : []) {
          if (String(row?.chainId || '').toLowerCase() !== 'solana') continue;
          try {
            const mint = canonicalAddress(row?.tokenAddress, 'dexscreener_token_mint_invalid');
            if (!byMint.has(mint)) {
              byMint.set(mint, Object.freeze({
                mint,
                discovery_source: path.includes('boosts') ? 'DEXSCREENER_TOP_BOOSTS' : 'DEXSCREENER_LATEST_PROFILES'
              }));
            }
          } catch {}
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('dexscreener_timeout');
        if (String(error?.message || error) === 'dexscreener_rate_limited') {
          await new Promise(resolve => setTimeout(resolve, 350));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }

    const tokens = [...byMint.values()];
    discoveryCache = Object.freeze({
      tokens: Object.freeze(tokens),
      observed_at_ms: Date.now()
    });
    return Object.freeze({
      tokens: tokens.slice(0, boundedLimit).map(row => ({ ...row })),
      observed_at_ms: discoveryCache.observed_at_ms,
      cache_hit: false,
      source: 'DEXSCREENER_DISCOVERY_PUBLIC'
    });
  }

  return Object.freeze({
    getTokenPools,
    getDiscoveryTokens,
    safety: Object.freeze({
      read_only: true,
      market_discovery_only: true,
      transaction_submission: false,
      signer_requested: false,
      live_execution_authorized: false
    })
  });
}