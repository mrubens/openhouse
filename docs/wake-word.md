# The wake word: "Hey Opie"

Every household wakes the assistant the same way: **"Hey Opie"**. Since voice set 9 (2026-11-24) "Opie" on its own,
"Hi Opie" and "Okay Opie" don't wake it: two words are much harder to hear by mistake, and false wakes cost more trust
than saying "hey". (Before, any of them woke it.) It isn't a setting. The household record can still give the
assistant another display name, but the words it answers to can't change.

**"Hey Opie" or Tap to talk (2026-11-28).** Whether the wake word is used at all is the household's choice, one line on
the setup's last step and **Talk to Opie** in Settings → Opie (shown while the voice is on), or ask Opie (`hey_opie`).
The two are offered side by side, neither as the fallback. With **Tap to talk** the microphone is closed: the shell doesn't stream it to
the bridge, the wake model doesn't run, and the home screen's rail has a Talk button (always there, under the keyboard). A tap opens
a live session with its own microphone at once (no kept audio to catch up on), and when the session ends its page
goes, and the microphone with it. `MainActivity.micWanted()` is false while `heyOpie` is off; the bridge's
`/voice/wake` follows the choice too. Adjust to the room hears the room through the same stream, so with Tap to talk
it keeps the volume as set.

**Now (2026-11-20):** a small wake model listens all the time (`bridge/wake.js`, `models/wake/opie.onnx`), alone: a
score of at least 0.9 is its name (round 3's model, voice set 4), and the display hands the microphone to OpenAI's live voice, which hears the
request. It's the only speech model on the tablet: the speech model (Parakeet), the speaker model (TitaNet), the
keyword spotter, the voice detector (silero), the turn model (Smart Turn) and the voices (Kitten) are gone
(`docs/voice-models.md`, voice set 3). The microphone and the wake model
run only while Live voice is on (a wake word with no live voice has nothing to wake): with it off, or the tablet not linked,
nothing listens, and Settings shows Live voice: Off (Hey Opie only shows while it's on). There's no local fallback.

**Before:** the speech model (Parakeet) found the name. It transcribed every utterance in the room at its start
(1.0, 1.6 and 2.2 s in, then at the end) and looked for the ways it writes "Opie". It was slow, it ran Parakeet on
all the talk in the room, and it missed half the time.

**Against other engines (2026-11-27):** openWakeWord's and microWakeWord's standard recipes, sherpa-onnx's keyword
spotter, LiveKit WakeWord and Porcupine, on this test set: `docs/wake-eval.md`. Ours stays.

## Round 7 (2026-11-24): no better than round 6, not shipped

35,690 more "Hey Opie" clips said every way (`HEY` in `synth.py`), half child-like (said slower, then played faster:
higher pitch and resonances at the same pace), 1,279 from 120 cloned voices, and "hey" with other names as near-misses
(`HEY_NEAR`); y2's own mistakes on the bank (only 158 windows at 0.5 or more in 1,600 hours). Stages `r3 --stage hey7`,
`features7`, then `train` with `hey=1`. At 0.98, "Hey Opie" out of 10 (the test set's child-like voices apart):

| | adult up close | adult noisy | child up close | child noisy | false wakes in 12 h |
|---|---|---|---|---|---|
| **round 6 (y2, set 9)** | **9.7** | **8.4** | **8.8** | **8.3** | **1** |
| z3 (60k steps, 256) | 9.7 | 8.9 | 8.8 | 8.5 | 3 |
| z1 (45k steps, 256) | 8.9 | 8.2 | 8.3 | 8.3 | 1 |
| z2 (45k steps, 192) | 9.1 | 7.5 | 8.5 | 8.1 | 2 |

The child-like clips didn't lift the child-like test voices, and "hey" plus other names made it stricter on the name
itself. The next step is the household's own "Hey Opie" wakes (kept on the tablet, opt-in), not more synthetic voices.

## Results (2026-11-24, round 6: "Hey Opie" only)

Round 6 is on the tablet from voice set 9 (`models/wake/opie.onnx`, y2, 4.3 MB, width 256), at 0.98 with set 6's gain
and floor. It is round 5 (f3) trained with `hey=1`: the name clips that start with "hey" are the name, and the rest
("Opie.", "Opie, set a timer", "Hi Opie", "Okay Opie") are near-misses, from every pass. No new audio: the clips keep
their text. The test set's "Hey Opie" clips, out of 10, and how often its other name clips woke it:

| | up close | kitchen noise | across the room | TV or talk behind | "Opie" or "Hi Opie" woke | false wakes in 12 h | near-misses woke |
|---|---|---|---|---|---|---|---|
| round 5 (f3), 0.99 (set 8) | 9.8 | 9.1 | 3.6 | 5.3 | 79% | 5 | 33/384 |
| **round 6 (y2), 0.98** | **9.4** | **8.4** | **4.1** | **4.8** | **0%** | **1** | **15/384** |
| round 6, width 192 (y1), 0.98 | 9.3 | 8.5 | 3.9 | 4.9 | 0% | 3 | 16/384 |

On the training run's held-out sound y2 woke 0.07 times an hour (f3: 0.23). Replaying a home's first-day clips, every
false wake scored 0, every "Hey Opie" still woke, and the wakes said as "Opie" alone (most of the children's) didn't.

- **Train:** `r3 --stage train --names y2:1000:3000:45000:256:b0w+r2+s0w:0:smooth=0:pos_seeds=200:hey=1`.
- **The bench** keeps each clip's text (`scores.positives[].text`), so "Hey Opie" and the bare name can be scored apart.

## Results (2026-11-24, round 5: fewer false wakes, more misses)

Round 5 was on the tablet in voice set 8 (`models/wake/opie.onnx`, f3, 2.5 MB, width 192), at 0.99 with set 6's
gain and floor (set 7 had it at 0.98; 0.99 hears 9.1 up close and 8.2 in kitchen noise, with about a third fewer
false wakes again). It aims at false wakes and accepts more misses: a wake that wasn't wanted costs more trust than
saying the name twice. What changed from round 4:

- **Everyday sounds as negatives:** FSD50K (Zenodo 4060432; only its CC0 and CC-BY clips, 35k for training, 8.4k held
  out as `fsd-0`), banked like the speech (`r3 --stage data5`, then `bank --only fsd`), and round 4's mistakes on it
  mined (`mine --names s0w`).
- **The name only near and clear:** positives from a near-only pass (`featuresnear`, seed 200: louder, no far rooms,
  the listener's fixed gain), and `pos_seeds=200` trains on those alone.
- **False wakes weigh more:** neg weight 1000, hard 3000 (round 4: 300, 1000).

Same test set as round 4, at 0.98 (out of 10; false wakes as the bench counts them):

| | up close | kitchen noise | across the room | TV or talk behind | false wakes per hour | near-misses woke |
|---|---|---|---|---|---|---|
| round 4 (s0w, set 6) | 9.7 | 8.8 | 6.7 | 6.0 | 1.17 | 56/384 |
| **round 5 (f3)** | **9.3** | **8.4** | **2.6** | **4.3** | **0.50** | **36/384** |
| round 5, width 256 (f1) | 8.8 | 7.8 | 3.1 | 4.1 | 0.42 | 31/384 |
| round 5, weights 600/2000 (f2) | 9.6 | 8.4 | 3.4 | 4.3 | 0.67 | 38/384 |

On the training run's held-out sound (speech, meetings, everyday sounds) f3 woke 0.27 times an hour, against s0w's 0.83.
Replaying a home's first-day clips (kept on its tablet, opt-in), every false wake scored at most 0.03 with f3 (s0w: up
to 0.998), and every adult wake still woke. Across the room it now rarely wakes, as intended.

- **Train:** `r3 --stage train --names f3:1000:3000:45000:192:b0w+r2+s0w:0:smooth=0:pos_seeds=200`.
- **If it misses too often:** 0.98 in `opie.json` (set 7), no retraining.

## Results (2026-11-23, round 4: scores that spread)

Round 4 was on the tablet from voice set 5 to 6 (`models/wake/opie.onnx`, s0w, 4.3 MB, width 256), at 0.98. The threshold
now comes with the model (`models/wake/opie.json`), so a tablet never runs one round's model at another's threshold.

Round 3's labels were smoothed (the name's target was 0.95), so every score piled up between 0.90 and 0.98 and no
threshold could separate real wakes from false ones: at 0.95 it already missed a fifth of names said up close.
Round 4 trains without smoothing, adds 278 more cloned voices and round 3's mined mistakes (2,113 windows), and
spreads its scores up to 1. Out of 10 on the same test set; false wakes counted without the 1.5 s gap, so compare
the rows with each other, not with the tables below:

| | up close | kitchen noise | across the room | TV or talk behind | false wakes per hour |
|---|---|---|---|---|---|
| round 3 (r2), 0.9 | 9.5 | 9.0 | 8.0 | 6.1 | 1.7 |
| round 3 (r2), 0.95 | 8.0 | 7.4 | 6.1 | 4.3 | 0.7 |
| **round 4 (s0w), 0.98** | **9.7** | **8.9** | **8.2** | **6.1** | **1.1** |
| round 4 (s0w), 0.99 | 9.7 | 8.8 | 7.8 | 5.7 | 1.0 |
| round 4, width 192 (s0), 0.99 | 9.7 | 9.0 | 7.7 | 5.6 | 0.75 |

- **At home** round 3 at 0.9 woke 15–24 times a day, about three quarters of them false (each now silent, but it
  chimes). Round 4 at 0.98 should cut false wakes by about a third at the same hearing; at home that's untested.
- **Train:** `r3 --stage train --names s0w:300:1000:45000:256:b0w+r2:0:smooth=0` (key=value options after the spec).

## Near and clear only (voice set 6)

The tablet is meant to wake only for someone near it speaking clearly, not across the room. Round 4's listener turned
the microphone up to match the room (up to 32 times), so after a quiet minute a faint murmur sounded like someone next
to it: at home, half the false wakes on its first day were near-silent (their loudest moment 0.003–0.026 of full
scale), against 0.05–0.31 for every real wake. Since set 6, `models/wake/opie.json` sets a fixed gain (2) and a
loudness floor (0.03: a wake needs the microphone's loudest moment in the last 1.3 s, before the gain, to reach it).
Replaying that day's 15 clips: every adult wake still woke, and both false wakes the replay could reproduce didn't.
Loud false wakes (a sneeze and coughs, a child calling out, typing) need training, not a floor.

Since set 10 the floor is 0.01. On the Galaxy Tab A11 a person 1.5-2 m away peaks at 0.02-0.04 with the shell's gain
control alone (its noise suppressor and echo canceller blank the microphone in quiet spells and cut the first words after
them, so listening adds gain control only), and 0.03 blocked nearly every wake there. On the Tab S10 FE this lets back some
of the quieter false wakes set 6 stopped (0.01-0.026).

## Learning a home's own false wakes (opt-in)

A household can let its tablet keep a few seconds around each wake, so the wakes that weren't for it can be learned
from: `POST /voice/clips/setting {"on": true}` (off by default; off deletes them). Each wake keeps 2 s before it
reached the bridge to 1 s after, as streamed (16 kHz mono wav), in `voice-clips/` with when and how sure
(`clips.jsonl`). At most 300 clips, none older than 30 days; they never leave the tablet by themselves and aren't in
backups. `GET /voice/clips` lists them, `GET /voice/clips/<file>` reads one, `POST /voice/clips/clear` deletes them.
Whether a wake was real can be told from the speech log at the same moment (the live voice answered a request, or
closed silently with `go_away` or after its quiet time).

## Results (2026-11-20, round 3: 1,550 hours of ordinary speech)

Round 3 was on the tablet from voice set 4 (`models/wake/opie.onnx`, r2), at 0.9. Out of 10, the same test set as below:

| | up close | kitchen noise | across the room | TV or talk behind | false wakes per hour |
|---|---|---|---|---|---|
| round 2 (voice set 3), 0.9 | 8.9 | 8.6 | 8.2 | 6.0 | 2.7 |
| round 3, first try (b0w), 0.9 | 9.6 | 8.5 | 7.7 | 5.3 | 1.0 |
| round 3 (r2), 0.85 | 9.7 | 9.1 | 8.3 | 6.5 | 1.5 |
| **round 3 (r2), 0.9** | **9.5** | **8.9** | **8.0** | **6.1** | **1.2** |

- **At home it wakes far more than the bench says.** The first evening at 0.85 (2026-11-20, from 5 pm):
  19 wakes with nobody talking to it, 6 an hour at dinner; 8 of them scored 0.85–0.9. Back at 0.9 the next day. And
  a session its name opened now checks it was spoken to before it says anything: if not (other talk, the TV, its name
  inside someone else's sentence), it calls `go_away` and stays silent (`wakeNote` in `bridge/live-tools.js`,
  `/live/setup?how=wake`).
- **The silent check at home** (2026-11-21 to 23, 29 wakes): 22 false, and it stayed silent in all of them; 7 real
  requests answered. One false wake still got an answer: a cut-off sentence to someone else, transcribed as starting
  with its name, answered from an earlier conversation. Since then the check answers only a clear, finished request
  (or its name alone), and a session its name opened starts without the earlier conversation unless someone talked to
  it in the last two minutes. Each false wake still chimes.

- **What changed:** about 1,550 hours of commercial-use ordinary speech it learns to ignore (four times round 2's,
  from five sources: talks and podcasts, parliament, YouTube, earnings calls, audiobooks), and the name clips again
  in hard rooms (across the room half the time, always over something, often music or talk as loud as a TV).
- **What the extra speech did alone:** it halved false wakes, but the model then took any talk-like sound for "not the
  name", so it heard less across the room and over a TV (b0w). The hard-room clips won that back.
- **False wakes:** 1.5 an hour over 12 hours (round 2: 2.7). Sound-alike sentences wake it 65 times in 384, as
  before. The real voice's takes weren't run.
- **Size:** 2.4 MB (width 192), up from 1.1 MB.
- **Cost:** about $80 on Modal.

## Results (2026-11-20, round 2: the model alone, no speech check)

The on-device speech models are going away, so the wake model has to work alone: what it hears wakes the assistant,
and each false wake opens a paid live session. Out of 10 "Opie"s from voices it never trained on (macOS voices and
half of Kokoro's, adults and children), at the default threshold (0.9):

| | up close | kitchen noise | across the room | TV or talk behind | a real voice's takes | false wakes per hour |
|---|---|---|---|---|---|---|
| before: words only (Parakeet) | 6.8 | 5.5 | 4.2 | 2.3 | 10 of 28 | 0 |
| round 1 model + Parakeet's check | 7.5 | 5.7 | 4.9 | 1.9 | 16 of 28 | 0 |
| round 2 model alone (`opie.onnx`), old listener | 8.6 | 7.7 | 7.9 | 4.1 | 19 of 28 | 2.8 |
| **the same model, today's listener (no speech models)** | **8.9** | **8.6** | **8.2** | **6.0** | not run | **2.7** |
| same, threshold 0.5 | 9.2 | 8.3 | 8.8 | 4.9 | 22 of 28 | 6.4 |
| bigger, trained longer (v2a), 0.9 | 9.4 | 8.4 | 8.6 | 4.8 | 23 of 28 | 9.6 |

- **Today's listener** (no voice detector: the microphone's level is learned from the loud moments of the last
  minute) hears more than the old one with the same model, most of all with a TV behind (6.0 in 10, from 4.1).
- **False wakes** come from talk without the name: 2.6 an hour on audiobooks, 4.8 on meetings, none on music or
  household noise (12 hours in all; 4.4 and 3 with the old listener). Sound-alike sentences ("Okay, please pass the
  peas", "I hope he…") wake it 65 times in 384.
- **Inside someone else's talk** ("Hey Opie, …" said during a call or TV, the old `rollwake` bench): it woke for 1 of 6
  close up and 3 of 6 across the room at 0.5, with 5–7 false wakes an hour in 26 minutes of nonstop talk.
- **Time:** it fires as the name ends (median 50 ms before the end of the word).
- **What limits it:** the model learns its training speech too well. It barely fires on the 100 hours it trained
  against, but does on speech it hasn't heard. Longer training hears more and false-wakes more (v2a). Fewer false
  wakes need more *different* ordinary speech to learn from, not more rounds on the same. The next round needs more
  Modal budget than the Starter plan's limit (see below).
- Not compared: Picovoice Porcupine (no Picovoice key).

<details><summary>Round 1 (2026-11-19)</summary>

A small model (two dense layers) trained on Piper voices and 27 hours of speech, with Parakeet's reading as a second
check: 7.5 / 5.7 / 4.9 / 1.9 out of 10 and no false requests, but alone it would make 19 false requests an hour.
</details>

## How it works on the tablet

- **Features:** openWakeWord's front end (Apache-2.0, v0.5.1): every 80 ms, log-mel frames (`melspectrogram.onnx`)
  and one 96-number speech embedding (`embedding_model.onnx`) of the last 0.775 s. `bridge/wake.js` is
  openWakeWord's streaming code in JavaScript; `scripts/wake/check.mjs` checks it scores exactly as the Python the
  model was trained with (largest difference 0.0000 over a test clip).
- **Model:** `models/wake/opie.onnx` (ours, 2.4 MB): the last 16 embeddings (1.28 s) through a projection, three
  1-D convolutions, a GRU and attention pooling to one score (`Head2` in `scripts/wake/train.py`, width 192). It runs
  with `onnxruntime-node` in the listener process.
- **The listener** (`bridge/voice-worker.js`): the microphone brought up to a steady level (the loud moments of the
  last minute toward 0.3 of full scale, at most 32x, squashed so a near voice isn't clipped; the level is kept across
  restarts), then the model. A score of at least `VOICE_WAKE_THRESHOLD` (0.9) wakes it, once per name (1.5 s).
  Nothing is transcribed or kept.
- **Then** (`shell/…/Listening.kt`, `LiveVoice.kt`): the wake goes to the display (`/voice/events`), which stops the
  tablet's own speech, chimes and opens a live voice session at once. "Hey Opie, add milk to the list" said in one
  breath works: while the session connects (about 2 s), the tablet's own listening keeps the microphone and keeps what
  it hears, from 0.7 s before the wake model fired (in memory only). Once the session can hear (`session.started`),
  that goes first, played into the session's audio track (GPT-Live over WebRTC takes audio only on the track), brought
  up to a steady level, with each pause cut to 160 ms while it's behind so it catches up. Caught up, at a pause (or
  once the live voice starts talking, or 10 s on), the tablet lets go and the session's own microphone, with
  Chromium's echo cancelling, replaces the track. The log's `t+… ms` lines (`adb logcat -s LiveVoice`) time each step
  from the wake. While a session runs the tablet doesn't listen for its name; the live voice hears being talked over itself.
- **The microphone check** (Settings → Opie → Voice, Check the microphone, or `mic_check`; docs/settings.md): the
  shell opens the microphone and shows its level; the bridge's listener (`/voice/check`) keeps only each 0.1 s's peak
  (before the gain) and the model's best score, and a wake is the check's, not a conversation. Its verdict
  (`micVerdict`): heard; quiet (the loudest moment under the loudness floor, 0.01 without one); noisy (the room's 20th
  percentile at least a third of that peak); silent (exact zeros); unclear (loud and clear, not heard as its name).
  The shell adds what only it knows: not allowed, or another app has the microphone.
- **Counting false wakes:** each time it fires, the bridge keeps when and how sure (`voice-wakes.jsonl`, nothing heard
  or said). `GET /voice/wakes` gives them with the counts for the last hour and day; `POST /voice/wakes/clear`
  empties it. Compare the times with the live voice's conversations to tell real wakes from false ones.
- **Only with the live voice, and "Hey Opie":** `MainActivity.micWanted()` is the microphone switch, `heyOpie` and
  `LiveVoice.chosen`; the microphone stream stops and starts as the live voice or "Hey Opie" goes off and on, and the
  wake model is fetched only then.
- **A tap** on the assistant opens a live voice session too; without the live voice it opens typing. With Tap to talk
  the pill shows at rest, so there is something to tap. The typing box
  has no microphone now (dictating needed the speech model).
- **Shipping:** voice set 3 (`docs/voice-models.md`): the three files under `models/wake/`, with `onnxruntime-node`
  (linux-arm64 only). `scripts/voice-models.sh` fetches openWakeWord's two files and copies `opie.onnx` from this
  repo; `scripts/voice-bundle.sh` makes the set; `scripts/voice-install.sh` puts it on a debug build.

## How it was trained

On Modal (`scripts/wake/modal_app.py`, workspace openhouse-wake), from synthetic and public data whose licenses allow
commercial use. No household audio goes there, and only the model and its scores come back.

- **Voices saying it:** 29 Piper voice models (about 2,000 speakers: LibriTTS-R and LibriTTS, VCTK, ARCTIC,
  L2-ARCTIC's accented English and 22 others), half of Kokoro's 28 English voices, and about 240 voices cloned from
  LibriTTS-R speakers with Chatterbox (MIT; each cloned clip kept only if Parakeet hears the name in it: 2,655 of
  7,520). 273,000 training windows. Piper's phonemizer reads "Opie" as "oh-pie", so it's spelled as said
  ("Opee", "Ohpee"…); Kokoro gets "opie" added to its lexicon. Children: the voices pitched up and sped up.
- **Near-misses** from the same voices: "Okay", "Copy", "Obi", "Hoping", "Open", "Opal", "Toby", "Soapy"…
- **Rooms** (`scripts/wake/features.py`): reverb, distance and the tablet's quiet microphone, the listener's gain,
  kitchen and household noise (DEMAND), music and noise (MUSAN), other people talking, 12% as over a call.
- **Ordinary sound to ignore:** about 390 hours of speech (LibriSpeech dev/test-other and train-clean-360, AMI
  meetings; CC-BY 4.0) and MUSAN's music and noise (CC-BY 4.0), all in the same rooms, as 684,000 windows, plus
  24,000 hard negatives: moments earlier models took for the name. openWakeWord's 2,000 hours of negatives are
  non-commercial (CC-BY-NC-SA), so they aren't used.
- **Training:** weighted cross-entropy (a false wake costs 300 times a miss, a hard negative 1,000), labels smoothed
  by 5% so scores don't all pile up at 1.00; 30,000 steps (longer memorises the training speech).
- **Round 3** (`r3` in `modal_app.py`, a Modal workspace): a speech bank of ~1,550 h, each source's shard
  placed in rooms 20 s at a time and embedded on L4s (YODAS2 English, CC-BY 3.0; People's Speech clean, CC-BY;
  VoxPopuli English and accented English, CC0; Earnings-22, CC-BY-SA 4.0; LibriSpeech train-other-500, CC-BY 4.0;
  none gated). One shard of each is held out to count false wakes an hour per source. Training samples 6 million
  windows from it beside round 2's, mines what the first model took for the name (883 windows), and adds every
  name clip again in hard rooms (`features.place(hard=True)`). 45,000 steps, width 192, on an A100.
- **Cost (rounds 1–2):** $36.67 on Modal in all, inside the Starter plan's $42.50 limit. About $18 of it was one round-1 run whose
  process pool hung; the cloning and mining steps now have hard time limits.

## The test set

`scripts/wake/testset.py` builds it on the Mac; `scripts/wake/bench.mjs --set <dir>` runs it through the real
listener (`bridge/voice-worker.js`, the tablet's model), keeping every score to try thresholds afterwards.
`scripts/voice-replay.mjs` runs a test recording from a tablet (`scripts/voice-rec.sh`) through it again.

- **Positives:** macOS voices and Kokoro's voices, adults and children (pitched up): six phrases each ("Opie.",
  "Hey Opie.", "Hey Opie, what's the weather tomorrow?", "Opie, set a timer for ten minutes.", "Hey Opie, add milk
  to the shopping list.", "Hi Opie, what time is it?"). The spelling is picked per voice, by Parakeet reading
  "Opie." alone; nine voices that can't say it in any spelling are left out. Four rooms each: up close and quiet,
  kitchen noise 5–15 dB below the voice, across the room (reverb, the tablet's level, noise), music or other speech
  5–12 dB below. Kokoro's voices that Modal trained on are skipped (`--skip-voices`): 1,152 clips.
- **A real voice:** 7 takes, recorded on a Mac with the speaker's OK, kept there (not in the repo).
- **Near-misses:** 35 sentences that sound like the name.
- **Other sound:** 5 h of read speech (LibriSpeech test-clean), 4 h of meetings from a table microphone (AMI), 2 h of
  music with vocals (GTZAN), 1 h of household noise (DEMAND). None of it is used in training.

## Reproducing

```
MODAL_CONFIG_PATH=<config> modal run scripts/wake/modal_app.py::main --stage data      # public data onto the volume
... --stage voices      # the voices saying it (CPU containers)
... --stage features    # in rooms, as features
... --stage train --names nw300
... --stage harden --names nw300,h1000      # mine nw300's mistakes, train h1000 against them
... --stage harden --names h1000,g1000      # and again
... --stage data2 / clone / features2       # round 2: cloned voices, 360 h more speech
... --stage train2 --names v2d:300:1000:30000:128 --hard nw300,h1000,v2a
... ::r3 --stage bank --hours 20 / mine --names b0w --thr 0.5 / featureshard   # round 3
... ::r3 --stage train --names r2:300:1000:45000:192:b0w
modal volume get opie-wake models/r2.onnx models/wake/opie.onnx
scripts/wake/setup.sh                       # on the Mac: Python, the listener's models, the test set's sources
VOICE_DIR=<listener dir with models/wake/> node scripts/wake/bench.mjs --set <testset> --skip-voices <file>
```

`scripts/wake/{synth,build,train}.py` are the same steps for one machine (the first, slower version of this work).
