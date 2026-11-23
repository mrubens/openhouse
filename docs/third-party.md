# Third-party software and data

OpenHouse is MIT-licensed (`LICENSE`). These are the things in this repo, or put into its builds, that someone else
made, with their licenses. Anything marked **check** needs a decision before or soon after the repo is public.

## In this repo

| What | Where | License | Notes |
|---|---|---|---|
| PRoot 5.1.107.102 (Termux's build) | `shell/app/src/main/jniLibs/arm64-v8a/libproot.so`, `libproot-loader.so` | GPL-2.0-or-later | Run as a separate program (executed, not linked), so it ships beside MIT code as an aggregate. License text, exact version, source link and the shipped binaries' hashes are in `shell/app/src/main/assets/licenses/` (in the APK too). |
| talloc 2.5 (Termux's libtalloc 2.5.0) | `jniLibs/arm64-v8a/libtalloc.so` | LGPL-3.0-or-later | Loaded by proot only. LGPL and GPL 3 texts and the source link in `assets/licenses/`. |
| libandroid-shmem 0.7 (Termux) | `jniLibs/arm64-v8a/libandroid-shmem.so` | BSD-3-Clause | Notice in `assets/licenses/libandroid-shmem-LICENSE.txt`. |
| MapLibre GL JS 5.6.0 | `bridge/kit/maplibre-gl.js`, `.css` | BSD-3-Clause | Notice in `bridge/kit/maplibre-gl.LICENSE.txt`. |
| Inter, Newsreader, Caveat, Nunito | `shell/app/src/main/assets/fonts/` | SIL OFL 1.1 | License texts beside the fonts (`OFL-*.txt`). |
| Phosphor Icons 2.1.1 (path data) | `chat/src/tab-icons.js` | MIT | Credited in the file. |
| IEEE MAC prefix registry (maker names) | `bridge/devices/oui.txt.gz`, built by `scripts/oui-build.mjs` | IEEE public listing | Facts (prefix to company name), freely published by IEEE; commonly redistributed (Wireshark, nmap). Fine. |
| The "Opie" wake model | `models/wake/opie.onnx` | Ours (MIT) | Trained only on synthetic and public data whose licenses allow it (`docs/wake-word.md`): Piper and Kokoro voices, Chatterbox (MIT) clones of LibriTTS-R speakers, LibriSpeech, AMI, MUSAN, VoxPopuli (CC0/CC-BY), People's Speech, YODAS2 (CC-BY 3.0) and Earnings-22 (CC-BY-SA 4.0). openWakeWord's non-commercial negatives were left out. **check:** the CC-BY sets ask for attribution; a list in `docs/wake-word.md` covers it, but whether CC-BY-SA training data binds the weights is unsettled law. Low risk; say so in the model's notes. |

## Fetched when building or installing (not in the repo)

| What | Used by | License |
|---|---|---|
| openWakeWord's `melspectrogram.onnx`, `embedding_model.onnx` (v0.5.1) | the voice set on the CDN (`scripts/voice-models.sh`) | Apache-2.0 |
| onnxruntime-node 1.20.1, onnxruntime-common | the voice set | MIT |
| Ubuntu 24.04 base, git, curl, ca-certificates | the tablet's runtime image (`runtime/Dockerfile`) | Various free licenses (GPL, LGPL, MIT…), unmodified Ubuntu packages |
| Node.js 22 | the runtime image | MIT (bundles others under their own) |
| React 19, react-dom, scheduler, zod 4 | `chat/` (bundled into the bridge's pages) | MIT |
| @json-render/core, @json-render/react 0.23.1 | `chat/` | Apache-2.0 (keep its NOTICE, if any, in the bundle's notices) |
| esbuild | `chat/` build only | MIT |
| Phaser 4, three.js, eventemitter3 | `webapp/` (the family's games) | MIT |
| Rapier 2D/3D (@dimforge) | `webapp/` | Apache-2.0 |
| Vite 5 | `webapp/` dev server | MIT |
| AndroidX (Compose, Activity, CameraX), Kotlin stdlib | `shell/` | Apache-2.0 |
| apksig 8.7.3 | `shell/` | Apache-2.0 |
| ZXing core 3.5.3 | `shell/` | Apache-2.0 |
| org.json (tests only) | `shell/` | Public domain (JSON License text since 2024: "Public Domain") |
| @openai/codex | `spikes/vendors/` (an old spike, not shipped) | Apache-2.0 |

Nothing here is incompatible with publishing the repo under MIT. The GPL/LGPL binaries have their license texts,
versions and source links in `shell/app/src/main/assets/licenses/README.txt`, which the APK carries. Still open: an
"About" or notices screen in the app listing the Apache-2.0 and BSD components.

## Services, not software

OpenAI's live voice and text model (through the OpenHouse cloud), Nutrislice's public menu API
(School lunch plugin), Open-Meteo for the weather and place search, OpenFreeMap tiles, Nominatim and the OSM routing service for the Map
app (OpenStreetMap data, ODbL: the map shows its attribution), iCloud shared albums and calendar links:
used over the network under their own terms, nothing of theirs is in the repo.
