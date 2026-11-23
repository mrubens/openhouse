// Sun and moon: today's sunrise and sunset, how long the day is and how that's changing, and the moon tonight. The
// sunrise and sunset come from the tablet's own weather (kit weather()); the rest is worked out here (sky.js), so
// nothing leaves the tablet. The voice can ask (app.json "sky").
import { weather, onAction } from '/kit/openhouse.js';
import { h, hm, dayKey, put, whenShown } from './ui.js';
import { placeFrom, sunTimes, moon, next } from './sky.js';
import { moonPic } from './pic.js';

const $app = document.getElementById('app');
let place = null, todaySun = null, problem = null;

async function load() {
  const w = await weather();
  if (!w?.sunrise || !w?.sunset) { problem = 'The weather doesn’t know where home is yet: tell Opie your town or ZIP code.'; return; }
  todaySun = { rise: new Date(w.sunrise), set: new Date(w.sunset) };
  place = placeFrom(todaySun.rise, todaySun.set);
  problem = null;
}
const dayOf = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d; };
const sunOn = (offset) => (offset === 0 && todaySun ? todaySun : place ? sunTimes(dayOf(offset), place) : null);
const length = (s) => (s.set - s.rise) / 60e3;
const hours = (min) => `${Math.floor(min / 60)} hours ${Math.round(min % 60)} minutes`;
const dateWords = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Daylight'));
  if (problem || !todaySun) { put($app, top, h('div', { class: 'empty' }, h('p', { class: 'soft' }, problem || 'Looking at the sky…'))); return; }
  const t = sunOn(0), y = sunOn(-1), tm = sunOn(1), m = moon(), full = next('full'), nw = next('new');
  const change = y ? Math.round(length(t) - length(y)) : 0;
  put($app, top, h('div', { class: 'cols', style: '--n:2' },
    h('section', { class: 'part' },
      h('div', { class: 'label' }, 'The sun today'),
      h('div', { class: 'pair-big' }, h('div', {}, h('div', { class: 'soft' }, 'Sunrise'), h('div', { class: 'big' }, hm(t.rise))), h('div', {}, h('div', { class: 'soft' }, 'Sunset'), h('div', { class: 'big' }, hm(t.set)))),
      h('p', { class: 'soft' }, `${hours(length(t))} of daylight, ${change === 0 ? 'about the same as yesterday' : `${Math.abs(change)} minute${Math.abs(change) === 1 ? '' : 's'} ${change > 0 ? 'more' : 'less'} than yesterday`}.`),
      tm ? h('p', { class: 'soft' }, `Tomorrow: up at ${hm(tm.rise)}, down at ${hm(tm.set)}.`) : null),
    h('section', { class: 'part' },
      h('div', { class: 'label' }, 'The moon tonight'),
      h('div', { class: 'moonrow' }, moonPic(m, 'moon'), h('div', {}, h('div', { class: 'big mid' }, m.name), h('div', { class: 'soft' }, `${Math.round(m.lit * 100)}% lit`))),
      h('p', { class: 'soft' }, `Next full moon ${dateWords(full)}; next new moon ${dateWords(nw)}.`))),
    h('div', { class: 'foot' }, 'Worked out on the tablet from the weather’s sunrise and sunset: within a minute or two.'));
}

function answer({ what, day }) {
  if (!todaySun) return 'I don’t know where home is yet, so I can’t say when the sun sets. Tell me your town or ZIP code.';
  const off = day === 'tomorrow' ? 1 : 0, s = sunOn(off), when = off ? 'tomorrow' : 'today';
  if (what === 'moon') { const m = moon(Date.now() + off * 864e5); return `${m.name} ${off ? 'tomorrow night' : 'tonight'}, about ${Math.round(m.lit * 100)}% lit. The next full moon is ${dateWords(next('full'))}.`; }
  if (!s) return 'The sun doesn’t rise or set there that day.';
  if (what === 'sunrise') return `Sunrise ${when} is at ${hm(s.rise)}.`;
  if (what === 'daylight') return `${hours(length(s))} of daylight ${when}, from ${hm(s.rise)} to ${hm(s.set)}.`;
  const left = s.set - Date.now();
  return `Sunset ${when} is at ${hm(s.set)}${!off && left > 0 && left < 3 * 3600e3 ? `, in ${Math.round(left / 60e3)} minutes` : ''}.`;
}

(async () => {
  await load(); draw();
  whenShown(() => onAction((name, args) => (name === 'sky' ? answer(args) : null)));
  let shown = dayKey();
  setInterval(async () => { if (dayKey() !== shown) { shown = dayKey(); await load(); } draw(); }, 5 * 60e3);
})();
