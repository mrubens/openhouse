#!/bin/bash
# Usage: SESSION=reuse|fresh scripts/bench-followup.sh "first request" "follow-up"
# Runs the first request, keeps it, runs the follow-up, undoes both. Prints phases.
cd "$(dirname "$0")/.."
kill $(lsof -ti tcp:8787 -sTCP:LISTEN) 2>/dev/null; sleep 0.5
BRIDGE_DEV=1 nohup node bridge/server.js >> bridge.log 2>&1 &
for i in $(seq 1 20); do curl -s localhost:8787/state >/dev/null && break; sleep 0.3; done
base=$(git -C webapp rev-parse HEAD)
run() {
  n=$(wc -l < bridge/runs.jsonl)
  curl -s -XPOST localhost:8787/request -H 'content-type: application/json' -d "$(node -e 'console.log(JSON.stringify({text:process.argv[1]}))' "$1")" >/dev/null
  for i in $(seq 1 150); do [ "$(wc -l < bridge/runs.jsonl)" -gt "$n" ] && break; sleep 1; done; sleep 1.5
  tail -1 bridge/runs.jsonl | node -e 'const r=JSON.parse(require("fs").readFileSync(0));const p=r.phases;console.log(`${(process.env.SESSION+" "+r.model).padEnd(30)} tool=${p.firstTool} edit=${p.firstEdit} vis=${p.firstVisible} done=${r.ms} | ${r.text.slice(0,40)}`)'
}
run "$1"; curl -s -XPOST localhost:8787/keep >/dev/null
run "$2"; curl -s -XPOST localhost:8787/undo >/dev/null
git -C webapp reset -q --hard "$base"; git -C webapp tag -f last-good "$base" >/dev/null
