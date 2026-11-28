#!/bin/bash
# A new code for a settings device (docs/hub.md), when the first one was lost: run on the hub itself.
# --forget-pin also forgets the settings page's PIN (a lost PIN): whoever has the hub's console is its owner. It leaves
# forget-pin in the keeper's own folder, which the keeper needs before it forgets the PIN (the bridge's secret alone
# can't), so on Linux it runs as root there.
#   Docker:  docker exec openhouse /opt/openhouse/hub/owner-code.sh [--forget-pin]
#   Linux:   sudo -u openhouse /opt/openhouse/hub/owner-code.sh
#            sudo touch /var/lib/openhouse-keeper/forget-pin && sudo -u openhouse /opt/openhouse/hub/owner-code.sh --forget-pin
#   Mac:     ~/OpenHouse/hub/owner-code.sh [--forget-pin]
set -euo pipefail
D=${OPENHOUSE_DATA:-/data}
[ -d "$D" ] || D=/var/lib/openhouse
[ -d "$D" ] || D="$HOME/Library/Application Support/OpenHouse Hub"
K=${OPENHOUSE_KEEPER_DIR:-}
if [ -z "$K" ]; then if [ -d /keeper ]; then K=/keeper; elif [ -d "$HOME/Library/Application Support/OpenHouse Keeper" ]; then K="$HOME/Library/Application Support/OpenHouse Keeper"; else K="${D%/}-keeper"; fi; fi
T=$(cat "$D/.bridge-token")
if [ "${1:-}" = --forget-pin ]; then
  [ -f "$K/forget-pin" ] || touch "$K/forget-pin" 2>/dev/null || { echo "Run first, as root: sudo touch '$K/forget-pin'"; exit 1; }
  curl -fsS -X POST -H "x-openhouse-token: $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:${PORT:-8787}/hub/forget-pin >/dev/null && echo "The PIN is forgotten: choose a new one on the settings page."
fi
curl -fsS -X POST -H "x-openhouse-token: $T" -H 'content-type: application/json' -d '{}' http://127.0.0.1:${PORT:-8787}/hub/owner-code
echo
cat "$D/hub-setup.txt"
