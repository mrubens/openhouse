// Sun and moon's card on Home: the sunset (or the sunrise, before it), and the moon.
import { weather } from '/kit/openhouse.js';
import { h, hm, put } from './ui.js';
import { moon } from './sky.js';
import { moonPic } from './pic.js';

async function draw() {
  const w = await weather(), m = moon();
  const rise = w?.sunrise && new Date(w.sunrise), set = w?.sunset && new Date(w.sunset), now = new Date();
  const sunWord = !set ? null : now < rise ? ['Sunrise', hm(rise)] : now < set ? ['Sunset', hm(set)] : ['Sunrise tomorrow', hm(rise.getTime() + 864e5)];
  put(document.body, 
    sunWord ? h('div', {}, h('div', { class: 'k-soft' }, sunWord[0]), h('div', { class: 'k-big' }, sunWord[1])) : h('div', { class: 'k-soft' }, 'Tell Opie where home is for the sun’s times.'),
    h('div', { class: 'k-grow' }),
    h('div', { class: 'k-row' }, moonPic(m, 'k-moon'), h('div', { class: 'k-soft' }, `${m.name}, ${Math.round(m.lit * 100)}%`)));
}
draw(); setInterval(draw, 10 * 60e3);
