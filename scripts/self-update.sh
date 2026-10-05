#!/usr/bin/env bash
# empir3-bridge self-update — keep a systemd-managed Linux bridge clone on the
# latest release tag (Fleet Phase 7.6 / FINAL_PASS N-002).
#
# Why this exists: Windows bridges follow the payload manifest and roll within
# minutes of a release; Linux clones (VPS installs, host.empir3.com) had NO
# update path and drifted until someone ran a manual `git checkout` — observed
# twice in one week. This script closes that gap for any clone that runs under
# systemd.
#
#   self-update.sh run                        one update check (the timer's job)
#   self-update.sh install [dir] [unit]       install itself + a systemd timer
#
# Contract:
#  - Moves FORWARD only, and only between `vX.Y.Z` release tags on origin —
#    never to a branch head, so a half-published tree is never adopted.
#  - git + npm run as the CLONE'S OWNER (root git on a user-owned checkout
#    trips safe.directory — the trap empir3-deploy's cmd_update documents).
#  - Rolls back to the previous ref if npm install fails or the bridge does
#    not come back healthy, so a bad update degrades to "still on the old
#    version", never to "bridge down".
#  - flock guard: overlapping timer fires are a no-op, not a race.
set -u

DIR="${EMPIR3_BRIDGE_DIR:-/opt/empir3-bridge}"
UNIT="${EMPIR3_BRIDGE_UNIT:-empir3-bridge.service}"
STATUS_URL="http://127.0.0.1:3006/api/status"
BIN=/usr/local/bin/empir3-bridge-update

log() { echo "[empir3-bridge-update] $*"; }

cmd_run() {
  exec 9>/var/lock/empir3-bridge-update.lock
  flock -n 9 || { log "another update run holds the lock — skipping"; exit 0; }
  [ -d "$DIR/.git" ] || { log "no git checkout at $DIR — nothing to update"; exit 0; }

  local owner; owner="$(stat -c %U "$DIR")"
  # Run as the clone's owner. When that IS the invoking root, skip sudo —
  # minimal images may not ship it.
  git_o() {
    if [ "$owner" = "$(id -un)" ]; then git -C "$DIR" "$@"; else sudo -u "$owner" git -C "$DIR" "$@"; fi
  }
  npm_o() {
    if [ "$owner" = "$(id -un)" ]; then bash -lc "cd '$DIR' && $*"; else sudo -u "$owner" bash -lc "cd '$DIR' && $*"; fi
  }

  # Current version: package.json is the version source of truth (a shallow
  # FETCH_HEAD checkout may have no local tags for `git describe` to find).
  local cur
  cur="v$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -1)"

  # Latest release tag on origin. `--refs` drops peeled ^{} entries; sort -V
  # picks the highest version.
  local latest
  latest="$(git_o ls-remote --tags --refs origin 'v[0-9]*' 2>/dev/null | awk -F/ '{print $NF}' | grep -E '^v[0-9]+(\.[0-9]+)*$' | sort -V | tail -1)"
  [ -n "$latest" ] || { log "could not read release tags from origin — skipping"; exit 0; }

  if [ "$cur" = "$latest" ]; then log "up to date ($cur)"; exit 0; fi
  # Forward only: if the highest remote tag is not strictly newer, stand still.
  if [ "$(printf '%s\n%s\n' "$cur" "$latest" | sort -V | tail -1)" != "$latest" ]; then
    log "remote $latest is not newer than local $cur — skipping"; exit 0
  fi

  log "updating $cur -> $latest"
  local prev; prev="$(git_o rev-parse HEAD)"
  git_o fetch --depth 1 origin "refs/tags/$latest:refs/tags/$latest" || { log "fetch failed"; exit 1; }
  git_o checkout -f "$latest" || { log "checkout failed"; exit 1; }

  if ! npm_o "npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1"; then
    log "dependency install failed — rolling back to $prev"
    git_o checkout -f "$prev"
    npm_o "npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1" || true
    systemctl restart "$UNIT"
    exit 1
  fi

  systemctl restart "$UNIT"

  # Health gate: the wrapper must answer again, or this was not an update —
  # it was an outage we caused. Roll back.
  local i
  for i in $(seq 1 60); do
    if curl -fsS --max-time 2 "$STATUS_URL" >/dev/null 2>&1; then
      log "updated to $latest — bridge healthy"
      exit 0
    fi
    sleep 1
  done
  log "bridge not healthy 60s after updating to $latest — rolling back to $prev"
  git_o checkout -f "$prev"
  npm_o "npm ci >/dev/null 2>&1 || npm install >/dev/null 2>&1" || true
  systemctl restart "$UNIT"
  exit 1
}

cmd_install() {
  local dir="${1:-$DIR}" unit="${2:-$UNIT}"
  [ "$(id -u)" = "0" ] || { log "install must run as root (writes systemd units)"; exit 1; }
  [ -d "$dir/.git" ] || { log "install: $dir is not a git checkout"; exit 1; }

  cp "$(readlink -f "$0")" "$BIN"
  chmod 755 "$BIN"

  cat > /etc/systemd/system/empir3-bridge-update.service <<UNITEOF
[Unit]
Description=Empir3 bridge self-update (checks release tags, forward-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=EMPIR3_BRIDGE_DIR=${dir}
Environment=EMPIR3_BRIDGE_UNIT=${unit}
ExecStart=${BIN} run
Nice=10
UNITEOF

  # 30-min cadence keeps Linux boxes within one release window of the
  # Windows manifest rollers; RandomizedDelaySec staggers a fleet so a
  # release does not restart every machine in the same minute.
  cat > /etc/systemd/system/empir3-bridge-update.timer <<'UNITEOF'
[Unit]
Description=Periodic Empir3 bridge self-update check

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
RandomizedDelaySec=600
Persistent=true

[Install]
WantedBy=timers.target
UNITEOF

  systemctl daemon-reload
  systemctl enable --now empir3-bridge-update.timer
  log "installed: $BIN + empir3-bridge-update.timer (dir=$dir, unit=$unit, every 30min ±10min)"
}

case "${1:-run}" in
  run)     cmd_run ;;
  install) shift; cmd_install "$@" ;;
  *) echo "usage: self-update.sh [run | install [dir] [unit]]" >&2; exit 2 ;;
esac
