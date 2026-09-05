import assert from 'node:assert/strict';
import {
  createOrcaRaydiumShadowRiskEvidenceCollector,
  ORCA_RAYDIUM_SHADOW_RISK_EVIDENCE_COLLECTOR
} from '../services/api/src/orca-raydium-shadow-risk-evidence-collector.mjs';

const observedAt = '2026-09-05T16:30:00.000Z';
const now = Date.parse(observedAt);
const source = (name, ref, extra) => async () => ({
  verified: true,
  source: name,
  source_reference: ref,
  observed_at: observedAt,
  ...extra
});
const opportunity = {
  token_mint: 'TokenMint111111111111111111111111111111111',
  quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  buy_route: {
    dex_id: 'orca', price_usd: 1, liquidity_usd: 900000,
    price_impact_bps: 5, fee_bps: 3, quote_source: 'ORCA_RPC', quote_verified: true, costs_verified: true
  },
  sell_route: {
    dex_id: 'raydium', price_usd: 1.01, liquidity_usd: 800000,
    price_impact_bps: 7, fee_bps: 3, quote_source: 'RAYDIUM_RPC', quote_verified: true, costs_verified: true
  }
};

const collector = createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource: source('MARKET_TEST', 'market:1', {
    volume_24h_usd: 3000000,
    token_age_hours: 240,
    volatility_1h_bps: 250,
    momentum_5m_bps: 100,
    momentum_1h_bps: 400,
    buy_sell_imbalance: 0.2
  }),
  loadHolderSource: source('SOLANA_RPC', 'holder:1', { top10_holder_pct: 12 }),
  loadTokenControlSource: source('TOKEN_CONTROL_TEST', 'controls:1', { transferable: true, risk_flags: [] }),
  loadSellSimulationSource: source('SELL_SIM_TEST', 'sell:1', { sell_simulation_ok: true }),
  now: () => now,
  maxEvidenceAgeMs: 15000
});

const evidence = await collector.loadRiskEvidence({ opportunity, notional_usdc: 1000 });
assert.equal(evidence.verified, true);
assert.equal(evidence.data.liquidity_usd, 800000);
assert.ok(evidence.data.spread_bps > 0);
assert.equal(evidence.data.estimated_price_impact_bps, 7);
assert.equal(evidence.data.top10_holder_pct, 12);
assert.equal(evidence.data.route_count, 2);
assert.equal(evidence.data.source_count, 2);
assert.equal(evidence.data.sell_simulation_ok, true);
assert.equal(evidence.data.transferable, true);
assert.equal(evidence.live_execution_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_RISK_EVIDENCE_COLLECTOR.verified_sources_required, 4);

const stale = createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource: source('MARKET_TEST', 'market:1', {
    volume_24h_usd: 3000000, token_age_hours: 240, volatility_1h_bps: 250,
    momentum_5m_bps: 100, momentum_1h_bps: 400, buy_sell_imbalance: 0.2,
    observed_at: '2026-09-05T16:29:00.000Z'
  }),
  loadHolderSource: source('SOLANA_RPC', 'holder:1', { top10_holder_pct: 12 }),
  loadTokenControlSource: source('TOKEN_CONTROL_TEST', 'controls:1', { transferable: true, risk_flags: [] }),
  loadSellSimulationSource: source('SELL_SIM_TEST', 'sell:1', { sell_simulation_ok: true }),
  now: () => now,
  maxEvidenceAgeMs: 15000
});
await assert.rejects(() => stale.loadRiskEvidence({ opportunity, notional_usdc: 1000 }), /shadow_market_risk_source_observed_at_stale/);

const noSellProof = createOrcaRaydiumShadowRiskEvidenceCollector({
  loadMarketRiskSource: source('MARKET_TEST', 'market:1', {
    volume_24h_usd: 3000000, token_age_hours: 240, volatility_1h_bps: 250,
    momentum_5m_bps: 100, momentum_1h_bps: 400, buy_sell_imbalance: 0.2
  }),
  loadHolderSource: source('SOLANA_RPC', 'holder:1', { top10_holder_pct: 12 }),
  loadTokenControlSource: source('TOKEN_CONTROL_TEST', 'controls:1', { transferable: true, risk_flags: [] }),
  loadSellSimulationSource: source('SELL_SIM_TEST', 'sell:1', { sell_simulation_ok: false }),
  now: () => now
});
await assert.rejects(() => noSellProof.loadRiskEvidence({ opportunity, notional_usdc: 1000 }), /shadow_sell_simulation_not_verified/);

console.log('ORCA Raydium SHADOW risk evidence collector regression: PASS');
