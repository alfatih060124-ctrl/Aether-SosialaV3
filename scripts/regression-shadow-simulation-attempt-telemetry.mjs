import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = await fs.readFile(new URL('./vm-real-market-shadow-probe.mjs', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /transaction_build_attempted:\s*Boolean\(quoteEvidence\s*&&\s*priceImpactGatePassed\s*&&\s*simulationAttempts\s*<=\s*simulationLimit\)/,
  'per-candidate transaction_build_attempted must not be inferred from the global simulation counter after the probe limit is exhausted'
);

assert.match(
  source,
  /simulation_skipped_probe_limit/,
  'probe must preserve an explicit probe-limit skip state'
);
assert.match(source, /mode:\s*'SHADOW'/, 'probe must remain SHADOW');
assert.match(source, /execution_dispatched:\s*false/, 'probe must not dispatch execution');
assert.match(source, /transaction_signed:\s*false/, 'probe must not claim signing');
assert.match(source, /network_submission_authorized:\s*false/, 'probe must keep network submission unauthorized');
assert.match(source, /signer_requested:\s*false/, 'probe must not request a signer');
assert.match(source, /live_execution_authorized:\s*false/, 'probe must keep LIVE unauthorized');

console.log('shadow simulation attempt telemetry regression: PASS');
