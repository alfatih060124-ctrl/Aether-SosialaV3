#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
ENV_FILE="$APP_DIR/.env"
LOCAL_API="${LOCAL_API:-http://127.0.0.1:8080}"
PUBLIC_API="${PUBLIC_API:-https://api.aether.boats}"
ADMIN_API="${ADMIN_API:-https://a.aether.boats}"
EXPECTED_SHA="${EXPECTED_SHA:-}"

say(){ printf '[aether-postdeploy-audit] %s\n' "$*"; }
fail(){ printf '[aether-postdeploy-audit] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout"
[ -s "$ENV_FILE" ] || fail "$ENV_FILE is missing or empty"
cd "$APP_DIR"

printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-fA-F]{40}$' || fail "EXPECTED_SHA must be a 40-character approved commit SHA"
EXPECTED_SHA="$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')"
CURRENT_SHA="$(git rev-parse HEAD | tr 'A-F' 'a-f')"
[ "$CURRENT_SHA" = "$EXPECTED_SHA" ] || fail "runtime checkout does not match approved SHA: expected $EXPECTED_SHA found $CURRENT_SHA"

for cmd in git docker curl grep sed cut; do command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is not installed"; done
docker compose version >/dev/null 2>&1 || fail "docker compose is unavailable"

# Read only named gate/token variables. Never print .env or secret values.
grep -Eq '^EXECUTION_MODE=SHADOW$' "$ENV_FILE" || fail "EXECUTION_MODE must remain SHADOW"
grep -Eq '^LIVE_ENABLED=false$' "$ENV_FILE" || fail "LIVE_ENABLED must remain false"
grep -Eq '^FIXTURE_GATE_PASSED=false$' "$ENV_FILE" || fail "FIXTURE_GATE_PASSED must remain false"
grep -Eq '^OPERATOR_APPROVED=false$' "$ENV_FILE" || fail "OPERATOR_APPROVED must remain false"
grep -Eq '^API_TOKEN=.+$' "$ENV_FILE" || fail "API_TOKEN is missing"
grep -Eq '^ADMIN_API_TOKEN=.+$' "$ENV_FILE" || fail "ADMIN_API_TOKEN is missing"
ADMIN_API_TOKEN="$(grep -m1 '^ADMIN_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$ADMIN_API_TOKEN" ] || fail "ADMIN_API_TOKEN is empty"

expect_code(){
  local expected="$1" method="$2" url="$3" code
  code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X "$method" "$url")" || fail "request failed: $method $url"
  [ "$code" = "$expected" ] || fail "$method $url expected HTTP $expected but got $code"
}

admin_get_body(){
  local url="$1"
  curl -fsS --max-time 10 --config - "$url" <<EOF
header = "Authorization: Bearer $ADMIN_API_TOKEN"
EOF
}

admin_get_status(){
  local url="$1"
  admin_get_body "$url" >/dev/null || fail "authorized Admin read failed: $url"
}

db_scalar(){
  docker compose --env-file "$ENV_FILE" exec -T postgres \
    psql -U aether -d aether -Atqc "$1"
}

say "checking container and host-port isolation"
docker inspect -f '{{.State.Running}}' aether-v3-postgres-1 2>/dev/null | grep -qx true || fail "Postgres container is not running"
docker inspect -f '{{.State.Running}}' aether-v3-api-1 2>/dev/null | grep -qx true || fail "API container is not running"
api_port="$(docker port aether-v3-api-1 8080/tcp 2>/dev/null || true)"
printf '%s\n' "$api_port" | grep -q '^127\.0\.0\.1:8080$' || fail "API must be bound exclusively to 127.0.0.1:8080"
postgres_port="$(docker port aether-v3-postgres-1 5432/tcp 2>/dev/null || true)"
[ -z "$postgres_port" ] || fail "PostgreSQL unexpectedly has a published host port"

say "checking local runtime SHADOW invariants"
LOCAL_HEALTH="$(curl -fsS --max-time 8 "$LOCAL_API/api/health")"
LOCAL_READY="$(curl -fsS --max-time 8 "$LOCAL_API/api/readiness")"
LOCAL_VERSION="$(curl -fsS --max-time 8 "$LOCAL_API/api/version")"
LOCAL_EXEC="$(curl -fsS --max-time 8 "$LOCAL_API/api/execution/status")"
LOCAL_AUTO="$(curl -fsS --max-time 8 "$LOCAL_API/api/autotrade/status")"
printf '%s' "$LOCAL_HEALTH" | grep -q '"status":"ok"' || fail "local health failed"
printf '%s' "$LOCAL_READY" | grep -q '"status":"ready"' || fail "local readiness failed"
printf '%s' "$LOCAL_VERSION" | grep -q '"execution_mode":"SHADOW"' || fail "local version is not SHADOW"
printf '%s' "$LOCAL_VERSION" | grep -q '"live_enabled":false' || fail "local version reports LIVE enabled"
printf '%s' "$LOCAL_EXEC" | grep -q '"mode":"SHADOW"' || fail "local execution mode is not SHADOW"
printf '%s' "$LOCAL_EXEC" | grep -q '"live_enabled":false' || fail "local execution reports LIVE enabled"
printf '%s' "$LOCAL_EXEC" | grep -q '"fail_closed":true' || fail "local execution is not fail-closed"
printf '%s' "$LOCAL_EXEC" | grep -q '"signer_exposed_to_api":false' || fail "signer boundary failed"
printf '%s' "$LOCAL_AUTO" | grep -q '"mode":"SHADOW"' || fail "Auto Trade mode is not SHADOW"
printf '%s' "$LOCAL_AUTO" | grep -q '"execution_dispatched":false' || fail "Auto Trade unexpectedly reports execution dispatch"
printf '%s' "$LOCAL_AUTO" | grep -q '"live_execution_authorized":false' || fail "Auto Trade unexpectedly authorizes LIVE"

say "checking public ingress read lanes"
for path in /api/health /api/readiness /api/version /api/execution/status /api/signals/config /api/autotrade/status /api/traders?limit=1 /api/marketplace/fees; do
  curl -fsS --max-time 10 "$PUBLIC_API$path" >/dev/null || fail "public read failed: $path"
done
expect_code 401 GET "$PUBLIC_API/api/auth/session"
expect_code 401 GET "$PUBLIC_API/api/account/trader"
expect_code 404 GET "$PUBLIC_API/api/admin/wallets/readiness"
expect_code 404 POST "$PUBLIC_API/api/shadow/simulate"

say "checking direct PRIMARY_VM authentication fences"
expect_code 401 POST "$LOCAL_API/api/shadow/simulate"
expect_code 401 GET "$LOCAL_API/api/executions"
expect_code 401 GET "$LOCAL_API/api/admin/wallets/readiness"
expect_code 401 GET "$ADMIN_API/api/admin/wallets/readiness"

say "checking authorized Admin read-only lanes without printing data"
WALLET_READY="$(admin_get_body "$LOCAL_API/api/admin/wallets/readiness")" || fail "wallet readiness read failed"
printf '%s' "$WALLET_READY" | grep -q '"live_execution_authorized":false' || fail "wallet readiness unexpectedly authorizes LIVE"
printf '%s' "$WALLET_READY" | grep -q '"private_keys_stored":false' || fail "wallet readiness reports private keys stored"
printf '%s' "$WALLET_READY" | grep -q '"user_funds_custodied":false' || fail "wallet readiness reports user funds custodied"
admin_get_status "$LOCAL_API/api/admin/traders/applications?limit=1"
admin_get_status "$LOCAL_API/api/admin/audit"
admin_get_status "$LOCAL_API/api/admin/copy-policies?limit=1"

say "checking repository/database migration parity"
repo_migrations="$(find migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)"
db_migrations="$(db_scalar 'SELECT version FROM schema_migrations ORDER BY version')"
[ "$repo_migrations" = "$db_migrations" ] || fail "database schema_migrations does not exactly match repository"

say "checking database SHADOW/separation invariants"
[ "$(db_scalar "SELECT count(*) FROM traders WHERE mode IS DISTINCT FROM 'SHADOW'")" = "0" ] || fail "non-SHADOW trader rows detected"
[ "$(db_scalar "SELECT count(*) FROM copy_policies WHERE mode IS DISTINCT FROM 'SHADOW' OR live_execution_authorized IS DISTINCT FROM false")" = "0" ] || fail "copy mandate SHADOW/LIVE invariant violated"
[ "$(db_scalar "SELECT count(*) FROM traders WHERE published=true AND NOT (onboarding_status='APPROVED' AND verification_status='VERIFIED' AND verified=true AND status='ACTIVE' AND mode='SHADOW')")" = "0" ] || fail "published trader verification gate violated"
[ "$(db_scalar "SELECT count(*) FROM trader_reconciled_trades WHERE reconciliation_status IS DISTINCT FROM 'RECONCILED'")" = "0" ] || fail "invalid reconciled trade state detected"
[ "$(db_scalar "SELECT count(*) FROM execution_requests WHERE mode='LIVE'")" = "0" ] || fail "LIVE execution request rows detected"

say "MANUAL_REQUIRED: wallet-signature login/onboarding must be tested with the user's wallet; this audit never handles signing material"
say "MANUAL_REQUIRED: automatic evidence collection, VERIFY/REJECT, publication, and Copy Mandate mutations are intentionally not invoked by this read-only audit"
say "FINAL: READ_ONLY_POSTDEPLOY_AUDIT=PASS sha=$CURRENT_SHA SHADOW=true LIVE=false signer_exposed_to_api=false"
