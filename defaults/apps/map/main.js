// The household's Map (bridge/maps.js, docs/maps.md): home, saved places, today's events with a place and when to
// leave for them, and what Opie last showed. Tiles from OpenFreeMap (OpenStreetMap); places and drives through the
// bridge. Nothing is looked up until someone turns the map on here.
import { map as places } from '/kit/openhouse.js';

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const clock = (s) => { const d = new Date(s), h = d.getHours(), m = d.getMinutes(); return `${h % 12 || 12}:${pad(m)}${h < 12 ? 'a' : 'p'}`.replace(':00', ''); };
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const short = (a) => String(a || '').split(',').slice(0, 2).join(',');
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b5562f';

let data = null, sel = null, map = null, markers = [], seenShown = 0, routeFor = null;

// ---- the page ----
function draw() {
  if (!data) { app.innerHTML = '<div class="none"><h2>The map isn\'t here right now</h2><p>It will show once the tablet can reach it.</p></div>'; map = null; return; }
  if (!data.on) return off();
  if (!map) {
    app.innerHTML = '<aside class="side"></aside><div class="mapbox"><div id="map"></div></div>';
    map = new maplibregl.Map({ container: 'map', style: STYLE, center: data.home ? [data.home.lon, data.home.lat] : [-98.6, 39.8], zoom: data.home ? 11 : 3,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => { if (current()) route(); else fit(); });
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

function side() {
  const s = app.querySelector('.side'); if (!s) return;
  const h = data.home, cur = current();
  const card = cur ? `<section class="sec card">
      <div class="label">${cur.kind === 'shown' ? 'Opie showed' : cur.kind === 'ev' ? 'Today' : cur.kind === 'home' ? 'Home' : 'Saved place'}</div>
      <h2>${esc(cur.name)}</h2>
      ${cur.address && cur.address !== cur.name ? `<div class="addr">${esc(short(cur.address))}</div>` : ''}
      ${cur.leaveBy ? `<div class="drive">Leave by ${clock(cur.leaveBy)}</div><div class="note">${clock(cur.start)} start, about ${mins(cur.minutes)} away</div>`
        : cur.minutes ? `<div class="drive">About ${mins(cur.minutes)} by car</div>` : ''}
      ${cur.note ? `<div class="note">${esc(cur.note)}</div>` : ''}
      ${cur.minutes ? `<div class="fine">${cur.miles} miles from home. A typical time, without live traffic.</div>` : ''}
      <div class="acts">${cur.kind === 'place' ? '<button data-do="remove">Remove</button>' : ''}${cur.kind === 'home' ? '<button data-do="home">Set the address</button>' : ''}<button data-do="close">Done</button></div>
    </section>` : '';
  const row = (kind, id, pinCls, what, sub, end = '') => `<button class="row${sel?.kind === kind && sel.id === id ? ' on' : ''}" data-kind="${kind}" data-id="${esc(id)}">
      <i class="pin ${pinCls}"></i><div style="min-width:0"><div class="what">${esc(what)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div><div class="end">${end}</div></button>`;
  const today = data.today || [];
  s.innerHTML = card + `
    <section class="sec"><div class="label">Today</div><div class="rows">${today.length ? today.map((e, i) => row('ev', String(i), 'ev', e.title, `${clock(e.start)} · ${e.place}`,
      e.leaveBy ? `<b>Leave ${clock(e.leaveBy)}</b>${mins(e.minutes)}` : e.lat == null ? (data.looking ? 'Finding…' : 'Not on the map') : '')).join('')
      : '<div class="empty">Nothing with a place today.</div>'}</div></section>
    <section class="sec"><div class="label">Places</div><div class="rows">
      ${h ? row('home', 'home', 'home', 'Home', h.own ? short(h.label) : `${h.label}, from the weather`) : '<div class="empty">Home isn\'t set yet.</div>'}
      ${(data.places || []).map((p) => row('place', p.name, '', p.name, short(p.address), p.minutes ? mins(p.minutes) : '')).join('')}
    </div><button class="add" data-do="add">Add a place</button></section>`;
}

function off() {
  map = null;
  app.innerHTML = `<div class="none"><h2>The map</h2>
    <p>Home, the places you go, today's events and when to leave for them, and the places Opie shows you.</p>
    <p>Maps come from OpenStreetMap: free, with no account. The places you look up, and the places in today's events, are sent to OpenStreetMap's services to find them and the drive from home.</p>
    <button class="go" data-do="on">Turn on the map</button></div>`;
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
  const add = (lat, lon, cls, label) => {
    const el = document.createElement('div'); el.className = `mk ${cls}`; el.innerHTML = `<i></i>${label ? `<span>${esc(label)}</span>` : ''}`;
    markers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [-9, 0] }).setLngLat([lon, lat]).addTo(map));
  };
  if (data.home) add(data.home.lat, data.home.lon, 'home', 'Home');
  for (const p of data.places || []) add(p.lat, p.lon, '', p.name);
  (data.today || []).forEach((e) => { if (e.lat != null) add(e.lat, e.lon, 'ev', `${clock(e.start)} ${e.title}`); });
  if (data.shown) add(data.shown.lat, data.shown.lon, 'shown', data.shown.name);
}
function fit() {
  if (!map) return;
  const pts = [data.home, ...(data.places || []), ...(data.today || []).filter((e) => e.lat != null), data.shown].filter(Boolean).map((p) => [p.lon, p.lat]);
  if (pts.length > 1) map.fitBounds(pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: 90, maxZoom: 14, duration: 0 });
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
    map.addLayer({ id: 'drive-under', type: 'line', source: 'drive', paint: { 'line-color': '#ffffff', 'line-width': 9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    map.addLayer({ id: 'drive', type: 'line', source: 'drive', paint: { 'line-color': accent(), 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  }
  routeLine = line;
  if (cur) frameRoute(cur, 600);
}
let routeLine = null;
/** The place shown, home and the drive between, in view. */
function frameRoute(cur, duration) {
  const pts = [[cur.lon, cur.lat], ...(data.home ? [[data.home.lon, data.home.lat]] : []), ...(routeLine || [])];
  const b = pts.reduce((x, p) => x.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: 110, maxZoom: 15, duration });
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
    ${home ? '' : '<input name="name" autocomplete="off" placeholder="Name, like School or Grandma\'s">'}
    <input name="address" autocomplete="off" placeholder="Street address, town">
    <div class="msg"></div><div class="btns"><button type="button" data-x>Cancel</button><button class="main">Save</button></div></form>`;
  document.body.appendChild(el);
  const f = el.querySelector('form'), msg = el.querySelector('.msg');
  el.onclick = (e) => { if (e.target === el || e.target.hasAttribute('data-x')) el.remove(); };
  (f.name || f.address).focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const name = home ? 'Home' : f.name.value.trim(), address = f.address.value.trim();
    if (!name || !address) { msg.textContent = home ? 'An address, please.' : 'A name and an address, please.'; return; }
    msg.textContent = 'Finding it…';
    try {
      const r = await places.save(name, address, home);
      if (r?.error) { msg.textContent = r.error; return; }
      el.remove(); await refresh(); pick(home ? { kind: 'home', id: 'home' } : { kind: 'place', id: r.place.name }); fit();
    } catch { msg.textContent = "That didn't save. Try again."; }
  };
}

app.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const act = b.dataset.do;
  if (act === 'on') { b.disabled = true; await places.turnOn(true).catch(() => {}); return refresh(); }
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
