// Calendar: the week in columns, the whole month, or everything coming up as a list, each person in their color. Tap a day
// to see all of it and add to it. Events come from the family's synced calendars (added in Settings) plus ones added here,
// which can repeat and stay on this display (synced calendars are read-only here). The events live in the bridge, not here.
import { house, timer, say, phone, shell, weather, screen as onScreen } from '/kit/openhouse.js';

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
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0111 0v5.5l1.5 1.5h-14z"/><path d="M10 20.5a2 2 0 004 0"/>' };
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
/** A color with some see-through: alpha('#e9b949', .32). */
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Everyone an event is for: its person and whoever else it's for (also). */
// Whose it is, by the family's own names only: a synced calendar's name ("Family") on every event says nothing.
const isPerson = (n) => (H?.family || []).some((p) => p.name.toLowerCase() === String(n).toLowerCase());
const people = (e) => [e.who, ...(e.also || [])].filter((n) => n && isPerson(n));
const whoText = (e) => people(e).join(' & ');
/** An event's colour: its person's; for two or more, their colours side by side. */
/** An event's background: its person's color, or stripes of each person's color when it's for several. */
const paint = (e, a) => { const cs = people(e).map((n) => alpha(house.color(n), a)); return cs.length > 1 ? `repeating-linear-gradient(135deg, ${cs.map((c, i) => `${c} calc(${i * 9} * var(--u)) calc(${(i + 1) * 9} * var(--u))`).join(', ')})` : alpha(house.color(e.who), a); };
const dotPaint = (e) => { const cs = people(e).map((n) => house.color(n)); return cs.length > 1 ? `linear-gradient(135deg, ${cs.map((c, i) => `${c} ${i * 100 / cs.length}% ${(i + 1) * 100 / cs.length}%`).join(', ')})` : house.color(e.who); };
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
const START_VIEW = matchMedia('(max-width: 700px)').matches ? 'list' : 'week'; // (a phone: the list, docs/phones.md)
const REPEATS = [[null, 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'], ['yearly', 'Every year']];

let H = null, events = [], view = START_VIEW, weeks = 0, months = 0, days = 0;
/** The day view's hours (it scrolls to now; earlier and later are a scroll away). */
const FIRST_HOUR = 0, HOURS = 24, HOUR_U = 64;
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
const timeOf = (t) => { const d = new Date(t), hr = d.getHours(), m = d.getMinutes(); return `${hr % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${hr < 12 ? 'AM' : 'PM'}`; };
const onDay = (e, day) => e.t0 < dayStart(day, 1) && (e.t1 ?? e.t0 + 1) > day && !(e.allDay && (e.t1 ?? 0) <= day);
const eventsOn = (day) => events.filter((e) => onDay(e, day)).sort((a, b) => (b.allDay - a.allDay) || a.t0 - b.t0);
/** All day, or running past midnight into another day: shown as one bar across its days (week and month). */
const spans = (e) => e.allDay || (e.t1 != null && dayStart(e.t1 - 1) > dayStart(e.t0));
/** The bars for the days from `first`, `n` of them: each spanning event once, packed into lanes (rows) so none overlap.
 *  a, b: its first and last column; cutL/cutR: it goes on before or after these days. */
function bars(first, n) {
  const last = dayStart(first, n);
  const list = events.filter((e) => spans(e) && e.t0 < last && (e.t1 ?? e.t0 + 1) > first)
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
const barKids = (e, cutL) => [!e.allDay && !cutL ? h('span', { class: 'bt' }, timeOf(e.t0)) : null, h('span', { class: 'bw' }, e.title)];
const repeatLabel = (r) => REPEATS.find(([k]) => k === r)?.[1];
const dayName = (d, today) => d === today ? 'Today' : d === dayStart(today, 1) ? 'Tomorrow' : null;

function screen() {
  if (!H) return h('div');
  const today = dayStart(Date.now()), from = dayStart(today, weeks * DAYS);
  const oneDay = dayStart(today, days);
  const title = view === 'month' ? fmt(monthStart(today, months), { month: 'long', year: 'numeric' }) : view === 'day' ? (dayName(oneDay, today) || fmt(oneDay, { weekday: 'long' })) + ' ' + fmt(oneDay, { month: 'long', day: 'numeric' }) : fmt(view === 'list' ? today : from, { month: 'long' });
  const set = (f) => () => { f(); draw(); };
  return h('div', { class: 'screen' },
    h('div', { class: 'top' },
      h('h1', { class: 'title' }, title),
      chip('Day', view === 'day', set(() => { view = 'day'; })),
      chip('Week', view === 'week', set(() => { view = 'week'; })),
      chip('Month', view === 'month', set(() => { view = 'month'; })),
      chip('List', view === 'list', set(() => { view = 'list'; })),
      view === 'day' ? [round('left', set(() => days--), { disabled: days <= -30, label: 'Earlier' }), days !== 0 ? chip('Today', false, set(() => { days = 0; })) : null, round('right', set(() => days++), { disabled: days >= 60, label: 'Later' })] : null,
      view === 'week' ? [round('left', set(() => weeks--), { disabled: weeks <= -4, label: 'Earlier' }), weeks !== 0 ? chip('This week', false, set(() => { weeks = 0; })) : null, round('right', set(() => weeks++), { disabled: weeks >= 9, label: 'Later' })] : null,
      view === 'month' ? [round('left', set(() => months--), { disabled: months <= -1, label: 'Earlier' }), round('right', set(() => months++), { disabled: months >= 2, label: 'Later' })] : null,
      round('photo', fromPhoto, { label: 'From a photo of a flyer' }),
      round('bell', remindersCard, { label: 'Reminders' }),
      round('plus', () => guard(() => eventForm(null, view === 'day' ? oneDay : today)), { dark: true, label: 'Add' })),
    view === 'month' ? month(monthStart(today, months), today) : view === 'list' ? agenda(today) : view === 'day' ? dayView(oneDay, today) : weekView(from, today),
    h('div', { class: 'note' },
      onScreen?.kind === 'phone' ? null : btn('Add a calendar', addCalendar, { soft: H.calendars !== 0 }), // (on the display, behind the PIN)
      H.fromApps?.length ? btn('From apps', fromAppsCard, { soft: true }) : null));
}

/** A calendar by its link: on the display, behind the PIN (the shell keeps the links, sealed). */
function addCalendar() {
  if (!phone.addCalendar()) openCard((close) => [h('h2', null, 'Add a calendar'), h('p', { class: 'line light' }, 'On the display: Add a calendar here, or Settings, Family. From a computer, ask Claude or ChatGPT to add it with the calendar’s link.'), h('div', { class: 'actions' }, btn('OK', close))]);
}

/** The forecast by day ("YYYY-MM-DD" -> {high, rain}), for the day headers. */
let forecast = {};
const loadForecast = () => weather().then((w) => { if (!w?.days) return; forecast = Object.fromEntries(w.days.map((d) => [d.date, d])); if (H) draw(); });
const dayWeather = (day) => {
  const f = forecast[house.dayKey(new Date(day))]; if (!f) return null;
  return h('span', { class: 'wx' }, `${f.high}°`, f.rain >= 40 ? h('span', { class: 'wx-rain', title: 'chance of rain' }, ` ${f.rain}%`) : null);
};

/** The week: a column a day; across the top, under the days, all-day and multi-day things as one bar each. */
function weekView(from, today) {
  const now = Date.now(), { list, lanes } = bars(from, DAYS);
  const L = 2 + lanes; // the grid row the timed events go in
  return h('div', { class: 'week', style: `grid-template-rows:auto ${lanes ? `repeat(${lanes}, auto) ` : ''}minmax(0, 1fr)` },
    [...Array(DAYS)].map((_, i) => {
      const day = dayStart(from, i), isToday = day === today;
      return [
        h('div', { class: 'col' + (isToday ? ' today' : ''), style: `grid-column:${i + 1};grid-row:1 / -1` }),
        h('div', { class: 'col-top' + (isToday ? ' today' : ''), style: `grid-column:${i + 1};grid-row:1`, tap: () => openDay(day) },
          h('span', { class: 'dow' }, fmt(day, { weekday: 'short' })),
          h('span', { class: 'num' }, fmt(day, { day: 'numeric' })),
          dayWeather(day)),
        h('div', { class: 'col-events vscroll', style: `grid-column:${i + 1};grid-row:${L}`, 'data-keep': 'col' + i },
          eventsOn(day).filter((e) => !spans(e)).map((e) => eventChip(e, isToday && (e.t1 ?? e.t0) < now)),
          notesEl(day, 'week'), // the apps' notes (a school lunch): the next thing after the day's events
          h('div', { class: 'col-rest', tap: () => openDay(day) })),
      ];
    }),
    list.map(({ e, a, b, lane, cutL, cutR }) => h('div', {
      class: 'wbar' + (cutL ? ' cut-l' : '') + (cutR ? ' cut-r' : '') + ((e.t1 ?? (e.allDay ? dayStart(e.t0, 1) : e.t0)) <= now ? ' past' : ''),
      style: `grid-column:${a + 1} / ${b + 2};grid-row:${2 + lane};background:${paint(e, .32)}`, tap: () => openEvent(e) }, barKids(e, cutL))));
}

/** One day by the hour: all-day things across the top, the rest where they fall, and a line at now. */
function dayView(day, today) {
  const list = eventsOn(day), all = list.filter((e) => e.allDay), timed = list.filter((e) => !e.allDay);
  const top = dayStart(day) + FIRST_HOUR * 3600e3, end = top + HOURS * 3600e3;
  // Side by side where they overlap: each takes a lane.
  const lanes = [], placed = timed.map((e) => {
    const a = Math.max(e.t0, top), b = Math.min(Math.max(e.t1 ?? e.t0 + 1800e3, a + 1800e3), end);
    let lane = lanes.findIndex((l) => l <= a); if (lane < 0) { lane = lanes.length; lanes.push(0); } lanes[lane] = b;
    return { e, a, b, lane };
  });
  const n = Math.max(1, lanes.length), y = (t) => ((t - top) / 3600e3) * HOUR_U;
  const grid = h('div', { class: 'hours vscroll', 'data-keep': 'hours', role: 'none', tap: () => {} },
    h('div', { class: 'hours-in', style: `height:calc(${HOURS * HOUR_U} * var(--u))` },
      [...Array(HOURS)].map((_, i) => h('div', { class: 'hour', style: `top:calc(${i * HOUR_U} * var(--u));height:calc(${HOUR_U} * var(--u))`,
        tap: () => guard(() => eventForm(null, day, (FIRST_HOUR + i) * 60)) },
        h('span', { class: 'hour-label' }, i ? `${(FIRST_HOUR + i) % 12 || 12} ${(FIRST_HOUR + i) < 12 ? 'AM' : 'PM'}` : ''))),
      placed.map(({ e, a, b, lane }) => {
        const c = house.color(e.who);
        return h('div', { class: 'block', style: `top:calc(${y(a)} * var(--u));height:calc(${Math.max(28, y(b) - y(a) - 3)} * var(--u));left:calc(76 * var(--u) + (100% - 76 * var(--u)) * ${lane / n});width:calc((100% - 76 * var(--u)) / ${n} - 6 * var(--u));background:${paint(e, .28)};border-color:${c}`, tap: () => openEvent(e) },
          h('div', { class: 'block-what' }, e.title), h('div', { class: 'block-when' }, `${timeOf(e.t0)}${e.t1 ? ' – ' + timeOf(e.t1) : ''}${whoText(e) ? ' · ' + whoText(e) : ''}`));
      }),
      day === today && Date.now() >= top && Date.now() < end ? h('div', { class: 'now-line', style: `top:calc(${y(Date.now())} * var(--u))` }) : null));
  // Opened on this day: start at the hour before now (or 7 AM), not at midnight.
  if (scrolledTo !== day) requestAnimationFrame(() => { scrolledTo = day; grid.scrollTop = grid.scrollHeight / HOURS * Math.max(0, (day === today ? new Date().getHours() - 1 : 7) - FIRST_HOUR); });
  const f = forecast[house.dayKey(new Date(day))];
  return h('div', { class: 'dayview' },
    grid,
    h('div', { class: 'dside vscroll', 'data-keep': 'dside' },
      f ? h('div', { class: 'dwx' }, h('span', { class: 'hi' }, `${f.high}°`),
        h('span', { class: 'rest' }, f.condition || '', f.rain >= 40 ? h('span', { class: 'wx-rain' }, `${f.condition ? ', ' : ''}${f.rain}% rain`) : null)) : null,
      all.map((e) => h('div', { class: 'wbar', style: `background:${paint(e, .32)}`, tap: () => openEvent(e) }, barKids(e, true))),
      notesEl(day, 'day')));
}

function eventChip(e, past) {
  const c = house.color(e.who);
  return h('div', { class: 'chipv' + (past ? ' past' : ''), style: `background:${paint(e, past ? .14 : .32)}`, tap: () => openEvent(e) },
    h('div', { class: 'when' }, e.allDay ? 'All day' : timeOf(e.t0)),
    h('div', { class: 'what' }, e.title),
    whoText(e) ? h('div', { class: 'whose' }, whoText(e)) : null,
    e.fromApp ? h('div', { class: 'src' }, e.appName || appName(e.fromApp)) : null);
}

/** The month as a grid, a few events per day in their person's color, multi-day ones as one bar; tap a day for all of it. */
function month(first, today) {
  const start = weekStart(first), m = new Date(first).getMonth();
  const last = dayStart(monthStart(first, 1), -1);
  const rows = Math.min(6, Math.max(4, Math.floor(Math.round((last - start) / 86400000) / 7) + 1));
  const room = rows > 4 ? 2 : 3; // things a day shows, bars included (a third is cut off in a five-week month)
  return h('div', { class: 'month' },
    h('div', { class: 'mhead' }, [...Array(7)].map((_, i) => h('div', { class: 'mdow' }, fmt(dayStart(start, i), { weekday: 'short' })))),
    [...Array(rows)].map((_, r) => {
      const wk = dayStart(start, r * 7), { list, lanes } = bars(wk, 7);
      const shown = list.filter((x) => x.lane < room), left = Math.max(0, room - lanes);
      return h('div', { class: 'mweek', style: `grid-template-rows:auto ${Math.min(lanes, room) ? `repeat(${Math.min(lanes, room)}, auto) ` : ''}minmax(0, 1fr)` },
        [...Array(7)].map((_, i) => {
          const day = dayStart(wk, i), inMonth = new Date(day).getMonth() === m, isToday = day === today;
          const all = eventsOn(day), rest = all.filter((e) => !spans(e)), hidden = all.length - rest.slice(0, left).length - shown.filter((x) => x.a <= i && x.b >= i).length;
          return [
            h('div', { class: 'cell' + (isToday ? ' today' : inMonth ? '' : ' out'), style: `grid-column:${i + 1};grid-row:1 / -1`, tap: () => openDay(day) }),
            h('span', { class: 'num' + (isToday ? ' now' : inMonth ? '' : ' out'), style: `grid-column:${i + 1};grid-row:1`, tap: () => openDay(day) }, fmt(day, { day: 'numeric' })),
            h('div', { class: 'cell-rest', style: `grid-column:${i + 1};grid-row:-2`, tap: () => openDay(day) },
              rest.slice(0, left).map((e) => h('div', { class: 'mev', style: `background:${paint(e, .32)}` }, e.title)),
              hidden > 0 ? h('div', { class: 'more' }, `+${hidden} more`) : null),
          ];
        }),
        shown.map(({ e, a, b, lane, cutL, cutR }) => h('div', { class: 'mev mbar' + (cutL ? ' cut-l' : '') + (cutR ? ' cut-r' : ''),
          style: `grid-column:${a + 1} / ${b + 2};grid-row:${2 + lane};background:${paint(e, .32)}`, tap: () => openEvent(e) }, e.title)));
    }));
}

function eventRow(e) {
  return h('div', { class: 'erow', tap: () => openEvent(e) },
    h('span', { class: 'when' }, e.allDay ? 'All day' : timeOf(e.t0)),
    h('span', { class: 'dot', style: `background:${dotPaint(e)}` }),
    h('span', { class: 'what' }, e.title),
    whoText(e) ? h('span', { class: 'whose' }, whoText(e)) : null);
}

function agenda(today) {
  const now = Date.now(), out = [];
  for (let i = 0; i < AGENDA_DAYS; i++) {
    const day = dayStart(today, i);
    const list = eventsOn(day).filter((e) => e.allDay || (e.t1 ?? e.t0) >= now || i > 0);
    if (!list.length && !notesOn(day).length) continue;
    out.push(h('h2', { class: 'aday' + (i === 0 ? ' today' : '') }, dayName(day, today) || fmt(day, { weekday: 'long', month: 'short', day: 'numeric' })),
      list.length ? h('div', { class: 'rows' }, list.map(eventRow)) : null,
      notesEl(day, 'list'));
  }
  return h('div', { class: 'agenda vscroll', 'data-keep': 'agenda' }, out.length ? out : h('p', { class: 'nothing' }, 'Nothing coming up'));
}

/** One day up close: everything on it, and adding to it. */
function openDay(day) {
  openCard((close) => {
    const today = dayStart(Date.now()), list = eventsOn(day);
    return [
      h('div', { class: 'card-top' },
        h('h2', { class: 'day-name' + (day === today ? ' today' : '') }, dayName(day, today) || fmt(day, { weekday: 'long' })),
        // The hour-by-hour view is a quiet link here, not a third button (docs/ux.md).
        h('button', { class: 'day-date', onclick: () => { close(); view = 'day'; days = Math.round((day - today) / 86400000); draw(); } }, `${fmt(day, { month: 'long', day: 'numeric' })} · by the hour`)),
      h('div', { class: 'rows vscroll day-rows', 'data-keep': 'day' }, list.length ? list.map(eventRow) : h('p', { class: 'nothing small' }, 'Nothing yet')),
      h('div', { class: 'actions' }, btn('Close', close, { soft: true }), btn('Add', () => { close(); eventForm(null, day); })),
    ];
  }, { width: 860 });
}

function openEvent(e) {
  const remove = (date = null) => {
    events = events.filter((x) => x.id !== e.id || (date && x.date !== date)); draw(); house.removeEvent(e.id, date);
  };
  const mine = e.local && e.id; // added here: it can be changed; synced ones change where they come from
  let counting = !!e.countdown;
  const later = e.t0 > Date.now() && (mine || e.uid);
  openCard((close) => [
    h('div', { class: 'ev-title' }, h('span', { class: 'dot big', style: `background:${dotPaint(e)}` }), h('h2', { class: 'big' }, e.title)),
    h('p', { class: 'line' }, fmt(e.t0, { weekday: 'long', month: 'long', day: 'numeric' }) + (e.allDay ? '' : ' · ' + timeOf(e.t0) + (e.t1 ? ' – ' + timeOf(e.t1) : ''))),
    e.repeat ? h('p', { class: 'line' }, repeatLabel(e.repeat) + (e.until ? `, until ${fmt(Date.parse(e.until + 'T12:00'), { month: 'long', day: 'numeric' })}` : '')) : null,
    e.place ? h('p', { class: 'line light' }, e.place) : null,
    whoText(e) ? h('p', { class: 'line ink' }, whoText(e)) : null,
    e.notes ? h('p', { class: 'line notes' }, e.notes) : null,
    e.fromApp ? h('p', { class: 'line light small' }, `From ${e.appName || appName(e.fromApp)}`) // one of the household's apps put it here (read-only)
      : !mine ? h('p', { class: 'line light small' }, `From ${e.who ? e.who + '’s' : 'a'} calendar: change it there.`) : null,
    e.t0 > Date.now() && (mine || e.uid) ? h('div', { class: 'chips' }, chip(counting ? 'Counting down on the home screen' : 'Count down to it', counting, () => {
      guard(() => { counting = !counting; e.countdown = counting; house.countdown(mine ? { id: e.id } : { uid: e.uid }, counting); sheets.at(-1)?.redraw(); });
    })) : null,
    later && !e.allDay ? h('div', { class: 'row' }, h('span', { class: 'label' }, 'Remind'),
      remindChips(e.remind ?? null, (m) => guard(() => { e.remind = m; house.remind(mine ? { id: e.id } : { uid: e.uid }, m); sheets.at(-1)?.redraw(); }))) : null,
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
        h('span', { class: 'tick' }, flyerPick.on.has(i) ? icon('check') : null),
        h('span', { class: 'what' }, h('b', null, e.title), h('span', null, [when(e), e.place].filter(Boolean).join(' · ')), e.notes ? h('span', { class: 'n' }, e.notes) : null)))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Whose'), h('div', { class: 'chips' }, chip('Everyone', flyerPick.who == null, () => { flyerPick.who = null; redraw(); }),
        (H.family || []).map((p) => chip(p.name, same(flyerPick.who, p.name), () => { flyerPick.who = p.name; redraw(); }, house.color(p.name))))),
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
    people: e ? people(e) : [], repeat: e?.repeat ?? null, until: e?.until ?? null, place: e?.place || '', notes: e?.notes || '', countdown: !!e?.countdown, remind: e?.remind ?? null,
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
  const finish = () => {
    if (!f.title.trim()) return;
    const d = new Date(f.day); const allDay = f.len === 0 || f.min < 0;
    if (!allDay) d.setHours(Math.floor(f.min / 60), f.min % 60, 0, 0);
    const start = d.getTime(), end = allDay ? null : start + f.len * 60000;
    const fields = { title: f.title.trim(), start, end, allDay, who: f.people[0] || null, also: f.people.slice(1), repeat: f.repeat, until: f.repeat ? f.until : null, place: f.place.trim(), notes: f.notes.trim(), countdown: f.countdown, remind: allDay ? null : f.remind };
    s.close();
    if (e) { Object.assign(e, { ...fields, t0: start, t1: allDay ? dayStart(start, 1) : end }); draw(); house.updateEvent(e.id, { ...fields, repeat: f.repeat || 'none' }); }
    else { events.push({ id: null, ...fields, start: d.toISOString(), t0: start, t1: allDay ? dayStart(start, 1) : end, local: true }); draw(); house.addEvent(fields); }
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
          H.family.map((p) => chip(p.name, f.people.some((n) => same(n, p.name)), pick(() => { f.people = f.people.some((n) => same(n, p.name)) ? f.people.filter((n) => !same(n, p.name)) : [...f.people, p.name]; }), house.color(p.name))))) : null,
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

house.subscribe((d) => {
  H = d;
  events = (d.events || []).map((e) => ({ ...e, t0: Date.parse(e.start), t1: e.end ? Date.parse(e.end) : null })).filter((e) => !isNaN(e.t0));
  draw(); showFlyer();
  if (afterPin && H.unlockedUntil > Date.now()) { const fn = afterPin; afterPin = null; if (Date.now() - afterPinAt < 120e3) fn(); } // the PIN was just given (not long after asking)
});
loadForecast(); setInterval(loadForecast, 30 * 60e3);
