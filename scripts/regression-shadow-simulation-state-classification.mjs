import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../services/api/src/jupiter-unsigned-simulation.mjs', import.meta.url);
const source = fs.readFileSync(sourcePath, 'utf8');
const match = source.match(/function classifySimulationState\(sim\) \{[\s\S]*?\n\}/);
assert.ok(match, 'classifySimulationState must exist');

const context = Object.create(null);
vm.runInNewContext(`${match[0]}; globalThis.__classify = classifySimulationState;`, context);
const classify = context.__classify;
assert.equal(typeof classify, 'function');

const ready = classify({ ok: true, error: null });
assert.equal(ready.state_status, 'SIMULATION_STATE_READY');
assert.equal(ready.account_state_available, true);
assert.equal(ready.route_execution_rejected, false);

const accountMissing = classify({ ok: false, error: 'AccountNotFound' });
assert.equal(accountMissing.state_status, 'SIMULATION_ACCOUNT_STATE_UNAVAILABLE');
assert.equal(accountMissing.account_state_available, false);
assert.equal(accountMissing.route_execution_rejected, false);

for (const sim of [
  { ok: false, error: null },
  { ok: false },
  null,
  undefined
]) {
  const result = classify(sim);
  assert.equal(
    result.account_state_available,
    false,
    'malformed or missing simulation state must fail closed and must not claim account state is available'
  );
  assert.notEqual(
    result.state_status,
    'SIMULATION_STATE_READY',
    'malformed or missing simulation state must never be classified as ready'
  );
}

assert.match(source, /mode:\s*'SHADOW'/);
assert.match(source, /transaction_signed:\s*false/);
assert.match(source, /signer_requested:\s*false/);
assert.match(source, /network_submission_authorized:\s*false/);
assert.match(source, /live_execution_authorized:\s*false/);

console.log('SHADOW simulation state classification regression passed');
