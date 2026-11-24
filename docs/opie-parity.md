# What Opie can do, next to what tapping can do

Aim: whatever someone can do by tapping the tablet, they can ask Opie (the live voice) to do. The exceptions are on
purpose: anything behind the PIN that guards against kids or against Opie itself, and anything a person must say yes
to (`DeviceServer.personOnly` in the shell). For those, Opie can at most open the right screen
(`show_on_screen`), and its taps there stop at the PIN pad or are refused.

Opie's tools: `LIVE_TOOLS` and the voice's own tools in `bridge/live-tools.js` (timer, weather, read_page, volume,
tablet_screen, home_devices, tv, bluetooth, message_family, show_on_screen, the apps' voice actions); the home screen's
in `bridge/home-screen.js` and `bridge/chat.js`; the house's in `bridge/house.js`; the map's in `bridge/maps.js`;
using the screen and other apps in `bridge/device-tools.js` (look_at_screen, tap, type, scroll: the fallback for
anything without a tool of its own, in OpenHouse's own screens even with "Opie uses apps" off). Typed turns get the
same tools (`chat.js` textTools).

Key: **yes** a tool does it; **screen** only by opening the screen and tapping there; **no, on purpose** stays a
person's; **new** closed by this change.

## Home screen and Today

| Tapping | Opie | Notes |
| --- | --- | --- |
| Open a tab or app | yes | show_on_screen |
| Tabs: add, remove, order, rename; the look (palette, colours, type, density, photo backdrop) | **new** | set_home (it was typed-only; "Tabs and look" has no PIN) |
| Today's app cards on or off | yes | today_card |
| Timers: start, +/− minutes, clear | yes | timer (a changed time is cancel and start) |
| Today's lines (things): take one down | yes | take_down_thing |
| Notes: open, take down | yes | look_at_notes, take_down_note; put_note and update_note too |
| Put back a note taken down, or an app taken off Apps | **new** | put_back (was typed-only) |
| Take an app off the Apps tab | screen | Rare; hold the tile, Take it off Apps |
| "Undo that" (an app, the tabs or the look) | **new** | undo_change "latest" or by id, list_changes (the voice had no undo; never offered, only done when asked) |
| Meals card: plan tonight's dinner | yes | set_meals |
| Lists card: tick, untick, add | yes | change_list |
| An app's day notes: week, today only, off | **new** | calendar_event settings.app_notes |
| Sleep now (the moon) | **new** | tablet_screen sleep |

## The built-in apps

| App: tapping | Opie | Notes |
| --- | --- | --- |
| Calendar: add, change, remove (a day or all), countdown, reminder on any event | yes | calendar_event |
| Calendar: which calendar a new event goes in | yes | calendar_event add.calendar |
| Calendar: the usual reminder and saying it aloud (the bell) | **new** | calendar_event settings |
| Calendar: an event from a flyer photo sent from a phone | **new** | flyer_photo (was typed-only), then calendar_event |
| Calendar: Add a calendar | yes | add_calendar; the tablet asks for the PIN |
| Calendar: unlock with the PIN | no, on purpose | The PIN is a person's |
| Chores: done / not done, who did an Anyone chore, add, change (who, days, every N days, stars, picture, stays until done), skip, remove | yes | change_chores |
| Chores: rewards add, remove | yes | change_rewards |
| Chores: spend stars on a reward (Get it!) | no, on purpose | The kid asks on the tablet and a grown-up says yes with the PIN |
| Chores: routines add, change, remove, tick a step | yes | change_routines |
| Lists: tick, add, edit, whose, remove, clear checked, new list, rename, delete list | yes | change_list |
| Lists: by store section or in the order added | **new** | change_list byAisle |
| Lists: send to a phone (QR) | screen | The QR card is for the phone in someone's hand; message_family sends text |
| Map: save a place, Home, remove one, show one | yes | save_place, forget_place, show_on_map |
| Meals: plan, clear, favourites, which meals to plan, recipe per meal, ingredients to groceries | yes | set_meals; recipes__ingredients then change_list |
| Meals / Recipes: "Write it for me", add a recipe from a paste or idea | screen | Typing a recipe in is easier there; save_recipe takes a link, set_meals notes takes text |
| Recipes: search the web, choose, cook, steps, timers, take a recipe out | yes | the Recipes app's voice actions (recipes__*), save_recipe, set_meals |
| Photos: take off, put back, caption | **new** | photos |
| Photos: albums: new, rename, put photos in or out, sleep screen and All, remove | **new** | photos album |
| Photos: add photos or an iCloud album | yes | Photos come from a phone; add_photo_album asks for the PIN |
| Photos: stop keeping an iCloud album | screen | On its card in Photos |
| Weather: where home is | **new** | update_household location (was typed-only) |
| Whiteboard: draw, clear, save | no | Drawing is the finger's; the board stays on that device |
| TV app | yes | tv (the app itself only shows the week) |

## Settings (the gear)

| Row | Opie | Notes |
| --- | --- | --- |
| Voice (the voice, Hey Opie, the microphone) | no, on purpose | Locked: it costs money and it's Opie's own off switch |
| Family: who, ages or roles, colours, where, chores | **new** | update_household (was typed-only). Leaving someone out of the list is refused unless they're named in taking_off |
| Calendars: accounts, shown or not, two-way, whose, where new events go | no, on purpose | Locked; adding one by link is add_calendar with the PIN |
| What Opie remembers | yes | remember_preference, forget_preference |
| Linked devices: pair or remove a screen, phone, computer, TV | no, on purpose | Locked (Add and Remove) |
| Linked devices: the house's speakers, streamers, printers and their buttons | **new** | home_devices (tv, bluetooth and volume were already there); turning on or opening something asks the room first |
| Brightness | **new** | tablet_screen (Settings' row has no PIN) |
| Email: turn on, allow a held email, who's read | no, on purpose | personOnly |
| Account: link, backups, reach from away | no, on purpose | Locked |
| Advanced: PIN Lock, Updates, Plugins, Opie uses apps, home network, cloud address, USB debugging, Android settings, leave kiosk mode | no, on purpose | Locked, and personOnly where it widens what Opie may do or leaves OpenHouse |
| Advanced: check-ins (how often, what they look for) | yes | heartbeat_settings |
| Night hours | yes | night_hours |
| Volume (no row: the tablet's buttons) | yes | volume |
| Plugins: add, update, remove | no (voice) | The gallery is behind the PIN; a typed turn or a computer can ask (add_plugin), and the tablet still asks for the PIN |

## The phone page

| Tapping | Opie | Notes |
| --- | --- | --- |
| Today and the apps (the same actions as the tablet) | yes | The same tools, from the phone's own Opie |
| Ask Opie, share text or a link to Opie | yes | That is Opie |
| Turn notifications on, add to home screen, the iPhone shortcut | no | The phone's own permissions, given by the person holding it |
| Setup: a calendar link and whose it is, an album, invite someone | yes / no | add_calendar takes who; inviting someone uses the phone's share sheet, so it stays there |

## Open question

- **The calendar's PIN lock.** With "Calendar needs the PIN" on, the Calendar app can't change events without the
  PIN, but Opie's calendar_event still can, so a child can ask Opie for what they couldn't tap. Not changed here:
  either Opie honours the lock (and asks for the PIN on the tablet first, as add_calendar does) or the lock is only
  about the app. That is the household's call.
