// The household on a TV: read from the sofa, driven by the remote (left and right, or OK for the next). Three views:
// the photos with the time and what's next, Today, and the week. After 10 minutes untouched it goes back to the
// photos, and in the household's night hours it shows only the time and the first thing tomorrow, dim, until a key
// is pressed (that key only wakes it).
//
// It's an app for screens (app.json "screens": ["tv"]): a paired TV shows it, and the tablet doesn't list it. It only
// reads the house (the kit, as in any app); nothing here can change anything.
import { house, weather } from '/kit/openhouse.js';

const VIEWS = ['photos', 'today', 'week'];
const NAMES = { photos: 'Photos', today: 'Today', week: 'This week' };
const IDLE = 10 * 60e3, AWAKE = 60e3, EVERY = 15e3; // back to the photos; awake at night after a key; a photo's time
const $app = document.getElementById('app');

// ---- helpers ----------------------------------------------------------------------------------------------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k === 'style') Object.assign(el.style, v); else el.setAttribute(k, v); }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const clock = (now) => new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
const whoOf = (e) => [e.who, ...(e.also || [])].filter(Boolean);
const dots = (names) => h('span', { class: 'who' }, names.map((w) => h('i', { style: { background: house.color(w) } })), names.join(', '));

/** Events that touch a day, in order (all-day first). */
function eventsOn(hs, day) {
  const a = new Date(day); a.setHours(0, 0, 0, 0);
  const b = new Date(a); b.setDate(b.getDate() + 1);
  return (hs?.events || []).filter((e) => { const s = Date.parse(e.start), x = Date.parse(e.end || e.start); return s < b && (x > a || s >= a); })
    .sort((x, y) => (y.allDay ? 1 : 0) - (x.allDay ? 1 : 0) || Date.parse(x.start) - Date.parse(y.start));
}
/** The next few things from now (today, then tomorrow). */
function nextUp(hs, now, n = 3) {
  return (hs?.events || []).filter((e) => !e.allDay && Date.parse(e.end || e.start) > now && Date.parse(e.start) < now + 36 * 3600e3)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, n);
}
const whenWord = (e, now) => (Date.parse(e.start) <= now ? 'Now' : dayKey(new Date(now)) === dayKey(new Date(e.start)) ? time(e.start) : `Tomorrow ${time(e.start)}`);
/** The household's night hours (Settings on the tablet: house.night {from, to} "HH:MM"). */
function isNight(hs, now) {
  const n = hs?.night; if (!n?.from || !n?.to) return false;
  const d = new Date(now), m = d.getHours() * 60 + d.getMinutes();
  const mins = (t) => { const [x, y] = String(t).split(':').map(Number); return x * 60 + (y || 0); };
  const a = mins(n.from), b = mins(n.to);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

// ---- views ------------------------------------------------------------------------------------------------
const event = (e, now, big) => h('div', { class: 'event' + (big ? ' big' : '') },
  h('span', { class: 'when' }, e.allDay ? 'All day' : whenWord(e, now)), h('span', { class: 'what' }, e.title), whoOf(e).length ? dots(whoOf(e)) : null);
function clockBlock(now) {
  const t = wx?.temp;
  return h('div', {}, h('div', { class: 'time' }, clock(now)),
    h('div', { class: 'date' }, new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + (t != null ? ` · ${Math.round(t)}°` : '')));
}

// The photos stay put between redraws (so they can crossfade): one layer, with the last two pictures in it, under
// everything else (which is drawn again every second).
const layer = h('div', { class: 'photos' }), $rest = h('div', {});
$app.append(layer, $rest);
let shownName = null;
function photos(hs, now) {
  const names = hs?.photos || [];
  const i = names.length ? Math.floor(now / EVERY) % names.length : -1;
  const name = i >= 0 ? names[i] : null;
  if (name && name !== shownName) {
    shownName = name;
    house.photo(name).then((src) => {
      if (shownName !== name) return;
      const img = h('img', { src, alt: '' });
      img.onload = () => { for (const o of layer.querySelectorAll('img.on')) o.classList.remove('on'); img.classList.add('on'); [...layer.querySelectorAll('img')].slice(0, -2).forEach((o) => o.remove()); };
      layer.append(img);
    }).catch(() => {});
    if (names.length > 1) house.photo(names[(i + 1) % names.length]).catch(() => {}); // the next one, loaded ahead
  }
  const caption = name && hs?.captions?.[name], next = nextUp(hs, now);
  return [
    !names.length && h('div', { class: 'empty' }, 'No photos yet. Add some from a phone in the Photos app.'),
    h('div', { class: 'corner left' }, clockBlock(now), caption && h('div', { class: 'caption' }, caption)),
    next.length > 0 && h('div', { class: 'corner right' }, next.map((e) => event(e, now)))];
}
function today(hs, now) {
  let evs = eventsOn(hs, now).filter((e) => e.allDay || Date.parse(e.end || e.start) > now - 30 * 60e3), title = 'Today';
  if (!evs.length) { const t = new Date(now); t.setDate(t.getDate() + 1); evs = eventsOn(hs, t); title = evs.length ? 'Tomorrow' : 'Today'; }
  const dinner = hs?.meals?.[dayKey(new Date(now))]?.dinner;
  const left = {};
  for (const c of hs?.chores || []) if (c.today && !c.done && !c.skipped) (left[c.who || 'Anyone'] ||= []).push(c.task);
  const groceries = (hs?.lists || []).find((l) => l.id === 'groceries');
  const open = groceries ? groceries.items.filter((x) => !x.done) : [];
  return h('div', { class: 'sheet' }, clockBlock(now), h('div', { class: 'cols' },
    h('section', {}, h('h2', {}, title), evs.length ? evs.slice(0, 6).map((e) => event(e, now, true)) : h('p', { class: 'soft' }, 'Nothing on the calendar.')),
    h('section', {},
      dinner && [h('h2', {}, 'Dinner'), h('p', { class: 'big' }, dinner)],
      h('h2', {}, 'Chores left'),
      Object.keys(left).length ? Object.entries(left).map(([who, tasks]) => h('div', { class: 'chores' }, dots([who]), h('span', {}, tasks.join(', ')))) : h('p', { class: 'soft' }, 'All done.'),
      open.length > 0 && [h('h2', {}, 'Groceries'), h('p', {}, open.slice(0, 6).map((x) => x.text).join(', ') + (open.length > 6 ? ` and ${open.length - 6} more` : ''))])));
}
function week(hs, now) {
  const days = [...Array(7)].map((_, i) => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + i); return d; });
  return h('div', { class: 'sheet' }, h('div', { class: 'week' }, days.map((d, i) => {
    const evs = eventsOn(hs, d), dinner = hs?.meals?.[dayKey(d)]?.dinner;
    return h('section', { class: i === 0 ? 'today' : null },
      h('h3', {}, i === 0 ? 'Today' : d.toLocaleDateString([], { weekday: 'short' }), ' ', h('span', {}, d.getDate())),
      evs.slice(0, 5).map((e) => h('div', { class: 'wk' }, h('div', { class: 'wk-what' }, e.title),
        h('div', { class: 'soft' }, e.allDay ? 'All day' : time(e.start), whoOf(e).length ? dots(whoOf(e)) : null))),
      evs.length > 5 && h('div', { class: 'soft' }, `and ${evs.length - 5} more`),
      dinner && h('div', { class: 'dinner' }, `Dinner: ${dinner}`));
  })));
}
function night(hs, now) {
  const next = nextUp(hs, now, 1)[0];
  return h('div', { class: 'night' }, h('div', { class: 'time' }, clock(now)), next && h('div', { class: 'date' }, `${whenWord(next, now)} · ${next.title}`));
}

// ---- the page ---------------------------------------------------------------------------------------------
let view = 'photos'; try { if (VIEWS.includes(localStorage.getItem('view'))) view = localStorage.getItem('view'); } catch {}
let touched = Date.now(), hintUntil = Date.now() + 6000, asleep = false, wx = null;

function draw() {
  const hs = house.data, now = Date.now();
  if (!hs) return;
  if (view !== 'photos' && now - touched > IDLE) view = 'photos';
  asleep = isNight(hs, now) && now - touched > AWAKE;
  layer.hidden = asleep || view !== 'photos';
  $rest.replaceChildren(...[asleep ? night(hs, now) : { photos, today, week }[view](hs, now),
    !asleep && h('nav', { class: now < hintUntil ? 'on' : null }, VIEWS.map((v) => h('span', { class: v === view ? 'here' : null }, NAMES[v])), h('em', {}, 'Left and right to change'))].flat().filter(Boolean));
}
addEventListener('keydown', (e) => {
  touched = Date.now();
  if (asleep) { e.preventDefault(); return draw(); } // the first key only wakes it
  const step = { ArrowRight: 1, Enter: 1, ' ': 1, MediaTrackNext: 1, ArrowLeft: -1, MediaTrackPrevious: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  view = VIEWS[(VIEWS.indexOf(view) + step + VIEWS.length) % VIEWS.length];
  hintUntil = Date.now() + 6000;
  try { localStorage.setItem('view', view); } catch {}
  draw();
});
house.subscribe(draw);
const refreshWeather = () => weather().then((w) => { wx = w; draw(); });
refreshWeather(); setInterval(refreshWeather, 10 * 60e3);
setInterval(draw, 1000);
