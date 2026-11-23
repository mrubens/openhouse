#!/bin/bash
# Copy a tablet's family folder to this computer, before an install or anything else that could go wrong:
#   scripts/tablet-backup.sh -s SERIAL [--name before-1.0.4]
# Saves ~/Documents/openhouse-backups/tablet-<date>[-name].tgz and prints its path. From the bridge's
# GET /backup/export (needs a display with it: 1.0.4 or later, or any debug build from main), else, on a debug build,
# straight from the app's folder with run-as. A release display older than 1.0.4 has neither: it says so and stops.
set -euo pipefail
cd "$(dirname "$0")/.."
SERIAL=${ANDROID_SERIAL:-} NAME=
while [ $# -gt 0 ]; do case "$1" in -s) SERIAL=$2; shift 2 ;; --name) NAME=-$2; shift 2 ;; *) echo "unknown: $1" >&2; exit 2 ;; esac; done
[ -n "$SERIAL" ] || { echo "Name the tablet: -s SERIAL (adb devices)" >&2; exit 2; }
export ANDROID_SERIAL=$SERIAL
. scripts/env.sh
mkdir -p ~/Documents/openhouse-backups
B=~/Documents/openhouse-backups/tablet-$(date +%Y%m%d-%H%M)$NAME.tgz
PORT=$(( 20000 + RANDOM % 20000 ))
adb forward tcp:$PORT tcp:8787 >/dev/null
trap 'adb forward --remove tcp:$PORT >/dev/null 2>&1 || true' EXIT
T=$(scripts/bridge-token.sh 2>/dev/null || true)
code=000
[ -n "$T" ] && code=$(curl -s -o "$B" -w '%{http_code}' -H "X-Openhouse-Token: $T" "http://127.0.0.1:$PORT/backup/export" || true)
if [ "$code" != 200 ]; then
  rm -f "$B"
  if adb shell run-as "$DISPLAY_PKG" true >/dev/null 2>&1; then
    adb exec-out "run-as $DISPLAY_PKG tar czf - -C files/display --exclude=./voice --exclude=./bridge --exclude=./defaults --exclude=./ports --exclude=./build --exclude=./buildserver --exclude=./webapp.tgz --exclude=./webapp/node_modules --exclude=./agent --exclude=./.backup/tmp ." > "$B"
  else
    echo "No way to copy this tablet's folder: its display has no /backup/export (HTTP $code) and isn't a debug build." >&2; exit 1
  fi
fi
# A whole archive with the family's settings in it, or it isn't a backup.
tar -tzf "$B" | grep -qx './household.json' || { echo "The copy at $B is incomplete." >&2; exit 1; }
echo "$B ($(du -h "$B" | cut -f1 | tr -d ' '))"
