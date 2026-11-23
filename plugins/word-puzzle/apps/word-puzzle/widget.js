// Word puzzle's card on Today: today's mixed-up letters, or the word once it's solved.
import { store } from '/kit/openhouse.js';
import { h, dayKey, put } from './ui.js';
import { puzzleFor } from './words.js';

async function draw() {
  const q = puzzleFor(dayKey()), s = await store.get('today'), solved = s?.day === dayKey() && s.solved;
  put(document.body, 
    h('div', { class: 'k-tiles' }, (solved ? q.word.split('') : q.letters).map((l) => h('span', { class: 'k-tile' }, l.toUpperCase()))),
    h('div', { class: 'k-grow' }),
    h('div', { class: 'k-soft' }, solved ? `Solved${s.by ? ` by ${s.by}` : ''}. ${q.clue}` : `${q.word.length} letters. Ask Opie for a hint.`));
}
draw(); setInterval(draw, 30e3);
