#!/usr/bin/env bash
set -euo pipefail

PREFIX=/opt/empir3-bridge
SERVICE_USER=empir3
PURGE_DATA=0
UNIT=empir3-bridge.service

fail() { echo "[empir3-bridge-uninstall] $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || fail "--prefix needs a value"; PREFIX="$2"; shift 2 ;;
    --user) [ "$#" -ge 2 ] || fail "--user needs a value"; SERVICE_USER="$2"; shift 2 ;;
    --purge-data) PURGE_DATA=1; shift ;;
    -h|--help) echo "usage: sudo empir3-bridge-uninstall [--purge-data] [--prefix PATH] [--user NAME]"; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run as root"
case "$PREFIX" in /opt/*|/usr/local/lib/*) ;; *) fail "unsafe --prefix" ;; esac
case "$PREFIX" in *".."*|*$'\n'*|*$'\r'*) fail "unsafe --prefix" ;; esac
[[ "$PREFIX" =~ ^/(opt|usr/local/lib)/[A-Za-z0-9._/-]+$ ]] || fail "unsafe --prefix characters"
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || fail "unsafe --user"

systemctl disable --now empir3-bridge-update.timer empir3-bridge-update.path 2>/dev/null || true
systemctl disable --now "$UNIT" 2>/dev/null || true
rm -f -- "/etc/systemd/system/$UNIT" /etc/systemd/system/empir3-bridge-update.service /etc/systemd/system/empir3-bridge-update.timer /etc/systemd/system/empir3-bridge-update.path /etc/empir3-bridge.env /etc/empir3-bridge-install.json
systemctl daemon-reload
rm -rf -- "$PREFIX"
rm -rf -- /var/cache/empir3-bridge
rm -f -- /usr/local/sbin/empir3-bridge-uninstall

if [ "$PURGE_DATA" = 1 ]; then
  rm -rf -- /var/lib/empir3-bridge
  if id "$SERVICE_USER" >/dev/null 2>&1; then userdel --remove "$SERVICE_USER"; fi
  echo "[empir3-bridge-uninstall] program and retained provider data removed"
else
  echo "[empir3-bridge-uninstall] program removed; $SERVICE_USER home/provider data retained"
fi
