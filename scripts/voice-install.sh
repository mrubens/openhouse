#!/bin/bash
# Put the wake model on a device over adb: models/wake/ (scripts/voice-models.sh) and onnxruntime-node (linux-arm64, for
# the runtime's Node) into files/display/voice/, in place of whatever was there.
# Debug builds only (run-as): a release display downloads the same files itself (VoiceModels.kt, docs/voice-models.md,
# scripts/voice-bundle.sh makes the set).
set -e
cd "$(dirname "$0")/.."
. scripts/env.sh
MODELS=${1:?usage: voice-install.sh <models dir from scripts/voice-models.sh>}
ADB=${ADB:-adb}; PKG=$DISPLAY_PKG; F=/data/user/0/$PKG/files
$ADB shell rm -rf /data/local/tmp/voice-models; $ADB shell mkdir -p /data/local/tmp/voice-models/wake
for f in melspectrogram.onnx embedding_model.onnx opie.onnx; do $ADB push -q "$MODELS/wake/$f" /data/local/tmp/voice-models/wake/; done
$ADB shell chmod -R a+rX /data/local/tmp/voice-models
$ADB shell "run-as $PKG sh -c 'rm -rf $F/display/voice/models && mkdir -p $F/display/voice && cp -r /data/local/tmp/voice-models $F/display/voice/models'"
# The package carries every platform's library (185 MB); only this one's is kept. The old listening's sherpa-onnx goes.
$ADB shell "run-as $PKG sh /data/local/tmp/rt.sh /bin/sh -c 'cd $F/display/voice && rm -rf node_modules/sherpa-onnx-* && echo {} > package.json && { [ -d node_modules/onnxruntime-node ] || npm install --silent --ignore-scripts onnxruntime-node@1.20.1; } && cd node_modules/onnxruntime-node/bin/napi-v3 && rm -rf darwin win32 linux/x64; du -sh $F/display/voice'"
$ADB shell rm -rf /data/local/tmp/voice-models
