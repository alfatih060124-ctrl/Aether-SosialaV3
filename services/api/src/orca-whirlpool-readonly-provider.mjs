const ORCA_API_BASE_URL = 'https://api.orca.so/v2/solana';

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

function exactPair(pool, tokenMint, quoteMint) {
  const a = String(pool?.tokenMintA || '').trim();
  const b = String(pool?.tokenMintB || '').trim();
  return (a === tokenMint && b === quoteMint) || (a === quoteMint && b === tokenMint);
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response || response.ok !== true) throw new Error(`orca_discovery_http_${response?.status || 'error'}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.data)) throw new Error('orca_discovery_payload_invalid');
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

export function createOrcaWhirlpoolReadOnlyQuoteLoader({
  quotePool,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = ORCA_API_BASE_URL,
  timeoutMs = 4_000,
  quoteNotionalUsdc,
  maxPools = 20
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('orca_fetch_required');
  if (typeof quotePool !== 'function') throw new Error('orca_onchain_quote_loader_required');
  const notionalUsdc = finite(quoteNotionalUsdc);
  if (!(notionalUsdc > 0)) throw new Error('orca_quote_notional_usdc_required');

  return async function loadOrcaQuotes(request = {}) {
    const tokenMint = text(request.token_mint, 'orca_token_mint_required');
    const quoteMint = text(request.quote_mint, 'orca_quote_mint_required');
    if (tokenMint === quoteMint) throw new Error('orca_distinct_mints_required');
    if (request.read_only !== true) throw new Error('orca_read_only_required');
    if (request.strategy !== 'TWO_LEG_ARBITRAGE') throw new Error('orca_strategy_invalid');

    const query = new URLSearchParams({
      tokensBothOf: `${tokenMint},${quoteMint}`,
      size: String(Math.max(1, Math.min(100, Number(maxPools) || 20))),
      includeBlocked: 'false'
    });
    const pools = await fetchJson(fetchImpl, `${String(apiBaseUrl).replace(/\/$/, '')}/pools?${query}`, timeoutMs);
    const candidates = pools.filter(pool => pool && exactPair(pool, tokenMint, quoteMint));
    if (!candidates.length) throw new Error('orca_no_exact_pair_pools');

    const rows = [];
    for (const pool of candidates) {
      const poolAddress = text(pool.address, 'orca_pool_address_required');
      const quote = await quotePool(Object.freeze({
        pool_address: poolAddress,
        token_mint: tokenMint,
        quote_mint: quoteMint,
        notional_usdc: notionalUsdc,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE',
        source_hint: 'ORCA_WHIRLPOOLS_ONCHAIN'
      }));
      if (!quote || typeof quote !== 'object') throw new Error('orca_onchain_quote_required');
      if (quote.quote_verified !== true) throw new Error('orca_onchain_quote_unverified');
      if (quote.costs_verified !== true) throw new Error('orca_onchain_costs_unverified');
      const priceUsd = finite(quote.price_usd);
      if (!(priceUsd > 0)) throw new Error('orca_onchain_price_required');
      const feeBps = finite(quote.fee_bps);
      if (feeBps === null || feeBps < 0 || feeBps > 10_000) throw new Error('orca_onchain_fee_bps_required');
      const priceImpactBps = finite(quote.price_impact_bps);
      if (priceImpactBps === null || priceImpactBps < 0 || priceImpactBps > 10_000) throw new Error('orca_onchain_price_impact_bps_required');
      const observedAt = text(quote.observed_at, 'orca_onchain_observed_at_required');
      if (!Number.isFinite(Date.parse(observedAt))) throw new Error('orca_onchain_observed_at_invalid');
      const quoteSource = text(quote.quote_source, 'orca_onchain_quote_source_required');
      if (!quoteSource.toUpperCase().includes('ORCA')) throw new Error('orca_onchain_quote_source_invalid');

      rows.push(Object.freeze({
        dex_id: 'orca',
        pool_address: poolAddress,
        token_mint: tokenMint,
        quote_mint: quoteMint,
        price_usd: priceUsd,
        fee_bps: feeBps,
        price_impact_bps: priceImpactBps,
        liquidity_usd: finite(quote.liquidity_usd ?? pool.tvlUsdc ?? pool.tvl),
        quote_source: quoteSource,
        quote_verified: true,
        costs_verified: true,
        observed_at: new Date(Date.parse(observedAt)).toISOString()
      }));
    }

    if (!rows.length) throw new Error('orca_no_verified_quotes');
    return Object.freeze(rows);
  };
}

export const ORCA_WHIRLPOOL_READONLY_PROVIDER = Object.freeze({
  api_base_url: ORCA_API_BASE_URL,
  dex_id: 'orca',
  strategy: 'TWO_LEG_ARBITRAGE',
  read_only: true,
  live_execution_authorized: false
});
