# Is our "Hey Opie" model worth keeping? (2026-11-27)

The question: how well does our own wake model (`models/wake/opie.onnx`, `docs/wake-word.md`) work, and does an
existing engine do as well or better, so we needn't make our own? Evaluation only: nothing that ships changed.

**Answer: keep ours.** On our test set it hears "Hey Opie" better than every other engine we could run, at the same
or fewer false wakes, and it is the only one that ignores "Opie" alone and "Hi Opie" as asked. Both engines that
train a model for you (openWakeWord and microWakeWord) did worse made their standard way, and both train on
non-commercial negatives. sherpa-onnx needs no training but hears less; Porcupine can't be licensed for an open-source
app at all. What we made is the design the field settled on (a small head on a shared speech embedding, trained on
synthetic voices); the newest engine, LiveKit WakeWord, is the same idea with its own encoder. My reading: borrow
that encoder as the next round to try, and score every clip at several offsets in our bench.

## The numbers

Our test set (`scripts/wake/testset.py`: macOS and Kokoro voices the model never trained on, adults and children,
four rooms), "Hey Opie" clips only, out of 10, and false wakes an hour on its 12 hours of other sound (read speech,
meetings, music, household noise). Each engine hears what the tablet's listener hands on (gain 2, the loudness floor,
1.5 s between wakes), and each clip is scored at four offsets within the 80 ms step (below).

| | up close | kitchen noise | across the room | TV or talk behind | "Opie." or "Hi Opie" woke | near-misses woke | false wakes an hour |
|---|---|---|---|---|---|---|---|
| **ours (round 6, y2), 0.98, as shipped** | **8.4** | **7.6** | **2.4** | **3.9** | **0%** | **2%** | **0 in 12 h** |
| ours, 0.915 (one false wake in 12 h) | 8.8 | 8.1 | 3.0 | 4.4 | 0% | 2% | 0.08 |
| openWakeWord, its standard recipe (`oww_standard.py`), 0.5 (its default) | 7.8 | 7.1 | 4.5 | 3.3 | 10% | 3% | 1.6 |
| openWakeWord, standard recipe, 0.96 (one false wake in 12 h) | 5.5 | 5.4 | 2.6 | 1.9 | 5% | 1% | 0.08 |
| microWakeWord, its notebook recipe (`mww_standard.py`), 0.99 | 8.7 | 7.1 | 6.2 | 6.2 | 33% | 28% | 9.0 |
| microWakeWord, the same at 40,000 steps, 0.99 | 7.7 | 6.9 | 6.4 | 5.7 | 30% | 20% | 2.1 |
| sherpa-onnx keyword spotter, threshold 0.15, boost 2 | 6.2 | 5.6 | 2.1 | 3.7 | 1% | 1% | 0 in 12 h |
| sherpa-onnx, threshold 0.05, boost 3 (its most lenient) | 7.2 | 6.5 | 2.8 | 4.3 | 2% | 1% | 0.25 |
| Picovoice Porcupine | not run: no key can be had (below) | | | | | | |
| LiveKit WakeWord | not run for "Hey Opie": training needs a LiveKit Cloud account (below) | | | | | | |

"Across the room" is low for ours on purpose: since round 5 it wakes only for someone near and clear
(`docs/wake-word.md`, "Near and clear only"). The other engines weren't trained that way, so that column flatters them.

### The engines apart from the training: "Hey Jarvis"

Every engine has a "Hey Jarvis" model made by its own authors, so a "Hey Jarvis" set in the same rooms
(`scripts/wake/jarvis_set.py`: the 24 macOS voices, adults and children, three phrases, four rooms) compares the
engines when each is trained as well as its makers know how. Same 12 hours of other sound.

| "Hey Jarvis" model | threshold | up close | kitchen noise | across the room | TV or talk behind | false wakes an hour |
|---|---|---|---|---|---|---|
| openWakeWord `hey_jarvis_v0.1` | 0.5 (its default) | 9.7 | 8.5 | 7.2 | 6.9 | 0.42 |
| openWakeWord | 0.996 (one in 12 h) | 6.1 | 4.8 | 1.5 | 2.2 | 0.08 |
| microWakeWord `hey_jarvis` | 0.97 (its default) | 6.4 | 5.4 | 4.4 | 3.9 | 0 in 12 h |
| microWakeWord | 0.92 (one in 12 h) | 7.0 | 6.1 | 5.1 | 4.8 | 0.08 |
| LiveKit WakeWord `hey_jarvis` (v2.1.3) | 0.5 (its default) | 6.0 | 7.6 | 6.1 | 8.2 | 2.33 |
| LiveKit WakeWord | 0.645 (one in 12 h) | 4.2 | 5.5 | 4.2 | 6.4 | 0.08 |
| sherpa-onnx, threshold 0.1 | | 6.9 | 5.3 | 1.4 | 2.3 | 0 in 12 h |

Up close at one false wake in 12 hours, ours hears "Hey Opie" 8.8 times in 10; the best "Hey Jarvis" model hears its
own name 7.0 times. The phrases differ, so this isn't exact, but no engine's own model is clearly ahead of ours.
Across the room and over a TV, microWakeWord's and LiveKit's are better, which is ours being near-only by design.

### What each one costs and allows

| | model | CPU while listening (one thread, M4 Max) | memory | license | in an MIT app and the paid cloud | to switch |
|---|---|---|---|---|---|---|
| **ours** | 4.3 MB head + openWakeWord's 2.4 MB front end | 2.1% of a core | ~16 MB | ours (MIT); front end Apache-2.0; training data commercial-use (`docs/wake-word.md`) | yes | nothing |
| openWakeWord, standard recipe | 0.2 MB head + the same front end | about ours | about ours | code Apache-2.0; its negatives (ACAV100M features) CC-BY-NC-SA | the model, no: trained on non-commercial data | none: same listener, swap `opie.onnx` |
| microWakeWord | 60 KB (TFLite, int8) | 0.12% | ~3 MB | code and models Apache-2.0; its negative features (kahrendt/microwakeword) CC-BY-NC 4.0 | the model, no, for the same reason | a TFLite runtime and its micro front end in the shell (Kotlin, LiteRT) or a native addon for the bridge's Node; days |
| sherpa-onnx keyword spotter | 5.2 MB (zipformer, int8) | 1.1% | ~55 MB | code and weights Apache-2.0, but trained on GigaSpeech, whose audio is for non-commercial research (its card: models "may be eligible" for commercial use under fair use) | unclear: a question for a lawyer | `sherpa-onnx-node` in the bridge (we used it before voice set 3); a day; no training at all |
| LiveKit WakeWord | 7.4 MB (ONNX) | 4.7% via its Python client (its README: 1.65%, one thread) | ~30 MB | code and weights Apache-2.0 | yes, the ready-made ones; a "Hey Opie" model needs its TTS (below) | its JavaScript client runs in Node: about a day in `voice-worker.js` |
| Picovoice Porcupine | not measured | not measured | not measured | proprietary; needs an AccessKey checked online | only on an enterprise contract | its Android or Node SDK and a key on every tablet |

CPU is on the Mac, streamed 80 ms at a time as on the tablet; a tablet's cores are roughly two to four times slower,
so ours is about 5–8% of one core there (it is the listener's whole cost: the bridge's process is already running).
Memory is what loading the models added to the process.

## Each candidate

- **openWakeWord, the standard way.** Its own `train.py` with `examples/custom_model.yml` (10,000 clips of
  "hey opee" from Piper's LibriTTS-R generator, as its notes advise for a name Piper misreads; its adversarial
  phrases from CMUdict's "OW1 P IY2"; MIT room impulses; AudioSet backgrounds; all 2,000 hours of its ACAV100M
  negative features; its 32-wide DNN, 50,000 steps and auto-training). The notebook also mixes in an hour of FMA music;
  FMA is a 7 GB download behind a loading script, so a second AudioSet shard stood in. Run on the Mac in about
  45 minutes (most of it making clips). At its default threshold it wakes falsely 1.6 times an hour; held to one false
  wake in 12 hours it hears 5.5 in 10 up close, against ours' 8.8 at the same budget. That gap is what our rounds 2–6
  bought: more and different speech to ignore, cloned voices, hard rooms and mined mistakes (`docs/wake-word.md`).
- **microWakeWord** (ESPHome / Open Home Foundation). Its `basic_training_notebook.ipynb` as written, on the same
  10,000 clips, with its four negative feature sets (5.6 GB). Its authors say the notebook "will most likely not be
  usable", and it isn't: 9 false wakes an hour at 0.99, and a third of the bare "Opie" clips woke it. Four times
  the steps (40,000, the scaled-up recipe LiveKit's comparison used) cut that to 2 an hour, still with a third of the
  bare names waking it, and its int8 output tops out at 0.996, so no stricter threshold is left. Both models are
  60 KB. Its strength is size and CPU (made for ESP32s); the tablet doesn't need that.
- **sherpa-onnx keyword spotting** (k2-fsa). Open vocabulary: "HEY OPIE" written as its BPE tokens in four spellings
  ("Opie", "Opee", "Oh pee", "Oppy"), no training. It almost never wakes falsely (0–3 times in 12 hours at any setting),
  but hears "Hey Opie" only 6–7 times in 10 up close, against ours' 8.4. The only English model is the 3.3M GigaSpeech
  one from 2024 (a zh-en one came out in 2025-12). It's the fallback if we ever want a household to pick its own words.
- **Picovoice Porcupine.** Not tested. Picovoice ended its Free Tier on 2026-06-30 and disabled those AccessKeys, and
  says there's no personal or non-commercial plan: it sells to enterprises only, after a one-time trial they approve by
  hand. Usage is counted per monthly active device, and the SDK won't start without a key it checks online, so every
  tablet would need one, and a self-built tablet couldn't run it. Published prices (third-party, 2026-11): about
  $6,000 a year for the first paid plan, $30,000 for enterprise. Its engine is proprietary, so it can't be part of an
  open-source app. A key would need someone to apply for a trial as a company; nothing was signed up for.
- **LiveKit WakeWord** (livekit/livekit-wakeword, v2.1.3, 2026-11-17, Apache-2.0 code and weights): the one current
  engine with a strong claim. It started as an openWakeWord head (like ours) and now has its own pretrained encoder;
  its own benchmark (not checked here) has it at 89% heard at 0.5 false wakes an hour against openWakeWord's 46%.
  Its ready-made "Hey Jarvis" ran here (above): at one false wake in 12 h it hears less than openWakeWord's up close
  (4.2 against 6.1) and more across the room and over a TV (4.2 and 6.4 against 1.5 and 2.2). Training
  "Hey Opie" needs a LiveKit Cloud project: its TTS (LiveKit Inference) makes the clips, and part of its data is a
  gated Hugging Face dataset. Not done: it needs an account. What it would take: a LiveKit Cloud project's API key
  and secret, an accepted dataset licence on Hugging Face, and a GPU or an Apple-silicon Mac for about 20 minutes.
- **Others.** Snowboy (archived 2020, its model trainer gone) and Mycroft Precise (unmaintained since Mycroft closed
  in 2023) are dead. Howl and Raven are dead too. Sensory and DaVoice are closed, commercial SDKs like Porcupine.
  nanowakeword and ViolaWake are new single-author projects whose numbers are only their own.

## What we learned about our own bench

- **A clip's score depends on where it falls in the 80 ms step.** One "Hey Opie" across the room scored 0.003, 0.74,
  0.02 and 0.94 at offsets 20 ms apart; 6% of clips wake at some offsets and not others. `bench.mjs` streams the clips
  one after another through one listener, so each lands at whatever offset the last left. That's why its numbers in
  `docs/wake-word.md` (9.4 / 8.3 / 4.1 / 4.8 for round 6) are about a point above the ones here: here every clip starts
  from a fresh listener at four offsets and the share that woke is counted. Compare rounds with each other within one
  bench, not across the two.
- **False wakes need more than 12 hours to measure.** At these rates one false wake is 0.08 an hour; the engines
  above differ by one or two in 12 hours. The household's own wakes (opt-in clips, `docs/wake-word.md`) say more.

## Not done

- **A real room.** Everything here is the simulated microphone (`scripts/wake/bench.mjs`'s test set); the room test
  in `docs/hardware.md` needs a speaker, a tablet and a recording, and none was made.
- **A "Hey Opie" LiveKit model, and Porcupine at all:** both need an account (above).
- **The tablet itself:** CPU and memory were measured on the Mac, not on a tablet.

## Recommendation

Keep ours. Don't switch to Porcupine (no way to license it for an open-source app), to microWakeWord (made its
standard way it wakes falsely 2–9 times an hour, and the tablet doesn't need its size), or to sherpa-onnx (fewer heard), and don't retrain the standard
openWakeWord way (its negatives are non-commercial, and it hears less: 5.5 against 8.8 up close at the same
false wakes).

Borrow:

1. **LiveKit WakeWord's encoder.** Apache-2.0 weights, built for exactly this, and it runs in Node. Our training data
   (`scripts/wake/modal_app.py`: commercial-use speech, cloned voices, rooms) could train a head on its encoder in
   place of openWakeWord's. That's the next round worth trying; it needs no LiveKit account if we bring our own clips.
2. **The bench: score at several offsets** (`compare.py --phases 4`), so a round isn't judged on offset luck.
3. **microWakeWord's sliding-window average** (it averages the last five scores before a wake): one smooth step that
   could replace part of what the loudness floor does. Untested.

Not worth borrowing: either project's negative data (both non-commercial), or the standard recipes (both trained
here and both behind ours on the name and the near-misses).

## Reproducing

All outside the repo, in a scratch folder (`<w>`), with the test set from `scripts/wake/setup.sh` and `testset.py`.

```
uv venv -p 3.12 <w>/py && VIRTUAL_ENV=<w>/py uv pip install numpy scipy soundfile onnxruntime sherpa-onnx sentencepiece pymicro-wakeword livekit-wakeword pyarrow
python -I scripts/wake/compare.py --set <testset> --skip-voices <skip-kokoro-even.txt> --engine oww:<v-y2>/models/wake/opie.onnx --oww <oww dir> --out ours.json
python -I scripts/wake/compare.py ... --engine sherpa:<sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01>:0.15:2.0 --out sherpa.json
python -I scripts/wake/jarvis_set.py --testset <testset> --out <jarvis>
python -I scripts/wake/compare.py --set <jarvis> --engine mww:<pymicro_wakeword>/models/hey_jarvis.json --out j-mww.json   # and oww:, lk:, sherpa:...:<tokens>
python -I scripts/wake/summary.py ours.json@0.98,0.9 sherpa.json; python -I scripts/wake/summary.py --at-fph 0.1 ours.json
python -I scripts/wake/cost.py oww:<opie.onnx> --oww <oww dir> --audio <testset>/meeting.pcm --seconds 120
```

The two standard recipes: `oww_standard.py` (a Python 3.11 venv with torch 2.1.2, torchaudio, numpy<2, piper-tts
1.3.0, audiomentations 0.33, torch-audiomentations 0.11, openWakeWord and piper-sample-generator checkouts, and a
`generate_samples.py` shim that calls rhasspy's generator) and `mww_standard.py` (a venv with the micro-wake-word
checkout, `datasets<4` and tensorboard). Piper's clips are 22.05 kHz; openWakeWord's augmentation needs 16 kHz.
