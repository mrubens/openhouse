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
#   OPENHOUSE_KEEPER_DIR, KEEPER_PORT  the keeper's folder (default <data>-keeper) and loopback port (default PORT+3)
#   OPENHOUSE_KEEPER, OPENHOUSE_KEEPER_TOKEN_FILE  a keeper already running as a user of its own (hub/install.sh's
#                       openhouse-keeper service): its address and its token's file; none is started here then
#   OPENHOUSE_RUN_AS    started as root: run the bridge and the apps' server as this user, the keeper alone as root
#                       (hub/addon.sh, a Home Assistant add-on), so they can't read what the keeper holds
set -euo pipefail
C=${OPENHOUSE_CODE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
# As a Home Assistant add-on (ha-addon/): the Supervisor starts the image with its token and /data/options.json.
if [ -n "${SUPERVISOR_TOKEN:-}" ] && [ -f /data/options.json ] && [ -z "${OPENHOUSE_ADDON:-}" ]; then exec bash "$C/hub/addon.sh"; fi
# The Supervisor's token is the keeper's alone (hub/keeper.mjs): nothing else started here gets it.
SV_TOKEN=${SUPERVISOR_TOKEN:-}; unset SUPERVISOR_TOKEN HASSIO_TOKEN
AS=
if [ -n "${OPENHOUSE_RUN_AS:-}" ] && [ "$(id -u)" = 0 ]; then
  AS="setpriv --reuid=$OPENHOUSE_RUN_AS --regid=$(id -g "$OPENHOUSE_RUN_AS") --init-groups --no-new-privs --inh-caps=-all env HOME=$(getent passwd "$OPENHOUSE_RUN_AS" | cut -d: -f6) USER=$OPENHOUSE_RUN_AS"
fi
D=${OPENHOUSE_DATA:-/data}
mkdir -p "$D"
cd "$D"
echo "$(date '+%F %T') hub starting: code $C, data $D"

# The code, fresh each start; the bridge's own state files in bridge/ (screens.json, undo.json...) stay.
mkdir -p bridge
cp -R "$C/bridge/." bridge/
rm -rf bridge/test bridge/fixtures
mkdir -p chat/src && cp "$C/chat/src/screen-client.js" "$C/chat/src/seal.js" "$C/chat/src/relay-client.js" chat/src/ # (bridge/satellite.js: the screen client it loads)
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

# (the bridge's user owns its data folder; the keeper's folder stays root's, 0700)
[ -n "$AS" ] && find "$D" ! -user "$OPENHOUSE_RUN_AS" -exec chown -h "$OPENHOUSE_RUN_AS:" {} + 2>/dev/null || true

export PORT=${PORT:-8787} VITE_PORT=${VITE_PORT:-5173}
[ -d "$C/runtime/hub-voice/node_modules/onnxruntime-node" ] && export VOICE_DIR=${VOICE_DIR:-$C/runtime/hub-voice} # "Hey Opie" on the hub's screens (hub/build.sh)
export OPENHOUSE_HOST=keeper OPENHOUSE_CODE_DIR="$C" DEFAULTS_DIR="$C/defaults" OPENHOUSE_TOKEN_FILE="$D/.bridge-token"
if [ -z "${OPENHOUSE_BACKUP_DIR:-}" ]; then if [ -d /backups ]; then export OPENHOUSE_BACKUP_DIR=/backups; else export OPENHOUSE_BACKUP_DIR="$D/backups"; fi; fi

# The keeper (hub/keeper.mjs): the calendar and album links, the household's own OpenAI key and the PIN, sealed, in a
# folder of its own beside the data folder (never inside it, where the assistant's tools and backups reach), run from
# the code rather than the data folder's copy. A new token each start, for the bridge alone.
export OPENHOUSE_KEEPER_DIR=${OPENHOUSE_KEEPER_DIR:-${D%/}-keeper}
if [ -n "${OPENHOUSE_KEEPER:-}" ] && [ -n "${OPENHOUSE_KEEPER_TOKEN_FILE:-}" ]; then
  # Its own user's (a Linux hub): it reads the bridge's secret through the group, and we read its token.
  export OPENHOUSE_KEEPER_TOKEN=$(cat "$OPENHOUSE_KEEPER_TOKEN_FILE")
  chmod 640 .bridge-token
  KEEPER=
else
  KEEPER_PORT=${KEEPER_PORT:-$((PORT + 3))}
  export OPENHOUSE_KEEPER="http://127.0.0.1:$KEEPER_PORT"
  export OPENHOUSE_KEEPER_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
  (KEEPER_PORT=$KEEPER_PORT BRIDGE_URL="http://127.0.0.1:$PORT" OPENHOUSE_DATA="$D" SUPERVISOR_TOKEN=$SV_TOKEN exec node "$C/hub/keeper.mjs" >> keeper.log 2>&1) &
  KEEPER=$!
fi

(cd webapp && exec $AS node node_modules/vite/bin/vite.js --config ../vite.config.mjs --host 127.0.0.1 --port $VITE_PORT --strictPort >> ../vite.log 2>&1) &
VITE=$!
# The log through tee without a pipeline, so the subshell becomes node and $! is the bridge itself (a pipeline would
# leave $! a shell, and stopping it would leave node running).
(cd bridge && exec $AS node server.js > >(tee -a ../bridge.log) 2>&1) &
BRIDGE=$!
trap 'kill $VITE $BRIDGE $KEEPER 2>/dev/null; exit 0' TERM INT
# Either one stopping stops the hub: Docker's restart policy, systemd or launchd starts it again (a restore, an update,
# a crash). Polled rather than `wait -n`, which the Mac's own bash (3.2) doesn't have.
STARTED=$(date +%s)
( sleep 120; rm -f "$(git -C "$C" rev-parse --absolute-git-dir 2>/dev/null)/opie-updated" ) & # still running two minutes after an update: it's good
while kill -0 $VITE 2>/dev/null && kill -0 $BRIDGE 2>/dev/null && { [ -z "$KEEPER" ] || kill -0 $KEEPER 2>/dev/null; }; do sleep 2; done
echo "$(date '+%F %T') hub stopping"
kill $VITE $BRIDGE $KEEPER 2>/dev/null || true
wait $VITE $BRIDGE $KEEPER 2>/dev/null || true
# A bad update (hub/update.sh): the new version stopped within a minute of its first start after updating, so the one
# before comes back, once; the supervisor (systemd, launchd) then starts that.
G=$(git -C "$C" rev-parse --absolute-git-dir 2>/dev/null || echo "$C/.git")
if [ -f "$G/opie-updated" ] && [ -s "$G/opie-previous" ] && [ $(( $(date +%s) - STARTED )) -lt 60 ]; then
  rm -f "$G/opie-updated"
  echo "$(date '+%F %T') the new version stopped at once: going back"
  bash "$C/hub/update.sh" --back >> update.log 2>&1 || true
fi
exit 1
