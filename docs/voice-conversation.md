# Talking to it like a person

> **Status (1.0.9):** superseded. pi is off the tablet; a conversation is OpenAI's live voice with the household's tools (docs/assistant.md). Kept for the measurements.

From trying Opie on a real tablet (2026-11-19): too many kinds of thinking indicators, and it didn't talk
naturally. The voice log at 18:31 UTC showed first sound 10.5 s and 6.8 s after the request (about 1.2 s of that
was hearing and speaking), every "Hey Opie" starting a new conversation, and answers of several written sentences.

## Speed: spoken turns on a fast model

- A spoken turn switches the conversation's running pi to the provider's fast model with pi's `set_model`. It's the
  same pi and the same session, so the conversation carries on (`agents/boxed.js` `piUse`).
- The fast models are in `agents/model.js` (`piVoiceModel`): `claude-code/claude-sonnet-5-5` and
  `openrouter/anthropic/claude-sonnet-5.5`. ChatGPT stays on its own model. To override, put `"pi-voice"` in the
  model file (a model of the chosen provider, or `"same"`), or set `PI_VOICE_MODEL`.
- These stay on the family's own model (Opus 5.5 by default): typed turns, making or changing an app or game, and
  "think harder" (`chat.js` `wantsDepth`).
- If pi doesn't have the fast model, it asks once and logs it; that pi then stays on its own model.
- Saying its name also switches the waiting pi ahead of time (`prewarm`).

Measured on the laptop through `claude -p`, with the family's rules (45 KB) and the new spoken rules:

| | first words, cold | first words, warm (same process) |
| --- | --- | --- |
| Haiku 5.5 | 4.3 to 8.5 s | 1.4 to 2.7 s |
| Sonnet 5.5 | | 1.2 to 1.7 s |
| Opus 5.5 | 3.9 to 4.8 s | |

The model is only part of the time. A cold Claude Code process (a new conversation, or more than 5 minutes since
the last turn: pi-claude-code's limit) costs seconds on its own. Haiku made up what tools would have said, so it
isn't used.

## Conversation: a wake carries on

- `Conversations.kt`: a wake counts as "someone else" only when both voices are known and differ.
- In the tablet's log the speaker was only guessed (`who: null`, `guess: "Sam"`, score 0.64 to 0.67, under the
  0.68 bar), and a null voice counted as someone else. So every wake started over, and with it a cold process.
- A wake within 5 minutes of the last answer now continues the conversation, so "and tomorrow?" works. The bridge
  prewarms the same conversation within the same 5 minutes.

## How it talks

- `CHAT.md` tells it to talk, not write: answer first and stop, one or two short sentences, no lists or written
  phrasing, at most one question back, and no "I'll check" preface when no tool is needed.
- Every spoken request ends with a short reminder of this (`chat.js` `SPOKEN`), so it's the last thing the model
  reads.
- How loud: the household's volume (Settings → Screen → Volume, the keys, the `volume` tool) is the normal level, for music,
  Opie and the timers alike. With Adjust to the room on (the default), Opie and a timer's ring are fitted to the room
  as they start, never in the middle (`ui/RoomVolume.kt`): about 3 dB under the normal level in a quiet room, up to
  9 dB over it in a noisy one, and 6 dB under in the night hours. The room is the level of the microphone that listens
  for its name (the level only, nothing recorded or kept but a minute of numbers), measured only while the tablet
  itself plays nothing, as its noise floor against this room's own usual quiet, so no tablet needs tuning. Music isn't
  touched. Without the live voice there's no microphone, so only the night hours change it.

## One indicator

The assistant's button (`Buddy.kt`, `Face`) is the only thing that shows its state. Each state has its own color and
one thing moving, so it reads from across the room:

- **Listening:** dark, its bars standing low in an arc and rising with their voice. Your turn.
- **Thinking:** light, a row of dots with a ripple running through it. On it. (Dots, never bars, so it can't be taken
  for listening; a row of dots while listening read as thinking.)
- **Talking:** the accent color, its bars moving with its voice. Its turn.
- At rest it isn't shown.

With the live voice, the state comes from what is really happening (`chat/live/live-session.cjs`, `look()`), not from
the timing of its words, which run seconds ahead of its voice: talking while its voice plays (held through a breath
between sentences), thinking while a request is being worked on (its text model, the household's tools) until its
answer is heard, listening otherwise. Before, it went back to listening while it was still working ("one sec", then
the tools ran) and before it had finished speaking.

If the live voice can't connect, or ends before it answered, a card on Home says so (it did only over other apps;
on Home the button just went away).

Hearing now looks like listening, working looks like thinking, and finished answers no longer have a look of their
own.

These are gone:
- the dots above the button
- the dots and italic "Searching…" status in the caption
- the "Got it, next" line and the thought text in the bubble over other apps
- the card of dots in the conversation screen (the button shows thinking there too)

Captions are only words: what they're saying, along the bottom, and what it says while it talks. Over other apps,
the bubble still shows what it's doing in that app, with Stop.

Tried on an emulator against a bridge with the fake agent and injected "heard" events:
- While it thinks, only the dark button shows.
- While it talks, the button is the accent color and its words show above it.
- A second wake 15 s later, with the speaker only guessed, logged "(follow-up)" in the same conversation.

## Not done

- **Starting the model while the end of speech is still being confirmed.** That is the listening pipeline
  (`voice-worker.js`), which the cloud-voice work owns. What's here is safe without it: the wake switches the pi
  ahead of time.
- **Keeping a Claude Code process warm for the next new conversation.** pi-claude-code starts one at the first
  request. Fixing that needs a change upstream.
- **Not yet measured on the tablet with a real model.**
