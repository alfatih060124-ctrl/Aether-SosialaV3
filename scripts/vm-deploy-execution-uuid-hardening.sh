#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
cd "$APP_DIR"

say(){ printf '[aether-uuid-hardening] %s\n' "$*"; }
fail(){ printf '[aether-uuid-hardening] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -s .env ] || fail ".env is missing"
for cmd in git docker curl node; do command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is not installed"; done

grep -Eq '^EXECUTION_MODE=SHADOW$' .env || fail "EXECUTION_MODE must remain SHADOW"
grep -Eq '^LIVE_ENABLED=false$' .env || fail "LIVE_ENABLED must remain false"
grep -Eq '^FIXTURE_GATE_PASSED=false$' .env || fail "FIXTURE_GATE_PASSED must remain false"
grep -Eq '^OPERATOR_APPROVED=false$' .env || fail "OPERATOR_APPROVED must remain false"

say "creating pre-deploy database backup"
if [ -x /usr/local/sbin/aether-db-backup ]; then
  /usr/local/sbin/aether-db-backup
else
  mkdir -p backups && chmod 700 backups
  backup="backups/pre-execution-uuid-hardening-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker compose --env-file .env exec -T postgres pg_dump -U aether -d aether -Fc > "$backup"
  [ -s "$backup" ] || fail "database backup is empty"
  chmod 600 "$backup"
fi

rollback_dir="$(mktemp -d)"
cleanup(){ rm -rf "$rollback_dir"; }
trap cleanup EXIT

cp services/api/src/repositories/execution-requests.mjs "$rollback_dir/execution-requests.mjs"
if [ -f scripts/execution-uuid-regression.mjs ]; then
  cp scripts/execution-uuid-regression.mjs "$rollback_dir/execution-uuid-regression.mjs"
fi
changed=0
rollback(){
  rc=$?
  trap - ERR
  if [ "$changed" -eq 1 ]; then
    say "deployment failed; restoring previous execution request repository"
    cp "$rollback_dir/execution-requests.mjs" services/api/src/repositories/execution-requests.mjs
    if [ -f "$rollback_dir/execution-uuid-regression.mjs" ]; then
      cp "$rollback_dir/execution-uuid-regression.mjs" scripts/execution-uuid-regression.mjs
    else
      rm -f scripts/execution-uuid-regression.mjs
    fi
    docker compose --env-file .env up -d --build api >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap rollback ERR

say "fetching approved main revision"
git fetch origin main
TARGET_SHA="$(git rev-parse origin/main)"
[ -n "$TARGET_SHA" ] || fail "origin/main SHA could not be resolved"
say "target main SHA: $TARGET_SHA"

git checkout origin/main -- \
  services/api/src/repositories/execution-requests.mjs \
  scripts/execution-uuid-regression.mjs
changed=1

say "validating fetched fail-closed source"
node --check services/api/src/repositories/execution-requests.mjs
node --check scripts/execution-uuid-regression.mjs
grep -q 'invalid_follower_user_id_uuid' scripts/execution-uuid-regression.mjs || fail "UUID regression fixture missing"
grep -q 'assertUUID' services/api/src/repositories/execution-requests.mjs || fail "UUID validation missing from repository"
node scripts/execution-uuid-regression.mjs

say "validating SHADOW compose isolation"
docker compose --env-file .env config -q
grep -q '127.0.0.1:8080:8080' docker-compose.yml || fail "API must remain localhost-bound"
if grep -Eq '(^|["[:space:]-])5432:5432(["[:space:]]|$)|0\.0\.0\.0:5432' docker-compose.yml; then
  fail "PostgreSQL host publishing is forbidden"
fi

say "rebuilding PRIMARY_VM API"
docker compose --env-file .env up -d --build api

say "waiting for local readiness"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/api/readiness >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail "API readiness timeout"

say "verifying SHADOW/fail-closed runtime"
status="$(curl -fsS --max-time 8 http://127.0.0.1:8080/api/execution/status)"
printf '%s' "$status" | grep -q '"mode":"SHADOW"' || fail "execution mode is not SHADOW"
printf '%s' "$status" | grep -q '"live_enabled":false' || fail "LIVE execution became enabled"
printf '%s' "$status" | grep -q '"fail_closed":true' || fail "runtime is not fail-closed"

api_port="$(docker port aether-v3-api-1 8080/tcp 2>/dev/null || true)"
printf '%s\n' "$api_port" | grep -q '^127\.0\.0\.1:8080$' || fail "API is not bound exclusively to 127.0.0.1:8080"
postgres_port="$(docker port aether-v3-postgres-1 5432/tcp 2>/dev/null || true)"
[ -z "$postgres_port" ] || fail "PostgreSQL unexpectedly has a published host port: $postgres_port"

changed=0
trap - ERR
say "FINAL: execution UUID hardening deployed from $TARGET_SHA"
say "SHADOW preserved; LIVE_ENABLED=false; fail_closed=true"
