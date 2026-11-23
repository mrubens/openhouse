#!/bin/bash
# Everything the wake-word work needs on the Mac (docs/wake-word.md), in one folder outside the repo (about 9 GB):
#   py/            Python 3.12 with torch, onnxruntime, piper-tts, sherpa-onnx
#   voice/         the display's listener as the bench runs it: voice-models.sh's wake model and onnxruntime-node
#   dl/piper       Piper's LibriTTS-R (904 speakers) and VCTK (109) voices                       training voices
#   dl/kokoro-*    Kokoro v1.0 (28 English voices)                                                 test voices (and macOS `say`)
#   dl/noise       DEMAND: kitchen, living room, washing, cafeteria (CC-BY-SA 3.0)                  rooms
#   dl/test        LibriSpeech test-clean (CC-BY 4.0), AMI SDM test shards (CC-BY 4.0), GTZAN       other sound
#   dl/neg         other speech to train against: LibriSpeech dev-clean, dev-other, test-other and AMI SDM train shards
#                  (CC-BY 4.0)
#   dl/acav        the first 410 hours of openWakeWord's ACAV100M negative features (CC-BY-NC-SA 4.0, non-commercial:
#                  for comparison only, the model that ships isn't trained on them; docs/wake-word.md)
#   oww/           openWakeWord's melspectrogram.onnx, embedding_model.onnx and validation features (Apache-2.0)
#
#   scripts/wake/setup.sh [dir]     (default ~/.cache/openhouse-wake; what's there already is kept)
set -e
cd "$(dirname "$0")/../.."
ROOT=$(pwd); W=${1:-$HOME/.cache/openhouse-wake}
mkdir -p "$W"/{dl/piper,dl/noise,dl/acav,dl/test,oww,voice}
get() { [ -s "$2" ] || { echo "↓ $2"; curl -sSLf ${3:+-r $3} "$1" -o "$2.part" && mv "$2.part" "$2"; }; }
[ -x "$W/py/bin/python" ] || uv venv -q -p 3.12 "$W/py"
VIRTUAL_ENV="$W/py" uv pip install -q torch numpy scipy soundfile onnxruntime onnx piper-tts sherpa-onnx pyarrow
# espeak-ng (Piper's phonemizer) can't open its data under a long path: a short link to it.
ln -sfn "$W/py/lib/python3.12/site-packages/piper/espeak-ng-data" "$W/espeak"
H=https://huggingface.co/rhasspy/piper-voices/resolve/main/en
for v in en_US/libritts_r/medium/en_US-libritts_r-medium en_GB/vctk/medium/en_GB-vctk-medium; do
  get $H/$v.onnx "$W/dl/piper/$(basename $v).onnx"; get $H/$v.onnx.json "$W/dl/piper/$(basename $v).onnx.json"; done
for n in DKITCHEN DLIVING DWASHING PCAFETER; do
  [ -d "$W/dl/noise/$n" ] || { get https://zenodo.org/records/1227121/files/${n}_16k.zip "$W/dl/noise/$n.zip"; (cd "$W/dl/noise" && unzip -qo $n.zip && rm $n.zip); }; done
O=https://github.com/dscripka/openWakeWord/releases/download/v0.5.1
get $O/melspectrogram.onnx "$W/oww/melspectrogram.onnx"; get $O/embedding_model.onnx "$W/oww/embedding_model.onnx"
F=https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main
get $F/validation_set_features.npy "$W/oww/validation_set_features.npy"
get $F/openwakeword_features_ACAV100M_2000_hrs_16bit.npy "$W/dl/acav/acav_part.npy" 0-3538944127  # 1.15 M windows of 1.28 s
[ -d "$W/dl/test/ls" ] || { mkdir -p "$W/dl/test/ls"; curl -sSLf https://www.openslr.org/resources/12/test-clean.tar.gz | tar xz -C "$W/dl/test/ls"; }
for i in 0 1; do get "https://huggingface.co/datasets/edinburghcstr/ami/resolve/main/sdm/test-0000$i-of-00004.parquet" "$W/dl/test/ami-$i.parquet"; done
[ -d "$W/dl/test/gtzan" ] || { mkdir -p "$W/dl/test/gtzan"; curl -sSLf https://huggingface.co/datasets/marsyas/gtzan/resolve/main/data/genres.tar.gz | tar xz -C "$W/dl/test/gtzan"; }
mkdir -p "$W/dl/neg"
for part in dev-clean dev-other test-other; do [ -d "$W/dl/neg/LibriSpeech/$part" ] || curl -sSLf https://www.openslr.org/resources/12/$part.tar.gz | tar xz -C "$W/dl/neg"; done
for i in 0 1 2 3; do get "https://huggingface.co/datasets/edinburghcstr/ami/resolve/main/sdm/train-0000$i-of-00027.parquet" "$W/dl/neg/ami-train-$i.parquet"; done
rm -f "$W/dl/test/gtzan/genres/jazz/jazz.00054.wav" # (a broken file in GTZAN)
[ -d "$W/dl/kokoro-multi-lang-v1_0" ] || curl -sSLf https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2 | tar xj -C "$W/dl"
scripts/voice-models.sh "$W/voice/models" >/dev/null
[ -d "$W/voice/node_modules/onnxruntime-node" ] || (cd "$W/voice" && echo '{}' > package.json && npm install --silent --no-audit --no-fund onnxruntime-node@1.20.1)
du -sh "$W"
