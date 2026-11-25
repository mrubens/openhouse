// The family's own things that the starting apps (Calendar, Chores, Lists, Meals, Photos) show: kept here, by
// the bridge, not in any app's code. So the assistant can rewrite an app, or the family can throw one away and
// say "undo", and the events, chores, lists and meals are all still there. The same data is on the home screen
// tools, so "add milk", "Leo fed the cat" or "what's for dinner Thursday?" work from any conversation.
//
// GET  /house                  { v, today, family, lists, chores, stars, rewards, asks, checklists, meals, favorites,
//                                mealWork, events, photos, night, ai }
// GET  /house/wait?v=N         the same, once it changes (or after 25 s)
//      &same=1                 nothing changed in those 25 s: { v, same: true }, and the caller keeps what it has
// POST /house/list             { list, add?: [text], check?: [id|text], uncheck?, remove?, clearChecked?, who? }
// POST /house/chore            { done: {who, task}, value? } | { add: {who, task, days?} } | { remove: {who, task} }
// POST /house/reward           { add: {title, stars, who?} } | { remove: id } | { redeem: {who, id} } | { answer: {id, yes} }
// POST /house/checklist        { add: {name, who?, from, to, days?, steps: [{text, pic}]} } | { update: {id, ...} } | { remove: id }
//                              | { check: {id, step, who, done?} }
// POST /house/meal             { date: "YYYY-MM-DD", meal?: "dinner", text } (empty text clears it) | { favorite: text, value? }
// POST /house/meal/ingredients { date, meal? }  the assistant puts what that meal needs on Groceries
// POST /house/event            { add: {title, start, end?, allDay?, who?, repeat?, until?} } | { remove: id, date? }
// POST /house/settings         { night: {from: "21:30", to: "06:30"} | false, remind?: minutes | false, remindAloud?: bool }
//                              (no photos on the idle screen at night; remind: the reminder every timed event gets)
// POST /house/flyer?name=x.jpg a photo of a flyer or school notice (the body): the assistant reads its events
//                              into view().flyer { state: "working" | "done" | "error", events?, text? } (waiting events kept through a restart); nothing is
//                              added until the Calendar app (or the assistant) adds what the family says yes to
// POST /house/recipe-photo?meal=Tacos  a photo of a recipe (the body): the assistant types it into the recipe box
// POST /house/recipe-link     {link, meal?} a recipe's page (shared from a phone): read, saved, made into cooking steps
//                             (POST /house/meal {cook: meal, force?} makes the steps again; {find: words} finds recipes
//                             on the web, shown as recipeFind; {findDone: true} puts them away; cooking.js)
// POST /house/flyer/clear      {}  the flyer's events put away (added, or not wanted)
// POST /house/lock             { calendar: bool }  the display only (not an app): a PIN for calendar changes in the apps
// POST /house/unlock           {}  the display only, after the PIN: apps may change the calendar for 5 minutes
//   view(): calendarLock, unlockedUntil (ms; 0 when locked or no lock)
// POST /house/remind           { done: key }  a reminder put away, on every screen (its key from view().reminders)
// POST /house/thing            { take: id }  one of the things on Home taken down (view().things: things.js)
// GET  /house/photo/<name>     one of the family's photos (files in display/photos/)
// POST /house/photo?name=x.jpg the image itself as the body (the phone upload page); x.mp4 / x.mov: a video (MAX_VIDEO)
// GET  /house/photo/<video>    its still (stills.js); ?play=1: {url} for <video src>, /house/video/<name>?t=… (serveVideo)
// POST /house/photo/part?id&n&of&name  a video from the phone page in parts (the shell only), put together in .incoming
// POST /house/photo/remove     { name }  (moved to photos/.removed, not deleted)
// POST /house/photo/album      { add: {name, photos?} } | { rename: {id, name} } | { remove: id } | { put: {id, photos, on?} } | { show: {id, sleep?, all?} }
// POST /house/photo?name=x.jpg from an app (x-openhouse-app): into that app's own album, named after it
// POST /house/photo/caption    { name, text }  (empty text takes it off)
//   view(): albums [{id, name, photos, app?, sleep?, all?}], captions {photo: text},
//   screensaver: the photos the sleep screen shows (all but those whose albums are all off there)
//   linked: shared albums kept in step from iCloud [{id, album, from, status, error?, at, photos, coming}] (photo-albums.js)
// POST /house/album/stream, /house/album/assets   the shell only: what a linked album said (photo-albums.js)
// POST /house/share            { url }  a phone hand-off link (PhoneQr) through the shell's share sheet
//
// files: house.json (lists, chore checkmarks, stars, rewards, checklists, meals, events added on the display)
// next to household.json; photos/ next to it. Chores themselves stay in household.json, where setup and
// update_household keep them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';
import { registered } from './stores.js';
import { AISLES, PEOPLE, aisleOf, dayKey, daysFrom, MEDIA, VIDEO, MAX_VIDEO, DAY, NIGHT, SHOWS, str } from './house/util.js';
import assistantPart from './house/assistant.js';
import listsPart from './house/lists.js';
import choresPart from './house/chores.js';
import rewardsPart from './house/rewards.js';
import routinesPart from './house/routines.js';
import mealsPart from './house/meals.js';
import recipesPart from './house/recipes.js';
import flyersPart from './house/flyers.js';
import eventsPart from './house/events.js';
import settingsPart from './house/settings.js';
import mediaPart from './house/media.js';
import toolsPart from './house/tools.js';

export { ROOM, PEOPLE, VIDEO, MAX_VIDEO, videoKind, PICS, AISLES, aisleOf } from './house/util.js';

export function houseRoutes({ DIR, json, body, board, homeScreen = null, currentAgent = null, agentName = () => 'off', WORK = DIR, things = null, notes = null, appName = (id) => id }) {
  const FILE = registered('house', path.join(DIR, '../house.json'));
  const PHOTOS = path.join(DIR, '../photos');
  try { fs.mkdirSync(PHOTOS, { recursive: true }); } catch {}
  let data = readJson(FILE, null) || {};
  data.lists ||= [{ id: 'groceries', name: 'Groceries', items: [] }, { id: 'todo', name: 'To do', items: [] }];
  data.done ||= {}; // "YYYY-MM-DD": ["who|task", ...]
  data.by ||= {}; // "YYYY-MM-DD|who|task" -> who did a chore anyone could (they got its stars)
  data.skipped ||= {}; // "YYYY-MM-DD": ["who|task", ...]  skipped for the day: no stars, not left to do
  data.meals ||= {}; // "YYYY-MM-DD": { dinner: "Tacos" }
  data.recipes ||= {}; // the recipe box, by meal (lowercase): { text, link?, notes?, video?, image?, picsAt?, cook?: {name, serves, ingredients,
  // steps: [{text, uses?, timer?, image?}], for, at}, at } (image: the dish's photo on its page; a step's image: its page's photo of it)
  data.mealSlots ||= ['dinner']; // which meals the Meals app plans: some of breakfast, lunch, dinner
  data.events ||= []; // added on the display: [{ id, title, start, end?, allDay, who, place?, notes?, repeat?, until?, skip?, countdown? }]
  data.countdowns ||= []; // synced events counted down to (their uid from calendar.js)
  data.reminds ||= {}; // synced events' reminders: uid -> minutes before (-1: none, over the household's default)
  data.whose ||= {}; // two-way synced events' people when they aren't the calendar's own: uid -> { who, also? } (calendar-sync.js)
  data.reminded ||= []; // reminders put away: "uid-or-id|start ISO" (the latest 200)
  data.rewards ||= []; // [{ id, title, stars, who? }]
  data.spent ||= {}; // "who" (lowercase) -> stars spent on rewards
  data.asks ||= []; // rewards asked for, waiting for a yes: [{ id, who, reward, title, stars, at, manual? }]
  data.got ||= []; // rewards given, newest first: [{ who, title, stars, at }]
  data.checklists ||= []; // [{ id, name, who: [], from, to, days?, steps: [{ text, pic }] }]
  data.checked ||= {}; // "YYYY-MM-DD": ["checklistId|step|who", ...]
  data.favorites ||= []; // meals pinned as favorites
  data.mealCounts ||= {}; // "tacos": { text, n, last }
  data.settings ||= {};
  // What the household's apps put on the calendar (day-notes.js): how each shows (SHOWS), and their order.
  notes?.setPrefs({ show: (app) => (SHOWS.includes(data.settings.fromApps?.[app]) ? data.settings.fromApps[app] : 'today'), order: () => data.settings.fromAppsOrder || [] });
  const appEvents = () => { try { return notes ? notes.events() : []; } catch (e) { console.error('[day-notes]', e); return []; } };
  data.albums ||= []; // [{ id, name, photos: [file names], app?: the app that saved them, sleep?: false (not on the sleep screen), all?: false (not in Photos' All) }]
  data.captions ||= {}; // file name -> a line shown with it ("Grandma's 80th")
  // shared albums linked on the tablet (photo-albums.js): data.synced; their links stay in the shell
  if (!data.earned) { // stars earned so far, kept apart from checkmarks (those are pruned after two months)
    data.earned = {};
    for (const keys of Object.values(data.done)) for (const k of keys) { const w = k.split('|')[0]; if (w) data.earned[w] = (data.earned[w] || 0) + 1; }
  }
  // A view's version: from anywhere at a start, so a caller holding one from before a restart is never told nothing changed.
  let version = crypto.randomInt(1, 2 ** 30);
  const waiters = new Set();
  const mealWork = {}; // "date|meal" -> { state: "working" | "done" | "error", added?, text? } (not saved)
  const FLYERS = path.join(DIR, '../flyers');

  let rev = 0; // goes up with every save (what's cached from the data is good while it's the same)
  function save() {
    rev++;
    writeJson(FILE, data);
    changed();
  }
  function changed() {
    version++;
    if (!waiters.size) return; // (nobody waiting: no view to work out)
    const out = view();
    for (const w of waiters) w(out);
    waiters.clear();
  }

  function prune() { // keep two months of checkmarks and meals
    const cut = dayKey(daysFrom(-60));
    for (const k of Object.keys(data.done)) if (k < cut) delete data.done[k];
    for (const k of Object.keys(data.skipped)) if (k < cut) delete data.skipped[k];
    for (const k of Object.keys(data.by)) if (k < cut) delete data.by[k];
    for (const k of Object.keys(data.checked)) if (k < cut) delete data.checked[k];
    for (const k of Object.keys(data.meals)) if (k < cut) delete data.meals[k];
    data.events = data.events.filter((e) => e.repeat ? !e.until || e.until >= cut : new Date(e.end || e.start) > Date.now() - 60 * DAY);
  }

  // household.json, read once for a whole view (the family, the chores, the events kept there) and not again for each
  // part of it: board.snapshot() when the board has one, else its two reads. Outside a view, read when asked.
  let seen = null;
  const snapshot = () => (board.snapshot ? board.snapshot() : { view: board.householdView(), events: board.calendarEvents() });
  const household = () => (seen ? (seen.s ||= snapshot()).view : board.householdView());
  const calendarEvents = () => (seen ? (seen.s ||= snapshot()).events : board.calendarEvents());
  function view() {
    const outer = seen;
    seen ||= {};
    try { return viewNow(); } finally { seen = outer; }
  }
  function viewNow() {
    const h = household(), events = house.events(), reminders = house.reminders(Date.now(), events);
    return {
      v: version, today: dayKey(), family: (h.family || []).map((f, i) => ({ name: f.name, note: f.note || '', color: f.color || PEOPLE[i % PEOPLE.length] })),
      streaks: house.streaks(), lists: data.lists.map((l) => ({ ...l, byAisle: l.byAisle ?? l.id === 'groceries', items: l.items.map((i) => ({ ...i, aisle: aisleOf(i.text) })) })), aisles: [...AISLES.map(([a]) => a), 'Other'], chores: house.chores(), stars: house.starsView(), rewards: data.rewards, asks: data.asks, got: data.got.slice(0, 5),
      checklists: house.checklists(), meals: data.meals, favorites: house.favorites(), mealWork, recipes: data.recipes, recipeFind: house.recipeFindNow(), mealSlots: data.mealSlots,
      events, dayNotes: (() => { try { return notes ? notes.byDay() : {}; } catch { return {}; } })(), fromApps: (() => { try { return notes ? notes.apps() : []; } catch { return []; } })(), photos: house.photos(), calendars: (h.calendars || []).length + (board.sync?.calendars().filter((c) => c.mode !== 'off').length || 0),
      calendarTargets: board.sync?.targets() || [], // two-way calendars new events can go into (calendar-sync.js)
      things: (() => { try { return things ? things.strip({ events, reminders }) : []; } catch (e) { console.error('[things]', e); return []; } })(), // (things.js: the strip on Home)
      night: data.settings.night === false ? null : data.settings.night || NIGHT,
      reminders, flyer: house.flyerNow(), calendarLock: !!data.settings.calendarLock, unlockedUntil: house.unlocked() > Date.now() ? house.unlocked() : 0,
      removed: house.removedPhotos(), albums: data.albums, linked: house.albums.view(), captions: data.captions, screensaver: house.screensaver(), remind: data.settings.remind ?? null, remindAloud: !!data.settings.remindAloud,
      ai: !['off', 'none'].includes(agentName()) && !!currentAgent,
    };
  }

  // The parts (house/*.js), each over the same data; what one needs of another it finds on house when it's called.
  const house = { DIR, WORK, PHOTOS, FLYERS, data, board, homeScreen, currentAgent, agentName, things, notes, appName, mealWork,
    save, changed, view, prune, household, calendarEvents, appEvents, rev: () => rev };
  for (const part of [assistantPart, listsPart, choresPart, rewardsPart, routinesPart, mealsPart, recipesPart, flyersPart, eventsPart, settingsPart, mediaPart, toolsPart])
    Object.assign(house, part(house));

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/house' && !p.startsWith('/house/')) return false; // not /household
    // An app asking: on the tablet (x-openhouse-app) or in its frame on a phone or other screen (x-openhouse-screen-app).
    const fromApp = !!(req.headers['x-openhouse-app'] || req.headers['x-openhouse-screen-app']);
    if (req.method === 'GET' && p === '/house') { json(res, 200, view()); return true; }
    if (req.method === 'GET' && p === '/house/wait') {
      if (Number(url.searchParams.get('v')) !== version) { json(res, 200, view()); return true; }
      const same = url.searchParams.get('same') === '1'; // (a caller from before it could keep its view gets the view again)
      const t = setTimeout(() => { waiters.delete(done); json(res, 200, same ? { v: version, same: true } : view()); }, 25e3);
      const done = (v) => { clearTimeout(t); json(res, 200, v); };
      waiters.add(done);
      req.on('close', () => { clearTimeout(t); waiters.delete(done); });
      return true;
    }
    if (p.startsWith('/house/photo/') && req.method === 'GET') {
      const name = decodeURIComponent(p.slice('/house/photo/'.length));
      if (!MEDIA.test(name) || name.includes('/') || name.startsWith('.')) { json(res, 404, { error: 'not found' }); return true; }
      if (VIDEO.test(name)) { // a video: its still (what every picture of it shows), or where to play it
        const removed = !!url.searchParams.get('removed');
        if (url.searchParams.get('play')) { fs.existsSync(path.join(PHOTOS, name)) ? json(res, 200, { url: house.playUrl(name) }) : json(res, 404, { error: 'not found' }); return true; }
        try { const buf = fs.readFileSync(house.stills.fileOf(name)); res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' }); res.end(buf); }
        catch { if (!removed) house.stills.want(name); json(res, 404, { error: 'no still yet' }); }
        return true;
      }
      try {
        const buf = fs.readFileSync(url.searchParams.get('removed') ? path.join(PHOTOS, '.removed', name) : path.join(PHOTOS, name)); // ?removed=1: one taken off, to put back
        res.writeHead(200, { 'content-type': /png$/i.test(name) ? 'image/png' : /webp$/i.test(name) ? 'image/webp' : /gif$/i.test(name) ? 'image/gif' : 'image/jpeg', 'cache-control': 'max-age=86400' });
        res.end(buf);
      } catch { json(res, 404, { error: 'not found' }); }
      return true;
    }
    if (req.method !== 'POST') return false;
    if (p === '/house/photo') { // raw image body
      const name = String(url.searchParams.get('name') || '').replace(/[^\w.-]/g, '_').slice(-80);
      if (!MEDIA.test(name)) { json(res, 400, { error: 'name must end in .jpg, .png, .webp, .mp4 or .mov' }); return true; }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_VIDEO) { json(res, 413, { error: 'too big' }); return true; } chunks.push(c); }
      const app = String(req.headers['x-openhouse-app'] || '').trim(); // an app saving a picture: into its own album
      const file = house.addPhoto(Buffer.concat(chunks), name, '', /^[a-z0-9][a-z0-9-]{0,60}$/.test(app) ? app : null);
      if (!file) { json(res, 413, { error: 'too big' }); return true; }
      json(res, 200, { ok: true, name: file }); return true;
    }
    if (p === '/house/photo/part') { // raw: one part of a video (the phone page, through the shell)
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 8e6) { json(res, 413, { error: 'too big' }); return true; } chunks.push(c); }
      const r = house.videoPart(url.searchParams, Buffer.concat(chunks));
      json(res, r.error ? r.code || 400 : 200, r); return true;
    }
    if ((p === '/house/flyer' || p === '/house/recipe-photo') && req.method === 'POST') { // raw image body
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 15e6) { json(res, 413, { error: 'too big' }); return true; } chunks.push(c); }
      const r = p === '/house/flyer' ? house.addFlyer(Buffer.concat(chunks), url.searchParams.get('name') || 'flyer.jpg') : house.addRecipePhoto(Buffer.concat(chunks), url.searchParams.get('meal'));
      json(res, r.error ? 400 : 200, r); return true;
    }
    const b = await body(req);
    const send = (r) => json(res, r.error ? 400 : 200, r.error ? r : { ...r, house: view() });
    if (p === '/house/list') { send(house.changeList(b)); return true; }
    if (p === '/house/chore') {
      if (b.done) send(house.changeChores(b.value === false ? { undone: [b.done] } : { done: [b.done] }));
      else send(house.changeChores(b));
      return true;
    }
    if (p === '/house/reward') { send(house.changeRewards(b, { fromApp: true })); return true; }
    if (p === '/house/checklist') { send(house.changeChecklists(b)); return true; }
    if (p === '/house/recipe-link') { send(house.addRecipeLink(b)); return true; } // a link shared from a phone (Recipes)
    if (p === '/house/meal') { send(b.favorite != null ? house.favorite(b.favorite, b.value !== false) : b.recipe ? house.setRecipe({ ...b.recipe, quiet: false, video: b.recipe.video }) : b.cook ? house.prepareCook(b.cook, { force: !!b.force }) : b.find ? house.findRecipes(b.find) : b.findDone ? house.findDone() : b.writeRecipe ? house.writeRecipe(b.writeRecipe) : b.addText ? house.addRecipeText(b.addText) : b.slots ? house.setSlots(b.slots) : house.setMeals([b])); return true; }
    if (p === '/house/meal/ingredients') { send(await house.ingredients(b.date, str(b.meal || 'dinner', 20).toLowerCase())); return true; }
    if (p === '/house/event') {
      // With the calendar locked, an app changes it only for a little while after the PIN on the display.
      if (fromApp && data.settings.calendarLock && house.unlocked() < Date.now()) { json(res, 403, { error: 'The calendar is locked: someone unlocks it with the PIN.', locked: true }); return true; }
      send(house.changeEvents(b)); return true;
    }
    if ((p === '/house/lock' || p === '/house/unlock') && fromApp) { json(res, 403, { error: 'Only the display can do that.' }); return true; }
    if (p === '/house/lock') { if (b.calendar !== undefined) { if (b.calendar) data.settings.calendarLock = true; else delete data.settings.calendarLock; } house.setUnlocked(0); save(); send({ ok: true }); return true; }
    if (p === '/house/unlock') { house.setUnlocked(Date.now() + 5 * 60e3); changed(); send({ ok: true, until: house.unlocked() }); return true; }
    if (p === '/house/settings') { send(house.settings(b)); return true; }
    if (p === '/house/remind') { send(house.putAway(b.done)); return true; }
    if (p === '/house/thing') { if (!things?.take(b.take)) { json(res, 400, { error: 'Which thing (its id)?' }); return true; } changed(); json(res, 200, { ok: true }); return true; }
    if (p === '/house/flyer/clear') { house.clearFlyer(); changed(); send({ ok: true }); return true; }
    if (p === '/house/photo/remove') { send(house.removePhoto(b.name)); return true; }
    if (p === '/house/photo/album') { send(house.changeAlbums(b)); return true; }
    if (p === '/house/photo/restore') { send(house.restorePhoto(b.name)); return true; }
    if (p === '/house/photo/caption') { send(house.caption(b)); return true; }
    if ((p === '/house/album/stream' || p === '/house/album/assets') && fromApp) { json(res, 403, { error: 'Only the display can do that.' }); return true; }
    if (p === '/house/album/stream') { const { done, ...r } = house.albums.stream(b); json(res, r.error ? 400 : 200, r); return true; }
    if (p === '/house/album/assets') { const { done, ...r } = house.albums.assets(b); json(res, r.error ? 400 : 200, r); return true; }
    if (p === '/house/share') { const r = await house.shell('/share', { url: String(b.url || '') }); send(r && !r.error ? { ok: true } : { error: r?.error || 'The display can\u2019t share from here.' }); return true; }
    return false;
  }

  // What changes with the clock alone, with no save: the day (chores, streaks, "today"), the reminders due (their chime
  // and card come only from the view), the things on Home and their words, a synced event's note running out, routines
  // starting or ending, the PIN's few minutes running out. A screen waiting with same=1 keeps its view, so each time any of these differs, every screen is told.
  function clockNow() {
    const outer = seen;
    seen ||= {};
    try {
      const events = house.events(), reminders = house.reminders(Date.now(), events);
      let strip = []; try { strip = things ? things.strip({ events, reminders }).map((x) => `${x.id} ${x.text}`) : []; } catch {} // ("Swim in 9 minutes")
      return JSON.stringify([dayKey(), reminders.map((r) => r.key), strip, events.filter((e) => e.note).map((e) => e.id), data.checklists.filter((c) => house.activeNow(c)).map((c) => c.id),
        house.unlocked() > Date.now(), !['off', 'none'].includes(agentName()) && !!currentAgent]);
    } finally { seen = outer; }
  }
  let clock = '';
  try { clock = clockNow(); } catch (e) { console.error('[house] clock', e.message); }
  function tick() {
    let now; try { now = clockNow(); } catch (e) { console.error('[house] clock', e.message); return; }
    if (now !== clock) { clock = now; changed(); }
  }
  setInterval(tick, 30e3).unref?.();
  // Asks left from before a restart: nobody is looking at a card for them any more (the kid asks again).
  data.asks = [];
  for (const k of ['call', 'context', 'settings', 'putAway', 'addFlyer', 'readEmail', 'addRecipePhoto', 'prepareCook', 'addRecipeLink', 'findRecipes',
    'changeAlbums', 'caption', 'addPhoto', 'serveVideo', 'stills', 'removePhoto', 'restorePhoto', 'albums']) handle[k] = house[k];
  handle.tools = house.TOOLS;
  handle.view = view;
  handle.changed = changed;
  handle.tick = tick; // (tests: what the 30 s clock does)
  handle.events = () => house.events(); // the calendar as screens get it (tests)
  handle.reminders = (now) => house.reminders(now); // the reminders due now (phone-buzz.js: they buzz the phones of the people on them)
  handle.night = () => (data.settings.night === false ? null : data.settings.night || { from: '21:30', to: '06:30' });
  handle.localEvents = () => [...data.events.flatMap((e) => house.occurrences(e, Date.now() - 35 * DAY, Date.now() + 70 * DAY)), ...appEvents()];
  board.onCalendar = () => changed(); // a two-way calendar was read or sent to (calendar-sync.js), a link calendar read, the household saved
  return handle;
}