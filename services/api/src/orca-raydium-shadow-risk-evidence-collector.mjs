const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value, code) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
};

function requiredNumber(value, code, { min = -Infinity, max = Infinity } = {}) {
  const numeric = finite(value);
  if (numeric === null || numeric < min || numeric > max) throw new Error(code);
  return numeric;
}

function freshVerifiedSource(raw, { now, maxAgeMs, prefix }) {
  if (!raw || typeof raw !== 'object') throw new Error(`${prefix}_payload_required`);
  if (raw.verified !== true) throw new Error(`${prefix}_unverified`);
  const source = text(raw.source, `${prefix}_source_required`);
  const sourceReference = text(raw.source_reference, `${prefix}_source_reference_required`);
  const observed = Date.parse(text(raw.observed_at, `${prefix}_observed_at_required`));
  if (!Number.isFinite(observed)) throw new Error(`${prefix}_observed_at_invalid`);
  const age = now - observed;
  if (age < -2_000) throw new Error(`${prefix}_observed_at_future`);
  if (age > maxAgeMs) throw new Error(`${prefix}_observed_at_stale`);
  return { raw, source, sourceReference, observedAt: new Date(observed).toISOString() };
}

function routeEvidence(opportunity = {}) {
  const buy = opportunity.buy_route;
  const sell = opportunity.sell_route;
  if (!buy || !sell) throw new Error('shadow_risk_routes_required');
  if (buy.quote_verified !== true || sell.quote_verified !== true) throw new Error('shadow_risk_route_quotes_unverified');
  if (buy.costs_verified !== true || sell.costs_verified !== true) throw new Error('shadow_risk_route_costs_unverified');
  const buyDex = text(buy.dex_id, 'shadow_risk_buy_dex_required').toLowerCase();
  const sellDex = text(sell.dex_id, 'shadow_risk_sell_dex_required').toLowerCase();
  if (new Set([buyDex, sellDex]).size !== 2 || !['orca', 'raydium'].includes(buyDex) || !['orca', 'raydium'].includes(sellDex)) {
    throw new Error('shadow_risk_cross_dex_orca_raydium_required');
  }
  const buyPrice = requiredNumber(buy.price_usd, 'shadow_risk_buy_price_required', { min: Number.MIN_VALUE });
  const sellPrice = requiredNumber(sell.price_usd, 'shadow_risk_sell_price_required', { min: Number.MIN_VALUE });
  const mid = (buyPrice + sellPrice) / 2;
  const spreadBps = Math.abs(sellPrice - buyPrice) / mid * 10_000;
  const liquidityUsd = Math.min(
    requiredNumber(buy.liquidity_usd, 'shadow_risk_buy_liquidity_required', { min: 0 }),
    requiredNumber(sell.liquidity_usd, 'shadow_risk_sell_liquidity_required', { min: 0 })
  );
  const estimatedPriceImpactBps = Math.max(
    requiredNumber(buy.price_impact_bps, 'shadow_risk_buy_impact_required', { min: 0 }),
    requiredNumber(sell.price_impact_bps, 'shadow_risk_sell_impact_required', { min: 0 })
  );
  const sources = new Set([
    text(buy.quote_source, 'shadow_risk_buy_quote_source_required'),
    text(sell.quote_source, 'shadow_risk_sell_quote_source_required')
  ]);
  return { liquidityUsd, spreadBps, estimatedPriceImpactBps, routeCount: 2, sourceCount: sources.size };
}

export function createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource,
  loadTokenRiskSource,
  now = () => Date.now(),
  maxEvidenceAgeMs = 15_000
} = {}) {
  if (typeof loadMarketRiskSource !== 'function') throw new Error('shadow_market_risk_source_required');
  if (typeof loadTokenRiskSource !== 'function') throw new Error('shadow_token_risk_source_required');
  const maxAge = requiredNumber(maxEvidenceAgeMs, 'shadow_risk_evidence_max_age_required', { min: 1 });

  return Object.freeze({
    async loadRiskEvidence({ opportunity, notional_usdc } = {}) {
      if (!opportunity || typeof opportunity !== 'object') throw new Error('shadow_risk_opportunity_required');
      const tokenMint = text(opportunity.token_mint, 'shadow_risk_token_mint_required');
      const quoteMint = text(opportunity.quote_mint, 'shadow_risk_quote_mint_required');
      const route = routeEvidence(opportunity);
      const context = Object.freeze({
        token_mint: tokenMint,
        quote_mint: quoteMint,
        opportunity,
        notional_usdc,
        read_only: true,
        strategy: 'TWO_LEG_ARBITRAGE'
      });
      const [marketRaw, tokenRaw] = await Promise.all([
        loadMarketRiskSource(context),
        loadTokenRiskSource(context)
      ]);
      const timestamp = Number(now());
      if (!Number.isFinite(timestamp)) throw new Error('shadow_risk_now_invalid');
      const market = freshVerifiedSource(marketRaw, { now: timestamp, maxAgeMs: maxAge, prefix: 'shadow_market_risk_source' });
      const token = freshVerifiedSource(tokenRaw, { now: timestamp, maxAgeMs: maxAge, prefix: 'shadow_token_risk_source' });

      if (token.raw.transferable !== true) throw new Error('shadow_token_transferability_not_verified');
      const riskFlags = Array.isArray(token.raw.risk_flags) ? token.raw.risk_flags.map(String).filter(Boolean) : [];

      const data = Object.freeze({
        liquidity_usd: route.liquidityUsd,
        volume_24h_usd: requiredNumber(market.raw.volume_24h_usd, 'shadow_market_volume_required', { min: 0 }),
        spread_bps: route.spreadBps,
        top10_holder_pct: requiredNumber(token.raw.top10_holder_pct, 'shadow_holder_top10_required', { min: 0, max: 100 }),
        token_age_hours: requiredNumber(token.raw.token_age_hours, 'shadow_token_age_required', { min: 0 }),
        route_count: route.routeCount,
        source_count: route.sourceCount,
        volatility_1h_bps: requiredNumber(market.raw.volatility_1h_bps, 'shadow_market_volatility_required', { min: 0 }),
        momentum_5m_bps: requiredNumber(market.raw.momentum_5m_bps, 'shadow_market_momentum_5m_required'),
        momentum_1h_bps: requiredNumber(market.raw.momentum_1h_bps, 'shadow_market_momentum_1h_required'),
        buy_sell_imbalance: requiredNumber(market.raw.buy_sell_imbalance, 'shadow_market_buy_sell_imbalance_required', { min: -1, max: 1 }),
        sell_simulation_ok: true,
        transferable: true,
        risk_flags: Object.freeze(riskFlags),
        estimated_price_impact_bps: route.estimatedPriceImpactBps
      });

      return Object.freeze({
        verified: true,
        data,
        source: 'AETHER_ORCA_RAYDIUM_VERIFIED_RISK_COLLECTOR',
        source_reference: `${market.sourceReference}|${token.sourceReference}`,
        observed_at: new Date(Math.min(Date.parse(market.observedAt), Date.parse(token.observedAt))).toISOString(),
        provenance: Object.freeze({
          market: Object.freeze({ source: market.source, source_reference: market.sourceReference }),
          token: Object.freeze({ source: token.source, source_reference: token.sourceReference })
        }),
        read_only: true,
        transaction_building_authorized: false,
        signer_requested: false,
        network_submission_authorized: false,
        live_execution_authorized: false
      });
    }
  });
}

export const ORCA_RAYDIUM_SHADOW_RISK_EVIDENCE_COLLECTOR = Object.freeze({
  mode: 'SHADOW',
  strategy: 'TWO_LEG_ARBITRAGE',
  route_risk_from_verified_quotes: true,
  verified_market_source_required: true,
  verified_token_source_required: true,
  sell_path_from_verified_sell_route: true,
  transaction_building_authorized: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});
