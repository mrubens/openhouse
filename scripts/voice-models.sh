#!/bin/bash
# Download the wake model the display listens with into one folder, for scripts/voice-install.sh and
# scripts/voice-bundle.sh (docs/wake-word.md). About 4 MB.
#   wake/melspectrogram.onnx, wake/embedding_model.onnx   openWakeWord's front end (Apache-2.0, its v0.5.1 release)
#   wake/opie.onnx                                        "Opie" / "Hey Opie" (ours, from this repo: models/wake/)
# It runs with onnxruntime-node (voice-bundle.sh and voice-install.sh fetch it). There are no other speech models on
# the tablet: OpenAI's live voice hears what's said after its name.
# Usage: scripts/voice-models.sh [dir]   (default runtime/voice-models)
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd); D=${1:-runtime/voice-models}
mkdir -p "$D/wake" && cd "$D"
get() { [ -e "$2" ] || { echo "↓ $2"; curl -sSLf "$1" -o "$2.part" && mv "$2.part" "$2"; }; }
O=https://github.com/dscripka/openWakeWord/releases/download/v0.5.1
get $O/melspectrogram.onnx wake/melspectrogram.onnx
get $O/embedding_model.onnx wake/embedding_model.onnx
cp "$ROOT/models/wake/opie.onnx" wake/opie.onnx; cp "$ROOT/models/wake/opie.json" wake/opie.json
du -sh .
