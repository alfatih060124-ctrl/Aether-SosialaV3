import assert from 'node:assert/strict';
import fs from 'node:fs';

const runtimeSource = fs.readFileSync('services/api/src/market-shadow-runtime.mjs', 'utf8');
const routeSource = fs.readFileSync('services/api/src/member-autotrade-route.mjs', 'utf8');
const page = fs.readFileSync('public/autotrade-demo.html', 'utf8');
const runtime = await import(`../services/api/src/market-shadow-runtime.mjs?observability-regression=${Date.now()}`);
const state = runtime.getMarketShadowRuntimeState();

assert.equal(state.status, 'IDLE');
assert.equal(state.mode, 'SHADOW');
assert.equal(state.min_expected_net_edge_bps, 20);
assert.equal(state.live_execution_authorized, false);
assert.equal(state.observability.scan_target_ms, 30000);
assert.equal(state.observability.scans_started, 0);
assert.equal(state.observability.scans_completed, 0);
assert.equal(state.observability.scans_failed, 0);
assert.equal(state.observability.current_scan_duration_ms, null);
assert.equal(state.observability.last_scan_duration_ms, null);
assert.equal(state.observability.mode, 'SHADOW');
assert.equal(state.observability.min_expected_net_edge_bps, 20);
assert.equal(state.observability.live_execution_authorized, false);

for (const required of [
  'runtime_session',
  'scan_target_ms',
  'last_scan_duration_ms',
  'scans_completed',
  'scans_failed'
]) assert.ok(runtimeSource.includes(required), `runtime observability missing ${required}`);
for (const required of [
  'MARKET_SHADOW_SCAN_STARTED',
  'MARKET_SHADOW_SCAN_COMPLETED',
  'MARKET_SHADOW_SCAN_FAILED',
  "entity_type: 'market_shadow_scan'",
  'audit_recorded',
  "mode: 'SHADOW'",
  'live_execution_authorized: false'
]) assert.ok(routeSource.includes(required), `audit trail missing ${required}`);

for (const required of [
  'id="scanDuration"',
  'runtime scans',
  'scan_target_ms',
  'Runtime scan counters are observability',
  'SHADOW · LIVE OFF'
]) assert.ok(page.includes(required), `observability dashboard missing ${required}`);

assert.ok(!runtimeSource.includes('live_execution_authorized: true'));
assert.ok(!routeSource.includes('network_submission_authorized: true'));
assert.ok(!page.includes('LIVE authorized=true'));

console.log('market shadow observability regression: PASS');
