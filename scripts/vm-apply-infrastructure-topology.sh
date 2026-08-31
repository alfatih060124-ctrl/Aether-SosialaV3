#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
cd "$APP_DIR"

say(){ printf '[aether-topology] %s\n' "$*"; }
fail(){ printf '[aether-topology] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -s .env ] || fail ".env is missing"
command -v git >/dev/null 2>&1 || fail "git is not installed"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"

# Never allow this convergence script to alter the LIVE posture.
grep -Eq '^EXECUTION_MODE=SHADOW$' .env || fail "EXECUTION_MODE must remain SHADOW"
grep -Eq '^LIVE_ENABLED=false$' .env || fail "LIVE_ENABLED must remain false"
grep -Eq '^FIXTURE_GATE_PASSED=false$' .env || fail "FIXTURE_GATE_PASSED must remain false"
grep -Eq '^OPERATOR_APPROVED=false$' .env || fail "OPERATOR_APPROVED must remain false"
grep -Eq '^POSTGRES_PASSWORD=.+$' .env || fail "POSTGRES_PASSWORD is required"
grep -Eq '^API_TOKEN=.+$' .env || fail "API_TOKEN is required"
grep -Eq '^ADMIN_API_TOKEN=.+$' .env || fail "ADMIN_API_TOKEN is required"

say "fetching canonical infrastructure contract"
git fetch origin main
git checkout origin/main -- docker-compose.yml deploy/Caddyfile scripts/vm-apply-routing.sh

say "validating compose before changing containers"
docker compose --env-file .env config -q

grep -q '127.0.0.1:8080:8080' docker-compose.yml || fail "API must bind to localhost only"
if grep -Eq '(^|["[:space:]-])5432:5432(["[:space:]]|$)|0\.0\.0\.0:5432' docker-compose.yml; then
  fail "PostgreSQL host publishing is forbidden"
fi
grep -q 'AETHER_DEPLOYMENT_ROLE: PRIMARY_VM' docker-compose.yml || fail "PRIMARY_VM role missing"
grep -q 'EXECUTION_MODE: SHADOW' docker-compose.yml || fail "compose is not SHADOW-locked"
grep -q 'LIVE_ENABLED: "false"' docker-compose.yml || fail "compose LIVE gate is not locked"

say "converging API container configuration without rebuilding application code"
docker compose --env-file .env up -d --no-build api

say "waiting for primary API readiness"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/api/readiness >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail "primary API readiness timeout"

api_port="$(docker port aether-v3-api-1 8080/tcp 2>/dev/null || true)"
printf '%s\n' "$api_port" | grep -q '^127\.0\.0\.1:8080$' || fail "API is not bound exclusively to 127.0.0.1:8080"
postgres_port="$(docker port aether-v3-postgres-1 5432/tcp 2>/dev/null || true)"
[ -z "$postgres_port" ] || fail "PostgreSQL unexpectedly has a published host port: $postgres_port"

say "applying transactional Caddy traffic fencing"
bash scripts/vm-apply-routing.sh

say "verifying SHADOW posture after convergence"
status="$(curl -fsS --max-time 10 https://api.aether.boats/api/execution/status)"
printf '%s' "$status" | grep -q '"mode":"SHADOW"' || fail "execution mode changed unexpectedly"
printf '%s' "$status" | grep -q '"live_enabled":false' || fail "LIVE became enabled unexpectedly"

say "FINAL: VM converged to PRIMARY_VM single-writer topology"
say "LIVE remains disabled; PostgreSQL is not published; public API is read-only"
