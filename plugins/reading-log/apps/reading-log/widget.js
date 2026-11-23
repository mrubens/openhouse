// Reading log's card on Today: this week, a row of small bars for each reader, and today's minutes.
import { house, store } from '/kit/openhouse.js';
import { h, dayKey, weekday, put } from './ui.js';
import { minutesOn, weekOf, streak } from './log.js';

let family = [];
async function draw() {
  const log = (await store.get('log'))?.items || [], s = { goal: 20, readers: null, ...((await store.get('settings')) || {}) };
  const who = s.readers?.length ? s.readers : family, week = weekOf(), t = dayKey();
  const max = Math.max(s.goal * 1.5, ...who.flatMap((n) => week.map((d) => minutesOn(log, n, d))));
  put(document.body, h('div', { class: 'k-people' }, who.slice(0, 4).map((n) => h('div', { class: 'k-person' },
    h('div', { class: 'k-row' }, h('span', { class: 'k-name' }, n), h('span', { class: 'k-soft' }, `${minutesOn(log, n, t)} today · ${streak(log, n, s.goal)} in a row`)),
    h('div', { class: 'k-bars' }, week.map((d) => h('div', { class: 'k-b' + (d === t ? ' t' : '') + (minutesOn(log, n, d) >= s.goal ? ' met' : '') },
      h('div', { style: `height:${Math.max(6, Math.min(100, Math.round((minutesOn(log, n, d) / max) * 100)))}%` }))))))));
}
house.subscribe((hv) => { family = (hv.family || []).map((p) => p.name).filter(Boolean); draw(); });
setInterval(draw, 60e3);
