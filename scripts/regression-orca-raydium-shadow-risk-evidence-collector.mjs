import assert from 'node:assert/strict';
import {
  createOrcaRaydiumShadowRiskEvidenceCollector,
  ORCA_RAYDIUM_SHADOW_RISK_EVIDENCE_COLLECTOR
} from '../services/api/src/orca-raydium-shadow-risk-evidence-collector.mjs';

const nowMs = Date.parse('2026-09-06T00:00:00.000Z');
const observedAt = new Date(nowMs - 1000).toISOString();
const opportunity = {
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  buy_route: {
    dex_id: 'orca', pool_address: 'orca-pool', price_usd: 1,
    fee_bps: 2, price_impact_bps: 3, liquidity_usd: 1_000_000,
    quote_source: 'ORCA_WHIRLPOOLS_ONCHAIN_RPC_SLOT_1', quote_verified: true, costs_verified: true
  },
  sell_route: {
    dex_id: 'raydium', pool_address: 'ray-pool', price_usd: 1.004,
    fee_bps: 2, price_impact_bps: 4, liquidity_usd: 800_000,
    quote_source: 'RAYDIUM_ONCHAIN_RPC_CPMM_SLOT_1', quote_verified: true, costs_verified: true
  }
};

const marketSource = overrides => async context => ({
  verified: true,
  source: 'VERIFIED_MARKET_ANALYTICS',
  source_reference: `market:${context.token_mint}`,
  observed_at: observedAt,
  volume_24h_usd: 2_000_000,
  volatility_1h_bps: 300,
  momentum_5m_bps: 50,
  momentum_1h_bps: 100,
  buy_sell_imbalance: 0.1,
  ...overrides
});
const tokenSource = overrides => async context => ({
  verified: true,
  source: 'SOLANA_CONFIRMED_RPC_TOKEN_RISK',
  source_reference: `token:${context.token_mint}`,
  observed_at: observedAt,
  top10_holder_pct: 20,
  token_age_hours: 100,
  transferable: true,
  risk_flags: [],
  ...overrides
});

const collector = createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource: marketSource(),
  loadTokenRiskSource: tokenSource(),
  now: () => nowMs,
  maxEvidenceAgeMs: 5_000
});
const evidence = await collector.loadRiskEvidence({ opportunity, notional_usdc: 100 });
assert.equal(evidence.verified, true);
assert.equal(evidence.data.liquidity_usd, 800_000);
assert.ok(evidence.data.spread_bps > 0);
assert.equal(evidence.data.estimated_price_impact_bps, 4);
assert.equal(evidence.data.top10_holder_pct, 20);
assert.equal(evidence.data.sell_simulation_ok, true);
assert.equal(evidence.data.transferable, true);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_RISK_EVIDENCE_COLLECTOR.verified_token_source_required, true);

const staleCollector = createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource: marketSource({ observed_at: new Date(nowMs - 60_000).toISOString() }),
  loadTokenRiskSource: tokenSource(),
  now: () => nowMs,
  maxEvidenceAgeMs: 5_000
});
await assert.rejects(() => staleCollector.loadRiskEvidence({ opportunity }), /shadow_market_risk_source_observed_at_stale/);

const unverifiedToken = createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource: marketSource(),
  loadTokenRiskSource: tokenSource({ verified: false }),
  now: () => nowMs
});
await assert.rejects(() => unverifiedToken.loadRiskEvidence({ opportunity }), /shadow_token_risk_source_unverified/);

const badRouteCollector = createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource: marketSource(),
  loadTokenRiskSource: tokenSource(),
  now: () => nowMs
});
await assert.rejects(
  () => badRouteCollector.loadRiskEvidence({ opportunity: { ...opportunity, sell_route: { ...opportunity.sell_route, costs_verified: false } } }),
  /shadow_risk_route_costs_unverified/
);

console.log('ORCA Raydium SHADOW risk evidence collector regression: PASS');
