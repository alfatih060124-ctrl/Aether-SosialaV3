const RAYDIUM_API_BASE_URL = 'https://api-v3.raydium.io';
const RAYDIUM_ONCHAIN_SOURCE_PREFIX = 'RAYDIUM_ONCHAIN_RPC';

const finite = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

function requiredBps(value, code) {
  const numeric = finite(value);
  if (numeric === null || numeric < 0 || numeric > 10_000) throw new Error(code);
  return numeric;
}

function mintAddress(value) {
  if (typeof value === 'string') return value.trim();
  return String(value?.address || value?.mint || '').trim();
}

function poolMints(pool) {
  const a = mintAddress(pool?.mintA ?? pool?.tokenMintA ?? pool?.baseMint);
  const b = mintAddress(pool?.mintB ?? pool?.tokenMintB ?? pool?.quoteMint);
  return [a, b];
}

function exactPair(pool, tokenMint, quoteMint) {
  const [a, b] = poolMints(pool);
  return (a === tokenMint && b === quoteMint) || (a === quoteMint && b === tokenMint);
}

function discoveryRows(payload) {
  if (!payload || payload.success !== true) throw new Error('raydium_discovery_unsuccessful');
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.data?.data)) return payload.data.data;
  throw new Error('raydium_discovery_payload_invalid');
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!response || response.ok !== true) throw new Error(`raydium_discovery_http_${response?.status || 'error'}`);
    return discoveryRows(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export function createRaydiumReadOnlyQuoteLoader({
  quotePool,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = RAYDIUM_API_BASE_URL,
  timeoutMs = 4_000,
  quoteNotionalUsdc,
  maxPools = 20
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('raydium_fetch_required');
  if (typeof quotePool !== 'function') throw new Error('raydium_onchain_quote_loader_required');
  const notionalUsdc = finite(quoteNotionalUsdc);
  if (!(notionalUsdc > 0)) throw new Error('raydium_quote_notional_usdc_required');

  return async function loadRaydiumQuotes(request = {}) {
    const tokenMint = text(request.token_mint, 'raydium_token_mint_required');
    const quoteMint = text(request.quote_mint, 'raydium_quote_mint_required');
    if (tokenMint === quoteMint) throw new Error('raydium_distinct_mints_required');
    if (request.read_only !== true) throw new Error('raydium_read_only_required');
    if (request.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('raydium_strategy_invalid');

    const query = new URLSearchParams({
      mint1: tokenMint,
      mint2: quoteMint,
      poolType: 'all',
      poolSortField: 'liquidity',
      sortType: 'desc',
      pageSize: String(Math.max(1, Math.min(1000, Number(maxPools) || 20))),
      page: '1'
    });

    const pools = await fetchJson(
      fetchImpl,
      `${String(apiBaseUrl).replace(/\/$/, '')}/pools/info/mint?${query}`,
      timeoutMs
    );
    const candidates = pools.filter(pool => pool && exactPair(pool, tokenMint, quoteMint));
    if (!candidates.length) throw new Error('raydium_no_exact_pair_pools');

    const rows = [];
    for (const pool of candidates) {
      const poolAddress = text(pool.id ?? pool.address ?? pool.poolId, 'raydium_pool_address_required');
      const quote = await quotePool(Object.freeze({
        pool_address: poolAddress,
        pool_type: String(pool.type || pool.poolType || '').trim() || null,
        token_mint: tokenMint,
        quote_mint: quoteMint,
        notional_usdc: notionalUsdc,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE',
        source_hint: RAYDIUM_ONCHAIN_SOURCE_PREFIX
      }));
      if (!quote || typeof quote !== 'object') throw new Error('raydium_onchain_quote_required');
      if (quote.quote_verified !== true) throw new Error('raydium_onchain_quote_unverified');
      if (quote.costs_verified !== true) throw new Error('raydium_onchain_costs_unverified');

      const buyPriceUsd = finite(quote.buy_price_usd);
      const sellPriceUsd = finite(quote.sell_price_usd);
      if (!(buyPriceUsd > 0)) throw new Error('raydium_onchain_buy_price_required');
      if (!(sellPriceUsd > 0)) throw new Error('raydium_onchain_sell_price_required');
      const buyFeeBps = requiredBps(quote.buy_fee_bps, 'raydium_onchain_buy_fee_bps_required');
      const sellFeeBps = requiredBps(quote.sell_fee_bps, 'raydium_onchain_sell_fee_bps_required');
      const buyPriceImpactBps = requiredBps(quote.buy_price_impact_bps, 'raydium_onchain_buy_price_impact_bps_required');
      const sellPriceImpactBps = requiredBps(quote.sell_price_impact_bps, 'raydium_onchain_sell_price_impact_bps_required');
      const observedAt = text(quote.observed_at, 'raydium_onchain_observed_at_required');
      if (!Number.isFinite(Date.parse(observedAt))) throw new Error('raydium_onchain_observed_at_invalid');
      const quoteSource = text(quote.quote_source, 'raydium_onchain_quote_source_required');
      if (!quoteSource.toUpperCase().startsWith(RAYDIUM_ONCHAIN_SOURCE_PREFIX)) {
        throw new Error('raydium_onchain_quote_source_invalid');
      }

      rows.push(Object.freeze({
        dex_id: 'raydium',
        pool_address: poolAddress,
        token_mint: tokenMint,
        quote_mint: quoteMint,
        buy_price_usd: buyPriceUsd,
        sell_price_usd: sellPriceUsd,
        buy_fee_bps: buyFeeBps,
        sell_fee_bps: sellFeeBps,
        buy_price_impact_bps: buyPriceImpactBps,
        sell_price_impact_bps: sellPriceImpactBps,
        liquidity_usd: finite(quote.liquidity_usd ?? pool.tvl ?? pool.tvlUsd),
        quote_source: quoteSource,
        quote_verified: true,
        costs_verified: true,
        observed_at: new Date(Date.parse(observedAt)).toISOString()
      }));
    }

    if (!rows.length) throw new Error('raydium_no_verified_quotes');
    return Object.freeze(rows);
  };
}

export const RAYDIUM_READONLY_PROVIDER = Object.freeze({
  api_base_url: RAYDIUM_API_BASE_URL,
  dex_id: 'raydium',
  strategy: 'TWO_LEG_ARBITRAGE',
  read_only: true,
  live_execution_authorized: false
});
