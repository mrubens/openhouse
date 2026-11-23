#!/bin/bash
# Usage: scripts/try-request.sh "request" [app-id] [frames-dir]
# Sends a request to the on-device bridge, screenshots every ~1.5 s until it finishes,
# prints timings, the final message and the bridge log tail. The change stays (say "undo" to take it back).
cd "$(dirname "$0")/.."
. scripts/env.sh
adb forward tcp:9787 tcp:8787 >/dev/null
T=$(scripts/bridge-token.sh) || exit 1 # the bridge answers only with its secret
OUT=${3:-/tmp/frames}; mkdir -p "$OUT"; rm -f "$OUT"/f*.png
body=$(node -e 'const [t,a]=process.argv.slice(1);console.log(JSON.stringify(a?{text:t,app:a}:{text:t}))' "$1" "$2")
curl -s -H "X-Openhouse-Token: $T" -XPOST localhost:9787/request -H 'content-type: application/json' -d "$body" >/dev/null
t0=$(date +%s); i=0
while :; do
  i=$((i+1)); adb exec-out screencap -p > "$OUT/f$(printf %03d $i)-$(( $(date +%s)-t0 ))s.png"
  s=$(curl -s -H "X-Openhouse-Token: $T" localhost:9787/state); case "$s" in *'"review"'*|*'"idle"'*) [ $i -gt 2 ] && break;; esac
  [ $(( $(date +%s)-t0 )) -gt 300 ] && break; sleep 1.2
done
sleep 2; adb exec-out screencap -p > "$OUT/final.png"
adb shell run-as $DISPLAY_PKG tail -1 files/display/bridge/runs.jsonl | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log("ok",r.ok,"ms",r.ms,JSON.stringify(r.phases),"edits",r.edits.join(","))'
adb shell run-as $DISPLAY_PKG tail -40 files/display/bridge.log | grep -E "^\[(done|log)\]" | tail -4 | cut -c1-400
