// Trash day's card on Home: the next pickup, big, and what goes out.
import { store } from '/kit/openhouse.js';
import { h, dayKey, whenDay, monthDay, put } from './ui.js';
import { pickups, fromCalendar, what } from './pickup.js';

async function draw() {
  const setup = await store.get('setup'), cal = await store.get('calendar');
  const l = setup?.link && cal?.events ? fromCalendar(cal.events).slice(0, 3) : setup ? pickups(setup, dayKey(), 3) : [];
  const next = l.find((p) => p.date > dayKey() || new Date().getHours() < 9);
  put(document.body, next ? [
    h('div', { class: 'k-big' }, whenDay(next.date).replace(/^./, (c) => c.toUpperCase())),
    h('div', { class: 'k-soft' }, `${monthDay(next.date)}: ${what(next)}${next.moved ? `, a day late for ${next.moved}` : ''}`),
  ] : h('div', { class: 'k-soft' }, 'Set your pickup day in Trash day.'));
}
draw();
setInterval(draw, 15 * 60e3);
