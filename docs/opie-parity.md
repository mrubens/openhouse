# What Opie can do, next to what tapping can do

Aim: whatever someone can do by tapping the tablet, they can ask Opie (the live voice) to do. Something behind the
PIN is no reason for Opie to refuse: it does it, and the tablet asks a person for the PIN (a card with the PIN pad, as
add_calendar has always done; or, on a locked Settings row it opens, the row's own PIN pad). Opie says "type the PIN on
the tablet", and from a phone, that it's on the tablet itself. The rules that don't bend:

- The PIN is only ever typed by a person on the tablet. Opie never sees it, never takes it from what someone says,
  and nothing it does lands while a PIN pad is up (`DeviceServer.ownPrivate`); its tools can't answer the card
  (one tool runs at a time, and the card's own call is the one waiting).
- While a card that waits for a person's answer is up (the "Is this OK?" card, a device asking to pair, a calendar or
  album link someone sent, the account that entered the link code: `ui/PersonCards.kt`), every device tool is refused, reading the screen included, and Opie
  tells them it's theirs to answer. The card's yes also takes only a real touch, not an injected one.
- What is person-only (`DeviceServer.personOnly`: turning on email, allowing a held email, Opie uses apps and other
  switches that widen what Opie may do, ways out of Opie, saying yes to a calendar or album someone sent, or to the account that entered the link code, keeping an app made on the tablet) needs a
  person's own tap, PIN or not. Opie can open the screen; the tap is theirs.
- Which everyday things ask for the PIN (Settings → Advanced → Ask for the PIN, docs/settings.md): Opie changes a
  switch only when asked (`pin_choices`), and the tablet asks for the PIN on its own card; the switch itself is a
  person's own tap. A switch that's off means a person's plain yes, never Opie's.
- PIN Lock itself (turning it off, changing the PIN, Forgot PIN? and its Reset with your account, whose code card is
  a person card with the PIN pad's mark) and leaving kiosk mode: Opie only opens the screen. Asking Opie to
  take off the lock that guards against Opie makes no sense, and leaving kiosk mode takes the tablet out of Opie.

`test/house.test.mjs` checks the PIN can't be got round: Opie's change to a locked calendar or a reward goes through
the card, naming its switch, and a no (or no card) leaves things as they were. The shell's `PinChoicesTest` checks a
switch that's on still asks, what isn't a switch always asks and can't be turned off, and changing one takes the PIN.

Opie's tools: `LIVE_TOOLS` and the voice's own tools in `bridge/live-tools.js` (timer, weather, read_page, volume,
tablet_screen, home_devices, tv, bluetooth, music, message_family, show_on_screen, the apps' voice actions); the home screen's
in `bridge/home-screen.js` and `bridge/chat.js`; the house's in `bridge/house.js`; the map's in `bridge/maps.js`;
using the screen and other apps in `bridge/device-tools.js` (look_at_screen, tap, type, scroll: the fallback for
anything without a tool of its own, in Opie's own screens even with "Opie uses apps" off). Typed turns get the
same tools (`chat.js` textTools).

Key: **yes** a tool does it; **screen** only by opening the screen and tapping there; **no, on purpose** stays a
person's; **screen, with the PIN** Opie opens it and carries on once someone types the PIN; **new** closed by this change.

## Home screen and Today

| Tapping | Opie | Notes |
| --- | --- | --- |
| Open a tab or app | yes | show_on_screen |
| Tabs: add, remove, order, rename; the look (palette, colours, type, density, photo backdrop) | **new** | set_home (it was typed-only); Opie only since 2026-11-26: Home has no panel for it |
| Home's cards: order, on or off (Opie only since 2026-11-26) | **new** | set_home today (the order and which show), today_card (an app's own card) |
| Home's own cards one at a time: the Whiteboard, a recipe to try, Dinner, Groceries… on or off | **new** | today_card with the card's name (whiteboard, recipes, meals, lists…), keeping the rest of the household's order |
| Home's empty cards: "Add a shared calendar", "Add your photos", a recipe to try | yes | add_calendar, add_photo_album; recipes__cook opens a recipe |
| Timers: start, +/− minutes, clear | yes | timer (a changed time is cancel and start) |
| Alarms: add, change, turn on or off, delete, snooze, stop (Home's clock, the phone page, the ringing screen) | yes | alarm |
| Today's lines (things): take one down | yes | take_down_thing |
| Notes: open, take down | yes | look_at_notes, take_down_note; put_note and update_note too |
| Put back a note taken down, or an app taken off Apps | **new** | put_back (was typed-only) |
| Take an app off the Apps tab | screen | Rare; hold the tile, Take it off Apps |
| An Android app in Apps: float its video over Home, or not (hold the tile) | **new** | video_app; the device asks for the PIN itself when Add apps asks for it, as the hold menu does |
| "Undo that" (an app, the tabs or the look) | **new** | undo_change "latest" or by id, list_changes (the voice had no undo; never offered, only done when asked). An undo that brings back what a plugin's app was granted (its removal taken back) brings the app back without it, and the tablet's card asks to give it back (the PIN when Add apps asks) |
| Meals card: plan tonight's dinner | yes | set_meals |
| Lists card: tick, untick, add | yes | change_list |
| An app's day notes: week, today only, off | **new** | calendar_event settings.app_notes |
| Sleep now (the moon) | **new** | tablet_screen sleep |
| Make a new app or game, or change one ("make the text on Chores bigger"), on the tablet itself | **new** | make_app (the typed assistant starts it too): the builder makes it on rails (`bridge/rails.js`), and it opens on the tablet; a new or limited app that gets no family things or websites goes straight in (with Add apps off), otherwise it goes in only on a person's Keep it there (with the PIN when Ask for the PIN → Add apps is on; the card then also names what it may use and any exact websites it asked to reach). A change to one of the household's own apps (every right) always opens with Keep it, one tap. Asked for from a "later" run, a change that needs a Keep it waits on Home for a person instead (and those runs have no make_app). Opie can't keep it (docs/building-on-the-tablet.md) |
| Home: "… is ready to try" (an app made on the tablet nobody kept yet): open it to try again | **new** | try_made_app opens it with its bar; Keep it stays a person's own tap (with the PIN when Add apps asks), never Opie's |

## The built-in apps

| App: tapping | Opie | Notes |
| --- | --- | --- |
| Calendar: add, change, remove (a day or all), countdown, reminder on any event | yes | calendar_event |
| Calendar: which calendar a new event goes in | yes | calendar_event add.calendar |
| Calendar: the usual reminder and saying it aloud (the bell) | **new** | calendar_event settings |
| Calendar: an event from a flyer photo sent from a phone | **new** | flyer_photo (was typed-only), then calendar_event |
| Calendar: open the photo or email a waiting event came from (From) | photo yes, email no, on purpose | flyer_photo shows the photo; family_things has the waiting events and whose email each came from, never the email itself (docs/tablet-email.md, Safety) |
| The household's email address (Settings → Account → Email; the phone page's Copy; an empty Calendar or Photos) | **new** | family_things email |
| Calendar: Add a calendar | yes | add_calendar; the tablet asks for the PIN |
| Calendar, with Ask for the PIN → Change the calendar on: any change | **new** | calendar_event asks; the tablet's card takes the PIN, then the calendar is open for 5 minutes, as after the app's unlock. A computer's workshop isn't asked |
| Chores: done / not done, who did an Anyone chore, add, change (who, days, every N days, stars, picture, stays until done), skip, remove | yes | change_chores |
| Chores: rewards add, remove | yes | change_rewards |
| Chores: spend stars on a reward (Get it!) | **new** | change_rewards redeem: the same card as Get it!, an adult's yes on the tablet (with the PIN when Give rewards asks) |
| Chores: routines add, change, remove, tick a step | yes | change_routines |
| Chores: a step's time (tap a step in Routines) | **new** | change_routines times (or minutes on a step) |
| Chores: Start a routine (the player, a step at a time), Done, close it | **new** | chores__play (the Chores app's voice action: opens its tab, the routine and whose turn), change_routines check (the player moves on as Done would), chores__stop |
| Lists: tick, add, edit, whose, remove, clear checked, new list, rename, delete list | yes | change_list |
| Lists: by store section or in the order added | **new** | change_list byAisle |
| Lists: send to a phone (QR) | screen | The QR card is for the phone in someone's hand; message_family sends text |
| Map: save a place, Home, remove one, show one | yes | save_place, forget_place, show_on_map |
| Meals: plan, clear, favourites, which meals to plan, recipe per meal, ingredients to groceries | yes | set_meals; recipes__ingredients then change_list |
| Meals / Recipes: "Write it for me", add a recipe from a paste or idea | screen | Typing a recipe in is easier there; save_recipe takes a link, set_meals notes takes text |
| Recipes: search the web, choose, cook, steps, timers, take a recipe out | yes | the Recipes app's voice actions (recipes__*), save_recipe, set_meals |
| Photos: take off, put back, caption | **new** | photos |
| Photos: albums: new, rename, put photos in or out, sleep screen and All, remove | **new** | photos album |
| Photos: add photos or an iCloud album | yes | Photos come from a phone; add_photo_album asks a person's yes (with the PIN when Add photo albums asks) |
| Photos: stop keeping an iCloud album | screen | On its card in Photos |
| Weather: where home is | **new** | update_household location (was typed-only) |
| Whiteboard: draw, clear, save | no | Drawing is the finger's; the board stays on that device (a small picture of it shows on Home's card) |
| Recipes: take a starter recipe out | yes | remove_recipe; a new household's box starts empty (since 2026-11-28), and boxes that got Opie's starters before keep them until taken out |
| TV app | yes | tv (the app itself only shows the week) |
| A media app from Apps (music, audiobooks, podcasts): play something, pause, skip, back 30 seconds, what's playing | **new** | music (docs/music.md): plays from a search in the app, or opens one that can't take a search; the system's own media apps open only for someone, as from Apps |

## Settings (the gear): the tabs Household, Opie, Connections, Screen, Devices, Account, Advanced

| Row | Opie | Notes |
| --- | --- | --- |
| Opie → Voice (the voice, Google's or OpenAI's, Hey Opie, the microphone) | screen, with the PIN | Opie opens the row and the tablet asks for the PIN (while Change settings asks); then it chooses there |
| Opie → House rules (how Opie answers here: the defaults until the household edits them; Defaults puts them back) | **new** | house_rules: get reads them; set and defaults put the tablet's own card up, a person's yes with the PIN when one is set, whatever the PIN choices say (Opie can't tell who is asking); a no leaves them |
| Opie → Talk to Opie ("Hey Opie" or Tap to talk), and the setup's line for it | **new** | hey_opie: get, on, off (no PIN, as the row). Turned off from a conversation, that conversation carries on; the next needs a tap |
| Opie → Check the microphone (does Opie hear you: the level, then "Hey Opie", and too quiet, too noisy or blocked) | **new** | mic_check: start puts the check on the screen (no PIN: it changes nothing); from the tablet's own voice the conversation ends first so the check can have the microphone, typed or from a phone it waits for the answer; last says how the last one went |
| Opie → Voice → This month (minutes talking to Opie, typed questions, apps made or changed, about what it cost) | **new** | how_much_used: the same lines, the household's as the cloud counts them with Opie's voice, this tablet's on the household's own OpenAI key |
| Opie → Voice → Opie credit left (and the account page's balance) | **new** | how_much_used says what's left and the price a minute. Adding credit and auto top-up are on the account page, a person paying with their own card: not Opie's |
| "Turn on Opie?", asked once when a linked household's voice becomes available and nobody here had said yes | no, on purpose | personOnly: it's the yes to what goes to OpenAI (and the voice is off then, so there's no Opie to ask) |
| The first setup's Allow for the phone or computer that used its code | no, on purpose | A person's own tap (setForPerson), as pairing is: it says who may do the setup. The setup is quiet throughout, so there's no Opie to ask |
| The first setup's Choose a PIN | no, on purpose | As PIN Lock: Opie can't choose or see a PIN, and the setup is quiet throughout, so there's no Opie to ask |
| The first setup's calendar and photos steps | yes, by link / no for sign-ins | add_calendar and add_photo_album take a link, as anywhere (the tablet asks a person's yes); signing in to Google or iCloud stays on the screen, as in Settings → Connections. Typing to Opie waits until the setup is done |
| The first setup's Two of Android's settings: Let Opie use other apps, Stop charging at 80% | no, on purpose | Both are Android's own pages, outside Opie (kiosk mode left, behind the PIN if one was chosen), and device control is personOnly; the setup is quiet throughout, so there's no Opie to ask |
| The end of the first setup's Opie is ready: OK, Turn off | yes, by the Voice row | OK only closes it. Turn off is Settings → Opie → Voice's Off: Opie opens the row and the tablet asks for the PIN (as Voice above). The voice coming on there follows the person's Done, the setup's last tap |
| Ask for Opie's voice (Settings → Opie → Voice, while the household doesn't have it) | no, on purpose | Until the household has the voice there's no Opie to ask; once it does, the ask is done |
| Your own OpenAI key: put in, change, remove (Settings → Opie → Voice, or Today's **Add a key** card while there's no voice; a hub's settings page) | no, on purpose | A secret Opie must never see or hear; an adult sends it from a phone on the Wi-Fi (the QR code, sealed straight to the shell), types it on the tablet, or pastes it on a hub's settings page, behind the PIN. Putting it in is personOnly. While there's no voice there's no Opie to ask |
| Your own OpenAI key → Monthly stop ($5 to $200, $20 to start) | **new**, screen, with the PIN | Opie opens the row (or Today's card once the stop is reached) and the tablet asks for the PIN; the choice is the person's there. how_much_used says this month's cost against the stop |
| Your own keys → Gemini key: put in, change, remove (Settings → Opie → Voice; a settings page's `/setup/gemini`) | no, on purpose | As the OpenAI key: a secret Opie must never see or hear, sent by the QR code, typed on the tablet, or sent from a settings page with a person's yes on the tablet that names Google. Putting it in is personOnly |
| Your own keys → Gemini key → Monthly stop ($5 to $200, $20 to start) | screen, with the PIN | As the OpenAI key's stop: Opie opens the row (or Today's card once it's reached), and the person chooses there. how_much_used names Google's cost against it || Backups → Your own storage: set up, change, remove (a bucket's address and key) | no, on purpose | Its secret is one Opie must never see or hear, as the OpenAI key: an adult enters it on a phone or computer on the Wi-Fi (the QR code), on the tablet, or on a hub's settings page. Opie can open Backups (screen, with the PIN, as for the rest of Account); turning it on or off once it's set up is that screen's |
| Household: who, adult, kid or pet, ages or notes, colours, where, chores | **new** | update_household (was typed-only; kind since 2026-11-27). Leaving someone out of the list is refused unless they're named in taking_off |
| Connections → Calendars: accounts, shown or not, two-way, whose, where new events go | screen, with the PIN | Opie opens the tab, the tablet asks for the PIN (while Change settings asks), Opie carries on there; adding one by link is add_calendar |
| Connections → Photo albums: add, remove | yes / screen | add_photo_album asks a person's yes (with the PIN when Add photo albums asks); Remove is on the screen, as Stop keeping it here in Photos |
| Opie → What Opie remembers | yes | remember_preference, forget_preference |
| Devices: pair or remove a screen, phone, computer, TV; cancel an invite nobody has opened | screen, with the PIN | Add, Remove and Cancel ask for the PIN; the pairing code itself is shown for the person's own device |
| Devices → Add → Another Opie tablet: the code another tablet scans to join this household (docs/multi-tablet.md) | screen, with the PIN | Opie opens it (Settings → Devices → Add); the tablet asks for the PIN; the code is for the person standing at the new tablet |
| Advanced → Add this device to another Opie; on a tablet that's part of another's household, Household → Leave the household | no, on purpose | personOnly, as pairing and Tailscale are: it changes which household this tablet shows and hears for. Opie can open the row; the tap, the code and the PIN are a person's |
| On a tablet that's part of another's household: Opie's own tools for that tablet (its screen, volume, camera, media, other apps) | not yet | Its conversations run with the main tablet's tools, which would act on the main tablet: those are left out there (live-tools.js ON_THIS_DEVICE), and Opie says so. Phase 2 of docs/multi-tablet.md sends them to the tablet they're at |
| Devices: the house's speakers, streamers, printers and their buttons | **new** | home_devices (tv, bluetooth and volume were already there); turning on or opening something asks the room first |
| Devices → Home Assistant: the lights, switches, scenes and media players picked for Opie, their buttons; a thermostat's reading | **new** | home_assistant (on, off, brightness, play, pause, volume, status...), or home_devices; turning a switch or a media player on asks the room first. Locks, garage doors, alarms and cameras aren't reachable by anyone through Opie, and thermostats aren't changed |
| Devices → Home Assistant → Choose what Opie may use (on a hub: its settings page) | **new** | home_assistant use / stop_using: Opie's ask is a card a person answers on the device, with the PIN when the lock is on; things lists what could be picked |
| Devices → Home Assistant → Connect (its address and long-lived token), Connect again, Disconnect | screen, with the PIN | home_assistant connect puts the screen up; the token is a secret Opie must never see or hear, so a person types it there or sends it from a phone on the Wi-Fi (the QR code, sealed straight to the shell): personOnly. On a hub, connect opens the settings page's Home Assistant section (on the settings devices that have it open); the token is typed there and kept by the keeper after a yes on its card, with the PIN. As the Home Assistant add-on it's connected already: the section has only what Opie may use |
| Screen → Brightness | **new** | tablet_screen (Settings' row has no PIN) |
| Screen → Volume: the level, Adjust to the room | **new** | volume (set, louder, quieter, mute; room_on, room_off). Settings' row has no PIN |
| Account → Email: turn on, allow a held email, who's read | no, on purpose | personOnly (turning it off: screen, with the PIN) |
| Account: link, backups, reach from away | screen, with the PIN | Opie opens the row; the tablet asks for the PIN. The yes to the account that entered the code is personOnly |
| Updates (the version under the tabs, no PIN); Advanced: home network, cloud address, speech log | screen, with the PIN | Opie opens it; the tablet asks for the PIN |
| Advanced → Ask for the PIN: a switch on or off (Add apps, Add photo albums, Change the calendar, Give rewards, Change settings) | **new** | pin_choices: get says each and what always asks; set puts the tablet's own card up ("Stop asking for the PIN to add apps?"), which takes the PIN typed by a person (a real finger within the two minutes after it), and a no leaves it. Opie's tap on the switch in Settings is refused (personOnly). With no PIN set it says nothing asks |
| What always needs the PIN: these switches, PIN Lock, Advanced, Account and Backups, adding a linked device, the ways out of Opie, erasing, a plugin update from somewhere new | no, on purpose | Not a switch: pin_choices says so and can't turn them off. They change who reaches the household, widen what Opie may do, or leave Opie |
| Advanced: PIN Lock, leave kiosk mode, Erase this device | no, on purpose | Opie only opens the screen (above); with no PIN set, erase and the ways out (Wi-Fi settings after the first setup, Unlink, Restore too) ask a person to set one first, which outside the first setup needs the tablet linked to an account |
| Advanced: Restart Opie's software (Restart, or Reset to put it back as it came) | screen, with the PIN | Opie can open Advanced (the tablet asks for the PIN); the tap is the person's, since it stops Opie itself mid-answer |
| The starting screen's Settings (after a minute with Opie's software not answering): Wi-Fi, an update, Restart, Leave kiosk mode, Erase | no, on purpose | It's there only while Opie's software isn't running, so there's no Opie to ask. The same rows as elsewhere, with the same PIN |
| Advanced: "Opie's software was stopped by Android" | no, on purpose | A line of information, not an action; the steps for the child-process limit end on Android's own Developer options, outside Opie, behind the PIN |
| Join Wi-Fi (the "Not on Wi-Fi" note): a nearby network and its password, no PIN | no, on purpose | It's for a tablet that's offline, when Opie (the cloud's) can't be reached. Its Wi-Fi settings button is a way out, as above |
| The PIN's recovery code: shown when a PIN is chosen, Forgot PIN?, PIN recovery code | no, on purpose | Like the PIN: only a person sees or types it. Its card and box count as a PIN pad (nothing Opie does lands while they're up) and "I've kept it" takes a real finger. Opie can open the PIN pad; Forgot PIN? is the person's |
| Opie: Opie uses apps, device control; Advanced: USB debugging, Android settings | no, on purpose | personOnly: they widen what Opie may do or leave Opie |
| Advanced: Tailscale (turn on, sign in, an auth key, turn off) | no, on purpose | personOnly, as pairing is: it changes who can reach the tablet, from anywhere, and signing in is the person's own Tailscale account (its login opens on their phone; an auth key is pasted by a person). Opie can open Advanced (the tablet asks for the PIN); the row itself refuses Opie's tap. A hub's settings page has the same, for a person on a settings device |
| Opie → Check-ins (how often, what they look for) | yes | heartbeat_settings; new instructions (what they look for) put the tablet's card up first, showing them, with the PIN when Change settings asks |
| Night hours | yes | night_hours |
| Volume (no row: the tablet's buttons) | yes | volume |
| Opie → Now playing (shown while Opie can't see what the media apps play) | no, on purpose | personOnly: it widens what Opie may see; Android's own page, with the PIN |
| Plugins: find, look at, add, update, remove | **new** | find_plugins, look_at_plugin, add_plugin, update_plugin, remove_plugin: each change asks on the tablet (with the PIN when Add apps asks; an update from somewhere new always) |
| Signing in to Spotify for the tablet's own player (Settings → Connections → Spotify) | done | music `spotify_sign_in` puts Spotify's sign-in page on the screen; the person types there |
| An Android app from Apps → Add apps (its Google Play results and "Music and books" suggestions): its Google Play page | done | install_app opens the same page, after a card on screen (the PIN when Add apps asks). Install, Buy and everything else on Google Play stay the person's taps: Opie never taps or types there (DeviceRules.handsOff), and open_app never opens a store (DeviceRules.neverOpen) |
| Apps → Add apps → Open Google Play: Google Play to look around in | yes | install_app opens a named app's page the same way; looking around and everything inside Google Play stay the person's taps (DeviceRules.handsOff) |
| Apps → Add apps: an app already on the device (its Google Play result says On this device), into Apps and open | yes | open_app opens it and adds it to Apps; one of the device's own (a browser, Files) takes a person's yes on the card first, with the PIN when one is set, as the tap does |
| Connections → Google Play: sign in, sign out | no, on purpose | personOnly: it puts a real Google account on a shared screen, and the password is the person's. install_app says where to sign in when nobody has |
| Connections → Google Play: Show or Hide Google apps (Gmail, Photos, Drive, Contacts, Calendar, hidden while an account is signed in) | no, on purpose | personOnly, behind the PIN: showing them opens a person's mail and photos on a shared screen |

## The phone page

| Tapping | Opie | Notes |
| --- | --- | --- |
| Today and the apps (the same actions as the tablet) | yes | The same tools, from the phone's own Opie |
| Ask Opie, share text or a link to Opie | yes | That is Opie |
| Turn notifications on, add to home screen, the iPhone shortcut | no | The phone's own permissions, given by the person holding it |
| Setup: a calendar link and whose it is, an album, invite someone | yes / no | add_calendar takes who; inviting someone uses the phone's share sheet, so it stays there |

## A hub's settings page (docs/hub.md)

| What someone taps | Opie | How, or why not |
| --- | --- | --- |
| Add a calendar or an iCloud album | yes | add_calendar, add_photo_album: a card on the settings page asks a person (the PIN for an album, once one is set) |
| Answer an "Is this OK?" card, type the PIN, set or change it | no, on purpose | A person's own tap on a settings device; Opie never sees the PIN |
| Their own OpenAI key in or out | no, on purpose | The key is typed by a person and goes straight to the keeper |
| Remove a calendar or an album | no | On the settings page only for now (on a tablet it's Settings too) |
| Sign in to iCloud or Google calendars, choose which show, pick Google Photos | no, on purpose | A sign-in is typed or done by a person, as on the tablet |
| Listen for "Hey Opie" on a screen, Go back to the version before | no | The screen's own microphone permission; Go back is on the settings page only |
