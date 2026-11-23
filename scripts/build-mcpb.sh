#!/bin/bash
# The OpenHouse extension for Claude Desktop (dist/openhouse.mcpb) and the npx package's file
# (connect/dist/openhouse-mcp.mjs): connect/openhouse-mcp.mjs bundled with only what it imports (the screen client and
# cipher from chat/src, bridge/pair-code.js), one file, run by Claude Desktop's own Node. Nothing here is published.
#   scripts/build-mcpb.sh        then open dist/openhouse.mcpb (Claude Desktop installs it), or: npx ./connect
set -euo pipefail
cd "$(dirname "$0")/.."
ESBUILD=chat/node_modules/.bin/esbuild
[ -x "$ESBUILD" ] || (cd chat && npm install --silent)
VERSION=$(node -p "require('./connect/package.json').version")
OUT=dist/mcpb
rm -rf "$OUT" dist/openhouse.mcpb connect/dist
mkdir -p "$OUT/server" connect/dist
"$ESBUILD" connect/openhouse-mcp.mjs --bundle --platform=node --format=esm --target=node18 --legal-comments=none \
  --outfile="$OUT/server/index.mjs" --log-level=warning
# The same file for npx (the bundle keeps the source's shebang).
cp "$OUT/server/index.mjs" connect/dist/openhouse-mcp.mjs
chmod +x connect/dist/openhouse-mcp.mjs
node -e "const m=require('./connect/mcpb/manifest.json'); m.version='$VERSION'; require('fs').writeFileSync('$OUT/manifest.json', JSON.stringify(m, null, 2)+'\n')"
cp connect/mcpb/icon.png LICENSE "$OUT/"
(cd "$OUT" && COPYFILE_DISABLE=1 zip -qrXD ../openhouse.mcpb manifest.json icon.png LICENSE server)
# What the tablet serves from its Connect screen (bridge/connect-page.js), so the download always matches the tablet.
mkdir -p bridge/public/connect && cp dist/openhouse.mcpb connect/dist/openhouse-mcp.mjs bridge/public/connect/
echo "dist/openhouse.mcpb ($(du -h dist/openhouse.mcpb | cut -f1), version $VERSION)"
