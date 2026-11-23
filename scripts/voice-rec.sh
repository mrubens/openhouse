#!/bin/bash
# A test recording of your own test session on the display: what its microphone heard, and what the
# listener was told and decided, kept on the display until you pull or clear it. Off unless you switch
# it on here; it switches itself off after the minutes you give (15 by default, 60 at most) and is never
# on after a restart. For working on the listening only: don't leave it on with the family around.
#
#   scripts/voice-rec.sh on [minutes]    start     scripts/voice-rec.sh off    stop
#   scripts/voice-rec.sh list            what's there (and whether it's on)
#   scripts/voice-rec.sh pull [dir]      copy them to the Mac (default runtime/voice-rec), then
#                                        VOICE_DIR=… node scripts/voice-replay.mjs runtime/voice-rec
#   scripts/voice-rec.sh clear           delete them from the display
#
# BRIDGE=localhost:9797 for a bridge that's already forwarded; OPENHOUSE_TOKEN to skip asking adb for
# the secret. Set ANDROID_SERIAL when more than one device is connected.
cd "$(dirname "$0")/.."
. scripts/env.sh
if [ -z "$BRIDGE" ]; then adb forward tcp:9787 tcp:8787 >/dev/null; BRIDGE=localhost:9787; fi
T=${OPENHOUSE_TOKEN:-$(scripts/bridge-token.sh)} || exit 1
api() { curl -sf -m "${MAXT:-10}" -H "X-Openhouse-Token: $T" "$@"; }
post() { api -XPOST -H 'content-type: application/json' -d "$2" "$BRIDGE$1"; }
case "$1" in
  on) post /voice/record "{\"on\":true,\"minutes\":${2:-15}}" || echo "Couldn't start it (is the bridge up, are the recordings full?)";;
  off) post /voice/record '{"on":false}';;
  list) api "$BRIDGE/voice/record";;
  clear) post /voice/record/clear '{}';;
  pull)
    out=${2:-runtime/voice-rec}; mkdir -p "$out"
    for f in $(api "$BRIDGE/voice/record" | node -e 'for (const f of JSON.parse(require("fs").readFileSync(0)).files) console.log(f.name)'); do
      MAXT=300 api -o "$out/$f" "$BRIDGE/voice/record/$f" && echo "$out/$f"
    done;;
  *) sed -n '2,14p' "$0"; exit 2;;
esac
echo
