#!/bin/bash
# Run a command in the cloud service's checkout (its own private repo, mrubens/openhouse-cloud; its README has the
# commands), with OPENHOUSE set to this checkout so it rebuilds its copies of our pages from here:
#
#   AWS_PROFILE=openhouse-admin scripts/cloud.sh scripts/deploy.sh --diff
#   AWS_PROFILE=openhouse-admin scripts/cloud.sh node scripts/release.ts "$PWD/dist/1.2.0/display.apk" --rescue … --channel stable
#   scripts/cloud.sh node scripts/phone-app.ts       (after changing chat/src/phone.jsx; then commit it there and deploy)
#   scripts/cloud.sh npm test
#
# The command runs in the cloud checkout, so give files from here as absolute paths. Where the checkout is:
# OPENHOUSE_CLOUD, else an openhouse-cloud folder next to this repo, else ~/Code/openhouse-cloud.
set -eo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLOUD=${OPENHOUSE_CLOUD:-}
if [ -z "$CLOUD" ]; then
  for d in "$ROOT/../openhouse-cloud" "$HOME/Code/openhouse-cloud"; do [ -f "$d/lambda/local.ts" ] && { CLOUD=$d; break; }; done
fi
[ -n "$CLOUD" ] && [ -f "$CLOUD/lambda/local.ts" ] || {
  echo "No cloud checkout. Clone it: git clone https://github.com/mrubens/openhouse-cloud ~/Code/openhouse-cloud && (cd ~/Code/openhouse-cloud && npm ci)" >&2
  exit 1
}
[ $# -gt 0 ] || { sed -n '2,11p' "$0"; exit 1; }
cd "$CLOUD"
OPENHOUSE=$ROOT exec "$@"
