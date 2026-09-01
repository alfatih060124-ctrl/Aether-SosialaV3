import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const script = await fs.readFile(new URL('./vm-postdeploy-shadow-audit.sh', import.meta.url), 'utf8');

for (const required of [
  'EXPECTED_SHA',
  'EXECUTION_MODE=SHADOW',
  'LIVE_ENABLED=false',
  'FIXTURE_GATE_PASSED=false',
  'OPERATOR_APPROVED=false',
  'READ_ONLY_POSTDEPLOY_AUDIT=PASS',
  'signer_exposed_to_api=false',
  'expect_code 401 POST "$LOCAL_API/api/shadow/simulate"',
  'expect_code 404 POST "$PUBLIC_API/api/shadow/simulate"',
  'expect_code 401 GET "$LOCAL_API/api/admin/wallets/readiness"',
  'private_keys_stored',
  'user_funds_custodied',
  'schema_migrations',
  'trader_reconciled_trades',
  'execution_requests',
  'MANUAL_REQUIRED: wallet-signature login/onboarding',
  'VERIFY/REJECT, publication, and Copy Mandate mutations are intentionally not invoked'
]) {
  assert.ok(script.includes(required), `post-deploy audit missing guard: ${required}`);
}

for (const forbidden of [
  'git reset --hard',
  'git clean ',
  'git merge ',
  'git pull ',
  'docker compose up',
  'docker compose down',
  'docker rm ',
  'docker restart',
  'set -x',
  'cat "$ENV_FILE"',
  'PATCH ',
  'PUT ',
  'DELETE ',
  'INSERT INTO',
  'UPDATE traders',
  'UPDATE copy_policies',
  'DELETE FROM',
  'TRUNCATE ',
  'ALTER TABLE',
  'DROP TABLE'
]) {
  assert.equal(script.includes(forbidden), false, `read-only audit contains forbidden mutation: ${forbidden}`);
}

// The only POST requests in the audit are intentionally unauthenticated fence probes.
const postLines = script.split('\n').filter(line => /expect_code\s+\d+\s+POST\s+/.test(line));
assert.deepEqual(postLines.map(line => line.trim()), [
  'expect_code 404 POST "$PUBLIC_API/api/shadow/simulate"',
  'expect_code 401 POST "$LOCAL_API/api/shadow/simulate"'
]);

assert.ok(script.includes('admin_get_body "$LOCAL_API/api/admin/wallets/readiness"'));
assert.ok(script.includes('admin_get_status "$LOCAL_API/api/admin/traders/applications?limit=1"'));
assert.ok(script.includes('admin_get_status "$LOCAL_API/api/admin/audit"'));
assert.ok(script.includes('admin_get_status "$LOCAL_API/api/admin/copy-policies?limit=1"'));
assert.equal(/printf[^\n]*ADMIN_API_TOKEN/.test(script), false, 'Admin token must never be printed');
assert.equal(/echo[^\n]*ADMIN_API_TOKEN/.test(script), false, 'Admin token must never be echoed');

console.log('post-deployment SHADOW audit regression: PASS');
