#!/bin/bash
# Update a hub installed from a checkout (hub/install.sh on Linux, hub/install-mac.sh): pull, build, and let the bridge
# restart (bridge/hub.js POST /hub/update runs this, then exits; systemd or launchd starts it on the
# new code). Docker hubs pull a new image instead.
#   --back  the version before the last update, again (Go back on the settings page; hub/start.sh does it by itself
#           when the new version stops within a minute of starting). The next update moves forward from there.
set -euo pipefail
cd "$(dirname "$0")/.."
G=$(git rev-parse --git-dir)
if [ "${1:-}" = --back ]; then
  [ -s "$G/opie-previous" ] || { echo "no version to go back to"; exit 1; }
  P=$(cat "$G/opie-previous")
  echo "$(date '+%F %T') going back from $(git rev-parse --short HEAD) to ${P:0:7}"
  git reset -q --hard "$P"
  rm -f "$G/opie-previous"
  hub/build.sh
  exit 0
fi
echo "$(date '+%F %T') updating from $(git rev-parse --short HEAD)"
git rev-parse HEAD > "$G/opie-previous.new"
git pull --ff-only
if [ "$(git rev-parse HEAD)" = "$(cat "$G/opie-previous.new")" ]; then rm -f "$G/opie-previous.new"; else mv "$G/opie-previous.new" "$G/opie-previous"; date +%s > "$G/opie-updated"; fi
hub/build.sh
echo "$(date '+%F %T') now at $(git rev-parse --short HEAD)"
