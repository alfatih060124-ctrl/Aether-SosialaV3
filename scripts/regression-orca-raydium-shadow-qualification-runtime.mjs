import assert from 'node:assert/strict';
import {
  createOrcaRaydiumShadowQualificationRuntime,
  ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME
} from '../services/api/src/orca-raydium-shadow-qualification-runtime.mjs';

const observedAt = '2026-09-06T00:00:00.000Z';
const opportunity = {
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  observed_at: observedAt,
  market_source: 'ORCA_RAYDIUM_REAL_MARKET',
  buy_route: {
    dex_id: 'orca', pool_address: 'orca-pool', price_usd: 1,
    fee_bps: 1, price_impact_bps: 1, liquidity_usd: 5_000_000,
    quote_source: 'ORCA_WHIRLPOOLS_ONCHAIN_RPC_TEST', quote_verified: true, costs_verified: true
  },
  sell_route: {
    dex_id: 'raydium', pool_address: 'ray-pool', price_usd: 1.01,
    fee_bps: 1, price_impact_bps: 1, liquidity_usd: 5_000_000,
    quote_source: 'RAYDIUM_ONCHAIN_RPC_CPMM_TEST', quote_verified: true, costs_verified: true
  }
};

const scannerRuntime = {
  async scanPair() {
    return { source: 'ORCA_RAYDIUM_REAL_MARKET', opportunities: [opportunity] };
  }
};

const riskData = {
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

const runtime = createOrcaRaydiumShadowQualificationRuntime({
  scannerRuntime,
  notionalUsdc: 1000,
  loadNetworkFeeEvidence: async () => ({ network_fee_usdc: 0.01, network_fee_verified: true }),
  loadRiskEvidence: async () => ({ verified: true, data: riskData }),
  now: () => Date.parse(observedAt)
});

const result = await runtime.scanAndQualifyPair({
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  demo_account: { cash_balance_usdc: 2000, open_position: {} }
});
assert.equal(result.mode, 'SHADOW');
assert.equal(result.qualified_count, 1);
assert.equal(result.results[0].assessment.decision.action, 'ARBITRAGE_SETTLE');
assert.equal(result.results[0].assessment.arbitrage.net_edge_bps >= 20, true);
assert.equal(result.results[0].settlement.settlement_status, 'ARBITRAGE_CLOSED');
assert.equal(result.results[0].funds_moved, false);
assert.equal(result.live_execution_authorized, false);
assert.equal(ORCA_RAYDIUM_SHADOW_QUALIFICATION_RUNTIME.min_expected_net_edge_bps, 20);

const feeBlocked = createOrcaRaydiumShadowQualificationRuntime({
  scannerRuntime,
  notionalUsdc: 1000,
  loadNetworkFeeEvidence: async () => ({ network_fee_usdc: 0.01, network_fee_verified: false }),
  loadRiskEvidence: async () => ({ verified: true, data: riskData }),
  now: () => Date.parse(observedAt)
});
await assert.rejects(
  () => feeBlocked.scanAndQualifyPair({ token_mint: 'TOKEN', quote_mint: 'USDC', demo_account: { cash_balance_usdc: 2000, open_position: {} } }),
  /shadow_network_fee_unverified/
);

const riskBlocked = createOrcaRaydiumShadowQualificationRuntime({
  scannerRuntime,
  notionalUsdc: 1000,
  loadNetworkFeeEvidence: async () => ({ network_fee_usdc: 0.01, network_fee_verified: true }),
  loadRiskEvidence: async () => ({ verified: false, data: riskData }),
  now: () => Date.parse(observedAt)
});
await assert.rejects(
  () => riskBlocked.scanAndQualifyPair({ token_mint: 'TOKEN', quote_mint: 'USDC', demo_account: { cash_balance_usdc: 2000, open_position: {} } }),
  /shadow_risk_evidence_unverified/
);

console.log('ORCA Raydium SHADOW qualification runtime regression: PASS');
