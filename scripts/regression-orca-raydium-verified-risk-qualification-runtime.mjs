import assert from 'node:assert/strict';
import {
  createOrcaRaydiumVerifiedRiskQualificationRuntime,
  ORCA_RAYDIUM_VERIFIED_RISK_QUALIFICATION_RUNTIME
} from '../services/api/src/orca-raydium-verified-risk-qualification-runtime.mjs';

const noopScanner = { async scanPair() { return { source: 'ORCA_RAYDIUM_REAL_MARKET', opportunities: [] }; } };
const noopFee = async () => ({ network_fee_usdc: 0, network_fee_verified: true });

assert.throws(() => createOrcaRaydiumVerifiedRiskQualificationRuntime({
  scannerRuntime: noopScanner,
  loadNetworkFeeEvidence: noopFee,
  rpcUrl: 'https://rpc.invalid',
  notionalUsdc: 100
}), /verified_risk_sell_simulation_source_required/);

const runtime = createOrcaRaydiumVerifiedRiskQualificationRuntime({
  scannerRuntime: noopScanner,
  loadNetworkFeeEvidence: noopFee,
  loadSellSimulationSource: async () => ({
    verified: true,
    sell_simulation_ok: true,
    source: 'TEST_VERIFIED_SELL_SIMULATION',
    source_reference: 'test:sell-sim',
    observed_at: new Date().toISOString()
  }),
  rpcUrl: 'https://rpc.invalid',
  notionalUsdc: 100
});

assert.equal(runtime.mode, 'SHADOW');
assert.equal(runtime.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(runtime.verified_sell_simulation_required, true);
assert.equal(runtime.live_execution_authorized, false);
assert.equal(runtime.transaction_building_authorized, false);
assert.equal(ORCA_RAYDIUM_VERIFIED_RISK_QUALIFICATION_RUNTIME.verified_sell_simulation_required, true);
assert.equal(ORCA_RAYDIUM_VERIFIED_RISK_QUALIFICATION_RUNTIME.min_expected_net_edge_bps, 20);

const result = await runtime.scanAndQualifyPair({ token_mint: 'TOKEN', quote_mint: 'USDC', demo_account: { cash_balance_usdc: 1000, open_position: {} } });
assert.equal(result.mode, 'SHADOW');
assert.equal(result.qualified_count, 0);
assert.equal(result.live_execution_authorized, false);

console.log('ORCA Raydium verified risk qualification runtime regression: PASS');
