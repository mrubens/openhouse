#!/bin/bash
# The Luna/Terra build eval (docs/luna-build-eval.md): a dev bridge on a copy of this checkout in a scratch folder
# (its state files go next to its own code, and APP_DIR is a git repo of its own), the sample household, then
# luna-build.mjs. Never touches a tablet or the cloud service; the OpenAI key comes from Parameter Store into this
# process's environment only.
#   scripts/eval/run.sh <scratch dir> [env for luna-build.mjs, e.g. ONLY=maze MODELS=gpt-6-luna VARIANT=engine]
#   SCRIPT=rails-e2e.mjs scripts/eval/run.sh <scratch dir> [MODEL=...]   the tablet's own builder, end to end
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
S="${1:?scratch folder}"; shift
PORT="${PORT:-5741}"
mkdir -p "$S"
if [ ! -d "$S/oh" ]; then
  rsync -a --exclude .git --exclude shell --exclude ios --exclude spikes --exclude docs --exclude models --exclude runtime --exclude brand "$REPO/" "$S/oh/"
  mkdir -p "$S/oh/shell/app/src/main" && rsync -a "$REPO/shell/app/src/main/assets" "$S/oh/shell/app/src/main/" # the kit's fonts
  # The sample household (CLAUDE.md): Sam, Alex, Maya and Leo in Springfield.
  echo '{"family":[{"name":"Sam"},{"name":"Alex"},{"name":"Maya"},{"name":"Leo"}],"town":"Springfield","chores":[{"who":"Maya","task":"Feed the cat","days":[],"stars":1},{"who":"Leo","task":"Set the table","days":[],"stars":1},{"who":"Maya","task":"Make bed","days":[],"stars":1}],"calendars":[]}' > "$S/oh/household.json"
  mkdir -p "$S/app" "$S/chats" "$S/display"
  git -C "$S/app" init -q && git -C "$S/app" -c user.name=eval -c user.email=eval@local commit -q --allow-empty -m start
fi
[ -f "$S/pw/node_modules/playwright-core/index.mjs" ] || (mkdir -p "$S/pw" && cd "$S/pw" && npm init -y >/dev/null && npm i -s playwright-core@1.49.1 phaser@4.2.1 three@0.187.0 @dimforge/rapier2d-compat@0.21.0 @dimforge/rapier3d-compat@0.21.0) # the tablet's installed libraries (webapp/package.json)
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/house"; then
  (cd "$S/oh/bridge" && BRIDGE_DEV=1 PORT=$PORT APP_DIR="$S/app" CHAT_DIR="$S/chats" CLOUD_DISPLAY="$S/display" DEVICE_MCP_CONFIG="$S/device-mcp.json" HEARTBEAT=off MAIL=off AGENT=cloud \
    nohup node server.js > "$S/bridge.log" 2>&1 &) </dev/null >/dev/null 2>&1
  for _ in $(seq 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/house" && break; sleep 1; done
  sleep 3 # the built-in apps are seeded as plugins at start
  git -C "$S/app" add -A && git -C "$S/app" -c user.name=eval -c user.email=eval@local commit -qm seeded || true
fi
OPENAI_API_KEY="$(AWS_PROFILE=openhouse-admin aws ssm get-parameter --name /home-cloud/openai-api-key --with-decryption --query Parameter.Value --output text)"
export OPENAI_API_KEY
env BRIDGE="http://127.0.0.1:$PORT" APP_DIR="$S/app" DISPLAY="$S/display" OUT="${OUT:-$S/out}" PLAYWRIGHT="$S/pw/node_modules/playwright-core/index.mjs" LIBS="$S/pw/node_modules" "$@" node "$REPO/scripts/eval/${SCRIPT:-luna-build.mjs}"
