import assert from 'node:assert/strict';
import {
  createOrcaRaydiumShadowEvidenceAdapter,
  ORCA_RAYDIUM_SHADOW_EVIDENCE_ADAPTER
} from '../services/api/src/orca-raydium-shadow-evidence-adapter.mjs';

const now = Date.parse('2026-09-05T16:30:00.000Z');
const observedAt = '2026-09-05T16:29:59.000Z';
const riskData = {
  liquidity_usd: 1_000_000,
  volume_24h_usd: 3_000_000,
  spread_bps: 8,
  top10_holder_pct: 12,
  token_age_hours: 240,
  route_count: 2,
  source_count: 2,
  volatility_1h_bps: 250,
  momentum_5m_bps: 300,
  momentum_1h_bps: 700,
  buy_sell_imbalance: 0.35,
  sell_simulation_ok: true,
  transferable: true,
  risk_flags: []
};

const adapter = createOrcaRaydiumShadowEvidenceAdapter({
  now: () => now,
  maxEvidenceAgeMs: 5_000,
  loadNetworkFeeSource: async request => ({
    verified: true,
    network_fee_usdc: 0.01,
    source: 'NETWORK_FEE_TEST_SOURCE',
    source_reference: 'fee:test:1',
    observed_at: observedAt,
    request
  }),
  loadRiskSource: async request => ({
    verified: true,
    data: riskData,
    source: 'RISK_TEST_SOURCE',
    source_reference: 'risk:test:1',
    observed_at: observedAt,
    request
  })
});

const fee = await adapter.loadNetworkFeeEvidence({ opportunity: { direction: 'ORCA_TO_RAYDIUM' } });
assert.equal(fee.network_fee_verified, true);
assert.equal(fee.network_fee_usdc, 0.01);
assert.equal(fee.read_only, true);
assert.equal(fee.live_execution_authorized, false);

const risk = await adapter.loadRiskEvidence({ opportunity: { direction: 'ORCA_TO_RAYDIUM' } });
assert.equal(risk.verified, true);
assert.equal(risk.data.transferable, true);
assert.equal(risk.read_only, true);
assert.equal(risk.live_execution_authorized, false);

const stale = createOrcaRaydiumShadowEvidenceAdapter({
  now: () => now,
  maxEvidenceAgeMs: 500,
  loadNetworkFeeSource: async () => ({ verified: true, network_fee_usdc: 0.01, source: 'x', source_reference: 'y', observed_at: observedAt }),
  loadRiskSource: async () => ({ verified: true, data: riskData, source: 'x', source_reference: 'y', observed_at: observedAt })
});
await assert.rejects(() => stale.loadNetworkFeeEvidence({}), /shadow_network_fee_source_observed_at_stale/);

const unverified = createOrcaRaydiumShadowEvidenceAdapter({
  now: () => now,
  loadNetworkFeeSource: async () => ({ verified: false }),
  loadRiskSource: async () => ({ verified: false })
});
await assert.rejects(() => unverified.loadNetworkFeeEvidence({}), /shadow_network_fee_source_unverified/);
await assert.rejects(() => unverified.loadRiskEvidence({}), /shadow_risk_source_unverified/);

assert.equal(ORCA_RAYDIUM_SHADOW_EVIDENCE_ADAPTER.requires_verified_sources, true);
assert.equal(ORCA_RAYDIUM_SHADOW_EVIDENCE_ADAPTER.transaction_building_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_EVIDENCE_ADAPTER.network_submission_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_EVIDENCE_ADAPTER.live_execution_authorized, false);

console.log('ORCA Raydium SHADOW evidence adapter regression: PASS');
