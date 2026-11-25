# Can Luna build OpenHouse apps? (eval, 2026-11-25)

Whether OpenAI's `gpt-6-luna` (the cloud assistant's model) can make and change small OpenHouse apps with the
workshop's tools, compared with `gpt-6.1-terra` (reasoning none), and what it costs. The eval came first; the
product path it points to (`docs/building-on-the-tablet.md`) was then built and measured the same way.

## Summary

- **Luna is good enough, on rails.** Free-form, with the workshop's own tools, both models built and loaded all 30
  requests without errors, and Luna did what was asked about as often as Terra. That's 5 games, 5 tabs and 5 changes
  to built-in apps each.
- **"Builds" is the wrong bar.** Both shipped apps that load clean but don't work: a Lists edit that crashed when an
  item was opened, a snack rotation that never advanced, a Thanksgiving page that rendered unstyled, phone text a
  quarter size. Neither error checks nor the build check caught these.
- **Cost:** a median build was **0.5¢ on Luna and 3.6¢ on Terra**, 40–60 s each.
- **Terra can't be the fallback through the cloud as it is.** The service stops a model call at 30 s (API Gateway's
  HTTP API). Terra's long file writes passed that in every new app on the tablet's own path (0 of 9 new apps; its 4
  small edits worked). Luna's slowest calls were 17–26 s; the builder now writes long files in parts to keep them
  well under.
- **The rails that worked** (all in `bridge/rails.js`, and judged below):
  - **A game engine.** No game touched `game.js`, and every input and game-loop bug from the free-form games went
    away (buttons that let go together, loops that died, games that couldn't end).
  - **A fixed tab template.** No phone or theme breakage.
  - **Looking at the screen.** Fixed most visible bugs.
  - **A second look at the code** for what a picture can't show. It removed the snack rotation that never advanced,
    the maze that solved itself, the doubled fall speed, and the hardcoded year and Wi-Fi line.
  - **A parent's yes**, with an app made here limited like one from a link.
- **With all of it**, Luna's new apps averaged **3.9 of 5**, against 3.2 (games) and 3.6 (tabs) free-form. All 10 did
  what was asked, and it cost a median **0.76¢** and about a minute. Changes to existing apps are the weak spot
  (mean 3.0): timid restyles, and one edit broken by a regex escape that loaded clean and read fine to the review.
- **Recommendation: Luna alone, on rails** (template, engine, look, review). **No Terra fallback for now:** it would
  need the cloud to allow calls longer than 30 s, and a fallback that's slow, costs 7× as much and breaks the time
  limit isn't worth it for these requests. Open-ended work stays with a computer.

Total spend: $4.10 across 221 builds plus the routing checks, at list price from the API's usage numbers. The cap was $10.

## Setup

- A dev bridge per track, in a scratch copy of the repo, with the sample household (Sam, Alex, Maya, Leo in
  Springfield) and the built-in apps seeded: `scripts/eval/run.sh` (no household data, the OpenAI key only in the
  process's environment).
- **Free-form** (`scripts/eval/luna-build.mjs`): the cloud assistant's loop shape (`bridge/agents/cloud.js`) on the
  Responses API, with the workshop's tools served by that bridge over its MCP endpoint:
  - `get_guide`, `start_editing`, `list_files`, `read_file`, `write_file`, `edit_file`, `check_build` and
    `done_editing`;
  - `calendar_event` (one request is the household's data, not code);
  - optionally `look_at_tablet`, answered with tablet-size and phone-size screenshots.
  - `check_build` adds what a headless Chrome load of the page threw (console errors, failed requests), as the tablet
    reports a tab's own errors.
- **Success ("builds")**: what it changed passes `check_build` and loads in headless Chrome with no errors after a few
  taps. **"Does what was asked"**: judged by reading each app's code and screenshot (reviewers working from the same
  checklist, spot-checked), with a 1–5 quality score.
- **The tablet's own path** (`scripts/eval/rails-e2e.mjs`):
  - each request goes to the bridge's `POST /request` (or typed to `/chat`), so its own builder makes it;
  - a stand-in cloud on this machine forwards `/v1/ai/respond` and `/v1/decide` to OpenAI;
  - a stand-in device server answers `look` with a screenshot and the approval card with a yes.
- List prices: Luna $0.10/M in, $0.01/M cached, $0.50/M out; Terra $1.00 / $0.05 / $5.00.

## The 30 runs (free-form, pass 1)

Builds: all 30 yes. Does: what the code shows. Quality 1–5 for new apps. ¢ and seconds per build.

| Request | Luna | | | Terra | | |
|---|---|---|---|---|---|---|
| | does / quality | ¢ | s | does / quality | ¢ | s |
| Game: dinosaur catch | yes / 4 | 0.44 | 57 | yes / 3 (can't lose) | 3.76 | 58 |
| Game: maze | yes / 3 | 0.43 | 38 | yes / 4 | 3.30 | 48 |
| Game: memory match | yes / 4 (flip never animates) | 0.65 | 60 | yes / 3 | 3.42 | 50 |
| Game: tap-the-mole | yes / 3 (moles too fast) | 0.40 | 33 | yes / 4 | 3.32 | 50 |
| Game: platformer | yes / 2 (can't hold → and tap jump) | 0.48 | 48 | yes / 4 | 3.19 | 49 |
| Tab: soccer countdown | yes / 4 | 0.43 | 32 | yes / 3 (tiny on a phone) | 5.37 | 41 |
| Tab: snack rotation | yes / 3 (first family fixed) | 0.87 | 48 | yes / 3 (tiny on a phone) | 5.65 | 51 |
| Tab: babysitter board | yes / 3 | 0.68 | 35 | yes / 3 (tiny on a phone) | 7.62 | 60 |
| Tab: reading streaks | yes / 4 | 0.67 | 49 | yes / 3 (tiny on a phone) | 6.64 | 49 |
| Tab: Thanksgiving checklist | yes / 4 | 1.00 | 49 | partly / 2 (renders unstyled) | 5.78 | 44 |
| Edit: bigger text on Chores | yes | 0.35 | 25 | yes | 2.66 | 31 |
| Edit: quantity on Lists items | no¹ | 0.63 | 24 | yes (item text "Milk × 2") | 6.44 | 60 |
| Edit: Whiteboard paper yellow | yes | 0.33 | 24 | yes | 2.19 | 30 |
| Edit: Grandma's birthday countdown | yes (calendar event, yearly) | 0.06 | 9 | yes (same) | 0.18 | 6 |
| Edit: Halloween look on Meals | partly (barely Halloween) | 0.93 | 65 | partly (clearer, still subdued) | 3.92 | 52 |

¹ Stopped after four edits by a fault in the harness's loop check (four different edits to one file looked like a
loop). Rerun with the fix: it finished in 23 steps for 1.2¢. It saves quantities in the app's own store and takes
"2 milk" when adding.

### Rates per category (pass 1)

| | Luna | Terra |
|---|---|---|
| Games: builds / does / mean quality | 5/5 / 5/5 / 3.2 | 5/5 / 5/5 / 3.6 |
| Tabs: builds / does / mean quality | 5/5 / 5/5 / 3.6 | 5/5 / 4/5 / 2.8 |
| Edits: builds / does fully | 5/5 / 3/5 (4/5 rerun) | 5/5 / 4/5 |
| Median ¢ per build (all passes) | 0.50 (45 runs) | 3.59 (30 runs) |
| Median seconds | 41 | 52 |

Repeats (Luna 3 passes, Terra 2): 75 of 75 built. Run-to-run variation was in what they made, not in whether it
loaded. Two runs hit a dropped connection to OpenAI and stopped early, still building; the harness now retries those.

## The variants

| Variant | Runs | Builds | Luna ¢ (median) | Terra ¢ | What changed in what they made |
|---|---|---|---|---|---|
| Free-form | 75 | 75/75 | 0.50 | 3.59 | (above) |
| + look_at_tablet | 30 | 30/30 | 0.69 | 4.58 | Visible bugs mostly fixed: Luna's platformer buttons and corner, memory flip, padding, overlap; Terra's phone sizing (4 of 5 tabs) and its games can be won and lost now. Logic bugs stayed (Luna's snack rotation, its Lists edit still broken) |
| Engine in the instructions | 10 | 10/10 | 0.79 | 5.14 | All games build; costs more (the engine rides in every call and the model copies it out) |
| **Tablet's builder** (rails) | 14 | 14/14 | 0.58 | – | Games better (mean 3.8, from 3.2): no engine bugs left; tabs 3.4; the Lists edit now works |
| Tablet's builder + look | 14 + 14 | 14/14 Luna, 6/14 Terra | 0.67 | 2.61 (timeouts) | Tabs richer (4.0); games 3.4 (a doubled egg speed, a leftover alpha); Terra: 0 of 9 new apps inside 30 s, 4/4 edits |
| Tablet's builder + look + review (Luna reviews) | 14 + 14 | 14/14, 14/14 | 1.16, then 0.76 writing in parts | – | **New apps 3.9** (10/10 do what was asked), edits 3.0. The review removed the stuck rotation, the self-solving maze, the doubled speed, the hardcoded year and Wi-Fi line. Left: a hardcoded snack order, moles under a second, a timid Halloween, and the Lists quantity broken by a regex escape. Slowest call 18 s, from 26 s |
| … with Terra reviewing | 14 | 13/14 (one out of steps) | 1.44 | – | About the same as Luna reviewing (new apps 3.8), with more scope creep in edits: not worth 2× |
| Terra building, writing in parts | 5 games | 3/5 inside 30 s | – | 2.44 | Writing in parts helps but doesn't make Terra fit (slowest call 40 s) |
| Typed to the assistant | 15 | 12 built + Grandma kept as an event; soccer became a calendar countdown, snacks only an answer | 0.41 | – | Routes: 9 forced builds, 5 left to the assistant, which called make_app for 3 of them and kept 2 as calendar data |

The routing check (`scripts/eval/route-check.mjs`, 21 requests including 6 everyday ones):
- **Forced builds:** the typed assistant's first question sent 9 of the 14 app requests straight to the builder, and
  none of the 7 household ones.
- **The other 5:** they went to the model, which has `make_app` as well as the household's tools. In the typed run
  it called `make_app` for the babysitter board, the Thanksgiving checklist and the Lists quantity, and answered the
  soccer countdown with a calendar countdown event (fair). It answered the snack rotation in words only, with
  nothing kept (a miss).
- **Grandma's birthday:** always a calendar event, never a build.

## Failure modes

- **Logic that loads but doesn't work** (both models, all variants):
  - a rotation anchored to "this Saturday" that never moves;
  - a feature started but unreachable from the UI;
  - a use-before-declaration that throws only when a card opens;
  - a maze whose drag solves itself (a shortest-path walk to the finger);
  - hardcoded choices the family can't change (who's first, the year, the Wi-Fi line);
  - data kept in the app's own store that belongs with the household (quantities Opie can't see).
- **Layout that loads but is broken:**
  - Terra's `--u` set after `quiet.css` with no phone reset, in 4 of 5 tabs;
  - no `--u` at all, so a page renders unstyled;
  - controls in the bottom-right corner kept for the assistant;
  - unpadded panels.
  The fixed tab template and looking at the screen fix these.
- **Game plumbing:**
  - buttons that all let go at once;
  - loops that stop for good when the page is hidden;
  - games with no end;
  - things that walk off the screen.
  The engine fixes these: it handles input, the loop, gravity, edges and the Play again card.
- **Choosing data over code:** both models made Grandma's birthday a calendar event. The typed path made the soccer
  countdown one too.
- **Escapes and edge cases a review reads past:** a `/^\\d+$/` written for `/^\d+$/` (every quantity
  refused), a variable used before it's declared that works only because of timing. The builder now flags a doubled
  backslash in a regex at `check_build` and `done`.
- **Time:** Terra's turns that write a file take 35 s or more; the service's limit is 30 s.
- **Luna specifically:** prettier and quicker, but more slips in logic and timing (moles up under a second), and
  timid restyles (Halloween barely reads).
- **Terra specifically:** more careful with input and other screens, but plainer.

## Recommendation

1. **Luna alone, on rails** for games, small tabs and changes to an app. Everything here cost under 1.5¢ a build.
2. **Rails:**
   - one app per request;
   - the templates and the engine;
   - its own files only, with `app.json`'s rights out of reach;
   - `check_build`;
   - `look_at_tablet` (Device control is on by default on a set-up tablet);
   - the second look at the code;
   - writes in parts under 30 s;
   - a parent's yes;
   - new apps limited like plugins from a link.
   All of it is built on this branch (`docs/building-on-the-tablet.md`).
3. **No Terra fallback yet.** It needs the cloud to allow long calls for builds: a Lambda function URL or a streamed
   response, not the HTTP API. It would also need a reason the reviewer can't cover.
4. **Keep the computer for the rest:** anything multi-app, anything with outside data, anything a family will lean on.
5. **Next for the rails:**
   - Give the builder the household's data functions, so a feature that belongs with the family's things goes there
     (a Lists quantity in the item, not the app's store).
   - Add a way to change hardcoded choices, which the review could insist on.
   - Show the app running behind the approval card.

## Rerunning it

```bash
scripts/eval/run.sh <scratch dir>                                   # the 30 free-form runs
scripts/eval/run.sh <scratch dir> LOOK=1                            # with look_at_tablet
scripts/eval/run.sh <scratch dir> VARIANT=engine                    # games with the engine in the instructions
SCRIPT=rails-e2e.mjs scripts/eval/run.sh <scratch dir> LOOK=1 REVIEW_MODEL=gpt-6-luna   # the tablet's own builder
SCRIPT=rails-e2e.mjs scripts/eval/run.sh <scratch dir> TYPED=1      # typed to the tablet's assistant
SCRIPT=route-check.mjs scripts/eval/run.sh <scratch dir>            # the typed assistant's first question
node scripts/eval/summarize.mjs <scratch dir>/out/results.jsonl     # tables
```

Each run's files and screenshot stay in the scratch folder (`out/<variant>/<model>/<request>/`).
