// Chores: a card per person, in their color, with today's chores; tap one when it's done, and it earns a star. Stars add up to rewards each
// kid saves for; a kid asks here and someone says yes on the display's own card (this app never says yes for them). Routines
// (morning, bedtime) show at the top of each person's card during their hours, as pictures kids can follow before they can read. Hold a
// chore (or its … button) to change it, skip it today or take it off; a chore anyone can do asks who did it, and the stars are theirs.
// Hold a reward or step to take it off. Everything lives in the bridge, so the assistant changes it too.
import { house, timer, say, phone, shell } from '/kit/openhouse.js';
import { glyph } from './glyphs.js';

// ---- drawing: small helpers (no framework) ----------------------------------------------------------------
const $app = document.getElementById('app');
const $over = document.body.appendChild(document.createElement('div'));

/** An element: h('div', { class, style, tap, hold, ...attributes }, ...children). tap/hold are touch-first presses. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'tap' || k === 'hold') continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (props?.tap || props?.hold) { press(el, props.tap, props.hold); if (tag !== 'button' && tag !== 'input' && props.tap && !props.role) { el.tabIndex = 0; el.setAttribute('role', 'button'); } }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/** A tap (finger up without moving) and a hold (about half a second), on any element. */
function press(el, tap, hold) {
  let t = 0, x = 0, y = 0, down = false;
  const stop = () => { down = false; clearTimeout(t); };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); down = true; x = e.clientX; y = e.clientY;
    if (hold) t = setTimeout(() => { down = false; hold(e); }, 550);
  });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - x, e.clientY - y) > 14) stop(); });
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('pointerup', (e) => { const was = down; stop(); if (was) { e.stopPropagation(); tap?.(e); } });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // A tap doesn't move the keyboard's focus (it stays in the field being typed in); Tab still reaches everything.
  el.addEventListener('mousedown', (e) => { if (e.target === el || !e.target.closest?.('input, textarea')) e.preventDefault(); });
  // A keyboard (the cover) works it too: Enter or Space taps.
  if (tap) el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el && !el.disabled) { e.preventDefault(); tap(e); } });
}

const ICONS = { plus: '<path d="M12 4.5v15M4.5 12h15"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', left: '<path d="M14.5 5.5L8 12l6.5 6.5"/>', right: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>', dots: '<circle cx="5.5" cy="12" r=".6"/><circle cx="12" cy="12" r=".6"/><circle cx="18.5" cy="12" r=".6"/>' };
const icon = (name, cls = '') => h('span', { class: 'icon ' + cls, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });
const STAR = [...Array(10)].map((_, i) => { const a = Math.PI / 5 * i - Math.PI / 2, r = i % 2 ? 22.5 : 50; return `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
const star = (color, size) => h('span', { class: 'star', style: `width:calc(${size} * var(--u));height:calc(${size} * var(--u))`, 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 100 100"><polygon fill="${color}" points="${STAR}"/></svg>` });

const btn = (label, tap, { soft = false, color = null, disabled = false, cls = '' } = {}) =>
  h('button', { class: `btn ${soft ? 'soft' : ''} ${cls}`, style: color && !soft ? `background:${color}` : null, disabled, tap: disabled ? null : tap }, label);
/** A pill to choose with; with a color it's a person's: their initial on it, then their name. */
const chip = (label, on, tap, color = null) => (color
  ? h('button', { class: 'q-who' + (on ? ' on' : ''), tap }, h('span', { class: 'q-av sm', style: `background:${color}` }, label.slice(0, 1).toUpperCase()), label)
  : h('button', { class: 'chip' + (on ? ' on' : ''), tap }, label));
/** A line picture (glyphs.js), drawn in the text color. */
const gl = (name, cls = '') => h('span', { class: 'gl ' + cls, 'aria-hidden': 'true', html: glyph(name) });
const round = (name, tap, { dark = false, disabled = false, label = null } = {}) =>
  h('button', { class: 'round' + (dark ? ' dark' : ''), disabled, 'aria-label': label, tap: disabled ? null : tap }, icon(name));
/** A person's card: their color (--c) from a little lighter at the top to a little deeper and a step round the wheel
 *  at the foot, and the ink that reads on it (--pi). */
function paint(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return `--c:${hex}`;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min, s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const hue = ((!d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  const dir = hue < 100 || hue > 300 ? -1 : 1; // warm colors deepen toward red, cool ones toward violet
  const at = (dh, dl, ds = 1) => `hsl(${((hue + dir * dh + 360) % 360).toFixed(0)} ${(s * 100 * ds).toFixed(0)}% ${Math.max(8, Math.min(92, l * 100 + dl)).toFixed(0)}%)`;
  return `--c:${hex};${l < .45 ? '--pi:#fff;--on-pi:#15132b;' : ''}background:linear-gradient(165deg, ${at(-5, 7)}, ${at(5, -3)} 72%, ${at(16, -7, .94)})`;
}
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Redraw an element's insides, keeping where each [data-keep] part was scrolled to. */
function keepScroll(root, fn) {
  const at = {};
  root.querySelectorAll('[data-keep]').forEach((e) => { at[e.dataset.keep] = [e.scrollLeft, e.scrollTop]; });
  fn();
  root.querySelectorAll('[data-keep]').forEach((e) => { const v = at[e.dataset.keep]; if (v) { e.scrollLeft = v[0]; e.scrollTop = v[1]; } });
}

// ---- cards over the app (a stack: a card can open another) ----
const sheets = [];
function openSheet(el, redraw = null) {
  const s = { el, redraw: () => redraw?.(s), close: () => { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); el.remove(); } };
  sheets.push(s); $over.append(el); s.redraw();
  return s;
}
/** A card in the middle; render(close) gives its insides (drawn again when the house changes). Tapping outside closes it. */
function openCard(render, { width = 720, onOutside = null } = {}) {
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', style: `width:calc(${width} * var(--u))`, tap: () => {} });
  let s;
  const scrim = h('div', { class: 'scrim', role: 'none', tap: () => (onOutside ? onOutside(s.close) : s.close()) }, card);
  s = openSheet(scrim, (me) => keepScroll(card, () => card.replaceChildren(...[render(me.close)].flat().filter(Boolean))));
  return s;
}
/** "Take it off?": a question, the kind answer, and the other one. */
function confirmCard(title, yes, onYes, no = 'Keep it', onNo = null) {
  return openCard((close) => [
    h('h2', { class: 'big' }, title),
    h('div', { class: 'actions' }, btn(no, () => { close(); onNo?.(); }, { soft: true }), btn(yes, () => { close(); onYes(); }, { color: 'var(--accent)' })),
  ], { onOutside: (close) => { close(); onNo?.(); } });
}
/** What the tablet said no to (a list that's full): its reason, and OK. */
function told(r) { if (r?.error) openCard((close) => [h('h2', null, r.error), h('div', { class: 'actions' }, btn('OK', close))]); }
/** Asks for a few words with the keyboard (an item, a chore, a meal). extra(): more choices under the field. */
function ask({ title, hint = '', initial = '', extra = null, onDone }) {
  const input = h('input', { class: 'field', placeholder: hint, enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  input.value = initial;
  const more = h('div', { class: 'extra' });
  let s;
  const finish = () => { const t = input.value.trim(); if (!t) return; input.blur(); s.close(); onDone(t); };
  const done = btn('Done', null, { disabled: !initial.trim() });
  input.addEventListener('input', () => { done.disabled = !input.value.trim(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(); } });
  const cancel = btn('Cancel', () => { input.blur(); s.close(); }, { soft: true });
  // (Done is re-armed as the text changes, so its tap reads the field when pressed.)
  press(done, () => { if (!done.disabled) finish(); });
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', tap: () => {} }, h('h2', null, title), input, more, h('div', { class: 'actions' }, cancel, done));
  const scrim = h('div', { class: 'scrim high', tap: () => { input.blur(); s.close(); } }, card);
  s = openSheet(scrim, (me) => keepScroll(more, () => more.replaceChildren(...[extra?.(me)].flat().filter(Boolean))));
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  return s;
}

// ---- chores, rewards, routines -----------------------------------------------------------------------------
/** Star choices when adding a reward. */
const REWARD_STARS = [5, 10, 20, 30, 50];
/** When a routine can show (start, end). */
const HOURS = [['06:00', '08:00'], ['06:30', '09:00'], ['07:00', '09:30'], ['15:00', '18:00'], ['19:00', '21:00'], ['19:30', '21:30']];
/** Routines to start from: name, hours, steps (text, picture). */
const ROUTINES = [
  ['Morning', ['06:30', '09:00'], [['Get dressed', 'shirt'], ['Breakfast', 'plate'], ['Brush teeth', 'teeth'], ['Shoes on', 'shoes'], ['Backpack', 'backpack']]],
  ['After school', ['15:00', '18:00'], [['Coat away', 'coat'], ['Snack', 'cup'], ['Homework', 'book'], ['Tidy up', 'toys']]],
  ['Bedtime', ['19:00', '21:00'], [['Bath', 'bath'], ['Pajamas', 'shirt'], ['Brush teeth', 'teeth'], ['Read a book', 'book'], ['Bed', 'bed']]],
];
/** Stars a chore can be worth. */
const CHORE_STARS = [1, 2, 3, 5];
const WEEK = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

let H = null, tab = 'today', rewardsFor = null, asked = null;

function draw() {
  keepScroll($app, () => $app.replaceChildren(screen()));
  for (const s of sheets) s.redraw?.();
  manualAsk();
}

const starsOf = (name) => Object.entries(H.stars || {}).find(([k]) => same(k, name))?.[1] ?? 0;
const isDone = (r, step, who) => r.done.some((k) => same(k, `${step.text}|${who}`));
const clock = (hhmm) => {
  const hr = parseInt(hhmm.slice(0, 2), 10); if (isNaN(hr)) return hhmm;
  const m = hhmm.slice(-2);
  return `${hr % 12 === 0 ? 12 : hr % 12}${m === '00' ? '' : ':' + m} ${hr < 12 ? 'AM' : 'PM'}`;
};
/** What was just ticked (it pops once, not on every redraw). */
const fresh = new Set();

// changes show at once; the bridge's next update confirms them
function choreDone(c, done, by = null) {
  // A chore anyone can do: who did it gets its stars (asked first).
  if (done && !c.who.trim() && !by) return whoDidIt(c);
  c.done = done; c.by = done ? by : null; c.skipped = false; c.week = Math.max(0, c.week + (done ? 1 : -1)); if (done) fresh.add(c); draw(); fresh.clear(); house.choreDone(c.who, c.task, done, by);
}
function whoDidIt(c) {
  const s = openCard((close) => [
    h('h2', { class: 'big' }, `Who did “${c.task}”?`),
    h('div', { class: 'chips wrap' }, (H.family || []).map((p) => chip(p.name, false, () => { close(); choreDone(c, true, p.name); }, house.color(p.name)))),
    h('div', { class: 'actions' }, btn('Cancel', close, { soft: true })),
  ], { width: 760 });
  return s;
}
/** A chore up close: change it, skip it today, or take it off. */
/** Every few days: [days, label]. */
const EVERY = [[2, '2 days'], [3, '3 days'], [7, 'week'], [14, '2 weeks'], [30, 'month']];
function choreCard(c) {
  const f = { task: c.task, who: c.who, days: [...(c.days || [])], stars: c.stars || 1, pic: c.pic || 'star', keep: !!c.keep, every: c.every || 0, after: !!c.after };
  const input = h('input', { class: 'field', enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  input.value = f.task; input.addEventListener('input', () => { f.task = input.value; });
  const s = openCard((close) => [
    h('h2', null, 'Chore'),
    input,
    h('div', { class: 'chips wrap' }, (H.family || []).map((p) => chip(p.name, same(f.who, p.name), () => { f.who = p.name; s.redraw(); }, house.color(p.name))),
      chip('Anyone', !f.who.trim(), () => { f.who = ''; s.redraw(); })),
    h('div', { class: 'chips wrap' }, chip('Every day', !f.days.length && !f.every, () => { f.days = []; f.every = 0; s.redraw(); }),
      WEEK.map(([k, label]) => chip(label, !f.every && f.days.includes(k), () => { if (f.every) { f.every = 0; f.days = []; } f.days = f.days.includes(k) ? f.days.filter((x) => x !== k) : [...f.days, k]; s.redraw(); }))),
    // or every few days: from today, or that long after it was last done (the sheets a week after they were changed)
    h('div', { class: 'chips wrap' }, h('span', { class: 'chip-label' }, 'Or every'),
      EVERY.map(([n, label]) => chip(label, f.every === n, () => { f.every = f.every === n ? 0 : n; f.days = []; s.redraw(); }))),
    f.every ? h('div', { class: 'chips wrap' }, chip('Counting from today', !f.after, () => { f.after = false; s.redraw(); }), chip('Counting from when it’s done', f.after, () => { f.after = true; s.redraw(); })) : null,
    f.days.length || (f.every && !f.after) ? h('div', { class: 'chips wrap' }, chip('Gone after its day', !f.keep, () => { f.keep = false; s.redraw(); }), chip('Stays until done', f.keep, () => { f.keep = true; s.redraw(); })) : null,
    h('div', { class: 'chips wrap' }, h('span', { class: 'chip-label' }, 'Stars'), CHORE_STARS.map((n) => chip(String(n), f.stars === n, () => { f.stars = n; s.redraw(); }))),
    h('div', { class: 'pick-row hscroll', 'data-keep': 'chore-pics' },
      PICS.map((p) => h('button', { class: 'pick' + (p === f.pic ? ' on' : ''), 'aria-label': p, tap: () => { f.pic = p; s.redraw(); } }, gl(lineOf(p))))),
    h('div', { class: 'actions' },
      btn('Take it off', () => { close(); confirmCard(`Take off “${c.task}”?`, 'Take it off', () => { H.chores = H.chores.filter((x) => x !== c); draw(); house.removeChore(c.who, c.task); }); }, { soft: true }),
      btn(c.skipped ? 'Back on today' : 'Skip today', () => { close(); c.skipped = !c.skipped; if (c.skipped) c.done = false; draw(); house.skipChore(c.who, c.task, c.skipped); }, { soft: true }),
      btn('Cancel', close, { soft: true }),
      btn('Save', () => {
        const task = f.task.trim() || c.task; close();
        const to = { task, who: f.who, days: f.every ? [] : f.days, stars: f.stars, pic: f.pic, keep: f.days.length || (f.every && !f.after) ? f.keep : false,
          every: f.every, after: f.every ? f.after : false }, was = { who: c.who, task: c.task };
        Object.assign(c, to); draw(); house.updateChore(was.who, was.task, to);
      })),
  ], { width: 860 });
  return s;
}
function checkStep(r, s, who, done) {
  const k = `${s.text}|${who.toLowerCase()}`;
  r.done = done ? [...r.done, k] : r.done.filter((x) => !same(x, k)); if (done) fresh.add(r.id + '|' + k); draw(); fresh.clear(); house.checkStep(r.id, s.text, who, done);
}
function updateRoutine(r, change) {
  Object.assign(r, change); draw();
  house.updateChecklist({ id: r.id, steps: r.steps, from: r.from, to: r.to, who: r.who });
}

function screen() {
  if (!H) return h('div');
  const tabTo = (t) => () => { tab = t; draw(); };
  const day = new Date((H.today || '') + 'T12:00'), weekday = isNaN(day) ? '' : day.toLocaleDateString('en-US', { weekday: 'long' });
  return h('div', { class: 'screen' },
    h('div', { class: 'top' },
      h('h1', { class: 'title' }, tab === 'rewards' ? 'Rewards' : tab === 'routines' ? 'Routines' : ['Chores ', h('span', null, weekday)]),
      h('div', { class: 'q-seg' }, [['today', 'Today'], ['rewards', 'Rewards'], ['routines', 'Routines']].map(([t, label]) =>
        h('button', { class: tab === t ? 'on' : '', tap: tabTo(t) }, label))),
      tab === 'today' ? round('plus', addChore, { dark: true, label: 'Add a chore' }) : null),
    tab === 'rewards' ? rewards() : tab === 'routines' ? routines() : today());
}

// A reward asked for: someone says yes on the display's own card, with the PIN. This app never answers it
// (it used to, where the display had no card of its own, and any kid could tap Yes); the reward shows it's waiting.
function manualAsk() {
  if (asked) { asked.card.close(); asked = null; }
}

// ---- today ----

/** On a phone: whose chores to show (a name), or everyone's. */
let only = null;
/** The line picture for a chore's or step's picture. */
const LINE = { shirt: 't-shirt', coat: 't-shirt', teeth: 'tooth', shoes: 'sneaker', bath: 'bathtub', book: 'book-open', plate: 'fork-knife', hands: 'drop', hair: 'comb', toys: 'puzzle-piece', cup: 'coffee', pet: 'paw-print', laundry: 'washing-machine' };
const lineOf = (p) => LINE[p] || p || 'star';
const inFamily = (name) => (H.family || []).some((p) => same(p.name, name));

function today() {
  const chores = (H.chores || []).filter((c) => c.today), routines = (H.checklists || []).filter((r) => r.now);
  // One card per person (in family order), then anyone else's; the ones for everybody are under them.
  const names = (H.family || []).map((p) => p.name);
  const others = [...new Set(chores.map((c) => c.who).filter((w) => w.trim() && !names.some((n) => same(n, w))))];
  const forOne = (n) => routines.filter((r) => !r.who.length || r.who.some((w) => same(w, n)));
  const columns = [...names, ...others].map((n) => [n, chores.filter((c) => same(c.who, n))])
    .filter(([n, list]) => list.length || forOne(n).length);
  const everyone = chores.filter((c) => !c.who.trim()), saving = savingUp();
  if (!columns.length && !everyone.length) return h('div', { class: 'none' }, h('h2', null, 'No chores yet'), btn('Add a chore', addChore));
  if (!columns.some(([n]) => n === only)) only = null;
  // up to four across fill the screen (never wider than a third of it); more scroll sideways
  const across = columns.length <= 4 ? Math.max(3, columns.length) : 4.3;
  const left = (list) => list.filter((c) => !c.done && !c.skipped).length;
  return h('div', { class: 'today', 'data-keep': 'today' },
    // on a phone: who has what left (tap one for just theirs), and a way to add a chore at the end
    h('div', { class: 'who-row', 'data-keep': 'who-row' },
      columns.length > 1 ? h('button', { class: 'wt' + (only ? '' : ' on'), tap: () => { only = null; draw(); } }, h('span', { class: 'q-av all' }, 'All'), 'Everyone') : null,
      columns.map(([n, list]) => h('button', { class: 'wt' + (only === n ? ' on' : ''), 'aria-label': n, tap: () => { only = only === n ? null : n; draw(); } },
        h('span', { class: 'q-av', style: inFamily(n) ? `background:${house.color(n)}` : null }, n.slice(0, 1).toUpperCase()), left(list) ? `${left(list)} left` : list.length ? 'Done' : n)),
      h('button', { class: 'wt', 'aria-label': 'Add a chore', tap: addChore }, h('span', { class: 'q-av none' }, icon('plus')), 'Add')),
    columns.length ? h('div', { class: 'cols hscroll', 'data-keep': 'columns', style: `grid-auto-columns:calc((100% - ${(Math.ceil(across) - 1) * 16} * var(--u)) / ${across})` },
      columns.filter(([n]) => !only || n === only).map(([name, list]) => person(name, list, forOne(name)))) : null,
    everyone.length || saving.length ? h('div', { class: 'bot' + (everyone.length && saving.length ? '' : ' one') },
      everyone.length ? h('section', { class: 'q-panel any' },
        h('div', { class: 'q-label' }, 'Up for grabs · anyone'),
        h('div', { class: 'any-list vscroll', 'data-keep': 'anyone' }, everyone.map((c) => choreRow(c)))) : null,
      saving.length ? h('section', { class: 'q-panel rew', tap: () => { tab = 'rewards'; rewardsFor = saving[0].who; draw(); } },
        h('div', { class: 'q-label' }, 'Saving up for'),
        h('div', { class: 'rew-grid' }, saving.map(({ r, who, have }) => h('div', { style: `--c:${house.color(who)}` },
          h('div', { class: 'rw' }, h('span', { class: 'gi' }, gl('gift')), h('div', null, h('b', null, r.title), h('span', null, `${who} · ${Math.min(have, r.stars)} of ${r.stars} stars`))),
          h('div', { class: 'meter' }, h('div', { style: `width:${Math.min(100, Math.max(0, have / r.stars * 100))}%` })))))) : null) : null);
}

/** What the stars are going toward, the closest first (two fit): each reward with whose it is, or whoever has the most stars for it. */
function savingUp() {
  const out = [];
  for (const r of H.rewards || []) {
    if (!(r.stars > 0)) continue;
    const who = r.who ? (H.family || []).find((p) => same(p.name, r.who))?.name
      : (H.family || []).map((p) => p.name).filter((n) => starsOf(n) > 0).sort((a, b) => starsOf(b) - starsOf(a))[0];
    if (who) out.push({ r, who, have: starsOf(who) });
  }
  out.sort((a, b) => b.have / b.r.stars - a.have / a.r.stars);
  const first = out.filter((x, i) => out.findIndex((y) => y.who === x.who) === i); // one each before anyone's second
  return [...first, ...out.filter((x) => !first.includes(x))].slice(0, 2);
}

function person(name, chores, routines) {
  const mine = inFamily(name), count = chores.filter((c) => !c.skipped).length, done = chores.filter((c) => c.done).length;
  const allDone = chores.length > 0 && chores.every((c) => c.done || c.skipped) && routines.every((r) => r.steps.every((s) => isDone(r, s, name)));
  const next = chores.find((c) => !c.done && !c.skipped), stars = mine ? starsOf(name) : 0, around = 2 * Math.PI * 32;
  return h('section', { class: 'pc' + (mine ? '' : ' plain') + (stars > 0 ? ' starred' : ''), style: mine ? paint(house.color(name)) : null },
    // what's next, large and faint in the corner, while there's room under the rows for it
    !allDone && next && !routines.length && chores.length <= 4 ? gl(lineOf(next.pic), 'deco') : null,
    h('div', { class: 'pc-top' },
      // their initial in a ring that closes as the day's chores get done
      h('div', { class: 'ring' },
        h('span', { 'aria-hidden': 'true', html: `<svg viewBox="0 0 76 76"><circle class="track" cx="38" cy="38" r="32" stroke-width="8"/>${done && count ? `<circle class="arc" cx="38" cy="38" r="32" stroke-width="8" stroke-dasharray="${(around * done / count).toFixed(1)} ${around.toFixed(1)}"/>` : ''}</svg>` }),
        h('b', null, name.slice(0, 1).toUpperCase())),
      h('div', { class: 'name-box' }, h('h2', { class: 'pname' }, name),
        chores.length ? h('div', { class: 'of' }, `${allDone ? 'All done' : `${done} of ${count} done`}${H.streaks?.[name] ? ` · ${H.streaks[name]} days in a row` : ''}`) : null),
      stars > 0 ? h('span', { class: 'starpill' }, star('#ffd35c', 19), String(stars)) : null),
    h('div', { class: 'pc-list vscroll', 'data-keep': 'p-' + name },
      routines.map((r) => routineSteps(r, name)),
      chores.map((c) => choreRow(c))),
    allDone ? h('div', { class: 'alld' }, gl('trophy'), 'All done today') : null);
}

/** A routine's steps as big pictures, two to a row; tap one when it's done. */
function routineSteps(r, who) {
  return h('div', { class: 'routine' },
    h('div', { class: 'rt-name' }, r.name),
    h('div', { class: 'steps' }, r.steps.map((s) => {
      const done = isDone(r, s, who);
      return h('div', { class: 'stp' + (done ? ' done' : ''), tap: () => checkStep(r, s, who, !done) },
        h('div', { class: 'pic-wrap' }, pic(s.pic, 'pic'), done ? h('span', { class: 'tick' + (fresh.has(r.id + '|' + `${s.text}|${who.toLowerCase()}`) ? ' pop' : '') }, icon('check')) : null),
        h('div', { class: 'stp-text' }, s.text));
    })));
}

/** A chore: tap it when it's done; hold it (or tap its picture) to change it. */
function choreRow(c) {
  return h('div', { class: 'ch' + (c.done ? ' done' : '') + (c.skipped ? ' skipped' : '') + (fresh.has(c) ? ' pop' : ''), tap: () => (c.skipped ? choreCard(c) : choreDone(c, !c.done)), hold: () => choreCard(c) },
  h('span', { class: 'ck' }, c.done ? icon('check') : null),
  h('span', { class: 'task' }, h('span', { class: 't' }, c.task), c.skipped ? h('span', { class: 'sub' }, 'Skipped today') : c.by ? h('span', { class: 'sub' }, c.by)
    : c.late ? h('span', { class: 'sub late' }, c.late === 1 ? 'From yesterday' : `${c.late} days late`) : null),
  (c.stars || 1) > 1 ? h('span', { class: 'worth' }, star('currentColor', 15), String(c.stars)) : null,
  h('button', { class: 'g', 'aria-label': 'Change', tap: () => choreCard(c) }, gl(lineOf(c.pic))));
}

function addChore() {
  let who = H.family?.[0]?.name || '', days = [], stars = 1;
  ask({ title: 'New chore', hint: 'Feed the cat',
    extra: (s) => [
      h('div', { class: 'chips', 'data-keep': 'who' },
        (H.family || []).map((p) => chip(p.name, who === p.name, () => { who = p.name; s.redraw(); }, house.color(p.name))),
        chip('Anyone', who === '', () => { who = ''; s.redraw(); })),
      h('div', { class: 'chips', 'data-keep': 'days' },
        chip('Every day', !days.length, () => { days = []; s.redraw(); }),
        WEEK.map(([k, label]) => chip(label, days.includes(k), () => { days = days.includes(k) ? days.filter((x) => x !== k) : [...days, k]; s.redraw(); }))),
      h('div', { class: 'chips', 'data-keep': 'stars' }, h('span', { class: 'chip-label' }, 'Stars'), CHORE_STARS.map((n) => chip(String(n), stars === n, () => { stars = n; s.redraw(); }))),
    ],
    onDone: (task) => {
      H.chores = [...(H.chores || []), { who, task, today: true, done: false, week: 0, days, stars }]; draw();
      house.addChore(who, task, days, stars).then(told);
    } });
}

// ---- rewards ----

function rewards() {
  const kids = H.family?.length ? H.family.map((p) => p.name) : Object.keys(H.stars || {});
  if (!kids.some((k) => k === rewardsFor)) rewardsFor = kids[0] || '';
  const who = rewardsFor, have = starsOf(who);
  const list = (H.rewards || []).filter((r) => !r.who || same(r.who, who));
  return h('div', { class: 'rewards' },
    h('div', { class: 'kids chips', 'data-keep': 'kids' },
      kids.map((k) => h('button', { class: 'q-who' + (k === who ? ' on' : ''), tap: () => { rewardsFor = k; draw(); } },
        h('span', { class: 'q-av sm', style: `background:${house.color(k)}` }, k.slice(0, 1).toUpperCase()), k,
        h('span', { class: 'kstars' }, star('var(--gold)', 16), String(starsOf(k))))),
      h('span', { class: 'gap' }),
      btn('New reward', () => addReward(kids), { soft: true })),
    list.length ? h('div', { class: 'rw-grid vscroll', 'data-keep': 'rewards' }, list.map((r) => rewardCard(r, who, have)))
      : h('div', { class: 'none top-gap' }, h('h2', null, 'No rewards yet'), h('p', null, 'Pick something to save stars for, like a movie night.')),
    H.got?.[0] ? h('p', { class: 'last' }, `Last reward: ${H.got[0].who}, ${H.got[0].title}`) : null);
}

function rewardCard(r, who, have) {
  const waiting = (H.asks || []).some((a) => a.reward === r.id && same(a.who, who));
  return h('div', { class: 'q-panel rw-card', style: `--c:${house.color(who)}`,
    hold: () => confirmCard(`Take off “${r.title}”?`, 'Take it off', () => { H.rewards = H.rewards.filter((x) => x !== r); draw(); house.removeReward(r.id); }) },
  h('div', { class: 'rw' }, h('span', { class: 'gi' }, gl('gift')), h('div', null, h('b', null, r.title), h('span', null, `${Math.min(have, r.stars)} of ${r.stars} stars`))),
  // how close: a bar that fills with their stars
  h('div', { class: 'meter' }, h('div', { style: `width:${Math.min(100, Math.max(0, have / r.stars * 100))}%` })),
  waiting ? h('div', { class: 'rw-note strong' }, 'Asking…')
    : have >= r.stars ? btn('Get it!', () => {
      H.asks = [...(H.asks || []), { id: 'new', who, reward: r.id, title: r.title, stars: r.stars, manual: false }]; draw();
      house.redeem(who, r.id); // someone says yes on the display's own card
    }, { cls: 'wide' })
      : h('div', { class: 'rw-note' }, `${r.stars - have} more to go`));
}

function addReward(kids) {
  let stars = 20, who = null;
  ask({ title: 'New reward', hint: 'Movie night',
    extra: (s) => [
      h('div', { class: 'chips' }, REWARD_STARS.map((n) => chip(`${n} stars`, stars === n, () => { stars = n; s.redraw(); }))),
      h('div', { class: 'chips', 'data-keep': 'who' }, chip('Anyone', who === null, () => { who = null; s.redraw(); }),
        kids.map((k) => chip(k, who === k, () => { who = k; s.redraw(); }, house.color(k)))),
    ],
    onDone: (title) => house.addReward(title, stars, who) });
}

// ---- routines ----

function routines() {
  const list = H.checklists || [];
  const missing = ROUTINES.filter(([name]) => !list.some((r) => same(r.name, name)));
  return h('div', { class: 'routines vscroll', 'data-keep': 'routines' },
    list.map((r) => h('div', { class: 'q-panel rt-card', hold: () => confirmCard(`Take off the ${r.name} routine?`, 'Take it off', () => {
      H.checklists = H.checklists.filter((x) => x.id !== r.id); draw(); house.removeChecklist(r.id);
    }) },
    h('h2', null, r.name),
    // when it shows: tap one
    h('div', { class: 'chips', 'data-keep': 'hours-' + r.id },
      [...HOURS, [r.from, r.to]].filter(([f, t], i, all) => all.findIndex(([a, b]) => a === f && b === t) === i)
        .map(([f, t]) => chip(`${clock(f)} – ${clock(t)}`, r.from === f && r.to === t, () => updateRoutine(r, { from: f, to: t })))),
    // whose: tap to change
    h('div', { class: 'chips', 'data-keep': 'who-' + r.id },
      chip('Everyone', !r.who.length, () => updateRoutine(r, { who: [] })),
      (H.family || []).map((p) => {
        const on = r.who.some((w) => same(w, p.name));
        return chip(p.name, on, () => updateRoutine(r, { who: on ? r.who.filter((w) => !same(w, p.name)) : [...r.who, p.name] }), house.color(p.name));
      })),
    h('div', { class: 'stp-row hscroll', 'data-keep': 'steps-' + r.id },
      r.steps.map((s) => h('div', { class: 'stp-tile', hold: () => confirmCard(`Take off “${s.text}”?`, 'Take it off', () => updateRoutine(r, { steps: r.steps.filter((x) => x !== s) })) },
        pic(s.pic, 'pic'), h('div', { class: 'stp-text' }, s.text))),
      h('button', { class: 'round dark add-step', 'aria-label': 'Add a step', tap: () => addStep(r) }, icon('plus'))))),
    !list.length ? h('p', { class: 'hint' }, 'Routines show at the top of each person’s chores during their hours, in pictures.') : null,
    missing.length ? h('div', { class: 'actions start' }, missing.map(([name, [from, to], steps]) =>
      btn(`Add ${name}`, () => house.addChecklist({ name, from, to, steps: steps.map(([text, p]) => ({ text, pic: p })) }), { soft: true }))) : null);
}

function addStep(r) {
  let chosen = 'star';
  ask({ title: `New step for ${r.name}`, hint: 'Brush teeth',
    extra: (s) => h('div', { class: 'chips', 'data-keep': 'pics' },
      PICS.map((p) => h('button', { class: 'pick' + (p === chosen ? ' on' : ''), 'aria-label': p, tap: () => { chosen = p; s.redraw(); } }, pic(p)))),
    onDone: (text) => updateRoutine(r, { steps: [...r.steps, { text, pic: chosen }] }) });
}

// ---- the routine pictures, drawn flat (no emoji, no words), so kids who can't read yet know the step ----
const PICS = ['sun', 'moon', 'shirt', 'teeth', 'shoes', 'backpack', 'bed', 'bath', 'book', 'plate', 'hands', 'hair', 'toys', 'cup', 'coat', 'pet', 'star', 'plant', 'trash', 'laundry', 'broom'];
const C = { ink: '#2b2a28', blue: '#5b8def', red: '#e5604d', yellow: '#f4c542', green: '#5dbb7e', brown: '#b07a4f', pink: '#f29bb6', water: '#9ccbf5', orange: '#f2994a', white: '#fff' };
const OUT = `stroke="${C.ink}" stroke-width="4" stroke-linejoin="round"`;
const box = (c, x, y, w, ht, r = 6, outline = false) => `<rect x="${x}" y="${y}" width="${w}" height="${ht}" rx="${r}" fill="${c}"${outline ? ' ' + OUT : ''}/>`;
const ln = (c, x1, y1, x2, y2, w = 5, op = 1) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"${op < 1 ? ` stroke-opacity="${op}"` : ''}/>`;
const poly = (c, ...p) => `<polygon fill="${c}" points="${p.join(' ')}"/>`;
const dot = (c, x, y, r, outline = false) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"${outline ? ' ' + OUT : ''}/>`;
const bubbles = (list) => list.map(([x, y, r]) => dot(C.water, x, y, r, true)).join('');
let masks = 0;
const DRAW = {
  sun: () => [...Array(8)].map((_, i) => { const a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a); return ln(C.orange, 50 + 30 * c, 50 + 30 * s, 50 + 42 * c, 50 + 42 * s, 7); }).join('') + dot(C.yellow, 50, 50, 22),
  moon: () => { const id = 'moon' + masks++; return `<mask id="${id}"><rect width="100" height="100" fill="#fff"/><circle cx="66" cy="38" r="30" fill="#000"/></mask>`
    + `<circle cx="50" cy="50" r="32" fill="${C.yellow}" mask="url(#${id})"/>` + dot(C.yellow, 80, 78, 4) + dot(C.yellow, 88, 64, 3); },
  shirt: (coat = false) => { const c = coat ? C.orange : C.blue, bottom = coat ? 90 : 84, cuff = coat ? 70 : 48;
    return poly(c, 30, 20, 42, 16, 50, 24, 58, 16, 70, 20, 90, 36, 80, cuff, 70, 42, 70, bottom, 30, bottom, 30, 42, 20, cuff, 10, 36)
      + (coat ? ln(C.ink, 50, 26, 50, 90, 3, .5) + dot(C.white, 58, 50, 3) + dot(C.white, 58, 66, 3) : ''); },
  coat: () => DRAW.shirt(true),
  teeth: () => box(C.blue, 6, 62, 66, 12, 6) + box(C.blue, 60, 56, 34, 18, 7) + box(C.white, 62, 38, 30, 18, 4, true)
    + [0, 1, 2, 3].map((i) => ln(C.water, 68 + i * 6, 42, 68 + i * 6, 54, 3)).join('')
    + `<path d="M60 34C66 22 76 30 80 24C86 30 92 26 96 34Z" fill="${C.water}"/>`,
  shoes: () => poly(C.red, 14, 66, 14, 38, 34, 38, 52, 54, 84, 58, 90, 66) + box(C.white, 10, 64, 82, 12, 6, true)
    + [0, 1, 2].map((i) => ln(C.white, 30 + i * 7, 44 + i * 4, 38 + i * 7, 44 + i * 4, 3)).join(''),
  backpack: () => `<path d="M36 26A14 12 0 0 1 64 26" fill="none" stroke="${C.ink}" stroke-width="5"/>` + box(C.green, 24, 24, 52, 64, 16) + box('#3f9a61', 33, 56, 34, 24, 8) + ln(C.white, 40, 62, 60, 62, 3),
  bed: () => box(C.brown, 10, 30, 8, 54, 3) + box(C.brown, 84, 50, 8, 34, 3) + box(C.white, 16, 54, 72, 14, 4, true) + box(C.blue, 40, 46, 50, 22, 6) + box(C.white, 20, 42, 22, 12, 6, true),
  bath: () => bubbles([[34, 34, 8], [50, 26, 6], [62, 36, 9], [44, 42, 5]]) + box(C.water, 12, 46, 76, 10, 4) + box(C.white, 10, 50, 80, 26, 12, true) + ln(C.ink, 22, 76, 18, 86) + ln(C.ink, 78, 76, 82, 86),
  book: () => poly(C.blue, 50, 26, 14, 20, 14, 76, 50, 82) + poly(C.red, 50, 26, 86, 20, 86, 76, 50, 82) + ln(C.ink, 50, 26, 50, 82, 3)
    + [0, 1, 2].map((i) => ln(C.white, 22, 36 + i * 10, 42, 39 + i * 10, 3) + ln(C.white, 58, 39 + i * 10, 78, 36 + i * 10, 3)).join(''),
  plate: () => dot(C.white, 50, 52, 30, true) + `<circle cx="50" cy="52" r="19" fill="none" stroke="${C.ink}" stroke-opacity=".25" stroke-width="4"/>`
    + ln(C.ink, 10, 40, 10, 84, 4) + [6, 10, 14].map((x) => ln(C.ink, x, 22, x, 40, 3)).join('') + box(C.ink, 86, 22, 6, 62, 3),
  hands: () => bubbles([[36, 36, 9], [56, 28, 7], [66, 44, 10], [46, 48, 6]]) + box(C.pink, 22, 56, 56, 26, 10, true) + ln(C.white, 32, 64, 52, 64, 4),
  hair: () => box(C.orange, 14, 36, 72, 16, 6) + [...Array(10)].map((_, i) => ln(C.orange, 19 + i * 7, 50, 19 + i * 7, 72, 4)).join(''),
  toys: () => dot(C.red, 36, 38, 15) + box(C.blue, 52, 26, 26, 26, 4) + box(C.brown, 14, 50, 72, 36, 6) + box('#8e5d38', 14, 50, 72, 8, 4),
  cup: () => poly(C.water, 30, 44, 70, 44, 66, 86, 34, 86) + `<polygon points="26,18 74,18 66,86 34,86" fill="none" ${OUT}/>`,
  pet: () => `<ellipse cx="50" cy="66" rx="22" ry="18" fill="${C.brown}"/>` + [[20, 38], [36, 20], [58, 20], [76, 38]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="9" ry="11" fill="${C.brown}"/>`).join(''),
  plant: () => ln(C.green, 50, 64, 50, 30, 5) + `<ellipse cx="36" cy="40" rx="14" ry="8" fill="${C.green}" transform="rotate(-30 36 40)"/>`
    + `<ellipse cx="64" cy="32" rx="14" ry="8" fill="${C.green}" transform="rotate(30 64 32)"/>` + `<ellipse cx="50" cy="22" rx="7" ry="11" fill="#3f9a61"/>`
    + poly(C.orange, 28, 60, 72, 60, 66, 90, 34, 90) + box('#d9822f', 25, 56, 50, 9, 3),
  trash: () => box('#8c9399', 22, 32, 56, 56, 6) + box('#6d747a', 16, 22, 68, 12, 4) + box('#6d747a', 40, 14, 20, 10, 4)
    + [36, 50, 64].map((x) => ln(C.white, x, 44, x, 78, 4, .6)).join(''),
  laundry: () => dot(C.blue, 34, 44, 14) + dot(C.red, 56, 40, 14) + dot(C.yellow, 70, 48, 11)
    + box(C.brown, 14, 48, 72, 40, 10) + [0, 1, 2].map((i) => ln('#8e5d38', 22, 60 + i * 9, 78, 60 + i * 9, 3)).join(''),
  broom: () => ln(C.brown, 74, 10, 50, 56, 6) + poly(C.yellow, 40, 50, 62, 60, 52, 90, 18, 76)
    + [0, 1, 2].map((i) => ln('#d9a42f', 30 + i * 8, 64 + i * 3, 22 + i * 9, 80 + i * 3, 3)).join(''),
  star: () => poly(C.yellow, ...[...Array(10)].map((_, i) => { const a = (-90 + i * 36) * Math.PI / 180, r = i % 2 ? 18 : 42; return `${(50 + r * Math.cos(a)).toFixed(1)},${(54 + r * Math.sin(a)).toFixed(1)}`; })),
};
const pic = (name, cls = '') => h('span', { class: 'pic-svg ' + cls, 'aria-hidden': 'true', html: `<svg viewBox="0 0 100 100">${(DRAW[name] || DRAW.star)()}</svg>` });

house.subscribe((d) => { H = d; draw(); });
