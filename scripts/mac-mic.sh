#!/bin/bash
# Talk to the emulator with the Mac's microphone. The emulator's own microphone input hangs it on
# macOS, so this streams the Mac mic (ffmpeg) straight into the display's listening endpoint
# (/voice/stream on the bridge, forwarded over adb) - the same 16 kHz audio the shell would send.
# Everything after the microphone is the real pipeline: wake words, who's talking, transcript.
# Usage: scripts/mac-mic.sh [avfoundation audio device index, default 0]. Ctrl-C to stop.
set -e
cd "$(dirname "$0")/.."
. scripts/env.sh
adb forward tcp:9787 tcp:8787 >/dev/null
T=$(scripts/bridge-token.sh) # the bridge answers only with its secret
curl -sf -m3 -H "X-Openhouse-Token: $T" localhost:9787/voice/status >/dev/null || { echo "The display's bridge isn't reachable on :9787."; exit 1; }
echo "Listening through the Mac microphone. Say \"Hey display, …\". Ctrl-C to stop."
ffmpeg -hide_banner -loglevel error -f avfoundation -i ":${1:-0}" -ac 1 -ar 16000 -f s16le - \
  | curl -s -H "X-Openhouse-Token: $T" -X POST -T - -H 'content-type: application/octet-stream' localhost:9787/voice/stream >/dev/null
