# Opie using other apps

Opie can open, install and use the tablet's other Android apps for someone ("open DoorDash and reorder last
Friday's pizza", "set a 5 minute timer in Clock"). It reads the screen through Android accessibility, taps and types,
and the floating face moves next to each thing it touches, saying what it's doing ("Tapping “Reorder”"), with a Stop
button. It never finishes the last step that costs money or reaches other people: it stops there and the person taps it.

## Opie's own screen (2026-11-21)

Opie can open and move between tabs, and use its own screens as well as other apps.

- `show_on_screen {what}` puts the screen on a tab or one of the household's apps (an app that isn't a tab opens full
  screen), from wherever it is: Opie comes to the front from another Android app (device server `/front`), an app
  open full screen closes, the Settings list closes. Its `what` is an enum of the tabs and apps there are now, with
  their names in the description, rebuilt for every conversation. Offered without device control too.
- `look_at_screen`, `tap`, `type` and `scroll` work on Opie's own pages (the tabs and apps are web pages: their
  elements come through accessibility), with device control on; "Opie uses apps" isn't needed for Opie's own screen.
  Chromium only builds a page's accessibility for a service that asks for more than window changes, so the service asks
  for every event while Opie is using the screen and goes back to window changes two minutes after its last action.
- `type` with `submit` in Opie's own page sends a real Enter key to the focused element (its fields add on
  keydown); nothing leaves the house, so the "written, not sent" rule is for other apps only. An app open full screen
  runs in its own process, where this isn't possible yet: there Opie taps the page's own button.
- **Never Settings, a PIN or Opie's own questions.** While the Settings list, any of Opie's dialogs
  (CalmDialog: Settings' rows, PINs, "Is this OK?") or a PIN pad (in any window: the pad carries a marker its windows
  are checked for) is up, the screen list says so instead of listing them, and taps, typing and scrolling there are
  refused. Opie can't enter or get round the PIN.
- Nothing matches words in what people say: whether someone wants it to stop is the model's call
  (`stop_using_apps`, which halts like the Stop button). (The first version matched "stop" words; removed.)

## Anything a person can do in Opie (2026-11-21, later)

Opie can do anything a person can do within its own app.

- Settings and its own dialogs are now Opie's to use too (they were off limits in the first version). Its
  limits are a person's: Settings' rows ask for the PIN when the lock is on, and a PIN pad is the one thing Opie can't
  see or touch (any window with one: the screen list says a PIN is being asked for, every action is refused).
- A few controls are a person's own, whoever's tap it is: Device control, Opie uses apps, USB debugging,
  Android settings, Leave kiosk mode, and "Add" on a calendar or album someone sent. They check
  `DeviceServer.personOnly` and do nothing when Opie's tap set them off in the last 2.5 s; Opie hears why.
- Hard to take back on Opie's screen (a button labelled delete, remove, reset...): the tap answers "ask them
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

Two switches, both in Settings → Advanced (behind the lock when the lock is on):

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
| `install_app {name, confirmed}` | Without `confirmed`, answers "ask them first". With it: an app already on the tablet goes into Apps; otherwise the tablet's own card (the PIN when locked and Ask for the PIN → Add apps is on), then the app's Google Play page (`DeviceServer.installFromPlay`, `PlayStore.openPage`). The person taps Install; when Play has installed it, it's in Apps (`AppStore`, from the package-added broadcast). No Google Play on the device, or no Google account signed in: it says so, and where to sign in (Settings → Connections → Google Play). |
| `look_at_screen {picture?, wait?}` | The screen as numbered elements (`[7] Button "Start" (tap) @1960,1408`). The on-screen keyboard is one line, not its keys. When the list says little (a game, a map) or `picture` is asked for, a quarter-size JPEG goes to the cloud's text model, which describes it in a few lines (the voice's tools take text only). |
| `tap {id | x,y, long?}` | Taps an element or a point. |
| `type {text, id?, submit?}` | Types into a field. `submit` presses enter only in a search box. |
| `scroll {direction, id?}` | Scrolls. |
| `press {back | home}` | Back, or home to Opie. |

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
  kiosk); `install_app` opens only one app's Google Play page (`DeviceRules.playPage`), after a yes on screen.
- **Hands off Google Play.** While Google Play or Google's sign-in is in front, Opie may read the screen, scroll and
  press Back or Home, but every tap and every typed word is refused (`DeviceRules.handsOff`, tested): Install, Buy,
  Update and the account are the person's own taps.
- **Other risky taps ask.** Delete, remove, share, call, allow, accept and the like still show the "Is this OK?" card
  (as before), and wait for a person.
- **Stop.** The face's Stop button halts at once and goes back to Opie's home screen. Asking Opie to stop has it call
  `stop_using_apps`, which halts at once and stays where it is; typed Stop does too. A stopped run refuses every
  further action until the next request.
- **Limits.** At most 60 actions for one request and 40 a minute; then it stops and says where it got to. A typed turn
  may take up to 40 model steps once it's using an app (8 otherwise).
- **Logged.** Every action and what came of it goes to the speech log (Settings → Advanced → Keep a log of what it hears, kept on
  the tablet only): `device-tool` and `device-result` from the bridge, `device-action` from the shell, `device-stop`.
  The shell also logs each call to logcat.

What it can't guard: an app drawn without accessibility labels (a game, some web views) where the only way in is a
tap at a point. The point is still checked against whatever element is under it, but an unlabelled "Buy" drawn as a
picture can't be recognised. Keep to well-made apps; Opie is told to stop at anything that looks final.

## Kiosk

An app Opie opens or installs is added to the tablet's apps (AppStore's list: it shows in Apps, and the kiosk's lock
task list lets it open). Back from an app's first screen and Home both land on Opie; the kiosk stays locked.

## Google Play

Android apps come from Google Play, with the household's own Google account on the tablet (Aurora Store, the earlier
way, used a shared anonymous account against Play's terms, and apps like YouTube TV need a real account).

- **Signing in**: Settings → Connections → Google Play (always the PIN; a person's own tap, `personOnly`). It's Android's
  own add-account flow for Google, after one line: a Google account just for this tablet works best (docs/setup.md) (`AccountManager.addAccount`); Google's sign-in pages are let into lock task only
  until Opie is back in front. Nothing in Opie's device-owner policies stops adding an account (no
  `DISALLOW_MODIFY_ACCOUNTS`, no account-management restrictions). Play's own purchase password (Settings →
  Authentication) is left to the household: Opie doesn't point to it.
  Signed in, the row shows the account, and Sign out takes it off.
- **Adding an app**: Apps → Add apps (its search shows Google Play's results under Opie's list, and the Music and books
  suggestions) or `install_app` open that app's Play page, after the PIN when Add apps asks for it. Play is let into
  lock task for that moment only (`KioskApps.allowInKiosk(temporary)`), so Home or Back returns to Opie and it can't
  be reached again without a new tap there. `open_app` never opens it.
- **After installing**: a package installed by Play (with a launcher icon) goes into Apps and the lock task list.
- **No Google Play** (some photo frames, Amazon tablets): Add apps says adding Android apps needs Google Play. There is
  no other way in.
- **Aurora Store** is gone: the update that removes it uninstalls the Aurora that Opie installed (`AppStore.retireAurora`,
  device owner, silent; one someone installed themselves stays) and drops the shell's "install this APK" handler. The
  apps it added stay installed and in Apps; Play doesn't update them, since it didn't install them.

### A Google account on the device

Signing in to Google Play, or to YouTube TV with its own sign-in, adds a Google account to Android, and every Google app
on the device could then reach that person's mail, photos and files. While one is signed in, the shell (device owner,
`shell/GooglePrivacy.kt`, applied at start and whenever accounts change):
- hides Gmail, Google Photos, Drive, Contacts and Calendar, so nobody can open them, Opie included. Settings →
  Connections → Google Play → Show Google apps brings them back (a person's own, with the PIN);
- turns off the account's mail, contacts and calendar sync, so the device's own Contacts and Calendar (a Samsung's too)
  don't get them;
- keeps Chrome, through its managed policies: no Google sign-in or sync, and no Gmail (`BrowserSignin` 0,
  `SyncDisabled`, `URLBlocklist`), so Google's sites open signed out.

YouTube TV, YouTube and Play keep the account. Opie's own calendars use their own sign-in (docs/calendar-sync.md),
not the device's account, so they're untouched. Not yet tried on a real device: whether Chrome applies its policies on a
device set up this way.

## Cost and latency

Screen reading is text (the accessibility tree), which the model reads quickly and cheaply. A picture is taken only
when the tree says little or the model asks; it goes out at a quarter size, JPEG quality 55 (about 30 KB), to the
household's cloud text model once, and only its few lines of description go back into the conversation. The live
voice's backend runs the loop itself; each action waits about 0.7 s for the screen to settle.

## Tried (2026-11-20, emulator, release-key build 1.0.12-local.7)

Driven through the bridge's `/live/tool` as the voice's backend would call it (no real model in the loop; the
emulator wasn't linked to a cloud account):

- With "Opie uses apps" off: refused with where to turn it on. Turned on through Settings → Advanced.
- Clock: "Let Opie open Clock?" card, yes, opened; Timer tab, 5, 0, 0, Start. Opening Messages a second time needed no
  card (it had become an added app).
- "Opie, stop" via `/live/said`: the next tap was refused; the next request worked again. The face's Stop button:
  the next tap answered "Stopped: Someone pressed Stop on the screen", and the tablet went back to Opie.
- Messages: started a chat to 555-0100 (the "Send to 555-0100" row was allowed after narrowing the rule), typed
  "Running late, home by 6" with submit: written, not sent; tapping "Send SMS" by number, by its parent and by
  coordinates: all refused.
- Installed Fossify Calculator through `install_app` (then through Aurora Store, since replaced by Google Play),
  opened it, 7 × 6 = 42, Home and Back both landed on Opie with lock task mode still LOCKED.
- The speech log had each tool call, its result and the shell's action line.

Not tried: a real model (live voice or typed) driving a whole task, the picture description (needs the cloud),
DoorDash or any real shopping app, a Samsung tablet.
