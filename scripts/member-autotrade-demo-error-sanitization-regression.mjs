import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../services/api/src/member-autotrade-route.mjs', import.meta.url), 'utf8');
const start = source.indexOf('if (route === DEMO_STATE_ROUTE || route === DEMO_SIMULATE_ROUTE)');
const end = source.indexOf('if (route === LEGACY_ROUTE)', start);

assert.notEqual(start, -1, 'persistent demo route boundary must exist');
assert.notEqual(end, -1, 'persistent demo route boundary must remain isolated');

const demoRoute = source.slice(start, end);

assert.equal(
  /error:\s*String\(error\?\.message/.test(demoRoute),
  false,
  'persistent demo API must not reflect raw internal/database exception messages to authenticated clients'
);
assert.match(demoRoute, /mode:\s*'SHADOW'/, 'demo route must remain SHADOW-only');
assert.match(demoRoute, /execution_dispatched:\s*false/, 'demo error responses must remain non-dispatching');
assert.match(demoRoute, /funds_moved:\s*false/, 'demo error responses must never claim funds moved');
assert.match(demoRoute, /live_execution_authorized:\s*false/, 'demo route must never authorize LIVE execution');

console.log(JSON.stringify({
  ok: true,
  schema: 'aether.member_autotrade_demo.error_sanitization.regression.v1',
  mode: 'SHADOW',
  live_execution_authorized: false
}));
