import assert from 'node:assert/strict';
import fs from 'node:fs';

const path = new URL('./vm-deploy-current-main-shadow.sh', import.meta.url);
const source = fs.readFileSync(path, 'utf8');

assert.match(source, /set -Eeuo pipefail/);
assert.match(source, /EXPECTED_SHA/);
assert.match(source, /approved 40-character commit SHA/);
assert.match(source, /origin\/main moved: expected/);
assert.match(source, /git merge --ff-only/);
assert.match(source, /git merge-base --is-ancestor/);
assert.doesNotMatch(source, /git reset --hard/);
assert.doesNotMatch(source, /git clean(?:\s|$)/);
assert.doesNotMatch(source, /git checkout -f/);
assert.doesNotMatch(source, /cat\s+[^\n]*\.env/);
assert.doesNotMatch(source, /source\s+[^\n]*\.env/);
assert.doesNotMatch(source, /LIVE_ENABLED=true/);
assert.doesNotMatch(source, /OPERATOR_APPROVED=true/);
assert.doesNotMatch(source, /FIXTURE_GATE_PASSED=true/);
assert.doesNotMatch(source, /docker compose[^\n]*images -q api/);

for (const invariant of [
  '^EXECUTION_MODE=SHADOW$',
  '^LIVE_ENABLED=false$',
  '^FIXTURE_GATE_PASSED=false$',
  '^OPERATOR_APPROVED=false$'
]) {
  assert.ok(source.includes(invariant), `missing env invariant ${invariant}`);
}

const backupIndex = source.indexOf('creating verified pre-deploy database backup');
const fetchIndex = source.indexOf('fetching approved main revision');
const mergeIndex = source.indexOf('git merge --ff-only');
const buildIndex = source.indexOf('building explicitly tagged candidate API image');
const recreateIndex = source.indexOf('up -d --build --force-recreate api');
const migrationIndex = source.indexOf('verifying migration set exactly matches repository');
const localSafetyIndex = source.indexOf('verifying local SHADOW/fail-closed runtime');
const publicSafetyIndex = source.indexOf('verifying public SHADOW endpoints');

for (const [name, index] of Object.entries({ backupIndex, fetchIndex, mergeIndex, buildIndex, recreateIndex, migrationIndex, localSafetyIndex, publicSafetyIndex })) {
  assert.ok(index >= 0, `${name} missing`);
}
assert.ok(backupIndex < fetchIndex, 'backup must happen before source update');
assert.ok(fetchIndex < mergeIndex, 'fetch/approval must happen before fast-forward');
assert.ok(mergeIndex < buildIndex, 'source must reach approved SHA before candidate build');
assert.ok(buildIndex < recreateIndex, 'candidate must be built/smoked before PRIMARY_VM recreation');
assert.ok(recreateIndex < migrationIndex, 'migration verification must happen after API startup');
assert.ok(migrationIndex < localSafetyIndex, 'migration set must verify before runtime success');
assert.ok(localSafetyIndex < publicSafetyIndex, 'local runtime must pass before public success');

assert.match(source, /pg_dump/);
assert.match(source, /pg_restore -l/);
assert.match(source, /CANDIDATE_IMAGE="aether-current-main-candidate:\$\{TARGET_SHA\}"/);
assert.match(source, /docker build -t "\$CANDIDATE_IMAGE" \./);
assert.match(source, /docker image inspect "\$CANDIDATE_IMAGE"/);
assert.match(source, /up -d --build --force-recreate api/);
assert.match(source, /--read-only/);
assert.match(source, /no-new-privileges:true/);
assert.match(source, /isolated candidate unexpectedly reported database readiness/);
assert.match(source, /SELECT version FROM schema_migrations ORDER BY version/);
assert.match(source, /database schema_migrations does not exactly match repository migrations/);
assert.match(source, /"mode":"SHADOW"/);
assert.match(source, /"live_enabled":false/);
assert.match(source, /"fail_closed":true/);
assert.match(source, /"signer_exposed_to_api":false/);
assert.match(source, /127\\\.0\\\.0\\\.1:8080/);
assert.match(source, /PostgreSQL unexpectedly has a published host port/);
assert.match(source, /FINAL: PRIMARY_VM updated to approved main/);

console.log('current main rollout regression: PASS');
