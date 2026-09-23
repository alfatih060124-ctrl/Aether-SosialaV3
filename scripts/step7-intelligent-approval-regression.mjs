import assert from 'node:assert/strict';
import {
  settleMemberFromCompletedShadowScan
} from '../services/api/src/member-autotrade-shadow-scheduler.mjs';

const baseCandidate = Object.freeze({
  token_mint: 'TOKEN',
  quote_mint: 'USDC',
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM',
  buy_dex_family: 'ORCA',
  sell_dex_family: 'RAYDIUM',
  buy_pool_address: 'BUY_POOL',
  sell_pool_address: 'SELL_POOL',
  buy_pool_pair_verified: true,
  sell_pool_pair_verified: true,
  notional_usdc: 5,
  gross_profit_before_costs_usdc: 0.005,
  market_execution_cost_usdc: 0.002,
  network_fee_usdc: 0.001,
  market_net_pnl_usdc: 0.003,
  gross_executable_spread_bps: 10,
  expected_net_edge_bps: 6,
  net_edge_gate_passed: true,
  costs_verified: true,
  exact_transaction_fee_ready: true,
  transaction_built: true,
  atomic_two_leg: true,
  simulation_attempted: true,
  roundtrip_simulation_ok: true,
  analysis_latency_ms: 120,
  analysis_sla_passed: true,
  paper_approval_passed: true,
  opportunity_age_ms: 450,
  observed_at: '2026-09-19T08:00:00.000Z',
  mode: 'SHADOW',
  execution_dispatched: false,
  transaction_signed: false,
  network_submission_authorized: false,
  live_execution_authorized: false
});

const member = Object.freeze({
  user_id: '00000000-0000-0000-0000-000000000001',
  wallet_address: 'wallet-1',
  state: 'RUNNING_SCANNING'
});

async function evaluate(candidate, label) {
  const transitions = [];
  let state = 'RUNNING_SCANNING';
  let persisted = 0;
  const transition = async (_pool, _userId, command) => {
    transitions.push(command);
    if (command === 'BEGIN_EXECUTION') state = 'EXECUTING';
    if (command === 'BEGIN_SETTLING') state = 'SETTLING';
    if (command === 'SETTLED') state = 'RUNNING_SCANNING';
    if (command === 'FAIL') state = 'PAUSED';
    return { state, live_execution_authorized: false };
  };
  const scan = {
    scan_id: 'scan-' + label,
    status: 'COMPLETE',
    mode: 'SHADOW',
    live_execution_authorized: false,
    summary: { measured: [candidate] }
  };
  const result = await settleMemberFromCompletedShadowScan({
    pool: {},
    repos: null,
    member,
    scan,
    performanceFeeBps: 0,
    executionFeeBps: 0,
    paperMinNetEdgeBps: 0.5,
    transition,
    persist: async () => {
      persisted += 1;
      return { duplicate: false };
    }
  });
  return { result, transitions, persisted };
}

const valid = await evaluate(baseCandidate, 'valid');
assert.equal(valid.result.settled, 1);
assert.equal(valid.persisted, 1);
assert.deepEqual(valid.transitions, ['BEGIN_EXECUTION', 'BEGIN_SETTLING', 'SETTLED']);

const rejectedCases = [
  ['same-dex-distinct-pool', { sell_dex: 'ORCA', sell_dex_family: 'ORCA', sell_pool_address: 'SELL_POOL_ORCA_2' }],
  ['not-built', { transaction_built: false }],
  ['non-atomic', { atomic_two_leg: false }],
  ['no-exact-fee', { exact_transaction_fee_ready: false }],
  ['costs-unverified', { costs_verified: false }],
  ['simulation-failed', { roundtrip_simulation_ok: false }],
  ['scanner-sla', { analysis_latency_ms: 301, analysis_sla_passed: false, paper_approval_passed: false }],
  ['stale', { opportunity_age_ms: 3001, paper_approval_passed: false }],
  ['below-edge', { expected_net_edge_bps: 0.49, net_edge_gate_passed: false, paper_approval_passed: false }],
  ['approval-failed', { paper_approval_passed: false }],
  ['same-pool', { sell_dex: 'ORCA', sell_pool_address: 'BUY_POOL' }],
  ['missing-buy-pool', { buy_pool_address: null }],
  ['buy-pair-unverified', { buy_pool_pair_verified: false }],
  ['sell-pair-unverified', { sell_pool_pair_verified: false }],
  ['live-mode', { mode: 'LIVE' }],
  ['submission-authorized', { network_submission_authorized: true }]
];

for (const [label, patch] of rejectedCases) {
  const tested = await evaluate({ ...baseCandidate, ...patch }, label);
  assert.equal(tested.result.settled, 0, label);
  assert.equal(tested.persisted, 0, label);
  assert.equal(tested.transitions.length, 0, label);
}

console.log('step7 intelligent approval regression: PASS');