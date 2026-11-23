# Opie using other apps

Opie can open, install and use the tablet's other Android apps for someone ("open DoorDash and reorder last
Friday's pizza", "set a 5 minute timer in Clock"). It reads the screen through Android accessibility, taps and types,
and the floating face moves next to each thing it touches, saying what it's doing ("Tapping “Reorder”"), with a Stop
button. It never finishes the last step that costs money or reaches other people: it stops there and the person taps it.

## OpenHouse's own screen (2026-11-21)

Opie can open and move between tabs, and use OpenHouse itself as well as other apps.

- `show_on_screen {what}` puts the screen on a tab or one of the household's apps (an app that isn't a tab opens full
  screen), from wherever it is: OpenHouse comes to the front from another Android app (device server `/front`), an app
  open full screen closes, the Settings list closes. Its `what` is an enum of the tabs and apps there are now, with
  their names in the description, rebuilt for every conversation. Offered without device control too.
- `look_at_screen`, `tap`, `type` and `scroll` work on OpenHouse's own pages (the tabs and apps are web pages: their
  elements come through accessibility), with device control on; "Opie uses apps" isn't needed for OpenHouse's own screen.
  Chromium only builds a page's accessibility for a service that asks for more than window changes, so the service asks
  for every event while Opie is using the screen and goes back to window changes two minutes after its last action.
- `type` with `submit` in OpenHouse's own page sends a real Enter key to the focused element (its fields add on
  keydown); nothing leaves the house, so the "written, not sent" rule is for other apps only. An app open full screen
  runs in its own process, where this isn't possible yet: there Opie taps the page's own button.
- **Never Settings, a PIN or OpenHouse's own questions.** While the Settings list, any of OpenHouse's dialogs
  (CalmDialog: Settings' rows, PINs, "Is this OK?") or a PIN pad (in any window: the pad carries a marker its windows
  are checked for) is up, the screen list says so instead of listing them, and taps, typing and scrolling there are
  refused. Opie can't enter or get round the PIN.
- Nothing matches words in what people say: whether someone wants it to stop is the model's call
  (`stop_using_apps`, which halts like the Stop button). (The first version matched "stop" words; removed.)

## Anything a person can do in OpenHouse (2026-11-21, later)

Opie can do anything a person can do within OpenHouse's own application.

- Settings and OpenHouse's own dialogs are now Opie's to use too (they were off limits in the first version). Its
  limits are a person's: Settings' rows ask for the PIN when the lock is on, and a PIN pad is the one thing Opie can't
  see or touch (any window with one: the screen list says a PIN is being asked for, every action is refused).
- A few controls are a person's own, whoever's tap it is: Device control, Opie uses apps, Home network, USB debugging,
  Android settings, Leave kiosk mode, and "Add" on a calendar or album someone sent. They check
  `DeviceServer.personOnly` and do nothing when Opie's tap set them off in the last 2.5 s; Opie hears why.
- Hard to take back on OpenHouse's screen (a button labelled delete, remove, reset...): the tap answers "ask them
  first", and goes through only with `confirmed: true` after a spoken yes. (Other apps keep the on-screen "Is this OK?".)
- Direct tools first: `timer` (start, list, cancel: what the screen's timers do), `show_on_screen`, and the household
  tools; look, tap, type and scroll for the rest.
- The built-in apps' cards (Lists, Chores, Calendar, Meals, Photos) said `role="button"` on the card and its scrim (any
  element with a tap did), and a button's insides can't be reached by accessibility: Opie, and screen readers, saw no
  dialog. They're `role="dialog"` and `role="none"` now. (Needs the apps updated on the tablet.)
- A computer (the workshop) doesn't get these: driving the screen is for someone at the tablet.

## Dropdowns (2026-11-21)

A web page's `<select>` opens a popup list in a window of its own; tapping it open and then tapping an option worked
on the emulator but not on a real tablet. `pick {id, option}` does it in one step wherever the popup appears: it
opens the dropdown, waits up to 3 s for a new window, finds the option by what it reads, and taps it (the final-button
and PIN rules still apply). No such option: it lists the real ones and closes the list. A dropdown reads as
`View "Who / a menu pop up button"`: Chromium doesn't expose a web dropdown's current choice; a native one's shows
after `now:` (stateDescription). A window with nothing readable in it is named in the screen list, so a popup that
can't be read says so.

## Turning it on

Two switches, both in Settings → This tablet (behind the lock when the lock is on):

- **Device control**: the accessibility service. On by default on a set-up tablet; it also carries the floating face
  and the keyboard's assistant key.
- **Opie uses apps**: off until someone turns it on. With it off, every action is refused with where to turn it on
  (the workshop's `look_at_tablet` picture still works).

## What it can do

The same seven tools for the live voice (its backend, gpt-6-luna, calls them while the session talks) and for typed
turns (agents/cloud.js). `bridge/device-tools.js` → the shell's device server (`DeviceServer.kt`, 127.0.0.1:8791,
its own token).

| Tool | What it does |
|---|---|
| `open_app {name}` | Opens an app by its name. A system app (Clock, a browser) asks once on screen, "Let Opie open Clock?" (the PIN when the lock is on); after that it's one of the tablet's added apps (Apps, and kiosk lets it open). Answers with the screen. |
| `install_app {name, confirmed}` | Without `confirmed`, answers "ask them first". With it, the existing Aurora flow (AuroraInstall.kt): the tablet's own card (PIN when locked), Aurora fetched from F-Droid and checked if missing, the app from Google Play, installed silently by the shell, put in Apps. |
| `look_at_screen {picture?, wait?}` | The screen as numbered elements (`[7] Button "Start" (tap) @1960,1408`). The on-screen keyboard is one line, not its keys. When the list says little (a game, a map) or `picture` is asked for, a quarter-size JPEG goes to the cloud's text model, which describes it in a few lines (the voice's tools take text only). |
| `tap {id | x,y, long?}` | Taps an element or a point. |
| `type {text, id?, submit?}` | Types into a field. `submit` presses enter only in a search box. |
| `scroll {direction, id?}` | Scrolls. |
| `press {back | home}` | Back, or home to OpenHouse. |

Every action answers with what's on screen afterwards, so a step is usually one call. The rules the assistant gets are
in `DEVICE_RULES` (device-tools.js): say what it's about to do in a few words, work from the screen it's given, stop and
ask at a sign-in or anything it doesn't know, and say where it got to at the end.

## The safety rules

Enforced in the shell (where the bridge can't change them), and again where the bridge can:

- **Never the last step.** A tap is refused when the button (or what's drawn inside it, or the clickable thing it
  belongs to) is a finishing action: pay, place / submit / confirm order, order now, buy, purchase, confirm purchase,
  subscribe, start trial, donate, tip, transfer, send money, send (message, SMS, email, invite...), reply, post,
  publish, delete / close account, deactivate (`DeviceRules.finalAction`, tested in DeviceRulesTest). Matched on a
  button's own short label, so "Send to 555-0100" (picking a recipient) or "Checkout" (going to the review screen)
  are fine. The refusal tells the assistant to stop and tell them it's ready; the face says "Stopped at “Place order”:
  that one's yours to tap". There is no yes that unlocks it: the person taps it themselves.
- **Never a password or card.** Taps on, and typing into, password fields and fields whose hint or id says card
  number, CVV, expiry, IBAN, PIN or password are refused; so is any typed text with a card number in it (Luhn-checked),
  in the shell and in the bridge.
- **Never sends what it typed.** `type` with `submit` outside a search box writes the text and stops: "written, not sent".
- **Never Settings or a store.** `open_app` refuses the tablet's Settings, its launcher and the app stores (ways out of
  kiosk); installing goes through `install_app` only.
- **Other risky taps ask.** Delete, remove, share, call, allow, accept and the like still show the "Is this OK?" card
  (as before), and wait for a person.
- **Stop.** The face's Stop button halts at once and goes back to OpenHouse. Asking Opie to stop has it call
  `stop_using_apps`, which halts at once and stays where it is; typed Stop does too. A stopped run refuses every
  further action until the next request.
- **Limits.** At most 60 actions for one request and 40 a minute; then it stops and says where it got to. A typed turn
  may take up to 40 model steps once it's using an app (8 otherwise).
- **Logged.** Every action and what came of it goes to the speech log (Settings → This tablet → Speech log, kept on
  the tablet only): `device-tool` and `device-result` from the bridge, `device-action` from the shell, `device-stop`.
  The shell also logs each call to logcat.

What it can't guard: an app drawn without accessibility labels (a game, some web views) where the only way in is a
tap at a point. The point is still checked against whatever element is under it, but an unlabelled "Buy" drawn as a
picture can't be recognised. Keep to well-made apps; Opie is told to stop at anything that looks final.

## Kiosk

An app Opie opens or installs is added to the tablet's apps (AppStore's list: it shows in Apps, and the kiosk's lock
task list lets it open). Back from an app's first screen and Home both land on OpenHouse; the kiosk stays locked.

## Cost and latency

Screen reading is text (the accessibility tree), which the model reads quickly and cheaply. A picture is taken only
when the tree says little or the model asks; it goes out at a quarter size, JPEG quality 55 (about 30 KB), to the
household's cloud text model once, and only its few lines of description go back into the conversation. The live
voice's backend runs the loop itself; each action waits about 0.7 s for the screen to settle.

## Tried (2026-11-20, emulator, release-key build 1.0.12-local.7)

Driven through the bridge's `/live/tool` as the voice's backend would call it (no real model in the loop; the
emulator wasn't linked to a cloud account):

- With "Opie uses apps" off: refused with where to turn it on. Turned on through Settings → This tablet.
- Clock: "Let Opie open Clock?" card, yes, opened; Timer tab, 5, 0, 0, Start. Opening Messages a second time needed no
  card (it had become an added app).
- "Opie, stop" via `/live/said`: the next tap was refused; the next request worked again. The face's Stop button:
  the next tap answered "Stopped: Someone pressed Stop on the screen", and the tablet went back to OpenHouse.
- Messages: started a chat to 555-0100 (the "Send to 555-0100" row was allowed after narrowing the rule), typed
  "Running late, home by 6" with submit: written, not sent; tapping "Send SMS" by number, by its parent and by
  coordinates: all refused.
- Installed Fossify Calculator through `install_app` (Aurora fetched and set up, the app installed by the shell),
  opened it, 7 × 6 = 42, Home and Back both landed on OpenHouse with lock task mode still LOCKED.
- The speech log had each tool call, its result and the shell's action line.

Not tried: a real model (live voice or typed) driving a whole task, the picture description (needs the cloud),
DoorDash or any real shopping app, a Samsung tablet.
