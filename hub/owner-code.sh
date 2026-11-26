#!/bin/bash
# A new code for a settings device (docs/hub.md), when the first one was lost: run on the hub itself.
# --forget-pin also forgets the settings page's PIN (a lost PIN): whoever has the hub's console is its owner.
#   Docker:  docker exec openhouse /opt/openhouse/hub/owner-code.sh
#   Linux:   sudo -u openhouse /opt/openhouse/hub/owner-code.sh
#   Mac:     ~/OpenHouse/hub/owner-code.sh
set -euo pipefail
D=${OPENHOUSE_DATA:-/data}
[ -d "$D" ] || D=/var/lib/openhouse
[ -d "$D" ] || D="$HOME/Library/Application Support/OpenHouse Hub"
T=$(cat "$D/.bridge-token")
if [ "${1:-}" = --forget-pin ]; then curl -fsS -X POST -H "x-openhouse-token: $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:${PORT:-8787}/hub/forget-pin >/dev/null && echo "The PIN is forgotten: choose a new one on the settings page."; fi
curl -fsS -X POST -H "x-openhouse-token: $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:${PORT:-8787}/hub/owner-code
echo
cat "$D/hub-setup.txt"
