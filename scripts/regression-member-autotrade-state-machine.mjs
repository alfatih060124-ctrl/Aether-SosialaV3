import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyMemberAutoTradeCommand, MEMBER_AUTOTRADE_STATE_MACHINE } from '../services/api/src/member-autotrade-state-machine.mjs';

const now = new Date('2026-09-06T12:00:00.000Z');
const base = { state: 'STOPPED', stop_requested: false };

const started = applyMemberAutoTradeCommand(base, 'START', { now });
assert.equal(started.state, 'RUNNING_SCANNING');
assert.equal(started.stop_requested, false);
assert.equal(started.started_at, now.toISOString());
assert.throws(() => applyMemberAutoTradeCommand(started, 'START', { now }), /autotrade_start_state_conflict/);
const paused = applyMemberAutoTradeCommand(started, 'PAUSE', { now });
assert.equal(paused.state, 'PAUSED');
const resumed = applyMemberAutoTradeCommand(paused, 'START', { now });
assert.equal(resumed.state, 'RUNNING_SCANNING');
const executing = applyMemberAutoTradeCommand(resumed, 'BEGIN_EXECUTION', { now });
assert.equal(executing.state, 'EXECUTING');
const stopDuringExecution = applyMemberAutoTradeCommand(executing, 'STOP', { now });
assert.equal(stopDuringExecution.state, 'EXECUTING');
assert.equal(stopDuringExecution.stop_requested, true);
const settling = applyMemberAutoTradeCommand(stopDuringExecution, 'BEGIN_SETTLING', { now });
assert.equal(settling.state, 'SETTLING');
const stoppedAfterSettlement = applyMemberAutoTradeCommand(settling, 'SETTLED', { now });
assert.equal(stoppedAfterSettlement.state, 'STOPPED');
assert.equal(stoppedAfterSettlement.stop_requested, false);
const directStop = applyMemberAutoTradeCommand(started, 'STOP', { now });
assert.equal(directStop.state, 'STOPPED');
assert.equal(directStop.stopped_at, now.toISOString());

assert.deepEqual(MEMBER_AUTOTRADE_STATE_MACHINE.states, ['STOPPED','RUNNING_SCANNING','EXECUTING','SETTLING','PAUSED']);
assert.deepEqual(MEMBER_AUTOTRADE_STATE_MACHINE.member_commands, ['START','STOP']);
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.execution_mode, 'SHADOW');
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.execution_dispatched, false);
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.live_execution_authorized, false);

const migration = fs.readFileSync(new URL('../migrations/027_member_autotrade_state_machine.sql', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../services/api/src/member-autotrade-state-route.mjs', import.meta.url), 'utf8');
const dispatcher = fs.readFileSync(new URL('../services/api/src/member-positions-route.mjs', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../api/member-autotrade-state.mjs', import.meta.url), 'utf8');
const vercel = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
const memberUi = fs.readFileSync(new URL('../public/member.html', import.meta.url), 'utf8');
const manifest = fs.readFileSync(new URL('../deploy/vercel-direct-deploy-manifest.json', import.meta.url), 'utf8');
const machine = fs.readFileSync(new URL('../services/api/src/member-autotrade-state-machine.mjs', import.meta.url), 'utf8');

for (const token of ['RUNNING_SCANNING','EXECUTING','SETTLING','PAUSED']) assert.match(migration, new RegExp(token));
assert.match(migration, /live_execution_authorized BOOLEAN NOT NULL DEFAULT FALSE/);
for (const path of ['/api/account/autotrade/state','/api/account/autotrade/start','/api/account/autotrade/stop']) {
  const escaped = path.replaceAll('/', '\\/');
  assert.match(route, new RegExp(escaped));
  assert.match(caddy, new RegExp(escaped));
  assert.match(vercel, new RegExp(escaped));
}
assert.match(route, /execution_dispatched: false/);
assert.match(dispatcher, /handleMemberAutoTradeStateRoute/);
assert.match(edge, /PRIMARY_API_ORIGIN = 'https:\/\/api\.aether\.boats'/);
assert.match(edge, /authorization: `Bearer \$\{token\}`/);
assert.match(edge, /execution_dispatched: false/);
assert.match(memberUi, /\/api\/account\/autotrade\/state/);
assert.match(memberUi, /setAutoTrade\('start'\)/);
assert.match(memberUi, /setAutoTrade\('stop'\)/);
assert.match(memberUi, /RUNNING_SCANNING/);
assert.match(memberUi, /LIVE authorized=false/);
assert.match(manifest, /api\/member-autotrade-state\.mjs/);
for (const source of [route, edge, machine]) {
  assert.doesNotMatch(source, /sendTransaction|secretKey|fromSecretKey|seed phrase/i);
}
assert.doesNotMatch(memberUi, /sendTransaction|secretKey|fromSecretKey/i);

console.log('Member Auto Trade state machine regression: PASS');
