// Bedtime's card on Home: a button to start the scene, and once it's run, that it's done.
import { store, devices } from '/kit/openhouse.js';
import { runScene } from './scene.js';
import { h, hm, at, dayKey, put } from './ui.js';

async function draw() {
  const s = await store.get('setup'), ran = await store.get('ran'), now = new Date();
  if (!s) { put(document.body, h('div', { class: 'k-soft' }, 'Set up bedtime in the Bedtime app.')); return; }
  const bed = at(s.time), done = ran?.day === dayKey();
  const btn = h('button', { class: 'k-btn' }, done ? 'Run it again' : 'Start bedtime');
  btn.addEventListener('click', async () => { btn.disabled = true; btn.textContent = 'Starting…'; const results = await runScene(devices, s); await store.set('ran', { day: dayKey(), results }); draw(); });
  put(document.body, h('div', { class: 'k-soft' }, done ? 'Bedtime scene done' : now < bed ? 'Bedtime' : 'It’s bedtime'), h('div', { class: 'k-big' }, hm(bed)), h('div', { class: 'k-grow' }), btn);
}
draw(); setInterval(draw, 30e3);
