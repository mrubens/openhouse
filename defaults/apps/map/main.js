// The household's Map (bridge/maps.js, docs/maps.md): home, saved places, today's events with a place and when to
// leave for them, and what Opie last showed. Tiles from OpenFreeMap (OpenStreetMap); places and drives through the
// bridge. Nothing is looked up until someone turns the map on here.
import { map as places, house } from '/kit/openhouse.js';

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const clock = (s) => { const d = new Date(s), h = d.getHours(), m = d.getMinutes(); return `${h % 12 || 12}:${pad(m)}${h < 12 ? 'a' : 'p'}`.replace(':00', ''); };
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const short = (a) => String(a || '').split(',').slice(0, 2).join(',');
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b5562f';
const ICONS = { home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h4.5v-5.5h3V20H18V9.5"/>', pin: '<path d="M12 21c4-4.5 6.5-7.8 6.5-11a6.5 6.5 0 10-13 0c0 3.200 2.500 6.500 6.500 11z"/><circle cx="12" cy="10" r="2.4"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', fit: '<path d="M12 4l6.5 15.5L12 16l-6.5 3.5z"/>' };
const ic = (name) => `<span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg></span>`;
/** The color of whoever an event is for (the household's own), or null when it's nobody's in particular. */
let family = [];
const colorOf = (who) => (family.some((p) => p.name.toLowerCase() === String(who || '').toLowerCase()) ? house.color(who) : null);

// The map's colors: the style the tiles come with (OpenFreeMap's Positron), painted in the home screen's light look
// (or its dark one): warm land, soft green, blue water, white roads. Only colors change; what's drawn stays theirs.
const DARK = document.documentElement.classList.contains('dark') || new URLSearchParams(location.hash.slice(1)).get('dark') === '1';
const LOOK = DARK
  ? { land: '#23252b', built: '#272a31', water: '#16303f', green: '#22362a', road: '#3b3f48', casing: '#1b1d22', rail: '#30333b', building: '#2b2e36', label: '#8d929d', place: '#d6d9df', greenLabel: '#7fae78', waterLabel: '#6fa3c2' }
  : { land: '#eef0ea', built: '#e9ebe4', water: '#a8d2ee', green: '#cfe5c2', road: '#ffffff', casing: '#cfd2c8', rail: '#d5d8cf', building: '#e3e5dc', label: '#8a8f84', place: '#4d5160', greenLabel: '#5a9a52', waterLabel: '#5f9cc0' };
document.documentElement.style.setProperty('--map-land', LOOK.land);
function recolor() {
  for (const l of map.getStyle()?.layers || []) {
    const k = `${l['source-layer'] || ''} ${l.id}`.toLowerCase(), set = (prop, v) => { try { map.setPaintProperty(l.id, prop, v); } catch {} };
    if (l.id.startsWith('drive')) continue; // ours
    if (l.type === 'background') set('background-color', LOOK.land);
    else if (l.type === 'fill') {
      if (/ice|glacier/.test(k)) continue;
      if (/water/.test(k)) set('fill-color', LOOK.water);
      else if (/park|wood|grass|forest|landcover/.test(k)) set('fill-color', LOOK.green);
      else if (/building/.test(k)) { set('fill-color', LOOK.building); set('fill-outline-color', LOOK.casing); }
      else if (/landuse|residential/.test(k)) set('fill-color', LOOK.built);
    } else if (l.type === 'line') {
      if (/water/.test(k)) set('line-color', LOOK.water);
      else if (/rail/.test(k)) set('line-color', LOOK.rail);
      else if (/boundary|admin/.test(k)) set('line-color', LOOK.casing);
      else if (/transportation|highway|road|tunnel|bridge|street/.test(k)) set('line-color', /casing/.test(k) ? LOOK.casing : LOOK.road);
    } else if (l.type === 'symbol') {
      set('text-color', /water/.test(k) ? LOOK.waterLabel : /park/.test(k) ? LOOK.greenLabel : /place/.test(k) ? LOOK.place : LOOK.label);
      set('text-halo-color', LOOK.land);
    }
  }
}

let data = null, sel = null, map = null, markers = [], seenShown = 0, routeFor = null;

// ---- the page ----
function draw() {
  if (!data) { app.innerHTML = `<div class="m-off"><div class="q-panel"><span class="mark">${ic('pin')}</span><h1>The map isn't here right now</h1><p>It will show once the tablet can reach it.</p></div></div>`; map = null; return; }
  if (!data.on) return off();
  if (!map) {
    app.innerHTML = `<div class="mapbox"><div id="map"></div><div class="zoom"><button class="round" data-do="in" aria-label="Closer">${ic('plus')}</button><button class="round" data-do="out" aria-label="Farther">${ic('minus')}</button><button class="round" data-do="fit" aria-label="Everything in view">${ic('fit')}</button></div></div><aside class="side"></aside>`;
    map = new maplibregl.Map({ container: 'map', style: STYLE, center: data.home ? [data.home.lon, data.home.lat] : [-98.6, 39.8], zoom: data.home ? 11 : 3,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => { recolor(); if (current()) route(); else fit(); });
    // Made while the tab was hidden or still being laid out, the map keeps that first size: it follows its box from
    // then on, and fits what it shows to the new size until someone moves it themselves.
    let moved = false, was = '';
    map.on('movestart', (e) => { if (e.originalEvent) moved = true; });
    new ResizeObserver(() => {
      const r = document.getElementById('map').getBoundingClientRect(), now = Math.round(r.width) + 'x' + Math.round(r.height);
      if (!r.width || !r.height || now === was) return;
      was = now; map.resize();
      if (map.loaded() && !moved) reframe();
    }).observe(document.getElementById('map'));
  }
  side(); pins();
}

/** How soon to leave, in a few words (for a leave-by card's label). */
function soon(leaveBy) {
  const m = Math.round((new Date(leaveBy) - Date.now()) / 60e3);
  return m <= 0 ? 'Time to go' : m <= 90 ? `Leave in ${mins(m)}` : 'Later today';
}
function side() {
  const s = app.querySelector('.side'); if (!s) return;
  const h = data.home, cur = current(), at = s.scrollTop;
  const card = cur && !(cur.kind === 'ev' && cur.leaveBy) ? `<section class="card">
      <div class="q-label">${cur.kind === 'shown' ? 'Opie showed' : cur.kind === 'ev' ? 'Today' : cur.kind === 'home' ? 'Home' : 'Saved place'}</div>
      <h2>${esc(cur.name)}</h2>
      ${cur.address && cur.address !== cur.name ? `<div class="addr">${esc(short(cur.address))}</div>` : ''}
      ${cur.leaveBy ? `<div class="drive">Leave by ${clock(cur.leaveBy)}</div><div class="note">${clock(cur.start)} start, about ${mins(cur.minutes)} away</div>`
        : cur.minutes ? `<div class="drive">About ${mins(cur.minutes)} by car</div>` : ''}
      ${cur.note ? `<div class="note">${esc(cur.note)}</div>` : ''}
      ${cur.minutes ? `<div class="fine">${cur.miles} miles from home. A typical time, without live traffic.</div>` : ''}
      <div class="acts">${cur.kind === 'place' ? '<button class="btn soft" data-do="remove">Remove</button>' : ''}${cur.kind === 'home' ? '<button class="btn soft" data-do="home">Set the address</button>' : ''}<button class="btn soft" data-do="close">Done</button></div>
    </section>` : '';
  const on = (kind, id) => (sel?.kind === kind && sel.id === id ? ' on' : '');
  const row = (kind, id, icon, what, line, end = '') => `<button class="m-row${on(kind, id)}" data-kind="${kind}" data-id="${esc(id)}">
      <span class="d">${ic(icon)}</span><span class="t"><div class="m-what">${esc(what)}</div>${line ? `<div class="m-line">${esc(line)}</div>` : ''}</span>${end ? `<em>${end}</em>` : ''}</button>`;
  // Today's events with a place: the ones with a drive are cards (when to leave), the rest rows (found, or not).
  const today = (data.today || []).map((e, i) => ({ ...e, i: String(i) }));
  const go = (e) => { const c = colorOf(e.who); return `<button class="go${c ? '' : ' plain'}${on('ev', e.i)}" data-kind="ev" data-id="${e.i}"${c ? ` style="--c:${c}"` : ''}>
      <div class="lab"><span>${soon(e.leaveBy)}</span><span>${esc(e.who || '')}</span></div>
      <div class="m-big">${clock(e.leaveBy)}<small>leave by</small></div>
      <b>${esc(e.title)}</b><span class="m">${clock(e.start)} · ${esc(short(e.place))} · ${mins(e.minutes)} drive</span></button>`; };
  const rest = today.filter((e) => !e.leaveBy);
  s.innerHTML = `<h1>Map</h1><div class="sub">${h ? esc(h.own ? short(h.label) : h.label) : 'Home isn\'t set yet'}</div>
    ${card}${today.filter((e) => e.leaveBy).map(go).join('')}
    ${rest.length ? `<div class="q-label">Today</div><div class="m-rows">${rest.map((e) => row('ev', e.i, 'clock', e.title, `${clock(e.start)} · ${e.place}`, e.lat == null ? (data.looking ? 'Finding…' : 'Not on the map') : '')).join('')}</div>` : ''}
    <div class="q-label">Places</div><div class="m-rows">
      ${h ? row('home', 'home', 'home', 'Home', h.own ? '' : 'From the weather') : '<div class="m-empty">Home isn\'t set yet.</div>'}
      ${(data.places || []).map((p) => row('place', p.name, 'pin', p.name, '', p.minutes ? mins(p.minutes) : '')).join('')}
    </div><button class="btn soft m-add" data-do="${h ? 'add' : 'home'}">${h ? 'Add a place' : 'Set the address'}</button>${h ? '' : '<button class="btn soft m-add" data-do="add">Add a place</button>'}`;
  s.scrollTop = at;
}

function off() {
  map = null;
  app.innerHTML = `<div class="m-off"><div class="q-panel"><span class="mark">${ic('pin')}</span><h1>Map</h1>
    <p class="lead">Home, the places you go, today's events and when to leave for them, and the places Opie shows you.</p>
    <p>Maps come from OpenStreetMap: free, with no account. The places you look up, and the places in today's events, are sent to OpenStreetMap's services to find them and the drive from home.</p>
    <button class="btn" data-do="on">Turn on the map</button></div></div>`;
}

// ---- what's selected ----
function current() {
  if (!sel || !data) return null;
  if (sel.kind === 'shown' && data.shown) return { kind: 'shown', ...data.shown };
  if (sel.kind === 'home' && data.home) return { kind: 'home', name: 'Home', address: data.home.label, lat: data.home.lat, lon: data.home.lon };
  if (sel.kind === 'place') { const p = (data.places || []).find((x) => x.name === sel.id); return p && { kind: 'place', ...p }; }
  if (sel.kind === 'ev') { const e = (data.today || [])[Number(sel.id)]; return e && { kind: 'ev', ...e, name: e.title, address: e.place }; }
  return null;
}

// ---- the map's pins and the drive ----
function pins() {
  if (!map) return;
  for (const m of markers) m.remove();
  markers = [];
  const add = (lat, lon, cls, icon, label, small = '', color = null) => {
    const el = document.createElement('div'); el.className = `mk ${cls}`; if (color) el.style.setProperty('--c', color);
    el.innerHTML = `<i>${ic(icon)}</i>${label ? `<span>${esc(label)}${small ? `<small>${esc(small)}</small>` : ''}</span>` : ''}`;
    markers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(map));
  };
  const taken = new Set((data.today || []).filter((e) => e.lat != null).map((e) => `${e.lat.toFixed(4)},${e.lon.toFixed(4)}`)); // a place with something on today shows as that
  for (const p of data.places || []) if (!taken.has(`${p.lat.toFixed(4)},${p.lon.toFixed(4)}`)) add(p.lat, p.lon, '', 'pin', p.name);
  (data.today || []).forEach((e) => { if (e.lat != null) add(e.lat, e.lon, 'ev', 'clock', e.title, `${clock(e.start)}${e.minutes ? ` · ${mins(e.minutes)}` : ''}`, colorOf(e.who)); });
  if (data.shown) add(data.shown.lat, data.shown.lon, 'shown', 'pin', data.shown.name);
  if (data.home) add(data.home.lat, data.home.lon, 'home', 'home', 'Home');
}
/** Room around what's fitted: more at the right, where the panel floats over the map (not on a phone, where it's under it). */
function pad2(n) { if (innerWidth <= 700) n = Math.round(n * .4); const side = app.querySelector('.side'), over = side && innerWidth > 700 ? side.offsetWidth + 16 : 0; return { top: n, bottom: n, left: n, right: n + over + (over ? 60 : 0) }; }
function fit() {
  if (!map) return;
  const pts = [data.home, ...(data.places || []), ...(data.today || []).filter((e) => e.lat != null), data.shown].filter(Boolean).map((p) => [p.lon, p.lat]);
  if (pts.length > 1) map.fitBounds(pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: pad2(90), maxZoom: 14, duration: 0 });
  else if (pts.length) map.jumpTo({ center: pts[0], zoom: 12 });
}
async function route() {
  if (!map || !map.isStyleLoaded()) return;
  const cur = current(), want = cur && cur.kind !== 'home' && data.home ? `${cur.lat},${cur.lon}` : null;
  if (want === routeFor) return;
  routeFor = want;
  let line = cur?.line || null;
  if (want && !line) { try { const r = await places.route(cur.lat, cur.lon); line = r?.line || null; if (r?.minutes && !cur.minutes) { Object.assign(target(), { minutes: r.minutes, miles: r.miles }); side(); } } catch {} }
  if (routeFor !== want) return; // something else was picked meanwhile
  const geo = { type: 'Feature', geometry: { type: 'LineString', coordinates: line || [] } };
  if (map.getSource('drive')) map.getSource('drive').setData(geo);
  else {
    map.addSource('drive', { type: 'geojson', data: geo });
    map.addLayer({ id: 'drive-under', type: 'line', source: 'drive', paint: { 'line-color': accent(), 'line-width': 16, 'line-blur': 8, 'line-opacity': .45 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'drive', type: 'line', source: 'drive', paint: { 'line-color': accent(), 'line-width': 6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  }
  // the drive in the color of whoever it's for (a deeper shade of it, so it reads on the land), else the accent
  const whose = cur?.kind === 'ev' && colorOf(cur.who);
  map.setPaintProperty('drive-under', 'line-color', whose || accent());
  map.setPaintProperty('drive', 'line-color', whose ? shade(whose) : accent());
  routeLine = line;
  if (cur) frameRoute(cur, 600);
}
let routeLine = null;
/** A color a third of the way to ink: '#ff8566' -> a deeper coral. */
const shade = (hex) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * .82).toString(16).padStart(2, '0')).join('');
/** The place shown, home and the drive between, in view. */
function frameRoute(cur, duration) {
  const pts = [[cur.lon, cur.lat], ...(data.home ? [[data.home.lon, data.home.lat]] : []), ...(routeLine || [])];
  const b = pts.reduce((x, p) => x.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: pad2(110), maxZoom: 15, duration });
}
/** What it shows, fitted again (its size changed). */
function reframe() { const cur = current(); if (cur && routeFor) frameRoute(cur, 0); else if (cur) route(); else fit(); }
// the data a pick points at (to keep a drive's time found for it)
function target() {
  if (sel.kind === 'place') return data.places.find((x) => x.name === sel.id) || {};
  if (sel.kind === 'ev') return data.today[Number(sel.id)] || {};
  return {};
}
function pick(next) { sel = next; side(); route(); if (!sel) fit(); }

// ---- adding a place ----
function sheet({ home = false } = {}) {
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = `<form class="sheet"><h2>${home ? "Home's address" : 'Add a place'}</h2>
    ${home ? '' : '<input class="field" name="name" autocomplete="off" placeholder="Name, like School or Grandma\'s">'}
    <input class="field" name="address" autocomplete="off" placeholder="Street address, town">
    <div class="sugs"></div>
    <div class="msg"></div><div class="btns"><button class="btn soft" type="button" data-x>Cancel</button><button class="btn">Save</button></div></form>`;
  document.body.appendChild(el);
  const f = el.querySelector('form'), msg = el.querySelector('.msg');
  el.onclick = (e) => { if (e.target === el || e.target.hasAttribute('data-x')) el.remove(); };
  (f.name || f.address).focus();
  // Addresses as they type (the cloud's suggestions, nearest home first): a tap fills the box, and its place is the one saved.
  const sugs = el.querySelector('.sugs');
  let picked = null, asked = 0, timer = 0;
  f.address.addEventListener('input', () => {
    picked = null; clearTimeout(timer);
    const q = f.address.value.trim();
    if (q.length < 3) { sugs.replaceChildren(); return; }
    timer = setTimeout(async () => {
      const mine = ++asked, list = await places.suggest(q);
      if (mine !== asked) return; // (a newer one is on its way)
      sugs.replaceChildren(...list.map((x) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sug'; b.textContent = x.text;
        b.onclick = () => { f.address.value = x.text; picked = x; sugs.replaceChildren(); f.address.focus(); }; return b; }));
    }, 250);
  });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const name = home ? 'Home' : f.name.value.trim(), address = f.address.value.trim();
    if (!name || !address) { msg.textContent = home ? 'An address, please.' : 'A name and an address, please.'; return; }
    msg.textContent = 'Finding it…';
    try {
      const r = await places.save(name, address, home, picked && picked.text === address ? picked.id : '');
      if (r?.ok === false || r?.error) { msg.textContent = r.error || "That didn't save. Try again."; return; }
      el.remove(); await refresh(); pick(home ? { kind: 'home', id: 'home' } : { kind: 'place', id: r.place.name }); fit();
    } catch { msg.textContent = "That didn't save. Try again."; }
  };
}

app.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const act = b.dataset.do;
  if (act === 'on') { b.disabled = true; await places.turnOn(true).catch(() => {}); return refresh(); }
  if (act === 'in') return map?.zoomIn();
  if (act === 'out') return map?.zoomOut();
  if (act === 'fit') return reframe();
  if (act === 'add') return sheet();
  if (act === 'home') return sheet({ home: true });
  if (act === 'close') { if (sel?.kind === 'shown') { places.clear().catch(() => {}); data.shown = null; pins(); } return pick(null); }
  if (act === 'remove' && sel?.kind === 'place') { await places.remove(sel.id).catch(() => {}); sel = null; await refresh(); return fit(); }
  if (b.dataset.kind) pick(sel?.kind === b.dataset.kind && sel.id === b.dataset.id ? null : { kind: b.dataset.kind, id: b.dataset.id });
});

// ---- keeping up (Opie showing a place lands within a few seconds) ----
let timer = 0, lastJson = '';
async function refresh() {
  clearTimeout(timer);
  let next = null;
  try { next = await places.get(); if (next?.error) next = null; } catch {}
  const j = JSON.stringify(next);
  if (j !== lastJson) {
    const count = (d) => (d ? [d.home, ...(d.places || []), ...(d.today || []).filter((e) => e.lat != null)].filter(Boolean).length : 0), had = count(data);
    lastJson = j; data = next;
    if (data?.shown && data.shown.at !== seenShown) { seenShown = data.shown.at; sel = { kind: 'shown', id: 'shown' }; routeFor = null; }
    if (sel && !current()) sel = null;
    draw();
    if (map?.isStyleLoaded() && !sel && count(data) !== had) fit(); // a place found since: bring it into view
    route();
  }
  if (!document.hidden) timer = setTimeout(refresh, data?.looking ? 2000 : 4000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else clearTimeout(timer); });
refresh();
// whose color is whose (and it changing)
house.subscribe((h) => { const next = JSON.stringify((h.family || []).map((p) => [p.name, p.color])); if (next === JSON.stringify(family.map((p) => [p.name, p.color]))) return; family = h.family || []; if (data?.on && map) { side(); pins(); } });
