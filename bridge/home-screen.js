// The home screen's state: the notes on it, where everything sits, its look, timers and the whiteboard. The
// assistant puts notes up, changes them and takes them down with tools (an MCP server, `home`), the same way whether
// it is answering someone or keeping the home screen current. The family moves and resizes anything on it, keeps a
// note, or drags anything to the trash; whatever they trash can be put back (on the screen, or put_back).
//
// It is laid out like a phone's home screen (grid.js): pages of cells, and everything on it takes a few of them
// (notes and widgets 1x1 up to 4x4, apps 1x1). Things never overlap: what's in the way makes room. The first
// page is what the kitchen sees; the others only when someone swipes, so the assistant chooses what is worth
// the first page, keeps notes short, and takes things down when they're done.
//
// GET  /home                   { notes:[{…, page, col, row, size}], places, grid, v }   size: the note's shape ("2x1")
// GET  /home/wait?v=N          the same, once it changes (or after 25 s)
// GET  /home/whiteboard        the Whiteboard's drawing for Home's card: {img (a data: picture), w, h, at, empty}
// POST /home/remove {id}       the family took it down (dragged to the trash: kept a while, so it can be put back)
// POST /home/putback {key}     put back something the family trashed: a note's id, or a place key
// POST /home/keep {id, keep}   the family wants it kept (no expiry; the assistant asks before removing)
// POST /home/touch {id}        someone opened it up close
// POST /home/arrange {items:[{key, page, col, row, w, h}], present?:[key]}  the display moved or resized things (a drag
//                              and what made room for it; or where it put something new). key: a note's id, "clock",
//                              "weather", "app:<id>", "own:<key>". present: everything on the home screen now (not a note)
// POST /home/place {key, hidden} someone dragged the clock, the weather, an app or the home app's own thing to the trash
// POST /home/move, /home/place with x, y (u): from before the grid; the nearest cell
// POST /home/mcp               MCP (JSON-RPC over HTTP), bearer token; tools below
// /door and /door/... are the same (homePath): their first name, still used by phones and shells from before.
//
// Each run (a conversation turn, a curation, a refit) reaches the tools with a token of its own, so the
// tools know whose they are: who put a note up, whose `progress` it is, which conversation ends. An
// agent whose tool connection is shared by all its runs (Codex's app-server) uses the one shared
// token; its runs take turns (`exclusive`), so the shared token always means the run going now.
//
// file: door.json next to the chats (its first name, kept so tablets and backups need no move).
import fs from 'node:fs';
import { readJson, writeJson, unsaved } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';
import crypto from 'node:crypto';
import * as G from './grid.js';

/** /door, /door/x (the first names, which older phones, shells and the cloud's phone page still call) as /home, /home/x. */
export const homePath = (u) => /^\/door(?=$|[/?])/.test(u) ? '/home' + u.slice(5) : u;

const SIZE_HELP = `cells across x down, on a ${G.COLS} x ${G.ROWS} grid (one cell is an app's square): ` +
  '1x1 (one number or a word or two), 2x1 (a line or two, a short list), 2x2 (a list, a picture, a recipe card), ' +
  '4x2 (something to follow along with), 4x4 (rarely: half the page)';
/** The starting apps: the display draws a live widget for each from the house's data (house.js), so they work with no AI. */
export const BUILT_IN_WIDGETS = { calendar: '2x2', chores: '2x2', lists: '2x2', meals: '2x1', photos: '2x2' };
/**
 * How the family wants the home screen to look (apps/home/style.json, which the assistant edits like an app; the
 * display's own "Tabs and look" sheet writes it too, through POST /home/look):
 *   tabs      the tabs, in order: "today" (the day, and the notes put up), "apps" (every app that isn't a tab, and the
 *             Android apps added), or an app's id ("calendar", "homework"); an entry may be {"id": "homework",
 *             "name": "School"} to name it differently. Missing: today, the five starting apps, apps. A "board" tab
 *             (what the home screen had before Apps) reads as "apps".
 *   palette   "paper" (warm, the default), "linen" (warmer), "sage", "mist" (cool), "dusk" (dark)
 *   colors    {"bg", "sheet", "ink", "accent"}: "#rrggbb" each, over the palette's own
 *   type      "clean" (the default, a quiet sans), "serif", "round", "hand": the face of the whole screen
 *   density   "calm" (the default, roomy) or "snug" (smaller type, more on screen)
 *   backdrop  "none" (the default) or "photos": the family's photos behind the screen, one every 5 minutes
 *   cards     the apps' own cards on Home, in order: app ids (an app offers one with a widget.html and "today" in its
 *             app.json; apps.js list). None until someone turns one on.
 *   door      "#rrggbb", the screen's color, under the scenery if any (the key keeps its first name, as households' files have it)
 *   clock     true (the board's clock), "compact" (a small dark clock with the date), or false (no clock)
 *   scenery   up to 10 https picture URLs shown behind the board, one at a time (5 minutes each)
 *   weather   "family" for the deep-blue weather card with the hours and an animated sky; else the plain one
 */
export const PALETTES = ['paper', 'linen', 'sage', 'mist', 'dusk'];
export const TYPES = ['clean', 'serif', 'round', 'hand'];
/** Home's own cards (chat/src/home.jsx TODAY_CARDS); an app's card is "app:<its id>". */
export const TODAY_CARDS = ['calendar', 'weather', 'lunch', 'whiteboard', 'recipes', 'meals', 'lists', 'chores', 'notes', 'photos'];
/**
 * The cards Home shows, in order, while the household hasn't arranged them (style.json has no "today"; home.jsx
 * TODAY_DEFAULT). Arranging them in Tabs and look (or set_home, today_card) saves the whole list, and from then on only
 * they change it: a new default never moves a household's own. Version 2 (2026-11-25): Dinner off (it can be added),
 * the Whiteboard and a recipe to try on, the list after them (smaller).
 */
export const TODAY_DEFAULT = ['calendar', 'weather', 'lunch', 'whiteboard', 'chores', 'photos', 'lists', 'notes'];
/** The cards on Home now, in order: the household's list, else the default with the apps' cards that are on before the photos. */
export function todayNow(st = {}) {
  if (Array.isArray(st.today)) return st.today;
  const d = [...TODAY_DEFAULT], at = d.indexOf('photos');
  d.splice(at < 0 ? d.length : at, 0, ...(Array.isArray(st.cards) ? st.cards : []).map((x) => 'app:' + x));
  return d;
}
const TAB_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
const HEX = /^#[0-9a-f]{6}$/i;
export function cleanLook(s = {}) {
  const tabs = Array.isArray(s.tabs) ? s.tabs.map((t) => (typeof t === 'string' ? { id: t } : t && typeof t === 'object' ? { id: t.id, ...(typeof t.name === 'string' && t.name.trim() ? { name: t.name.trim().slice(0, 24) } : {}) } : null))
    .map((t) => (t?.id === 'board' ? { id: 'apps' } : t)) // the board is gone: Apps takes its place (a name it had was for the board)
    .filter((t, i, a) => t && typeof t.id === 'string' && TAB_ID.test(t.id) && t.id !== 'home' && a.findIndex((x) => x?.id === t.id) === i).slice(0, 14) : null;
  const colors = s.colors && typeof s.colors === 'object' ? Object.fromEntries(['bg', 'sheet', 'ink', 'accent'].filter((k) => HEX.test(s.colors[k] || '')).map((k) => [k, s.colors[k]])) : {};
  return {
    tabs: tabs && tabs.length ? tabs : null,
    palette: PALETTES.includes(s.palette) ? s.palette : 'paper',
    colors,
    type: TYPES.includes(s.type) ? s.type : 'clean',
    density: s.density === 'snug' ? 'snug' : 'calm',
    backdrop: s.backdrop === 'photos' ? 'photos' : 'none',
    cards: Array.isArray(s.cards) ? s.cards.filter((id, i, a) => typeof id === 'string' && TAB_ID.test(id) && id !== 'home' && a.indexOf(id) === i).slice(0, 9) : [],
    // which of Home's cards show, in order (null: all of them, in the usual order)
    today: Array.isArray(s.today) ? s.today.filter((id, i, a) => typeof id === 'string' && (TODAY_CARDS.includes(id) || (id.startsWith('app:') && TAB_ID.test(id.slice(4)))) && a.indexOf(id) === i).slice(0, 20) : null,
  };
}
// What the display is showing: the home screen's tab ("today", "apps" or an app's id), so "make this bigger" means
// it. The display reports each change (POST /home/showing); a report older than an hour counts for nothing.
let showing = null;
/** Is this app one of the home screen's tabs? */
// The tabs a home screen has until the family changes them (chat/src/home.jsx DEFAULT_TABS).
export const DEFAULT_TABS = ['today', 'calendar', 'weather', 'map', 'chores', 'lists', 'meals', 'recipes', 'photos', 'whiteboard', 'apps'];
/** Is this app one of the home screen's tabs (the usual set counts, before anyone changed them)? */
export function isTab(app) { return (readStyle().tabs || DEFAULT_TABS).some((t) => (typeof t === 'string' ? t : t?.id) === app); }
export function showingTab() { return showing && Date.now() - showing.at < 3600e3 ? showing.tab : null; }
/** A request's app: the one the shell says is open full screen, else the app in the home screen's tab. */
export function requestApp(app) {
  if (app && TAB_ID.test(String(app)) && app !== 'home') return String(app);
  const t = showingTab();
  return t && t !== 'today' && t !== 'apps' && t !== 'board' ? t : null;
}
const styleFile = () => path.join(process.env.OPENHOUSE_APP_DIR || '', 'apps/home/style.json');
/** A household set up before the version 2 default (2026-11-25) keeps the cards it had (Dinner on, no Whiteboard or
 *  recipe): what it saw stays what it sees until someone arranges Home (homeScreenRoutes decides once, home-default.json). */
export const TODAY_DEFAULT_V1 = ['calendar', 'weather', 'lunch', 'meals', 'lists', 'chores', 'notes', 'photos'];
let keepV1 = false;
const readStyle = () => {
  let s = {}; try { s = JSON.parse(fs.readFileSync(styleFile(), 'utf8')) || {}; } catch {}
  return keepV1 && !Array.isArray(s.today) ? { ...s, today: [...TODAY_DEFAULT_V1, ...(Array.isArray(s.cards) ? s.cards : []).map((x) => 'app:' + x)] } : s;
};
function homeStyle() {
  const s = readStyle();
  return {
    door: HEX.test(s.door || '') ? s.door : null,
    clock: s.clock === false ? false : s.clock === 'compact' ? 'compact' : true,
    scenery: (Array.isArray(s.scenery) ? s.scenery : []).filter((u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(u)).slice(0, 10),
    weather: s.weather === 'family' ? 'family' : null,
    ...cleanLook(s),
  };
}
/** What each kind of thing on the home screen is when nobody has sized it (the home app's own things: the display measures them). */
const DEFAULT_SHAPE = (key, widgets = {}) => (key === 'clock' ? '2x1' : key === 'weather' ? '2x2' : key === 'whiteboard' ? '2x2'
  : key.startsWith('app:') ? BUILT_IN_WIDGETS[key.slice(4)] || (widgets[key.slice(4)] ? '2x2' : '1x1') : key.startsWith('timer:') ? '1x1' : null);
const hasWidget = (key, widgets = {}) => key.startsWith('app:') && !!(BUILT_IN_WIDGETS[key.slice(4)] || widgets[key.slice(4)]);

export function homeScreenRoutes({ DIR, json, body, edits = null, APP_DIR = null }) {
  const FILE = registered('home-screen', path.join(DIR, 'door.json'));
  // Which default this household's Home has, decided once: one already set up (its family saved) when this came keeps
  // version 1; a new one gets version 2.
  {
    const f = path.join(DIR, 'home-default.json');
    let v = null; try { v = JSON.parse(fs.readFileSync(f, 'utf8')).v; } catch {}
    if (v !== 1 && v !== 2) {
      let setUp = false; try { setUp = (JSON.parse(fs.readFileSync(path.join(DIR, '../household.json'), 'utf8')).family || []).length > 0; } catch {}
      v = setUp ? 1 : 2;
      try { fs.writeFileSync(f, JSON.stringify({ v })); } catch (e) { console.error('[home] default not kept:', e.message); }
    }
    keepV1 = v === 1;
  }
  const TOKEN = crypto.randomUUID();
  let version = 1;
  const waiters = new Set();
  /** Tools called outside any run (or by a run that hasn't started yet) count as keeping the home screen current. */
  const NOBODY = Object.freeze({ by: 'assistant', who: null, conversation: null, touched: null });
  const runs = new Map(); // token -> the run's context (null: minted ahead, its run hasn't started)
  const minted = new Map(); // token -> when, for tokens minted ahead (a warm agent)
  let shared = null; // the exclusive run going now: what the shared TOKEN means
  let turn = Promise.resolve(); // exclusive runs, one after another
  const mint = () => {
    const t = crypto.randomUUID();
    runs.set(t, null); minted.set(t, Date.now());
    for (const [k, at] of minted) if (Date.now() - at > 30 * 60e3) { minted.delete(k); if (runs.get(k) === null) runs.delete(k); }
    return t;
  };
  /** Whose tools these are, by the bearer token; undefined: not a home-screen token at all. */
  const contextOf = (token) => (runs.get(token) || (runs.has(token) ? NOBODY : token === TOKEN ? shared || NOBODY : undefined));

  // Written to a temp file and renamed, so a power cut mid-write can't leave half a file; the previous
  // version is kept as door.json.bak and read if the main one is ever unreadable.
  const read = () => readJson(FILE, null) || { notes: [] };
  // A save that's refused or fails puts the home screen back as it was last saved and throws (marked unsaved: store.js
  // unsaved says what to answer), so what shows is what's on disk.
  let saved = null; // the home screen as last saved (or read), as JSON
  const write = () => {
    try { writeJson(FILE, homeScreen); saved = JSON.stringify(homeScreen); }
    catch (e) { if (saved != null) homeScreen = JSON.parse(saved); console.error('[home]', e.message); throw Object.assign(e, { unsaved: true }); }
  };
  // Start-up's own one-time moves: one that can't be saved (a door.json a newer release saved) is kept in memory only,
  // never a reason to stop (the shell would only start the bridge again, and again).
  const writeAtStart = () => { try { writeJson(FILE, homeScreen); } catch (e) { console.error('[home] not saved at start:', e.message); } };
  let homeScreen = read();
  homeScreen.notes ||= [];
  for (const n of homeScreen.notes) { n.content = fenced(n.content); delete n.refitting; } // notes saved in an older shape read right again; no refit outlives a restart
  homeScreen.places ||= {}; // where the other things on the home screen are (the clock, the weather, apps, the home app's own things)
  homeScreen.trash ||= []; // notes the family dragged to the trash, newest first, so they can be put back
  // Once, when the board became the Apps tab and notes moved to Home: the notes the assistant kept current for the
  // board on its own (by: 'assistant', from its hourly look) are put aside, kept in door.json, so Today shows the notes
  // someone asked for.
  if (!homeScreen.notesOnToday) { homeScreen.notesOnToday = true; homeScreen.boardNotes = homeScreen.notes.filter((n) => n.by === 'assistant'); homeScreen.notes = homeScreen.notes.filter((n) => n.by !== 'assistant'); writeAtStart(); }
  homeScreen.present ||= null; // what the display last said is on the home screen (not notes); null: it hasn't yet
  // The whiteboard on the home screen: what the family drew, as strokes ({c: color, w: width, p: [x, y, ...]}, 0-1000 across
  // and down its box). `was`: what a clear wiped, so undo brings it back.
  homeScreen.sketch ||= { v: 0, strokes: [], was: null };
  homeScreen.timers ||= []; // kitchen timers, {label, total (s), endAt (ms)}: on the home screen as "timer:<endAt>". The shell rings them; screens show them too.
  // Once, before the home screen first moves onto the grid: the free-form board as it was, kept (door.json.pregrid), in case it's wanted back.
  try { if (!homeScreen.widgetsOnHome && fs.existsSync(FILE) && !fs.existsSync(FILE + '.pregrid')) fs.copyFileSync(FILE, FILE + '.pregrid'); } catch {}
  if (!homeScreen.widgetsOnHome) { // once: the starting apps' icons become their widgets, where they are (what's in the way makes room)
    homeScreen.widgetsOnHome = true;
    toGrid(homeScreen);
    for (const [app, shape] of Object.entries(BUILT_IN_WIDGETS)) {
      const key = 'app:' + app, p = homeScreen.places[key];
      if (!p || p.hidden || p.col == null || (p.w || 1) * (p.h || 1) > 1) continue;
      const all = [...Object.entries(homeScreen.places).filter(([k, q]) => k !== key && !q.hidden && q.col != null).map(([k, q]) => ({ key: k, page: q.page | 0, col: q.col, row: q.row, w: q.w || 1, h: q.h || 1 })),
        ...homeScreen.notes.filter((n) => n.col != null).map((n) => ({ key: n.id, page: n.page | 0, col: n.col, row: n.row, ...G.dims(n.size) }))];
      const { w, h } = G.dims(shape);
      for (const m of G.makeRoom(all, key, { page: p.page | 0, col: p.col, row: p.row, w, h })) {
        const n = homeScreen.notes.find((x) => x.id === m.key);
        const q = homeScreen.places[m.key];
        if (n) Object.assign(n, { page: m.page, col: m.col, row: m.row });
        else homeScreen.places[m.key] = { ...q, page: m.page, col: m.col, row: m.row, ...(q?.w != null || m.key === key ? { w: m.w, h: m.h } : {}) }; // the home app's things keep being measured
      }
    }
    writeAtStart();
  }
  homeScreen.widgets ||= {}; // app id -> { content (a layout, like a note's), shapes: { "4x2": content for that shape }, at }: what agent-made apps show on the home screen
  if (toGrid(homeScreen)) writeAtStart();
  saved = JSON.stringify(homeScreen);
  // A change to how the home screen looks (the assistant's edit, an undo) reaches every screen at once.
  // A change to the apps reaches every screen at once: the look (apps/home, the assistant's edit or an undo), and an
  // app's own files (appsV: when each last changed), so a tab showing that app loads it again and they watch it change.
  const appsV = {};
  try {
    const d = path.join(APP_DIR || process.env.OPENHOUSE_APP_DIR || '', 'apps'); fs.mkdirSync(path.join(d, 'home'), { recursive: true });
    let t = 0;
    fs.watch(d, { recursive: true }, (_, f) => {
      const id = String(f || '').split(/[\\/]/)[0];
      if (id && id !== 'home' && TAB_ID.test(id)) appsV[id] = Date.now();
      clearTimeout(t); t = setTimeout(tell, 300); // (appsV is kept in memory only)
    }).unref?.();
  } catch {}
  // What a paired computer is changing (workshop.js): a quiet line on the home screen instead of the assistant looking
  // busy, and a tab to show (its app, while the computer checks it). Not kept: gone after a restart.
  // An app in use hands-free (the Recipes app while cooking): the screen stays on, and the live voice knows what's on it
  // and listens a while after each answer (live-tools.js). Until it says so, or `until`. Not kept.
  const live = { computer: null, show: null, handsFree: null };
  const handsFree = () => (live.handsFree && live.handsFree.until > Date.now() ? live.handsFree : null);
  /** Saved, and every screen told (also when it wasn't saved: they show it as it was put back). */
  function save() {
    try { write(); } finally { tell(); }
  }
  /** Every screen told the home screen changed (what changed isn't kept: live, appsV). */
  function tell() {
    version++;
    const out = view();
    for (const w of waiters) w(out);
    waiters.clear();
  }

  // ---- space ----
  // Everything on the home screen, as grid items: notes, then the rest (what the display says is there, or every place it ever had).
  const onHome = (p, k) => !p.hidden && p.col != null && (!homeScreen.present || homeScreen.present.includes(k));
  const items = (but = null) => [
    ...Object.entries(homeScreen.places).filter(([k, p]) => k !== but && onHome(p, k)).map(([key, p]) => ({ key, page: p.page | 0, col: p.col, row: p.row, w: p.w || 1, h: p.h || 1 })),
    ...homeScreen.notes.filter((n) => n.id !== but && n.col != null).map((n) => ({ key: n.id, page: n.page | 0, col: n.col, row: n.row, ...G.dims(n.size) })),
  ];
  /** Put [moved] (grid items, each with a key) where they say, back into the notes and places. */
  function apply(moved) {
    for (const m of moved) {
      const n = homeScreen.notes.find((x) => x.id === m.key);
      const at = { page: m.page, col: m.col, row: m.row };
      if (n) Object.assign(n, at);
      else if (/^[\w:.-]{1,80}$/.test(m.key)) homeScreen.places[m.key] = { ...homeScreen.places[m.key], ...at, w: m.w, h: m.h };
    }
  }
  /** [key] (w x h) to [want] ({page, col, row}), whatever is there making room; or, with no [want], the first free spot. */
  function settleOne(key, w, h, want) {
    const all = items(key);
    if (!want) { const f = G.firstFree(all, w, h); apply([{ key, ...f }]); return f; }
    const next = G.makeRoom(all, key, { ...want, w, h });
    const was = new Map(all.map((i) => [i.key, i]));
    apply(next.filter((i) => i.key === key || JSON.stringify(i) !== JSON.stringify(was.get(i.key))));
    return next.find((i) => i.key === key);
  }
  /** The spot an assistant asked for (page, col, row count from 1), or null for "anywhere free". */
  const wanted = (a, was) => (a.page == null && a.col == null && a.row == null ? null
    : { page: a.page != null ? Math.max(0, Number(a.page) - 1) : was?.page ?? 0, col: a.col != null ? Number(a.col) - 1 : was?.col ?? 0, row: a.row != null ? Number(a.row) - 1 : was?.row ?? 0 });
  const where = (i) => `page ${(i.page | 0) + 1}, col ${i.col + 1}, row ${i.row + 1}`;

  function expire() {
    const now = Date.now(), before = homeScreen.notes.length, timers = homeScreen.timers.length;
    homeScreen.notes = homeScreen.notes.filter((n) => !n.until || n.until > now || n.keep);
    homeScreen.timers = homeScreen.timers.filter((t) => t.endAt > now - 10 * 60e3); // rung long ago (the shell stops ringing after 5 min)
    // (on a timer and before a read: one that can't be saved is put back and tried again next time, never thrown)
    if (homeScreen.notes.length !== before || homeScreen.timers.length !== timers) { try { save(); } catch {} }
  }
  /** A timer started (by the shell, a screen, a note's Timer), or put back with the time it had: by when it rings. */
  function startTimer(a) {
    const label = String(a.label || 'Timer').slice(0, 40);
    const endAt = Number.isFinite(Number(a.endAt)) && Number(a.endAt) > 0 ? Math.round(Number(a.endAt)) : Date.now() + Math.round(Number(a.seconds) * 1000);
    const total = Math.round(Number(a.total ?? a.seconds ?? (endAt - Date.now()) / 1000));
    if (!(endAt > Date.now() - 60e3 && endAt < Date.now() + 86400e3) || !(total >= 1 && total <= 86400)) return null;
    if (!homeScreen.timers.some((t) => t.endAt === endAt)) homeScreen.timers.push({ label, total, endAt });
    save();
    return endAt;
  }
  function cancelTimer(endAt) {
    const before = homeScreen.timers.length;
    homeScreen.timers = homeScreen.timers.filter((t) => t.endAt !== Number(endAt));
    delete homeScreen.places['timer:' + Number(endAt)];
    save();
    return homeScreen.timers.length !== before;
  }
  setInterval(expire, 20e3).unref?.();

  /**
   * The home screen's tabs and look (apps/home/style.json), changed in one step: from the "Tabs and look" sheet
   * (POST /home/look) and from the assistant (set_home). Only the keys given change. It's a change like any other,
   * so "undo" takes it back: its own commit, or part of the turn's when that turn is already editing.
   */
  function setLook(b, turn = null, who = null) {
    const keys = ['tabs', 'palette', 'colors', 'type', 'density', 'backdrop', 'cards', 'today'].filter((k) => b[k] !== undefined);
    if (!keys.length) return { error: 'Nothing to change: give tabs, palette, colors, type, density, backdrop or cards.' };
    const next = { ...readStyle() };
    for (const k of keys) next[k] = b[k];
    const clean = cleanLook(next);
    for (const k of keys) {
      if (k === 'colors' && !Object.keys(clean.colors).length) delete next.colors;
      else if (k === 'tabs') { if (clean.tabs) next.tabs = clean.tabs.map((t) => (t.name ? t : t.id)); else delete next.tabs; }
      else if (k === 'cards' && !clean.cards.length) delete next.cards;
      else if (k === 'today' && !clean.today) delete next.today;
      else next[k] = clean[k];
    }
    const holding = !!(turn && edits?.holder?.() === turn);
    const owner = { id: 'look', kind: 'look', who, text: keys.includes('tabs') ? 'Change the tabs' : keys.every((k) => k === 'cards' || k === 'today') ? 'Change the cards on Home' : 'Change the look' };
    if (edits && !holding && !edits.tryAcquire(owner, { checkpoint: true })) return { error: edits.busyText?.() || 'Busy', busy: true };
    try {
      fs.mkdirSync(path.dirname(styleFile()), { recursive: true });
      writeJson(styleFile(), next, { bak: false, space: 2, newline: true }); // (in the apps' git folder: no .bak beside it)
      if (edits && !holding) edits.finish(owner, true);
    } catch (e) { if (edits && !holding) edits.finish(owner, false); return { error: e.message }; }
    save();
    return { style: homeStyle() };
  }

  // The alarm clocks (alarms.js): their own store; here so every screen and the shell get them with the rest.
  let alarmsOf = () => null;
  let boardOf = () => null, boardAt = 0;
  /** The drawing for Home's card: a picture of it (only an image's data address), its size, and whether it's blank. */
  function whiteboard() {
    const b = boardOf() || {};
    const img = typeof b.img === 'string' && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.img) ? b.img : null;
    return { at: Number(b.at) || 0, empty: !img || b.empty === true, ...(img && b.empty !== true ? { img } : {}), w: Number(b.w) || 0, h: Number(b.h) || 0 };
  }
  function view() {
    return { v: version, whiteboard: boardAt, computer: live.computer, show: live.show, handsFree: handsFree() && { app: live.handsFree.app, until: live.handsFree.until }, sketch: homeScreen.sketch.v, notes: homeScreen.notes, places: homeScreen.places, timers: homeScreen.timers, alarms: alarmsOf(), trash: homeScreen.trash.map((n) => ({ id: n.id, title: n.title })),
      grid: { cols: G.COLS, rows: G.ROWS, reserved: G.RESERVED, shapes: G.SHAPES },
      // Apps with a widget (bigger than 1x1 they show it, at 1x1 their icon) and the shape each starts at; agent-made apps' widget layouts.
      style: homeStyle(), appsV, widgets: { builtin: BUILT_IN_WIDGETS, starts: Object.fromEntries(Object.keys(homeScreen.widgets).map((k) => [k, '2x2'])), content: homeScreen.widgets } };
  }

  const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const label = (i) => { const n = homeScreen.notes.find((x) => x.id === i.key); return n ? `note ${n.id} "${n.title}"` : i.key.startsWith('app:') ? `app ${i.key.slice(4)}` : i.key.startsWith('own:') ? `the home app's ${i.key.slice(4)}` : i.key; };
  /** The notes, for the assistant: they show on the Home tab, newest first (a title and a line; a tap opens one). */
  function describe() {
    expire();
    const mine = homeScreen.notes;
    const lines = [mine.length ? 'Notes on Home now (newest first; Home shows five):' : 'No notes on Home.'];
    for (const x of [...mine].reverse().sort((a, b) => (b.at || 0) - (a.at || 0))) lines.push(`- ${x.id} "${x.title}"; ` +
        `${x.by === 'family' ? 'kept by the family' : x.keep ? 'kept' : x.until ? `comes down by itself in ${Math.max(1, Math.round((x.until - Date.now()) / 60e3))} min` : 'stays until taken down'}` +
        `${x.for ? `; for ${x.for}` : ''}; put up ${ago(x.at)} by ${x.by === 'chat' ? `you, answering ${x.askedBy || 'someone'}` : 'the family'}` +
        `${x.touched ? `; last opened ${ago(x.touched)}` : ''}`);
    if (homeScreen.trash.length) lines.push(`Taken down by the family (put_back brings one back): ${homeScreen.trash.map((x) => `${x.id} "${x.title}"`).join(', ')}.`);
    return lines.join('\n');
  }

  function snapshot(n, context) {
    if (!context?.touched) return;
    const i = context.touched.findIndex((t) => t.id === n.id);
    if (i >= 0) context.touched.splice(i, 1);
    context.touched.push({ id: n.id, title: n.title, content: n.content, size: n.size, paper: n.paper, color: n.color, page: n.page, col: n.col, row: n.row });
  }

  /** UI lines sent without their ```spec fence would show as raw text: put the fence back. */
  function fenced(content) {
    let t = String(content || '');
    // A whole layout written as one JSON object ({"root", "elements"}), maybe in a ```spec fence: the same thing as
    // patch lines, which is what the screen reads.
    const whole = t.replace(/^\s*```(?:spec|json)?\s*/, '').replace(/\s*```\s*$/, '');
    if (/^\s*\{\s*"root"/.test(whole)) try {
      const o = JSON.parse(whole);
      if (o && o.root && o.elements) {
        t = '```spec\n' + [JSON.stringify({ op: 'add', path: '/root', value: o.root }),
          ...Object.entries(o.elements).map(([k, v]) => JSON.stringify({ op: 'add', path: '/elements/' + k, value: v })),
          ...(o.state ? [JSON.stringify({ op: 'add', path: '/state', value: o.state })] : [])].join('\n') + '\n```';
        return t;
      }
    } catch {}
    if (t.includes('```spec') || !/^\s*\{"op"\s*:/m.test(t)) return t;
    const lines = t.split('\n'), ui = lines.filter((l) => /^\s*\{"op"\s*:/.test(l)), prose = lines.filter((l) => !/^\s*\{"op"\s*:/.test(l) && l.trim());
    return (prose.length ? prose.join('\n') + '\n\n' : '') + '```spec\n' + ui.join('\n') + '\n```';
  }

  // ---- changes (used by the tools and by fallbacks) ----
  function put(a, opts = {}, context = NOBODY) {
    expire();
    const size = G.shapeOf(a.shape ?? a.size) || '2x1';
    const n = {
      id: 'n-' + crypto.randomUUID().slice(0, 6), title: (String(a.title || '').trim() || 'Note').slice(0, 60), content: fenced(a.content),
      size, paper: a.paper || null, color: a.color || null, for: a.for || null,
      keep: !!a.keep, until: a.keep ? null : a.minutes ? Date.now() + Number(a.minutes) * 60e3 : null,
      by: context.by, askedBy: context.who, conversation: context.conversation, at: Date.now(), touched: null,
    };
    if (!n.content.trim()) return { error: 'content is empty' };
    homeScreen.notes = [...homeScreen.notes, n];
    const { w, h } = G.dims(size);
    settleOne(n.id, w, h, wanted(a));
    save(); snapshot(n, context);
    if (n.for) try { handle.onNoteFor?.(n); } catch {} // a phone of theirs gets it (screens.js notify, docs/phones-and-tv.md)
    return { note: n };
  }
  function update(a, context = NOBODY) {
    const n = homeScreen.notes.find((x) => x.id === a.id);
    if (!n) return { error: `No note ${a.id}.\n\n${describe()}` };
    const next = { ...n };
    for (const k of ['title', 'content', 'paper', 'color', 'for']) if (a[k] != null && String(a[k]).trim()) next[k] = String(a[k]);
    next.content = fenced(next.content);
    const shape = G.shapeOf(a.shape ?? a.size);
    if (shape) next.size = shape;
    if (a.keep != null) { next.keep = !!a.keep; if (next.keep) next.until = null; }
    if (a.minutes != null && !next.keep) next.until = Number(a.minutes) > 0 ? Date.now() + Number(a.minutes) * 60e3 : null;
    homeScreen.notes = homeScreen.notes.map((x) => (x.id === n.id ? next : x));
    const want = wanted(a, n);
    if (want || next.size !== n.size || next.col == null) { const { w, h } = G.dims(next.size); settleOne(n.id, w, h, want || (next.col != null ? { page: next.page, col: next.col, row: next.row } : null)); }
    save(); snapshot(next, context);
    return { note: next };
  }
  /** An app's widget on the home screen: a layout like a note's content (for every shape, or one [shape]); empty content takes it away. */
  function setWidget(a) {
    const app = String(a.app || '').replace(/^app:/, '').trim();
    if (!/^[\w.-]{1,80}$/.test(app)) return { error: 'Which app? Its id, as in "app:<id>" on the home screen.' };
    if (BUILT_IN_WIDGETS[app]) return { error: `${app} is a starting app: the display draws its widget from the house's data. Change the data (the house tools), or resize it with move_on_home.` };
    const content = fenced(a.content);
    const shape = a.shape ? G.shapeOf(a.shape) : null;
    if (a.shape && !shape) return { error: `Shapes: ${G.SHAPES.join(', ')}.` };
    if (!content.trim()) {
      if (shape && homeScreen.widgets[app]?.shapes) delete homeScreen.widgets[app].shapes[shape]; else delete homeScreen.widgets[app];
    } else {
      const w = homeScreen.widgets[app] || { content: null, shapes: {} };
      if (shape) w.shapes = { ...w.shapes, [shape]: content }; else w.content = content;
      homeScreen.widgets[app] = { ...w, at: Date.now() };
    }
    // A widget only shows bigger than 1x1: an app that's still an icon grows to its first shape where it is.
    const p = homeScreen.places['app:' + app];
    if (homeScreen.widgets[app] && p && !p.hidden && p.col != null && (p.w || 1) * (p.h || 1) === 1) {
      const { w, h } = G.dims(shape && shape !== '1x1' ? shape : '2x2'); settleOne('app:' + app, w, h, p);
    }
    if (!homeScreen.widgets[app] && p && (p.w || 1) * (p.h || 1) > 1) { p.w = 1; p.h = 1; }
    save();
    return { ok: true };
  }
  /** Move or resize anything on the home screen (a note by id, or "clock", "weather", "app:<id>", "own:<key>"); what's in the way makes room. */
  function arrange(a) {
    const key = String(a.what || a.id || '');
    const n = homeScreen.notes.find((x) => x.id === key), p = homeScreen.places[key];
    if (!n && !(p && onHome(p, key))) return { error: `Nothing called ${key} on the home screen.\n\n${describe()}` };
    const was = n ? { page: n.page | 0, col: n.col, row: n.row, ...G.dims(n.size) } : { page: p.page | 0, col: p.col, row: p.row, w: p.w || 1, h: p.h || 1 };
    let shape = G.shapeOf(a.shape);
    if (key.startsWith('app:') && !hasWidget(key, homeScreen.widgets)) shape = '1x1';
    const { w, h } = shape ? G.dims(shape) : was;
    if (n && shape && shape !== n.size) { const from = n.size; n.size = shape; setTimeout(() => handle.onResize?.(n, from), 0); }
    const at = settleOne(key, w, h, wanted(a, was) || was);
    save();
    return { at };
  }
  function remove(id) {
    const before = homeScreen.notes.length;
    homeScreen.notes = homeScreen.notes.filter((x) => x.id !== id);
    if (homeScreen.notes.length === before) return { error: `No note ${id}` };
    save();
    return { ok: true };
  }
  /** The family dragged a note to the trash: off the home screen, but kept (the newest 20) so it can be put back. */
  function trash(id) {
    const n = homeScreen.notes.find((x) => x.id === id);
    if (!n) return false;
    homeScreen.notes = homeScreen.notes.filter((x) => x !== n);
    homeScreen.trash = [{ ...n, trashed: Date.now() }, ...homeScreen.trash.filter((x) => x.id !== id)].slice(0, 20);
    save();
    return true;
  }
  /** Put back something the family trashed: a note (by id) or anything else on the home screen (by its place key), where it was if that's still free. */
  function putBack(key) {
    const p = homeScreen.places[key];
    if (p?.hidden) { p.hidden = false; if (p.col != null) settleOne(key, p.w || 1, p.h || 1, p); save(); return true; }
    const t = homeScreen.trash.find((x) => x.id === key);
    if (!t) return false;
    const { trashed, ...n } = t;
    homeScreen.trash = homeScreen.trash.filter((x) => x !== t);
    homeScreen.notes = [...homeScreen.notes.filter((x) => x.id !== n.id), n]; // the family's own choice: back on the home screen
    const { w, h } = G.dims(n.size);
    const spot = n.col != null ? { page: n.page | 0, col: n.col, row: n.row, w, h } : null;
    if (spot && G.fits(items(n.id), spot)) apply([{ key: n.id, ...spot }]);
    else settleOne(n.id, w, h, spot ? G.nearest(items(n.id), w, h, spot) : null); // where it was is taken now: the nearest free spot
    save();
    return true;
  }
  /** Replace the notes the assistant keeps current (curation) with these, each in the first free spot. */
  function replaceCurated(cards) {
    homeScreen.notes = homeScreen.notes.filter((n) => n.by !== 'assistant');
    for (const c of cards) {
      const n = { id: 'n-' + crypto.randomUUID().slice(0, 6), title: c.title, content: c.content, size: G.shapeOf(c.size) || '2x1', paper: c.paper || null, color: null, for: null, keep: false, until: null, by: 'assistant', at: Date.now(), touched: null };
      homeScreen.notes.push(n); const { w, h } = G.dims(n.size); settleOne(n.id, w, h, null);
    }
    save();
  }

  // ---- MCP ----
  const SPOT = {
    page: { type: 'number', description: 'Which page, from 1 (the one the kitchen sees). Leave out page, col and row for the first free spot.' },
    col: { type: 'number', description: `Its left column, 1-${G.COLS}.` }, row: { type: 'number', description: `Its top row, 1-${G.ROWS}.` },
  };
  const SHAPE = { type: 'string', enum: G.SHAPES, description: `Cells across x down: ${SIZE_HELP}.` };
  const TOOLS = [
    { name: 'look_at_notes', description: 'See the notes on the Home tab: id, title, who it is for, how long it has been up, whether it comes down by itself, and any the family took down. Look before putting up or changing notes.', inputSchema: { type: 'object', properties: {} } },
    { name: 'put_note', description: 'Put a note on the Home tab, where the family sees it under the day: its title and a line of it there, and all of it when someone taps it. Only for something they asked to keep or will come back to (a plan for the day, a list for an outing). Never a recipe: that goes in the recipe box (save_recipe). Keep it short.',
      inputSchema: { type: 'object', required: ['title', 'content'], properties: {
        title: { type: 'string', description: 'Two to four plain words, shown on Home.' },
        content: { type: 'string', description: 'What it holds when opened: a sentence or two of markdown prose, and/or one ```spec block of JSONL patches (the UI format in your instructions). Start with a plain sentence: its first words show under the title on Home.' },
        for: { type: 'string', description: "A family member's name, if it's for them." },
        minutes: { type: 'number', description: 'Take it down by itself after this many minutes (quick things: 10-30). Leave out to keep it until it is taken down.' },
        keep: { type: 'boolean', description: 'Only if someone asked to keep it.' },
      } } },
    { name: 'update_note', description: 'Change a note in place: its title or content as things move on (a follow-up, the next part of a plan), or when it comes down. Prefer this to putting up a second note about the same thing.',
      inputSchema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' }, for: { type: 'string' },
        minutes: { type: 'number', description: 'Comes down by itself after this many minutes from now; 0 to stay up.' }, keep: { type: 'boolean' },
      } } },
    { name: 'set_home', description: 'Change the home screen itself in one step: which tabs there are and their order, and its look. This is the only way to change them: don\'t read or edit apps/home/style.json, and there is nothing to check afterwards. Give only what changes (call it with nothing to hear how it is now); today orders the cards on the Home tab. tabs is the whole list in order: "today", "apps", or app ids (from the home screen line you were given); {"id", "name"} names a tab differently. Today is the day at a glance with your notes; Apps holds every app that isn\'t a tab (and the Android apps added), so an app taken out of the tabs is still in Apps.',
      inputSchema: { type: 'object', properties: {
        tabs: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } }] } },
        palette: { type: 'string', enum: ['paper', 'linen', 'sage', 'mist', 'dusk'], description: 'paper is the usual; linen warmer; sage and mist cooler; dusk dark' },
        colors: { type: 'object', description: 'The family\'s own colors over the palette: bg, sheet, ink, accent as #rrggbb. {} goes back to the palette\'s.', properties: { bg: { type: 'string' }, sheet: { type: 'string' }, ink: { type: 'string' }, accent: { type: 'string' } } },
        type: { type: 'string', enum: ['clean', 'serif', 'round', 'hand'] },
        density: { type: 'string', enum: ['calm', 'snug'], description: 'snug: smaller, more fits' },
        backdrop: { type: 'string', enum: ['none', 'photos'] },
        today: { type: 'array', items: { type: 'string' }, description: 'The cards on the Home tab, in order, as Tabs and look arranges them: the whole list of those to show, from ' + TODAY_CARDS.join(', ') + ', and "app:<id>" for an app\'s own card that is on (today_card turns one on). Leave one out to take it off Home; [] for the usual order.' } } } },
    { name: 'today_card', description: 'Turn a card on Home on or off: one of Home\'s own (' + TODAY_CARDS.join(', ') + '; whiteboard is the drawing, recipes a recipe to try, meals tonight\'s dinner, lists the groceries), or an app\'s own card (a remote for the speakers, a score): only apps that offer one, listed here when you call it with no app. A new one shows only once someone turns it on. on: true to show it, false to take it off. position: where among the cards, from 1 (leave out for the end; give it alone to move one that is on).',
      inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'The app\'s id, or one of Home\'s own cards' }, on: { type: 'boolean' }, position: { type: 'number' } } } },
    { name: 'take_down_note', description: 'Take a note off Home. Notes the family kept: ask first.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  ];
  const extra = []; const extraCall = new Map(); // more tools on this server (the household, the assistant's name, house.js): name -> handler
  async function call(name, a, context) {
    // A background run (the heartbeat, heartbeat.js) gets only the tools its level allows, and a few notes a day.
    if (context?.allow && !context.allow.has(name)) return { content: [{ type: 'text', text: `Not in the background: ${name} isn't allowed at this level.` }], isError: true };
    if (extraCall.has(name)) return extraCall.get(name)(name, a, context === NOBODY ? null : context);
    const ok = (t) => ({ content: [{ type: 'text', text: t }] });
    const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (name === 'look_at_notes') return ok(describe());
    if (name === 'put_note' && context?.notesLeft != null && context.notesLeft <= 0) return err('No more notes today from the background.');
    if (name === 'put_note') { const r = put(a, {}, context); if (!r.error && context?.notesLeft != null) context.notesLeft--; return r.error ? err(r.error) : ok(`Put up ${r.note.id} "${r.note.title}" on Home.`); }
    if (name === 'update_note') { const r = update(a, context); return r.error ? err(r.error) : ok(`Updated ${r.note.id}.`); }
    if (name === 'set_widget') { const r = setWidget(a); return r.error ? err(r.error) : ok(String(a.content || '').trim() ? `Set ${String(a.app).replace(/^app:/, '')}'s widget.` : 'Took the widget away.'); }
    if (name === 'move_on_home') { const r = arrange(a); return r.error ? err(r.error) : ok(`Moved ${a.what} to ${where(r.at)} (${r.at.w}x${r.at.h}).`); }
    if (name === 'set_home') {
      if (!Object.keys(a || {}).length) { // nothing to change: how it is now, to change from
        const st = readStyle();
        return ok(`Now: tabs ${(st.tabs || []).map((x) => x.id || x).join(', ') || 'the usual set'}; Home's cards ${todayNow(st).join(', ') || 'none'} (could be added: ${TODAY_CARDS.filter((k) => !todayNow(st).includes(k)).join(', ') || 'none'})${(st.cards || []).length ? ` (app cards on: ${st.cards.map((x) => 'app:' + x).join(', ')})` : ''}; look ${st.palette || 'paper'}, ${st.type || 'clean'}, ${st.density || 'calm'}.`);
      }
      const r = setLook(Array.isArray(a.today) && !a.today.length ? { ...a, today: null } : a || {}, context?.turn || null, context?.who || null); // ([]: the usual cards again)
      if (r.error) return err(r.error);
      const st = r.style, tabs = (st.tabs || []).map((t) => t.name ? `${t.id} ("${t.name}")` : t.id);
      return ok(`Done. Tabs: ${tabs.length ? tabs.join(', ') : 'the usual set'}; look: ${st.palette}, ${st.type}, ${st.density}${st.backdrop === 'photos' ? ', photos behind' : ''}${Array.isArray(st.today) ? `; Home's cards: ${st.today.join(', ')}` : ''}. It's on the screen now.`);
    }
    if (name === 'today_card') {
      const offer = cardApps(), cur = readStyle().cards || [], nameOf = (id) => offer.find((x) => x.id === id)?.name || id;
      const line = (cards) => { const on = cards.filter((id) => offer.some((x) => x.id === id)), off = offer.filter((x) => !on.includes(x.id));
        return `On Home: ${on.length ? on.map((id) => `${nameOf(id)} (${id})`).join(', ') : 'no app cards'}. ${off.length ? `Off, and could be on: ${off.map((x) => `${x.name} (${x.id})`).join(', ')}.` : 'No other app offers one.'}`; };
      const id = String(a.app || '');
      // Home's own cards (the whiteboard, a recipe to try, dinner, the list…): on, off or moved in the household's list.
      const own = () => { const l = todayNow(readStyle()); return `Home's own cards on: ${l.filter((k) => TODAY_CARDS.includes(k)).join(', ') || 'none'}; off: ${TODAY_CARDS.filter((k) => !l.includes(k)).join(', ') || 'none'}.`; };
      if (!id) return ok(`${line(cur)} ${own()}`);
      if (TODAY_CARDS.includes(id)) {
        const l = todayNow(readStyle()), on = a.on === true || (a.on == null && l.includes(id)), rest = l.filter((x) => x !== id);
        if (on) rest.splice(a.position != null && Number.isFinite(+a.position) ? Math.max(0, Math.min(rest.length, Math.round(+a.position) - 1)) : l.includes(id) ? l.indexOf(id) : rest.length, 0, id);
        const r = setLook({ today: rest }, context?.turn || null, context?.who || null);
        return r.error ? err(r.error) : ok(`Done, it's on the screen now (a card shows while its tab is there). ${own()}`);
      }
      const on = a.on === true || (a.on == null && cur.includes(id)); // position alone: move one that's on
      if (on && !offer.some((x) => x.id === id)) return err(`${id} has no card for Home (an app offers one with a widget.html and "today" in its app.json; a plugin's app also needs "today-card" in its uses). ${line(cur)}`);
      const l = cur.filter((x) => x !== id);
      if (on) l.splice(a.position != null && Number.isFinite(+a.position) ? Math.max(0, Math.min(l.length, Math.round(+a.position) - 1)) : cur.includes(id) ? cur.indexOf(id) : l.length, 0, id);
      const r = setLook({ cards: l }, context?.turn || null, context?.who || null);
      return r.error ? err(r.error) : ok(`Done, it's on the screen now. ${line(r.style.cards)}`);
    }
    if (name === 'take_down_note') {
      const n = homeScreen.notes.find((x) => x.id === a.id);
      if (n && (n.by === 'family' || n.keep) && context.by === 'assistant') return err('The family kept that one. Leave it.');
      if (n && context.quiet && n.by !== 'assistant') return err('Only your own notes, in the background.');
      const r = remove(a.id); return r.error ? err(r.error) : ok(`Took down ${a.id}.`);
    }
    return err(`unknown tool ${name}`);
  }
  async function mcp(req, res) {
    const context = contextOf(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!context) return json(res, 401, { error: 'unauthorized' });
    const msg = await body(req);
    if (msg.id == null) { res.writeHead(202); return res.end(); } // notifications
    const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'home', version: '0.1' } });
    if (msg.method === 'tools/list') return reply({ tools: [...TOOLS, ...extra] });
    if (msg.method === 'tools/call') { try { return reply(await call(msg.params?.name, msg.params?.arguments || {}, context)); } catch (e) { return reply({ content: [{ type: 'text', text: e.message }], isError: true }); } }
    if (msg.method === 'ping') return reply({});
    json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }

  async function handle(req, res, url) {
    try { return await handleNow(req, res, url); }
    catch (e) { if (!e?.unsaved || res.headersSent) throw e; const u = unsaved(e); json(res, u.status, { error: u.error }); return true; }
  }
  async function handleNow(req, res, url) {
    const p = url.pathname;
    if (p === '/home/mcp' && req.method === 'POST') { await mcp(req, res); return true; }
    if (req.method === 'GET' && p === '/home') { expire(); json(res, 200, view()); return true; }
    if (req.method === 'GET' && p === '/home/timer') { expire(); json(res, 200, { timers: homeScreen.timers.map(({ label, total, endAt }) => ({ label, total, endAt })) }); return true; }
    if (req.method === 'GET' && p === '/home/whiteboard') { json(res, 200, whiteboard()); return true; }
    if (req.method === 'GET' && p === '/home/sketch') { json(res, 200, { v: homeScreen.sketch.v, strokes: homeScreen.sketch.strokes }); return true; }
    if (req.method === 'GET' && p === '/home/wait') {
      expire();
      if (Number(url.searchParams.get('v')) !== version) { json(res, 200, view()); return true; }
      const t = setTimeout(() => { waiters.delete(done); json(res, 200, view()); }, 25e3);
      const done = (v) => { clearTimeout(t); json(res, 200, v); };
      waiters.add(done);
      req.on('close', () => { clearTimeout(t); waiters.delete(done); });
      return true;
    }
    if (req.method !== 'POST' || !p.startsWith('/home/')) return false;
    const b = await body(req);
    const n = homeScreen.notes.find((x) => x.id === String(b.id || ''));
    if (p === '/home/arrange') { // the display moved or resized things, or placed something new
      const list = Array.isArray(b.items) ? b.items : [];
      const ok = (v, max) => Number.isInteger(v) && v >= 0 && v < max;
      const good = list.filter((m) => m && typeof m.key === 'string' && ok(m.col, G.COLS) && ok(m.row, G.ROWS) && Number.isInteger(m.page) && m.page >= 0 && m.page < 50 && G.SHAPES.includes(`${m.w}x${m.h}`));
      for (const m of good) {
        const n = homeScreen.notes.find((x) => x.id === m.key);
        if (n && `${m.w}x${m.h}` !== n.size) { const from = n.size; n.size = `${m.w}x${m.h}`; homeScreen.notes = [...homeScreen.notes.filter((x) => x !== n), n]; setTimeout(() => handle.onResize?.(n, from), 0); }
      }
      apply(good.map(({ key, page, col, row, w, h }) => ({ key, page, col, row, w, h })));
      if (Array.isArray(b.present)) homeScreen.present = b.present.filter((k) => typeof k === 'string').slice(0, 500);
      if (homeScreen.present) for (const k of Object.keys(homeScreen.places)) if (k.startsWith('timer:') && !homeScreen.present.includes(k)) delete homeScreen.places[k]; // rung or stopped
      save(); json(res, 200, { ok: true, v: version }); return true; // v: the home screen's version with this in it (a screen holds its move until it sees it)
    }
    if (p === '/home/showing') { // the display's tab changed (only the display reports it)
      const t = String(b.tab || '');
      showing = TAB_ID.test(t) ? { tab: t, at: Date.now() } : null;
      json(res, 200, { ok: true }); return true;
    }
    if (p === '/home/look') { // the display's "Tabs and look" sheet: a change like any other, so "undo" takes it back
      const r = setLook(b, null, b.who ? String(b.who).slice(0, 40) : null);
      if (r.busy) { json(res, 409, { error: 'busy', text: r.error }); return true; }
      if (r.error) { json(res, 500, { error: r.error }); return true; }
      json(res, 200, { ok: true, style: r.style }); return true;
    }
    if (p === '/home/place' && /^[\w:.-]{1,80}$/.test(String(b.key || ''))) { // put in the trash (hidden), or from before the grid: x, y in u
      const was = homeScreen.places[b.key] || {};
      if (b.hidden != null) homeScreen.places[b.key] = { ...was, hidden: !!b.hidden };
      if (b.x != null || b.y != null) { const d = G.dims(DEFAULT_SHAPE(b.key, homeScreen.widgets) || `${was.w || 1}x${was.h || 1}`); settleOne(b.key, d.w, d.h, G.cellFromU(b.x, b.y, d.w, d.h)); }
      save(); json(res, 200, { ok: true }); return true;
    }
    if (p === '/home/sketch') { // {add: stroke} | {undo: true} | {clear: true}
      const k = homeScreen.sketch, a = b.add;
      if (a) {
        const pts = Array.isArray(a.p) ? a.p.slice(0, 800).map((n) => Math.max(0, Math.min(1000, Math.round(Number(n) || 0)))) : [];
        if (pts.length < 2 || pts.length % 2) { json(res, 400, { error: 'a stroke needs points' }); return true; }
        k.strokes.push({ c: /^#[0-9a-f]{6}$/i.test(a.c) ? a.c : '#24282a', w: Math.max(2, Math.min(60, Number(a.w) || 8)), p: pts });
        if (k.strokes.length > 400) k.strokes.splice(0, k.strokes.length - 400);
        k.was = null;
      } else if (b.clear) { if (k.strokes.length) k.was = k.strokes; k.strokes = []; }
      else if (b.undo) { if (!k.strokes.length && k.was) { k.strokes = k.was; k.was = null; } else k.strokes.pop(); }
      k.v++; save(); json(res, 200, { ok: true, v: k.v }); return true;
    }
    if (p === '/home/timer') { // {start: {label, seconds} or {label, total, endAt}} or {cancel: endAt}
      if (b.start && typeof b.start === 'object') { const endAt = startTimer(b.start); json(res, endAt ? 200 : 400, endAt ? { ok: true, endAt } : { error: 'bad timer' }); return true; }
      json(res, 200, { ok: cancelTimer(b.cancel) }); return true;
    }
    if (p === '/home/handsfree') { // {note, listen (s), minutes} from an app in use hands-free, or {off: true}
      const app = String(req.headers['x-openhouse-app'] || 'home').slice(0, 60);
      if (b.off) { if (live.handsFree?.app === app) { live.handsFree = null; tell(); } json(res, 200, { ok: true }); return true; }
      const minutes = Math.max(1, Math.min(90, Number(b.minutes) || 20));
      const was = handsFree();
      live.handsFree = { app, note: String(b.note || '').replace(/[\u0000-\u0008]/g, '').slice(0, 1500), listen: Math.max(8, Math.min(30, Math.round(Number(b.listen) || 20))), until: Date.now() + minutes * 60e3 };
      // the screens hear of it when it starts or stops (a new step's note needs no redraw anywhere)
      if (!was || was.app !== app) tell(); json(res, 200, { ok: true }); return true;
    }
    if (p === '/home/remove') { trash(String(b.id || '')); json(res, 200, { ok: true }); return true; }
    if (p === '/home/putback') { json(res, 200, { ok: putBack(String(b.key || '')) }); return true; }
    if (p === '/home/keep' && n) { n.keep = b.keep !== false; if (n.keep) n.until = null; else if (n.by === 'family') n.by = 'chat'; save(); json(res, 200, n); return true; }
    if (p === '/home/move' && n) { // from before the grid: x, y in u, to the nearest cell
      const { w, h } = G.dims(n.size); settleOne(n.id, w, h, G.cellFromU(b.x, b.y, w, h)); save(); json(res, 200, { ok: true }); return true;
    }
    if (p === '/home/touch' && n) { n.touched = Date.now(); write(); json(res, 200, { ok: true }); return true; }
    json(res, 404, { error: 'not found' });
    return true;
  }

  /** Set a flag on a note (e.g. refitting) and tell the screens. */
  handle.mark = (id, flags) => { const x = homeScreen.notes.find((m) => m.id === id); if (x) { Object.assign(x, flags); save(); } };
  /** Put something the family trashed (a note, the clock, the weather, an app, a home-app thing) back on the home screen. */
  handle.putBack = putBack;
  // The same tools for someone's own AI app on a computer (workshop.js): the list, and a call as that computer.
  /** Kitchen timers for the workshop's timer tool (a paired agent's "set a pasta timer"): the shell rings them. */
  handle.timers = { start: startTimer, cancel: cancelTimer, list: () => homeScreen.timers.slice() }; // (finished ones too: still on the screen, ringing, until cleared)
  // apps: the apps the change has touched so far: the home screen pulses their tabs (or Apps, for one that isn't a tab).
  handle.computerNote = (text, apps = []) => { live.computer = text ? { text: String(text).slice(0, 160), apps: apps.slice(0, 20), at: live.computer?.at || Date.now() } : null; tell(); };
  /** The app in use hands-free right now: {app, note, listen, until}, or null. */
  handle.handsFree = handsFree;
  handle.showTab = (tab) => { if (TAB_ID.test(String(tab || ''))) { live.show = { tab: String(tab), at: Date.now() }; tell(); } };
  /** Open an app: its tab if it is one, else full screen over the home screen (the Map, when Opie shows a place). */
  handle.showApp = (app) => { if (TAB_ID.test(String(app || ''))) { live.show = { tab: String(app), at: Date.now(), ...(isTab(app) ? {} : { open: true }) }; tell(); } };
  handle.setAlarms = (f) => { alarmsOf = () => { try { return f(); } catch { return null; } }; };
  handle.changed = tell;
  handle.tools = () => [...TOOLS, ...extra];
  handle.call = (name, a, ctx) => call(name, a || {}, ctx || NOBODY);
  handle.addTools = (tools, fn) => { extra.push(...tools); for (const t of tools) extraCall.set(t.name, fn); };
  handle.url = `/home/mcp`;
  handle.token = TOKEN;
  handle.describe = describe;
  handle.style = homeStyle;
  /** Home's Whiteboard card: the drawing as the Whiteboard app last saved it for Home (its own data, "home": {img, at,
   *  empty}; server.js from apps.js readData), and when, so every screen's card draws it again as it changes. */
  handle.setWhiteboard = (read) => { boardOf = read; try { boardAt = Number(read()?.at) || 0; } catch {} };
  handle.appData = (app, name) => { if (app === 'whiteboard' && name === 'home') { boardAt = Date.now(); tell(); } };
  /** The apps that offer a card on Home ([{id, name}]: server.js, from apps.js list), for today_card. */
  let cardApps = () => [];
  handle.setCardApps = (fn) => { cardApps = fn; };
  handle.setLook = setLook; // plugins.js: a plugin's look and tabs, inside its own change
  handle.arrange = arrange;
  handle.setWidget = setWidget;
  handle.put = (a, opts, ctx) => put(a, opts, ctx || NOBODY);
  /** A token for an agent started ahead of its run (a warm one); the run attaches it. */
  handle.mint = mint;
  /** The run this token belongs to while it is running (its context), else null. Never the shared token. (chat.js callText) */
  handle.runOf = (token) => runs.get(token) || null;
  handle.replaceCurated = replaceCurated;
  /**
   * Run fn as one run with this context: fn({ token, attach, put }) gets the run's own token (for its agent's
   * home-screen connection), attach(token) for a token minted ahead, and put() as this run. Returns the notes it put
   * up or changed. exclusive: the agent shares one connection (the shared token), so wait for the others.
   */
  handle.during = async (ctx, fn, { exclusive = false } = {}) => {
    const mine = { ...ctx, touched: [] }, tokens = [];
    const attach = (t) => { if (t && t !== TOKEN) { runs.set(t, mine); minted.delete(t); tokens.push(t); } };
    let done = () => {};
    if (exclusive) {
      const before = turn; turn = new Promise((r) => (done = r));
      if (shared) ctx.send?.({ type: 'status', text: 'One moment' });
      await before;
      shared = mine;
    }
    const token = mint(); attach(token);
    mine.token = token; // the run's own key: the agent in its own app saves with it (box.js)
    try {
      const r = await fn({ token: exclusive ? TOKEN : token, own: token, attach, put: (a, opts) => put(a, opts, mine) });
      return { result: r, notes: mine.touched, ctx: mine };
    } finally {
      for (const t of tokens) runs.delete(t);
      if (exclusive) { if (shared === mine) shared = null; done(); }
    }
  };
  /** Pins from the old board, once. */
  handle.migrate = (pins) => {
    if (homeScreen.migrated) return;
    homeScreen.migrated = true;
    for (const p of pins || []) {
      const n = { id: 'n-' + crypto.randomUUID().slice(0, 6), title: p.title, content: p.text, size: '2x2', paper: 'card', color: null, for: p.who, keep: true, until: null, by: 'family', at: p.at || Date.now(), touched: null, conversation: p.conversation || null };
      homeScreen.notes.push(n); settleOne(n.id, 2, 2, null);
    }
    save();
  };
  return handle;
}

/**
 * A board from before the grid (free x, y in u, scale and turn) onto the grid: everything to the free cell nearest
 * where it was, on the first page (the clock, the weather, apps and the home app's things first, then notes, oldest
 * first), or the next page with room. Returns whether anything changed.
 */
export function toGrid(homeScreen) {
  let changed = false;
  const placed = [];
  const old = (p) => p && p.col == null && (p.x != null || p.y != null);
  for (const [key, p] of Object.entries(homeScreen.places)) {
    if (key === 'gear') { delete homeScreen.places[key]; changed = true; continue; } // the gear sits by the page dots now, off the grid
    if (!old(p)) { if (p.col != null && !p.hidden) placed.push({ key, page: p.page | 0, col: p.col, row: p.row, w: p.w || 1, h: p.h || 1 }); continue; }
    const shape = DEFAULT_SHAPE(key, homeScreen.widgets || {});
    const { w, h } = shape ? G.dims(shape) : { w: 1, h: 1 }; // the home app's own things: the display measures them and picks
    const at = G.nearest(p.hidden ? [] : placed, w, h, G.cellFromU(p.x, p.y, w, h));
    const { x, y, scale, rot, ...rest } = p;
    homeScreen.places[key] = { ...rest, page: at.page, col: at.col, row: at.row, ...(shape ? { w, h } : {}) };
    if (!p.hidden) placed.push({ key, ...at });
    changed = true;
  }
  const fix = (n, live) => {
    const size = G.shapeOf(n.size) || '2x1';
    if (size !== n.size) { n.size = size; changed = true; }
    if (n.col == null || n.x !== undefined) {
      const { w, h } = G.dims(size);
      const at = n.col != null ? { page: n.page | 0, col: n.col, row: n.row, w, h } : n.x != null ? G.cellFromU(n.x, n.y, w, h) : null;
      const spot = live ? (at && G.fits(placed, at) ? at : at ? G.nearest(placed, w, h, at) : G.firstFree(placed, w, h)) : at || { page: 0, col: 0, row: 0 };
      n.page = spot.page; n.col = spot.col; n.row = spot.row;
      if (live) placed.push({ key: n.id, ...spot, w, h });
      delete n.x; delete n.y; delete n.w; delete n.rot;
      changed = true;
    } else if (live) placed.push({ key: n.id, page: n.page | 0, col: n.col, row: n.row, ...G.dims(size) });
  };
  [...homeScreen.notes].sort((a, b) => (a.x == null) - (b.x == null) || (a.at || 0) - (b.at || 0)).forEach((n) => fix(n, true));
  for (const n of homeScreen.trash || []) fix(n, false);
  return changed;
}
