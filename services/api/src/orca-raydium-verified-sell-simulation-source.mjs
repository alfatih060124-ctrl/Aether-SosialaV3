const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

const finite = (value, code, { min = -Infinity, max = Infinity } = {}) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) throw new Error(code);
  return numeric;
};

const dex = (value, code) => {
  const normalized = text(value, code).toLowerCase();
  if (!['orca', 'raydium'].includes(normalized)) throw new Error(code);
  return normalized;
};

function assertSellRoute(route, tokenMint, quoteMint) {
  if (!route || typeof route !== 'object') throw new Error('sell_simulation_route_required');
  if (String(route.side || '').toUpperCase() !== 'SELL') throw new Error('sell_simulation_sell_side_required');
  const sellDex = dex(route.dex_id, 'sell_simulation_dex_invalid');
  const poolAddress = text(route.pool_address, 'sell_simulation_pool_required');
  if (text(route.token_mint, 'sell_simulation_token_mint_required') !== tokenMint) throw new Error('sell_simulation_token_mint_mismatch');
  if (text(route.quote_mint, 'sell_simulation_quote_mint_required') !== quoteMint) throw new Error('sell_simulation_quote_mint_mismatch');
  if (route.quote_verified !== true || route.costs_verified !== true) throw new Error('sell_simulation_route_unverified');
  return { sellDex, poolAddress };
}

export function createOrcaRaydiumVerifiedSellSimulationSource({
  scannerRuntime,
  now = () => Date.now(),
  maxAgeMs = 15_000
} = {}) {
  if (!scannerRuntime || typeof scannerRuntime.scanPair !== 'function') throw new Error('sell_simulation_scanner_required');
  const maxAge = finite(maxAgeMs, 'sell_simulation_max_age_invalid', { min: 1 });

  return async function loadSellSimulationSource({ opportunity } = {}) {
    if (!opportunity || typeof opportunity !== 'object') throw new Error('sell_simulation_opportunity_required');
    const tokenMint = text(opportunity.token_mint, 'sell_simulation_token_mint_required');
    const quoteMint = text(opportunity.quote_mint, 'sell_simulation_quote_mint_required');
    const expected = assertSellRoute(opportunity.sell_route, tokenMint, quoteMint);

    const snapshot = await scannerRuntime.scanPair({ token_mint: tokenMint, quote_mint: quoteMint });
    if (!snapshot || snapshot.read_only !== true || snapshot.live_execution_authorized !== false) {
      throw new Error('sell_simulation_snapshot_invariant_failed');
    }
    const matching = (snapshot.opportunities || []).find(candidate => {
      const route = candidate?.sell_route;
      return candidate?.token_mint === tokenMint
        && candidate?.quote_mint === quoteMint
        && String(route?.side || '').toUpperCase() === 'SELL'
        && String(route?.dex_id || '').toLowerCase() === expected.sellDex
        && String(route?.pool_address || '') === expected.poolAddress;
    });
    if (!matching) throw new Error('sell_simulation_exact_route_not_found');

    const route = matching.sell_route;
    assertSellRoute(route, tokenMint, quoteMint);
    const observedAt = text(route.observed_at || matching.observed_at, 'sell_simulation_observed_at_required');
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) throw new Error('sell_simulation_observed_at_invalid');
    const timestamp = Number(now());
    if (!Number.isFinite(timestamp)) throw new Error('sell_simulation_now_invalid');
    const age = timestamp - observedMs;
    if (age < -2_000) throw new Error('sell_simulation_observed_at_future');
    if (age > maxAge) throw new Error('sell_simulation_observed_at_stale');

    const sellPriceUsd = finite(route.price_usd, 'sell_simulation_price_required', { min: Number.MIN_VALUE });
    const feeBps = finite(route.fee_bps, 'sell_simulation_fee_bps_required', { min: 0, max: 10_000 });
    const impactBps = finite(route.price_impact_bps, 'sell_simulation_impact_bps_required', { min: 0, max: 10_000 });
    const quoteSource = text(route.quote_source, 'sell_simulation_quote_source_required');

    return Object.freeze({
      verified: true,
      sell_simulation_ok: true,
      token_mint: tokenMint,
      quote_mint: quoteMint,
      dex_id: expected.sellDex,
      pool_address: expected.poolAddress,
      sell_price_usd: sellPriceUsd,
      sell_fee_bps: feeBps,
      sell_price_impact_bps: impactBps,
      source: 'ORCA_RAYDIUM_VERIFIED_ONCHAIN_SELL_QUOTE_SIMULATION',
      source_reference: `${quoteSource}|${expected.sellDex.toUpperCase()}|${expected.poolAddress}`,
      observed_at: new Date(observedMs).toISOString(),
      read_only: true,
      transaction_building_authorized: false,
      transaction_signed: false,
      signer_requested: false,
      network_submission_authorized: false,
      live_execution_authorized: false
    });
  };
}

export const ORCA_RAYDIUM_VERIFIED_SELL_SIMULATION_SOURCE = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_scope: Object.freeze(['ORCA', 'RAYDIUM']),
  exact_route_requote_required: true,
  onchain_quote_math_required: true,
  read_only: true,
  transaction_building_authorized: false,
  transaction_signing_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
