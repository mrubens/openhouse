#!/bin/bash
# Build what a hub runs from a checkout (docs/hub.md): the pages (chat/ into bridge/public), the Connect screen's
# downloads, and the apps' dev server's packages for this machine. Used by the Docker image, the Pi install and updates.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd chat && npm ci --no-audit --no-fund --silent && npm run build --silent)
if command -v zip >/dev/null; then scripts/build-mcpb.sh >/dev/null; else echo "(no zip: the Connect screen's downloads are left out)"; fi
(cd webapp && npm ci --no-audit --no-fund --silent)
# "Hey Opie" for the hub's screens (docs/hub.md): the wake model (openWakeWord's front end and ours, about 4 MB) and
# onnxruntime-node to run it, in runtime/hub-voice (bridge/voice.js, VOICE_DIR). Without it, Opie is a tap.
if scripts/voice-models.sh runtime/hub-voice/models >/dev/null && (cd runtime/hub-voice && { [ -f package.json ] || echo '{}' > package.json; } && { [ -d node_modules/onnxruntime-node ] || npm install --no-audit --no-fund --silent onnxruntime-node@1.20.1; }); then echo "the wake model is in"; else echo "(no wake model: Opie is a tap on the hub's screens)"; fi
echo "built $(node -p "require('./hub/package.json').version")"
