#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
SOURCE="$APP_DIR/deploy/Caddyfile"
TARGET="/etc/caddy/Caddyfile"
BACKUP="/etc/caddy/Caddyfile.aether-backup-$(date +%Y%m%d%H%M%S)"
PUBLIC_API="https://api.aether.boats"
ADMIN_ORIGIN="https://a.aether.boats"
ADMIN_HOST="a.aether.boats"

say(){ printf '[aether-routing] %s\n' "$*"; }
fail(){ printf '[aether-routing] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -s "$SOURCE" ] || fail "$SOURCE is missing"
[ -s "$APP_DIR/public/operator-autotrade.html" ] || fail "operator auto-trade page is missing"
[ -s "$APP_DIR/services/api/src/auto-trade-training.mjs" ] || fail "auto-trade training module is missing"
[ -s "$APP_DIR/services/api/src/signal-intelligence.mjs" ] || fail "signal intelligence module is missing"
[ -s "$APP_DIR/services/api/src/auto-trade-engine.mjs" ] || fail "auto-trade engine module is missing"
command -v caddy >/dev/null 2>&1 || fail "caddy is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"
systemctl is-active --quiet caddy || fail "caddy is not active"

say "validating repository routing contract"
caddy validate --config "$SOURCE" --adapter caddyfile >/dev/null

ROLLBACK_REQUIRED=0
rollback(){
  if [ "$ROLLBACK_REQUIRED" -eq 1 ] && [ -s "$BACKUP" ]; then
    say "verification failed; restoring previous Caddyfile"
    install -m 0644 "$BACKUP" "$TARGET"
    caddy validate --config "$TARGET" --adapter caddyfile >/dev/null || true
    systemctl reload caddy || true
  fi
}
trap rollback ERR INT TERM

if [ -s "$TARGET" ]; then
  cp -a "$TARGET" "$BACKUP"
else
  fail "$TARGET is missing; refusing non-transactional first install"
fi

say "installing single-primary routing contract"
install -m 0644 "$SOURCE" "$TARGET"
caddy validate --config "$TARGET" --adapter caddyfile >/dev/null
ROLLBACK_REQUIRED=1
systemctl reload caddy

say "verifying local primary runtime"
curl -fsS --max-time 8 http://127.0.0.1:8080/api/readiness >/dev/null

say "verifying public read path"
public_status="$(curl -fsS --max-time 12 "$PUBLIC_API/api/execution/status")"
printf '%s' "$public_status" | grep -F '"live_enabled":false' >/dev/null || fail "public execution status is not fail-closed"
curl -fsS --max-time 12 "$PUBLIC_API/api/health" >/dev/null

expect_blocked(){
  local method="$1" path="$2" code
  code="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' -X "$method" "$PUBLIC_API$path")"
  case "$code" in
    401|403|404|405) return 0 ;;
    *) fail "$method $path unexpectedly returned HTTP $code" ;;
  esac
}

say "verifying wallet-auth lane is reachable but validation remains fail-closed"
auth_code="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' "$PUBLIC_API/api/auth/challenge")"
[ "$auth_code" = "400" ] || fail "wallet auth challenge lane expected HTTP 400 for invalid input, got $auth_code"
session_code="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' "$PUBLIC_API/api/auth/session")"
[ "$session_code" = "401" ] || fail "wallet auth session without bearer expected HTTP 401, got $session_code"

say "verifying session-bound trader and copy mandate lanes"
for spec in \
  "GET /api/account/trader" \
  "POST /api/account/trader/challenge" \
  "POST /api/account/trader/apply" \
  "GET /api/account/copy-mandates" \
  "POST /api/account/copy-mandates" \
  "PATCH /api/account/copy-mandates/00000000-0000-0000-0000-000000000000"; do
  method="${spec%% *}"; path="${spec#* }"
  code="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data '{}' "$PUBLIC_API$path")"
  [ "$code" = "401" ] || fail "$method $path without session expected HTTP 401, got $code"
done

say "verifying execution/control mutation paths remain fenced"
expect_blocked POST /api/shadow/simulate
expect_blocked GET /api/admin/wallets
expect_blocked POST /api/executions
expect_blocked POST /api/signals/evaluate

admin_local(){
  curl -fsS --max-time 12 --resolve "$ADMIN_HOST:443:127.0.0.1" "$ADMIN_ORIGIN$1"
}

require_admin_text(){
  local path="$1" needle="$2" label="$3" body
  say "checking $label"
  body="$(admin_local "$path")" || fail "$label is not reachable through local Caddy"
  printf '%s' "$body" | grep -F "$needle" >/dev/null || fail "$label content mismatch"
}

say "verifying PRIMARY_VM operator auto-trade training surface locally"
require_admin_text /operator-autotrade 'AUTO TRADE OPERATOR SIMULATOR' 'operator page'
require_admin_text /operator-modules/auto-trade-training.mjs 'runAutoTradeTraining' 'training module'
require_admin_text /operator-modules/signal-intelligence.mjs 'HARD_MIN_EXPECTED_NET_EDGE_BPS = 20' 'signal edge floor module'
require_admin_text /operator-modules/auto-trade-engine.mjs 'live_execution_authorized: false' 'auto-trade fail-closed module'

say "checking external Admin reachability (non-fatal)"
external_code="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' "$ADMIN_ORIGIN/operator-autotrade" || true)"
case "$external_code" in
  200) say "external operator page reachable" ;;
  *) say "external operator page not yet reachable (HTTP ${external_code:-000}); local Caddy verification passed" ;;
esac

ROLLBACK_REQUIRED=0
trap - ERR INT TERM
say "FINAL: public API remains fenced; PRIMARY_VM operator SHADOW simulator is locally verified on the Admin hostname; LIVE remains disabled"
say "previous Caddyfile backup: $BACKUP"
