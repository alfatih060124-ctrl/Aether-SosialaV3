import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = await fs.readFile(new URL('./vm-real-market-shadow-probe.mjs', import.meta.url), 'utf8');

for (const envName of ['SIGNAL_MIN_LIQUIDITY_USD', 'SIGNAL_MIN_VOLUME_24H_USD']) {
  assert.doesNotMatch(
    source,
    new RegExp(`Math\\.max\\(0,\\s*Number\\(process\\.env\\.${envName}\\s*\\|\\|`),
    `${envName} must not use fail-open NaN parsing`
  );
}

assert.match(source, /Number\.isFinite\(/, 'shadow probe threshold config must explicitly reject/fallback non-finite values');
assert.match(source, /mode:\s*'SHADOW'/, 'probe must remain SHADOW');
assert.match(source, /live_execution_authorized:\s*false/, 'probe must keep LIVE unauthorized');
assert.match(source, /network_submission_authorized:\s*false/, 'probe must keep network submission unauthorized');
assert.match(source, /signer_requested:\s*false/, 'probe must not request a signer');

console.log('shadow probe threshold config regression: PASS');
