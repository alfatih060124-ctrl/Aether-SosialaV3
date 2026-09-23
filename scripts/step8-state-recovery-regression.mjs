import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyMemberAutoTradeCommand,
  MEMBER_AUTOTRADE_STATE_MACHINE
} from '../services/api/src/member-autotrade-state-machine.mjs';

const now = new Date('2026-09-19T08:30:00.000Z');

const executing = applyMemberAutoTradeCommand({
  state: 'EXECUTING',
  stop_requested: false
}, 'RECOVER_TIMEOUT', { now });
assert.equal(executing.state, 'PAUSED');
assert.equal(executing.stop_requested, false);
assert.equal(executing.paused_at, now.toISOString());

const settlingStop = applyMemberAutoTradeCommand({
  state: 'SETTLING',
  stop_requested: true
}, 'RECOVER_TIMEOUT', { now });
assert.equal(settlingStop.state, 'STOPPED');
assert.equal(settlingStop.stop_requested, false);
assert.equal(settlingStop.stopped_at, now.toISOString());

assert.throws(
  () => applyMemberAutoTradeCommand(
    { state: 'RUNNING_SCANNING', stop_requested: false },
    'RECOVER_TIMEOUT',
    { now }
  ),
  /autotrade_recovery_state_conflict/
);

assert.ok(MEMBER_AUTOTRADE_STATE_MACHINE.internal_commands.includes('RECOVER_TIMEOUT'));

const schedulerSource = fs.readFileSync(
  new URL('../services/api/src/member-autotrade-shadow-scheduler.mjs', import.meta.url),
  'utf8'
);
assert.match(schedulerSource, /AUTOTRADE_SHADOW_STATE_RECOVERY_MS/);
assert.match(schedulerSource, /state IN \('EXECUTING','SETTLING'\)/);
assert.match(schedulerSource, /RECOVER_TIMEOUT/);
assert.match(schedulerSource, /MEMBER_AUTOTRADE_SHADOW_STATE_RECOVERED/);
assert.doesNotMatch(schedulerSource, /sendTransaction|secretKey|fromSecretKey|seed phrase/i);

console.log('step8 state recovery regression: PASS');