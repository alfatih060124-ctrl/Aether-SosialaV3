import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  dispatchTwoLegLiveExecution,
  TWO_LEG_LIVE_EXECUTION_BOUNDARY
} from '../services/api/src/two-leg-live-execution-boundary.mjs';

const nowMs = Date.parse('2026-09-06T15:30:00.000Z');
const decision = Object.freeze({
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  action: 'ARBITRAGE_SETTLE',
  qualified: true,
  expected_net_edge_bps: 25,
  risk_verified: true,
  costs_verified: true,
  freshness_verified: true,
  observed_at: new Date(nowMs - 1000).toISOString(),
  token_mint: 'TOKEN_MINT',
  quote_mint: 'USDC_MINT',
  notional_usdc_atomic: '10000000',
  buy_dex: 'ORCA',
  sell_dex: 'RAYDIUM'
});

assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.atomic_required, true);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.leg_count, 2);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.directional_execution_supported, false);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.independent_leg_submission_supported, false);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.min_expected_net_edge_bps, 20);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.max_decision_age_ms_default, 15000);

const liveEnv = {
  EXECUTION_MODE: 'LIVE',
  LIVE_ENABLED: 'true',
  LIVE_READINESS_PASSED: 'true',
  ADMIN_LIVE_APPROVED: 'true',
  LIVE_SIGNER_UNLOCKED: 'true',
  LIVE_NETWORK_SUBMISSION_ENABLED: 'true',
  LIVE_FUND_MOVEMENT_ENABLED: 'true',
  LIVE_EMERGENCY_KILL_SWITCH: 'false',
  LIVE_MAX_DECISION_AGE_MS: '15000'
};

let buildCalls = 0;
let submitCalls = 0;
const blockedAudit = [];
await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision,
    env: { EXECUTION_MODE: 'SHADOW', LIVE_ENABLED: 'false', LIVE_MAX_DECISION_AGE_MS: '15000' },
    now: () => nowMs,
    buildSignedAtomicTransaction: async () => { buildCalls += 1; },
    submitSignedAtomicTransaction: async () => { submitCalls += 1; },
    auditWrite: async event => blockedAudit.push(event)
  }),
  /live_execution_gate_closed/
);
assert.equal(buildCalls, 0);
assert.equal(submitCalls, 0);
assert.equal(blockedAudit.at(-1)?.event_type, 'TWO_LEG_LIVE_EXECUTION_BLOCKED');

const staleAudit = [];
await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision: { ...decision, observed_at: new Date(nowMs - 16000).toISOString() },
    env: liveEnv,
    now: () => nowMs,
    auditWrite: async event => staleAudit.push(event)
  }),
  /two_leg_live_decision_stale/
);
assert.equal(staleAudit.at(-1)?.phase, 'VALIDATION');

const belowFloorAudit = [];
await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision: { ...decision, expected_net_edge_bps: 19 },
    env: liveEnv,
    now: () => nowMs,
    auditWrite: async event => belowFloorAudit.push(event)
  }),
  /two_leg_live_net_edge_below_floor/
);
assert.equal(belowFloorAudit.at(-1)?.event_type, 'TWO_LEG_LIVE_EXECUTION_BLOCKED');

const planBase = {
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  atomic: true,
  leg_count: 2,
  token_mint: decision.token_mint,
  quote_mint: decision.quote_mint,
  notional_usdc_atomic: decision.notional_usdc_atomic,
  legs: [{ dex: 'ORCA', side: 'BUY' }, { dex: 'RAYDIUM', side: 'SELL' }],
  signed: true,
  serialized_transaction: 'opaque-signed-atomic-transaction'
};

await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision,
    env: liveEnv,
    now: () => nowMs,
    buildSignedAtomicTransaction: async () => ({ ...planBase, serialized_transaction: ['buy-tx', 'sell-tx'] }),
    submitSignedAtomicTransaction: async () => { submitCalls += 1; },
    auditWrite: async () => {}
  }),
  /two_leg_atomic_plan_transaction_required/
);

await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision,
    env: liveEnv,
    now: () => nowMs,
    buildSignedAtomicTransaction: async () => ({ ...planBase, token_mint: 'OTHER_TOKEN' }),
    submitSignedAtomicTransaction: async () => { submitCalls += 1; },
    auditWrite: async () => {}
  }),
  /two_leg_atomic_plan_token_pair_mismatch/
);

await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision,
    env: liveEnv,
    now: () => nowMs,
    buildSignedAtomicTransaction: async () => ({ ...planBase, legs: [{ dex: 'RAYDIUM', side: 'BUY' }, { dex: 'ORCA', side: 'SELL' }] }),
    submitSignedAtomicTransaction: async () => { submitCalls += 1; },
    auditWrite: async () => {}
  }),
  /two_leg_atomic_plan_buy_leg_mismatch/
);

const events = [];
const result = await dispatchTwoLegLiveExecution({
  decision,
  env: liveEnv,
  now: () => nowMs,
  buildSignedAtomicTransaction: async () => planBase,
  submitSignedAtomicTransaction: async ({ plan }) => ({ accepted: true, atomic: plan.atomic }),
  auditWrite: async event => events.push(event)
});
assert.equal(result.atomic, true);
assert.equal(result.leg_count, 2);
assert.equal(result.execution_dispatched, true);
assert.equal(result.live_execution_authorized, true);
assert.equal(result.network_submission_authorized, true);
assert.equal(events.at(-1)?.event_type, 'TWO_LEG_LIVE_EXECUTION_AUTHORIZED');

const source = await fs.readFile(new URL('../services/api/src/two-leg-live-execution-boundary.mjs', import.meta.url), 'utf8');
assert.match(source, /two_leg_live_decision_stale/);
assert.match(source, /two_leg_atomic_plan_token_pair_mismatch/);
assert.match(source, /Uint8Array/);
assert.match(source, /TWO_LEG_LIVE_EXECUTION_BLOCKED/);
assert.doesNotMatch(source, /decision\.action\s*===?\s*['"]BUY['"]|decision\.action\s*===?\s*['"]SELL['"]/);
assert.doesNotMatch(source, /submitFirstLeg|submitSecondLeg|sendTransaction/);

console.log('two-leg LIVE execution boundary regression: PASS');
