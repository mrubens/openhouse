// Word puzzle: a word a day, its letters mixed up, and a clue. The kids work it out on the page or ask Opie for hints
// (app.json "hint"), each one giving a little more: what kind of thing it is, the clue, the first letter, the last.
// Opie gets the guess as a word (app.json "guess") and the page checks it. Today's hints and whether it's solved are
// kept for the household (store "today"), so the card on Today and the voice agree.
import { store, onAction } from '/kit/openhouse.js';
import { h, dayKey, put, whenShown } from './ui.js';
import { puzzleFor } from './words.js';

const $app = document.getElementById('app');
let state = { day: null, hints: 0, solved: false, by: null };
const p = () => puzzleFor(dayKey());
async function load() { const s = await store.get('today'); state = s?.day === dayKey() ? s : { day: dayKey(), hints: 0, solved: false, by: null }; }
const save = () => store.set('today', state);
const HINTS = (q) => [`It’s ${q.kind}.`, q.clue, `It starts with ${q.word[0].toUpperCase()}.`, `It ends with ${q.word.at(-1).toUpperCase()}.`];

function draw() {
  const q = p();
  const tiles = h('div', { class: 'tiles' }, (state.solved ? q.word.split('') : q.letters).map((l) => h('span', { class: 'tile' }, l.toUpperCase())));
  const hints = HINTS(q).slice(0, state.hints);
  put($app, h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Word puzzle')), h('div', { class: 'body' },
    h('div', { class: 'label' }, state.solved ? `Solved${state.by ? ` by ${state.by}` : ''}` : `Today’s word has ${q.word.length} letters`),
    tiles,
    state.solved ? h('p', { class: 'lead' }, q.clue) : h('div', { class: 'hints' }, hints.map((t) => h('p', { class: 'lead' }, t))),
    h('div', { class: 'actions' },
      !state.solved && state.hints < 4 ? h('button', { class: 'btn soft', tap: async () => { state.hints++; await save(); draw(); } }, state.hints ? 'Another hint' : 'A hint') : null,
      !state.solved ? h('button', { class: 'btn soft', tap: async () => { state.solved = true; state.by = null; await save(); draw(); } }, 'Show the word') : null),
    h('p', { class: 'soft' }, state.solved ? 'A new word tomorrow.' : 'Stuck? Ask Opie for a hint. Got it? Tell Opie your guess.')));
}

const actions = {
  puzzle() { const q = p(); return state.solved ? `Today’s word was ${q.word}. A new one comes tomorrow.` : `Today’s word has ${q.word.length} letters: ${q.letters.map((l) => l.toUpperCase()).join(', ')}. ${q.clue}`; },
  async hint() {
    const q = p(); if (state.solved) return `It’s already solved: ${q.word}.`;
    if (state.hints >= 4) return `That’s all the hints: it starts with ${q.word[0].toUpperCase()} and ends with ${q.word.at(-1).toUpperCase()}, and ${q.clue.toLowerCase()}`;
    const t = HINTS(q)[state.hints]; state.hints++; await save(); draw(); return t;
  },
  async guess({ word, who }) {
    const q = p(), g = String(word || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (g === q.word) { state.solved = true; state.by = who ? String(who).slice(0, 30) : null; await save(); draw(); return `Yes! It’s ${q.word}${who ? `. Well done, ${who}` : ''}.`; }
    if (g.length !== q.word.length) return `Not quite: it has ${q.word.length} letters.`;
    const right = [...g].filter((c, i) => c === q.word[i]).length;
    return `Not ${g}. ${right ? `${right} letter${right === 1 ? ' is' : 's are'} in the right place.` : 'Try again.'}`;
  },
  async reveal() { const q = p(); state.solved = true; state.by = null; await save(); draw(); return `It was ${q.word}. ${q.clue}`; },
};

(async () => {
  await load(); draw();
  whenShown(() => onAction(async (name, args) => { await load(); return actions[name]?.(args) ?? null; }));
  setInterval(async () => { if (state.day !== dayKey()) { await load(); draw(); } }, 60e3);
})();
