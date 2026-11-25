// The Map (defaults/apps/map, docs/maps.md): home, the household's saved places, today's events that have a place
// (with a rough "leave by"), and what Opie last showed on it. Finding places is Nominatim and drives are FOSSGIS's
// OSRM, both OpenStreetMap, keyless, from here (one request a second at most, each answer kept). Nothing is sent
// anywhere until someone turns the map on in the Map (household.json "maps": true).
//
//   GET  /map               { on, home, places, shown, today: [{title, start, who, place, lat, lon, minutes, miles, leaveBy}], looking }
//   GET  /map/route?lat=&lon=   the drive from home: { minutes, miles, line: [[lon, lat]...] } or { error }
//   POST /map/on {on}       POST /map/place {name, address, home?}   POST /map/place/remove {name}   POST /map/clear
//   tools: show_on_map, save_place, forget_place (home-screen tools; the live voice and typed turns have them)
import fs from 'node:fs';
import path from 'node:path';

const UA = 'OpenHouse/1 (+https://openhouse.computer)';
const DAY = 86400e3;
const NOT_A_PLACE = /^(zoom|teams|google meet|meet|facetime|online|virtual|phone|call|tbd|tba|home)$|https?:|zoom\.us|meet\.google|teams\.microsoft/i;
const str = (v, n = 120) => String(v ?? '').trim().slice(0, n);
const key = (s) => str(s, 200).toLowerCase().replace(/\s+/g, ' ');
const round = (n, d = 5) => Math.round(n * 10 ** d) / 10 ** d;

export function mapRoutes({ DIR, json, body, board, house = null, homeScreen = null, hasApp = () => true, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), gap = 1100 }) {
  const HOUSE = path.join(DIR, '../household.json'), CACHE = path.join(DIR, 'maps.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const cache = { geo: {}, routes: {}, shown: null, ...read(CACHE, {}) };
  const keep = () => { try { fs.writeFileSync(CACHE + '.tmp', JSON.stringify(cache)); fs.renameSync(CACHE + '.tmp', CACHE); } catch {} };
  const household = () => read(HOUSE, {});
  const isOn = () => household().maps === true;
  const places = () => (Array.isArray(household().places) ? household().places : []);
  const savePlaces = (list) => board.saveHousehold({ places: list }, { quiet: true });

  // One request at a time, a second apart (Nominatim's policy), whichever service it is.
  let queue = Promise.resolve(), last = 0;
  const polite = (url) => (queue = queue.catch(() => {}).then(async () => {
    const wait = last + gap - now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = now();
    const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10e3) });
    if (!r.ok) throw new Error(`${new URL(url).host}: ${r.status}`);
    return r.json();
  }));

  /** Home: the Map's own Home (a street address someone gave it), else the weather's place (a ZIP code or town). */
  async function home({ look = true } = {}) {
    const own = places().find((p) => p.home);
    if (own) return { name: 'Home', label: own.address, lat: own.lat, lon: own.lon, own: true };
    const loc = str(household().address, 160) || str(household().location, 100); // the street address from setup, else the town
    if (!loc) return null;
    const g = await find(loc, { look, near: null });
    return g ? { name: 'Home', label: loc, lat: g.lat, lon: g.lon, own: false } : null;
  }
  /** A place by its words, from what's been found before or Nominatim (near home when there is one). null: not found. */
  async function find(q, { look = true, near } = {}) {
    const k = key(q) && 'v2:' + key(q); // (v2: picked nearest home; earlier answers took the first match, a namesake town far away)
    if (!k) return null;
    const had = cache.geo[k];
    if (had) return had;
    if (had === null && now() - (cache.geoMiss?.[k] || 0) < 7 * DAY) return null; // not found: asked again after a week
    if (!look) return undefined;
    const h = near === undefined ? await home({ look }) : near;
    const box = h ? `&viewbox=${h.lon - 0.6},${h.lat + 0.4},${h.lon + 0.6},${h.lat - 0.4}` : '';
    // As said, then without its commas ("Central Library, Portland" finds nothing; "Central Library Portland" does),
    // then the name alone close to home.
    const words = str(q, 200), first = words.split(',')[0].trim();
    const tries = [[words, ''], ...(words.includes(',') ? [[words.replace(/,/g, ' '), '']] : []), ...(h && first !== words ? [[first, '&bounded=1']] : [])];
    let g = null;
    for (const [w, bound] of tries) {
      // Several matches, and the one nearest home: the first match alone can be a namesake ("Ridge Road, Chelsea" is in
      // Alabama too, and Nominatim doesn't read a state's abbreviation), and the viewbox only leans its order.
      const r = await polite(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${h ? 8 : 1}&addressdetails=0&q=${encodeURIComponent(w)}${box}${box && bound}`);
      const far = (x) => (h ? (Number(x.lat) - h.lat) ** 2 + ((Number(x.lon) - h.lon) * Math.cos(h.lat * Math.PI / 180)) ** 2 : 0);
      const best = Array.isArray(r) && r.length ? r.reduce((a, b) => (far(b) < far(a) ? b : a)) : null;
      if (best) { g = { lat: round(Number(best.lat)), lon: round(Number(best.lon)), label: str(best.display_name, 200).replace(/(^|, )(\d+[a-z]?), /i, '$1$2 ') } /* "801, SW 10th Ave" → "801 SW 10th Ave" */; break; }
    }
    cache.geo[k] = g;
    if (!g) cache.geoMiss = { ...(cache.geoMiss || {}), [k]: now() };
    keep();
    return g;
  }
  /** The drive between two points: minutes and miles (typical, no live traffic), and its line. */
  async function drive(a, b, { look = true, line = true } = {}) {
    if (!a || !b) return null;
    const k = `${round(a.lat, 4)},${round(a.lon, 4)};${round(b.lat, 4)},${round(b.lon, 4)}`;
    const had = cache.routes[k];
    if (had && now() - had.at < DAY && (!line || had.line)) return had;
    if (!look) return had || undefined;
    const r = await polite(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`);
    const x = r?.routes?.[0];
    if (!x) return null;
    const out = { minutes: Math.max(1, Math.round(x.duration / 60)), miles: Math.round(x.distance / 160.934) / 10,
      line: (x.geometry?.coordinates || []).slice(0, 2000).map(([lo, la]) => [round(lo), round(la)]), at: now() };
    cache.routes[k] = out;
    for (const [rk, v] of Object.entries(cache.routes)) if (now() - v.at > DAY) delete cache.routes[rk];
    keep();
    return out;
  }
  const byName = (name) => places().find((p) => !p.home && key(p.name) === key(name));

  // ---- today's events with a place ----
  let looking = false;
  async function today({ look }) {
    const t0 = new Date(now()); t0.setHours(0, 0, 0, 0);
    const end = t0.getTime() + DAY;
    let evs = [];
    try { evs = house?.view?.().events || []; } catch {}
    evs = evs.filter((e) => e.place && !e.allDay && new Date(e.start).getTime() >= t0.getTime() && new Date(e.start).getTime() < end && new Date(e.end || e.start).getTime() > now() - 3600e3).slice(0, 12);
    let h = null; try { h = await home({ look }); } catch {}
    const out = [], todo = [];
    for (const e of evs) {
      const place = str(e.place, 120), saved = byName(place);
      const at = saved || (NOT_A_PLACE.test(place) ? null : await find(place, { look: false, near: h }));
      if (at === undefined) todo.push(place);
      const d = at && h ? await drive(h, at, { look: false, line: false }) : null;
      if (at && h && d === undefined) todo.push(at);
      const start = new Date(e.start).getTime();
      const leaveBy = d?.minutes ? new Date(Math.floor((start - (d.minutes + 5) * 60e3) / 300e3) * 300e3).toISOString() : null;
      out.push({ title: str(e.title, 120), start: e.start, who: e.who || null, place, ...(at ? { lat: at.lat, lon: at.lon } : {}),
        ...(d?.minutes ? { minutes: d.minutes, miles: d.miles, leaveBy } : {}) });
    }
    // Look up what isn't known yet in the background, one a second; the page asks again while "looking".
    if (look && todo.length && !looking) {
      looking = true;
      (async () => {
        for (const x of todo.slice(0, 8)) {
          try { const at = typeof x === 'string' ? await find(x, { near: h }) : x; if (at && h) await drive(h, at, { line: false }); } catch {}
        }
      })().finally(() => { looking = false; });
    }
    return out;
  }

  async function view() {
    const on = isOn();
    if (!on) return { on, home: null, places: [], shown: null, today: [], looking: false };
    let h = null; try { h = await home(); } catch {}
    const ps = places().filter((p) => !p.home).map((p) => ({ name: p.name, address: p.address, lat: p.lat, lon: p.lon }));
    for (const p of ps) { const d = h ? await drive(h, p, { look: false, line: false }) : null; if (d?.minutes) Object.assign(p, { minutes: d.minutes, miles: d.miles }); }
    const shown = cache.shown && now() - cache.shown.at < 3 * 3600e3 ? cache.shown : null;
    return { on, home: h, places: ps, shown, today: await today({ look: true }), looking };
  }

  /** Save a place (or Home's street address): found once, kept with its name. */
  async function savePlace({ name, address, home: isHome = false }) {
    name = isHome ? 'Home' : str(name, 40); address = str(address || name, 160);
    if (!name || !address) throw new Error('A place needs a name and an address.');
    if (!isOn()) throw new Error(OFF);
    const g = await find(address, isHome ? { near: null } : {});
    if (!g) throw new Error(`Couldn't find ${address} on the map. Try a street address.`);
    const rest = places().filter((p) => (isHome ? !p.home : p.home || key(p.name) !== key(name)));
    const p = { name, address, lat: g.lat, lon: g.lon, ...(isHome ? { home: true } : {}) };
    savePlaces([...rest, p].slice(0, 40));
    return p;
  }
  function forgetPlace(name) {
    const before = places(), after = before.filter((p) => (key(name) === 'home' ? !p.home : p.home || key(p.name) !== key(name)));
    if (after.length === before.length) return false;
    savePlaces(after); return true;
  }

  const OFF = "The map isn't turned on yet: someone can turn it on in the Map app.";
  /** Show a place, and the drive to it from home, on the Map, and open it. */
  async function show({ place, label, note }) {
    if (!hasApp()) throw new Error("There's no Map app on this tablet.");
    if (!isOn()) throw new Error(OFF);
    const words = str(place, 200);
    if (!words) throw new Error('Which place?');
    const h = await home();
    const saved = key(words) === 'home' ? (h && { name: 'Home', address: h.label, lat: h.lat, lon: h.lon }) : byName(words);
    const at = saved || await find(words, { near: h });
    if (!at) throw new Error(`Couldn't find ${words} on the map.`);
    const d = h && saved?.name !== 'Home' ? await drive(h, at).catch(() => null) : null;
    cache.shown = { name: str(label || saved?.name || words, 80), address: saved?.address || at.label || words, lat: at.lat, lon: at.lon,
      ...(note ? { note: str(note, 200) } : {}), ...(d ? { minutes: d.minutes, miles: d.miles, line: d.line } : {}), at: now() };
    keep();
    homeScreen?.showApp?.('map');
    return cache.shown;
  }

  const TOOLS = [
    { name: 'show_on_map', description: 'Show a place on the tablet\'s Map, with the drive to it from home, and open the Map. Use it whenever you give directions, a travel time or when to leave, ' +
      'and when someone asks to see where something is. place: a saved place\'s name ("School", "Grandma\'s"), a street address, or a business or landmark with its town ' +
      '("Multnomah County Library, Portland"). It answers with the drive (typical times, no live traffic); say that time rather than guessing one.',
      inputSchema: { type: 'object', required: ['place'], properties: { place: { type: 'string' }, label: { type: 'string', description: 'A short name to show, if place is an address' }, note: { type: 'string', description: 'One line to show with it, e.g. "Leave by 3:40 for soccer"' } } } },
    { name: 'save_place', description: 'Save one of the household\'s places on the Map by name (school, practice, grandparents, work), or Home\'s street address (home: true). Only an address they told you.',
      inputSchema: { type: 'object', required: ['address'], properties: { name: { type: 'string' }, address: { type: 'string' }, home: { type: 'boolean' } } } },
    { name: 'forget_place', description: 'Take a saved place off the Map by its name ("Home" goes back to the town set for the weather).', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
  ];
  const ok = (text) => ({ content: [{ type: 'text', text }] }), err = (text) => ({ content: [{ type: 'text', text }], isError: true });
  async function call(name, a = {}) {
    try {
      if (name === 'show_on_map') {
        const s = await show(a);
        return ok(`The Map shows ${s.name}${s.address && s.address !== s.name ? ` (${s.address.split(',').slice(0, 3).join(',')})` : ''}.` +
          (s.minutes ? ` From home it's about ${s.minutes} minutes by car (${s.miles} miles): a typical time, without live traffic.` : ''));
      }
      if (name === 'save_place') { const p = await savePlace(a); return ok(`Saved ${p.name} on the Map: ${p.address}.`); }
      if (name === 'forget_place') return forgetPlace(a.name) ? ok(`Took ${str(a.name, 40)} off the Map.`) : err(`There's no saved place called ${str(a.name, 40)}. Saved: ${places().map((p) => p.name).join(', ') || 'none'}.`);
    } catch (e) { return err(String(e.message || e)); }
    return err(`${name} isn't a map tool.`);
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/map' && !p.startsWith('/map/')) return false;
    try {
      if (req.method === 'GET' && p === '/map') { json(res, 200, await view()); return true; }
      if (req.method === 'GET' && p === '/map/route') {
        const to = { lat: Number(url.searchParams.get('lat')), lon: Number(url.searchParams.get('lon')) };
        if (!isOn() || !Number.isFinite(to.lat) || !Number.isFinite(to.lon)) { json(res, 400, { error: 'route' }); return true; }
        const h = await home(), d = h && await drive(h, to);
        json(res, 200, d ? { minutes: d.minutes, miles: d.miles, line: d.line } : { error: h ? 'no route' : 'no home' }); return true;
      }
      if (req.method !== 'POST') return false;
      const b = await body(req);
      if (p === '/map/on') { board.saveHousehold({ maps: b.on !== false }, { quiet: true }); json(res, 200, { ok: true, on: b.on !== false }); return true; }
      if (p === '/map/place') { json(res, 200, { ok: true, place: await savePlace(b) }); return true; }
      if (p === '/map/place/remove') { json(res, 200, { ok: forgetPlace(b.name) }); return true; }
      if (p === '/map/clear') { cache.shown = null; keep(); json(res, 200, { ok: true }); return true; }
    } catch (e) { json(res, 200, { error: String(e.message || e) }); return true; }
    return false;
  }
  return Object.assign(handle, { tools: TOOLS, call, view, show, find, drive });
}
