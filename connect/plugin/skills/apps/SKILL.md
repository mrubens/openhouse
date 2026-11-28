---
name: apps
description: "How apps are made on Opie, before making or changing one: everyday tools that fit a tab, games, the kit for the household's data, icons, app.json, the quiet kit's CSS and how a tab should look."
---

# How apps are made on Opie (paths are relative to the apps folder)

## The screen
- A 10.9" landscape touchscreen (2304x1440) on a wall or counter, viewed from across the room.
  Big text, big tap targets. 8 GB RAM.
- No colored stripe down one side of a card or row (border-left accents). Show color with a
  tint, a dot or the text itself. No emoji as icons in the UI; draw icons (inline SVG). No sparkle symbols. The assistant is the sticky note with a face, bottom right.


## Note or app?
- Something to read or keep (a recipe, a plan, a list for today): a note, on Home.
- Something that has to keep changing by itself (a countdown, a live chart): an app, in Apps, and in the sidebar if
  they say yes when you ask.
- Anything you open and use or play (a game, a quiz, a drawing pad, a tool): an **app** (below). It runs full
  screen as its own installed Android app with an icon in the Apps tab, and opens automatically while you build it.
  If they're looking at one (the request says so), changes like "make it faster" or "add a high score" are for
  that one.
- To **delete** an app or game ("get rid of Snack Attack"), remove its whole folder `apps/<id>/`
  and nothing else. The display takes it out of Apps and uninstalls it, and "undo"
  brings it back. Never delete `apps/home`. If it isn't clear which one they mean, change nothing
  and say which apps there are.


## The family's things: calendar, chores, lists, meals, photos
The display starts with these apps: `apps/calendar`, `apps/chores`, `apps/lists`, `apps/meals`, `apps/photos`,
`apps/recipes`, `apps/map`, `apps/weather`, `apps/whiteboard` and `apps/tv` (the TV's). They're ordinary apps: change them like any other ("make the calendar show two weeks" is an edit to
`apps/calendar/main.js`), and deleting one is deleting its folder. Their data is not in their code: it lives in the
bridge, so an edit or a delete never loses the family's events, chores, lists or meals. Keep it that way, and use the
same data in any new app that needs it, through the kit (version 2: a new app's `app.json` says `"kit": 2`; an app that names no kit gets version 1, `docs/kit.md`):
`import { house, store, timer, say, phone, shell, weather } from '/kit/openhouse.js';`
- `house.subscribe((h) => draw(h))`: now and on every change (the assistant, another screen). `h.lists` (`{id, name,
  items: [{id, text, done, who}]}`), `h.chores` (`{who, task, today, done, week, days}`; `week` = days done this past
  week), `h.events` (the next weeks, soonest first: `{id, title, start, end, allDay, who, place, local, repeat, date}`),
  `h.meals` (`"YYYY-MM-DD"` → `{dinner: "Tacos"}`), `h.photos` (names, newest first), `h.family` (`{name, note}`),
  `h.stars` (name → stars to spend), `h.rewards`, `h.asks` (rewards waiting for a yes), `h.got`, `h.checklists`
  (routines: `{id, name, who, from, to, steps: [{text, pic}], now, done}`), `h.favorites`, `h.mealWork`, `h.night`,
  `h.today`, `h.ai`. The full shape is documented in the kit (`house.data`).
- Changes: `house.addItem(list, text, who)`, `check(list, id, done)`, `removeItem(list, id)`, `editItem(list, id,
  {text, who})`, `clearChecked(list)`, `addList(name)`, `renameList`, `deleteList`, `choreDone(who, task, done)`,
  `addChore(who, task, days, stars)`, `updateChore`, `skipChore`, `removeChore(who, task)`, `setMeal(date, meal,
  text)`, `favorite(text, pinned)`, `addIngredients(date, meal, items?)` (that meal's groceries on the
  list: items, else what its recipe lists, else the assistant's guess), `addEvent({title, start, end, allDay, who, repeat, place, notes, remind, calendar})`, `updateEvent(id,
  fields)`, `removeEvent(id, date)` (events added on the display, and those in a two-way calendar; a calendar read
  from a link is read-only), `addReward(title, stars, who)`, `removeReward(id)`, `redeem(who, id)` (someone says yes
  on the display's own card, with the PIN: nothing in an app or a conversation can say yes for them),
  `addChecklist`, `updateChecklist`, `removeChecklist`, `checkStep(id, step, who, done)`, `addPhoto(blob, name)`,
  `removePhoto(name)`, `setNight(from, to)`. Every one, with its arguments, is in the kit (`kit/openhouse.js`).
  `house.color(who)` is that person's color; `await house.photo(name)` is a URL for an `<img>`.
- In kit 2 every change resolves, never throws: the bridge's answer, or `{ok: false, error, status}` when it didn't
  happen (`error`: the reason in words to show, or null). Check `r?.ok === false` and show `r.error` when there is one.
  An app on kit 1 (`"kit": 1`, or none) fails the older way: `house.*` changes resolve `{error}`, and `store.set`,
  `house.addPhoto`, `setLocation` and the Map's changes reject. Keep its code to that, or move it to `"kit": 2` and
  change its checks with it.
- `await weather()`: the weather where they live (or null), °F and mph: `{place, temp, condition, code, isDay, high,
  low, feels, humidity, wind, sunrise, sunset, hours: [{time, temp, code, isDay, rain}] (next 24), days: [{date, high,
  low, code, condition, rain}] (7)}`; `code` is the WMO weather code, `rain` the chance in percent.
- `timer.start(label, seconds)`: a kitchen timer (it shows under the clock and rings on the display). `say(text)`: says it out loud
  in the assistant's voice. `store.get(name)` / `store.set(name, value)`: the app's own saved things, kept by the
  bridge (they survive the app being reinstalled and reach the household's phones). `phone.photos()` / `phone.list(name)`: a card with a QR code for a phone on the home
  Wi-Fi (photos from its camera roll; a list to take to the store). `shell.close()`: back to the home screen.
- `"screensaver": true` in an app's `app.json` (Photos has it) makes the home screen show the family's photos when idle,
  except during `h.night` (set in Photos), when it's a dim clock.
- The TV: a paired TV shows the app whose `app.json` says `"screens": ["tv"]` (ours is the app `tv`: photos, Today and
  the week, left and right on the remote). "Show Saturday's games on the TV" is a change to that app (or a new one with
  `"screens": ["tv"]`, which the TV then shows instead). It isn't on the tablet, it can't be seen with `look_at_tablet`,
  and it only reads: `house.subscribe`, `house.photo`, `weather()` work; anything that changes things resolves
  `{ok: false}` there (kit 2).
  Plain files only (no packages), sized in `vh` for across a room, and keys instead of touch (`keydown`: arrows, Enter).
- To change what's *on* a list, the chores, rewards, routines, the meals or an event, use the house tools
  (`change_list`, `change_chores`, `change_rewards`, `change_routines`, `set_meals`, `calendar_event`), not code.


## Icons
Every app and game gets an icon you draw: `apps/<id>/icon.svg`. It's the app's icon in the Apps tab (a
rounded square, its name under it) and its launcher icon. A square `viewBox` (e.g. `0 0 100 100`) with `<path d>`,
`<circle>`, `<ellipse>` and `<rect>` shapes, each with `fill` and/or `stroke` (+ `stroke-width`);
no text, gradients, transforms, images or filters. Bold, flat and readable at thumbnail size:
one clear subject on a background that fills the square; keep the bottom-left corner plain
(the label goes there). Redraw it when the app changes enough that it no longer fits.


## Apps and games
A page in `apps/<id>/` (id: lowercase, hyphens, e.g. `star-catcher`), served by the dev server and reloaded on every
save. `check_build` reports errors the page throws while it's open.
- Files (flat, no subfolders): `app.json` `{"name": "Marble Run", "tabIcon": "game-controller", "kit": 2}`, `icon.svg` (see "Icons"), `index.html`,
  `main.js` (more `.js` and `.css` files next to it are fine). A new app: write them all first, so it appears right away; then improve it.
- A card of its own on Home (a remote, a score): `widget.html` (a small page with the kit, like `index.html`; it sits
  on the card's color, with about 22 px at the sides) and `"today": {"size": "small"}` (or `"wide"`) in `app.json`. It
  shows once someone turns it on (`today_card`; ask in one short line before you do).
- A tab gets a small icon beside its name: `"tabIcon"` in `app.json`, one of (nothing else draws):
  `sun`, `calendar-blank`, `cloud-sun`, `list-checks`, `list-bullets`, `fork-knife`, `image`, `pencil-simple`,
  `squares-four`, `television-simple`, `house`, `star`, `heart`, `book-open`, `books`, `graduation-cap`,
  `music-notes`, `game-controller`, `puzzle-piece`, `paint-brush`, `palette`, `camera`, `timer`, `clock`, `alarm`,
  `bell`, `shopping-cart`, `basket`, `cooking-pot`, `coffee`, `plant`, `tree`, `flower`, `paw-print`, `dog`, `cat`,
  `baby`, `users`, `user`, `car`, `bicycle`, `airplane`, `map-pin`, `globe`, `gift`, `cake`, `trophy`, `medal`,
  `piggy-bank`, `wallet`, `chart-line`, `note`, `notebook`, `clipboard-text`, `lightbulb`, `lightning`,
  `thermometer`, `drop`, `moon`, `smiley`, `chat-circle`, `phone`, `envelope`, `video-camera`, `film-strip`,
  `headphones`, `microphone`, `rocket`, `flag`, `target`, `barbell`, `soccer-ball`, `basketball`, `sneaker`, `pill`,
  `first-aid`, `tooth`, `bed`, `bathtub`, `broom`, `t-shirt`, `washing-machine`, `recycle`, `wrench`, `hammer`,
  `calculator`, `flask`, `magnifying-glass`, `calendar-check`, `hourglass`, `sun-horizon`, `checks`.
- `index.html`: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/kit/openhouse.css"><style>...</style></head><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>`
  (a game: `html,body{margin:0;height:100%;overflow:hidden;background:#000;touch-action:none}` and no kit css if it
  draws everything itself).
- The look: `/kit/openhouse.css` has the display's fonts (`var(--hand)`, the handwriting; `var(--round)`) and colors
  (`--ink`, `--paper`, `--sticky`, `--card`, `--accent`, `--person-0`...).
- Everyday tools (a whiteboard, a tracker, a list, anything that could be a tab) look like the starting apps (calendar,
  chores, lists, meals, photos): calm and refined, never loud. Link `/kit/quiet.css` after the kit and use its pieces
  (`.title`, `.chip`, `.btn`, `.btn.soft`, `.round`, `.quiet`; sizes in `var(--u)`, with `:root { --u: calc(100vw / 1536) }` as they have), the page's own `--bg`/`--ink`/
  `--accent` (in a tab the home screen hands them over, so it matches), soft tints instead of bright blocks, at most one
  accent, one plain type, lighter weights. Read one starting app (`apps/chores/`) before making one. It fills whatever
  box it's in (a tab is smaller than the screen): nothing cut off or scrolling out of view, circles stay circles
  (equal width and height). Games and toys can be as bold as they like.
- Every app also runs on the household's phones (390 px wide, in a frame of its own): `quiet.css` makes `--u` a phone's
  size under 700 px; there, lay it out in one column (rows, not columns side by side; a top row that wraps). Leave out
  what only the tablet does when `screen?.kind === 'phone'` (from the kit). One that can't work on a phone says
  `"screens": ["tablet"]` in its app.json. Installed libraries (below) don't load on phones yet.
- Plain ES modules; the family's data only through the kit (above). Installed libraries (use only these, no CDNs, no
  npm installs):
  - 3D: `three`. Use the WebGPU renderer; it falls back to WebGL2 on its own:
    `import * as THREE from 'three/webgpu'` then `const r = new THREE.WebGPURenderer({ antialias: true }); await r.init();`
    `r.setSize(innerWidth, innerHeight); document.body.append(r.domElement); r.setAnimationLoop(frame)`.
    Shaders in TSL (`import { ... } from 'three/tsl'`), addons from `three/addons/...`.
  - 2D: `phaser` (`import * as Phaser from 'phaser'`, `type: Phaser.AUTO`, 1920x1080 with
    `scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }`).
  - Physics: `@dimforge/rapier3d-compat` / `@dimforge/rapier2d-compat`
    (`import RAPIER from '...'; await RAPIER.init();`, step the world once per frame).
    Phaser's built-in arcade physics is fine for simple 2D.
- Touch first: pointer events, text and targets readable from across the room (in a game text 32px+, targets 100px+; in a
  tool the quiet pieces' sizes), no keyboard
  needed except in a text field. Landscape. Keep the bottom-right 200x200 px clear (the assistant). The back gesture
  (swipe in from an edge) leaves the app, so there's no Home button.
- No image or sound files: draw with SVG, canvas, shapes, generated textures, materials and lights; make sound with
  Web Audio. Save the app's own things (high scores, settings) with the kit's `store` (kept by the bridge, on every
  screen); `localStorage` under `app.<id>.` only for what belongs to one screen. The family's things go through the
  kit.
- Make it look good: smooth 60 fps motion, easing; in games real lighting and materials in 3D and juice (particles,
  screen shake). Keep pixel ratio ≤ 2 and stop animation loops when `document.hidden`.
- Never `alert`, `confirm` or `prompt`; never leave the page or open other sites (the view stays in the app).


---

The quiet kit (`/kit/quiet.css`, linked after `/kit/openhouse.css` in an everyday tool) is in references/quiet.css: read it before writing one. How a tab should look is in references/design.md: check what you made against it before calling it done. For the home screen as it is now (its tabs, look and apps, and which tab the tablet is showing), call get_guide with topic "home".

---

This copy of the Opie guide is version ba523ead5043. If the Opie connector's guide is another version (its instructions, or get_guide with topic "home", say which), use get_guide instead and tell the person once that the Opie plugin needs updating.
