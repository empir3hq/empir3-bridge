#!/usr/bin/env bash
set -euo pipefail

PREFIX=/opt/empir3-bridge
SERVICE_USER=empir3
SERVER=https://app.empir3.com
# Pre-authorized pairing code (install-link flow). EMPIR3_PAIR_CODE lets
# cloud-init / provisioning hand it over without editing the command line.
PAIR_CODE="${EMPIR3_PAIR_CODE:-}"
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
    --pair) [ "$#" -ge 2 ] || fail "--pair needs a value"; PAIR_CODE="$2"; shift 2 ;;
    -h|--help) echo "usage: sudo bash install.sh [--prefix /opt/empir3-bridge] [--user empir3] [--server https://app.empir3.com] [--pair <code>]"; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run as root (sudo bash install.sh)"
case "$PREFIX" in /opt/*|/usr/local/lib/*) ;; *) fail "--prefix must be an absolute directory under /opt or /usr/local/lib" ;; esac
case "$PREFIX" in *".."*|*$'\n'*|*$'\r'*) fail "unsafe --prefix" ;; esac
[[ "$PREFIX" =~ ^/(opt|usr/local/lib)/[A-Za-z0-9._/-]+$ ]] || fail "unsafe --prefix characters"
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || fail "unsafe --user"
[[ "$SERVER" =~ ^https://[A-Za-z0-9._~:/?#@!\$\&\'\(\)\*+,\;=%-]+$|^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] || fail "--server must be HTTPS (HTTP is allowed only for localhost)"
if [ -n "$PAIR_CODE" ]; then
  [[ "$PAIR_CODE" =~ ^[A-Za-z0-9._-]{6,128}$ ]] || fail "--pair code is malformed"
fi
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
# PrivateTmp gives the service its own /tmp, which also hides /tmp/.X11-unix —
# where X servers publish their sockets. Without this the bridge cannot see a
# display even when Xvfb is running, so desktop tools report "no display" on a
# box that plainly has one. Expose just that directory, read-only, rather than
# weakening PrivateTmp; X access control still applies on top. Harmless when no
# X server is installed: systemd skips a BindReadOnlyPaths source that is
# missing when it is prefixed with '-'.
BindReadOnlyPaths=-/tmp/.X11-unix
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

# Unattended pairing: redeem the pre-authorized code as the service user BEFORE
# the first service start, so bridge-auth.json lands in the service home with
# the right ownership and mode and the daemon boots already paired. The claim
# is bounded and best-effort — a failed or expired code degrades to the normal
# interactive pairing path and never blocks the install.
if [ -n "$PAIR_CODE" ]; then
  log "redeeming pre-authorized pairing code as $SERVICE_USER"
  if runuser -u "$SERVICE_USER" -- \
      env HOME="$SERVICE_HOME" USER="$SERVICE_USER" EMPIR3_SERVER="$SERVER" \
      "$(command -v node)" "$PREFIX/current/src/headless-entry.js" --pair "$PAIR_CODE" --pair-only; then
    log "pairing succeeded; the service will start already paired"
  else
    log "WARNING: pairing did not complete; the service will fall back to interactive pairing (see journalctl -u $UNIT)"
  fi
fi

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
