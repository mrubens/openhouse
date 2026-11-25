# Settings

The rules for every dialog, card and setting are in [ux.md](ux.md).

One list, short words, the current value instead of an explanation. An optional PIN locks some rows. Opening a row
and changing something comes back to the list; Back goes up one level, Done closes.

## The list (ui/Sheets.kt, `SettingsSheet`; values from shell/SettingsLock.kt)

One narrow column, six rows, so Settings isn't visually chaotic:

| Row | Shows | Opens | Locked |
| --- | --- | --- | --- |
| Voice | Off, or the voice's name | Off, or one of OpenAI's voices: a voice turns on the live voice and Hey Opie together (linking first if need be); Off turns both off, and the microphone | yes |
| Family | the names | Family: who, where, chores | |
| Calendars | how many are shown | Google and iCloud accounts (each one's calendars: shown or not, two-way, whose, where new events go) and calendars' links; Add a calendar | yes |
| What Opie remembers | how many | what it keeps, and a few lines for each day; tap one to forget it (bridge `/memory`) | |
| Linked devices | how many | paired screens, TVs, phones and computers (Add, Remove), then the house's TVs, speakers and printers | Add and Remove |
| Account | the family's name, or Off | link or unlink, Backups (the cloud or a USB drive), reach from away | yes |
| Advanced | | Lock and updates (PIN Lock, Updates, Plugins); Opie (device control, Opie uses apps, check-ins); For developers (home network, cloud address, speech log, USB debugging, Android settings, leave kiosk mode) | yes |

"Tabs and look" stays its own button beside the gear (and holding a tab): it is the home screen's, already has no
text, and is used more than any of the above.

## What happened to each old setting

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
  photos; a linked album's card there has Stop keeping it here. No Settings row.

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
  the lock itself; tablets from before have it turned off once.)
- Removed: **cut**, from the apps and the settings. Taken-off things stay in the bridge; Opie can put one back when asked.
- Grown-ups: **gone**. Its rows are in the one list.

The old Grown-ups menu (shell/ParentMenu.kt, now shell/SettingsLock.kt):
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
- Updates: kept, locked, shows the version.
- This tablet: kept, locked, shorter:
  - Change the parent PIN: now the **Lock** row.
  - Use fingerprint: **cut** (later round).
  - Android settings, Speech log, USB debugging, Leave kiosk mode: kept.
  - Device control: moved here.
  - Reload the screen: **cut** (a restart does it; add back if asked).

First run:
- The "Choose a parent PIN" sheet: **cut**. No PIN by default; the welcome screen comes first.

## The lock

One switch, PIN Lock: Off or On.

- **Off (the default):** nothing asks for a PIN. Things that lead out of the home screen (leaving kiosk mode, Android
  settings, an app store or a system app, adding an Android app) still ask "Is this OK?" with a Yes, so nobody
  leaves by accident, but anyone can say yes. In This tablet, erasing the tablet, leaving kiosk mode, Android
  settings, turning on USB debugging and turning on device control (which opens Android's settings) ask someone to set
  a PIN first, so taps alone never reach them; once it's chosen they go on as with the lock on.
- **On:** turning it on chooses a PIN (typed twice). Rows marked with a small lock ask for it, then stay open for two
  minutes as before. The same PIN is the yes on the "Is this OK?" card for the
  ways out above, for adding apps, for a reward that needs a yes, and for changing the calendar.
- Turning it off asks for the PIN, then forgets it.

Locked rows: Voice, Screens and computers, Account, Backups, Plugins, Updates, This tablet, and Calendars. Not locked: what a household uses every day (Hey Opie, the voice, Family's names
and chores, night hours, devices, looking after things, putting things back).

A PIN set over adb (ConfigReceiver `--es pin`) turns the lock on the same way; an empty one turns it off.

## Back

Every back goes through Android's own back handling (OnBackPressedDispatcher, predictive back on in the manifest):
up one level, so a sheet opened from Settings goes back to the list, then Settings closes, and an app goes home.

- Kiosk mode hides Android's bars, so the system back gesture and button aren't there. Our own edge swipe stands in,
  shaped like Android's (in from the left or right edge, 70 dp, more sideways than up or down): over the home screen
  while something is open (Overlay.kt, EdgeBack), on every dialog (CalmDialog), and in apps (AppHost, AppWindow).
- A sheet opened from Settings has a ‹ at its top left, for people who don't know the gesture. Dialogs keep their
  Back button. No back on the home screen itself.
- The tablet's navigation mode isn't changed. If kiosk mode can let the real system gesture through cleanly, it's
  preferred over our copy; not tried on a real tablet yet.

## Words

Nothing shown says "grown-ups" or "parent": the PIN is "the PIN", the menu is Settings, and the assistant's rules
(bridge/CHAT.md, AGENT.md, WORKSHOP.md), its tools' answers and the connect pages say "someone at the tablet" or
"in Settings" instead.
