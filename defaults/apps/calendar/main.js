// Calendar: one day by the hour, the week in columns, the whole month, or everything coming up as a list, each person in
// their color. Tap a day to see all of it and add to it. Events come from the family's synced calendars (added in Settings) plus ones added here,
// which can repeat and stay on this display. Events in a two-way calendar (Google or iCloud signed in on the display: editable)
// change here like those; calendars read from a link are read-only here. The events live in the bridge, not here.
import { house, timer, say, phone, shell, weather, screen as onScreen } from '/kit/openhouse.js';
import { icon as skyIcon } from '/kit/weather-look.js';

// ---- drawing: small helpers (no framework) ----------------------------------------------------------------
const $app = document.getElementById('app');
const $over = document.body.appendChild(document.createElement('div'));

/** An element: h('div', { class, style, tap, hold, ...attributes }, ...children). tap/hold are touch-first presses. */
function h(tag, props, ...kids) {
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
function press(el, tap, hold) {
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

const ICONS = { plus: '<path d="M12 4.5v15M4.5 12h15"/>', edit: '<path d="M5 19h4L19.5 8.5l-4-4L5 15v4z"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', left: '<path d="M14.5 5.5L8 12l6.5 6.5"/>', right: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>', up: '<path d="M5.5 14.5L12 8l6.5 6.5"/>', down: '<path d="M5.5 9.5L12 16l6.5-6.5"/>',
  photo: '<rect x="3.5" y="6.5" width="17" height="13" rx="2.5"/><path d="M8.5 6.5l1.5-2.5h4l1.5 2.5"/><circle cx="12" cy="13" r="3.2"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0111 0v5.5l1.5 1.5h-14z"/><path d="M10 20.5a2 2 0 004 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  horizon: '<path d="M3 17h18M7 17a5 5 0 0110 0M12 6.5V9M5.4 10.4l1.7 1.7M18.6 10.4l-1.7 1.7M8 20.5h8"/>',
  moon: '<path d="M19.5 14.2A8 8 0 019.8 4.5a8 8 0 109.7 9.7z"/>',
  fork: '<path d="M7 3.5v17M4.5 3.5v4a2.5 2.5 0 005 0v-4M17.5 20.5v-17c-2.2 1.2-3.5 4-3.5 7.5v2h3.5"/>',
  note: '<path d="M5 4.5h14v10l-5 5H5z"/><path d="M14 19.5v-5h5M8.5 9h7M8.5 12.5h4"/>' };
const icon = (name, cls = '') => h('span', { class: 'icon ' + cls, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });
const STAR = [...Array(10)].map((_, i) => { const a = Math.PI / 5 * i - Math.PI / 2, r = i % 2 ? 22.5 : 50; return `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
const star = (color, size) => h('span', { class: 'star', style: `width:calc(${size} * var(--u));height:calc(${size} * var(--u))`, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 100 100"><polygon fill="${color}" points="${STAR}"/></svg>` });

const btn = (label, tap, { soft = false, color = null, disabled = false, cls = '' } = {}) =>
  h('button', { class: `btn ${soft ? 'soft' : ''} ${cls}`, style: color && !soft ? `background:${color}` : null, disabled, tap: disabled ? null : tap }, label);
const chip = (label, on, tap, dot = null) => h('button', { class: 'chip' + (on ? ' on' : ''), tap }, dot && h('span', { class: 'dot', style: `background:${dot}` }), label);
const round = (name, tap, { dark = false, disabled = false, label = null } = {}) =>
  h('button', { class: 'round' + (dark ? ' dark' : ''), disabled, 'aria-label': label, tap: disabled ? null : tap }, icon(name));
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Everyone an event is for: its person and whoever else it's for (also). */
// Whose it is, by the family's own names only: a synced calendar's name ("Family") on every event says nothing.
const isPerson = (n) => (H?.family || []).some((p) => p.name.toLowerCase() === String(n).toLowerCase());
const people = (e) => [e.who, ...(e.also || [])].filter((n) => n && isPerson(n));
const whoText = (e) => people(e).join(' & ');
/** An event's color: its person's, or stripes of each one's when it's for several (null: nobody's). */
const paint = (e) => { const cs = people(e).map((n) => house.color(n)); return cs.length > 1 ? `repeating-linear-gradient(135deg, ${cs.map((c, i) => `${c} calc(${i * 9} * var(--u)) calc(${(i + 1) * 9} * var(--u))`).join(', ')})` : cs[0] || null; };
/** How an event is drawn anywhere (index.html .ev): on its person's color; nobody's is a soft card, or ink when all day. */
// A person's color wins (whose it is); else the color chosen for its calendar (Settings, Calendars), else plain.
const calTone = (e) => (people(e).length ? null : e.color || null);
const evLook = (e, cls, past = false, style = '') => ({ class: `${cls} ev${people(e).length || calTone(e) ? '' : e.allDay ? ' solid' : ' plain'}${past ? ' past' : ''}`, style: [style, people(e).length ? `background:${paint(e)}` : calTone(e) ? `background:${calTone(e)}` : ''].filter(Boolean).join(';') || null });
/** A person's round mark: their initial, in their color. */
const mark = (name, cls = '') => h('span', { class: 'q-av ' + cls, style: `--c:${house.color(name)}` }, String(name).trim().charAt(0).toUpperCase());
const marks = (e, cls = 'sm') => (people(e).length ? h('span', { class: 'avs' }, people(e).map((n) => mark(n, cls))) : null);
/** A person to choose: their mark and name on a pill. */
const who = (name, on, tap) => h('button', { class: 'q-who' + (on ? ' on' : ''), tap }, h('span', { class: 'q-av sm', style: `background:${house.color(name)}` }, String(name).trim().charAt(0).toUpperCase()), name);
/** Redraw an element's insides, keeping where each [data-keep] part was scrolled to. */
function keepScroll(root, fn) {
  const at = {};
  root.querySelectorAll('[data-keep]').forEach((e) => { at[e.dataset.keep] = [e.scrollLeft, e.scrollTop]; });
  fn();
  root.querySelectorAll('[data-keep]').forEach((e) => { const v = at[e.dataset.keep]; if (v) { e.scrollLeft = v[0]; e.scrollTop = v[1]; } });
}

// ---- cards over the app (a stack: a card can open another) ----
const sheets = [];
function openSheet(el, redraw = null) {
  const s = { el, redraw: () => redraw?.(s), close: () => { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); el.remove(); } };
  sheets.push(s); $over.append(el); s.redraw();
  return s;
}
/** A card in the middle; render(close) gives its insides (drawn again when the house changes). Tapping outside closes it. */
function openCard(render, { width = 720, onOutside = null } = {}) {
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', style: `width:calc(${width} * var(--u))`, tap: () => {} });
  let s;
  const scrim = h('div', { class: 'scrim', role: 'none', tap: () => (onOutside ? onOutside(s.close) : s.close()) }, card);
  s = openSheet(scrim, (me) => keepScroll(card, () => card.replaceChildren(...[render(me.close)].flat().filter(Boolean))));
  return s;
}
/** "Take it off?": a question, the kind answer, and the other one. */
function confirmCard(title, yes, onYes, no = 'Keep it', onNo = null) {
  return openCard((close) => [
    h('h2', { class: 'big' }, title),
    h('div', { class: 'actions' }, btn(no, () => { close(); onNo?.(); }, { soft: true }), btn(yes, () => { close(); onYes(); }, { color: 'var(--red)' })),
  ], { onOutside: (close) => { close(); onNo?.(); } });
}
/** Asks for a few words with the keyboard (an item, a chore, a meal). extra(): more choices under the field. */
function ask({ title, hint = '', initial = '', extra = null, onDone }) {
  const input = h('input', { class: 'field', placeholder: hint, enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  input.value = initial;
  const more = h('div', { class: 'extra' });
  let s;
  const finish = () => { const t = input.value.trim(); if (!t) return; input.blur(); s.close(); onDone(t); };
  const done = btn('Done', null, { disabled: !initial.trim() });
  input.addEventListener('input', () => { done.disabled = !input.value.trim(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(); } });
  const cancel = btn('Cancel', () => { input.blur(); s.close(); }, { soft: true });
  // (Done is re-armed as the text changes, so its tap reads the field when pressed.)
  press(done, () => { if (!done.disabled) finish(); });
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', tap: () => {} }, h('h2', null, title), input, more, h('div', { class: 'actions' }, cancel, done));
  const scrim = h('div', { class: 'scrim high', tap: () => { input.blur(); s.close(); } }, card);
  s = openSheet(scrim, (me) => keepScroll(more, () => more.replaceChildren(...[extra?.(me)].flat().filter(Boolean))));
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  return s;
}

// ---- the calendar ------------------------------------------------------------------------------------------
/** How many days the week view shows. */
const DAYS = 7;
/** How far ahead the list goes. */
const AGENDA_DAYS = 21;
/** The view it opens on: "day", "week", "month" or "list". */
const START_VIEW = 'week';
/** A phone (docs/phones.md, "Narrow screens"): the week is a list under its days, and the top row is shorter. */
const narrow = () => matchMedia('(max-width: 700px)').matches;
const REPEATS = [[null, 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'], ['yearly', 'Every year']];

let H = null, events = [], view = START_VIEW, weeks = 0, months = 0, days = 0;
/** The day view's hours (it scrolls to now; earlier and later are a scroll away). */
const FIRST_HOUR = 0, HOURS = 24, HOUR_U = 60;
let scrolledTo = null; // the day the day view last scrolled itself to (after that it stays where they put it)

function draw() {
  keepScroll($app, () => $app.replaceChildren(screen()));
  for (const s of sheets) s.redraw?.();
}

// days, as the time of their midnight
const dayStart = (t, plus = 0) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + plus); return d.getTime(); };
const monthStart = (t, plus = 0) => { const d = new Date(dayStart(t)); d.setDate(1); d.setMonth(d.getMonth() + plus); return d.getTime(); };
const FIRST_DAY = (() => { try { const l = new Intl.Locale(navigator.language); const w = l.getWeekInfo?.() || l.weekInfo; return (w?.firstDay ?? 7) % 7; } catch { return 0; } })(); // 0: Sunday
const weekStart = (t) => { let d = dayStart(t); while (new Date(d).getDay() !== FIRST_DAY) d = dayStart(d, -1); return d; };
const fmt = (t, o) => new Date(t).toLocaleDateString(undefined, o);
/** The time, short, for where there's little room: "9:15a", "5p". */
const shortTime = (t) => { const d = new Date(t), hr = d.getHours(), m = d.getMinutes(); return `${hr % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${hr < 12 ? 'a' : 'p'}`; };
/** An event's hours: "9:15 – 10:45a", "11a – 1p". */
const shortSpan = (e) => { if (!e.t1) return shortTime(e.t0); const a = shortTime(e.t0), b = shortTime(e.t1); return `${a.at(-1) === b.at(-1) ? a.slice(0, -1) : a} – ${b}`; };
const timeOf = (t) => { const d = new Date(t), hr = d.getHours(), m = d.getMinutes(); return `${hr % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${hr < 12 ? 'AM' : 'PM'}`; };
const onDay = (e, day) => e.t0 < dayStart(day, 1) && (e.t1 ?? e.t0 + 1) > day && !(e.allDay && (e.t1 ?? 0) <= day);
const eventsOn = (day) => events.filter((e) => onDay(e, day)).sort((a, b) => (b.allDay - a.allDay) || a.t0 - b.t0);
/** All day, or running past midnight into another day: shown as one bar across its days (week and month). */
const spans = (e) => e.allDay || (e.t1 != null && dayStart(e.t1 - 1) > dayStart(e.t0));
/** The bars for the days from `first`, `n` of them: each spanning event once, packed into lanes (rows) so none overlap.
 *  a, b: its first and last column; cutL/cutR: it goes on before or after these days. keep: which of them. */
function bars(first, n, keep = () => true) {
  const last = dayStart(first, n);
  const list = events.filter((e) => spans(e) && keep(e) && e.t0 < last && (e.t1 ?? e.t0 + 1) > first)
    .sort((x, y) => x.t0 - y.t0 || (y.t1 ?? 0) - (x.t1 ?? 0));
  const col = (t) => Math.round((dayStart(t) - first) / 86400000);
  const lanes = [];
  return { list: list.map((e) => {
    const end = Math.max(e.t0, (e.t1 ?? e.t0 + 1) - 1);
    const a = Math.max(0, col(e.t0)), b = Math.min(n - 1, col(end));
    let lane = lanes.findIndex((l) => l < a); if (lane < 0) { lane = lanes.length; lanes.push(-1); } lanes[lane] = b;
    return { e, a, b, lane, cutL: e.t0 < first, cutR: end >= last };
  }), lanes: lanes.length };
}
/** A bar's words: its title, after its start time when it isn't all day (a sleepover from 5 PM to 10 AM). Whose it is is its color. */
/** What the household's apps put on a day (a school lunch, trash day): notes, not events (bridge day-notes.js), in the
 *  household's order. week: only the apps chosen for the week (Week and Today); else every one not turned off. */
const notesOn = (day, week = false) => (H?.dayNotes?.[house.dayKey(new Date(day))] || []).filter((x) => (week ? x.show === 'week' : x.show !== 'off'));
/** A note's label: "Lunch", and whose with their color ("Lunch · ● June") when it's one person's. */
const noteLabel = (x, sep = ' ') => [x.label, x.who ? [sep, isPerson(x.who) ? h('span', { class: 'nkid', style: `background:${house.color(x.who)}` }) : null, x.who] : null];
/** The whole text, each choice on its own line ("Popcorn Chicken / or Vegan Chic'n Nuggets", the "or" soft). */
const choices = (t) => String(t || ''); // (as the app wrote it: no splitting on words)
/** A day's notes as one outlined card (an event is filled, a note is outlined), a row each in the household's order.
 *  week: the notes chosen for the week, whole with one or two, each one's short words with more; else all of each. */
const notesEl = (day, kind) => {
  const ns = notesOn(day, kind === 'week'); if (!ns.length) return null;
  return h('div', { class: 'slip' + (kind === 'week' ? '' : ' full ' + kind) }, ns.map((x) => h('div', { class: 'nt', tap: () => openNote(x, day) },
    h('span', { class: 'nl' }, noteLabel(x)),
    h('span', { class: 'nv' }, kind === 'week' ? (ns.length > 2 ? x.short || x.text : x.text) : choices(x.text)))));
};
const appName = (id) => (H?.fromApps || []).find((a) => a.app === id)?.name || id;
/** How an app's things show, changed here at once (the house follows). */
function setShow(app, show) {
  const a = (H.fromApps || []).find((x) => x.app === app); if (a) a.show = show;
  for (const l of Object.values(H.dayNotes || {})) for (const x of l) if (x.app === app) x.show = show;
  house.showFromApp(app, show); draw();
}

/** A note up close: all of it, the day, the app it's from, where that app's notes show, and opening the app. */
function openNote(x, day) {
  const s = openCard((close) => {
    const show = (H.fromApps || []).find((a) => a.app === x.app)?.show ?? x.show, name = x.name || appName(x.app);
    return [
      h('div', { class: 'k' }, noteLabel(x, ' · '), ' · ', fmt(day, { weekday: 'long', month: 'long', day: 'numeric' })),
      h('h2', null, choices(x.text)),
      h('p', { class: 'from' }, `From ${name}`),
      h('div', { class: 'show' }, h('span', { class: 'label' }, 'Show'),
        [['week', 'Week and Today'], ['today', 'Today only'], ['off', 'Nowhere']].map(([k, l]) => chip(l, show === k, () => setShow(x.app, k)))),
      h('div', { class: 'actions' },
        shell.canOpenApps ? btn(`Open ${name}`, () => { close(); shell.openApp(x.app); }, { soft: true }) : null,
        btn('Done', close)),
    ];
  }, { width: 600 });
  s.el.firstChild.classList.add('nsheet');
}

/** The apps that put things on the calendar: how each shows, and their order. */
const SHOWS = [['week', 'Week and Today'], ['today', 'Today only'], ['off', 'Off']];
function fromAppsCard() {
  openCard((close) => {
    const list = H.fromApps || [];
    const move = (i, by) => { const ids = list.map((a) => a.app); const [a] = ids.splice(i, 1); ids.splice(i + by, 0, a); H.fromApps = ids.map((id) => list.find((x) => x.app === id)); house.orderFromApps(ids); draw(); };
    return [
      h('h2', null, 'From apps'),
      h('p', { class: 'line light' }, 'What the household’s apps put on the calendar. Their notes (a school lunch, trash day) show on Today, and on the week if you choose.'),
      ...(list.length ? list : [null]).map((a, i) => a && h('div', { class: 'app-row' },
        h('span', { class: 'app-name' }, a.name),
        h('div', { class: 'chips' }, (a.notes ? SHOWS : [['today', 'On'], ['off', 'Off']]).map(([k, l]) => chip(l, a.notes ? a.show === k : (a.show === 'off') === (k === 'off'), () => setShow(a.app, k)))),
        list.length > 1 ? [round('up', () => move(i, -1), { disabled: i === 0, label: 'Earlier' }), round('down', () => move(i, 1), { disabled: i === list.length - 1, label: 'Later' })] : null) || h('p', { class: 'line light' }, 'None yet.')),
      h('div', { class: 'actions' }, btn('Done', close)),
    ];
  }, { width: 1100 });
}
const barKids = (e, cutL) => [!e.allDay && !cutL ? h('span', { class: 'bt' }, shortTime(e.t0)) : null, h('span', { class: 'bw' }, e.title)];
const repeatLabel = (r) => (r === 'custom' ? 'Repeats' : REPEATS.find(([k]) => k === r)?.[1]); // custom: a rule from Google or iCloud
const dayName = (d, today) => d === today ? 'Today' : d === dayStart(today, 1) ? 'Tomorrow' : null;

const VIEWS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['list', 'List']];

/** A swipe across the calendar steps it, as the arrows do: right for earlier, left for later (day, week and month). Seen
 *  in the capture phase, before a tapped event's own handler; a swipe never taps (press() lets a moved finger go). */
let swipeStep = null;
{
  let sx = 0, sy = 0, st = 0, on = false;
  document.addEventListener('pointerdown', (e) => { on = e.isPrimary && !e.target.closest?.('input, textarea, .sheet'); sx = e.clientX; sy = e.clientY; st = Date.now(); }, true);
  document.addEventListener('pointerup', (e) => {
    if (!on || !swipeStep || sheets.length) return; on = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Date.now() - st > 900 || Math.abs(dx) < Math.max(70, innerWidth * 0.06) || Math.abs(dx) < Math.abs(dy) * 2) return;
    (dx > 0 ? swipeStep.back : swipeStep.on)?.();
  }, true);
  document.addEventListener('pointercancel', () => { on = false; }, true);
}

function screen() {
  if (!H) return h('div');
  const today = dayStart(Date.now()), from = dayStart(today, weeks * DAYS), oneDay = dayStart(today, days), small = narrow();
  const at = view === 'month' ? monthStart(today, months) : view === 'list' ? today : from;
  const [name, rest] = view === 'day' ? [fmt(oneDay, { weekday: small ? 'short' : 'long' }), fmt(oneDay, { month: small ? 'short' : 'long', day: 'numeric' })] : [fmt(at, { month: 'long' }), small ? null : fmt(at, { year: 'numeric' })];
  const set = (f) => () => { f(); draw(); };
  // Stepping: earlier, later and back to today (how far each view goes is the same as ever).
  const step = view === 'day' ? { back: () => days--, noBack: days <= -30, on: () => days++, noOn: days >= 60, home: () => { days = 0; }, away: days !== 0 }
    : view === 'week' ? { back: () => weeks--, noBack: weeks <= -4, on: () => weeks++, noOn: weeks >= 9, home: () => { weeks = 0; }, away: weeks !== 0 }
    : view === 'month' ? { back: () => months--, noBack: months <= -1, on: () => months++, noOn: months >= 2, home: () => { months = 0; }, away: months !== 0 } : null;
  swipeStep = step && !sheets.length ? { back: step.noBack ? null : set(step.back), on: step.noOn ? null : set(step.on) } : null;
  const tools = [round('photo', fromPhoto, { label: 'From a photo of a flyer' }), round('bell', remindersCard, { label: 'Reminders' })];
  const link = (label, tap) => h('button', { class: 'quiet', tap }, label);
  return h('div', { class: 'screen' },
    h('div', { class: 'top' },
      h('h1', { class: 'title' }, name, rest ? [' ', h('span', null, rest)] : null),
      h('div', { class: 'q-seg' }, VIEWS.map(([k, l]) => h('button', { class: view === k ? 'on' : null, 'aria-pressed': String(view === k), tap: set(() => { view = k; }) }, l))),
      step ? [round('left', set(step.back), { disabled: step.noBack, label: 'Earlier' }), small ? null : chip('Today', false, set(step.home)), round('right', set(step.on), { disabled: step.noOn, label: 'Later' })] : null,
      small ? null : tools,
      round('plus', () => guard(() => { const d = view === 'day' ? oneDay : today; eventForm(null, d, startFor(d)); }), { dark: true, label: 'Add' })),
    view === 'month' ? month(monthStart(today, months), today) : view === 'list' ? schedule(today, AGENDA_DAYS, today)
      : view === 'day' ? dayView(oneDay, today) : small ? [strip(from, today, today, openDay), dayList(from, DAYS, today, true)] : weekView(from, today),
    // (a phone has less of a top row: its tools are down here, and Today only once they've stepped away)
    h('div', { class: 'foot' },
      small && step?.away ? chip('Today', false, set(step.home)) : null,
      small ? tools : null,
      onScreen?.kind === 'phone' ? null : H.calendars === 0 ? btn('Add a calendar', addCalendar, { soft: true }) : link('Add a calendar', addCalendar), // (on the display, behind the PIN)
      H.fromApps?.length ? link('From apps', fromAppsCard) : null));
}

/** A calendar by its link: on the display, behind the PIN (the shell keeps the links, sealed). */
function addCalendar() {
  if (!phone.addCalendar()) openCard((close) => [h('h2', null, 'Add a calendar'), h('p', { class: 'line light' }, 'On the display: Add a calendar here, or Settings, Family. From a computer, ask Claude or ChatGPT to add it with the calendar’s link.'), h('div', { class: 'actions' }, btn('OK', close))]);
}

/** The weather: all of it (today's sunrise and sunset), and its days by date ("YYYY-MM-DD" -> {high, low, code, condition, rain}). */
let sky = null, forecast = {};
const loadForecast = () => weather().then((w) => { if (!w?.days) return; sky = w; forecast = Object.fromEntries(w.days.map((d) => [d.date, d])); if (H) draw(); });
const forecastOn = (day) => forecast[house.dayKey(new Date(day))] || null;
const skyMark = (code) => h('span', { class: 'sky', html: skyIcon(code) });
const U = (n) => `calc(${n} * var(--u))`;
/** Is it over? (a day's own things once the day is, the rest once they end) */
const isPast = (e, now) => (e.t1 ?? (e.allDay ? dayStart(e.t0, 1) : e.t0)) <= now;

/** Seven days to step through, one of them chosen (the day view's, and a phone's week). */
const strip = (from, on, today, pick) => h('div', { class: 'strip q-panel' }, [...Array(7)].map((_, i) => {
  const d = dayStart(from, i);
  return h('div', { class: 'sday' + (d === today ? ' today' : '') + (d === on ? ' on' : ''), tap: () => pick(d) }, h('small', null, fmt(d, { weekday: 'short' })), fmt(d, { day: 'numeric' }));
}));

/** The parts of a day the week is laid out in: [name, icon, the hour it ends, how much of the height it gets]. */
const PARTS = [['Morning', 'horizon', 12, 1], ['Afternoon', 'sun', 17, 1], ['Evening', 'moon', 24, 1.25]];
const partOf = (t) => { const hr = new Date(t).getHours(); return PARTS.findIndex(([, , end]) => hr < end); };

/** The week: a column a day, and across the columns the parts of the day. All-day things (and what began before these
 *  days) are bars under the days' names; something at a time that runs over several days is a card across them, in the
 *  part of the day it starts. */
function weekView(from, today) {
  const now = Date.now();
  const timed = (e) => !e.allDay && e.t0 >= from;
  const top = bars(from, DAYS, (e) => !timed(e)), across = PARTS.map((_, k) => bars(from, DAYS, (e) => timed(e) && partOf(e.t0) === k));
  // The grid's rows: the days' names, a row per lane of bars, the apps' notes, then for each part its cards across days and its events.
  const rows = ['auto']; let r = 2;
  const barsAt = r; for (let i = 0; i < Math.max(1, top.lanes); i++, r++) rows.push(`minmax(${U(48)}, auto)`);
  const notesAt = r++; rows.push(`minmax(${U(12)}, auto)`);
  const at = PARTS.map(([, , , fr], k) => { const start = r; for (let i = 0; i < across[k].lanes; i++, r++) rows.push('auto'); rows.push(`minmax(min-content, ${fr}fr)`); return { start, cell: r++ }; });
  const nowPart = partOf(now);
  return h('div', { class: 'week', 'data-keep': 'week', style: `grid-template-rows:${rows.join(' ')}` },
    [...Array(DAYS)].map((_, i) => {
      const day = dayStart(from, i), isToday = day === today, c = `grid-column:${i + 2}`, f = forecastOn(day);
      const list = eventsOn(day).filter((e) => !spans(e)), notes = notesEl(day, 'week'); // the apps' notes (a school lunch): with what holds all day
      return [
        h('div', { class: 'col' + (isToday ? ' today' : ''), style: `${c};grid-row:1 / -1` }),
        h('div', { class: 'dh' + (isToday ? ' today' : ''), style: `${c};grid-row:1`, tap: () => openDay(day) },
          h('div', { class: 'q-label' }, isToday ? 'Today' : fmt(day, { weekday: 'short' })),
          h('div', { class: 'n' }, h('b', null, fmt(day, { day: 'numeric' })), f ? h('span', { class: 'wxm' }, skyMark(f.code), `${f.high}°`) : null)),
        notes ? h('div', { class: 'wcell notes', style: `${c};grid-row:${top.list.some((x) => x.a <= i && x.b >= i) ? notesAt : barsAt} / ${notesAt + 1}` }, notes) : null, // (under the bars that cross this day)
        PARTS.map((_, k) => {
          const mine = list.filter((e) => partOf(e.t0) === k), kids = mine.map((e) => eventChip(e, isPast(e, now)));
          // now, between what's done and what's to come
          if (isToday && k === nowPart) { const next = mine.findIndex((e) => e.t0 > now); kids.splice(next < 0 ? kids.length : next, 0, h('div', { class: 'now' })); }
          // (under a card that crosses this day; else from the top of the part, level with the days beside it)
          const under = across[k].list.some((x) => x.a <= i && x.b >= i);
          return h('div', { class: 'wcell', style: `${c};grid-row:${under ? at[k].cell : at[k].start} / ${at[k].cell + 1}`, tap: (ev) => openDay(day, minuteAt(ev, k)) }, kids);
        }),
      ];
    }),
    h('div', { class: 'bline', style: `grid-row:${barsAt}` }), h('div', { class: 'band', style: `grid-row:${barsAt} / ${notesAt + 1}` }, 'All day'),
    PARTS.map(([name, ic], k) => [h('div', { class: 'bline', style: `grid-row:${at[k].start}` }), h('div', { class: 'band', style: `grid-row:${at[k].start} / ${at[k].cell + 1}` }, icon(ic, 'thin'), name)]),
    top.list.map(({ e, a, b, lane, cutL, cutR }) => h('div', { ...evLook(e, 'wbar' + (cutL ? ' cut-l' : '') + (cutR ? ' cut-r' : ''), isPast(e, now), `grid-column:${a + 2} / ${b + 3};grid-row:${barsAt + lane}`), tap: () => openEvent(e) }, barKids(e, cutL))),
    across.map((p, k) => p.list.map(({ e, a, b, lane, cutR }) => h('div', { ...evLook(e, 'chipv across' + (cutR ? ' cut-r' : ''), isPast(e, now), `grid-column:${a + 2} / ${b + 3};grid-row:${at[k].start + lane}`), tap: () => openEvent(e) },
      h('div', { class: 'when' }, shortTime(e.t0)), h('div', { class: 'what' }, e.title),
      h('div', { class: 'whose' }, [whoText(e), `until ${fmt(e.t1, { weekday: 'long' })}`].filter(Boolean).join(' · '))))));
}

/** How soon: "in 20 minutes", "in 2 hours" ('' when it's far off). */
const inText = (t, now) => { const m = Math.round((t - now) / 60e3), hrs = Math.round(m / 60); return m < 60 ? `in ${m} ${m === 1 ? 'minute' : 'minutes'}` : m < 600 ? `in ${hrs} ${hrs === 1 ? 'hour' : 'hours'}` : ''; };

/** One day: at the left the days to step through, what's next and what holds for the whole day (all-day things, the
 *  apps' notes, the meals, the weather); at the right the day by the hour, with a line at now. */
function dayView(day, today) {
  const now = Date.now(), list = eventsOn(day), all = list.filter((e) => e.allDay), timed = list.filter((e) => !e.allDay);
  const top = dayStart(day) + FIRST_HOUR * 3600e3, end = top + HOURS * 3600e3;
  // Side by side where they overlap: each takes a lane.
  const lanes = [], placed = timed.map((e) => {
    const a = Math.max(e.t0, top), b = Math.min(Math.max(e.t1 ?? e.t0 + 1800e3, a + 1800e3), end);
    let lane = lanes.findIndex((l) => l <= a); if (lane < 0) { lane = lanes.length; lanes.push(0); } lanes[lane] = b;
    return { e, a, b, lane };
  });
  const n = Math.max(1, lanes.length), y = (t) => ((t - top) / 3600e3) * HOUR_U, isNow = day === today && now >= top && now < end;
  // Today's sunset, at its hour beside the events.
  const suns = day === today && !narrow() ? [['Sunset', sky?.sunset]].map(([l, t]) => [l, Date.parse(t)]).filter(([, t]) => t >= top && t < end) : [];
  const side = 96 + (suns.length ? 290 : 20); // what the events leave free: the hours' names, and the marks' column
  const grid = h('div', { class: 'hours q-panel vscroll', 'data-keep': 'hours', role: 'none', tap: () => {} },
    h('div', { class: 'hours-in', style: `height:${U(HOURS * HOUR_U)}` },
      [...Array(HOURS)].map((_, i) => h('div', { class: 'hour', style: `top:${U(i * HOUR_U)};height:${U(HOUR_U)}`,
        tap: () => guard(() => eventForm(null, day, (FIRST_HOUR + i) * 60)) },
        isNow && Math.abs(now - (top + i * 3600e3)) < 20 * 60e3 ? null : h('span', { class: 'hour-label' }, `${(FIRST_HOUR + i) % 12 || 12}${(FIRST_HOUR + i) < 12 ? 'a' : 'p'}`))),
      placed.map(({ e, a, b, lane }) => {
        const tall = Math.max(30, y(b) - y(a) - 6);
        return h('div', { ...evLook(e, 'block' + (tall < 52 ? ' tight' : tall < 84 ? ' snug' : ''), day === today && isPast(e, now),
          `top:${U(y(a) + 3)};height:${U(tall)};left:calc(${U(96)} + (100% - ${U(side)}) * ${lane / n});width:calc((100% - ${U(side)}) / ${n} - ${U(8)})`), tap: () => openEvent(e) },
          h('div', { class: 'block-when' }, [shortSpan(e), whoText(e)].filter(Boolean).join(' · ')), h('div', { class: 'block-what' }, e.title));
      }),
      suns.map(([label, t]) => h('div', { class: 'mark', style: `top:${U(y(t) - 31)}` }, h('div', { class: 'itile' }, icon('horizon', 'thin')), h('div', null, h('small', null, shortTime(t)), label))),
      isNow ? h('div', { class: 'now-line', style: `top:${U(y(now))}` }, h('b', null, timeOf(now).replace(/ [AP]M$/, ''))) : null));
  // Opened on this day: the day from the morning on (today: with now in view), not from midnight.
  if (scrolledTo !== day) requestAnimationFrame(() => { scrolledTo = day; const hr = new Date().getHours(); grid.scrollTop = grid.scrollHeight / HOURS * Math.max(0, (day !== today ? 6.75 : hr < 8 ? hr - 1 : hr >= 19 ? Math.min(hr - 10, 10.25) : 6.75) - FIRST_HOUR); });

  const cur = day === today ? timed.find((e) => (e.t1 ?? e.t0) > now) : null; // what's on now, or next
  const f = forecastOn(day), meals = H.meals?.[house.dayKey(new Date(day))] || {}, slots = (H.mealSlots || []).filter((s) => typeof meals[s] === 'string' && meals[s]);
  const open = (app) => (shell.canOpenApps ? () => shell.openApp(app) : null);
  const row = (tile, label, value, tap = null, soft = false) => h('div', { class: 'irow', tap }, tile, h('div', null, h('div', { class: 'q-label' }, label), h('b', { class: soft ? 'soft' : null }, value)));
  const tile = (...kids) => h('div', { class: 'itile' }, kids);
  const rows = [
    all.map((e) => row(h('div', { class: 'itile q-letter', style: people(e).length ? `--c:${house.color(people(e)[0])}` : calTone(e) ? `--c:${calTone(e)}` : null }, e.title.trim().charAt(0).toUpperCase()), ['All day', whoText(e)].filter(Boolean).join(' · '), e.title, () => openEvent(e))),
    notesOn(day).map((x) => row(x.pics?.[0]?.image ? tile(h('img', { class: 'q-photo', src: x.pics[0].image, alt: '' })) : tile(icon('note', 'thin')), noteLabel(x), choices(x.text), () => openNote(x, day))),
    slots.map((s) => row(tile(icon('fork', 'thin')), s.charAt(0).toUpperCase() + s.slice(1), meals[s], open('meals'))),
    !slots.length && day >= today && (H.mealSlots || []).includes('dinner') ? row(tile(icon('fork', 'thin')), 'Dinner', 'Not planned yet', open('meals'), true) : null,
    f ? row(tile(skyMark(f.code)), f.rain >= 40 ? `Weather · ${f.rain}% rain` : 'Weather', `${f.condition ? f.condition + ', ' : ''}${f.high}° / ${f.low}°`, open('weather')) : null,
  ].flat().filter(Boolean);
  return h('div', { class: 'dayview' },
    h('div', { class: 'dleft' },
      strip(dayStart(today, Math.floor(days / 7) * 7), day, today, (d) => { days = Math.round((d - today) / 86400000); draw(); }),
      cur ? h('div', { class: 'nextc', tap: () => openEvent(cur) },
        h('div', { class: 'q-label' }, cur.t0 <= now ? 'Now' : ['Next', inText(cur.t0, now)].filter(Boolean).join(' · ')),
        h('h2', null, cur.title),
        h('div', { class: 'when' }, marks(cur, ''), [shortTime(cur.t0), whoText(cur), cur.place].filter(Boolean).join(' · '))) : null,
      rows.length ? h('div', { class: 'info q-panel', 'data-keep': 'info' }, rows) : null),
    grid);
}

function eventChip(e, past) {
  return h('div', { ...evLook(e, 'chipv', past), tap: () => openEvent(e) },
    h('div', { class: 'when' }, e.allDay ? 'All day' : shortTime(e.t0)),
    h('div', { class: 'what' }, e.title),
    whoText(e) ? h('div', { class: 'whose' }, whoText(e)) : null,
    e.fromApp ? h('div', { class: 'src' }, e.appName || appName(e.fromApp)) : null);
}

/** The month as a grid, a few events per day in their person's color, multi-day ones as one bar; tap a day for all of it. */
function month(first, today) {
  const start = weekStart(first), m = new Date(first).getMonth();
  const last = dayStart(monthStart(first, 1), -1);
  const rows = Math.min(6, Math.max(4, Math.floor(Math.round((last - start) / 86400000) / 7) + 1));
  // A chip: the time, short (the hour's "a" or "p" only where there are no minutes to tell it by), then the name.
  const hour = (t) => { const s = shortTime(t); return s.includes(':') ? s.slice(0, -1) : s; };
  const mev = (e, cls, past, style, tap, cutL = false) => h('div', { ...evLook(e, 'mev' + cls, past, style), tap }, !e.allDay && !cutL ? h('span', null, hour(e.t0)) : null, h('em', null, e.title));
  return h('div', { class: 'month' },
    h('div', { class: 'mhead' }, [...Array(7)].map((_, i) => h('div', { class: 'mdow q-label' }, fmt(dayStart(start, i), { weekday: 'short' })))),
    [...Array(rows)].map((_, r) => {
      const wk = dayStart(start, r * 7), { list, lanes } = bars(wk, 7), thisWeek = today >= wk && today < dayStart(wk, 7);
      const room = (rows > 4 ? 2 : 3) + (thisWeek && !narrow() ? 1 : 0); // things a day shows, bars included (this week's row is the tall one)
      const shown = list.filter((x) => x.lane < room);
      return h('div', { class: 'mweek' + (thisWeek ? ' this' : ''), style: `grid-template-rows:auto ${Math.min(lanes, room) ? `repeat(${Math.min(lanes, room)}, auto) ` : ''}minmax(0, 1fr)` },
        [...Array(7)].map((_, i) => {
          const day = dayStart(wk, i), inMonth = new Date(day).getMonth() === m, isToday = day === today, date = new Date(day).getDate();
          const all = eventsOn(day), rest = all.filter((e) => !spans(e)), over = shown.filter((x) => x.a <= i && x.b >= i);
          // Its own events start under the lowest bar that crosses it (a day no bar crosses starts at the top).
          const depth = Math.max(0, ...over.map((x) => x.lane + 1));
          // What doesn't fit is counted on the last line, in place of the last chip.
          let take = rest.slice(0, Math.max(0, room - depth)), hidden = all.length - take.length - over.length;
          if (hidden > 0 && take.length) { take = take.slice(0, -1); hidden++; }
          return [
            h('div', { class: 'cell' + (isToday ? ' today' : inMonth ? '' : ' out'), style: `grid-column:${i + 1};grid-row:1 / -1`, tap: () => openDay(day) }),
            h('div', { class: 'mnum' + (isToday ? ' today' : !inMonth ? ' out' : day < today ? ' past' : ''), style: `grid-column:${i + 1};grid-row:1`, tap: () => openDay(day) },
              h('b', null, date), isToday ? h('small', { class: 'q-label' }, 'Today') : date === 1 ? h('small', { class: 'q-label' }, fmt(day, { month: 'short' })) : null),
            h('div', { class: 'cell-rest', style: `grid-column:${i + 1};grid-row:${2 + depth} / -1`, tap: () => openDay(day) },
              take.map((e) => mev(e, '', day < today)),
              hidden > 0 ? h('div', { class: 'more' }, `+${hidden} more`) : null),
          ];
        }),
        shown.map(({ e, a, b, lane, cutL, cutR }) => mev(e, ' mbar' + (cutL ? ' cut-l' : '') + (cutR ? ' cut-r' : ''), (e.t1 ?? dayStart(e.t0, 1)) <= today,
          `grid-column:${a + 1} / ${b + 2};grid-row:${2 + lane}`, () => openEvent(e), cutL)));
    }));
}

/** An event as a row, in its person's color: when, what, and whose (their marks). */
function eventRow(e, past = false) {
  return h('div', { ...evLook(e, 'erow', past), tap: () => openEvent(e) },
    h('span', { class: 'when' }, e.allDay ? 'All day' : shortTime(e.t0)),
    h('span', { class: 'what' }, e.title),
    marks(e));
}

/** The days from `first` as a list, the ones with something on them: the day's name and weather, its events as rows,
 *  the apps' notes. done: keep what's over today, faded (a week), or leave it out (what's coming up). */
function dayList(first, n, today, done) {
  const now = Date.now(), out = [];
  for (let i = 0; i < n; i++) {
    const day = dayStart(first, i);
    const list = eventsOn(day).filter((e) => done || e.allDay || (e.t1 ?? e.t0) >= now || day > today);
    if (!list.length && !notesOn(day).length) continue;
    const f = forecastOn(day), near = dayName(day, today);
    out.push(h('h2', { class: 'dl', tap: () => openDay(day) }, near || fmt(day, { weekday: 'long' }),
        h('span', null, [near ? null : fmt(day, { month: 'short', day: 'numeric' }), f ? `${f.condition ? f.condition.toLowerCase() + ', ' : ''}${f.high}°` : null].filter(Boolean).join(' · '))),
      list.map((e) => eventRow(e, isPast(e, now))),
      notesEl(day, 'list'));
  }
  return h('div', { class: 'agenda', 'data-keep': 'agenda' }, out.length ? out : h('p', { class: 'nothing' }, done ? 'Nothing these days' : 'Nothing coming up'));
}

/** The List view, as a schedule: each day with something on it is a row, its weekday and date in a column on the left
 *  (the weather under them), and its things on the right: all-day ones as slim pills, then each event as a soft block
 *  tinted with its person's color, the title over its time. Today's date in the accent. */
/** Which day of an all-day thing over several days this is: " (Day 2/3)", else ''. */
const dayOfSpan = (e, day) => { if (!e.t1) return ''; const n = Math.round((dayStart(e.t1) - dayStart(e.t0)) / 864e5); return n > 1 ? ` (Day ${Math.round((day - dayStart(e.t0)) / 864e5) + 1}/${n})` : ''; };
const tint = (e) => { const c = people(e).map((n) => house.color(n))[0] || calTone(e); return c ? `color-mix(in srgb, ${c} 24%, var(--card))` : null; };
function schedule(first, n, today) {
  const now = Date.now(), out = [];
  for (let i = 0; i < n; i++) {
    const day = dayStart(first, i);
    const list = eventsOn(day).filter((e) => e.allDay || (e.t1 ?? e.t0) >= now || day > today);
    if (!list.length && !notesOn(day).length) continue;
    const f = forecastOn(day), d = new Date(day);
    out.push(h('div', { class: 'sch-day' + (day === today ? ' today' : '') },
      h('div', { class: 'sch-date', tap: () => openDay(day) },
        h('small', null, fmt(day, { weekday: 'short' })), h('b', null, String(d.getDate())), f ? h('span', null, `${f.high}°`) : null),
      h('div', { class: 'sch-things' },
        list.filter((e) => e.allDay).map((e) => h('div', { class: 'sch-pill' + (isPast(e, now) ? ' past' : ''), style: tint(e) ? `background:${tint(e)}` : null, tap: () => openEvent(e) }, e.title + dayOfSpan(e, day))),
        list.filter((e) => !e.allDay).map((e) => h('div', { class: 'sch-ev' + (isPast(e, now) ? ' past' : ''), style: tint(e) ? `background:${tint(e)}` : null, tap: () => openEvent(e) },
          h('b', null, e.title), h('span', null, timeOf(e.t0) + (e.t1 ? ' – ' + timeOf(e.t1) : '')))),
        notesEl(day, 'list'))));
  }
  return h('div', { class: 'agenda schedule', 'data-keep': 'agenda' }, out.length ? out : h('p', { class: 'nothing' }, 'Nothing coming up'));
}

/** One day up close: everything on it, and adding to it. */
/** A new event's start when nothing was tapped at a time: today, the next half hour (if the day isn't nearly over);
 *  another day, 9 AM. It lasts an hour (eventForm). All day is still one tap away. */
function startFor(day) {
  const now = new Date(), today = dayStart(Date.now());
  if (day !== today) return 9 * 60;
  const m = now.getHours() * 60 + now.getMinutes(), next = Math.ceil((m + 1) / 30) * 30;
  return next <= 22 * 60 ? next : 9 * 60;
}
/** Where a tap in one of the week's parts (morning, afternoon, evening) fell, as a start: its share of the part's hours
 *  (6 to 12, 12 to 5, 5 to 10), to the half hour. */
const PART_HOURS = [[6, 12], [12, 17], [17, 22]];
function minuteAt(ev, k) {
  const r = ev?.currentTarget?.getBoundingClientRect?.() || ev?.target?.closest?.('.wcell')?.getBoundingClientRect?.();
  const [a, b] = PART_HOURS[k] || [9, 10];
  if (!r || !r.height || ev?.clientY == null) return a * 60;
  const f = Math.min(0.999, Math.max(0, (ev.clientY - r.top) / r.height));
  return Math.floor((a + f * (b - a)) * 2) * 30;
}
function openDay(day, min = null) {
  openCard((close) => {
    const today = dayStart(Date.now()), list = eventsOn(day);
    return [
      h('div', { class: 'card-top' },
        h('h2', { class: 'day-name' }, dayName(day, today) || fmt(day, { weekday: 'long' }), ' ',
          // The hour-by-hour view is a quiet link here, not a third button (docs/ux.md).
          h('button', { class: 'by-hour', onclick: () => { close(); view = 'day'; days = Math.round((day - today) / 86400000); draw(); } }, `${fmt(day, { month: 'long', day: 'numeric' })} · by the hour`))),
      h('div', { class: 'vscroll day-rows', 'data-keep': 'day' }, list.length ? list.map((e) => eventRow(e)) : h('p', { class: 'nothing small' }, 'Nothing yet')),
      h('div', { class: 'actions' }, btn('Close', close, { soft: true }), btn('Add', () => { close(); eventForm(null, day, min ?? startFor(day)); })),
    ];
  }, { width: 860 });
}

function openEvent(e) {
  const remove = (date = null) => {
    events = events.filter((x) => x.id !== e.id || (date && x.date !== date)); draw(); house.removeEvent(e.id, date);
  };
  const mine = (e.local || e.editable) && e.id; // added here, or in a two-way calendar: it can be changed; other synced ones change where they come from
  let counting = !!e.countdown;
  const later = e.t0 > Date.now() && (mine || e.uid);
  openCard((close) => [
    h('div', { class: 'ev-title' }, marks(e, 'lg'), h('h2', { class: 'big' }, e.title)),
    h('p', { class: 'line' }, fmt(e.t0, { weekday: 'long', month: 'long', day: 'numeric' }) + (e.allDay ? '' : ' · ' + timeOf(e.t0) + (e.t1 ? ' – ' + timeOf(e.t1) : ''))),
    e.repeat ? h('p', { class: 'line' }, repeatLabel(e.repeat) + (e.until ? `, until ${fmt(Date.parse(e.until + 'T12:00'), { month: 'long', day: 'numeric' })}` : '')) : null,
    e.place ? h('p', { class: 'line light' }, e.place) : null,
    whoText(e) ? h('p', { class: 'line ink' }, whoText(e)) : null,
    e.notes ? h('p', { class: 'line notes' }, e.notes) : null,
    e.note ? h('p', { class: 'line light small' }, e.note) : null, // changed on its calendar before a change here went in
    e.editable && e.calendarName ? h('p', { class: 'line light small' }, `On ${e.calendarName}${e.sending ? ' · sending' : ''}`) : null,
    e.fromApp ? h('p', { class: 'line light small' }, `From ${e.appName || appName(e.fromApp)}`) // one of the household's apps put it here (read-only)
      : !mine ? h('p', { class: 'line light small' }, `From ${e.who ? e.who + '’s' : 'a'} calendar: change it there.`) : null,
    e.t0 > Date.now() && (mine || e.uid) ? h('div', { class: 'chips' }, chip(counting ? 'Counting down on the home screen' : 'Count down to it', counting, () => {
      guard(() => { counting = !counting; e.countdown = counting; house.countdown(e.local ? { id: e.id } : { uid: e.uid }, counting); sheets.at(-1)?.redraw(); });
    })) : null,
    later && !e.allDay ? h('div', { class: 'row' }, h('span', { class: 'label' }, 'Remind'),
      remindChips(e.remind ?? null, (m) => guard(() => { e.remind = m; house.remind(e.local ? { id: e.id } : { uid: e.uid }, m); sheets.at(-1)?.redraw(); }))) : null,
    h('div', { class: 'actions' },
      mine ? (e.repeat
        ? [btn('Remove this day', () => { close(); guard(() => remove(e.date || house.dayKey(new Date(e.t0)))); }, { soft: true }), btn('Remove all', () => { close(); guard(() => remove()); }, { soft: true })]
        : btn('Remove', () => { close(); guard(() => remove()); }, { soft: true })) : null,
      mine ? btn('Change', () => { close(); guard(() => eventForm(e)); }, { soft: true }) : null,
      e.fromApp && shell.canOpenApps ? btn(`Open ${e.appName || appName(e.fromApp)}`, () => { close(); shell.openApp(e.fromApp); }, { soft: true }) : null,
      btn('Close', close)),
  ], { width: 940 });
}

/** Reminders to pick from: minutes before (null: the household's usual, -1: none). */
const REMINDS = [[-1, 'None'], [0, 'At the start'], [5, '5 min'], [10, '10 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour']];
const remindLabel = (m) => m == null || m < 0 ? 'none' : m === 0 ? 'at the start' : m === 60 ? '1 hour before' : `${m} min before`;
/** An event's reminder chips: its own, or the usual one (what every event gets, set by the bell at the top). */
const remindChips = (cur, set) => H?.remind == null
  ? h('div', { class: 'chips' }, REMINDS.map(([m, l]) => chip(l, m < 0 ? cur == null || cur < 0 : cur === m, () => set(m < 0 ? null : m))))
  : h('div', { class: 'chips' }, chip(`Usual (${remindLabel(H.remind)})`, cur == null, () => set(null)), REMINDS.map(([m, l]) => chip(l, cur === m, () => set(m))));

/** The reminder every event gets, and whether the display says them out loud too. */
function remindersCard() {
  openCard((close) => {
    const set = (f) => { f(); sheets.at(-1)?.redraw(); };
    return [
      h('h2', null, 'Reminders'),
      h('p', { class: 'line light' }, 'Before each event with a time, the display shows it and chimes ("Swim in 15 minutes"). Not at night.'),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Every event'),
        h('div', { class: 'chips' }, REMINDS.map(([m, l]) => chip(l, (H.remind ?? -1) === m, () => set(() => { H.remind = m < 0 ? null : m; house.setReminders({ remind: H.remind }); }))))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, ''),
        h('div', { class: 'chips' }, chip('Say them out loud too', !!H.remindAloud, () => set(() => { H.remindAloud = !H.remindAloud; house.setReminders({ aloud: H.remindAloud }); })))),
      h('p', { class: 'line light small' }, 'An event can have its own: tap it, or set it when adding it.'),
      h('div', { class: 'actions' }, btn('Done', close)),
    ];
  }, { width: 1040 });
}

/** With the calendar locked (Settings, PIN Lock), changes wait for the PIN on the display:
 *  then they're open for a couple of minutes. [fn] runs at once when open, else once the PIN is given. */
let afterPin = null, afterPinAt = 0;
const unlocked = () => !H?.calendarLock || H.unlockedUntil > Date.now();
function guard(fn) {
  if (unlocked()) return fn();
  afterPin = fn; afterPinAt = Date.now();
  if (!phone.unlock()) { afterPin = null; openCard((close) => [h('h2', null, 'The calendar is locked'), h('p', { class: 'line light' }, 'Enter the PIN on the display.'), h('div', { class: 'actions' }, btn('OK', close))]); }
}

/** A flyer, school notice or invitation, photographed on a phone: the assistant reads its events, and they're added
 *  only once someone says which (the card below). */
function fromPhoto() {
  if (!H?.ai) return openCard((close) => [h('h2', null, 'A flyer to the calendar'), h('p', { class: 'line light' }, 'Reading a flyer needs the assistant, and it isn’t set up on this display.'), h('div', { class: 'actions' }, btn('OK', close))]);
  if (!phone.flyer()) openCard((close) => [h('h2', null, 'A flyer to the calendar'), h('p', { class: 'line light' }, 'This works on the display itself: a phone sends it the photo.'), h('div', { class: 'actions' }, btn('OK', close))]);
}
let flyerShown = null, flyerCard = null, flyerPick = null; // flyerPick: which of its events are ticked, and whose
function showFlyer() {
  const f = H?.flyer, key = f ? `${f.at}|${f.state}` : null;
  if (!f) { flyerCard?.close(); flyerCard = null; flyerShown = null; return; }
  if (key === flyerShown) return;
  flyerShown = key; flyerCard?.close();
  if (f.state === 'done') flyerPick = { on: new Set((f.events || []).map((_, i) => i)), who: null };
  const done = (close) => { close(); flyerCard = null; house.flyerDone(); };
  flyerCard = openCard((close) => {
    const g = H?.flyer;
    if (!g) return [];
    if (g.state === 'working') return [h('h2', null, 'Reading the flyer…'), h('p', { class: 'line light' }, 'The assistant is finding its dates. This takes a moment; you can close this.'),
      h('div', { class: 'actions' }, btn('Close', () => { close(); flyerCard = null; }, { soft: true }))];
    if (g.state === 'error') return [h('h2', null, 'Couldn’t read the flyer'), h('p', { class: 'line light' }, g.text || 'Try another photo, closer and straight on.'), h('div', { class: 'actions' }, btn('OK', () => done(close)))];
    const evs = g.events || [];
    if (!evs.length) return [h('h2', null, 'No dates on that flyer'), h('p', { class: 'line light' }, 'The assistant didn’t find any events in it. A closer photo, straight on, may help.'), h('div', { class: 'actions' }, btn('OK', () => done(close)))];
    const redraw = () => sheets.at(-1)?.redraw();
    const when = (e) => { const t = Date.parse(e.allDay ? e.start + 'T12:00' : e.start); return fmt(t, { weekday: 'short', month: 'short', day: 'numeric' }) + (e.allDay ? '' : ' · ' + timeOf(t) + (e.end ? ' – ' + timeOf(Date.parse(e.end)) : '')); };
    const n = flyerPick.on.size;
    return [
      h('h2', null, evs.length === 1 ? 'Add this from the flyer?' : 'Add these from the flyer?'),
      h('div', { class: 'flyer-list' }, evs.map((e, i) => h('button', { class: 'flyer-ev' + (flyerPick.on.has(i) ? ' on' : ''), tap: () => { flyerPick.on.has(i) ? flyerPick.on.delete(i) : flyerPick.on.add(i); redraw(); } },
        h('span', { class: 'q-check' + (flyerPick.on.has(i) ? ' on' : '') }, icon('check')),
        h('span', { class: 'fwhat' }, h('b', null, e.title), h('span', null, [when(e), e.place].filter(Boolean).join(' · ')), e.notes ? h('span', { class: 'n' }, e.notes) : null)))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Whose'), h('div', { class: 'chips' }, chip('Everyone', flyerPick.who == null, () => { flyerPick.who = null; redraw(); }),
        (H.family || []).map((p) => who(p.name, same(flyerPick.who, p.name), () => { flyerPick.who = p.name; redraw(); })))),
      h('div', { class: 'actions' }, btn('Not now', () => done(close), { soft: true }),
        btn(n === 0 ? 'Add' : n === 1 ? 'Add 1' : `Add ${n}`, () => guard(() => {
          for (const i of [...flyerPick.on].sort()) {
            const e = evs[i], t0 = Date.parse(e.allDay ? e.start + 'T00:00' : e.start), t1 = e.end ? Date.parse(e.end) : null;
            house.addEvent({ title: e.title, start: t0, end: !e.allDay && t1 > t0 ? t1 : null, allDay: !!e.allDay, who: flyerPick.who, place: e.place || '', notes: e.notes || '' });
          }
          done(close);
        }), { disabled: n === 0 })),
    ];
  }, { width: 940, onOutside: (close) => { close(); flyerCard = null; } });
}

/** Lengths to pick from, in minutes (0: all day). */
const LENGTHS = [[0, 'All day'], [15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']];
/** "Until" for a repeating event, from its start: [days, label]; null: always. */
const UNTILS = [[null, 'Always'], [28, '4 weeks'], [91, '3 months'], [182, '6 months'], ['june', 'End of the school year'], ['dec', 'End of the year']];

/** Add an event (e: null) or change one added here: what, which day, the time and how long, where, notes, whose,
 *  whether it repeats and until when, and a countdown. One card, all of it in reach without a keyboard but the words. */
function eventForm(e = null, startDay = null, startMin = null) {
  const today = dayStart(Date.now());
  const was = e ? { day: dayStart(e.t0), min: e.allDay ? -1 : new Date(e.t0).getHours() * 60 + new Date(e.t0).getMinutes(), len: e.allDay ? 0 : Math.round(((e.t1 ?? e.t0 + 3600e3) - e.t0) / 60000) } : null;
  const f = {
    title: e?.title || '', day: was?.day ?? startDay ?? today, min: was ? was.min : startMin ?? -1, len: was ? was.len : startMin != null ? 60 : 0,
    people: e ? people(e) : [], calendar: null, repeat: e?.repeat ?? null, until: e?.until ?? null, place: e?.place || '', notes: e?.notes || '', countdown: !!e?.countdown, remind: e?.remind ?? null,
  };
  if (f.min < 0) f.len = 0;
  let week = 0, shown = false; // week: which week of days the day chips show (0: the one with f.day)
  const input = (val, hint, set, cls = '') => {
    const i = h('input', { class: 'field ' + cls, placeholder: hint, enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
    i.value = val; i.addEventListener('input', () => { set(i.value); save.disabled = !f.title.trim(); });
    i.addEventListener('keydown', (k) => { if (k.key === 'Enter') { k.preventDefault(); i.blur(); } });
    return i;
  };
  const save = btn(e ? 'Save' : 'Add', null, { disabled: !f.title.trim() });
  const titleIn = input(f.title, 'Soccer practice', (v) => { f.title = v; }, 'big-field');
  const placeIn = input(f.place, 'Where (optional)', (v) => { f.place = v; });
  const notesIn = input(f.notes, 'Notes: what to bring, who drives (optional)', (v) => { f.notes = v; });
  const more = h('div', { class: 'extra' });
  let s;
  const untilDay = (u) => {
    if (u == null) return null;
    const d = new Date(f.day);
    if (u === 'june') { const y = d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear(); return `${y}-06-15`; }
    if (u === 'dec') return `${d.getFullYear()}-12-31`;
    return house.dayKey(new Date(dayStart(f.day, u)));
  };
  // Where a new event goes: picked, else the first person's own two-way calendar, else the household's (bridge: targetFor).
  const targets = H?.calendarTargets || [];
  const goesTo = () => f.calendar || targets.find((t) => t.who && same(t.who, f.people[0]))?.key || targets.find((t) => t.default)?.key || 'here';
  const finish = () => {
    if (!f.title.trim()) return;
    const d = new Date(f.day); const allDay = f.len === 0 || f.min < 0;
    if (!allDay) d.setHours(Math.floor(f.min / 60), f.min % 60, 0, 0);
    const start = d.getTime(), end = allDay ? null : start + f.len * 60000;
    const fields = { title: f.title.trim(), start, end, allDay, who: f.people[0] || null, also: f.people.slice(1), repeat: f.repeat, until: f.repeat ? f.until : null, place: f.place.trim(), notes: f.notes.trim(), countdown: f.countdown, remind: allDay ? null : f.remind };
    s.close();
    if (e) { Object.assign(e, { ...fields, t0: start, t1: allDay ? dayStart(start, 1) : end }); draw(); house.updateEvent(e.id, { ...fields, repeat: f.repeat || 'none', ...(e.date ? { date: e.date } : {}) }); }
    else { events.push({ id: null, ...fields, start: d.toISOString(), t0: start, t1: allDay ? dayStart(start, 1) : end, local: true }); draw(); house.addEvent({ ...fields, calendar: goesTo() }); }
  };
  press(save, () => { if (!save.disabled) finish(); });
  const cancel = btn('Cancel', () => s.close(), { soft: true });
  const card = h('div', { class: 'sheet form', style: 'width:calc(1040 * var(--u))', tap: () => {} },
    h('h2', null, e ? 'Change the event' : 'New event'), titleIn, more, h('div', { class: 'two' }, placeIn, notesIn), h('div', { class: 'actions' }, cancel, save));
  const scrim = h('div', { class: 'scrim high', tap: () => s.close() }, card);
  s = openSheet(scrim, () => keepScroll(more, () => {
    const pick = (fn) => () => { fn(); s.redraw(); };
    const from = dayStart(weekStart(f.day), week * 7);
    const label = (n) => { const hr = Math.floor(n / 60), m = n % 60; return `${hr % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${hr < 12 ? 'AM' : 'PM'}`; };
    more.replaceChildren(...[
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Day'), round('left', pick(() => { week--; }), { label: 'Earlier' }),
        h('div', { class: 'chips' }, [...Array(7)].map((_, i) => { const d = dayStart(from, i); return chip((d === today ? 'Today' : fmt(d, { weekday: 'short' })) + ' ' + fmt(d, { day: 'numeric' }), d === f.day, pick(() => { f.day = d; })); })),
        round('right', pick(() => { week++; }), { label: 'Later' }), h('span', { class: 'label soft' }, fmt(from, { month: 'short' }))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Time'),
        h('div', { class: 'chips', 'data-keep': 'time' }, chip('All day', f.min < 0, pick(() => { f.min = -1; f.len = 0; })),
          [...Array(18 * 4)].map((_, i) => { const n = 5 * 60 + i * 15; // 5 AM to 10:45 PM, every quarter hour
            return chip(label(n), f.min === n, pick(() => { f.min = n; if (!f.len) f.len = 60; })); }))),
      f.min >= 0 ? h('div', { class: 'row' }, h('span', { class: 'label' }, 'For'),
        h('div', { class: 'chips' }, LENGTHS.filter(([m]) => m).map(([m, l]) => chip(l, f.len === m, pick(() => { f.len = m; }))),
          h('span', { class: 'label soft' }, `until ${label((f.min + f.len) % 1440)}`))) : null,
      H.family?.length ? h('div', { class: 'row' }, h('span', { class: 'label' }, 'Whose'),
        h('div', { class: 'chips' }, chip('Everyone', !f.people.length, pick(() => { f.people = []; })),
          H.family.map((p) => who(p.name, f.people.some((n) => same(n, p.name)), pick(() => { f.people = f.people.some((n) => same(n, p.name)) ? f.people.filter((n) => !same(n, p.name)) : [...f.people, p.name]; }))))) : null,
      !e && targets.length ? h('div', { class: 'row' }, h('span', { class: 'label' }, 'Calendar'),
        h('div', { class: 'chips' }, targets.map((t) => chip(t.name, goesTo() === t.key, pick(() => { f.calendar = t.key; }))), chip('This display only', goesTo() === 'here', pick(() => { f.calendar = 'here'; })))) : null,
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Repeats'),
        h('div', { class: 'chips' }, REPEATS.map(([r, l]) => chip(l, f.repeat === r, pick(() => { f.repeat = r; if (!r) f.until = null; }))))),
      f.repeat ? h('div', { class: 'row' }, h('span', { class: 'label' }, 'Until'),
        h('div', { class: 'chips' }, UNTILS.map(([u, l]) => chip(l, f.until === untilDay(u), pick(() => { f.until = untilDay(u); }))))) : null,
      f.min >= 0 ? h('div', { class: 'row' }, h('span', { class: 'label' }, 'Remind'), remindChips(f.remind, (m) => { f.remind = m; s.redraw(); })) : null,
      h('div', { class: 'row' }, h('span', { class: 'label' }, ''), h('div', { class: 'chips' }, chip('Count down to it on the home screen', f.countdown, pick(() => { f.countdown = !f.countdown; })))),
    ].filter(Boolean));
    // The chosen time in view (it may be 4 PM, past the edge of the row) the first time the card draws.
    if (!shown) { shown = true; requestAnimationFrame(() => more.querySelector('[data-keep="time"] .chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' })); }
  }));
  if (!e) requestAnimationFrame(() => titleIn.focus());
  return s;
}

// Opened from Today's "+ Add" (add=<when> in its address, just now): the new-event card, once.
let addAsked = Number(new URLSearchParams(location.hash.slice(1)).get('add')) || 0;
house.subscribe((d) => {
  H = d;
  if (addAsked) { const fresh = Date.now() - addAsked < 15e3; addAsked = 0; if (fresh) setTimeout(() => { const d = dayStart(Date.now()); eventForm(null, d, startFor(d)); }, 0); }
  events = (d.events || []).map((e) => ({ ...e, t0: Date.parse(e.start), t1: e.end ? Date.parse(e.end) : null })).filter((e) => !isNaN(e.t0));
  draw(); showFlyer();
  if (afterPin && H.unlockedUntil > Date.now()) { const fn = afterPin; afterPin = null; if (Date.now() - afterPinAt < 120e3) fn(); } // the PIN was just given (not long after asking)
});
loadForecast(); setInterval(loadForecast, 30 * 60e3);
