# The heartbeat

The tablet regularly checks in on things and quietly takes care of them. The heartbeat still matters,
and the coding harness (pi) is off the tablet since 1.0.9 (docs/assistant.md). Since 2026-11-19 the heartbeat
hasn't needed it:

- **Checks** stay on the tablet, as code, and apps (plugins included) can declare their own, as data.
- **Judgment** goes to a decision model: OpenAI's Decisions API with `gpt-6-luna`, through our cloud
  (`POST /v1/decide`), or later the household's own key.
- **Things on Today, not notes** (since 1.0.12): a cheap text model puts one short line on Today's strip. Each line
  has its own end and comes down once what it's about is sorted, in plain code. See "Things on Today" below.
- **Fixing an app** goes to whoever builds. The fix waits for the household's Claude or Codex in the workshop, goes in
  behind the PIN card, and is one undo.
- **The hourly review:** once an hour in waking hours, the text model (on OpenAI's Flex tier) looks at today and
  tomorrow and does at most one small thing, usually nothing (section 6).
- **No fallback:** with no judge (not linked, OpenAI not chosen, or the service down) the checks and the tidying still
  run, and nothing is judged.

Code:
- `bridge/heartbeat.js`: the checks, the rules, and choosing a path.
- `bridge/heartbeat-judge.js`: the questions, the answers and the note writer.
- `bridge/heartbeat-checks.js`: the checks apps declare.
- `bridge/heartbeat-fixes.js`: fixes waiting for whoever builds.
- `bridge/workshop.js`: `start_editing {fix}` and the PIN card.
- `bridge/HEARTBEAT.md`: what the agent is told (fallback only).
- `shell/.../ui/Heartbeat.kt`: the Settings sheet.

Tests: `bridge/test/heartbeat-judge.test.mjs` covers the judge's path, app checks, the fix queue and the workshop,
with the decision and text models stubbed. `bridge/test/heartbeat.test.mjs` covers the checks and the agent's path.

## Things on Today (since 1.0.12)

Reminders and suggestions belong with the countdown, and should disappear when they're no longer relevant. So the heartbeat no longer writes notes. It writes **things**, one line
each, on a short strip where the countdown was: under the calendar on Today (beside the title when there's no
Calendar tab), and on the resting screen. At most 3 show, most urgent first. `bridge/things.js`, `things.json` next
to the chats.

| Kind | Example | Comes from | Gone when |
|---|---|---|---|
| Reminder | "Swim in 15 minutes" | an event's reminder (house.js) | ten minutes after it starts, or put away |
| Suggestion | "Leave by 4:50 for Ducks at MSU", "Nothing planned for dinner" | the heartbeat or the hourly review (`show_thing`) | its `until` passes (a day at most), or the finding behind it goes away |
| Countdown | "Trip to Chicago in 4 days" | an event marked to count down | it starts. Never a daily or weekly event; monthly and yearly still count |
| Broken app | "Drawing has a problem: ask Claude or ChatGPT to fix it" | a crash the judge thought worth it (written in code, no text model) | its fix is closed, or with none queued, the app stops failing |

Opie takes one down when asked ("got it", "take that down": `take_down_thing`, by id or words). A tap on a line
offers "Take down". A reminder taken down is put away on every screen. A countdown or a broken app taken down is only
hidden from the strip; the countdown and the fix stay. The Right now snapshot (voice and typed) and the hourly review
both list the things with their ids.

- `house.view().things`: what the strip shows (`[{id, kind, text, start?, until?}]`).
- `POST /house/thing {take: id}`: one taken down.
- Notes the heartbeat put up before 1.0.12 still come down once their finding is gone.

## 1. Checks, every 5 minutes, no AI

Code in the bridge looks at what it already has and writes down anything worth a look. Each finding has a stable
key, so the same thing isn't found twice.

| Check | Finds | Key | Level |
|---|---|---|---|
| Calendar overlap | two timed events for the same person that overlap, in the next 2 days | `conflict:<ids>` | notice |
| App crash | an app's page reported errors in the last hour (`POST /apperror`) | `crash:<app>` | notice |
| Calendar sync | a calendar couldn't be read, or nothing came from the shell for 2 hours | `sync:<calendar>` | notice |
| Dinner | after 3 PM, nothing planned for dinner, in a household that plans meals (some in the last 2 weeks) | `dinner:<day>` | tidy |
| Morning | from the night's end until 10, today has timed events (a prep note, only if there's something to get ready) | `morning:<day>` | tidy |
| Storage | under 1 GB free | `storage` | notice |
| An app's own | what its app.json declares (below) | `app:<app>:<id>` | notice or tidy |

Not yet, because each needs a signal the bridge doesn't have: Wi-Fi drops, backups that didn't run, updates waiting.

### Checks from apps and plugins (data only)

An app declares checks in its `app.json`, like its voice actions. The bridge reads the JSON and runs the test
itself, so nothing from a plugin ever runs as code.

```json
"checks": [{
  "id": "no-chores-3d",
  "text": "No chores checked off in 3 days",
  "level": "notice",
  "source": { "data": "progress" },
  "path": "last",
  "test": "older_than", "hours": 72,
  "for": "Leo"
}]
```

- **source**: either the app's own saved things (`{"data": name}`, what it saves with `/appdata/<name>`), or a key
  of the house's data (`{"house": "meals"}`). A plugin's app may only use keys its `uses` groups let it see
  (`houseFor`).
- **path**: dots into it. `{today}` becomes today's date (`meals` with `{today}.dinner`).
- **test**: one of
  - `missing`
  - `empty`
  - `older_than` (`hours`; the value is a date or a time in seconds or ms)
  - `count_below` or `count_above` (`n`)
  - `equals` or `not_equals` (`value`)
- Optional: `after` and `before` (HH:MM), and `for` (who it's about).
- No count limit of ours. A check that doesn't fit is left out, and `GET /heartbeat` lists why under `checkProblems`.
- **Where they're read from** (every app is a plugin, docs/plugins.md §11):
  - The household's own apps and OpenHouse's are read live from `app.json`.
  - An app from a link keeps the checks its card showed. The card says "it looks out for: …". They're fixed when
    it's added (`webapp/plugins/<name>.json`, `apps.<id>.checks`, `plugins.checksOf`), so editing its app.json can't
    add one. Checks that don't fit are left out, with a note on the card.
- Nothing saved yet isn't a problem: a test other than `missing` doesn't fire on a source that isn't there.

## 2. Tidying, no AI

A thing the heartbeat put up about a finding comes down by itself once the finding goes away: the clash was moved,
the app works again, dinner got planned. This happens at **Tidy up** and above, only for its own (`things.settle`), and
is logged as "Took down a thing on Today about something that's sorted". Each also has its `until`, so it ends anyway.

## 3. Judging: the decision model

**When:** as soon as a check finds something new, at the next 5-minute beat, not just hourly. It's cheap, so the
limits are rates, not the hour:

| Limit (judge path) | Value |
|---|---|
| Judgments an hour | 6 ("Check now" isn't held by this) |
| Judgments a day | 48 |
| Text-model notes a day | 12 runs, and at most 3 notes put up |
| Spending a day | $0.05 |

**One call per beat:** `POST /v1/decide` (cloud.js `decide()`), with up to 8 findings numbered in the input and three
typed questions for each:

| Question | Type | Answers |
|---|---|---|
| `worth_<n>`: worth doing something about now, for a household that wants a calm screen? | predicate | a probability; under 0.6 it's left alone |
| `act_<n>`: what would help most? | choice | `notice` (a new note), `tidy` (update the note that's already about it), `fix` (an app's code needs fixing) |
| `for_<n>`: who is it for? | choice | each household member by name, `household` or `everyone` (left out when the household has no names) |

The input also holds the time, the household (`board.household()`) and the notes on Today now.

**What the level allows**, whatever the model says:
- `fix` becomes a waiting fix only at **Fix things**, and only for a crash. Otherwise it's a note.
- `tidy` at **Notice only** is a note, if the text model finds none that says it already.

A judged finding isn't judged again. One that goes away and comes back is new.

**Where it comes from (`judge` in heartbeat.js):**
- Today: our cloud, when the tablet is linked and the household chose OpenAI in Better voice (`cloud.liveOn()`).
  That's the same agreement and allowance as the voice, since the service counts every decide and text call.
- Later: the household's own OpenAI key, which the shell holds (`/openai/decide` and `/openai/respond` in
  openhouse-cloud/docs/cloud-beta.md). It plugs into the same `{ ready, decide, ai }`. Not built.

## 4. A line on Today: the text model

For each finding worth it (but a crash: that line is written in code), `writeNote` (heartbeat-judge.js) runs the
cloud's text model (`POST /v1/ai/respond`, `gpt-6-luna`).
- **Instructions:** short rules per kind (`NOTE_RULES`), plus `DOOR.md` and the household's preferences.
- **Tools:** cut to the level, refused in code (`thingCall`), not by the prompt.
  - **Notice only:** `show_thing`, `family_things`, `about_household`.
  - **Tidy up** and **Fix things:** those, plus `take_down_thing` (its own only).
  - Never notes, apps, the home screen, devices, the calendar or speaking.
- **Limits:** at most 4 steps, and 3 new lines a day (the 4th `show_thing` is refused). The same words, or the same
  finding, change its line instead of adding one.

## 5. Fixing an app: it waits for whoever builds

Apps are plugins now, so the heartbeat doesn't change an app's code itself (on the judge path). At **Fix things**,
when the judge says `fix` for a crash:

1. **Queued:** `heartbeat-fixes.json`, one fix per app. It holds the errors, the page's log (the last 20) and the
   app's recent changes. The same app breaking again adds to it.
2. **Today says so:** "Chores has a problem: ask Claude or ChatGPT to fix it", while the fix waits.
3. **The workshop sees it.** `pending_fixes` is a door tool, so the paired computer's Claude or Codex gets it
   through the workshop MCP. WORKSHOP.md and the server's instructions tell it to mention waiting fixes. `close_fix`
   closes one as `done` or `dismissed`.
4. **The fix is an ordinary change:** `start_editing {what, fix: <id>}`, then edit, `check_build`, `done_editing`.
5. **Behind the PIN card:** `done_editing` on a fix asks the tablet "Put in the fix for Chores?" with the PIN.
   - **Yes:** one commit, one undo, and the fix is marked `done` with its sha.
   - **No, or no answer:** the files are put back, and the fix waits again.
   - A fix left open isn't put in by the idle timer, as other changes are. It's put back out.
   - With no shell (a laptop bench), there's no card and it goes in.

**Later, a cloud agent path (designed, not built):**
- A household with no computer could let our cloud fix it: a coding model (Claude or Codex on our account, within
  the allowance) gets the same fix (errors, log, the app's files read through a sealed relay call). It returns a patch.
- The tablet applies the patch as a change and shows the same PIN card. It's one undo.
- The workshop's tools are the contract either way, so this is a second client of `pending_fixes`, not new tools.
- Needs: an OK to send an app's code to a model on our account (the household opts in), and a price.

## 6. The hourly review (since 1.0.9)

The old fallback was an hourly turn of the tablet's own agent (pi), which is gone. In its place, once an hour, the
cloud's text model looks at the day. Code: `bridge/heartbeat-review.js`, `reviewNow` in `bridge/heartbeat.js`; tests in
`bridge/test/heartbeat-judge.test.mjs`.

- **When:** at most once an hour, in waking hours, never at night, in Sleep now, or while someone's using the tablet (a
  conversation, a change being made). Off means off. At most 16 a day and $0.05 a day.
- **What it sees:** a compact snapshot. That's the time, the household, today's and tomorrow's calendar, the lists'
  open items, chores, today's and tomorrow's meals, the notes and the things on Today, and whatever the checks found that nobody has
  looked at yet.
- **What it may do:** at most one small thing, or nothing (the rules say most hours it's nothing). It can put up a
  line on Today (`show_thing`), take down one of its own, or (at Fix things, for an app the checks found crashing) `queue_fix`,
  which waits for whoever builds. A second write is refused in code.
- **Its tools:** what the level allows (show_thing, family_things, about_household; take_down_thing at Tidy up),
  plus `queue_fix`. The voice's writing tools (lists, calendar, chores,
  meals) aren't among them: the background never changes the household's own data.
- **Same rules as before:** the levels, 3 new lines a day across the judge and the review, and never aloud.
- **The instant findings don't wait for it:** the decision model still judges a crash or a broken calendar as soon as a
  check fires, on the standard tier. The review runs after it in the same beat.
- **Flex:** the review asks for OpenAI's Flex processing (`tier: "flex"` on `/v1/ai/respond`, which the service turns
  into `service_tier: "flex"`). OpenAI's pricing page lists Flex for gpt-6-luna at $0.05 in, $0.005 cached and $0.25 out
  per million tokens, half the standard $0.10 / $0.01 / $0.50. A busy Flex answers 429 Resource Unavailable, which
  isn't charged. The tablet then skips that hour and doesn't retry on the standard tier. *The service side is the cloud
  session's to add.* Until it ships, the field is ignored and the review runs at standard rates; the log says which tier
  ran (`tier` in the review's entry and in chats.jsonl).
- **Logged per run:** input, cached and output tokens, the tier, and the cost (chats.jsonl, `path: "review"`;
  heartbeat.json's log). `today().reviewCost` is the day's spend.

**Cost per household-day (estimated, 2026-11-20).** A review's first call is about 1,550 tokens in: the rules and
DOOR.md about 740, the snapshot of a busy household about 300, the tools about 510. That's from the text's length;
the real counts are logged per run. A quiet hour is one call. An hour that does something is about three calls and
5,250 tokens in. With 14 waking hours, 2 of them doing something:

| | per quiet hour | per busy hour | per household-day | per month |
|---|---|---|---|---|
| Standard tier, no caching | $0.00016 | $0.00065 | about $0.0033 | about $0.10 |
| Flex, no caching | $0.00008 | $0.00033 | about $0.0016 | about $0.05 |
| Flex, 75% of the input cached | $0.00003 | $0.00015 | about $0.0006 | about $0.02 |

The decision model's instant judgments come on top: about $0.001 a busy day (section 3).

## 7. No judge

The tablet's own agent (pi) was the fallback until 1.0.9; it's gone. With no judge (unlinked, over the allowance, the
service down) the checks still run, notes about what's sorted still come down, and Settings shows what they found.
"Check now" says "It found things but has nothing to judge them with".

## Levels: one setting, four (unchanged)

Its level, how often the review runs (30, 60, 120 or 240 minutes) and its prompt: Settings, Advanced, Check-ins, or Opie's `heartbeat_settings` tool (`POST /heartbeat/settings`):

| Level | Checks | It may |
|---|---|---|
| **Off** | don't run | nothing |
| **Notice only** | run | a quiet note on Today about a problem |
| **Tidy up** (default) | run | that, plus nudges (dinner, morning), updating its notes, and taking them down once sorted |
| **Fix things** | run | that, plus fixing a broken app: queued for whoever builds (judge path), or by the agent (fallback) |

## Rules (both paths)

- **It never speaks.** Nothing it writes is said aloud, and neither model gets a speaking tool.
- **Nothing at night or in Sleep now.** Night hours are the household's (9:30 PM to 6:30 AM unless changed through the bridge, `POST /house/settings`). Sleep now
  (`POST /heartbeat/sleep`) holds until morning or until someone talks to the assistant. The checks still run, so
  the morning sees what happened overnight.
- **Not while someone's using it:** not during a conversation or an open change.
- **Household data only goes to services the household chose.** The judge path runs only when they chose OpenAI
  (Better voice). The agent path uses the agent they signed in.
- **Everything is logged.** "Done in the background" lists each run. A log entry now has `path` (`judge`, `agent`
  or `code`) and, for the judge, `judged`: each finding's worth, act, who and what was done.
- Each run is logged in `chats.jsonl` (`background: "heartbeat"`), with its cost (the judge's is estimated from
  `gpt-6-luna`'s prices), so a restart doesn't reset the caps.

## Cost (judge path, estimated; not measured on a tablet)

- A judgment: about 1,500–2,500 input tokens at $0.10 per million, about $0.0002. Decisions output is free.
- A note: 2–3 text-model steps of about 3,000 tokens in and 50–100 out, about $0.001–0.002.
- A busy day (5 judgments, 2 notes) is about $0.005. A household-month is about $0.15, inside the household's
  allowance. At every cap, a day is about $0.03 (the $0.05 cap leaves room).
- The agent path, for comparison: $0.02 a note and $0.18 a fix.

## Tried on the emulator (2026-11-19, the old agent path, gone since 1.0.9; Claude Opus 5.5 over OpenRouter)

| What | Level | What it did | Cost |
|---|---|---|---|
| Nothing new | Tidy up | no AI turn; "Check now" says "Nothing new to look at." | $0 |
| Sarah's haircut 10-11 and book club 10:30 Friday | Tidy up | one note for Sarah | $0.02 |
| Candy Bounce throwing `ReferenceError: title is not defined` | Tidy up | a note: "Candy Bounce isn't working right now." | $0.02 |
| The same crash | Fix things | fixed the one broken line, as "Fix candy-bounce (in the background)" (undo takes it back) | $0.18 |

The judge path hasn't been tried against the real service yet. It needs the cloud deployed with Decisions (the
user's call) and a linked tablet with OpenAI chosen.

## The bridge's routes

- `GET /heartbeat`: `{ level, path, findings, log, today: { notes, runs, judgments, cost }, caps, asleep, last,
  fixes, checkProblems }`. `path` is `judge`, `agent` or null.
- `POST /heartbeat/level {level}`: `off | notice | tidy | fix`.
- `POST /heartbeat/run`: the checks and a judgment or check-in now (Settings' "Check now").
- `POST /heartbeat/sleep {until?}`: Sleep now.

The skip reasons are `off`, `night`, `sleep`, `in use`, `cap`, `rate` (judge), `hour` (agent), `quiet` and
`no judge`. State is kept in `heartbeat.json` and `heartbeat-fixes.json`, next to the chats.

## Open questions

1. **A fix on the agent path has no PIN card**, because nobody is there in the background. Should Fix things on the
   fallback queue too, instead of fixing? That would make every fix wait for a person.
2. **Showing waiting fixes on the tablet:** a line on Today since 1.0.12. A row in Settings too? Not built;
   `GET /heartbeat` has `fixes`.
3. **Four levels or three?** Still open.
