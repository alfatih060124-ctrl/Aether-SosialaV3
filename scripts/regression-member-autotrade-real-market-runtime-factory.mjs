import assert from 'node:assert/strict';
import { createConfiguredMemberAutoTradeRealMarketRuntime, MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY } from '../services/api/src/member-autotrade-real-market-runtime-factory.mjs';

assert.throws(() => createConfiguredMemberAutoTradeRealMarketRuntime({ env: {} }), /solana_rpc_unconfigured/);
assert.throws(() => createConfiguredMemberAutoTradeRealMarketRuntime({ env: { SOLANA_RPC_URL: 'https://rpc.example.test', AUTOTRADE_SHADOW_MAX_CANDIDATES: '0' } }), /autotrade_shadow_max_candidates_invalid/);

const runtime = createConfiguredMemberAutoTradeRealMarketRuntime({
  env: {
    SOLANA_RPC_URL: 'https://rpc.example.test',
    AUTOTRADE_SHADOW_NOTIONAL_USDC: '10',
    AUTOTRADE_SHADOW_MAX_CANDIDATES: '5'
  },
  fetchImpl: async () => { throw new Error('network_not_expected_during_factory_construction'); }
});
assert.equal(typeof runtime.runNextOpportunity, 'function');
assert.equal(MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY.mode, 'SHADOW');
assert.equal(MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY.min_expected_net_edge_bps, 20);
assert.equal(MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY.transaction_count_per_day_capped, false);
assert.equal(MEMBER_AUTOTRADE_REAL_MARKET_RUNTIME_FACTORY.live_execution_authorized, false);
console.log('Member Auto Trade real-market runtime factory regression: PASS');
