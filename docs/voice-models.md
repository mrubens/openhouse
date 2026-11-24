# Voice models: the display downloads them

Since set 3 (2026-11-20), the only speech model on the tablet is the wake model ("Opie", `docs/wake-word.md`): about
30 MB with the runtime that runs it. What's said after its name goes to OpenAI's live voice (shell `LiveVoice.kt`); the
tablet has no speech recognition, speaker model, keyword spotter, voice detector, turn model or speech voices of its own.
The other speech models are removed. The microphone and the wake model run only while Live voice is
on; with it off, or the tablet not linked, nothing listens, and there's no local fallback.

A debug build gets the files over adb (`scripts/voice-install.sh`, which uses `run-as`); a release build isn't
debuggable, so the display fetches them itself (`shell/.../VoiceModels.kt`).

## What a voice set is

One folder on the releases CDN, `releases/voice/<version>/`, with `voice.json` and the files beside it:

```json
{ "schema": 1, "version": "3", "files": [ { "path": "models/wake/opie.onnx", "sha256": "…", "size": 1123690 }, … ] }
```

Set 3: `models/wake/` (openWakeWord's `melspectrogram.onnx` and `embedding_model.onnx`, Apache-2.0, v0.5.1; our
`opie.onnx`) and, under `node_modules/`, `onnxruntime-node` 1.20.1 with `onnxruntime-common` (its linux-arm64 library
only), for the runtime's Node: 227 files, 32 MB. Each file is its own object (so a download can resume and a bad file
costs only itself), immutable once uploaded.

Paths must be under `models/` or `node_modules/`, plain characters, no `.` or `..`; URLs are relative to `voice.json`
and https only (plain http only from a tester's computer: 10.0.2.2, localhost), as for releases.

## On the tablet

- Which set: the build's `openhouse.voiceUrl` (`shell/gradle.properties`, now
  `https://d15yaylh7unz6h.cloudfront.net/releases/voice/1/voice.json`), or `voice_url` from the QR code's admin extras
  or over adb (`ConfigReceiver --es voice_url …`, `""` for the build's own; `--ez voice_get true` to get it now). A new
  set is a new version in `gradle.properties`, carried by a release.
- When: the watchdog asks every 10 s once the runtime is set up, the microphone is on and so is Live voice; turning
  either on asks at once. It runs in its own thread, so first run never waits. Only on an unmetered network. After a failure it tries
  again in 10 min, then 20, 40… up to 6 h.
- Already there: `voice/.installed` holds the set's URL; nothing is fetched while it matches. A tablet that has the wake
  model from `voice-install.sh` (`models/wake/opie.onnx` and `onnxruntime-node`) and no marker is taken as having the
  build's set.
- Old models go: the bridge removes everything in `voice/models/` but `wake/`, and in `voice/node_modules/` but
  `onnxruntime-node` and `onnxruntime-common`, each time it starts and on `/voice/reload` (`bridge/voice.js`
  `clearOld`), with what it kept for them (`voiceprints.json`, the echo canceller's files). A tablet on set 1 or 2 frees
  about 800 MB at its first start on the new bridge, before set 3 has downloaded; it can't hear its name until set 3 is
  in place.
- How: files go to `voice/.download/` (`.part` until complete, resumed with a Range request; kept only once the size and
  SHA-256 match), with room checked first (what's left plus 300 MB). When all are there: `node_modules/` then `models/` are swapped in, the marker is
  written and the bridge is told (`POST /voice/reload`: the listener and speaker start again on the new files). The
  bridge also looks again every 30 s while listening isn't installed.
- Seen: `voice/download.json` (`{state, version, got, total, error}`) is in `/voice/status` as `download`, and Settings'
  Hey Opie row says "Getting ready", "Waits for Wi-Fi" or "Not ready yet" until they're in place.

## Making and uploading a set

```bash
scripts/voice-models.sh ~/.cache/openhouse-wake/voice-models-3
```

```bash
scripts/voice-bundle.sh ~/.cache/openhouse-wake/voice-models-3 ~/.openhouse/voice 3
```

```bash
scripts/cloud.sh node scripts/release.ts --voice ~/.openhouse/voice/3
```

`voice-bundle.sh` copies the wake model, fetches onnxruntime-node's linux-arm64 library from npm and writes
`voice.json`; it refuses a version folder that already exists. `release.ts --voice` checks every file against
`voice.json`, uploads them to `releases/voice/<version>/` (immutable), `voice.json` last, and refuses a version already
published. It changes no tablet: tablets fetch the set their build names. `--local .local` puts it in the local cloud
server's folder instead.

## Tested (2026-11-19)

A release build (1.0.4 from this branch, release type, signed with a throwaway key, `run-as` refused: "package not
debuggable") on a wiped emulator (`display-qr`), made device owner over adb, the runtime from the Mac, `voice_url` at the
Mac (`python3 -m http.server`, serving set 1 made by `voice-bundle.sh` from the prototype's models). With the microphone
switched on, set 1 downloaded during first run (781 MB in 84 s) and went in place; `/voice/status` said ready, model
"sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8 + nemo_en_titanet_small.onnx + wake words", the six "Opie" wake phrases,
able to speak. The wake name was changed to "pip", then a set 2 (the same files) was given: it downloaded, swapped in
and reloaded, kept "pip", and a recording of "Hey Pip, add bananas to the shopping list." was heard through the wake
words and addressed. A restart fetched nothing.

Not tried: a resumed download (Python's server ignores Range, so a broken file starts over there; the CDN honours it),
a metered network, a real tablet, or a tablet downloading from the CDN itself.

## Published

Set 1 went up on 2026-11-19 (`AWS_PROFILE=openhouse-admin node scripts/release.ts --voice ~/.openhouse/voice/1`):
https://d15yaylh7unz6h.cloudfront.net/releases/voice/1/voice.json. All 48 files were read back from the CDN and matched
their SHA-256s, and a Range request answered 206. Only a release built from this code fetches it (1.0.3 doesn't).
Set 2 (made 2026-11-20): set 1's files plus the wake model and onnxruntime-node, 276 files, 822 MB. Never uploaded:
set 3 replaced it.

Set 3 (made 2026-11-20, `scripts/voice-bundle.sh … 3`): the wake model and onnxruntime-node only, as above.
`openhouse.voiceUrl` points at it (`releases/voice/3/voice.json`); it has to be uploaded before a build with that
pointer goes on a tablet (`node scripts/release.ts --voice ~/.openhouse/voice/3`). Not yet tried on a device:
onnxruntime-node 1.20.1 in the runtime's Node on linux-arm64 (it runs on the Mac, and its library is the arm64 build).

Set 8 (made 2026-11-24): set 7 with the threshold at 0.99. `openhouse.voiceUrl` points at it.

Set 7 (made 2026-11-24): set 6 with round 5's wake model (`opie.onnx`, f3, 2.5 MB); same threshold, gain and floor.
No published release points at it.

Set 6 (made 2026-11-24): set 5 with `opie.json` also setting the microphone's gain (2, fixed) and a loudness floor
(0.03) for the listener; same model. `openhouse.voiceUrl` points at it from 1.0.24.

Set 5 (made 2026-11-23, `scripts/voice-bundle.sh … 5`): set 4 with round 4's wake model (`opie.onnx`, 4.3 MB) and
`models/wake/opie.json` (its threshold, 0.98, which the listener reads; without it, 0.9). `openhouse.voiceUrl` points
at it from 1.0.23. A 1.0.22 tablet keeps set 4 until it updates.

Set 4 (made 2026-11-20, `scripts/voice-bundle.sh ~/.cache/openhouse-wake/voice-models-3 ~/.openhouse/voice 4`): set 3
with round 3's wake model (`models/wake/opie.onnx`, 2.4 MB); every other file is the same. `openhouse.voiceUrl` points
at it (`releases/voice/4/voice.json`); upload it before a build with that pointer goes on a tablet
(`node scripts/release.ts --voice ~/.openhouse/voice/4`). A tablet on set 3 fetches set 4 by itself (a new version).
