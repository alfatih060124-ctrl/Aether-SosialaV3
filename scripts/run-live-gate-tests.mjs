import assert from 'node:assert/strict';
import { getLiveExecutionGateState } from '../services/api/src/live-execution-gate.mjs';

const closed = getLiveExecutionGateState({}, {});
assert.equal(closed.live_execution_authorized, false);
assert.ok(closed.blockers.includes('EXECUTION_MODE_NOT_LIVE'));
assert.ok(closed.blockers.includes('EMERGENCY_KILL_SWITCH_ACTIVE'));

const stillClosed = getLiveExecutionGateState({
  execution_mode: 'LIVE',
  live_enabled: true,
  readiness_passed: true,
  admin_live_approved: true,
  signer_unlocked: true,
  network_submission_enabled: true,
  fund_movement_enabled: true,
  emergency_kill_switch: true
}, {});
assert.equal(stillClosed.live_execution_authorized, false);
assert.ok(stillClosed.blockers.includes('EMERGENCY_KILL_SWITCH_ACTIVE'));

const open = getLiveExecutionGateState({
  execution_mode: 'LIVE',
  live_enabled: true,
  readiness_passed: true,
  admin_live_approved: true,
  signer_unlocked: true,
  network_submission_enabled: true,
  fund_movement_enabled: true,
  emergency_kill_switch: false
}, {});
assert.equal(open.live_execution_authorized, true);
assert.deepEqual(open.blockers, []);

console.log(JSON.stringify({ ok: true, tests: 3, fail_closed: true }));
