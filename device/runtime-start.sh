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
# Every git here runs nothing from the repo itself (as bridge/edits.js GIT_SAFE): webapp/ may have come from a backup.
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c tag.gpgSign=false \
  -c diff.ignoreSubmodules=all -c submodule.recurse=false "$@"; }

# First run on this device: the starting dashboard, as a git repo (Keep/Undo need history).
if [ ! -d webapp/.git ]; then
  mkdir -p webapp && tar xzf webapp.tgz -C webapp
  (cd webapp && git init -q && git add -A && git commit -qm "Starting point" && git tag -f last-good)
fi
# The starting apps (defaults/<id>) are Opie's own plugins now: the bridge puts them in and updates them on
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
# node_modules built for this runtime (Linux arm64), not copied from elsewhere: from Opie's own package.json and
# lockfile (webapp.tgz), never the ones in webapp/ (a backup's), installed exactly and with no package's scripts run.
if [ ! -d webapp/node_modules/@esbuild/linux-arm64 ]; then
  t="$D/.npm-build"; rm -rf "$t"; mkdir -p "$t"
  if tar xzf webapp.tgz -C "$t" ./package.json ./package-lock.json \
     && (cd "$t" && npm ci --ignore-scripts --no-audit --no-fund --silent); then
    rm -rf webapp/node_modules && mv "$t/node_modules" webapp/node_modules
  fi
  rm -rf "$t"
fi
# A tablet that's part of another tablet's household (docs/multi-tablet.md) shows that household's apps: the bridge keeps
# copies of them in .satellite/webapp, served by the same dev server with the same libraries. Its own webapp/ waits,
# untouched, for it to leave.
W=webapp
if [ -f .satellite/pairing.json ]; then
  mkdir -p .satellite/webapp/apps && ln -sfn "$D/webapp/node_modules" .satellite/webapp/node_modules && W=.satellite/webapp
fi
# The dev server serves the webapp/ it started in: after a restore put another one in its place, it's stopped here and
# started again in the new one.
wid=$(stat -c %i "$W" 2>/dev/null)
if [ -n "$wid" ] && [ -f .vite-webapp ] && [ "$(cat .vite-webapp)" != "$wid" ] && up 5173; then
  echo "$(date '+%F %T') webapp/ changed (a restore): restarting the dev server"
  pkill -f 'vite/bin/vite.js' 2>/dev/null
  for i in $(seq 1 20); do up 5173 || break; sleep 0.5; done
fi
if ! up 5173; then
  echo "$wid" > .vite-webapp
  (cd "$W" && setsid nohup node "$D/webapp/node_modules/vite/bin/vite.js" --config "$D/vite.config.mjs" --host 127.0.0.1 --port 5173 --strictPort < /dev/null >> "$D/vite.log" 2>&1 9>&- &) 9>&-
fi
# Until 1.0.9 the runtime had pi and SearXNG (its web search) for the tablet's own coding agent: gone from a runtime
# unpacked from an older image too, for the space.
rm -rf /opt/pi /opt/searxng /usr/local/bin/pi /usr/local/bin/openhouse-pi /root/.pi /root/.local/share/claude /root/.local/bin/claude /usr/local/bin/claude .searxng-secret searxng.log 2>/dev/null
if ! up 8787/state; then
  # bridge.pid is written by the bridge itself as it starts (bridge/pid-file.js), so it's node's own id (its process
  # group too: setsid) and the file's age is how long that bridge has run. One that's still running but holds no port
  # (connection refused, not just slow) after two minutes never got to serving: stop it and its voice worker (its
  # process group) and start another. One that's still starting up, or listening but busy, is left alone, and no
  # second one starts beside it.
  curl -s -m 2 -o /dev/null "http://127.0.0.1:8787/state"; refused=$?
  old=$(cat bridge.pid 2>/dev/null)
  running() { [ -n "$old" ] && tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null | grep -q 'node server.js'; }
  if running && [ "$refused" = 7 ] && [ $(( $(date +%s) - $(stat -c %Y bridge.pid) )) -gt 120 ]; then
    echo "$(date '+%F %T') stopping bridge $old (running, not listening)"
    kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null
    for i in $(seq 1 10); do kill -0 "$old" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$old" 2>/dev/null; kill -KILL "$old" 2>/dev/null
  fi
  if running; then
    echo "$(date '+%F %T') bridge $old is still starting or busy: left alone"
  else
    # The assistant is the cloud's (bridge/agents/cloud.js); AGENT in ./env only for a stand-in.
    (cd bridge && env ${AGENT:+AGENT=$AGENT} DEVICE_MCP_CONFIG=$(dirname "$D")/device-mcp.json BRIDGE_PID_FILE="$D/bridge.pid" \
      setsid nohup node server.js < /dev/null >> ../bridge.log 2>&1 9>&- &) 9>&-
  fi
fi
for i in $(seq 1 60); do up 5173 && up 8787/state && { echo "$(date '+%F %T') up"; exit 0; }; sleep 0.5; done
echo "$(date '+%F %T') timed out"; exit 1
