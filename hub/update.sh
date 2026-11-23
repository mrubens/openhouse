#!/bin/bash
# Update a hub installed from a checkout (hub/install.sh on Linux, hub/install-mac.sh): pull, build, and let the bridge
# restart (bridge/hub.js POST /hub/update runs this, then exits; systemd or launchd starts it on the
# new code). Docker hubs pull a new image instead.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "$(date '+%F %T') updating from $(git rev-parse --short HEAD)"
git pull --ff-only
hub/build.sh
echo "$(date '+%F %T') now at $(git rev-parse --short HEAD)"
