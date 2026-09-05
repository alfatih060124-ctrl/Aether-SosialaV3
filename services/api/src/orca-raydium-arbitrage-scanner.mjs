const ALLOWED_DEXES = Object.freeze(new Set(['orca', 'raydium']));
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_MARKET_AGE_MS = 5_000;

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const normalizeDex = value => String(value || '').trim().toLowerCase();
const normalizeMint = value => String(value || '').trim();

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new Error(code);
  return text;
}

function normalizePoolEvidence(pool, { now, maxMarketAgeMs }) {
  if (!pool || typeof pool !== 'object') throw new Error('scanner_pool_evidence_required');
  const dexId = normalizeDex(pool.dex_id);
  if (!ALLOWED_DEXES.has(dexId)) throw new Error('scanner_dex_not_allowed');
  const poolAddress = requiredText(pool.pool_address, 'scanner_pool_address_required');
  const tokenMint = requiredText(pool.token_mint, 'scanner_token_mint_required');
  const quoteMint = requiredText(pool.quote_mint, 'scanner_quote_mint_required');
  if (tokenMint === quoteMint) throw new Error('scanner_distinct_mints_required');
  const priceUsd = finite(pool.price_usd);
  if (!(priceUsd > 0)) throw new Error('scanner_price_required');
  const feeBps = finite(pool.fee_bps);
  if (feeBps === null || feeBps < 0 || feeBps > 10_000) throw new Error('scanner_fee_bps_required');
  const priceImpactBps = finite(pool.price_impact_bps);
  if (priceImpactBps === null || priceImpactBps < 0 || priceImpactBps > 10_000) throw new Error('scanner_price_impact_bps_required');
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
    price_usd: priceUsd,
    fee_bps: feeBps,
    price_impact_bps: priceImpactBps,
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

function compareDirection(buy, sell) {
  if (buy.dex_id === sell.dex_id) return null;
  if (buy.token_mint !== sell.token_mint || buy.quote_mint !== sell.quote_mint) return null;
  const grossEdgeBps = ((sell.price_usd / buy.price_usd) - 1) * 10_000;
  return Object.freeze({
    direction: `${buy.dex_id.toUpperCase()}_TO_${sell.dex_id.toUpperCase()}`,
    token_mint: buy.token_mint,
    quote_mint: buy.quote_mint,
    gross_edge_bps: Math.round(grossEdgeBps * 100) / 100,
    buy_route: buy,
    sell_route: sell,
    market_source: 'ORCA_RAYDIUM_REAL_MARKET',
    observed_at: buy.observed_at > sell.observed_at ? buy.observed_at : sell.observed_at,
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
    cache.set(pairKey, { value, expires_at: timestamp + Math.max(1, Number(cacheTtlMs) || DEFAULT_CACHE_TTL_MS) });
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
