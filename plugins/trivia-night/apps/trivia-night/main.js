// Trivia night: Opie hosts, the tablet is the board. "Start trivia with Sam and Dad" deals the questions (app.json
// "start"); Opie reads each one and its four choices from what the page answers; each player's answer comes back as
// a letter (app.json "answer": the voice model hears them and hands over who and which letter, so nothing here reads
// what was said); "next" moves on, "score" says where it stands, "end" finishes. Taps on the board do the same. The
// game is kept in the app's own data (store "game"), so it survives the page reloading.
import { house, store, onAction } from '/kit/openhouse.js';
import { h, and, put, whenShown } from './ui.js';
import { deal, LETTERS } from './questions.js';

const $app = document.getElementById('app');
let game = null; // {players, scores: {name: n}, qs, at: index, answers: {name: 0-3}, shown: bool, over: bool}
let family = [], picking = null;
const save = () => store.set('game', game);
const cur = () => game?.qs[game.at];
const sayQ = () => { const q = cur(); return `Question ${game.at + 1} of ${game.qs.length}: ${q.q} ${q.choices.map((c, i) => `${LETTERS[i]}: ${c}.`).join(' ')}`; };
const standings = () => [...game.players].sort((a, b) => game.scores[b] - game.scores[a]);
const scoreLine = () => standings().map((p) => `${p} ${game.scores[p]}`).join(', ');
const named = (who) => { const w = String(who || '').trim().toLowerCase(); return game?.players.find((p) => p.toLowerCase() === w) || game?.players.find((p) => p.toLowerCase().split(' ')[0] === w.split(' ')[0]) || null; };

async function start(players, n = 10) {
  const ps = [...new Set(players.map((p) => String(p).trim()).filter(Boolean))].slice(0, 8);
  game = { players: ps.length ? ps : ['Everyone'], scores: {}, qs: deal(Math.max(3, Math.min(30, n))), at: 0, answers: {}, shown: false, over: false };
  for (const p of game.players) game.scores[p] = 0;
  await save(); draw();
}
async function answer(p, choice) {
  if (!game || game.over || game.shown) return;
  game.answers[p] = choice; await save(); draw();
}
async function reveal() {
  if (!game || game.shown) return;
  game.shown = true;
  for (const [p, c] of Object.entries(game.answers)) if (c === cur().right) game.scores[p]++;
  await save(); draw();
}
async function next() {
  if (!game) return;
  if (!game.shown) await reveal();
  if (game.at + 1 >= game.qs.length) game.over = true; else { game.at++; game.answers = {}; game.shown = false; }
  await save(); draw();
}

function draw() {
  if (!game) {
    const chosen = picking || new Set(family);
    picking = chosen;
    put($app, h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Trivia night')), h('div', { class: 'empty' },
      h('p', { class: 'lead' }, 'A quiz for the whole family, with Opie as the host.'),
      h('p', { class: 'soft' }, 'Say “let’s play trivia” to Opie, or pick who’s playing and start. Opie reads each question; everyone calls out a letter.'),
      h('div', { class: 'actions' }, family.map((n) => { const b = h('button', { class: 'chip' + (chosen.has(n) ? ' on' : ''), tap: () => { chosen.has(n) ? chosen.delete(n) : chosen.add(n); b.classList.toggle('on'); } }, n); return b; })),
      h('button', { class: 'btn', tap: () => start([...chosen]) }, 'Start a game')));
    return;
  }
  const board = h('div', { class: 'scores' }, standings().map((p, i) => h('div', { class: 'player' + (game.over && i === 0 ? ' lead' : '') },
    h('span', { class: 'dot', style: `background:${house.color(p)}` }), h('span', { class: 'pname' }, p), h('span', { class: 'pts' }, String(game.scores[p])),
    !game.over && !game.shown && game.answers[p] != null ? h('span', { class: 'locked' }, 'in') : null)));
  if (game.over) {
    const top = standings(), best = game.scores[top[0]], winners = top.filter((p) => game.scores[p] === best);
    put($app, h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Trivia night'), h('button', { class: 'btn soft', tap: async () => { game = null; await save(); draw(); } }, 'New game')),
      h('div', { class: 'body' }, h('div', { class: 'big' }, game.players.length > 1 ? `${and(winners)} ${winners.length > 1 ? 'tie' : 'wins'}!` : `${best} of ${game.qs.length}`), board));
    return;
  }
  const q = cur();
  put($app, 
    h('div', { class: 'top' }, h('div', { class: 'label grow' }, `Question ${game.at + 1} of ${game.qs.length}`),
      h('button', { class: 'btn soft', tap: async () => { game.over = true; await save(); draw(); } }, 'End'),
      h('button', { class: 'btn', tap: game.shown ? next : reveal }, game.shown ? (game.at + 1 >= game.qs.length ? 'Finish' : 'Next question') : 'Show the answer')),
    h('div', { class: 'stage' },
      h('div', { class: 'question' }, q.q),
      h('div', { class: 'choices' }, q.choices.map((c, i) => h('button', { class: 'choice' + (game.shown && i === q.right ? ' right' : '') + (game.shown && i !== q.right ? ' wrong' : ''),
        tap: () => { if (picking?.player) { answer(picking.player, i); picking = null; } } },
        h('span', { class: 'letter' }, LETTERS[i]), h('span', {}, c),
        h('span', { class: 'who' }, Object.entries(game.answers).filter(([, a]) => a === i && game.shown).map(([p]) => p).join(', '))))),
      h('div', { class: 'tap' }, game.shown ? null : [h('span', { class: 'hint' }, 'Tap a name, then their letter:'),
        game.players.map((p) => h('button', { class: 'chip' + (picking?.player === p ? ' on' : ''), tap: () => { picking = { player: p }; draw(); } }, p))])),
    board);
}

const actions = {
  async start({ players, questions }) {
    const list = String(players || '').split(/\s*,\s*/).map((p) => family.find((f) => f.toLowerCase() === p.toLowerCase()) || p).filter(Boolean);
    await start(list.length ? list : family, questions || 10);
    return `Trivia night with ${and(game.players)}, ${game.qs.length} questions. Answer with a letter. ${sayQ()}`;
  },
  async answer({ player, letter }) {
    if (!game || game.over) return 'There’s no game on. Say “let’s play trivia” to start one.';
    const p = named(player) || (game.players.length === 1 ? game.players[0] : null);
    if (!p) return `Who said that? Playing: ${and(game.players)}.`;
    const i = LETTERS.indexOf(String(letter || '').toUpperCase());
    if (i < 0) return 'Answer with A, B, C or D.';
    if (game.shown) return 'That one’s done. Say next for the next question.';
    await answer(p, i);
    const waiting = game.players.filter((x) => game.answers[x] == null);
    if (waiting.length) return `${p} says ${LETTERS[i]}. Waiting for ${and(waiting)}.`;
    await reveal();
    const q = cur(), right = game.players.filter((x) => game.answers[x] === q.right);
    return `The answer is ${LETTERS[q.right]}: ${q.choices[q.right]}. ${right.length ? `${and(right)} got it` : 'Nobody got it'}. Say next when you’re ready.`;
  },
  async reveal() {
    if (!game || game.over) return 'There’s no game on.';
    await reveal(); const q = cur();
    return `The answer is ${LETTERS[q.right]}: ${q.choices[q.right]}.`;
  },
  async next() {
    if (!game) return 'There’s no game on.';
    await next();
    if (game.over) { const top = standings(), best = game.scores[top[0]], w = top.filter((p) => game.scores[p] === best); return `That’s the game! ${game.players.length > 1 ? `${and(w)} ${w.length > 1 ? 'tie' : 'wins'} with ${best}.` : `${best} of ${game.qs.length}.`} Final scores: ${scoreLine()}.`; }
    return `Scores: ${scoreLine()}. ${sayQ()}`;
  },
  score() { return game ? `${game.over ? 'Final scores' : `After ${game.at + (game.shown ? 1 : 0)} question${game.at + (game.shown ? 1 : 0) === 1 ? '' : 's'}`}: ${scoreLine()}.` : 'There’s no game on.'; },
  async repeat() { return game && !game.over ? sayQ() : 'There’s no game on.'; },
  async end() { if (!game) return 'There’s no game on.'; game.over = true; await save(); draw(); return `Game over. ${scoreLine()}.`; },
};

(async () => {
  game = await store.get('game');
  draw();
  house.subscribe((hv) => { const f = (hv.family || []).map((p) => p.name).filter(Boolean); if (f.join() !== family.join()) { family = f; picking = null; draw(); } });
  let busy = false; // an ask being done: the game here is the newest
  whenShown(() => onAction(async (name, args) => { busy = true; try { game = await store.get('game'); return await (actions[name]?.(args) ?? null); } finally { busy = false; } }, 1000));
  // another copy of this page (its window, a tab) may have moved the game on
  setInterval(async () => { if (busy || document.hidden) return; const g = await store.get('game'); if (!busy && JSON.stringify(g) !== JSON.stringify(game)) { game = g; draw(); } }, 1500);
})();
