import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyMemberAutoTradeCommand, MEMBER_AUTOTRADE_STATE_MACHINE } from '../services/api/src/member-autotrade-state-machine.mjs';

const now = new Date('2026-09-08T00:00:00.000Z');
const started = applyMemberAutoTradeCommand({ state: 'STOPPED', stop_requested: false }, 'START', { now });
assert.equal(started.state, 'RUNNING_SCANNING');
assert.equal(started.stop_requested, false);
assert.equal(started.started_at, now.toISOString());
assert.throws(() => applyMemberAutoTradeCommand(started, 'START', { now }), /autotrade_start_state_conflict/);
const stopped = applyMemberAutoTradeCommand(started, 'STOP', { now });
assert.equal(stopped.state, 'STOPPED');
assert.equal(stopped.stop_requested, false);

assert.deepEqual(MEMBER_AUTOTRADE_STATE_MACHINE.member_commands, ['START','STOP']);
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.execution_mode, 'SHADOW');
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.execution_dispatched, false);
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.live_execution_authorized, false);
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.transaction_submission_authorized, false);
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.signer_authorized, false);
assert.equal(MEMBER_AUTOTRADE_STATE_MACHINE.fund_movement_authorized, false);

const migration = fs.readFileSync(new URL('../migrations/027_member_autotrade_state_machine.sql', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../services/api/src/member-autotrade-state-route.mjs', import.meta.url), 'utf8');
const dispatcher = fs.readFileSync(new URL('../services/api/src/member-positions-route.mjs', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const edge = fs.readFileSync(new URL('../api/member-autotrade-state.mjs', import.meta.url), 'utf8');
const vercel = fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/autotrade-demo.html', import.meta.url), 'utf8');

for (const token of ['STOPPED','RUNNING_SCANNING','EXECUTING','SETTLING','PAUSED']) assert.match(migration, new RegExp(token));
assert.match(migration, /execution_mode TEXT NOT NULL DEFAULT 'SHADOW'/);
assert.match(migration, /live_execution_authorized BOOLEAN NOT NULL DEFAULT FALSE/);
assert.match(migration, /transaction_submission_authorized BOOLEAN NOT NULL DEFAULT FALSE/);
assert.match(migration, /signer_authorized BOOLEAN NOT NULL DEFAULT FALSE/);
assert.match(migration, /fund_movement_authorized BOOLEAN NOT NULL DEFAULT FALSE/);

for (const path of ['/api/account/autotrade/state','/api/account/autotrade/start','/api/account/autotrade/stop']) {
  const escaped = path.replaceAll('/', '\\/');
  assert.match(route, new RegExp(escaped));
  assert.match(caddy, new RegExp(escaped));
  assert.match(vercel, new RegExp(escaped));
}
assert.match(dispatcher, /handleMemberAutoTradeStateRoute/);
assert.match(edge, /PRIMARY_API_ORIGIN = 'https:\/\/api\.aether\.boats'/);
assert.match(edge, /authorization: `Bearer \$\{token\}`/);
assert.match(ui, /AUTOTRADE_BASE='\/api\/account\/autotrade'/);
assert.match(ui, /Start Auto Demo/);
assert.match(ui, /Stop Auto Demo/);
assert.match(ui, /RUNNING_SCANNING/);
assert.match(ui, /setInterval\(\(\)=>autoCycle\(false\),5000\)/);
assert.match(ui, /There is no daily transaction-count cap/);
assert.match(ui, /LIVE OFF/);

for (const source of [route, edge, dispatcher, ui]) {
  assert.doesNotMatch(source, /sendTransaction|secretKey|fromSecretKey|seed phrase/i);
}

console.log('Step 17 member Auto Trade SHADOW control regression: PASS');
