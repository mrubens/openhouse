#!/bin/bash
# Usage: scripts/bench-device.sh "request" ["request" ...]
# Runs requests against the on-device bridge (via adb forward), undoes each, prints phases,
# and samples device memory once a second while it runs (lowest MemAvailable, biggest PSS).
cd "$(dirname "$0")/.."
. scripts/env.sh
adb forward tcp:9787 tcp:8787 >/dev/null
T=$(scripts/bridge-token.sh) || exit 1 # the bridge answers only with its secret
OUT=${MEMLOG:-bench-device-mem.log}; : > "$OUT"
adb shell 'while true; do a=$(grep MemAvailable /proc/meminfo | tr -s " " | cut -d" " -f2); \
  c=0; for p in $(pgrep -f "claude|node|vite|esbuild|proot"); do v=$(grep -m1 ^Pss: /proc/$p/smaps_rollup 2>/dev/null | tr -s " " | cut -d" " -f2); c=$((c+${v:-0})); done; \
  echo "$(date +%s) $a $c"; sleep 1; done' > "$OUT" &
MEM=$!
for req in "$@"; do
  n=$(adb shell run-as $DISPLAY_PKG sh -c 'wc -l < files/display/bridge/runs.jsonl 2>/dev/null || echo 0' | tr -d '\r')
  curl -s -H "X-Openhouse-Token: $T" -XPOST localhost:9787/request -H 'content-type: application/json' -d "$(node -e 'console.log(JSON.stringify({text:process.argv[1]}))' "$req")" >/dev/null
  for i in $(seq 1 200); do s=$(curl -s -H "X-Openhouse-Token: $T" localhost:9787/state); case "$s" in *'"review"'*|*'"idle"'*) [ $i -gt 2 ] && break;; esac; sleep 1; done
  sleep 2
  adb shell run-as $DISPLAY_PKG tail -1 files/display/bridge/runs.jsonl | node -e 'const r=JSON.parse(require("fs").readFileSync(0));const p=r.phases;console.log(`${("device "+r.model).padEnd(16)} ${r.ok?"ok ":"ERR"} init=${p.init} text=${p.firstText} tool=${p.firstTool} edit=${p.firstEdit} vis=${p.firstVisible} done=${r.ms}  | ${r.text.slice(0,50)}`)'
  curl -s -H "X-Openhouse-Token: $T" -XPOST localhost:9787/undo >/dev/null; sleep 2
done
kill $MEM 2>/dev/null; wait $MEM 2>/dev/null
awk '{ if (min==""||$2<min) min=$2; if ($3>max) max=$3; if (NR==1) first=$2 } END { printf "MemAvailable: start %.0f MB, lowest %.0f MB. Agent+dev procs PSS peak %.0f MB\n", first/1024, min/1024, max/1024 }' "$OUT"
