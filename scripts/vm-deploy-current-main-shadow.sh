#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
ENV_FILE="$APP_DIR/.env"
PUBLIC_API="${PUBLIC_API:-https://api.aether.boats}"
EXPECTED_SHA="${EXPECTED_SHA:-}"
SMOKE_PORT="${SMOKE_PORT:-18082}"
BACKUP_DIR="$APP_DIR/backups"

say(){ printf '[aether-current-main] %s\n' "$*"; }
fail(){ printf '[aether-current-main] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout"
[ -s "$ENV_FILE" ] || fail "$ENV_FILE is missing or empty"
cd "$APP_DIR"

printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-fA-F]{40}$' || fail "EXPECTED_SHA must be the approved 40-character commit SHA"
EXPECTED_SHA="$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')"

for cmd in git docker curl; do command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is not installed"; done
docker compose version >/dev/null 2>&1 || fail "docker compose is unavailable"

# Never print the .env file or any secret values.
grep -Eq '^EXECUTION_MODE=SHADOW$' "$ENV_FILE" || fail "EXECUTION_MODE must remain SHADOW"
grep -Eq '^LIVE_ENABLED=false$' "$ENV_FILE" || fail "LIVE_ENABLED must remain false"
grep -Eq '^FIXTURE_GATE_PASSED=false$' "$ENV_FILE" || fail "FIXTURE_GATE_PASSED must remain false"
grep -Eq '^OPERATOR_APPROVED=false$' "$ENV_FILE" || fail "OPERATOR_APPROVED must remain false"
grep -Eq '^POSTGRES_PASSWORD=.+$' "$ENV_FILE" || fail "POSTGRES_PASSWORD is missing"
grep -Eq '^API_TOKEN=.+$' "$ENV_FILE" || fail "API_TOKEN is missing"
grep -Eq '^ADMIN_API_TOKEN=.+$' "$ENV_FILE" || fail "ADMIN_API_TOKEN is missing"
chmod 600 "$ENV_FILE"

branch="$(git branch --show-current)"
[ "$branch" = "main" ] || fail "PRIMARY_VM checkout must be on main (found: ${branch:-detached})"
git diff --quiet || fail "tracked working tree changes detected"
git diff --cached --quiet || fail "staged changes detected"

docker inspect -f '{{.State.Running}}' aether-v3-postgres-1 2>/dev/null | grep -qx true || fail "Postgres container is not running"
docker inspect -f '{{.State.Running}}' aether-v3-api-1 2>/dev/null | grep -qx true || fail "API container is not running"

say "creating verified pre-deploy database backup"
if [ -x /usr/local/sbin/aether-db-backup ]; then
  /usr/local/sbin/aether-db-backup
else
  install -d -m 0700 "$BACKUP_DIR"
  backup="$BACKUP_DIR/pre-current-main-$(date -u +%Y%m%dT%H%M%SZ).dump"
  tmp="$backup.tmp"
  trap 'rm -f "$tmp"' EXIT INT TERM
  docker compose --env-file "$ENV_FILE" exec -T postgres pg_dump -U aether -d aether -Fc > "$tmp"
  [ -s "$tmp" ] || fail "database backup is empty"
  docker compose --env-file "$ENV_FILE" exec -T postgres pg_restore -l < "$tmp" >/dev/null
  mv "$tmp" "$backup"
  chmod 600 "$backup"
  trap - EXIT INT TERM
fi

say "fetching approved main revision"
git fetch --prune origin main
TARGET_SHA="$(git rev-parse origin/main | tr 'A-F' 'a-f')"
[ "$TARGET_SHA" = "$EXPECTED_SHA" ] || fail "origin/main moved: expected $EXPECTED_SHA but found $TARGET_SHA; re-approve CI before deployment"
CURRENT_SHA="$(git rev-parse HEAD | tr 'A-F' 'a-f')"
git merge-base --is-ancestor "$CURRENT_SHA" "$TARGET_SHA" || fail "local main diverged from approved origin/main; refusing non-fast-forward update"

say "fast-forwarding tracked source to $TARGET_SHA"
git merge --ff-only "$TARGET_SHA"
[ "$(git rev-parse HEAD | tr 'A-F' 'a-f')" = "$TARGET_SHA" ] || fail "HEAD did not reach approved target"

say "validating SHADOW compose isolation"
docker compose --env-file "$ENV_FILE" config -q
grep -q '127.0.0.1:8080:8080' docker-compose.yml || fail "API must remain localhost-bound"
if grep -Eq '(^|["[:space:]-])5432:5432(["[:space:]]|$)|0\.0\.0\.0:5432' docker-compose.yml; then
  fail "PostgreSQL host publishing is forbidden"
fi
if grep -Eq 'EXECUTION_MODE:[[:space:]]*LIVE|LIVE_ENABLED:[[:space:]]*"?true"?' docker-compose.yml; then
  fail "compose contains LIVE enablement"
fi

say "building candidate API image"
docker compose --env-file "$ENV_FILE" build api
CANDIDATE_IMAGE="$(docker compose --env-file "$ENV_FILE" images -q api | head -1)"
[ -n "$CANDIDATE_IMAGE" ] || fail "candidate API image could not be resolved"

SMOKE_NAME="aether-current-main-smoke-$$"
cleanup_smoke(){ docker rm -f "$SMOKE_NAME" >/dev/null 2>&1 || true; }
trap cleanup_smoke EXIT INT TERM
cleanup_smoke
say "running isolated candidate smoke test"
docker run -d --name "$SMOKE_NAME" \
  --read-only \
  --security-opt no-new-privileges:true \
  -p "127.0.0.1:${SMOKE_PORT}:8080" \
  -e EXECUTION_MODE=SHADOW \
  -e LIVE_ENABLED=false \
  -e FIXTURE_GATE_PASSED=false \
  -e OPERATOR_APPROVED=false \
  "$CANDIDATE_IMAGE" >/dev/null

candidate_ready=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${SMOKE_PORT}/api/health" >/dev/null 2>&1; then candidate_ready=1; break; fi
  sleep 1
done
[ "$candidate_ready" -eq 1 ] || fail "candidate API health timeout"
CANDIDATE_STATUS="$(curl -fsS --max-time 5 "http://127.0.0.1:${SMOKE_PORT}/api/execution/status")"
printf '%s' "$CANDIDATE_STATUS" | grep -q '"mode":"SHADOW"' || fail "candidate mode is not SHADOW"
printf '%s' "$CANDIDATE_STATUS" | grep -q '"live_enabled":false' || fail "candidate LIVE flag is not false"
printf '%s' "$CANDIDATE_STATUS" | grep -q '"fail_closed":true' || fail "candidate is not fail-closed"
printf '%s' "$CANDIDATE_STATUS" | grep -q '"signer_exposed_to_api":false' || fail "candidate signer boundary failed"
code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SMOKE_PORT}/api/readiness")"
[ "$code" = "503" ] || fail "isolated candidate unexpectedly reported database readiness"
cleanup_smoke
trap - EXIT INT TERM

say "recreating PRIMARY_VM API from approved image/source"
docker compose --env-file "$ENV_FILE" up -d --force-recreate api

say "waiting for database-backed readiness and migrations"
ready=0
for _ in $(seq 1 45); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/api/readiness >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail "PRIMARY_VM API readiness timeout"

say "verifying migration set exactly matches repository"
repo_migrations="$(find migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)"
db_migrations="$(docker compose --env-file "$ENV_FILE" exec -T postgres psql -U aether -d aether -Atqc 'SELECT version FROM schema_migrations ORDER BY version')"
[ "$repo_migrations" = "$db_migrations" ] || fail "database schema_migrations does not exactly match repository migrations"

say "verifying local SHADOW/fail-closed runtime"
LOCAL_HEALTH="$(curl -fsS --max-time 8 http://127.0.0.1:8080/api/health)"
LOCAL_STATUS="$(curl -fsS --max-time 8 http://127.0.0.1:8080/api/execution/status)"
LOCAL_VERSION="$(curl -fsS --max-time 8 http://127.0.0.1:8080/api/version)"
printf '%s' "$LOCAL_HEALTH" | grep -q '"status":"ok"' || fail "local health failed"
printf '%s' "$LOCAL_STATUS" | grep -q '"mode":"SHADOW"' || fail "local execution mode is not SHADOW"
printf '%s' "$LOCAL_STATUS" | grep -q '"live_enabled":false' || fail "local LIVE flag is not false"
printf '%s' "$LOCAL_STATUS" | grep -q '"fail_closed":true' || fail "local runtime is not fail-closed"
printf '%s' "$LOCAL_STATUS" | grep -q '"signer_exposed_to_api":false' || fail "local signer boundary failed"

api_port="$(docker port aether-v3-api-1 8080/tcp 2>/dev/null || true)"
printf '%s\n' "$api_port" | grep -q '^127\.0\.0\.1:8080$' || fail "API is not bound exclusively to 127.0.0.1:8080"
postgres_port="$(docker port aether-v3-postgres-1 5432/tcp 2>/dev/null || true)"
[ -z "$postgres_port" ] || fail "PostgreSQL unexpectedly has a published host port: $postgres_port"

say "verifying public SHADOW endpoints"
PUBLIC_READY="$(curl -fsS --max-time 10 "$PUBLIC_API/api/readiness")"
PUBLIC_STATUS="$(curl -fsS --max-time 10 "$PUBLIC_API/api/execution/status")"
printf '%s' "$PUBLIC_READY" | grep -q '"status":"ready"' || fail "public readiness failed"
printf '%s' "$PUBLIC_STATUS" | grep -q '"mode":"SHADOW"' || fail "public execution mode is not SHADOW"
printf '%s' "$PUBLIC_STATUS" | grep -q '"live_enabled":false' || fail "public LIVE flag is not false"

say "deployed version response: $LOCAL_VERSION"
say "FINAL: PRIMARY_VM updated to approved main $TARGET_SHA"
say "SHADOW preserved; LIVE_ENABLED=false; fail_closed=true; signer_exposed_to_api=false"
