# The assistant, with no agent on the tablet

Since 1.0.9 there is no coding agent on the tablet: no pi, no agent app, no AI sign-in. Making our own harness is a losing
game, so the tablet does without one and the rough edges get fixed instead.

## Who does what

| What | Who | Where |
|---|---|---|
| Talking ("Opie, …") | OpenAI's live voice (gpt-live) with the household's tools | `shell/…/LiveVoice.kt`, `bridge/live-tools.js`, the cloud's `/v1/voice/live/start` |
| Typed turns, getting to know the family, a flyer or a recipe photo, the Meals buttons, refitting a resized note, the board | OpenAI's text model (gpt-6-luna) through the cloud (`/v1/ai/respond`), routed first by Decisions (`/v1/decide`) | `bridge/agents/cloud.js`, `bridge/chat.js` (`textTools`, `callText`, `textInstructions`), `bridge/house.js` (`answer`) |
| The heartbeat | checks on the tablet, Decisions to judge at once, the text model for a note, and an hourly review on OpenAI's Flex tier | `bridge/heartbeat*.js`, docs/heartbeat.md |
| Making and changing apps, and fixing one the heartbeat found broken | the household's own Claude Code, Claude Desktop or Codex on a computer, through the workshop | `bridge/workshop.js`, `connect/`, docs/workshop-mcp.md |

Both cloud paths need the tablet linked to a family account and OpenAI chosen (Settings → Live voice); the
bridge's `agentName()` is then `cloud`. Otherwise it's `none` (`agents/none.js`): a typed turn says how someone
turns it on, and the apps hide what needs it (`/house` `ai: false`). Safe mode is `off`.

**The household's own OpenAI key** (`own`): for a tablet without Opie's cloud voice (not linked, or not let in
yet), the first setup's **Set up Opie's AI** step, or Settings → Voice. The key is pasted on the phone or computer
connected for the setup (the box opens there as the step shows: `chat/src/phone.jsx` `AddKey`, sealed on the home
Wi-Fi to the bridge's `/setup/openai`, passed straight on to the shell and never written or logged), or pasted on the
tablet with a keyboard cover. The shell (`shell/…/OwnKey.kt`) checks it with one free call (the list of models: a
wrong key, a key without access and an account out of credit each get their own words), asks for the PIN first when
the lock is on, keeps it sealed in its no-backup files with a keystore key, and tells the bridge only that one is in
(`POST /cloud/own {on}`, which refuses anything else in the body). The voice comes on with the key (it's the
household's yes to OpenAI on their own account) and goes with it when there's no account to fall back on.

`agentName()` is then `own`: the same assistant, with `ai`, `decide` and the live start built by
`bridge/own-openai.js` (the cloud's own requests, models, live prompts and search words, moved here 2026-11-26) and
sent through the shell's route (`DeviceServer` `/openai`), which adds the key and reaches only three fixed paths at
api.openai.com (`/v1/live/sessions`, `/v1/responses`, `/v1/decisions`). Opie's cloud is never asked while a key is in,
and nothing is counted here: OpenAI bills the household, and a budget on the key at OpenAI is the stop.

## In this home

Everyone in the house may be listening, kids included, and Opie can't tell who is talking (voices aren't recognised;
a name comes only with a turn from that person's own phone). So the instructions both models get (bridge/CHAT.md,
**IN THIS HOME**, in the typed turns' and the live voice's alike) shape every answer as if a kid may be listening: no
sexual content, graphic violence or instructions for anything dangerous or illegal; sensitive questions (sex, death,
scary news, self-harm) answered gently and honestly, with a suggestion to talk with an adult at home, and danger right
now pointed to an adult and 911; health, legal and money questions given general information and a suggestion to ask a
professional. Everything else (trivia, homework, stories, jokes, recipes) gets full help. It's judged by the model with
the whole conversation, never by word lists, and Opie doesn't mention or announce any of it: it just answers that way,
or gently steers.

**House rules** (Settings → Voice → House rules; Opie's `house_rules`): the household's own few lines, empty by default.
They come right after the defaults in every conversation's instructions (bridge/house-rules.js `rulesBlock`, through
chat.js `prefsBlock`) and loosen or tighten them ("Adults use this too; the news is fine to talk about."). Something
someone asks Opie to remember doesn't change the defaults; only the house rules do, and changing them is always a person's
yes on the tablet, with the PIN when one is set (docs/settings.md).

## A typed turn

- The tools: the live voice's (`LIVE_TOOLS`, the weather, the TV, the apps' voice actions) plus `update_household`,
  `forget_preference`, `set_home`, `move_on_home`, `put_back`, `list_changes`, `undo_change`, `end_conversation`,
  `add_calendar`, `add_photo_album`. Never an app's files: no `start_editing`, `check_build`.
- Each tool runs as part of the turn (its home-screen token): notes it puts up come back with the answer, `set_home` and
  `undo_change` hold the turn's edit lock, `end_conversation` ends it.
- The conversation's last 12 turns go with each request (the model keeps nothing between turns).
- "Make me a game" is answered at once, with no model turn: apps are made from a computer (`NEEDS_COMPUTER`). So is
  POST /request (the builder), which a tablet with no agent never runs.
- Getting to know you (`onboard: true`) and background turns (refit, the board) skip the routing question.

## A flyer or a recipe photo

The photo goes to the text model with the request as an `input_image` (no tool call), and the answer is the events
(or the recipe) as before. The `flyer_photo` tool stays for the live voice and a computer.

## Existing tablets

An update to 1.0.9 (`OldAgent.kt`) removes the old agent's app and its data once the bridge has answered, and the
files the display kept for it (`agent-box.json`, its status, `agent-model.json`). Nothing of the household's was in
it: the chats, apps and household live in the display's own folder and stay, so the chats stay readable. `start.sh`
removes pi, SearXNG and Claude Code's leftovers from a runtime unpacked from an older image.

## What it can't do now

- Change an app's code from the tablet (by design: a computer does).
- The home tools (`mcp__home__*`) were the agent's: the live voice has the TV; the rest has no caller on the tablet
  now. Other Android apps came back on 2026-11-20 as the voice's and typed turns' own tools (open, install, look, tap,
  type, scroll), with "Opie uses apps" on in Settings: docs/device-control.md.
- Web search: pi's (SearXNG) is gone with it. The live voice's text model has OpenAI's own web search (the service the
  family chose; the cloud adds it when a session starts): directions, travel times (typical, no live traffic), when to
  leave, opening hours. Typed turns answer from what they know.
- The speech log (Settings → Speech log, on the tablet only) has each live conversation's words: what it heard
  (`live-heard`), what it said (`live-said`) and the tools its text model used (`live-tool`).
- **Memory**, all on the tablet (and in its backups), going to OpenAI only as context. It belongs to the household,
  not to whoever is talking (voices aren't recognised).
  - What lasts: facts and how they like things ("Leo is allergic to peanuts", "soccer is at Fuller Park", "shorter
    answers"), saved when they say "remember..." or it's clearly lasting, dropped on "forget that"
    (`remember_preference` / `forget_preference`, preferences.md). In every conversation's instructions.
  - Each day in a few lines, for a week (bridge/days.js, chats/days.json): what was said is written to
    chats/talk/<day>.jsonl as it happens, and about once an hour, when there's more, the text model on the Flex tier
    rewrites that day's lines (its cost is in chats.jsonl, `background: "days"`). A day's talk is deleted once it's two
    days old and summed up. Conversations get today's lines and one line for each day before.
  - Settings: `GET /memory` gives `{remembered: [sentences], days: [{day, text}]}`; `POST /memory/forget` with
    `{text}` (a remembered sentence, as listed) or `{day}` takes one out.
- What was said lately, by voice or typed, and what the household's tools found, is also kept by the bridge in memory
  for half an hour, word for word (bridge/live-tools.js `recentTalk`). A new live conversation starts with it (as
  OpenAI's session `input`, and in its text model's instructions), and so does a new typed conversation, so "the event
  we just talked about" still means something.
