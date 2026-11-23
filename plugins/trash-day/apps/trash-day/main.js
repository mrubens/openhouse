// Trash day: when the trash, recycling and yard waste go out, by the household's own schedule (pickup.js), or by
// their city's pickup calendar when it has a link to one. Each pickup is a note on the calendar (kit days.set), the
// evening before Today says so (kit today.show, on the sleep screen too), and the voice answers (app.json "pickup").
// Runs in the background.
import { store, today, days, web, onAction } from '/kit/openhouse.js';
import { h, sheet, field, dayKey, addDays, whenDay, monthDay, weekday, put, whenShown } from './ui.js';
import { DAYS, MONTHS, pickups, fromCalendar, what, What } from './pickup.js';
import { feedUrl, readIcs } from './ics.js';

const $app = document.getElementById('app');
let setup = null;  // pickup.js's schedule, plus link: the city's calendar (store "setup")
let cal = null;    // {events, at, error} from the city's calendar (store "calendar")

const list = (n = 8) => (setup?.link && cal?.events ? fromCalendar(cal.events).slice(0, n) : setup ? pickups(setup, dayKey(), n) : []);
/** The next pickup still to come: today's until 9 AM, then the one after. */
const next = () => list(3).find((p) => p.date > dayKey() || new Date().getHours() < 9);

async function readCalendar(force = false) {
  if (!setup?.link || (!force && cal?.at && Date.now() - cal.at < 12 * 3600e3)) return;
  try {
    const r = await web.get(feedUrl(setup.link));
    if (!/BEGIN:VCALENDAR/.test(r.text)) throw new Error('not a calendar');
    cal = { events: readIcs(r.text).slice(0, 300), at: Date.now() };
  } catch (e) { cal = { ...(cal || {}), error: String(e.message || e).slice(0, 100) }; }
  await store.set('calendar', cal);
}

// ---- on the calendar and Today ----
let notesFor = null, lineFor = null;
function update() {
  const l = list(8).map((p) => ({ date: p.date, label: 'Trash', short: What(p).slice(0, 28), text: `${What(p)}${p.text ? '' : ' go out'}${p.moved ? ` (a day later for ${p.moved})` : ''}` }));
  const k = JSON.stringify(l);
  if (k !== notesFor) { notesFor = k; days.set(l); }
  // from 3 PM the day before until 9 AM on the day
  const now = new Date(), t = dayKey(now), p = next();
  let text = '', until = null;
  if (p && p.date === addDays(t, 1) && now.getHours() >= 15) { text = `${What(p)} ${p.text ? 'pickup tomorrow' : 'go out tonight'}`; until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9); }
  else if (p && p.date === t && now.getHours() < 9) { text = `${What(p)} ${p.text ? 'pickup today' : 'today'}`; until = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9); }
  if (text !== lineFor) { lineFor = text; if (text) today.show(text.slice(0, 80), until); else today.clear(); }
  draw();
}

// ---- the page ----
function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Trash day'), h('button', { class: 'btn soft', tap: openSetup }, setup ? 'Schedule' : 'Set up'));
  if (!setup) {
    put($app, top, h('div', { class: 'empty' },
      h('p', { class: 'lead' }, 'Know which night the bins go out.'),
      h('p', { class: 'soft' }, 'Tell it your pickup day and which weeks recycling goes, or paste your city’s pickup calendar link. Each pickup goes on the calendar, and Today says so the evening before.'),
      h('button', { class: 'btn', tap: openSetup }, 'Set up')));
    return;
  }
  const l = list(8), p = l.find((x) => x.date > dayKey() || new Date().getHours() < 9);
  put($app, top, h('div', { class: 'body' },
    h('div', { class: 'next' }, h('div', { class: 'label' }, 'Next pickup'),
      h('div', { class: 'big' }, p ? whenDay(p.date).replace(/^./, (c) => c.toUpperCase()) : '—'),
      p ? h('div', { class: 'soft' }, `${monthDay(p.date)}: ${what(p)}${p.moved ? `, a day later for ${p.moved}` : ''}.`) : null),
    h('div', { class: 'weeks' }, l.filter((x) => x !== p).map((x) => h('div', { class: 'line' },
      h('span', { class: 'grow' }, `${weekday(x.date)}, ${monthDay(x.date)}`), h('span', { class: 'side' }, what(x) + (x.moved ? ` · moved for ${x.moved}` : '')))))),
  h('div', { class: 'foot' }, setup.link ? (cal?.error ? 'Couldn’t read your city’s pickup calendar just now.' : 'From your city’s pickup calendar.') : 'From the schedule you set. Storms and one-off changes aren’t in it.'));
}

function openSetup() {
  const s = { day: 'Monday', recycling: 'weekly', recyclingWeek: dayKey(), yard: 'none', yardWeek: dayKey(), yardFrom: 3, yardTo: 10, holidays: true, link: '', ...(setup || {}) };
  const sel = (opts, v, on) => h('select', { class: 'field', onchange: (e) => on(e.target.value) }, opts.map(([k, t]) => h('option', { value: k, selected: String(k) === String(v) }, t)));
  const date = (v, on) => h('input', { class: 'field', type: 'date', value: v, onchange: (e) => on(e.target.value) });
  const link = h('input', { class: 'field', placeholder: 'webcal://… or https://… (optional)', value: s.link, autocapitalize: 'off', spellcheck: 'false' });
  const msg = h('span', { class: 'hint' });
  sheet('Pickup schedule', [
    h('div', { class: 'pair' }, field('Pickup day', sel(DAYS.slice(1, 6).map((d) => [d, d]), s.day, (v) => { s.day = v; })),
      field('A weekday holiday', sel([['yes', 'Moves the rest of the week a day later'], ['no', 'Changes nothing']], s.holidays ? 'yes' : 'no', (v) => { s.holidays = v === 'yes'; }))),
    h('div', { class: 'pair' }, field('Recycling', sel([['weekly', 'Every week'], ['alternate', 'Every other week'], ['none', 'Not picked up']], s.recycling, (v) => { s.recycling = v; })),
      field('A day in a recycling week', date(s.recyclingWeek, (v) => { s.recyclingWeek = v; }), 'Only for every other week.')),
    h('div', { class: 'pair' }, field('Yard waste or compost', sel([['none', 'Not picked up'], ['weekly', 'Every week'], ['alternate', 'Every other week']], s.yard, (v) => { s.yard = v; })),
      field('A day in one of its weeks', date(s.yardWeek, (v) => { s.yardWeek = v; }))),
    h('div', { class: 'pair' }, field('Yard waste from', sel(MONTHS.map((m, i) => [i, m]), s.yardFrom, (v) => { s.yardFrom = Number(v); })),
      field('Through', sel(MONTHS.map((m, i) => [i, m]), s.yardTo, (v) => { s.yardTo = Number(v); }))),
    field('Or your city’s pickup calendar', link, 'If your city has a pickup calendar to subscribe to (ReCollect, or a Google, iCloud or Outlook calendar), its link gives the real dates, holidays and all. Then the schedule above is only used when it can’t be read.'),
    msg,
    setup ? h('button', { class: 'btn soft', tap: async () => { setup = null; cal = null; await store.set('setup', null); await store.set('calendar', null); document.querySelector('.scrim')?.remove(); update(); } }, 'Stop using Trash day') : null,
  ], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Save', tap: async (c) => {
      s.link = link.value.trim();
      if (s.link && !feedUrl(s.link)) { msg.textContent = 'That link isn’t a calendar address.'; msg.classList.add('bad'); return; }
      setup = s; await store.set('setup', setup);
      if (s.link) { msg.textContent = 'Reading the calendar…'; await readCalendar(true); if (cal?.error) { msg.textContent = 'Couldn’t read a calendar from that link (only ReCollect, Google, iCloud and Outlook calendars work).'; msg.classList.add('bad'); return; } }
      c(); update();
    } }]);
}

// ---- the voice ----
async function answer({ which }) {
  if (!setup) return 'Trash day isn’t set up yet: set your pickup day in the Trash day app.';
  await readCalendar();
  const p = next();
  if (!p) return 'There’s no pickup in the next few weeks.';
  const when = `${whenDay(p.date)}${p.moved ? ` (a day later for ${p.moved})` : ''}`;
  if (p.text) return `Next pickup ${when}: ${p.text}.`;
  if (which === 'recycling') {
    if (setup.recycling === 'none') return 'Recycling isn’t on your pickup schedule.';
    if (setup.recycling === 'weekly') return `Recycling goes every week. The next one is ${when}.`;
    const r = list(4).find((x) => x.recycling && x.date >= p.date);
    return r === p ? `Yes, recycling goes out ${when}.` : `Not this time: recycling goes out ${whenDay(r.date)}.`;
  }
  if (which === 'yard') {
    const y = list(8).find((x) => x.yard && x.date >= p.date);
    return y ? `Yard waste goes out ${whenDay(y.date)}.` : 'No yard waste pickups in the next few weeks.';
  }
  return `${What(p)} go out ${when}.`;
}

(async () => {
  setup = await store.get('setup');
  cal = await store.get('calendar');
  update();
  whenShown(() => onAction((name, args) => (name === 'pickup' ? answer(args) : null)));
  await readCalendar(); update();
  setInterval(async () => { await readCalendar(); update(); }, 10 * 60e3);
})();
