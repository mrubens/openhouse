#!/bin/bash
# Make the voice set a display downloads (VoiceModels.kt, docs/voice-models.md): the wake model and the runtime that
# runs it, as a folder for the releases CDN, with voice.json listing each file's SHA-256 and size.
#
#   scripts/voice-bundle.sh <models dir> <out dir> [version]
#
# <models dir> from scripts/voice-models.sh (wake/melspectrogram.onnx, wake/embedding_model.onnx; opie.onnx comes from
# this repo's models/wake/). onnxruntime-node (linux-arm64 only, for the runtime's Node) comes from npm. Nothing else:
# there are no other speech models on the tablet (docs/wake-word.md). Upload with
# openhouse-cloud/scripts/release.ts --voice <out dir>/<version>; nothing here goes anywhere.
set -e
cd "$(dirname "$0")/.."
MODELS=${1:?usage: voice-bundle.sh <models dir> <out dir> <version>}; OUT=${2:?usage: voice-bundle.sh <models dir> <out dir> <version>}; VERSION=${3:?usage: voice-bundle.sh <models dir> <out dir> <version>}
D="$OUT/$VERSION"
[ -e "$D" ] && { echo "$D already exists: a version is made once (pick another)"; exit 1; }
mkdir -p "$D/models/wake"
for f in melspectrogram.onnx embedding_model.onnx; do cp "$MODELS/wake/$f" "$D/models/wake/"; done; cp models/wake/opie.onnx models/wake/opie.json "$D/models/wake/"
# onnxruntime-node (its package carries every platform's library: linux-arm64 kept).
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ORT=${ORT_VERSION:-1.20.1}
(cd "$T" && echo '{}' > package.json && npm install --silent --no-audit --no-fund --ignore-scripts "onnxruntime-node@$ORT" >/dev/null)
N="$T/node_modules/onnxruntime-node/bin/napi-v3"; [ -f "$N/linux/arm64/onnxruntime_binding.node" ] || { echo "npm didn't fetch onnxruntime-node for linux-arm64"; exit 1; }
rm -rf "$N/darwin" "$N/win32" "$N/linux/x64"
mkdir -p "$D/node_modules"
cp -R "$T/node_modules/onnxruntime-node" "$T/node_modules/onnxruntime-common" "$D/node_modules/"
find "$D" -name .DS_Store -delete
node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [dir, version] = process.argv.slice(1), files = [];
(function walk(rel) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(r);
    else if (e.isFile()) { const b = fs.readFileSync(path.join(dir, r)); files.push({ path: r, sha256: crypto.createHash("sha256").update(b).digest("hex"), size: b.length }); }
    else throw new Error("not a plain file: " + r);
  }
})("");
const set = files.filter((f) => f.path !== "voice.json");
for (const f of set) if (!/^(models|node_modules)(\/[A-Za-z0-9._@+-]+)+$/.test(f.path)) throw new Error("a path the display would refuse: " + f.path);
fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify({ schema: 1, version, files: set }, null, 1) + "\n");
console.log(`${dir}: voice set ${version}, ${set.length} files, ${(set.reduce((n, f) => n + f.size, 0) / 1e6).toFixed(0)} MB`);
' "$D" "$VERSION"
