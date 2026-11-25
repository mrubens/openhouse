// Bus times' card on Home: the next buses at the stop, in minutes, from what the app last heard from the agency
// (it asks each minute in the hours chosen, or while it's open).
import { store } from '/kit/openhouse.js';
import { h, put } from './ui.js';

async function draw() {
  const s = await store.get('setup'), last = await store.get('last'), names = (await store.get('routes')) || {};
  if (!s) { put(document.body, h('div', { class: 'k-soft' }, 'Pick your agency and stop in Bus times.')); return; }
  const fresh = last && Date.now() - last.at < 5 * 60e3;
  const next = fresh ? last.buses.filter((b) => b.at > Date.now() - 60e3).slice(0, 2) : [];
  const m = (b) => Math.max(0, Math.round((b.at - Date.now()) / 60e3)), r = (b) => names[b.route] || b.route || 'Bus';
  put(document.body,
    next.length ? h('div', { class: 'k-big' }, m(next[0]) ? `${m(next[0])} min` : 'Now') : h('div', { class: 'k-mid' }, fresh ? 'No buses coming' : `Live ${s.from}–${s.to}`),
    next.length ? h('div', { class: 'k-soft' }, `${r(next[0])}${next[1] ? `, then ${r(next[1])} in ${m(next[1])} min` : ''}`) : null,
    h('div', { class: 'k-grow' }), h('div', { class: 'k-soft' }, s.stop.name));
}
draw(); setInterval(draw, 30e3);
