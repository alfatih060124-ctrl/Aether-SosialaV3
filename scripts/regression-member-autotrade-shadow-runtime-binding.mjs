import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyMemberAutoTradeCommand, MEMBER_AUTOTRADE_STATE_MACHINE } from '../services/api/src/member-autotrade-state-machine.mjs';
import { MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING } from '../services/api/src/member-autotrade-shadow-runtime-binding.mjs';

const now = new Date('2026-09-06T13:00:00.000Z');
for (const state of ['RUNNING_SCANNING','EXECUTING','SETTLING']) {
  const failed = applyMemberAutoTradeCommand({ state, stop_requested: false }, 'FAIL', { now });
  assert.equal(failed.state, 'PAUSED');
  assert.equal(failed.stop_requested, false);
  assert.equal(failed.paused_at, now.toISOString());
}
assert.throws(() => applyMemberAutoTradeCommand({ state: 'STOPPED' }, 'FAIL', { now }), /autotrade_fail_state_conflict/);
assert.ok(MEMBER_AUTOTRADE_STATE_MACHINE.internal_commands.includes('FAIL'));

assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.mode, 'SHADOW');
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.strategy, 'TWO_LEG_ARBITRAGE');
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.required_state, 'RUNNING_SCANNING');
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.qualified_action, 'ARBITRAGE_SETTLE');
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.no_qualified_opportunity_is_error, false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.transaction_count_cap, null);
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.execution_dispatched, false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.signer_authorized, false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.funds_moved, false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.network_submission_authorized, false);
assert.equal(MEMBER_AUTOTRADE_SHADOW_RUNTIME_BINDING.live_execution_authorized, false);

const source = fs.readFileSync(new URL('../services/api/src/member-autotrade-shadow-runtime-binding.mjs', import.meta.url), 'utf8');
assert.match(source, /runNextOpportunity/);
assert.match(source, /persistQualifiedPaperArbitrage/);
assert.match(source, /BEGIN_EXECUTION/);
assert.match(source, /BEGIN_SETTLING/);
assert.match(source, /SETTLED/);
assert.match(source, /'FAIL'/);
assert.match(source, /NO_QUALIFIED_OPPORTUNITY/);
assert.match(source, /state='RUNNING_SCANNING'/);
assert.match(source, /execution_mode='SHADOW'/);
assert.doesNotMatch(source, /sendTransaction|secretKey|fromSecretKey|signTransaction|signAllTransactions/i);

console.log('Member Auto Trade SHADOW runtime binding regression: PASS');
