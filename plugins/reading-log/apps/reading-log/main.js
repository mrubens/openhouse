// Reading log: minutes read, by each reader, said to the voice ("Maya read 20 minutes") or tapped in. Streaks of days
// with the household's daily goal, the week as a chart (here and on a card on Home), and, if the household turns it
// on, a star for each day someone reaches the goal: a "Reading" chore in Chores that ticks itself, so the stars are
// the Chores app's own and add up toward the same rewards.
//
// The log is the app's own (store "log"), kept by the tablet; the voice gives who and how many minutes as arguments
// (app.json "log"), so nothing here reads what was said.
import { house, store, onAction } from '/kit/openhouse.js';
import { h, sheet, field, dayKey, addDays, dateOf, weekday, monthDay, whenDay, and, put, whenShown } from './ui.js';
import { minutesOn, weekOf, streak, best } from './log.js';

const $app = document.getElementById('app');
const CHORE = 'Reading';
let log = [];                                    // [{id, who, minutes, day, book, at}]
let settings = { goal: 20, stars: false, readers: null }; // readers: names, or null for everyone in the family
let family = [], chores = [];

const readers = () => (settings.readers?.length ? settings.readers : family);
const save = () => store.set('log', { items: log.slice(-3000) });
/** The log as kept now: another copy of this page (its window, its card, the one in the background) may have added to it. */
const reload = async () => { log = (await store.get('log'))?.items || []; };
const named = (who) => {
  const w = String(who || '').trim().toLowerCase();
  return readers().find((n) => n.toLowerCase() === w) || readers().find((n) => n.toLowerCase().split(/\s+/)[0] === w.split(/\s+/)[0]) || null;
};

// ---- stars, through Chores ----
/** Make sure each reader has the Reading chore (stars on) or none (stars off). */
async function syncChores() {
  const mine = chores.filter((c) => c.task === CHORE);
  if (settings.stars) for (const n of readers()) if (!mine.some((c) => c.who === n)) await house.addChore(n, CHORE, [], 1);
  if (!settings.stars) for (const c of mine) await house.removeChore(c.who, CHORE);
}
/** Tick today's Reading chore for someone who has reached the goal (and untick it if a taken-back entry undoes it). */
function tick(who) {
  if (!settings.stars) return;
  const c = chores.find((x) => x.task === CHORE && x.who === who);
  if (!c) return;
  const reached = minutesOn(log, who, dayKey()) >= settings.goal;
  if (reached !== !!c.done) house.choreDone(who, CHORE, reached);
}

// ---- adding ----
async function add(who, minutes, book = '', day = dayKey()) {
  await reload();
  const e = { id: Date.now() + Math.random(), who, minutes: Math.max(1, Math.min(600, Math.round(minutes))), day, book: String(book || '').trim().slice(0, 80), at: Date.now() };
  log.push(e); await save(); if (day === dayKey()) tick(who); draw();
  return e;
}
async function takeOff(id) { await reload(); const e = log.find((x) => x.id === id); log = log.filter((x) => x.id !== id); await save(); if (e) tick(e.who); draw(); }

// ---- the page ----
function chart(who, days, cls = 'chart') {
  const max = Math.max(settings.goal * 1.5, ...days.map((d) => minutesOn(log, who, d)));
  return h('div', { class: cls }, days.map((d) => {
    const m = minutesOn(log, who, d);
    return h('div', { class: 'col' + (d === dayKey() ? ' today' : '') + (m >= settings.goal ? ' met' : '') },
      h('div', { class: 'n' }, m ? String(m) : ''),
      h('div', { class: 'well' }, h('div', { class: 'bar', style: `height:${Math.round((m / max) * 100)}%` }), h('div', { class: 'goal', style: `bottom:${Math.round((settings.goal / max) * 100)}%` })),
      h('div', { class: 'd' }, weekday(d, false).slice(0, 2)));
  }));
}
function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Reading log'),
    h('button', { class: 'btn soft', tap: openSettings }, 'Goal and stars'),
    h('button', { class: 'btn', tap: () => openAdd() }, 'Add reading'));
  if (!readers().length) { put($app, top, h('div', { class: 'empty' }, h('p', { class: 'soft' }, 'Add the family in Settings first, so the log knows who’s reading.'))); return; }
  const week = weekOf(), t = dayKey();
  const people = readers().map((n) => {
    const s = streak(log, n, settings.goal), total = week.reduce((a, d) => a + minutesOn(log, n, d), 0);
    return h('section', { class: 'reader' },
      h('div', { class: 'who' }, h('span', { class: 'dot', style: `background:${house.color(n)}` }), h('span', { class: 'name' }, n)),
      h('div', { class: 'nums' },
        h('div', {}, h('div', { class: 'big' }, String(minutesOn(log, n, t))), h('div', { class: 'soft' }, 'minutes today')),
        h('div', {}, h('div', { class: 'big' }, String(s)), h('div', { class: 'soft' }, `day${s === 1 ? '' : 's'} in a row`))),
      chart(n, week),
      h('div', { class: 'soft' }, `${total} minutes this week. Longest run: ${best(log, n, settings.goal)} days.`));
  });
  const recent = [...log].sort((a, b) => b.at - a.at).slice(0, 6);
  put($app, top, h('div', { class: 'body' },
    h('div', { class: 'cols', style: `--n:${Math.min(4, people.length)}` }, people),
    recent.length ? h('div', { class: 'recent' }, h('div', { class: 'label' }, 'Lately'), recent.map((e) => h('div', { class: 'line' },
      h('span', { class: 'grow' }, `${e.who}: ${e.minutes} minutes${e.book ? `, ${e.book}` : ''}`),
      h('span', { class: 'side' }, whenDay(e.day)),
      h('button', { class: 'x', 'aria-label': 'Take off', tap: () => takeOff(e.id) }, '×')))) : null),
    h('div', { class: 'foot' }, `The goal is ${settings.goal} minutes a day${settings.stars ? `, a star each day it’s reached (the Reading chore in Chores)` : ''}. Say “Maya read 20 minutes” to Opie.`));
}

function openAdd(who = readers()[0]) {
  const pick = h('select', { class: 'field' }, readers().map((n) => h('option', { value: n, selected: n === who }, n)));
  const mins = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '1', max: '600', value: String(settings.goal) });
  const book = h('input', { class: 'field', placeholder: 'Optional' });
  const when = h('select', { class: 'field' }, [0, 1, 2, 3, 4, 5, 6].map((i) => { const d = addDays(dayKey(), -i); return h('option', { value: d }, i === 0 ? 'Today' : i === 1 ? 'Yesterday' : `${weekday(d)}, ${monthDay(d)}`); }));
  sheet('Add reading', [h('div', { class: 'pair', style: '--n:3' }, field('Who', pick), field('Minutes', mins), field('When', when)), field('Book', book)], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Add', tap: async (c) => { const m = Number(mins.value); if (!(m > 0)) return; c(); await add(pick.value, m, book.value, when.value); } }]);
}
function openSettings() {
  const goal = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '5', max: '240', value: String(settings.goal) });
  const chosen = new Set(readers());
  const who = h('div', { class: 'actions' }, family.map((n) => { const b = h('button', { class: 'chip' + (chosen.has(n) ? ' on' : ''), tap: () => { chosen.has(n) ? chosen.delete(n) : chosen.add(n); b.classList.toggle('on'); } }, n); return b; }));
  const stars = h('select', { class: 'field' }, h('option', { value: 'no', selected: !settings.stars }, 'No stars'), h('option', { value: 'yes', selected: settings.stars }, 'A star each day they reach the goal'));
  sheet('Goal and stars', [field('Minutes a day', goal), field('Who’s reading', who), field('Stars', stars, 'Stars come through Chores: each reader gets a Reading chore that ticks itself when they reach the goal, so the stars count toward their rewards. Turning stars off takes the chore away again.')], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Save', tap: async (c) => {
      settings = { goal: Math.max(5, Math.min(240, Math.round(Number(goal.value) || 20))), stars: stars.value === 'yes', readers: family.filter((n) => chosen.has(n)) };
      if (settings.readers.length === family.length) settings.readers = null;
      await store.set('settings', settings); c(); await syncChores(); for (const n of readers()) tick(n); draw();
    } }]);
}

// ---- the voice ----
async function onLog({ who, minutes, book, day }) {
  const n = named(who);
  if (!n) return `Who was reading? The log has ${and(readers())}.`;
  if (!(minutes > 0)) return `How many minutes did ${n} read?`;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') && day <= dayKey() ? day : dayKey();
  // the same words twice within half a minute: one ask seen by two copies of this page, so it's written once
  const twin = log.find((e) => e.who === n && e.minutes === Math.round(minutes) && e.day === d && Date.now() - e.at < 30e3);
  if (!twin) await add(n, minutes, book, d);
  const today = minutesOn(log, n, dayKey()), s = streak(log, n, settings.goal);
  const goal = d !== dayKey() ? '' : today >= settings.goal && today - minutes < settings.goal ? ` That’s the goal for today${settings.stars ? ', and a star' : ''}.` : today < settings.goal ? ` ${settings.goal - today} more for today’s goal.` : '';
  return `Logged ${Math.round(minutes)} minutes for ${n}${d !== dayKey() ? ` on ${whenDay(d)}` : ''}.${goal}${s > 1 ? ` ${s} days in a row.` : ''}`;
}
function onHowMuch({ who, week }) {
  const ns = who ? [named(who)].filter(Boolean) : readers();
  if (!ns.length) return `The log has ${and(readers())}.`;
  return ns.map((n) => {
    const m = week ? weekOf().reduce((a, d) => a + minutesOn(log, n, d), 0) : minutesOn(log, n, dayKey());
    const s = streak(log, n, settings.goal);
    return `${n}: ${m} minutes ${week ? 'this week' : 'today'}${s ? `, ${s} day${s === 1 ? '' : 's'} in a row` : ''}.`;
  }).join(' ');
}
async function onTakeBack({ who }) {
  const n = who ? named(who) : null;
  const e = [...log].reverse().find((x) => !n || x.who === n);
  if (!e) return 'There’s nothing to take back.';
  await takeOff(e.id);
  return `Took off ${e.minutes} minutes for ${e.who}.`;
}

(async () => {
  log = (await store.get('log'))?.items || [];
  settings = { ...settings, ...((await store.get('settings')) || {}) };
  house.subscribe((hv) => {
    family = (hv.family || []).map((p) => p.name).filter(Boolean);
    chores = hv.chores || [];
    draw();
  });
  whenShown(() => onAction(async (name, args) => { await reload(); settings = { ...settings, ...((await store.get('settings')) || {}) }; return name === 'log' ? onLog(args) : name === 'how_much' ? onHowMuch(args) : name === 'take_back' ? onTakeBack(args) : null; }));
  let shown = dayKey();
  setInterval(async () => { await reload(); if (dayKey() !== shown) shown = dayKey(); draw(); }, 60e3);
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) { await reload(); draw(); } });
})();
