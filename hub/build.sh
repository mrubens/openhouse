#!/bin/bash
# Build what a hub runs from a checkout (docs/hub.md): the pages (chat/ into bridge/public), the Connect screen's
# downloads, and the apps' dev server's packages for this machine. Used by the Docker image, the Pi install and updates.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd chat && npm ci --no-audit --no-fund --silent && npm run build --silent)
if command -v zip >/dev/null; then scripts/build-mcpb.sh >/dev/null; else echo "(no zip: the Connect screen's downloads are left out)"; fi
(cd webapp && npm ci --no-audit --no-fund --silent)
echo "built $(node -p "require('./hub/package.json').version")"
