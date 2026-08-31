#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
cd "$APP_DIR"

say(){ printf '[aether-auth] %s\n' "$*"; }
fail(){ printf '[aether-auth] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -s .env ] || fail ".env is missing"
command -v git >/dev/null 2>&1 || fail "git is not installed"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"

grep -Eq '^EXECUTION_MODE=SHADOW$' .env || fail "EXECUTION_MODE must remain SHADOW"
grep -Eq '^LIVE_ENABLED=false$' .env || fail "LIVE_ENABLED must remain false"
grep -Eq '^FIXTURE_GATE_PASSED=false$' .env || fail "FIXTURE_GATE_PASSED must remain false"
grep -Eq '^OPERATOR_APPROVED=false$' .env || fail "OPERATOR_APPROVED must remain false"
grep -Eq '^POSTGRES_PASSWORD=.+$' .env || fail "POSTGRES_PASSWORD is required"
grep -Eq '^API_TOKEN=.+$' .env || fail "API_TOKEN is required"
grep -Eq '^ADMIN_API_TOKEN=.+$' .env || fail "ADMIN_API_TOKEN is required"

say "creating pre-deploy database backup"
if [ -x /usr/local/sbin/aether-db-backup ]; then
  /usr/local/sbin/aether-db-backup
else
  mkdir -p backups
  chmod 700 backups
  backup="backups/pre-wallet-auth-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker compose --env-file .env exec -T postgres pg_dump -U aether -d aether -Fc > "$backup"
  [ -s "$backup" ] || fail "database backup is empty"
  chmod 600 "$backup"
fi

say "fetching approved wallet-auth application and routing files"
git fetch origin main
git checkout origin/main -- \
  services/api/src/server.mjs \
  services/api/src/wallet-auth.mjs \
  migrations/012_wallet_only_accounts.sql \
  deploy/Caddyfile \
  scripts/vm-apply-routing.sh

say "validating SHADOW compose"
docker compose --env-file .env config -q

grep -q '127.0.0.1:8080:8080' docker-compose.yml || fail "API must remain localhost-bound"
if grep -Eq '(^|["[:space:]-])5432:5432(["[:space:]]|$)|0\.0\.0\.0:5432' docker-compose.yml; then
  fail "PostgreSQL host publishing is forbidden"
fi

say "building wallet-auth enabled PRIMARY_VM API"
docker compose --env-file .env up -d --build api

say "waiting for API readiness"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/api/readiness >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail "API readiness timeout"

say "verifying wallet account migrations"
migration_tables="$(docker compose --env-file .env exec -T postgres psql -U aether -d aether -Atqc \"SELECT to_regclass('public.user_accounts'),to_regclass('public.user_wallets'),to_regclass('public.wallet_auth_challenges'),to_regclass('public.wallet_auth_sessions'),to_regclass('public.user_consents');\")"
case "$migration_tables" in
  *user_accounts*user_wallets*wallet_auth_challenges*wallet_auth_sessions*user_consents*) ;;
  *) fail "wallet auth tables are missing" ;;
esac

say "verifying local auth validation and SHADOW posture"
local_auth_code="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8080/api/auth/challenge)"
[ "$local_auth_code" = "400" ] || fail "local wallet-auth endpoint expected HTTP 400 for invalid input, got $local_auth_code"
status="$(curl -fsS --max-time 8 http://127.0.0.1:8080/api/execution/status)"
printf '%s' "$status" | grep -q '"mode":"SHADOW"' || fail "execution mode is not SHADOW"
printf '%s' "$status" | grep -q '"live_enabled":false' || fail "LIVE execution became enabled"

say "applying constrained public wallet-auth routing"
bash scripts/vm-apply-routing.sh

say "verifying host port isolation"
api_port="$(docker port aether-v3-api-1 8080/tcp 2>/dev/null || true)"
printf '%s\n' "$api_port" | grep -q '^127\.0\.0\.1:8080$' || fail "API is not bound exclusively to 127.0.0.1:8080"
postgres_port="$(docker port aether-v3-postgres-1 5432/tcp 2>/dev/null || true)"
[ -z "$postgres_port" ] || fail "PostgreSQL unexpectedly has a published host port: $postgres_port"

say "FINAL: wallet-only authentication backend deployed on PRIMARY_VM"
say "Public ingress exposes read + wallet-auth only; Admin remains isolated; LIVE remains disabled"
