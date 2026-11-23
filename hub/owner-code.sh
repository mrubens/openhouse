#!/bin/bash
# A new code for a settings device (docs/hub.md), when the first one was lost: run on the hub itself.
#   Docker:  docker exec openhouse /opt/openhouse/hub/owner-code.sh
#   Linux:   sudo -u openhouse /opt/openhouse/hub/owner-code.sh
#   Mac:     ~/OpenHouse/hub/owner-code.sh
set -euo pipefail
D=${OPENHOUSE_DATA:-/data}
[ -d "$D" ] || D=/var/lib/openhouse
[ -d "$D" ] || D="$HOME/Library/Application Support/OpenHouse Hub"
curl -fsS -X POST -H "x-openhouse-token: $(cat "$D/.bridge-token")" -H 'content-type: application/json' -d '{}' http://127.0.0.1:${PORT:-8787}/hub/owner-code
echo
cat "$D/hub-setup.txt"
