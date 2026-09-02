import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const routeStart = source.indexOf("if(req.method==='PATCH'&&route==='/api/admin/fees')");
assert.notEqual(routeStart, -1, 'legacy admin fee route must remain explicit and guarded');
const routeEnd = source.indexOf('\n', routeStart);
const route = source.slice(routeStart, routeEnd === -1 ? source.length : routeEnd);

assert.match(route, /fee_control_lifecycle_required/, 'legacy route must fail closed into canonical lifecycle');
assert.match(route, /live_execution_authorized:false/, 'legacy route must preserve SHADOW authorization posture');
assert.match(route, /network_submission_authorized:false/, 'legacy route must not authorize network submission');
assert.match(route, /signer_required:false/, 'legacy route must not require signer material');
assert.doesNotMatch(route, /updateFeeConfig/, 'legacy route must not mutate platform fee configuration directly');
assert.doesNotMatch(route, /PLATFORM_FEE_CONFIG_UPDATED/, 'legacy route must not emit a successful mutation audit event');

console.log('fee route fail-closed regression: PASS');
