const ALLOWED_DEXES = Object.freeze(new Set(['orca', 'raydium']));
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_MARKET_AGE_MS = 5_000;

const finite = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const normalizeDex = value => String(value || '').trim().toLowerCase();
const normalizeMint = value => String(value || '').trim();

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new Error(code);
  return text;
}

function requiredBps(value, code) {
  const numeric = finite(value);
  if (numeric === null || numeric < 0 || numeric > 10_000) throw new Error(code);
  return numeric;
}

function normalizePoolEvidence(pool, { now, maxMarketAgeMs }) {
  if (!pool || typeof pool !== 'object') throw new Error('scanner_pool_evidence_required');
  const dexId = normalizeDex(pool.dex_id);
  if (!ALLOWED_DEXES.has(dexId)) throw new Error('scanner_dex_not_allowed');
  const poolAddress = requiredText(pool.pool_address, 'scanner_pool_address_required');
  const tokenMint = requiredText(pool.token_mint, 'scanner_token_mint_required');
  const quoteMint = requiredText(pool.quote_mint, 'scanner_quote_mint_required');
  if (tokenMint === quoteMint) throw new Error('scanner_distinct_mints_required');

  const buyPriceUsd = finite(pool.buy_price_usd);
  const sellPriceUsd = finite(pool.sell_price_usd);
  if (!(buyPriceUsd > 0)) throw new Error('scanner_buy_price_required');
  if (!(sellPriceUsd > 0)) throw new Error('scanner_sell_price_required');
  const buyFeeBps = requiredBps(pool.buy_fee_bps, 'scanner_buy_fee_bps_required');
  const sellFeeBps = requiredBps(pool.sell_fee_bps, 'scanner_sell_fee_bps_required');
  const buyPriceImpactBps = requiredBps(pool.buy_price_impact_bps, 'scanner_buy_price_impact_bps_required');
  const sellPriceImpactBps = requiredBps(pool.sell_price_impact_bps, 'scanner_sell_price_impact_bps_required');

  if (pool.quote_verified !== true) throw new Error('scanner_quote_unverified');
  if (pool.costs_verified !== true) throw new Error('scanner_costs_unverified');
  const quoteSource = requiredText(pool.quote_source, 'scanner_quote_source_required');
  const observedAtMs = Date.parse(String(pool.observed_at || ''));
  if (!Number.isFinite(observedAtMs)) throw new Error('scanner_observed_at_required');
  const ageMs = now - observedAtMs;
  if (ageMs < 0) throw new Error('scanner_future_quote_rejected');
  if (ageMs > maxMarketAgeMs) throw new Error('scanner_stale_quote_rejected');

  return Object.freeze({
    dex_id: dexId,
    pool_address: poolAddress,
    token_mint: tokenMint,
    quote_mint: quoteMint,
    buy_price_usd: buyPriceUsd,
    sell_price_usd: sellPriceUsd,
    buy_fee_bps: buyFeeBps,
    sell_fee_bps: sellFeeBps,
    buy_price_impact_bps: buyPriceImpactBps,
    sell_price_impact_bps: sellPriceImpactBps,
    liquidity_usd: finite(pool.liquidity_usd),
    quote_source: quoteSource,
    quote_verified: true,
    costs_verified: true,
    observed_at: new Date(observedAtMs).toISOString()
  });
}

function keyForPair(tokenMint, quoteMint) {
  return `${tokenMint}::${quoteMint}`;
}

function routeForSide(pool, side) {
  const buy = side === 'BUY';
  return Object.freeze({
    dex_id: pool.dex_id,
    pool_address: pool.pool_address,
    token_mint: pool.token_mint,
    quote_mint: pool.quote_mint,
    side,
    price_usd: buy ? pool.buy_price_usd : pool.sell_price_usd,
    fee_bps: buy ? pool.buy_fee_bps : pool.sell_fee_bps,
    price_impact_bps: buy ? pool.buy_price_impact_bps : pool.sell_price_impact_bps,
    liquidity_usd: pool.liquidity_usd,
    quote_source: pool.quote_source,
    quote_verified: true,
    costs_verified: true,
    observed_at: pool.observed_at
  });
}

function compareDirection(buyPool, sellPool) {
  if (buyPool.dex_id === sellPool.dex_id) return null;
  if (buyPool.token_mint !== sellPool.token_mint || buyPool.quote_mint !== sellPool.quote_mint) return null;
  const buy = routeForSide(buyPool, 'BUY');
  const sell = routeForSide(sellPool, 'SELL');
  const grossEdgeBps = ((sell.price_usd / buy.price_usd) - 1) * 10_000;
  return Object.freeze({
    direction: `${buy.dex_id.toUpperCase()}_TO_${sell.dex_id.toUpperCase()}`,
    token_mint: buy.token_mint,
    quote_mint: buy.quote_mint,
    gross_edge_bps: Math.round(grossEdgeBps * 100) / 100,
    buy_route: buy,
    sell_route: sell,
    market_source: 'ORCA_RAYDIUM_REAL_MARKET',
    observed_at: buy.observed_at < sell.observed_at ? buy.observed_at : sell.observed_at,
    strategy: 'TWO_LEG_ARBITRAGE',
    execution_ready: false,
    live_execution_authorized: false
  });
}

export function createOrcaRaydiumArbitrageScanner({
  loadPools,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxMarketAgeMs = DEFAULT_MAX_MARKET_AGE_MS
} = {}) {
  if (typeof loadPools !== 'function') throw new Error('scanner_pool_loader_required');
  const cache = new Map();

  async function loadFreshPair(tokenMint, quoteMint) {
    const timestamp = now();
    const pairKey = keyForPair(tokenMint, quoteMint);
    const cached = cache.get(pairKey);
    if (cached && timestamp < cached.expires_at) return cached.value;
    if (cached) cache.delete(pairKey);

    const rows = await loadPools({ token_mint: tokenMint, quote_mint: quoteMint, dexes: ['orca', 'raydium'] });
    if (!Array.isArray(rows)) throw new Error('scanner_provider_payload_invalid');
    const normalized = [];
    for (const row of rows) {
      const pool = normalizePoolEvidence(row, { now: timestamp, maxMarketAgeMs });
      if (pool.token_mint !== tokenMint || pool.quote_mint !== quoteMint) throw new Error('scanner_pair_mismatch');
      normalized.push(pool);
    }

    const orca = normalized.filter(row => row.dex_id === 'orca');
    const raydium = normalized.filter(row => row.dex_id === 'raydium');
    if (!orca.length || !raydium.length) throw new Error('scanner_both_dexes_required');

    const value = Object.freeze({
      token_mint: tokenMint,
      quote_mint: quoteMint,
      observed_at: new Date(timestamp).toISOString(),
      pools: Object.freeze(normalized),
      source: 'ORCA_RAYDIUM_REAL_MARKET',
      stale: false,
      read_only: true,
      execution_ready: false,
      live_execution_authorized: false
    });
    const ttlMs = Math.max(1, finite(cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
    const freshnessDeadline = Math.min(...normalized.map(pool => Date.parse(pool.observed_at) + maxMarketAgeMs));
    cache.set(pairKey, { value, expires_at: Math.min(timestamp + ttlMs, freshnessDeadline) });
    return value;
  }

  return Object.freeze({
    async scanPair({ token_mint, quote_mint } = {}) {
      const tokenMint = normalizeMint(token_mint);
      const quoteMint = normalizeMint(quote_mint);
      if (!tokenMint) throw new Error('scanner_token_mint_required');
      if (!quoteMint) throw new Error('scanner_quote_mint_required');
      if (tokenMint === quoteMint) throw new Error('scanner_distinct_mints_required');

      const snapshot = await loadFreshPair(tokenMint, quoteMint);
      const opportunities = [];
      const orca = snapshot.pools.filter(row => row.dex_id === 'orca');
      const raydium = snapshot.pools.filter(row => row.dex_id === 'raydium');
      for (const buy of orca) for (const sell of raydium) {
        const forward = compareDirection(buy, sell);
        if (forward) opportunities.push(forward);
        const reverse = compareDirection(sell, buy);
        if (reverse) opportunities.push(reverse);
      }
      opportunities.sort((a, b) => b.gross_edge_bps - a.gross_edge_bps);
      return Object.freeze({ ...snapshot, opportunities: Object.freeze(opportunities) });
    },
    clearCache() { cache.clear(); }
  });
}

export const ORCA_RAYDIUM_SCANNER_DEXES = Object.freeze(['orca', 'raydium']);
export const ORCA_RAYDIUM_SCANNER_DEFAULT_MAX_MARKET_AGE_MS = DEFAULT_MAX_MARKET_AGE_MS;
