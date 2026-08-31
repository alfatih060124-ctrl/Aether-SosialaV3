#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
SOURCE="$APP_DIR/deploy/Caddyfile"
TARGET="/etc/caddy/Caddyfile"
BACKUP="/etc/caddy/Caddyfile.aether-backup-$(date +%Y%m%d%H%M%S)"
PUBLIC_API="https://api.aether.boats"

say(){ printf '[aether-routing] %s\n' "$*"; }
fail(){ printf '[aether-routing] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -s "$SOURCE" ] || fail "$SOURCE is missing"
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
curl -fsS --max-time 12 "$PUBLIC_API/api/health" >/dev/null
curl -fsS --max-time 12 "$PUBLIC_API/api/execution/status" | grep -q '"live_enabled":false'

expect_blocked(){
  local method="$1" path="$2" code
  code="$(curl -sS --max-time 12 -o /dev/null -w '%{http_code}' -X "$method" "$PUBLIC_API$path")"
  case "$code" in
    401|403|404|405) return 0 ;;
    *) fail "$method $path unexpectedly returned HTTP $code" ;;
  esac
}

say "verifying public mutation/control paths are fenced"
expect_blocked POST /api/shadow/simulate
expect_blocked GET /api/admin/wallets
expect_blocked POST /api/executions
expect_blocked POST /api/signals/evaluate

ROLLBACK_REQUIRED=0
trap - ERR INT TERM
say "FINAL: public API is read-only; PRIMARY_VM remains the only writable runtime"
say "previous Caddyfile backup: $BACKUP"
