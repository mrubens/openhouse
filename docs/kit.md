# The kit, version 1

The JavaScript every app imports to reach the household's things: `bridge/kit/openhouse.js`, served to apps by the
bridge (`bridge/apps.js`, `bridge/kit-version.js`).

```js
import { house, store, timer, say, phone, shell } from '/kit/openhouse.js';
```

## Versions

- An app says which version it was made for in its `app.json`: `"kit": 1`. The bridge then serves version 1 at
  `/kit/openhouse.js` for that app's pages, whatever the newest version is. `/kit/v1/openhouse.js` names it outright.
- An app that names no version gets the newest at `/kit/openhouse.js` (today that is version 1).
- Version 1 is frozen: functions may be added to it and bugs fixed, but nothing in this list changes its arguments
  or what it resolves to. A change that would break an app made for version 1 goes in version 2, a file of its own
  (`bridge/kit/openhouse-v2.js`, listed in `KIT_VERSIONS`), and version 1 keeps being served.
- On a phone, the app's bundle carries the version its `app.json` names (`bridge/screens.js` `appFileList`).
- `version` (exported) is the version the page got.

## Failures

**Every change resolves and never rejects.** It resolves to the bridge's answer (usually `{ok: true, …}`), or, when
the change didn't happen, to

```js
{ ok: false, error, status }
```

- `error`: the bridge's reason, in words to show a person ("Groceries is full…"), or `null` when it gave none.
- `status`: the HTTP status (403 not allowed, 429 too many, 400 a bad request…), or `0` when it never reached the
  tablet.

Test `r?.ok === false` for a failure, and show `r.error` when there is one. A change with nothing to send (blank text
to `addItem`, `addList`, `renameList`, `addChore`, `addEvent`, `addReward`) resolves `null` and asks nothing.
`devices.do` also has `text` and `limited` (below). On a TV every change resolves `{ok: false, status: 403}`.

Reads differ by what they read, and are listed with each one: some resolve `null` or `[]` when they can't, some
reject.

## The house

| Function | Arguments | Resolves to |
|---|---|---|
| `house.data` | | The latest house data (shape in the kit's comment on `house.data`), or `null` until loaded |
| `house.subscribe(fn)` | `fn(data)`, now (if loaded) and on every change | Returns a function that stops it |
| `house.color(who)` | a family name | That person's color (a string) |
| `house.dayKey(d?)` | a Date (today) | `"YYYY-MM-DD"` |
| `house.addItem(list, text, who?)` | list name, text, a family name or null | change |
| `house.check(list, id, done = true)` | | change |
| `house.removeItem(list, id)` | | change |
| `house.clearChecked(list)` | | change |
| `house.addList(name)` | | change |
| `house.deleteList(list)` | | change |
| `house.byAisle(list, on = true)` | | change |
| `house.renameList(list, name)` | | change |
| `house.editItem(list, id, to)` | `to`: `{text?, who?}` | change |
| `house.choreDone(who, task, done = true, by?)` | `by`: who did a chore anyone can do | change |
| `house.addChore(who, task, days = [], stars = 1)` | | change |
| `house.updateChore(who, task, to)` | `to`: `{task?, who?, days?, stars?}` | change |
| `house.skipChore(who, task, skip = true)` | | change |
| `house.removeChore(who, task)` | | change |
| `house.setMeal(date, meal, text)` | `"YYYY-MM-DD"`, `'dinner'`…, text (`''` clears) | change |
| `house.favorite(text, pinned = true)` | | change |
| `house.setRecipe(meal, {link, notes})` | both empty takes it out | change |
| `house.addRecipeLink(link, meal?)` | | change; watch `data.mealWork.link` |
| `house.findRecipes(words)` | | change; results in `data.recipeFind` |
| `house.findDone()` | | change |
| `house.prepareCook(meal, force = false)` | | change; watch `data.mealWork["cook|<key>"]` |
| `house.writeRecipe(meal)` | | change; watch `data.mealWork["recipe|<key>"]` |
| `house.addRecipe(text)` | a link, a pasted recipe, or an idea | change |
| `house.mealSlots(slots)` | some of `'breakfast'`, `'lunch'`, `'dinner'` | change |
| `house.addIngredients(date, meal = 'dinner')` | | change; watch `data.mealWork["date|meal"]` |
| `house.addEvent({title, start, end?, allDay?, who?, also?, repeat?, until?, place?, notes?, countdown?, remind?, calendar?})` | `start`/`end`: anything `new Date()` takes; `calendar`: a key from `data.calendarTargets` or `'here'` | change |
| `house.updateEvent(id, fields)` | only what changes; `repeat: 'none'` stops it; `date`: which time of a repeating one | change |
| `house.removeEvent(id, date?)` | `date`: one time of a repeating one | change |
| `house.countdown({id?, uid?}, on = true)` | an event added here (`id`) or a synced one (`uid`) | change |
| `house.remind({id?, uid?}, minutes)` | minutes before; 0 at the start, -1 none, null the usual | change |
| `house.flyerDone()` | | change |
| `house.putAway(key)` | a key from `data.reminders` | change |
| `house.showFromApp(app, show)` | `'week'`, `'today'` or `'off'` | change |
| `house.orderFromApps(ids)` | app ids, first first | change |
| `house.setReminders({remind?, aloud?})` | minutes or null; true or false | change |
| `house.addReward(title, stars, who?)` | | change |
| `house.removeReward(id)` | | change |
| `house.redeem(who, id)` | someone says yes on the tablet's card, with the PIN | change |
| `house.answer(id, yes)` | only an ask with `manual: true` | change |
| `house.addChecklist({name, steps, from, to, who = []})` | | change |
| `house.updateChecklist({id, steps, from, to, who})` | | change |
| `house.removeChecklist(id)` | | change |
| `house.checkStep(id, step, who, done = true)` | | change |
| `house.photo(name)` | a photo's name | A `blob:` URL; rejects when it can't |
| `house.thumb(name, px = 360, removed = false)` | | A `blob:` URL of a small copy; rejects when it can't |
| `house.isVideo(name)` | | true or false (not a promise) |
| `house.video(name)` | | An address for `<video src>`, or `null` (also on another screen) |
| `house.addPhoto(blob, name = 'photo.jpg')` | an image, or a video named `.mp4`/`.mov` (80 MB at most) | change: `{ok, name}` |
| `house.removePhoto(name)` | | change |
| `house.restorePhoto(name)` | one in `data.removed` | change |
| `house.addAlbum(name, photos = [])` | | change |
| `house.renameAlbum(id, name)` | | change |
| `house.removeAlbum(id)` | the photos stay | change |
| `house.inAlbum(id, photos, on = true)` | | change |
| `house.addAlbumLink(link)` | an iCloud shared album's public link (a grown-up's phone) | change: `{added}` |
| `house.caption(name, text)` | `''` takes it off | change |
| `house.showAlbum(id, {sleep?, all?})` | | change |
| `house.setNight(from, to)` | `"HH:MM"` each; null for none | change |

"change" means the failure rule above.

## Everything else

| Function | Arguments | Resolves to |
|---|---|---|
| `screen` | | `{kind: 'tv' \| 'phone'}` on another screen, else `null` (not a function) |
| `weather()` | | The weather (shape in the kit), or `null` |
| `weatherProblem()` | | `'no location'`, `'unreachable'`, or `null` |
| `setLocation(place)` | a ZIP code or a town (the household's own apps) | change |
| `map.get()` | | The Map's places; rejects when it can't |
| `map.turnOn(on = true)` | | change |
| `map.save(name, address, home = false, placeId?)` | | change: `{place}` |
| `map.suggest(q)` | typed so far | `[{id, text}]`, `[]` when it can't |
| `map.remove(name)` | | change |
| `map.route(lat, lon)` | | `{line, minutes, miles}`; rejects when it can't |
| `map.clear()` | | change |
| `store.get(name)` | | The app's saved value, or `null` |
| `store.set(name, value)` | JSON, up to 8 MB; `null` or `undefined` deletes | change |
| `store.legacy()` | | `{files, prefs, done()}` once, or `null` |
| `onAction(handler, every = 2000)` | `handler(name, args)`, may return the words to say | Returns a function that stops it |
| `days.set(list)` | `[{date, label, short, text, who?, pics?}]` (the kit's comment) | change |
| `events.set(list)` | `[{date \| start, end?, allDay?, title, place?, who?}]` | change |
| `today.show(text, until?, {sleep?})` | up to 80 characters; a Date or ms | change |
| `today.clear()` | | change |
| `devices.list({state = false})` | | `[{id, name, kind, room, maker, model, present, actions}]`, `[]` when it can't |
| `devices.get(id)` | | The device with its `state`, or `null` |
| `devices.do(id, action, args = {})` | | change, with `text` (what happened, or why not) and `limited` (true when it was too many) |
| `web.get(url)` | https, a host in `"reaches"` | `{status, type, text}`; rejects when it can't |
| `web.bytes(url)` | | A `Uint8Array`; rejects when it can't or on a non-2xx |
| `web.json(url)` | | The parsed body; rejects when it can't or on a non-2xx |
| `reach.ask(host, key?)` | | change |
| `reach.forget(host)` | | change |
| `decide(input, questions)` | text, `[{type, name, instructions, …}]` | The answers in order, or `null` |
| `timer.start(label, seconds)` | | change |
| `timer.cancel(endAt)` | | change |
| `timer.list()` | | `[{label, total, endAt}]`, or `null` when it can't |
| `handsFree({note, listen, minutes} \| null)` | `null` ends it | change |
| `askApp(app, action, args = {})` | another app's voice action | What it answered (a string), or `null` |
| `say(text, who?)` | | change |
| `phone.photos()`, `phone.flyer()`, `phone.addCalendar()`, `phone.addAlbum()`, `phone.sharePhotos()`, `phone.googlePhotos()`, `phone.unlock()` | | true, or false when not on the tablet (not a promise) |
| `phone.list(name)`, `phone.recipe(meal)`, `phone.link(url)`, `phone.stopAlbum(id)` | | the same |
| `shell.close()` | | Back to the home screen |
| `shell.openApp(id)` | | true, or false where it can't (not a promise) |
| `shell.canOpenApps`, `shell.app` | | Whether `openApp` works; this app's id |
| `h(tag, props?, ...children)` | `props`: `class`, `html`, `on…` listeners, `tap`/`hold` (a `press`), any other attribute (`true`: present; `null`/`false`: left out); children: nodes, text, arrays | A new element (not a promise). An element with a `tap` that isn't a button or input also takes the keyboard's focus, as a button |
| `press(el, tap, hold?)` | a tap (finger up without moving) and a hold (about half a second) | Nothing; Enter or Space taps too |
| `pad(n)` | a number | Two digits: `"07"` (not a promise) |
| `dayKey(d?)` | a Date (now) | `"YYYY-MM-DD"` in the tablet's own time, as `house.dayKey` |
| `dateOf(key)` | `"YYYY-MM-DD"` | A Date at noon local that day |
| `addDays(key, n)` | `"YYYY-MM-DD"`, days (may be negative) | The key `n` days on; counted from noon, so daylight saving time never skips or repeats a day |
| `version` | | `1` |

What a plugin's app may call follows its `app.json` `"uses"` (`docs/plugins.md`); a call it may not make is a failure
with status 403.
