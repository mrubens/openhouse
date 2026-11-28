# Settings

The rules for every dialog, card and setting are in [ux.md](ux.md).

One full-screen page: tabs down the left, the chosen tab on the right. Each row shows its current value instead of an
explanation. A row that needs more opens in the same place, with a ‹ back to the tab; nothing opens over it but a
question to confirm and the PIN pad. Done (top left) closes Settings. On a phone (short side under 600 dp) the tabs are a
list; a tab opens full screen with a ‹ back to the list.

## The tabs (ui/SettingsScreen.kt; rows from shell/SettingsLock.kt)

Since 2026-11-27 (the user: "fewer levels… a full screen UI with side tabs", instead of nested sheets):

| Tab | What's on it | Locked |
| --- | --- | --- |
| Household | who lives here (a name, Adult, Kid or Pet, their color, an age or note), where you live, chores; Save | |
| Opie | Voice (Off or the voice's name; the household's own OpenAI key inside), Check the microphone, What Opie remembers, Check-ins, Device control, Opie uses apps, Now playing (while it's off) | Voice: Change settings; Check-ins and the rest from Device control down: always |
| Connections | every outside account or link the household hooks up, in sections: Calendars (Google and iCloud accounts and their calendars, calendars' links; Add), Photo albums (the iCloud shared albums, each with Remove; Add), Music and apps (Spotify, Google Play) | no PIN to look; each part as on its own (below) |
| Screen | Brightness, Volume (with Adjust to the room), Time | Time: Change settings |
| Devices | paired screens, TVs, phones and computers (Add, Remove), then the house's speakers, streamers and printers | Add always; Remove: Change settings |
| Account | link or unlink, Backups, Email, Use it away from home | always |
| Advanced | PIN Lock, PIN recovery code, Ask for the PIN, Plugins, Add this tablet to another Opie, Send a report; For developers: Home network, Tailscale, Cloud address, Speech log, USB debugging, Android settings, Leave kiosk mode, Erase this tablet | always |

**Connections** (shell/SettingsLock.kt `connections`, rows in shell/Lines.kt) keeps each part's own PIN:
- Calendars: with Change settings asking (the default), the section is one row (how many, Unlock) until the PIN is
  typed, as the Calendars tab asked before; then the accounts (Sign out), their calendars (a box to show each, a tap
  for more) and the links (a tap: Color, Remove). Add is Google, iCloud or a link.
- Photo albums: each album with Remove; Add sends the link from a phone (or pastes it). Adding or removing asks when
  Add photo albums does, as the Photos app does; the Photos tab keeps its own Add photos and Stop keeping it here.
  Google Photos copies photos once and keeps no connection, so it isn't here (Photos' Add photos has it).
- Spotify and Google Play: always the PIN when one is set, and a person's own tap (DeviceServer.personOnly). Google
  Play shows only where the device has it.

Under the tabs, quietly: the version (tap it to look for an update and install it).

House rules is in the Opie tab under Voice. It always asks for the PIN when one is set, whatever Ask for the PIN says
(Opie can't tell who is asking).

A tablet that's part of another tablet's household (docs/multi-tablet.md) has Household (On the main tablet, Leave),
Screen and Advanced only.

A locked tab asks for the PIN when it's chosen; with no PIN typed it shows its name and Unlock. Things opened by
Opie, the setup or a card (the Calendar app's Add a calendar, Home's Now playing card) open as before, over the screen
they were asked from, when Settings isn't open.

Voice also comes on when the first setup ends, where it can work (docs/onboarding.md, **Opie is ready**), with the
same line about OpenAI; the setup itself is quiet (no microphone, nothing said aloud). That dialog's **Turn off** is an
Off, kept like this row's, so the voice isn't turned on by itself later; this row is the way to turn it on then, and to
put in the household's own OpenAI key.

**House rules** (Voice → House rules, shell/HouseRules.kt): a few lines of the household's own on how Opie answers,
typed or spoken, on top of its defaults (docs/assistant.md, **In this home**). Empty by default, which means only the
defaults; the box's placeholder gives an example ("Adults use this too; the news is fine to talk about."). Kept with
the household (household.json `rules`, bridge/board.js; POST /household/rules), at most 600 characters. Opie can't
tell an adult from a kid, so changing them always takes the PIN when one is set, whatever the PIN choices say: the editor
asks for it first, and Opie's house_rules puts the tablet's own card up (a person's tap), showing the new text, wherever
Opie was asked. Only the shell
reaches POST /household/rules: no app, phone or screen scope has it. It's its own small file so it can move with
Settings.

The tabs, the look and Home's cards have no panel on Home for now (since 2026-11-26, the user: "that stuff can just go
through Opie instead of needing a clunky UI"): asking Opie does them (`set_home`, `today_card`).

## What happened to each old setting

Connections (2026-11-27, the user: a tab "holding every outside account or link the household hooks up"):
- The Calendars tab is the Connections tab's first section; the shared albums are its second.
- Spotify moved there from Opie, and Google Play from Advanced (still a person's own, still always the PIN).

Side tabs (2026-11-27):
- The six-row list and the sheets and dialogs stacked on it are one page with seven tabs (above).
- Family's sheet is the Household tab itself; Linked devices' sheet is the Devices tab. Calendars and Advanced are
  their tabs, one level less.
- Voice, What Opie remembers and Advanced's Opie section (device control, Opie uses apps, Now playing, Spotify,
  check-ins) are one tab, Opie. Check the microphone is its own row there, not a link under Voice's words.
- Brightness, Volume and Time are the Screen tab.
- Email moved into Account (it comes through the account, or the household's own mailbox).
- Updates is no row: the version under the tabs is the way to it.
- "We haven't tested this tablet" left Advanced (it's a line of information): it's under the version.
- Advanced's Household and Help sections are gone: Add this tablet to another Opie and Send a report are rows under
  the lock's.

Later rounds:
- Live voice makes no sense without Hey Opie, so Live voice, Hey Opie and Voice are one row, **Voice**: Off or one of
  the voices' names.
- No fingerprint unlock; the row is **PIN Lock**.
- At night and Looking after things are cut: night dimming is always on, with the household's night hours
  (9:30 PM to 6:30 AM unless they were changed); the heartbeat runs at its default level (Tidy up). Opie changes either
  when asked: night_hours, heartbeat_settings.
- "This tablet" was confusing: the row is **Advanced**.
- Screens and computers combine with Devices into **Linked devices**: one row and one sheet; the
  home network switch moved to Advanced.
- The heartbeat's frequency and prompt are visible and configurable by both the people and the agent:
  Advanced, Check-ins (how often: off, every 30 minutes to 4 hours; what it looks for: its prompt in full, to edit or
  put back), and Opie's heartbeat_settings tool (bridge POST /heartbeat/settings).
- One column, six rows: Backups went into Account; PIN Lock, Updates and Plugins into Advanced.
- Photo albums belong in the Photos app, not Settings: adding an iCloud album is the Photos app's Add
  photos; a linked album's card there has Stop keeping it here. No Settings row. (Since 2026-11-27 they are in
  Connections too, below.)

Plain Settings (first round):
- Ask Opie: **moved** to a keyboard button on the home screen.
- Listen for "Hey Opie": kept as **Hey Opie**; shown only while Live voice is on (off, nothing listens anyway).
  It now also is the microphone switch (below).
- Voice: kept; shows the voice's name.
- Family: kept. Its Calendars section now opens the calendars list itself (it used to send you to the parent menu).
- Devices in the house: kept as **Devices**.
- Looking after things: **cut** (later round).
- At night: **cut** (later round). Sleep now: **moved** to a moon button on the home screen.
- PIN for the calendar: **its own choice under Lock**, off by default. With PIN Lock on, Settings, This tablet shows
  "Calendar needs the PIN"; turned on, changing the calendar in the apps asks for the PIN. (Until 1.0.24 it followed
  the lock itself; tablets from before have it turned off once.) Since 2026-11-27 it is Change the calendar, one of
  **Ask for the PIN** (below).
- Removed: **cut**, from the apps and the settings. Taken-off things stay in the bridge; Opie can put one back when asked.
- The old PIN menu: **gone**. Its rows are in the one list.

The old PIN menu (shell/ParentMenu.kt, now shell/SettingsLock.kt):
- Live voice: kept, top of the list, locked (it costs money). The turn-on text is two lines.
- Cloud: renamed **Account**, locked. Its Backups item is gone (Backups is its own row). The address button stays
  for people who run their own cloud.
- Backups: kept, locked.
- Calendars: its own row again (2026-11-24), under Family: the accounts and links, each account's calendars. Locked when the lock is on.
- Photo albums: kept, locked.
- Screens and computers: kept, locked.
- Plugins: kept, locked.
- Microphone and device control: **split**. Microphone is merged into Hey Opie: with the assistant button gone, a
  microphone that is on with Hey Opie off listened for nothing, so one switch does both. Device control moved
  into This tablet.
- Updates: its own row in the main list, not locked (seeing the version and getting ours is everyone's), shows the version.
- This tablet: kept, locked, shorter:
  - Change the parent PIN: now the **Lock** row.
  - Use fingerprint: **cut** (later round).
  - Android settings, Speech log, USB debugging, Leave kiosk mode: kept.
  - Device control: moved here.
  - Reload the screen: **cut** (a restart does it; add back if asked).

First run:
- The "Choose a parent PIN" sheet: **cut**. No PIN by default; the welcome screen comes first.

## Check the microphone

Where someone looks when "Hey Opie" isn't working: Settings → Opie → Check the microphone, or ask Opie (`mic_check`). A card: the title, one line that says what to do ("Say “Hey Opie”"),
a bar that moves with the room, and Done. Once it has heard its name, or after 8 seconds, the line becomes what it
found, and a quiet Try again shows:

- heard: Opie heard you (and, with Voice Off, that it won't answer yet)
- too quiet: the voice never reached the wake model's loudness floor; come closer or speak up
- too noisy: the voice hardly stood above the room (under about 10 dB)
- heard something, but not "Hey Opie"
- blocked: not allowed to use the microphone (with Allow), another app has it (Android silences us, or it wouldn't
  open), or it hears nothing but silence (Android's microphone switch, or another app)
- still getting ready: no wake model on this tablet yet

While it runs the bridge only measures (`/voice/check`): a "Hey Opie" opens no conversation and isn't counted with
the false wakes, and nothing heard is kept, recorded (no clips, no test recording) or sent anywhere. A conversation
going ends first, since it holds the microphone. The microphone opens for the check even with Voice Off, then goes
back to what it was. (shell MicCheck.kt; the verdict is bridge/voice.js `micVerdict`.)

## The lock

One switch, PIN Lock: Off or On.

- **Off (the default):** nothing asks for a PIN. Things that lead out of the home screen (leaving kiosk mode, Android
  settings, an app store or a system app, adding an Android app) still ask "Is this OK?" with a Yes, so nobody
  leaves by accident, but anyone can say yes. In This tablet, erasing the tablet, leaving kiosk mode, Android
  settings, turning on USB debugging and turning on device control (which opens Android's settings) ask someone to set
  a PIN first, so taps alone never reach them; once it's chosen they go on as with the lock on. So do Account's
  Unlink this tablet, Backups' Restore and Recovery code, and Android's Wi-Fi settings outside kiosk mode.
- **Wi-Fi:** the Wi-Fi button (on the "Not on Wi-Fi" note) joins a network with no PIN: Opie's own Join Wi-Fi lists
  the networks nearby (or takes one by name) and asks for its password, all inside kiosk mode. Its Wi-Fi settings
  button, Android's own (saved networks, forgetting one, and a tap from the rest of Android's settings), is a way out
  as above. During the first setup, before the household is saved (the welcome screen's Join Wi-Fi, a tablet arriving
  from somewhere else), the button opens Android's Wi-Fi settings, since there's no PIN to ask for yet.
- **The first PIN:** chosen in the first setup's Choose a PIN step (no account needed), or later from PIN Lock or
  "Set a PIN first". A linked tablet's account can reset it if it's forgotten. On an unlinked tablet (one set up
  without an account, as a do-it-yourself tablet may be, now that the cloud lets households in a few at a time) a
  later first PIN is still allowed, after a line that it's for an adult of the household and that the recovery code
  is its only way back. Whoever chooses it first holds Settings, and nothing at the tablet tells an adult from
  anyone else, so the setup's step says it's best chosen then (2026-11-26; until 2026-11-25 an unlinked tablet
  refused a PIN outside setup).
- **On:** turning it on chooses a PIN (typed twice), then shows its recovery code (below). Rows marked with a small
  lock ask for it, then stay open for two minutes as before. The same PIN is the yes on the "Is this OK?" card for the
  ways out above, and for what **Ask for the PIN** (below) has on. Those ways out ask for it again, unless it was typed
  in the last two minutes.
- Turning it off asks for the PIN, then forgets it and its recovery code.

### Ask for the PIN to…

Advanced → Ask for the PIN (shown while PIN Lock is on): one switch for each everyday thing, so a household can keep
the PIN for what matters to them (the user, 2026-11-27: "having to enter the PIN to install apps" was annoying). Its
value says which are on. Permissive by default:

| Switch | What it covers | Default |
| --- | --- | --- |
| Add apps | an Android app (Add apps or install_app opening its Google Play page; signing in to Google Play always asks), a plugin (add, an update, an app reaching a website), keeping an app Opie made (its Keep it), Apps' plugin gallery | Off |
| Add photo albums | adding or taking off an iCloud album, phones sending photos, Google Photos | Off |
| Change the calendar | any change to the calendar from the apps or Opie (the bridge's calendar lock, as before) | Off |
| Give rewards | spending stars on a reward (Get it!), and changing the rewards | Off |
| Change settings | Settings' Voice, Time and Email (their small lock), the calendars in Connections, removing a linked device, the household's own OpenAI key | On |

Off means a person's plain yes: the card still shows, and only a real finger answers it (`PersonCards`); Opie never
can. What's `DeviceServer.personOnly` stays a person's own tap, whatever the switches say.

**Always the PIN** (when one is set), never a switch: changing these switches (each one, a person's own tap), PIN Lock
itself (turning it off, a new recovery code, Forgot PIN?), Advanced and what Opie may do (device control, Opie uses apps, Tailscale, the
home network, Plugins, Now playing), Account and Backups (link, unlink, restore, the backups' code, your own storage),
adding a linked device (a computer that changes the apps, a phone, a screen, a TV, another tablet) and joining another
household, the ways out of Opie (leaving kiosk mode, Android's settings and Wi-Fi settings, system apps and other app
stores, USB debugging), erasing the tablet, and a plugin update from somewhere other than before. These either change
who can reach the household, widen what Opie may do, or take the tablet out of Opie; a card that names no switch (an
older bridge, or a hub's settings page, whose keeper doesn't know them) asks as before.

Tablets from before keep their PIN and get these defaults with the update (as the calendar's own choice did in
1.0.24): adding apps and photos and giving rewards stop asking, Settings keeps asking. Opie changes a switch only when
asked (`pin_choices`), and the tablet then asks for the PIN on its own card. The code is shell/PinChoices.kt; the
bridge names the switch on its cards (`/approve` with `for`).

### Forgot the PIN

Choosing a PIN on an unlinked tablet (the first setup's step, or a new one after Forgot PIN?) ends with its **recovery code**: 16 characters
(XXXX-XXXX-XXXX-XXXX, the same alphabet as the backups' code: no I, L, O or U). Nothing is saved until someone taps
"I've kept it", so a PIN never exists without its code having been shown; the card can't be swiped away, and Cancel
leaves no PIN at all. The tablet keeps only a salted PBKDF2 hash of the code, as it does for the PIN. A tablet
linked to an account skips the code (Reset with your account, below, is the way back in), and so does the first
setup's Choose a PIN step there; Unlink this tablet then shows a code to keep before it unlinks, so an unlinked
tablet's PIN still always has one.

"Forgot PIN?" under the PIN pad takes that code, or the backups' recovery code (Account, Backups), and then a new
PIN, which comes with a new code. So if a child sets a PIN to lock someone out, whoever kept the backups' code still
gets back in. Advanced, PIN recovery code (after the PIN) makes a new one; the old one stops working. A PIN set
before recovery codes, or over adb, has none ("None" on that row) until one is made. The backups' code in Backups
needs the PIN to be shown, since it resets the PIN too.

A child who chose the PIN has its code, though, so a tablet linked to an account also offers **Reset with your
account** under the code box: the real proof of an adult is being signed in to the family's account. The tablet
shows an 8-character code (the link code's alphabet) and the account page's address; someone signed in there types it
under "Reset a tablet's PIN", and then the tablet lets them choose a new PIN, which comes with a new recovery code as
always. The service (openhouse-cloud `/v1/device/pin-reset/start` and `/poll`, under the tablet's device credential)
approves only when the member's family is the one the tablet is linked to and the tablet hasn't been unlinked; another
family's member is told no such code is showing. The code and poll token are kept only as hashes, for 15 minutes, a
tablet starts at most six an hour, and an approval is heard once. The bridge keeps the poll token (`/cloud/pin-reset/
start` and `/poll`, the shell's own: a paired device's call is refused); the shell only shows the code and acts on
the answer. The code's card is a person card with the PIN pad's mark, so Opie's screen tools neither read it nor act
while it's up, and the new PIN is typed on the pad as any other.

Locked rows: Account (with Backups and Email), Advanced (with Plugins), Opie's check-ins, device control, Opie uses
apps, Now playing, Connections' Spotify and Google Play, and adding a linked device always; Voice, Connections' calendars,
Time, Email and removing a linked device while Change settings is on (the default). Not locked: what a household uses every day (Hey Opie, the voice, Family's names
and chores, night hours, devices, looking after things, putting things back).

A PIN set over adb (ConfigReceiver `--es pin`) turns the lock on the same way; an empty one turns it off.

## Back

Every back goes through Android's own back handling (OnBackPressedDispatcher, predictive back on in the manifest):
up one level, so a page in Settings goes back to its tab (on a phone, then to the list of tabs), then Settings
closes, and an app goes home.

- Kiosk mode hides Android's bars, so the system back gesture and button aren't there. Our own edge swipe stands in,
  shaped like Android's (in from the left or right edge, 70 dp, more sideways than up or down): over the home screen
  while something is open (Overlay.kt, EdgeBack), on every dialog (CalmDialog), and in apps (AppHost, AppWindow).
- In Settings, a page opened from a tab has a ‹ before its title (on a phone, every tab does, back to the list).
  Dialogs keep their Back button. No back on the home screen itself.
- The tablet's navigation mode isn't changed. If kiosk mode can let the real system gesture through cleanly, it's
  preferred over our copy; not tried on a real tablet yet.

## Words

Nothing shown says "parent", and "adult" only where it matters who: the PIN is "the PIN", the menu is Settings, and the assistant's rules
(bridge/CHAT.md, AGENT.md, WORKSHOP.md), its tools' answers and the connect pages say "someone at the tablet" or
"in Settings" instead.
