---
name: working-here
description: "How to work on this household's OpenHouse tablet from a computer: which tools to use, in what order, for the tabs and look, notes, an app, waiting fixes, undo and devices, and the rules. Load before changing anything on the OpenHouse."
---

# Working on OpenHouse from a computer

You are changing a family's OpenHouse: a tablet in their home whose home screen is a column of tabs beside
one sheet showing the chosen tab. Today is the day at a glance with the family's notes, Apps is a grid of every app
that isn't a tab of its own, and each other tab is one of the family's apps: a small web page in `apps/<id>/`. The
tabs it has now are in `get_guide`. Someone in the family is asking you from their own computer. The family may be
watching the tablet while you work: it shows your change being made.

## How to work
- Tabs and the look ("move photos first", "make it warmer", "take out meals"): one `set_home` call. No files.
- Notes on Home, lists, chores, meals, events: the note and household tools. No files.
- An app (new or changed), in this order:
  1. The `apps` skill (or `get_guide` with `topic: "apps"`): how apps are made here (calm everyday tools that fit a tab, games, the kit for
     the family's data, icons) and the quiet kit's CSS.
  2. `start_editing` with what was asked, in their words ("A whiteboard that looks like Chores").
  3. Read what you need with `list_files` and `read_file` (for an everyday tool, read `apps/chores/` first, and
     `kit/openhouse.js` for the family's data).
  4. `write_file` a new file, whole; `edit_file` (old text, new text) for a small change to one that's there. Every
     save shows on the tablet at once, so each one must load without errors.
  5. A new app goes in Apps (the grid of apps that aren't tabs). Don't add it to the sidebar yourself, even when they
     said "tab".
  6. `check_build` the app (for a new app in Apps it checks its files: each script parses, what `index.html` loads is
     there), then `look_at_tablet` to see it as the family will.
  7. `done_editing` last, with one plain sentence of what changed. Everything since `start_editing` becomes one change
     on the tablet. Always call it: until you do, the family's own assistant can't change apps.
  8. For a new app, then ask in one short line whether to put it in the sidebar too ("Want Maya's Ballpark in the
     sidebar?"). Only on a yes: `set_home` with the whole tab list and its id where it belongs.
- `show_on_tablet` puts the home screen on a tab ("today", "apps" or an app's tab), closing any app open full
  screen: leave the tablet on the home screen when you're done.
- Fixes waiting: the tablet notices when an app breaks and writes it down for whoever builds. `pending_fixes` lists
  them, each with its error and log. If they want one fixed (or ask what's broken), `start_editing` with
  its `fix` id, read the app, make the smallest change that fixes the cause, `check_build`, then `done_editing`: someone
   says yes on the tablet's PIN card before it goes in (if nobody does, it's put back out and still waits).
  `close_fix` closes one that isn't worth fixing. Mention waiting fixes once when you start, in a line.
- Undo, only when they ask to take something back (never mention or offer it otherwise): `undo_latest` (the latest
  change, whoever made it), `list_changes` then `undo_change` for an older one, or `undo_plugin` for the latest change
  to one app, keeping the rest.
- Every app is a plugin, and you never write a manifest. An app you make is the household's own plugin (its version
  counts its changes). Changing one of OpenHouse's own (Calendar, Chores…) makes the household's version, which our
  updates leave alone; `reset_plugin` puts ours back. `list_plugins` shows them all. `export_plugin` with `plugin`
  is how one is shared.
- An app can offer the voice an action in its `app.json`: `"actions": [{"name": "start", "description": "Start the
  pasta timer.", "parameters": {"properties": {"minutes": {"type": "integer"}}, "required": ["minutes"]}, "reply":
  "Pasta timer on."}]`. Its page does it with `onAction((name, args) => …)` from `/kit/openhouse.js`.

## Devices in the house

`list_devices` shows what the tablet found on the Wi-Fi and over Bluetooth, and what each can do (`device_action`).
For one it can't control yet, you can teach it: `device_info` first (for a Bluetooth one it reads the services inside
it), then `save_recipe` with a recipe from the device's own documentation (`"over": "bluetooth"` for a BLE device).
A recipe is data the tablet checks, never code; its first use asks the people at the tablet, and anything that turns
something on, opens or unlocks asks every time. Say where the protocol came from (`sources`).

## Rules
- Paths are relative to the apps folder (`apps/chores/main.js`). The tablet commits each change itself: there is no
  git, dev server or build step for you to run.
- Keep the change to what was asked; don't redesign the rest of an app on the way.
- The tabs and the look live in `apps/home/style.json`: change them only with `set_home`.
- Answer them as you normally would. If you had to guess something (a time, a name), say what you guessed.


---

# Changing the home screen

## Change what's there first
Most requests are about something they can already see: "make the chores bigger", "I don't like the meals tab",
"get rid of the photos", "make it warmer", "the calendar should start on Monday". The home screen as it is now (get_guide) says which tab the tablet is showing (an app, the Home tab or the Apps tab); "this" and "it" usually mean that.
- Reach first for the smallest change to what's there: the tabs or the look (one `set_home` call, nothing else),
  then the app they're looking at (its `main.js` or `index.html`). Make a new app only when they ask for something
  that doesn't exist yet.
- Removing is a change like any other: take the tab out with `set_home` (the app stays in the Apps tab), or delete the
  app's folder when they want it gone for good. The family's data is never in an app, so nothing they entered is lost.
- Keep the change to what they asked. Don't redesign the rest of the app on the way.
- Say what you changed in one short sentence. Don't mention or offer undo: when someone asks to take a change back, take it back.


## The home screen
The screen everyone sees is the display's own page (not code you edit): a column on the left with the time, the day
and the tabs, and one sheet beside it showing the chosen tab. A tab is Today (a card for each tab's most important bit, opening that tab, and one for your notes),
Apps (a calm grid of every app that isn't a tab of its own, and the Android apps added; a hold there makes
one a tab or takes it off), or one of the family's apps running right in the sheet. There is no board any more: no
widgets, no cells. The same screen shows on any other screen in the house (an old tablet, a frame).
You change it these ways, lightest first:
- Notes (`put_note`, `update_note`): they show on Home. Information (a list, a plan, a recipe) goes on a note, kept
  if they want it kept.
- `set_home`, for the tabs and the look ("move photos first", "add a homework tab", "make it warmer"): one call, done.
  Don't read or edit files for it, don't call `start_editing`, and there's nothing to check afterwards. Tabs are the
  whole list in order (the current ones are in get_guide): `today`, `apps` and app ids; an app that isn't a tab is
  in Apps. A new app goes in Apps first; once it's made, ask in one short line whether it should go in the sidebar,
  and add its id to the tabs only on a yes. Reuse an app only when it plainly is the thing they asked for (a
  "whiteboard" is not the kids' drawing studio): otherwise make a new one, and never say a tab can't be added. Palettes: `paper` (the usual), `linen` (warmer), `sage`,
  `mist` (cool), `dusk` (dark); `colors` for their own; `type`: `clean`, `serif`, `round`, `hand`; `density`: `calm`
  or `snug`; `backdrop`: `none` or `photos`.
- Something that has to keep changing by itself (a countdown, a live chart) or that they use: an app (a tab, or in Apps).
The assistant (the sticky note with a face, bottom right), what it hears and says, typing and the settings are drawn
by the display over the page. Leave that corner clear.



---

For the home screen as it is now (its tabs, look and apps, and which tab the tablet is showing), call get_guide with topic "home".

---

How notes on Home should read: the notes skill. Making or changing an app: the apps skill.

---

This copy of the OpenHouse guide is version b99689307304. If the OpenHouse connector's guide is another version (its instructions, or get_guide with topic "home", say which), use get_guide instead and tell the person once that the OpenHouse plugin needs updating.
