#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
cd "$APP_DIR"

say(){ printf '[aether-product] %s\n' "$*"; }
fail(){ printf '[aether-product] ERROR: %s\n' "$*" >&2; exit 1; }

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
grep -Eq '^ADMIN_API_TOKEN=.+$' .env || fail "ADMIN_API_TOKEN is required"

say "creating pre-deploy database backup"
if [ -x /usr/local/sbin/aether-db-backup ]; then
  /usr/local/sbin/aether-db-backup
else
  mkdir -p backups && chmod 700 backups
  backup="backups/pre-verification-copy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker compose --env-file .env exec -T postgres pg_dump -U aether -d aether -Fc > "$backup"
  [ -s "$backup" ] || fail "database backup is empty"
  chmod 600 "$backup"
fi

say "fetching approved verification/copy files"
git fetch origin main
git checkout origin/main -- \
  services/api/src/server.mjs \
  services/api/src/repositories/core.mjs \
  services/api/src/repositories/admin.mjs \
  services/api/src/repositories/marketplace.mjs \
  migrations/014_trader_verification_copy_mandates.sql \
  deploy/Caddyfile \
  scripts/vm-apply-routing.sh \
  web/admin.html

say "validating SHADOW compose"
docker compose --env-file .env config -q
grep -q '127.0.0.1:8080:8080' docker-compose.yml || fail "API must remain localhost-bound"
if grep -Eq '(^|["[:space:]-])5432:5432(["[:space:]]|$)|0\.0\.0\.0:5432' docker-compose.yml; then
  fail "PostgreSQL host publishing is forbidden"
fi

say "building verification/copy enabled PRIMARY_VM API"
docker compose --env-file .env up -d --build api

say "waiting for API readiness"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/api/readiness >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail "API readiness timeout"

say "verifying migration"
evidence_table="$(docker compose --env-file .env exec -T postgres psql -U aether -d aether -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='trader_verification_evidence';")"
[ "$evidence_table" = "1" ] || fail "trader_verification_evidence table missing"
copy_columns="$(docker compose --env-file .env exec -T postgres psql -U aether -d aether -Atqc "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='copy_policies' AND column_name IN ('mode','status','allocation_bps','max_slippage_bps','max_daily_loss_bps','stop_drawdown_bps','live_execution_authorized');")"
[ "$copy_columns" = "7" ] || fail "copy mandate columns incomplete: $copy_columns/7"

say "verifying local session/admin fences"
for spec in \
  "GET /api/account/copy-mandates" \
  "POST /api/account/copy-mandates" \
  "PATCH /api/account/copy-mandates/00000000-0000-0000-0000-000000000000"; do
  method="${spec%% *}"; path="${spec#* }"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data '{}' "http://127.0.0.1:8080$path")"
  [ "$code" = "401" ] || fail "$method $path expected HTTP 401 without session, got $code"
done
admin_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/admin/copy-policies)"
[ "$admin_code" = "401" ] || fail "admin copy policies expected HTTP 401 without admin auth, got $admin_code"

say "verifying SHADOW posture"
status="$(curl -fsS --max-time 8 http://127.0.0.1:8080/api/execution/status)"
printf '%s' "$status" | grep -q '"mode":"SHADOW"' || fail "execution mode is not SHADOW"
printf '%s' "$status" | grep -q '"live_enabled":false' || fail "LIVE execution became enabled"

say "applying constrained public routing"
bash scripts/vm-apply-routing.sh

say "verifying host port isolation"
api_port="$(docker port aether-v3-api-1 8080/tcp 2>/dev/null || true)"
printf '%s\n' "$api_port" | grep -q '^127\.0\.0\.1:8080$' || fail "API is not bound exclusively to 127.0.0.1:8080"
postgres_port="$(docker port aether-v3-postgres-1 5432/tcp 2>/dev/null || true)"
[ -z "$postgres_port" ] || fail "PostgreSQL unexpectedly has a published host port: $postgres_port"

say "FINAL: trader evidence verification and follower SHADOW copy mandates deployed on PRIMARY_VM"
say "Marketplace publication remains explicit; copy mandates cannot authorize LIVE execution; LIVE remains disabled"
