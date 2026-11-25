// NAME: what it's for, in a line. It fills #app (index.html); its look is app.css. Its own things (what someone typed
// or ticked) are saved with the kit's store, so they're kept by the tablet and the same on every screen. Until it's
// made, the page shows "Making NAME…" (index.html), not this.
import { store, h } from '/kit/openhouse.js';

const app = document.getElementById('app');
let state = (await store.get('state')) || { note: '' };
const save = async () => { const r = await store.set('state', state); if (r?.ok === false) console.warn(r.error); };

function draw() {
  app.replaceChildren(
    // (h(tag, props, ...children): children are text or other h() elements, never HTML in a string. A title can have
    // a softer second part: h('h1', { class: 'title' }, 'Reading ', h('span', null, 'this week')).)
    h('div', { class: 'top' }, h('h1', { class: 'title' }, 'NAME')),
    h('div', { class: 'body' },
      h('div', { class: 'panel' }, state.note || 'Nothing yet.')));
}
draw();
