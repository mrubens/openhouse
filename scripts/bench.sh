#!/bin/bash
# Usage: VARIANT=name [AGENT_MODEL=..] [PROMPT_MODE=..] scripts/bench.sh "request" ["request" ...]
# Restarts the bridge with the given env, runs each request, undoes it, prints phases.
cd "$(dirname "$0")/.."
kill $(lsof -ti tcp:8787 -sTCP:LISTEN) 2>/dev/null; sleep 0.5
BRIDGE_DEV=1 nohup node bridge/server.js >> bridge.log 2>&1 &
for i in $(seq 1 20); do curl -s localhost:8787/state >/dev/null && break; sleep 0.3; done
for req in "$@"; do
  n=$(wc -l < bridge/runs.jsonl 2>/dev/null || echo 0)
  curl -s -XPOST localhost:8787/request -H 'content-type: application/json' -d "$(node -e 'console.log(JSON.stringify({text:process.argv[1]}))' "$req")" >/dev/null
  for i in $(seq 1 150); do [ "$(wc -l < bridge/runs.jsonl 2>/dev/null || echo 0)" -gt "$n" ] && break; sleep 1; done
  sleep 1.5
  tail -1 bridge/runs.jsonl | node -e 'const r=JSON.parse(require("fs").readFileSync(0));const p=r.phases;console.log(`${(r.variant+" "+r.model).padEnd(34)} ${r.ok?"ok ":"ERR"} init=${p.init} text=${p.firstText} tool=${p.firstTool} edit=${p.firstEdit} vis=${p.firstVisible} done=${r.ms}  | ${r.text.slice(0,40)}`)'
  curl -s -XPOST localhost:8787/undo >/dev/null
done
