// Lists: the family's shared lists (Groceries, To do, any they add), side by side like papers. Type on a list (or tap +) to add,
// tap an item to check it off; its … (or a hold) changes its words or whose it is, or takes it off; a list's name renames or deletes it. "Send to phone" puts a list on a phone on the home Wi-Fi. The lists live in
// the bridge, so the assistant adds to them too ("add milk") and changing this app never loses them.
import { house, timer, say, phone, shell, screen as onScreen } from '/kit/openhouse.js';

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
const chip = (label, on, tap, dot = null) => h('button', { class: 'chip' + (on ? ' on' : ''), tap }, dot && h('span', { class: 'dot', style: `background:${dot}` }), label);
const round = (name, tap, { dark = false, disabled = false, label = null } = {}) =>
  h('button', { class: 'round' + (dark ? ' dark' : ''), disabled, 'aria-label': label, tap: disabled ? null : tap }, icon(name));
/** A color with some see-through: alpha('#e9b949', .32). */
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
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
    h('div', { class: 'actions' }, btn(no, () => { close(); onNo?.(); }, { soft: true }), btn(yes, () => { close(); onYes(); }, { color: 'var(--red)' })),
  ], { onOutside: (close) => { close(); onNo?.(); } });
}
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

// ---- the lists ---------------------------------------------------------------------------------------------
/** Each list's paper: one soft tint of the ink on the sheet, the same for every list (the home screen's quiet look, no sticky-note colors). */
const PAPERS = ['color-mix(in srgb, var(--ink) 4.5%, var(--bg))'];

let H = null;

function draw() {
  // A list's add field being typed in keeps the keyboard through a redraw.
  const typing = document.activeElement?.classList?.contains('add-field') ? document.activeElement : null;
  keepScroll($app, () => $app.replaceChildren(view()));
  if (typing?.isConnected) typing.focus({ preventScroll: true });
  for (const s of sheets) s.redraw?.();
}

const findList = (name) => H.lists.find((l) => l.name === name || l.id === name);
function addTo(list) {
  ask({ title: `Add to ${list}`, hint: same(list, 'Groceries') ? 'Milk' : '', onDone: (text) => {
    findList(list)?.items.push({ id: 'new-' + Date.now(), text, done: false, who: null }); draw();
    house.addItem(list, text);
  } });
}

function view() {
  if (!H) return h('div');
  const lists = H.lists || [];
  const width = lists.length <= 3 ? 1330 / Math.max(2, lists.length) - 24 : 430;
  return h('div', { class: 'screen' },
    h('div', { class: 'top' },
      h('h1', { class: 'title' }, 'Lists'),
      chip('New list', false, () => ask({ title: 'New list', hint: 'Hardware store', onDone: (name) => house.addList(name) }))),
    h('div', { class: 'papers hscroll', 'data-keep': 'papers' },
      lists.map((l, i) => paper(l, PAPERS[i % PAPERS.length], width))));
}

function paper(l, color, width) {
  const open = l.items.filter((it) => !it.done), done = l.items.filter((it) => it.done);
  return h('section', { class: 'paper', style: `background:${color};width:calc(${width} * var(--u))` },
    h('div', { class: 'paper-top' },
      h('h2', { class: 'name', tap: () => listCard(l) }, l.name),
      h('button', { class: 'more', 'aria-label': `Change ${l.name}`, tap: () => listCard(l) }, icon('dots')),
      round('plus', () => addTo(l.name), { dark: true, label: 'Add' })),
    addField(l),
    h('div', { class: 'items vscroll', 'data-keep': 'items-' + l.id },
      l.byAisle ? byAisle(l, open) : open.map((it) => item(l, it)), l.byAisle && done.length && open.length ? h('div', { class: 'aisle' }, 'Checked') : null, done.map((it) => item(l, it))),
    h('div', { class: 'paper-foot' },
      // On someone's phone: Copy, what's still to get one per line, to paste anywhere; on the display, a QR card for a phone.
      open.length ? onScreen?.kind === 'phone' ? h('button', { class: 'quiet', tap: (e) => copy(open, e) }, 'Copy') : h('button', { class: 'quiet', tap: () => phone.list(l.name) }, 'Send to phone') : h('span'),
      done.length ? h('button', { class: 'quiet', tap: () => { l.items = l.items.filter((it) => !it.done); draw(); house.clearChecked(l.name); } }, 'Clear checked') : null));
}

/** What's still to get, one per line, onto the phone's clipboard; the button says Copied for a moment. */
async function copy(open, e) {
  const words = open.map((it) => it.text).join('\n'), b = e?.currentTarget || e?.target;
  try { await navigator.clipboard.writeText(words); }
  catch { const t = document.createElement('textarea'); t.value = words; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.append(t); t.select(); try { document.execCommand('copy'); } catch {} t.remove(); }
  if (b) { const was = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = was; }, 1800); }
}

/** What's left on a list in store sections (produce first, as a shop is walked), each under its name. */
function byAisle(l, open) {
  const order = H.aisles || [], groups = new Map();
  for (const it of open) { const a = it.aisle || 'Other'; if (!groups.has(a)) groups.set(a, []); groups.get(a).push(it); }
  const names = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return names.length > 1 ? names.map((a) => [h('div', { class: 'aisle' }, a), groups.get(a).map((it) => item(l, it))]) : open.map((it) => item(l, it));
}
function item(l, it) {
  return h('div', {
    class: 'item' + (it.done ? ' done' : ''),
    tap: () => { it.done = !it.done; draw(); house.check(l.name, it.id, it.done); },
    hold: () => itemCard(l, it),
  },
  h('span', { class: 'box' }, it.done ? icon('check') : null),
  h('span', { class: 'text' }, it.text),
  it.who ? h('span', { class: 'who', style: `background:${house.color(it.who)}` }) : null,
  h('button', { class: 'more', 'aria-label': `Change ${it.text}`, tap: () => itemCard(l, it) }, icon('dots')));
}

/** Typing right on a list: Enter adds it and the field stays for the next one. Kept across redraws (and its text with it). */
const fields = new Map();
function addField(l) {
  let f = fields.get(l.id);
  if (!f) {
    f = h('input', { class: 'add-field', placeholder: 'Add…', enterkeyhint: 'enter', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Add to ${l.name}` });
    f.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const list = findList(f.dataset.list), text = f.value.trim(); if (!list || !text) return;
      f.value = '';
      if (!list.items.some((it) => !it.done && same(it.text, text))) list.items.push({ id: 'new-' + Date.now(), text, done: false, who: null });
      draw(); house.addItem(list.name, text);
    });
    fields.set(l.id, f);
  }
  f.dataset.list = l.id;
  return f;
}

/** A field for a card, filled with text; onEnter when Enter is pressed. */
function field(text, onEnter) {
  const input = h('input', { class: 'field', enterkeyhint: 'done', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  input.value = text;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } });
  return input;
}

/** An item up close: change its words or whose it is, or take it off. */
function itemCard(l, it) {
  let who = it.who || null, s;
  const save = () => {
    const text = input.value.trim() || it.text; input.blur(); s.close();
    if (text === it.text && who === (it.who || null)) return;
    Object.assign(it, { text, who }); draw(); house.editItem(l.name, it.id, { text, who });
  };
  const input = field(it.text, save);
  s = openCard((close) => [
    h('h2', null, l.name),
    input,
    (H.family || []).length ? h('div', { class: 'chips wrap' }, chip('Anyone', !who, () => { who = null; s.redraw(); }),
      H.family.map((p) => chip(p.name, same(who, p.name), () => { who = p.name; s.redraw(); }, house.color(p.name)))) : null,
    h('div', { class: 'actions' },
      btn('Take it off', () => { input.blur(); close(); l.items = l.items.filter((x) => x !== it); draw(); house.removeItem(l.name, it.id); }, { soft: true }),
      btn('Cancel', () => { input.blur(); close(); }, { soft: true }),
      btn('Save', save)),
  ], { width: 820 });
  return s;
}

/** A list up close: rename it or get rid of it. */
function listCard(l) {
  let s;
  const save = () => {
    const name = input.value.trim(); input.blur(); s.close();
    if (!name || name === l.name) return;
    if (H.lists.some((x) => x !== l && same(x.name, name))) return openCard((close) => [h('h2', null, `There’s already a list called ${name}.`), h('div', { class: 'actions' }, btn('OK', close))]);
    const was = l.name; l.name = name; draw(); house.renameList(was, name);
  };
  const input = field(l.name, save);
  s = openCard((close) => [
    h('h2', null, 'List'),
    input,
    h('div', { class: 'chips' }, chip('In the order added', !l.byAisle, () => { l.byAisle = false; draw(); house.byAisle(l.name, false); }),
      chip('By store section', !!l.byAisle, () => { l.byAisle = true; draw(); house.byAisle(l.name, true); })),
    h('div', { class: 'actions' },
      btn('Delete list', () => { input.blur(); close(); confirmCard(l.items.length ? `Delete “${l.name}” and its ${l.items.length} thing${l.items.length === 1 ? '' : 's'}?` : `Delete “${l.name}”?`, 'Delete it', () => {
        H.lists = H.lists.filter((x) => x !== l); draw(); house.deleteList(l.name);
      }); }, { soft: true }),
      btn('Cancel', () => { input.blur(); close(); }, { soft: true }),
      btn('Save', save)),
  ], { width: 760 });
  return s;
}

house.subscribe((d) => { H = d; draw(); });
