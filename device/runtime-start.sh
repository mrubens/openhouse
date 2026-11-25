#!/bin/bash
# Start Vite (the family's apps) and the bridge inside the display's own runtime
# (the shell's bundled proot + Ubuntu image). Idempotent: the shell calls it on launch and
# whenever the bridge stops answering. Settings (AGENT, for a stand-in) come from ./env.
D=$(cd "$(dirname "$0")" && pwd)
cd "$D" || exit 1
[ -f env ] && . ./env
up() { curl -s -m 2 -o /dev/null "http://127.0.0.1:$1/" ; }
for n in $(seq 3 30); do eval "exec $n>&-"; done 2>/dev/null
exec < /dev/null >> "$D/start.log" 2>&1
exec 9> "$D/.start.lock"; flock -n 9 || exit 0
echo "$(date '+%F %T') starting"

# First run on this device: the starting dashboard, as a git repo (Keep/Undo need history).
if [ ! -d webapp/.git ]; then
  mkdir -p webapp && tar xzf webapp.tgz -C webapp
  (cd webapp && git init -q && git add -A && git commit -qm "Starting point" && git tag -f last-good)
fi
# The starting apps (defaults/<id>) are OpenHouse's own plugins now: the bridge puts them in and updates them on
# start-up (bridge/plugins.js syncBuiltins), with the one-time move of webapp/apps into plugins before that.
# Apps from before apps were web pages, rewritten (defaults/ports, see its README): each swapped in once, and only over
# the exact source it was ported from (anything else, or anything the family changed since, stays as it is).
if [ -d ports ]; then
  ported=""
  for d in ports/*/; do
    id=$(basename "$d"); a="webapp/apps/$id"
    [ -f "$a/App.kt" ] && [ -f "${d}replaces.sha256" ] && { [ -f "$d/index.html" ] || [ -f "$d/style.json" ]; } || continue
    [ "$(sha256sum "$a/App.kt" | cut -c1-64)" = "$(head -c 64 "${d}replaces.sha256")" ] || continue
    rm -f "$a"/*.kt && cp -R "$d." "$a/" && rm -f "$a/replaces.sha256" && ported="$ported $id"
  done
  [ -n "$ported" ] && (cd webapp && for id in $ported; do git add -A "apps/$id"; done && git commit -qm "Moved to web:$ported" && git tag -f last-good)
fi
# node_modules built for this runtime (Linux arm64), not copied from elsewhere.
if [ ! -d webapp/node_modules/@esbuild/linux-arm64 ]; then
  (cd webapp && rm -rf node_modules && npm install --no-audit --no-fund --silent)
fi
if ! up 5173; then
  (cd webapp && setsid nohup node node_modules/vite/bin/vite.js --config ../vite.config.mjs --host 127.0.0.1 --port 5173 --strictPort < /dev/null >> ../vite.log 2>&1 9>&- &) 9>&-
fi
# Until 1.0.9 the runtime had pi and SearXNG (its web search) for the tablet's own coding agent: gone from a runtime
# unpacked from an older image too, for the space.
rm -rf /opt/pi /opt/searxng /usr/local/bin/pi /usr/local/bin/openhouse-pi /root/.pi /root/.local/share/claude /root/.local/bin/claude /usr/local/bin/claude .searxng-secret searxng.log 2>/dev/null
if ! up 8787/state; then
  # A bridge from an earlier start that is still running but holds no port (connection refused, not just slow) after
  # two minutes never got to serving: stop it and its voice worker (its process group) before starting another, so
  # two never run side by side. One that's still starting up, or listening but busy, is left alone.
  curl -s -m 2 -o /dev/null "http://127.0.0.1:8787/state"; refused=$?
  old=$(cat bridge.pid 2>/dev/null)
  if [ "$refused" = 7 ] && [ -n "$old" ] && tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null | grep -q 'node server.js' \
     && [ $(( $(date +%s) - $(stat -c %Y bridge.pid) )) -gt 120 ]; then
    echo "$(date '+%F %T') stopping bridge $old (running, not listening)"
    kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null
    for i in $(seq 1 10); do kill -0 "$old" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$old" 2>/dev/null; kill -KILL "$old" 2>/dev/null
  fi
  # The assistant is the cloud's (bridge/agents/cloud.js); AGENT in ./env only for a stand-in. setsid makes node its
  # own process group, so $! (env, which becomes node) is the bridge and its group.
  (cd bridge && env ${AGENT:+AGENT=$AGENT} DEVICE_MCP_CONFIG=$(dirname "$D")/device-mcp.json \
    setsid nohup node server.js < /dev/null >> ../bridge.log 2>&1 9>&- & echo $! > ../bridge.pid) 9>&-
fi
for i in $(seq 1 60); do up 5173 && up 8787/state && { echo "$(date '+%F %T') up"; exit 0; }; sleep 0.5; done
echo "$(date '+%F %T') timed out"; exit 1
