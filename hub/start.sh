#!/bin/bash
# Start a hub (docs/hub.md): the apps' dev server and the bridge, headless, in the foreground (Docker, systemd on
# Linux, launchd on a Mac).
# The same layout as the tablet's display folder: the bridge's code is copied into the data folder at each start (as the
# shell copies it from the app), so the household's things, the bridge's own state and the code sit side by side, and
# backups (bridge/backup-format.js INCLUDE) and restore work as they do on the tablet.
#   OPENHOUSE_DATA      the data folder (Docker: /data; Linux: /var/lib/openhouse; a Mac: ~/Library/Application Support/OpenHouse Hub)
#   OPENHOUSE_CODE_DIR  the checkout or image's code (default: this script's repo)
#   OPENHOUSE_BACKUP_DIR  where backups go (default: /backups if it exists, else <data>/backups)
#   HUB_TLS_CERT, HUB_TLS_KEY  serve the home network on https (for live voice in phone browsers)
#   PORT, VITE_PORT, SCREENS_PORT  the bridge (8787) and apps' server (5173) on loopback, the home network's (8788)
set -euo pipefail
C=${OPENHOUSE_CODE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
D=${OPENHOUSE_DATA:-/data}
mkdir -p "$D"
cd "$D"
echo "$(date '+%F %T') hub starting: code $C, data $D"

# The code, fresh each start; the bridge's own state files in bridge/ (screens.json, undo.json...) stay.
mkdir -p bridge
cp -R "$C/bridge/." bridge/
rm -rf bridge/test bridge/fixtures
cp "$C/device/vite.config.mjs" vite.config.mjs
[ -f "$C/hub/package.json" ] && node -p "require('$C/hub/package.json').version" > VERSION 2>/dev/null || true

# First run: the starting point for the household's apps, as a git repo (undo is a git revert). Its apps come from
# defaults/ as Opie's own plugins when the bridge starts (bridge/plugins.js).
if [ ! -d webapp/.git ]; then
  mkdir -p webapp
  (cd "$C/webapp" && tar --exclude=./node_modules --exclude=./dist --exclude=./.git --exclude=./MEMORY.md --exclude=./CLAUDE.md --exclude='./apps/*' -cf - .) | tar -xf - -C webapp
  (cd webapp && git init -q && echo node_modules >> .git/info/exclude && git add -A && git commit -qm "Starting point" && git tag -f last-good)
fi
ln -sfn "$C/webapp/node_modules" webapp/node_modules # built for this machine with the code, never backed up

# The bridge's secret: the shell makes one each boot on a tablet; a hub keeps one in the data folder (0600).
[ -s .bridge-token ] || (umask 077 && node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > .bridge-token)

export PORT=${PORT:-8787} VITE_PORT=${VITE_PORT:-5173}
export OPENHOUSE_HUB=1 OPENHOUSE_CODE_DIR="$C" DEFAULTS_DIR="$C/defaults" OPENHOUSE_TOKEN_FILE="$D/.bridge-token"
if [ -z "${OPENHOUSE_BACKUP_DIR:-}" ]; then if [ -d /backups ]; then export OPENHOUSE_BACKUP_DIR=/backups; else export OPENHOUSE_BACKUP_DIR="$D/backups"; fi; fi

(cd webapp && exec node node_modules/vite/bin/vite.js --config ../vite.config.mjs --host 127.0.0.1 --port $VITE_PORT --strictPort >> ../vite.log 2>&1) &
VITE=$!
# The log through tee without a pipeline, so the subshell becomes node and $! is the bridge itself (a pipeline would
# leave $! a shell, and stopping it would leave node running).
(cd bridge && exec node server.js > >(tee -a ../bridge.log) 2>&1) &
BRIDGE=$!
trap 'kill $VITE $BRIDGE 2>/dev/null; exit 0' TERM INT
# Either one stopping stops the hub: Docker's restart policy, systemd or launchd starts it again (a restore, an update,
# a crash). Polled rather than `wait -n`, which the Mac's own bash (3.2) doesn't have.
while kill -0 $VITE 2>/dev/null && kill -0 $BRIDGE 2>/dev/null; do sleep 2; done
echo "$(date '+%F %T') hub stopping"
kill $VITE $BRIDGE 2>/dev/null || true
wait || true
exit 1
