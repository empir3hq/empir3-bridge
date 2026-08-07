#!/usr/bin/env bash
set -euo pipefail

PREFIX=/opt/empir3-bridge
SERVICE_USER=empir3
SERVER=https://app.empir3.com
UNIT=empir3-bridge.service
ENV_FILE=/etc/empir3-bridge.env
INSTALL_CONFIG=/etc/empir3-bridge-install.json
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fail() { echo "[empir3-bridge-install] $*" >&2; exit 1; }
log() { echo "[empir3-bridge-install] $*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || fail "--prefix needs a value"; PREFIX="$2"; shift 2 ;;
    --user) [ "$#" -ge 2 ] || fail "--user needs a value"; SERVICE_USER="$2"; shift 2 ;;
    --server) [ "$#" -ge 2 ] || fail "--server needs a value"; SERVER="$2"; shift 2 ;;
    -h|--help) echo "usage: sudo bash install.sh [--prefix /opt/empir3-bridge] [--user empir3] [--server https://app.empir3.com]"; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run as root (sudo bash install.sh)"
case "$PREFIX" in /opt/*|/usr/local/lib/*) ;; *) fail "--prefix must be an absolute directory under /opt or /usr/local/lib" ;; esac
case "$PREFIX" in *".."*|*$'\n'*|*$'\r'*) fail "unsafe --prefix" ;; esac
[[ "$PREFIX" =~ ^/(opt|usr/local/lib)/[A-Za-z0-9._/-]+$ ]] || fail "unsafe --prefix characters"
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || fail "unsafe --user"
[[ "$SERVER" =~ ^https://[A-Za-z0-9._~:/?#@!\$\&\'\(\)\*+,\;=%-]+$|^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] || fail "--server must be HTTPS (HTTP is allowed only for localhost)"
[ -f "$SCRIPT_DIR/runtime/.payload-version" ] || fail "runtime payload is missing"
[ -f "$SCRIPT_DIR/runtime/src/headless-entry.js" ] || fail "headless entrypoint is missing"
VERSION="$(tr -d '\r\n' < "$SCRIPT_DIR/runtime/.payload-version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9._-]+)?$ ]] || fail "invalid package version"

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required (found $(node --version))"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
command -v curl >/dev/null 2>&1 || fail "curl is required for the health gate"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating dedicated service account $SERVICE_USER"
  useradd --create-home --user-group --shell /bin/bash "$SERVICE_USER"
fi
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
[ -n "$SERVICE_HOME" ] && [ "$SERVICE_HOME" != / ] || fail "service account has no safe home directory"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME"

RELEASES="$PREFIX/releases"
RELEASE="$RELEASES/$VERSION"
STAGING="$RELEASES/.install-$VERSION-$$"
BACKUP="$RELEASES/.backup-$VERSION-$$"
install -d -m 0755 "$RELEASES"
rm -rf -- "$STAGING"
install -d -m 0755 "$STAGING"
cp -a "$SCRIPT_DIR/runtime/." "$STAGING/"
chown -R root:root "$STAGING"
find "$STAGING" -type d -exec chmod 0755 {} +
find "$STAGING" -type f -exec chmod 0644 {} +

PREVIOUS=""
if [ -L "$PREFIX/current" ]; then
  PREVIOUS="$(readlink -f "$PREFIX/current" || true)"
  case "$PREVIOUS" in "$RELEASES"/*) ;; *) fail "existing current link escapes $RELEASES" ;; esac
fi
# Always replace the versioned runtime from the verified package. Reusing an
# existing same-version directory makes a damaged or partially installed
# release impossible to repair. Keep the prior bytes until the health gate
# passes so a same-version repair is just as rollback-safe as an upgrade.
if [ -e "$RELEASE" ]; then mv -- "$RELEASE" "$BACKUP"; fi
mv -- "$STAGING" "$RELEASE"

cat > "$ENV_FILE" <<EOF
NODE_ENV=production
EMPIR3_SERVER=$SERVER
EMPIR3_HEADLESS=1
BRIDGE_HEADLESS=true
EMPIR3_CHROME_AUTOLAUNCH=0
HOME=$SERVICE_HOME
USER=$SERVICE_USER
EOF
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

cat > "$INSTALL_CONFIG" <<EOF
{"prefix":"$PREFIX","serviceUser":"$SERVICE_USER","server":"$SERVER"}
EOF
chown root:root "$INSTALL_CONFIG"
chmod 0600 "$INSTALL_CONFIG"

cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Empir3 Bridge (headless Linux host)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$SERVICE_HOME
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $PREFIX/current/src/headless-entry.js
Restart=always
RestartSec=3
TimeoutStopSec=15
KillMode=mixed
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=full
ReadWritePaths=$SERVICE_HOME
PrivateTmp=true
PrivateDevices=true
ProtectClock=true
ProtectControlGroups=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
TasksMax=512
MemoryMax=1536M

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/empir3-bridge-update.service <<EOF
[Unit]
Description=Empir3 Bridge signed headless update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$(command -v node) $PREFIX/current/src/headless-update.cjs run
Nice=10
EOF

cat > /etc/systemd/system/empir3-bridge-update.timer <<'EOF'
[Unit]
Description=Periodic Empir3 Bridge signed update check

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
RandomizedDelaySec=600
Persistent=true

[Install]
WantedBy=timers.target
EOF

ln -sfn "$RELEASE" "$PREFIX/current.next"
mv -Tf "$PREFIX/current.next" "$PREFIX/current"
install -m 0755 "$SCRIPT_DIR/uninstall.sh" /usr/local/sbin/empir3-bridge-uninstall

systemctl daemon-reload
BEFORE_RESTARTS="$(systemctl show -p NRestarts --value "$UNIT" 2>/dev/null || echo 0)"
systemctl reset-failed "$UNIT" 2>/dev/null || true
systemctl enable --now "$UNIT"
systemctl restart "$UNIT"

READY=
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3006/api/status >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
AFTER_RESTARTS="$(systemctl show -p NRestarts --value "$UNIT" 2>/dev/null || echo 0)"
if [ -z "$READY" ] || [ "${AFTER_RESTARTS:-0}" -gt "${BEFORE_RESTARTS:-0}" ]; then
  log "new release failed its health gate; restoring the previous release"
  systemctl stop "$UNIT" 2>/dev/null || true
  if [ -e "$BACKUP" ]; then
    rm -rf -- "$RELEASE"
    mv -- "$BACKUP" "$RELEASE"
  fi
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    ln -sfn "$PREVIOUS" "$PREFIX/current.next"
    mv -Tf "$PREFIX/current.next" "$PREFIX/current"
    systemctl reset-failed "$UNIT" 2>/dev/null || true
    systemctl restart "$UNIT" || true
  else
    systemctl disable --now "$UNIT" || true
  fi
  journalctl -u "$UNIT" --no-pager -n 50 >&2 || true
  fail "Bridge did not become healthy without restarting"
fi

rm -rf -- "$BACKUP"
systemctl enable --now empir3-bridge-update.timer
log "installed Empir3 Bridge $VERSION for $(uname -m); service is healthy (NRestarts=$AFTER_RESTARTS)"
log "pairing details: journalctl -u $UNIT -n 100 --no-pager"
