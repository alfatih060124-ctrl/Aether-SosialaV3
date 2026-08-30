#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aether-v3}"
ENV_FILE="$APP_DIR/.env"
BACKUP_DIR="$APP_DIR/backups"
HEALTH_SCRIPT="/usr/local/sbin/aether-health-check"
BACKUP_SCRIPT="/usr/local/sbin/aether-db-backup"
PUBLIC_API="https://api.aether.boats"
SSH_PORT="22022"

say() { printf '[aether] %s\n' "$*"; }
fail() { printf '[aether] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -d "$APP_DIR" ] || fail "$APP_DIR not found"
[ -s "$ENV_FILE" ] || fail "$ENV_FILE missing or empty"

MODE="$(sed -n 's/^EXECUTION_MODE=//p' "$ENV_FILE" | tail -1)"
LIVE="$(sed -n 's/^LIVE_ENABLED=//p' "$ENV_FILE" | tail -1)"
[ "$MODE" = "SHADOW" ] || fail "EXECUTION_MODE must remain SHADOW (found: ${MODE:-unset})"
[ "$LIVE" = "false" ] || fail "LIVE_ENABLED must remain false (found: ${LIVE:-unset})"
grep -q '^POSTGRES_PASSWORD=.' "$ENV_FILE" || fail "POSTGRES_PASSWORD missing"
grep -q '^API_TOKEN=.' "$ENV_FILE" || fail "API_TOKEN missing"
grep -q '^ADMIN_API_TOKEN=.' "$ENV_FILE" || fail "ADMIN_API_TOKEN missing"
chmod 600 "$ENV_FILE"

for cmd in docker curl ufw caddy cron; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is not installed"
done

if ! command -v fail2ban-client >/dev/null 2>&1; then
  say "installing fail2ban"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
fi

say "configuring fail2ban for SSH $SSH_PORT"
install -d -m 0755 /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/aether-sshd.local <<EOF
[sshd]
enabled = true
port = $SSH_PORT
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
fail2ban-client -t >/dev/null
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
READY=0
for i in $(seq 1 20); do
  if fail2ban-client ping >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
[ "$READY" -eq 1 ] || { systemctl --no-pager --full status fail2ban || true; fail "fail2ban socket did not become ready"; }
fail2ban-client status sshd >/dev/null || fail "fail2ban sshd jail is not active"

say "ensuring firewall rules"
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw status | grep -q '^Status: active' || ufw --force enable >/dev/null

say "ensuring container restart policy"
docker update --restart unless-stopped aether-v3-api-1 aether-v3-postgres-1 >/dev/null

say "installing health check"
cat > "$HEALTH_SCRIPT" <<'EOF'
#!/bin/sh
TS=$(date -Is)
OK=1
docker exec aether-v3-postgres-1 pg_isready -U aether -d aether >/dev/null 2>&1 || { echo "$TS POSTGRES_FAIL"; OK=0; }
curl -fsS http://127.0.0.1:8080/api/readiness >/dev/null 2>&1 || { echo "$TS API_LOCAL_FAIL"; OK=0; }
curl -fsS https://api.aether.boats/api/readiness >/dev/null 2>&1 || { echo "$TS HTTPS_FAIL"; OK=0; }
[ "$OK" -eq 1 ] && echo "$TS OK"
[ "$OK" -eq 1 ]
EOF
chmod 700 "$HEALTH_SCRIPT"

say "installing verified database backup"
install -d -m 0700 "$BACKUP_DIR"
cat > "$BACKUP_SCRIPT" <<'EOF'
#!/bin/sh
set -eu
D=/opt/aether-v3/backups
F=$D/aether_$(date +%F_%H%M%S).dump
T=$F.tmp
trap 'rm -f "$T"' EXIT INT TERM
docker exec aether-v3-postgres-1 pg_dump -U aether -d aether -Fc > "$T"
docker exec -i aether-v3-postgres-1 pg_restore -l < "$T" >/dev/null
mv "$T" "$F"
chmod 600 "$F"
find "$D" -type f -name 'aether_*.dump' -mtime +7 -delete
trap - EXIT INT TERM
EOF
chmod 700 "$BACKUP_SCRIPT"

cat > /etc/cron.d/aether-health <<EOF
*/5 * * * * root $HEALTH_SCRIPT >> /var/log/aether-health.log 2>&1
EOF
chmod 644 /etc/cron.d/aether-health

cat > /etc/cron.d/aether-db-backup <<EOF
15 2 * * * root $BACKUP_SCRIPT >> /var/log/aether-db-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/aether-db-backup
systemctl enable --now cron >/dev/null

cat > /etc/logrotate.d/aether <<'EOF'
/var/log/aether-health.log /var/log/aether-db-backup.log {
  su root root
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  create 600 root root
}
EOF
logrotate -d /etc/logrotate.d/aether >/dev/null 2>&1

say "running health verification"
"$HEALTH_SCRIPT"

say "running backup verification"
"$BACKUP_SCRIPT"
LATEST="$(ls -1t "$BACKUP_DIR"/aether_*.dump 2>/dev/null | head -1)"
[ -n "$LATEST" ] || fail "backup was not created"
docker exec -i aether-v3-postgres-1 pg_restore -l < "$LATEST" >/dev/null

say "checking services"
systemctl is-active --quiet docker || fail "docker is not active"
systemctl is-active --quiet caddy || fail "caddy is not active"
systemctl is-active --quiet fail2ban || fail "fail2ban is not active"
systemctl is-active --quiet cron || fail "cron is not active"

docker inspect -f '{{.State.Running}}' aether-v3-api-1 | grep -qx true || fail "API container is not running"
docker inspect -f '{{.State.Running}}' aether-v3-postgres-1 | grep -qx true || fail "Postgres container is not running"

say "checking SHADOW public endpoints"
curl -fsS "$PUBLIC_API/api/readiness" | grep -q '"status":"ready"' || fail "public readiness failed"
STATUS="$(curl -fsS "$PUBLIC_API/api/execution/status")"
printf '%s' "$STATUS" | grep -q '"mode":"SHADOW"' || fail "public execution mode is not SHADOW"
printf '%s' "$STATUS" | grep -q '"live_enabled":false' || fail "public LIVE flag is not false"

say "checking internal port exposure"
if ss -lnt | grep -qE '(^|[[:space:]])0\.0\.0\.0:8080[[:space:]]'; then
  say "WARNING: 8080 is listening publicly; bind it to 127.0.0.1 in docker-compose.yml"
else
  say "8080 is not publicly bound"
fi
if ss -lnt | grep -qE '(^|[[:space:]])0\.0\.0\.0:5432[[:space:]]'; then
  say "WARNING: 5432 is listening publicly; bind it to 127.0.0.1 or remove the host port"
else
  say "5432 is not publicly bound"
fi

if [ -s /root/.ssh/authorized_keys ]; then
  say "SSH key present; password-login hardening can be done after a separate key-login test"
else
  say "SSH key is NOT installed; password/root login was intentionally left unchanged"
fi

say "FINAL: SHADOW VM baseline verified"
say "LIVE_ENABLED remains false; no live execution was enabled"
