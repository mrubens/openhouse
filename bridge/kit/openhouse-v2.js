// The kit for the family's apps, version 2 (docs/kit.md lists all of it): the house's data (lists, chores, meals,
// calendar, photos, rewards, routines), timers, speaking, and the few things only the display can do. An app made for
// it says "kit": 2 in its app.json and gets this one at /kit/openhouse.js (also /kit/v2/openhouse.js); one that names
// no kit gets version 1 (openhouse.js). Nothing here changes in a way that breaks an app made for it. Import it in an
// app's main.js:
//
//   import { house, store, timer, say, phone, shell } from '/kit/openhouse.js';
//   (an app for a TV says "screens": ["tv"] in its app.json: it reads the house the same way, and changes nothing)
//   house.subscribe((h) => draw(h));        // now and whenever anything changes (the assistant, another screen)
//   house.addItem('Groceries', 'Milk');      house.check('Groceries', item.id, true)
//
// Every change (house.addItem, store.set, timer.start, today.show…) resolves, never rejects: to the bridge's answer,
// or when it didn't happen to { ok: false, error, status } (error: the bridge's reason, in words to show, "Groceries
// is full…", or null; status: the HTTP status, 0 when it didn't reach the tablet). Test r?.ok === false.
//
// The data lives in the bridge (bridge/house.js), never in the app, so an app can be rewritten or deleted without
// losing any of it. The app's page runs in the shell's web view, which hands it a key that only opens these routes.
const host = window.OpenhouseApp; // the shell's web view (absent in a desktop browser: then nothing reaches the bridge)
const APP = host?.app?.() || location.pathname.split('/')[2] || '';
// In its own window the shell hands the app its key. In a frame of the home page (a tab, a card on Home) the page
// around it does, by message, only to this app's own origin: never in the address, where another page could read it.
let KEY = host?.key?.() || '';
const keyReady = KEY || window.parent === window || new URLSearchParams(location.hash.slice(1)).get('screen') === '1' ? Promise.resolve() : new Promise((done) => {
  const on = (e) => {
    if (e.source !== window.parent || e.data?.openhouse !== 'key' || typeof e.data.key !== 'string') return;
    KEY = e.data.key; removeEventListener('message', on); done();
  };
  addEventListener('message', on);
  window.parent.postMessage({ openhouse: 'hello', app: location.pathname.split('/')[2] || '' }, '*');
  setTimeout(done, 5000); // (no answer: its calls go without a key, and fail)
});
const B = '/bridge';
// In a tab on the home screen, typing in a field must reach the field, not the assistant: tell the display when one
// has the keyboard (an app in its own window doesn't need to).
{
  const editable = (el) => el && (el.isContentEditable || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit)$/i.test(el.type)) || el.tagName === 'TEXTAREA');
  // (through the home page, which passes it on for its own frames only)
  const tell = (on) => { try { if (window.parent !== window) window.parent.postMessage({ openhouse: 'editing', on: !!on }, '*'); } catch {} };
  addEventListener('focusin', (e) => { if (editable(e.target)) tell(true); });
  addEventListener('focusout', (e) => { if (editable(e.target)) tell(false); });
  addEventListener('pagehide', () => tell(false));
}
// In a tab of the home screen the app gets the family's colors in its address too (bg, panel, ink, accent): its page
// takes them, so it sits on the same world as the screen around it.
{
  const q = new URLSearchParams(location.hash.slice(1)), hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : null);
  const bg = hex(q.get('bg')), ink = hex(q.get('ink')), accent = hex(q.get('accent')), st = document.documentElement.style;
  // An app with its own colors keeps them: what its own styles set on :root (a dark panel, its accent) isn't replaced,
  // or light text would land on the family's light paper.
  const own = new Set();
  for (const sh of document.styleSheets) {
    if (sh.href && sh.href.includes('/kit/')) continue;
    try { for (const rule of sh.cssRules) if (/^(:root|html)$/.test(rule.selectorText?.trim() || '')) for (const k of rule.style) if (k.startsWith('--')) own.add(k); } catch {}
  }
  const r = { setProperty: (k, v) => { if (!own.has(k)) st.setProperty(k, v); } };
  if (bg) { r.setProperty('--bg', bg); r.setProperty('--surface', bg); r.setProperty('--panel', `color-mix(in srgb, ${ink || '#24282a'} 6%, ${bg})`); }
  if (ink) { for (const k of ['--ink', '--text']) r.setProperty(k, ink); for (const k of ['--ink-soft', '--muted']) r.setProperty(k, `color-mix(in srgb, ${ink} 55%, ${bg || '#fff'})`); r.setProperty('--line', `color-mix(in srgb, ${ink} 13%, transparent)`); }
  if (accent) {
    r.setProperty('--accent', accent);
    const [ar, ag, ab] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16));
    if (.299 * ar + .587 * ag + .114 * ab > 186) r.setProperty('--accent-ink', '#1b1a20');
  }
  // (the light system, quiet.css: bg is the world behind the tab, panel the white of the panels on it)
  const panel = hex(q.get('panel')); if (panel) r.setProperty('--card', panel);
  if (q.get('dark') === '1') { r.setProperty('color-scheme', 'dark'); document.documentElement.classList.add('dark'); }
  // In a tab of the home screen the page is the stage itself: no padding of its own (quiet.css html.in-tab).
  if (bg && window.parent !== window && q.get('screen') !== '1') document.documentElement.classList.add('in-tab');
  // and the screen's type: a quiet face takes the place of the kit's round and handwritten ones.
  const face = { clean: ['Inter', 'Inter.ttf', '100 900'], serif: ['Newsreader', 'Newsreader.ttf', '200 800'], round: ['Nunito'], hand: ['Caveat'] }[q.get('face')];
  if (face) {
    if (face[1]) {
      document.head.appendChild(document.createElement('style')).textContent = `@font-face { font-family: '${face[0]}'; src: url('/kit/fonts/${face[1]}') format('truetype'); font-weight: ${face[2]}; font-display: swap; }`;
      for (const k of ['--round', '--hand']) r.setProperty(k, `'${face[0]}', system-ui, sans-serif`);
    }
    r.setProperty('--quiet', `'${face[0]}', system-ui, sans-serif`); // the starting apps' type (quiet.css)
  }
  // On a phone on its side the app keeps its phone layout (narrow.css, quiet.css's unit, its own rules) across the whole
  // width, rather than a tablet's layout shrunk to fit: on the display on a phone (compact=1) always, and in a phone's
  // page (kind=phone) when the window is short and wide (a computer's wide window keeps the tablet's). What its styles
  // and matchMedia say for a phone upright (at most 560 px wide: max-width 700px holds, min-width 701px doesn't) holds
  // then too, and the unit comes from the height, so the type is the size it is upright. (An app asks matchMedia,
  // not innerWidth, for its phone layout.)
  const side = q.get('compact') === '1' ? '' : q.get('kind') === 'phone' ? '(orientation: landscape) and (max-height: 500px)' : null;
  if (side != null) {
    const one = (m) => {
      const out = [];
      for (const part of m.split(',').map((s) => s.trim()).filter(Boolean)) {
        const max = part.match(/\(\s*max-width:\s*(\d+)px\s*\)/), min = part.match(/\(\s*min-width:\s*(\d+)px\s*\)/);
        if (max && +max[1] >= 560) { // (holds on a phone upright: at most 560 px wide)
          out.push(part);
          out.push(part.replace(max[0], side).replace(/^\s*and\s+|\s+and\s*$/g, '').replace(/\s+and\s+and\s+/, ' and ').trim() || 'all');
        } else if (min && +min[1] > 560) { if (side) out.push(part.replace(min[0], `${min[0]} and (min-height: 501px)`)); } // (doesn't)
        else out.push(part);
      }
      return out.join(', ') || 'not all';
    };
    const done = new WeakSet();
    const fix = (rules) => { for (const r of rules) { if (r.media && !done.has(r)) { done.add(r); const t = one(r.media.mediaText); if (t !== r.media.mediaText) r.media.mediaText = t; } if (r.cssRules) fix(r.cssRules); } };
    const all = () => { for (const sh of document.styleSheets) { try { fix(sh.cssRules); } catch {} } };
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (m) => mm(one(String(m)));
    const unit = document.createElement('style');
    unit.textContent = `@media ${side ? side : '(orientation: landscape)'} { html:root:root:root { --u: min(calc(100vw / 560), calc(100vh / 520)); } }`;
    document.head.appendChild(unit);
    all(); addEventListener('DOMContentLoaded', all); addEventListener('load', all);
    // (a style or stylesheet added later: when it's there)
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeName === 'STYLE') all(); else if (n.nodeName === 'LINK') n.addEventListener('load', all); } })
      .observe(document.documentElement, { subtree: true, childList: true });
  }
} // the dev server passes these on to the bridge

// On a TV or someone's phone (a screen app, docs/phones-and-tv.md, docs/phones.md) the app runs in a sandboxed frame in the
// screen's page, which holds the screen's key: the kit asks that page, and it asks the tablet, sealed, marked with this
// app (the page knows which frame is which). A TV only shows: anything that changes things fails there. On a phone the
// app's own rights hold, as on the tablet.
const SCREEN = window.parent !== window && new URLSearchParams(location.hash.slice(1)).get('screen') === '1';
/** On a screen other than the tablet: its kind ('tv' or 'phone'), else null. */
export const screen = SCREEN ? { kind: new URLSearchParams(location.hash.slice(1)).get('kind') || 'tv' } : null;
const asked = new Map(); let asks = 0;
if (SCREEN) addEventListener('message', (e) => {
  if (e.source !== window.parent || !e.data || typeof e.data !== 'object') return;
  const m = e.data;
  if (m.oh === 'reply' && asked.has(m.id)) { const done = asked.get(m.id); asked.delete(m.id); done(m); }
  // A key on the remote while the page around this one had the focus: as if it were pressed here.
  if (m.oh === 'key' && typeof m.key === 'string') dispatchEvent(new KeyboardEvent('keydown', { key: m.key, bubbles: true, cancelable: true }));
});
function viaScreen(path, body) {
  if (body !== undefined && screen.kind !== 'phone') return Promise.reject(Object.assign(new Error(`${path}: read only on a TV`), { status: 403, reason: null }));
  if (body instanceof Blob) return Promise.reject(Object.assign(new Error(`${path}: not from a phone yet`), { status: 403, reason: null }));
  return new Promise((resolve) => {
    const id = ++asks; asked.set(id, resolve);
    window.parent.postMessage({ oh: 'call', id, m: body === undefined ? 'GET' : 'POST', p: path, ...(body !== undefined ? { b: body } : {}) }, '*');
  }).then((m) => new Response(m.status === 204 ? null : m.body, { status: m.status || 500, headers: { 'content-type': m.type || 'application/json' } }));
}

/** A refused call's error: the bridge's reason when it gave one (e.reason: "Groceries is full…", for the app to show). */
async function failed(path, r) {
  let reason = null; try { reason = (await r.json())?.error || null; } catch {}
  return Object.assign(new Error(`${path}: ${r.status}${reason ? ` (${reason})` : ''}`), { status: r.status, reason: typeof reason === 'string' ? reason : null });
}
async function call(path, body, raw = false) {
  if (SCREEN) {
    const r = await viaScreen(path, body);
    if (!r.ok) throw await failed(path, r);
    return raw ? r : r.json();
  }
  await keyReady;
  const r = await fetch(B + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-openhouse-app': APP, 'x-openhouse-key': KEY, ...(body === undefined || body instanceof Blob ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  });
  if (!r.ok) throw await failed(path, r);
  return raw ? r : r.json();
}
/** What a change resolves to when it didn't happen: { ok: false, error: the bridge's reason to show ("Groceries is
 *  full…") or null, status: the HTTP status, 0 when it didn't get there }. */
const refused = (e) => { console.warn(e?.message || e); return { ok: false, error: typeof e?.reason === 'string' ? e.reason : null, status: e?.status || 0 }; };
/** A change that doesn't stop the app: its answer, or refused(). */
const send = (path, body) => call(path, body).catch(refused);
/** A change with nothing to send (blank text): resolves null, and nothing is asked. */
const nothing = () => Promise.resolve(null);
/** POST /apps/fetch, its answer whatever the status (its error is in the body). */
async function fetched(b) {
  if (SCREEN) return viaScreen('/apps/fetch', b);
  await keyReady;
  return fetch(B + '/apps/fetch', { method: 'POST', headers: { 'x-openhouse-app': APP, 'x-openhouse-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(b) });
}

// ---- the house ------------------------------------------------------------------------------------------
/**
 * The weather where they live (or null), °F and mph, refreshed every 10 minutes (bridge/weather.js):
 *   { place, temp, condition, code, isDay, high, low, feels, humidity, wind, sunrise, sunset,
 *     hours: [{time, temp, code, isDay, rain}] (the next 24), days: [{date: "YYYY-MM-DD", high, low, code, condition, rain}] (7), at,
 *     sense: [{text, until}] } (at most two lines tying the forecast to the household's plans, written a few times a day)
 * Its look (the sky, icons, hours and week) is /kit/weather-look.js and .css, for an app that wants to show it the same way.
 * code is the WMO weather code; rain is the chance of rain in percent; sunrise, sunset and time are local ISO times.
 */
/** Whether the tablet is still making this app (the builder's state, rails.js making): a template's page shows
 *  "Making <name>…" meanwhile, not a page half written (bridge/templates). False when it can't tell. */
export const beingMade = () => (SCREEN ? Promise.resolve(false) : call('/state').then((s) => !!APP && s?.making === APP).catch(() => false));
export const weather = () => call('/weather').then((w) => (w?.error ? null : w)).catch(() => null);
/** Why there's no weather: 'no location' (nobody has said where home is) or 'unreachable'; null when there is. */
export const weatherProblem = () => call('/weather').then((w) => (w?.error === 'no location' ? 'no location' : w?.error ? 'unreachable' : null)).catch(() => 'unreachable');
/** Where home is, for the weather: a ZIP code or a town (the family's own apps only). */
export const setLocation = (place) => send('/household/location', { location: String(place || '') });
/**
 * The Map's places (bridge/maps.js, the family's own apps only): get() is { on, home: {name, label, lat, lon},
 * places: [{name, address, lat, lon, minutes, miles}], shown: what Opie last showed, today: events with a place
 * ({title, start, who, place, lat, lon, minutes, miles, leaveBy}), looking }. Nothing is looked up until turnOn().
 * Drive times are typical ones, with no live traffic.
 */
export const map = {
  get: () => call('/map'),
  turnOn: (on = true) => send('/map/on', { on }),
  save: (name, address, home = false, placeId = '') => send('/map/place', { name, address, home, ...(placeId ? { placeId } : {}) }),
  /** Addresses for what's typed so far, nearest home first ([{id, text}]; none on a tablet without the cloud). save() takes a picked one's id. */
  suggest: (q) => call(`/map/suggest?q=${encodeURIComponent(q)}`).then((r) => r?.suggestions || []).catch(() => []),
  remove: (name) => send('/map/place/remove', { name }),
  route: (lat, lon) => call(`/map/route?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`),
  clear: () => send('/map/clear', {}),
};
const listeners = new Set();
let data = null, polling = false;
async function follow() {
  if (polling) return; polling = true;
  let v = -1;
  for (;;) {
    try { const r = await call(v < 0 ? '/house' : `/house/wait?v=${v}&same=1`); v = r.v; if (r.same) continue; data = r; for (const f of listeners) f(data); } // (same: nothing changed)
    catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
}
const PEOPLE = ['#ffc247', '#56d6a0', '#ff8566', '#74acff', '#c3a0ff', '#ff9ec4']; // only until /house says (it gives each person's own)
const photos = new Map(), thumbs = new Map();
/** Two digits: pad(7) is "07". */
export const pad = (n) => String(n).padStart(2, '0');
const iso = (d, allDay) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` + (allDay ? '' : `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`);

/** Thumbs are made four at a time, in the order asked for, so each shows as soon as it's ready instead of all at the end. */
let thumbsMaking = 0; const thumbsWaiting = [];
function makeThumb(job) {
  return new Promise((ok, no) => {
    const run = () => { thumbsMaking++; job().then(ok, no).finally(() => { thumbsMaking--; thumbsWaiting.shift()?.(); }); };
    thumbsMaking < 4 ? run() : thumbsWaiting.push(run);
  });
}

export const house = {
  /** The latest data: { today, family: [{name, note}], lists: [{id, name, items: [{id, text, done, who}]}], chores: [{who, task,
   *  today, done, week, days}], stars: {name: n}, rewards: [{id, title, stars, who}], asks, got, checklists: [{id, name, who,
   *  from, to, days, steps: [{text, pic}], now, done: ["step|who"]}], meals: {"YYYY-MM-DD": {dinner: "Tacos"}}, recipes: {"tacos": {text, link, notes, video?, cook?: {name, serves,
   *  ingredients: [{item, amount}], steps: [{text, uses?: [{item, amount}], timer?: {minutes, label}}]}}}, mealSlots, favorites:
   *  [{text, pinned}], mealWork, events: [{id, title, start, end, allDay, who, place, local, repeat, date, remind?, remindAt?}], reminders, remind, remindAloud, photos: [names],
   *  calendars, night: {from, to} | null, ai }. Null until loaded. */
  get data() { return data; },
  /** fn(data) now (if loaded) and on every change. Returns a function that stops it. */
  subscribe(fn) { listeners.add(fn); if (data) fn(data); follow(); return () => listeners.delete(fn); },
  /** That person's color, the same everywhere on the display. */
  color(who) { const i = (data?.family || []).findIndex((p) => p.name.toLowerCase() === String(who || '').toLowerCase()); return i < 0 ? '#5e6466' : data.family[i].color || PEOPLE[i % PEOPLE.length]; },
  dayKey: (d = new Date()) => iso(d, true),

  // lists
  addItem: (list, text, who = null) => !text?.trim() ? nothing() : send('/house/list', { list, add: [text.trim()], who }),
  check: (list, id, done = true) => send('/house/list', { list, [done ? 'check' : 'uncheck']: [id] }),
  removeItem: (list, id) => send('/house/list', { list, remove: [id] }),
  clearChecked: (list) => send('/house/list', { list, clearChecked: true }),
  addList: (name) => !name?.trim() ? nothing() : send('/house/list', { list: name.trim(), create: true }),
  deleteList: (list) => send('/house/list', { list, deleteList: true }),
  /** Show a list by store section (data.lists[].byAisle; each item's .aisle, in data.aisles' order) or as added. */
  byAisle: (list, on = true) => send('/house/list', { list, byAisle: !!on }),
  renameList: (list, name) => !name?.trim() ? nothing() : send('/house/list', { list, rename: name.trim() }),
  /** Change an item: { text?, who? } (who null: nobody's). */
  editItem: (list, id, to) => send('/house/list', { list, edit: [{ id, ...to }] }),
  // chores (a chore is {who, task})
  /** by: for a chore anyone can do (no who), who did it: the stars are theirs. */
  choreDone: (who, task, done = true, by = null) => send('/house/chore', { done: { who, task, ...(by ? { by } : {}) }, value: done }),
  addChore: (who, task, days = [], stars = 1) => !task?.trim() ? nothing() : send('/house/chore', { add: { who, task: task.trim(), days, stars } }),
  /** Change a chore: to = { task?, who?, days?, stars? } (today's tick goes with it). */
  updateChore: (who, task, to) => send('/house/chore', { update: { who, task, to } }),
  /** Skip a chore today (away, sick): not left to do, no stars. */
  skipChore: (who, task, skip = true) => send('/house/chore', { [skip ? 'skip' : 'unskip']: { who, task } }),
  removeChore: (who, task) => send('/house/chore', { remove: { who, task } }),
  // meals
  setMeal: (date, meal, text) => send('/house/meal', { date, meal, text: String(text || '').trim() }),
  favorite: (text, pinned = true) => send('/house/meal', { favorite: text, value: pinned }),
  /** The recipe box, by meal: setRecipe('Tacos', { link, notes }) (both empty takes it out). data.recipes["tacos"]. */
  setRecipe: (meal, { link = '', notes = '' } = {}) => send('/house/meal', { recipe: { meal, link, notes } }),
  /** A recipe's page by its link (shared from a phone, typed): read, saved under the recipe's own name (or meal), and
   *  made into cooking steps (watch data.mealWork.link, then data.mealWork["cook|name"]). */
  addRecipeLink: (link, meal = '') => send('/house/recipe-link', { link, meal }),
  /** Find recipes on the web for a few words (the household's text model with OpenAI's web search): 3 or 4 show in
   *  data.recipeFind {query, state: working|done|error, results: [{title, url, site, image, minutes, about}], text}.
   *  Save one with addRecipeLink(url, title); findDone() puts them away. */
  findRecipes: (words) => send('/house/meal', { find: String(words || '') }),
  findDone: () => send('/house/meal', { findDone: true }),
  /** Make a recipe's cooking steps (data.recipes[k].cook): once, kept; again with force. Watch data.mealWork["cook|k"]. */
  prepareCook: (meal, force = false) => send('/house/meal', { cook: meal, force }),
  /** The assistant writes a meal's recipe into the box (watch data.mealWork["recipe|tacos"]). */
  writeRecipe: (meal) => send('/house/meal', { writeRecipe: meal }),
  /** Add a recipe from whatever they typed: a link, a recipe pasted in, or an idea the assistant writes one for (watch mealWork.link). */
  addRecipe: (text) => send('/house/meal', { addText: text }),
  /** Which meals the Meals app plans: some of 'breakfast', 'lunch', 'dinner' (data.mealSlots). */
  mealSlots: (slots) => send('/house/meal', { slots }),
  /** The assistant puts what that meal needs on Groceries (watch data.mealWork["date|meal"]). */
  addIngredients: (date, meal = 'dinner') => send('/house/meal/ingredients', { date, meal }),
  // the calendar: events added on the display, and those in a two-way calendar (editable: Google or iCloud signed in on
  // the display); calendars read from a link are read-only. calendar: where a new one goes (a key from
  // data.calendarTargets, or 'here' for only the display); left out, the person's own two-way calendar, else the default.
  addEvent: ({ title, start, end = null, allDay = false, who = null, also = [], repeat = null, until = null, place = '', notes = '', countdown = false, remind = null, calendar = null }) => !title?.trim() ? nothing() : send('/house/event', {
    add: { title: title.trim(), start: iso(new Date(start), allDay), ...(end && !allDay ? { end: iso(new Date(end), false) } : {}), allDay, who, ...(also?.length ? { also } : {}), repeat, ...(until ? { until } : {}), place, notes, countdown, ...(remind != null ? { remind } : {}), ...(calendar ? { calendar } : {}) } }),
  /** Change an event (added here, or editable): its id and only what changes (start/end as times; repeat 'none' to
   *  stop; date: which time of a repeating one it was changed from). */
  updateEvent: (id, f) => send('/house/event', { update: { id, ...f,
    ...(f.start != null ? { start: iso(new Date(f.start), !!f.allDay) } : {}), ...(f.end != null && !f.allDay ? { end: iso(new Date(f.end), false) } : {}) } }),
  removeEvent: (id, date = null) => send('/house/event', { remove: id, date }),
  /** Count down to an event on the home screen: one added here (id) or a synced one (uid). */
  countdown: ({ id = null, uid = null }, on = true) => send('/house/event', { countdown: { id, uid, on } }),
  /** A reminder before an event (one added here by id, or a synced one by uid): minutes before (0 at the start, -1 none,
   *  null the household's usual). Due ones are in data.reminders [{key, title, start, who, place}]; the display shows them. */
  remind: ({ id = null, uid = null }, minutes) => send('/house/event', { remind: { id, uid, minutes } }),
  /** The flyer's events put away (added, or not wanted). */
  flyerDone: () => send('/house/flyer/clear', {}),
  /** What a waiting event came from (data.flyer.events[i].src, there while it's kept): {photo: url} for the flyer's
   *  photo, or the email {from, subject, at, text, invites, pictures: [urls]}; null once it's gone. The household's own
   *  apps on the display only. */
  async flyerSource(src) {
    const q = '/house/flyer/source?src=' + encodeURIComponent(src), url = async (p) => URL.createObjectURL(await (await call(p, undefined, true)).blob());
    try {
      if (String(src).startsWith('photo:')) return { photo: await url(q) };
      const m = await call(q), pictures = [];
      for (let i = 0; i < (m.pictures || 0); i++) pictures.push(await url(q + '&n=' + i));
      return { ...m, pictures };
    } catch { return null; }
  },
  /** Put a due reminder away on every screen (its key from data.reminders). */
  putAway: (key) => send('/house/remind', { done: key }),
  /** The reminder every timed event gets (minutes before, or null for none; data.remind), and whether the display
   *  says reminders out loud as well as showing them (data.remindAloud). */
  /** How an app's things on the calendar show (data.fromApps [{app, name, show, notes, events}], in order): 'week' (the
   *  Calendar's week and Today), 'today' (Home only, where a new one starts) or 'off'. order: the apps' ids, first first. */
  showFromApp: (app, show) => send('/house/settings', { fromApp: { app, show } }),
  orderFromApps: (ids) => send('/house/settings', { fromAppsOrder: ids }),
  setReminders: ({ remind, aloud } = {}) => send('/house/settings', { ...(remind !== undefined ? { remind: remind == null ? false : remind } : {}), ...(aloud !== undefined ? { remindAloud: !!aloud } : {}) }),
  // rewards (someone says yes on the display's own card, with the PIN: nothing in an app can say yes for them)
  addReward: (title, stars, who = null) => !title?.trim() ? nothing() : send('/house/reward', { add: { title: title.trim(), stars, who } }),
  removeReward: (id) => send('/house/reward', { remove: id }),
  redeem: (who, id) => send('/house/reward', { redeem: { who, id } }),
  /** Only for an ask with manual: true (a display with no card for it). */
  answer: (id, yes) => send('/house/reward', { answer: { id, yes } }),
  // routines (picture checklists)
  addChecklist: ({ name, steps, from, to, who = [] }) => send('/house/checklist', { add: { name, steps, from, to, who } }),
  updateChecklist: ({ id, steps, from, to, who }) => send('/house/checklist', { update: { id, steps, from, to, who } }),
  removeChecklist: (id) => send('/house/checklist', { remove: id }),
  checkStep: (id, step, who, done = true) => send('/house/checklist', { check: { id, step, who, done } }),
  // photos
  /** A blob: URL for one of the family's photos (cached). */
  photo(name) {
    if (photos.has(name)) { const p = photos.get(name); photos.delete(name); photos.set(name, p); return p; } // most recent last
    const p = call('/house/photo/' + encodeURIComponent(name), undefined, true).then((r) => r.blob()).then((b) => URL.createObjectURL(b));
    photos.set(name, p);
    // Full-size photos are big: keep the last few, and let the rest go (a grid of hundreds used to keep them all).
    while (photos.size > 8) { const [k, old] = photos.entries().next().value; photos.delete(k); old.then((u) => setTimeout(() => URL.revokeObjectURL(u), 30000)).catch(() => {}); }
    return p;
  },
  /** A small version of a photo (about [px] wide), for grids: made once from the full one, which is then let go. It's
   *  kept on the tablet (the page's Cache Storage), so the grid doesn't make every one again each time the app loads:
   *  a full grid of them took seconds, all dark until the last was done. A photo's name never changes with its picture. */
  thumb(name, px = 360, removed = false) { // removed: one taken off (data.removed), to put back
    const key = name + '|' + px + (removed ? '|r' : '');
    if (!thumbs.has(key)) thumbs.set(key, (async () => {
      const at = new Request(location.origin + '/__thumbs/' + encodeURIComponent(key));
      const store = await (globalThis.caches?.open('openhouse-thumbs').catch(() => null) ?? null);
      const kept = store && await store.match(at).catch(() => null);
      if (kept) return URL.createObjectURL(await kept.blob());
      return makeThumb(async () => {
        const b = await call('/house/photo/' + encodeURIComponent(name) + (removed ? '?removed=1' : ''), undefined, true).then((r) => r.blob());
        try {
          // Decoded straight to the small size (much quicker than the whole picture, then shrinking it).
          let bmp = await createImageBitmap(b, { resizeWidth: px, resizeQuality: 'medium' }).catch(() => null);
          if (!bmp || bmp.width > px) { bmp?.close?.(); bmp = await createImageBitmap(b); }
          const w = Math.min(px, bmp.width), hh = Math.round(bmp.height * w / bmp.width);
          const c = document.createElement('canvas'); c.width = w; c.height = hh;
          c.getContext('2d').drawImage(bmp, 0, 0, w, hh); bmp.close?.();
          const small = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
          if (small && store) store.put(at, new Response(small, { headers: { 'content-type': 'image/jpeg' } })).catch(() => {});
          return URL.createObjectURL(small || b);
        } catch { return URL.createObjectURL(b); }
      });
    })());
    return thumbs.get(key);
  },
  /** Into Photos: { ok, name }, the photo's name there (the same picture again gives the one already there, not a copy).
   *  A video too (name it .mp4 or .mov; 80 MB at most): Photos keeps it with a still, which photo() and thumb() give. */
  addPhoto: (blob, name = 'photo.jpg') => send('/house/photo?name=' + encodeURIComponent(name), blob),
  /** Is this one of the photos a video? (photo() and thumb() give its still; video() an address to play it.) */
  isVideo: (name) => /\.(mp4|mov|m4v)$/i.test(String(name || '')),
  /** An address for <video src> that plays one of the videos in Photos (it lasts a few hours), or null where it can't
   *  play (an app shown on another screen: show its still). */
  async video(name) {
    if (SCREEN) return null;
    const r = await call('/house/photo/' + encodeURIComponent(name) + '?play=1').catch(() => null);
    return r?.url ? B + r.url : null;
  },
  removePhoto: (name) => send('/house/photo/remove', { name }),
  /** Put back a photo taken off in the last 30 days (data.removed: their names, newest first). */
  restorePhoto: (name) => send('/house/photo/restore', { name }),
  /** Albums of their photos (data.albums [{id, name, photos, app?, sleep?, all?}]): add one (with photos), rename, take
   *  one away (the photos stay), or put photos in (on) or out (on: false). A picture an app saves with addPhoto goes in
   *  that app's own album by itself. */
  addAlbum: (name, photos = []) => send('/house/photo/album', { add: { name, photos } }),
  renameAlbum: (id, name) => send('/house/photo/album', { rename: { id, name } }),
  removeAlbum: (id) => send('/house/photo/album', { remove: id }),
  inAlbum: (id, photos, on = true) => send('/house/photo/album', { put: { id, photos, on } }),
  /** On an adult's own phone: keep an iCloud shared album here by its public link, with no PIN ({ added }, or
   *  { ok: false, error } like any change; a kid's phone or another screen gets that). On the display, phone.addAlbum() asks there. */
  addAlbumLink: (link) => send('/phone/album', { link }),
  /** A line shown with a photo on the idle screen and in the slideshow (data.captions); '' takes it off. */
  caption: (name, text) => send('/house/photo/caption', { name, text }),
  /** Where an album's photos show: { sleep: the sleep screen, all: Photos' All } (false leaves them out; an app's own
   *  album starts off the sleep screen). data.screensaver: the photos the sleep screen shows. */
  showAlbum: (id, where) => send('/house/photo/album', { show: { id, ...where } }),
  /** Night hours with no photos on the idle screen ("HH:MM"); null: photos all night. */
  setNight: (from, to) => send('/house/settings', { night: from && to ? { from, to } : false }),
};

// ---- the app's own saved things ------------------------------------------------------------------------------
/** Kept by the bridge, per app (each app sees only its own): survives the app being reinstalled, and reaches other
 *  screens. Values are JSON, up to 8 MB each. For quick per-device things (a high score) localStorage is fine too. */
export const store = {
  async get(name) { try { return await call('/appdata/' + name); } catch { return null; } },
  set: (name, value) => send('/appdata/' + name, value === undefined ? null : value),
  /** What the app saved before it was a web page ({files: {name: text}, prefs: {file: {key: value}}}), once: call
   *  done() after taking it in, and it isn't offered again. Null when there's nothing. */
  async legacy() {
    const v = await store.get('legacy');
    return v && { ...v, done: async () => { await store.set('legacy-done', true); await store.set('legacy', null); } };
  },
};

/**
 * Voice actions this app declares in its app.json ("actions": [{name, description, parameters, reply, open, answer}]):
 * the household asks the voice, the bridge puts it in this app's inbox, and handler(name, args) does it here, oldest
 * first, each once. Runs while the app is open; ones asked while it was closed are done when it next opens. For an
 * action with "answer": true, what the handler returns (a string) is what the voice says ("Step 3 of 8: …"); the
 * bridge waits a few seconds for it. every: how often to look, in ms (an app in use hands-free looks often). Returns a
 * function that stops it.
 */
export function onAction(handler, every = 2000) {
  let busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const box = await store.get('actions');
      const done = (await store.get('actions-done'))?.id || 0;
      const fresh = (box?.items || []).filter((i) => i.id > done);
      for (const i of fresh) {
        let said = null;
        try { said = await handler(i.action, i.args || {}); } catch (e) { console.error(e); said = 'That didn’t work.'; }
        // (only an answer still waited for: one asked long ago, while the app was closed, has had its reply)
        if (i.answer && typeof said === 'string' && Date.now() - Date.parse(i.at || 0) < 60e3) {
          const items = [...((await store.get('replies'))?.items || []), { id: i.id, text: said.slice(0, 2000) }].slice(-20);
          await store.set('replies', { items });
        }
      }
      if (fresh.length) await store.set('actions-done', { id: fresh.at(-1).id });
    } finally { busy = false; }
  };
  tick();
  const t = setInterval(tick, every);
  return () => { stopped = true; clearInterval(t); };
}

/**
 * What this app puts on the calendar, two kinds; the app says which.
 *
 * days.set(list): notes, facts about a day with no time (a school lunch, trash day, library books due, whose turn it
 * is), one per app a day (per person, with who). [{date: 'YYYY-MM-DD', label: one word ("Lunch"), short: up to about 24
 * characters ("Popcorn Chicken"), text: all of it ("Popcorn Chicken or Vegan Chic'n Nuggets"), who?: a family name, pics?: up to 4
 * [{text, image?}], what it's made of with a photo each (https, from a host in the app's "reaches"): Today's card shows
 * them as small photos beside their names}].
 * A day's notes are one outlined card after its events: in the Calendar's week (when the household chose Week and Home
 * for the app) the whole text, or with three or more the short words; Today and the day and list views the whole text. ({date, text: "Lunch: Popcorn Chicken"} still works: the label is what's
 * before the colon, else the app's name.) An app from a plugin needs "days" in its app.json "uses".
 *
 * events.set(list): events, when someone has to be somewhere or the day changes shape (a game, a half day, no school).
 * [{date: 'YYYY-MM-DD' (all day) or start: 'YYYY-MM-DDTHH:MM', end?: the same (for all day, the last day it's on),
 * allDay?, title, place?, who?: a family name}]. Shown exactly like the family's other events, read-only, "From <the
 * app>". An app from a plugin needs "calendar-events" in its "uses".
 *
 * Each set() replaces the app's whole set of that kind, from two weeks back to three months on; [] takes them off.
 * They're never synced to Google or iCloud, and go when the app does.
 */
export const days = { set: (list) => send('/calendar/days', { days: Array.isArray(list) ? list : [] }) };
export const events = { set: (list) => send('/calendar/events', { events: Array.isArray(list) ? list : [] }) };

/**
 * One short line of this app's own on Home, with the reminders and suggestions ("Lunch: Popcorn Chicken · Tacos
 * tomorrow"): plain words, up to 80 characters, until a time (a Date or ms; 10 minutes to a day from now, 3 hours if
 * not given). Showing again replaces it; a tap opens the app's tab; a person's x (or Opie) takes it down, and the same
 * words don't come back. clear() takes it down. An app from a plugin needs "today" in its app.json "uses".
 * The line is on the sleep screen too, under the events; { sleep: false } keeps it to Home (a busy or live line).
 */
export const today = {
  show: (text, until = null, { sleep } = {}) => send('/today/line', { text: String(text || ''), until: until instanceof Date ? until.getTime() : until, ...(sleep === false ? { sleep: false } : {}) }),
  clear: () => send('/today/line', { off: true }),
};

/**
 * The home's speakers and TVs (and anything else the tablet can control), through the tablet's own drivers. An app from a
 * plugin needs "devices" in its app.json "uses" (the card says "the home's speakers and TVs").
 *
 * list({state}) -> [{id, name, kind ('speaker', 'tv', 'streamer', 'light'...), room, maker, model, present (seen at the
 *   last scan), actions: [{name, says, params, asks}]}]; with {state: true} each also has its state. The id is this
 *   household's own for the device (keep it); never an address.
 * get(id) -> {id, name, kind, ..., state} or null. state is what the device says: for a speaker {state: 'playing' |
 *   'paused' | 'stopped', title, artist, volume (0-100), muted}; for a TV {power, app}. null when it can't tell.
 * do(id, action, args) -> {ok, text, state?}: an action from its list (a Sonos: play, pause, next, previous, set_volume
 *   {level}, volume_up {by}, volume_down {by}, mute, unmute). The first change to a device asks the people here once
 *   ("Let <app> control <device>?"); turning something on or opening an app on a TV asks every time ("asks": true).
 *   A no is {ok: false}. At most 60 a minute (then {ok: false, limited: true}). Pairing stays in Settings.
 */
export const devices = {
  list: ({ state = false } = {}) => call('/apps/devices', { state }).then((r) => r.devices || []).catch((e) => { console.warn(e.message); return []; }),
  get: (id) => call('/apps/devices/get', { id }).then((r) => (r.ok ? r : null)).catch((e) => { console.warn(e.message); return null; }),
  do: (id, action, args = {}) => call('/apps/devices/do', { id, action, args }).catch((e) => ({ ...refused(e), text: e.reason || e.message, limited: e.status === 429 })),
};

/**
 * Something on the web read through the tablet, for a site that doesn't let pages elsewhere read it (no CORS): only
 * https, only the hosts in this app's app.json "reaches" ("*.example.com" for any name under it), never the home
 * network. get(url) resolves to {status, type, text}; json(url) to the parsed body. Both throw when it can't.
 */
export const web = {
  async get(url) {
    const r = await fetched({ url: String(url) });
    const v = await r.json().catch(() => ({}));
    if (!r.ok || v.error) throw new Error(v.error || `${url}: ${r.status}`);
    return v;
  },
  /** The bytes at url (a transit feed's protobuf, a zip), up to 20 MB: a Uint8Array. Throws when it can't. */
  async bytes(url) {
    const r = await fetched({ url: String(url), binary: true });
    const v = await r.json().catch(() => ({}));
    if (!r.ok || v.error) throw new Error(v.error || `${url}: ${r.status}`);
    if (v.status < 200 || v.status >= 300) throw new Error(`${url}: ${v.status}`);
    const s = atob(v.base64 || ''), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
  async json(url) {
    const v = await web.get(url);
    if (v.status < 200 || v.status >= 300) throw new Error(`${url}: ${v.status}`);
    return JSON.parse(v.text);
  },
};

/**
 * A website this app chooses when the household sets it up (its app.json "reaches" has {"setup": "transit-feed", "why":
 * "Live arrivals from your transit agency"}; the install card said "a website you choose when you set it up").
 * ask(host, key?) puts a card on the tablet ("Let Bus times reach api.example.org?", with the PIN, in the words its card
 * had); on a yes the host joins what web.get may reach, and stays until forget(host) or the plugin is taken off.
 * Resolves to {ok} or {ok: false, error}. Only for an app from a link; the household's own apps list their hosts in
 * app.json.
 */
export const reach = {
  ask: (host, key = null) => send('/apps/reach', { host: String(host || ''), ...(key ? { key } : {}) }),
  forget: (host) => send('/apps/reach/forget', { host: String(host || '') }),
};

// ---- the rest ----------------------------------------------------------------------------------------------
/**
 * Small judgments by Opie's cloud (OpenAI Decisions), when the family chose it: questions about some text, each a
 * predicate {type:'predicate', name, instructions} (a probability), a choice {type:'choice', name, instructions,
 * choices:[{value, description}]} or a score {type:'score', name, instructions, levels:[{label, description}]}.
 * Resolves to the answers, in order ({name, probability} / {name, choice, confidence} / {name, score, confidence}), or
 * null when it isn't available (no cloud, not chosen, the month's allowance used). An app from a plugin needs "decide"
 * in its app.json "uses".
 */
export const decide = (input, questions) => call('/cloud/decide', { input: String(input || ''), questions }).then((r) => (r?.answers || null)).catch(() => null);
export const timer = { start: (label, seconds) => send('/home/timer', { start: { label: String(label || 'Timer'), seconds: Math.round(seconds) } }),
  /** Stop one (its endAt, from the home screen's timers). */
  cancel: (endAt) => send('/home/timer', { cancel: endAt }),
  /** The timers running now, [{label, total (s), endAt (ms)}] (one cleared from the home screen is gone). */
  list: () => call('/home/timer').then((r) => r?.timers || []).catch(() => null) };

/**
 * This app is in use hands-free (cooking with messy hands): the screen stays on, and while the live voice is open it
 * knows `note` (what's on the screen now: say it again as that changes) and listens `listen` seconds (8 to 30) after
 * each answer, so a short "next" works without the name. It lapses after `minutes`, or handsFree(null) ends it now.
 * Needs "say" in a plugin's app.json "uses".
 */
export const handsFree = (o) => send('/home/handsfree', o ? { note: String(o.note || ''), listen: o.listen, minutes: o.minutes } : { off: true });

/** Another of the household's apps does one of its voice actions (its app.json "actions"), as if asked aloud: the
 *  Meals app's Cook asks the Recipes app to cook that meal. Resolves to what it answered, or null. The household's own
 *  apps and ours only. */
export const askApp = (app, action, args = {}) => call('/apps/ask', { app, action, args }).then((r) => r?.text ?? null).catch(() => null);

/** Say something out loud in the assistant's voice (the display says it: its live voice, or the tablet's speech engine). */
export const say = (text, who = null) => send('/voice/say', { text, who });

/** A card with a QR code for a phone on the home Wi-Fi: 'photos' (from its camera roll into the family's photos), 'flyer', or
 *  'list' (a list to take to the store; arg: its name). Only on the display. */
// In an app's own window the shell shows the card; in a tab of the display's home (a frame there, told so with
// phone=1), the home page asks the shell for it.
const inHome = window.parent !== window && (new URLSearchParams(location.hash.slice(1)).get('phone') === '1' || screen?.kind === 'phone'); // in a tab of the display's home, or of a phone's page
const toPhone = (kind, arg) => {
  if (host?.phone) return host.phone(kind, arg);
  if (window.parent !== window && new URLSearchParams(location.hash.slice(1)).get('phone') === '1') { window.parent.postMessage({ openhouse: 'phone', kind, arg }, '*'); return true; }
  return false;
};
export const phone = {
  photos: () => toPhone('photos', ''),
  list: (name) => toPhone('list', String(name)),
  /** A photo of a flyer or school notice: the assistant reads its events into data.flyer { state, events } (nothing is
   *  added until the app adds the ones they want, then house.flyerDone()). */
  flyer: () => toPhone('flyer', ''),
  /** A photo of a recipe (a card, a cookbook page) for a meal: the assistant types it into the recipe box (watch
   *  data.mealWork["recipe|meal"], as for house.writeRecipe). */
  recipe: (meal) => toPhone('recipe', String(meal)),
  /** A web page (https) shown over the screen, on its own site only, with Done (a recipe's page, from its credit): the
   *  display never leaves for another site otherwise. False when not on the display. */
  link: (url) => toPhone('link', String(url)),
  /** The calendar is locked (data.calendarLock): the display asks for the PIN, and then the calendar can be
   *  changed for a couple of minutes (data.unlockedUntil). False when not on the display. */
  unlock: () => toPhone('pin', ''),
  /** Add one of the family's calendars (Google, iCloud, Outlook) by its link, on the display behind the PIN.
   *  False when not on the display. */
  addCalendar: () => toPhone('calendar', ''),
  /** Link an iCloud shared album (its photos kept here, up to date), on the display behind the PIN. False when
   *  not on the display. */
  addAlbum: () => toPhone('album', ''),
  /** Stop keeping a linked iCloud album here (its link's id, data.linked[].id): on the display, behind the PIN when
   *  the lock is on. Its photos come off with it. False when not on the display. */
  stopAlbum: (id) => toPhone('unlink', String(id)),
  /** The household's lasting photo page for phones (any time, from the share sheet too), behind the PIN. */
  sharePhotos: () => toPhone('share', ''),
  /** Photos picked in Google Photos (Google's picker, signed in on a phone), behind the PIN. */
  googlePhotos: () => toPhone('google', ''),
};

export const shell = {
  /** Back to the home screen. */
  close: () => (host?.close ? host.close() : SCREEN ? window.parent.postMessage({ oh: 'close' }, '*') : history.back()),
  /** Open another of the household's apps: its tab, or full screen (the home screen does it, for an app in one of its
   *  tabs). False where it can't; canOpenApps says whether it can. */
  openApp: (id) => { if (!inHome) return false; window.parent.postMessage({ openhouse: 'open', app: String(id) }, '*'); return true; },
  canOpenApps: inHome,
  app: APP,
};

/** An element: h('div', { class, style, tap, hold, ...attributes }, ...children). tap/hold are touch-first presses. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'tap' || k === 'hold') continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (props?.tap || props?.hold) { press(el, props.tap, props.hold); if (tag !== 'button' && tag !== 'input' && props.tap && !props.role) { el.tabIndex = 0; el.setAttribute('role', 'button'); } }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/** A tap (finger up without moving) and a hold (about half a second), on any element. */
export function press(el, tap, hold) {
  let t = 0, x = 0, y = 0, down = false;
  const stop = () => { down = false; clearTimeout(t); };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); down = true; x = e.clientX; y = e.clientY;
    if (hold) t = setTimeout(() => { down = false; hold(e); }, 550);
  });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - x, e.clientY - y) > 14) stop(); });
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointerup', (e) => { const was = down; stop(); if (was) { e.stopPropagation(); tap?.(e); } });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // A tap doesn't move the keyboard's focus (it stays in the field being typed in); Tab still reaches everything.
  el.addEventListener('mousedown', (e) => { if (e.target === el || !e.target.closest?.('input, textarea')) e.preventDefault(); });
  // A keyboard (the cover) works it too: Enter or Space taps.
  if (tap) el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el && !el.disabled) { e.preventDefault(); tap(e); } });
}

/** A day as "YYYY-MM-DD", in the tablet's own time (local, not UTC). */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The Date of a day's key, at noon local (so an hour's change either way is still that day). */
export const dateOf = (key) => { const [y, m, d] = String(key).split('-').map(Number); return new Date(y, m - 1, d, 12); };
/** The key n days from a day's key (n may be negative). Counted from noon, so a change to or from daylight saving
 *  time never skips or repeats a day. */
export const addDays = (key, n) => { const d = dateOf(key); d.setDate(d.getDate() + n); return dayKey(d); };

/** Which version of the kit this is (an app's app.json "kit"). */
export const version = 2;
