#!/bin/sh
set -eu

REPO=/opt/aether-v3
cd "$REPO"

say(){ printf '[aether-signal] %s\n' "$*"; }
fail(){ printf '[aether-signal] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail 'run as root'
[ -f .env ] || fail '.env not found'

grep -Eq '^EXECUTION_MODE=SHADOW$' .env || fail 'EXECUTION_MODE must remain SHADOW'
grep -Eq '^LIVE_ENABLED=false$' .env || fail 'LIVE_ENABLED must remain false'

say 'fetching approved SHADOW Signal Intelligence files'
git fetch origin main

git checkout origin/main -- \
  services/api/src/signal-intelligence.mjs \
  services/api/src/auto-trade-engine.mjs \
  services/api/src/repositories/signal-intelligence.mjs \
  services/api/src/server.mjs \
  migrations/010_signal_intelligence_autotrade.sql \
  docs/SIGNAL_INTELLIGENCE_AUTOTRADE.md

say 'building and restarting API only; hardened compose is preserved'
docker compose --env-file .env config -q
docker compose --env-file .env up -d --build api

say 'waiting for API readiness'
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://127.0.0.1:8080/api/readiness >/tmp/aether-signal-readiness.json 2>/dev/null; then break; fi
  i=$((i+1)); sleep 2
done
[ "$i" -lt 30 ] || fail 'API readiness timeout'

say 'verifying database migration'
docker exec aether-v3-postgres-1 psql -U aether -d aether -Atqc "SELECT to_regclass('public.signal_assessments'),to_regclass('public.algorithmic_strategies'),to_regclass('public.auto_trade_decisions');" | grep -q 'signal_assessments' || fail 'signal tables missing'

say 'verifying public safety posture'
curl -fsS https://api.aether.boats/api/signals/config >/tmp/aether-signal-config.json
curl -fsS https://api.aether.boats/api/autotrade/status >/tmp/aether-autotrade-status.json
curl -fsS https://api.aether.boats/api/execution/status >/tmp/aether-execution-status.json

grep -q '"quality_first":true' /tmp/aether-signal-config.json || fail 'quality-first flag missing'
grep -q '"mode":"SHADOW"' /tmp/aether-autotrade-status.json || fail 'Auto Trade is not SHADOW'
grep -q '"live_execution_authorized":false' /tmp/aether-autotrade-status.json || fail 'Auto Trade live authorization is not false'
grep -q '"live_enabled":false' /tmp/aether-execution-status.json || fail 'LIVE execution must remain disabled'

rm -f /tmp/aether-signal-readiness.json /tmp/aether-signal-config.json /tmp/aether-autotrade-status.json /tmp/aether-execution-status.json

say 'FINAL: Signal Intelligence + Auto Trade decision engine deployed in SHADOW mode'
say 'quality-over-quantity gates active; LIVE execution remains disabled'
