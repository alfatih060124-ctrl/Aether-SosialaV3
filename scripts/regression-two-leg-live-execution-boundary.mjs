import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  dispatchTwoLegLiveExecution,
  TWO_LEG_LIVE_EXECUTION_BOUNDARY
} from '../services/api/src/two-leg-live-execution-boundary.mjs';

const decision = Object.freeze({
  strategy: 'TWO_LEG_ARBITRAGE',
  dex_pair: 'ORCA_RAYDIUM',
  action: 'ARBITRAGE_SETTLE',
  qualified: true,
  expected_net_edge_bps: 25,
  risk_verified: true,
  costs_verified: true,
  freshness_verified: true
});

assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.atomic_required, true);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.leg_count, 2);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.directional_execution_supported, false);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.independent_leg_submission_supported, false);
assert.equal(TWO_LEG_LIVE_EXECUTION_BOUNDARY.min_expected_net_edge_bps, 20);

let buildCalls = 0;
let submitCalls = 0;
const blockedAudit = [];
await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision,
    env: { EXECUTION_MODE: 'SHADOW', LIVE_ENABLED: 'false' },
    buildSignedAtomicTransaction: async () => { buildCalls += 1; },
    submitSignedAtomicTransaction: async () => { submitCalls += 1; },
    auditWrite: async event => blockedAudit.push(event)
  }),
  /live_execution_gate_closed/
);
assert.equal(buildCalls, 0);
assert.equal(submitCalls, 0);
assert.equal(blockedAudit.at(-1)?.event_type, 'TWO_LEG_LIVE_EXECUTION_BLOCKED');

const liveEnv = {
  EXECUTION_MODE: 'LIVE',
  LIVE_ENABLED: 'true',
  LIVE_READINESS_PASSED: 'true',
  ADMIN_LIVE_APPROVED: 'true',
  LIVE_SIGNER_UNLOCKED: 'true',
  LIVE_NETWORK_SUBMISSION_ENABLED: 'true',
  LIVE_FUND_MOVEMENT_ENABLED: 'true',
  LIVE_EMERGENCY_KILL_SWITCH: 'false'
};

await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision: { ...decision, expected_net_edge_bps: 19 },
    env: liveEnv,
    auditWrite: async () => {}
  }),
  /two_leg_live_net_edge_below_floor/
);

await assert.rejects(
  dispatchTwoLegLiveExecution({
    decision,
    env: liveEnv,
    buildSignedAtomicTransaction: async () => ({
      strategy: 'TWO_LEG_ARBITRAGE', dex_pair: 'ORCA_RAYDIUM', atomic: false,
      leg_count: 2, legs: [{ dex: 'ORCA' }, { dex: 'RAYDIUM' }], signed: true,
      serialized_transaction: 'opaque'
    }),
    submitSignedAtomicTransaction: async () => { submitCalls += 1; },
    auditWrite: async () => {}
  }),
  /two_leg_atomic_plan_not_atomic/
);

const events = [];
const result = await dispatchTwoLegLiveExecution({
  decision,
  env: liveEnv,
  buildSignedAtomicTransaction: async () => ({
    strategy: 'TWO_LEG_ARBITRAGE',
    dex_pair: 'ORCA_RAYDIUM',
    atomic: true,
    leg_count: 2,
    legs: [{ dex: 'ORCA' }, { dex: 'RAYDIUM' }],
    signed: true,
    serialized_transaction: 'opaque-signed-atomic-transaction'
  }),
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
assert.match(source, /assertLiveExecutionAuthorized/);
assert.match(source, /TWO_LEG_ARBITRAGE/);
assert.match(source, /ORCA_RAYDIUM/);
assert.match(source, /ARBITRAGE_SETTLE/);
assert.match(source, /two_leg_atomic_plan_not_atomic/);
assert.doesNotMatch(source, /decision\.action\s*===?\s*['"]BUY['"]|decision\.action\s*===?\s*['"]SELL['"]/);
assert.doesNotMatch(source, /submitFirstLeg|submitSecondLeg|sendTransaction/);

console.log('two-leg LIVE execution boundary regression: PASS');
