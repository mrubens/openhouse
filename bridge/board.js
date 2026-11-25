// The family and the assistant's hourly look at the day ("curation"): it reads the household, the
// calendar and the home screen, and keeps its notes on the home screen current (home-screen.js), plus a one-line headline.
//
// GET  /board                 { assistant: {at, headline, weather}, curating, error, family, events, chores }
// POST /board/pin {title, text, conversation?, who?}   keep an answer: it goes on the home screen as a kept note
// POST /board/refresh         re-curate now
// GET  /household             the family, where they live, whose calendars are read, chores (setup)
// POST /household {family?, location?, chores?, routines?}   save what changed
// POST /calendar/feeds {feeds: [{id, who, ics?, error?}]}   the shell: what the family's calendars say now
// POST /calendar/claim         the shell: calendar links saved here before they moved to it (then gone from here)
// Two-way calendars (calendar-sync.js; the shell's Settings, never apps or screens):
//   GET  /calendar/sync          { calendars, targets, status }
//   POST /calendar/sync/discover {account}   that account's calendars, found again (after it's signed in)
//   POST /calendar/sync/set      {key, mode?: 'off'|'read'|'two-way', who?, default?: true}
//   POST /calendar/sync/forget   {account}   it was signed out: its calendars go
//   POST /calendar/sync/now      read and send now
//
// files: board.json (the last curation) and household.json (family, calendar, chores, location), next to the chats.
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import path from 'node:path';
import { calendars } from './calendar.js';
import { calendarSync } from './calendar-sync.js';
import { shellCall } from './calendar-links.js';

// How much the household holds. Past one, a save is refused with the reason (a 400 for a tap, an error a tool says),
// never cut short: nobody's chore or person is dropped to make room.
export const ROOM = { family: 20, chores: 100, places: 40, routines: 20 };
const full = (text) => Object.assign(new Error(text), { code: 'full', status: 400 });

export function boardRoutes({ HERE, DIR, WORK, currentAgent, agentName, json, body, homeScreen }) {
  const BOARD = path.join(DIR, 'board.json');
  const HOUSE = path.join(DIR, '../household.json');
  const read = (f, d) => readJson(f, d); // an unreadable file reads as its .bak, never as empty (store.js)
  const load = () => ({ assistant: null, ...read(BOARD, {}) });
  const save = (b) => writeJson(BOARD, b);
  let curating = false, lastError = null;
  // The family's calendars, read by the shell, which keeps their links (calendar.js).
  const cal = calendars({ DIR });
  // Two-way calendars (Google, iCloud): the shell holds the sign-ins and makes the requests (calendar-sync.js).
  const sync = calendarSync({ FILE: path.join(DIR, '../calendar-sync.json'), shell: (p, b) => shellCall(p, b, { timeoutMs: 60e3 }),
    family: () => (read(HOUSE, {}).family || []).map((f) => f.name).filter(Boolean) });
  const withoutLinks = ({ calendars: _, ...h }) => h; // links saved here before they moved to the shell

  // Until someone sets it up, the household is empty: nothing made up is ever said about a real family.
  function household() {
    const h = read(HOUSE, { family: [], location: null, routines: [], events: [], chores: [] });
    return { ...withoutLinks(h), events: [...(h.events || []), ...cal.events(), ...sync.events(), ...(handle.localEvents?.() || [])] };
  }

  /** Save what changed about the household (the setup sheet, or the assistant's tools). */
  function saveHousehold(b, { quiet = false } = {}) {
    const h = read(HOUSE, { family: [], location: null, routines: [], events: [], chores: [] });
    const str = (v, n = 80) => String(v ?? '').trim().slice(0, n);
    if (Array.isArray(b.family)) {
      // A person's color stays theirs when the list is saved again without it (the family sheet, the assistant).
      const had = new Map((h.family || []).map((f) => [String(f.name).toLowerCase(), f.color]));
      const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : null);
      h.family = b.family.map((f) => { const name = str(f.name, 40), color = f.color === null ? null : hex(f.color) || had.get(name.toLowerCase()) || null;
        return { name, ...(str(f.note) ? { note: str(f.note) } : {}), ...(color ? { color } : {}) }; }).filter((f) => f.name);
      if (h.family.length > ROOM.family) throw full(`The family has room for ${ROOM.family} people. Take someone off first.`);
    }
    if (b.location != null) h.location = str(b.location, 100) || null;
    if (b.address != null) h.address = str(b.address, 160) || null; // the home's street address (the first setup): directions, deliveries
    if (Array.isArray(b.chores)) {
      // A chore's stars stay when the list is saved again without them (the family sheet).
      // (and its picture, and whether it waits until done)
      const had = new Map((h.chores || []).map((c) => [`${String(c.who || '').toLowerCase()}|${String(c.task).toLowerCase()}`, c]));
      h.chores = b.chores.map((c) => { const who = str(c.who, 40), task = str(c.task, 100), was = had.get(`${who.toLowerCase()}|${task.toLowerCase()}`) || {};
        const n = Math.round(Number('stars' in c ? c.stars : was.stars)), pic = 'pic' in c ? c.pic : was.pic, keep = 'keep' in c ? c.keep : was.keep;
        const every = Math.round(Number('every' in c ? c.every : was.every)), since = 'since' in c ? c.since : was.since, after = 'after' in c ? c.after : was.after;
        return { who, task, ...(Array.isArray(c.days) && c.days.length ? { days: c.days.map((d) => str(d, 3).toLowerCase()) } : {}), ...(n >= 2 && n <= 10 ? { stars: n } : {}),
          ...(typeof pic === 'string' && /^[a-z]{2,12}$/.test(pic) ? { pic } : {}), ...(keep ? { keep: true } : {}),
          ...(every >= 2 && every <= 90 ? { every, ...(after ? { after: true } : /^\d{4}-\d{2}-\d{2}$/.test(since || '') ? { since } : {}) } : {}) }; }).filter((c) => c.task);
      if (h.chores.length > ROOM.chores) throw full(`There's room for ${ROOM.chores} chores. Take one off first.`);
    }
    // The Map's saved places (maps.js): found once, kept with their name; home: Home's own street address.
    if (Array.isArray(b.places)) {
      const num = (v, lim) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= lim ? n : null; };
      h.places = b.places.map((p) => ({ name: str(p.name, 40), address: str(p.address, 160), lat: num(p.lat, 90), lon: num(p.lon, 180), ...(p.home ? { home: true } : {}) }))
        .filter((p) => p.name && p.lat != null && p.lon != null);
      if (h.places.length > ROOM.places) throw full(`The Map has room for ${ROOM.places} places. Take one off first.`);
    }
    if (b.maps != null) { if (b.maps === true) h.maps = true; else delete h.maps; } // the Map turned on (its services: docs/maps.md)
    delete h.assistant; // (it was once renamable; it's always Opie now)
    if (Array.isArray(b.routines)) {
      h.routines = b.routines.map((r) => str(r, 160)).filter(Boolean);
      if (h.routines.length > ROOM.routines) throw full(`There's room for ${ROOM.routines} routines. Take one off first.`);
    }
    writeJson(HOUSE, h, { space: 2 });
    if (!quiet) curate('household'); // a chore ticked on or off isn't worth a curation
    return h;
  }
  const viewOf = (h) => ({ setup: !!h, family: h?.family || [], location: h?.location || '', address: h?.address || '', calendars: cal.labels(), chores: h?.chores || [], routines: h?.routines || [], calendar: cal.status() });
  const householdView = () => viewOf(read(HOUSE, null));

  function context() {
    const h = household(), now = new Date();
    const soon = (h.events || []).filter((e) => new Date(e.start) > new Date(now - 3600e3) && new Date(e.start) - now < 3 * 86400e3)
      .sort((a, c) => new Date(a.start) - new Date(c.start))
      .map((e) => `- ${new Date(e.start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${e.who} — ${e.title}${e.bring ? ` (bring: ${e.bring})` : ''}`);
    return [
      `Now: ${now.toString()}`,
      h.family?.length ? `Family: ${h.family.map((f) => f.name + (f.note ? ` (${f.note})` : '')).join(', ')}` : 'Family: not set up yet (ask who lives here, or someone can fill it in under Settings)',
      h.location ? `Location: ${h.location}` : 'Location: unknown (no weather)',
      h.routines?.length ? `Routines:\n${h.routines.map((r) => '- ' + r).join('\n')}` : '',
      `Calendar, next 3 days:\n${soon.join('\n') || '- nothing'}`,
      h.chores?.length ? `Chores:\n${h.chores.map((c) => `- ${c.who}: ${c.task}${c.days ? ` (${c.days.join(', ')})` : ''}`).join('\n')}` : '',
      handle.houseContext?.() || '', // lists, meals, chores done today (house.js)
    ].filter(Boolean).join('\n\n');
  }

  const parse = (text) => ({ headline: text.match(/^HEADLINE:\s*(.+)$/m)?.[1]?.trim() || '', weather: text.match(/^WEATHER:\s*(.+)$/m)?.[1]?.trim() || '' });

  async function curate(why) {
    if (curating) return;
    curating = true; lastError = null;
    const t0 = Date.now();
    try {
      const agent = await currentAgent();
      if (!agent.chat) throw new Error(`${agentName()} can't curate`);
      const sys = fs.readFileSync(path.join(HERE, 'CURATE.md'), 'utf8') + '\n\n---\n\n' + fs.readFileSync(path.join(HERE, 'NOTES.md'), 'utf8') + (handle.prefs?.() || '') + '\n\n---\n\n' + fs.readFileSync(path.join(HERE, 'chat-prompt.md'), 'utf8');
      const prompt = context() + `\n\nThe home screen right now:\n${homeScreen.describe()}`;
      const { result: r, notes } = await homeScreen.during({ by: 'assistant' }, (run) => agent.chat({ prompt, cwd: WORK, systemPrompt: sys, onEvent: () => {}, resume: null, homeToken: run.token, route: false }));
      if (!r.ok) throw new Error(r.text);
      const a = parse(r.text);
      save({ ...load(), assistant: { at: Date.now(), headline: a.headline, weather: a.weather } });
      console.log(`[board] curated (${why}) in ${Date.now() - t0} ms: ${notes.map((c) => c.title).join(' · ')}`);
    } catch (e) { lastError = e.message; console.log('[board] curation failed:', e.message); }
    finally { curating = false; }
  }

  // (No longer on a schedule: those notes were for the board, and Today now shows the day itself. /board/refresh still curates.)

  handle.household = () => context(); // what conversations know about the family
  handle.saveHousehold = saveHousehold;
  handle.householdView = householdView;
  /** Synced calendars plus events in household.json (house.js adds the display's own). */
  handle.calendarEvents = () => [...(read(HOUSE, {}).events || []), ...cal.events(), ...sync.events()];
  /** Both from one read of household.json (house.js: once for a whole /house view). */
  handle.snapshot = () => { const h = read(HOUSE, null); return { view: viewOf(h), events: [...(h?.events || []), ...cal.events(), ...sync.events()] }; };
  handle.sync = sync;
  sync.start(() => handle.onCalendar?.()); // house.js redraws every screen
  homeScreen.migrate(load().pins); // pins from before the home screen had notes
  return handle;
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/household' && req.method === 'GET') {
      json(res, 200, householdView());
      return true;
    }
    // Only the place (a ZIP code or town), from the Weather tab when none is set yet.
    if (p === '/household/location' && req.method === 'POST') {
      const loc = String((await body(req)).location || '').trim().slice(0, 100);
      if (!loc) { json(res, 400, { error: 'location' }); return true; }
      saveHousehold({ location: loc }); json(res, 200, { ok: true, location: loc }); return true;
    }
    if (p === '/household' && req.method === 'POST') {
      try { saveHousehold(await body(req)); } catch (e) { if (e.code !== 'full') throw e; json(res, 400, { error: e.message }); return true; }
      json(res, 200, { ok: true }); return true;
    }
    if (p === '/calendar/feeds' && req.method === 'POST') {
      const st = cal.setFeeds((await body(req)).feeds);
      json(res, 200, st);
      return true;
    }
    if (p === '/calendar/sync' && req.method === 'GET') { await sync.loadAccounts().catch(() => {}); json(res, 200, { calendars: sync.calendars(), targets: sync.targets(), status: sync.status() }); return true; }
    if (p.startsWith('/calendar/sync/') && req.method === 'POST') {
      const b = await body(req);
      const r = p === '/calendar/sync/discover' ? await sync.discover(String(b.account || ''))
        : p === '/calendar/sync/set' ? sync.setCalendar(String(b.key || ''), b)
        : p === '/calendar/sync/forget' ? sync.forget(String(b.account || ''))
        : p === '/calendar/sync/now' ? (await sync.flush().catch(() => {}), await sync.pull().catch(() => {}), { ok: true, status: sync.status() })
        : null;
      if (!r) return false;
      json(res, r.error ? 400 : 200, r); return true;
    }
    if (p === '/calendar/claim' && req.method === 'POST') {
      const h = read(HOUSE, null), links = (h?.calendars || []).filter((c) => c && c.url).map((c) => ({ url: String(c.url), who: c.who || null }));
      if (h && 'calendars' in h) writeJson(HOUSE, withoutLinks(h), { space: 2 });
      json(res, 200, { calendars: links });
      return true;
    }
    if (req.method === 'GET' && p === '/board') {
      const b = load(), h = household();
      json(res, 200, {
        assistant: b.assistant && { at: b.assistant.at, headline: b.assistant.headline, weather: b.assistant.weather },
        curating, error: lastError, family: (h.family || []).map((f) => ({ name: f.name, note: f.note || '' })),
        // for the view that turns toward whoever is talking: the next two days and chores
        events: (h.events || []).filter((e) => { const t = new Date(e.start) - Date.now(); return t > -3 * 3600e3 && t < 48 * 3600e3; }),
        chores: h.chores || [],
      });
      return true;
    }
    if (req.method !== 'POST' || !p.startsWith('/board/')) return false;
    const b = await body(req);
    if (p === '/board/pin') { // "keep this": it goes on the home screen as a note the family kept
      const text = String(b.text || '');
      if (!text.trim()) { json(res, 400, { error: 'nothing to pin' }); return true; }
      const { result: r } = await homeScreen.during({ by: 'family', who: b.who || null, conversation: b.conversation || null },
        async (run) => run.put({ title: String(b.title || 'Kept').slice(0, 60), content: text, size: 'large', paper: 'card', for: b.who || null, keep: true }, { makeRoom: true }));
      json(res, r.error ? 409 : 200, r.error ? { error: r.error } : r.note);
      return true;
    }
    if (p === '/board/refresh') { curate('asked'); json(res, 202, { ok: true }); return true; }
    return false;
  };
}
