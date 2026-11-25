#!/bin/bash
# Bundle what the shell copies into files/display/: the bridge (with the home screen page and
# the apps' kit), the dev server's config, the start script, the starting dashboard and the starting apps.
set -e
cd "$(dirname "$0")/.."
. scripts/env.sh
A=shell/app/src/main/assets/runtime
rm -rf "$A"; mkdir -p "$A/bridge/agents" "$A/bridge/public" "$A/bridge/kit/fonts"
(cd chat && npm run build --silent) # the generated-UI catalog prompt (chat-prompt.md), and the conversation page
cp bridge/*.js bridge/*.md bridge/package.json "$A/bridge/" # every guide and prompt the bridge reads (AGENT, CHAT, CURATE, DESIGN, NOTES, PLUGINS, WORKSHOP; chat-prompt.md is built just above)
scripts/build-mcpb.sh >/dev/null # the OpenHouse extension and script the Connect screen serves (connect-page.js)
cp -R bridge/public/chat bridge/public/app bridge/public/screen bridge/public/phone bridge/public/connect "$A/bridge/public/"
cp bridge/agents/*.js "$A/bridge/agents/" # the cloud's text model (cloud.js), none.js, and the stand-ins
mkdir -p "$A/bridge/house" && cp bridge/house/*.js "$A/bridge/house/" # the household's parts (house.js)
mkdir -p "$A/bridge/devices/drivers" && cp bridge/devices/*.js bridge/devices/oui.txt.gz "$A/bridge/devices/" && cp bridge/devices/drivers/*.js "$A/bridge/devices/drivers/"
cp device/runtime-start.sh "$A/start.sh"
cp bridge/kit/*.js bridge/kit/*.css "$A/bridge/kit/" && cp shell/app/src/main/assets/fonts/* "$A/bridge/kit/fonts/" # the apps' kit and the display's fonts
cp device/vite.config.mjs "$A/vite.config.mjs" # the dev server: the apps, and /bridge, /kit passed on to the bridge
# The starting apps (Calendar, Chores, Lists, Meals, Photos): regular web apps the family can change or delete,
# seeded once per device (start.sh). Their data lives in the bridge (house.js), not in them.
cp -R defaults/apps "$A/defaults"
cp -R defaults/ports "$A/ports" # apps from before apps were web pages, rewritten (defaults/ports/README.md)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$A/webapp.tgz" -C webapp --exclude node_modules --exclude dist --exclude .git --exclude MEMORY.md --exclude CLAUDE.md --exclude 'apps/*' .
du -sh "$A"
# Every file the bridge imports must be in the bundle (a folder left out here once kept the bridge from starting).
node -e '
const fs = require("fs"), path = require("path"); let bad = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []);
for (const f of walk(process.argv[1])) for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:^|[;\s])(?:import|export)\s[^;]*?from\s+["\x27](\.{1,2}\/[^"\x27]+)["\x27]|import\(\s*["\x27](\.{1,2}\/[^"\x27]+)["\x27]\s*\)/gm)) {
  const t = path.resolve(path.dirname(f), m[1] || m[2]); if (!fs.existsSync(t)) bad.push(`${path.relative(process.argv[1], f)} -> ${m[1] || m[2]}`);
}
if (bad.length) { console.error("missing from the bundle:\n  " + bad.join("\n  ")); process.exit(1); }
' "$A/bridge"
