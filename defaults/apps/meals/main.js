// Meals: the week's meals: tonight in a wide panel (its picture, or three of the household's own to tap for dinner),
// then a card per day (dinner, and breakfast and lunch if they want). A dish's picture is its recipe's own, from its
// page; with none, its initial on a warm tile. Tap a meal to plan it:
// write it, or tap one the family has often (favorites first, with a dot). Each meal can keep a recipe (a link, notes, or one the
// assistant writes), shown on every day it's planned. With the assistant set up, "Add to Groceries" puts what it needs on the list.
// Cook opens the Recipes app on that meal's recipe (kit askApp: its "cook" voice action), one step at a time.
// The plan lives in the bridge, so the assistant plans too ("tacos on Tuesday") and changing this app never loses it.
import { house, timer, say, phone, shell, askApp } from '/kit/openhouse.js';

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

const ICONS = { search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', meals: '<path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="17" r="2"/>',
  plus: '<path d="M12 4.5v15M4.5 12h15"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', left: '<path d="M14.5 5.5L8 12l6.5 6.5"/>', right: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>' };
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

// ---- the week's meals --------------------------------------------------------------------------------------
/** The meals a day can have, in order. */
const SLOTS = ['breakfast', 'lunch', 'dinner'];
/** Which meals each day shows: the ones they plan, and any with something planned this week. */
const mealsFor = (keys) => SLOTS.filter((m) => (H.mealSlots || ['dinner']).includes(m) || keys.some((k) => H.meals?.[k]?.[m]));
const recipeOf = (text) => (text ? H.recipes?.[text.toLowerCase()] || null : null);

let H = null, week = 0;

function draw() {
  keepScroll($app, () => $app.replaceChildren(view()));
  for (const s of sheets) s.redraw?.();
}

const day = (plus) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + plus); return d; };
const fromKey = (k) => new Date(k + 'T12:00:00');
const fmt = (d, o) => d.toLocaleDateString(undefined, o);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const planned = (k, m) => H.meals?.[k]?.[m] || null;

// changes show at once; the bridge's next update confirms them
function setMeal(k, m, text) {
  H.meals ||= {}; const d = { ...(H.meals[k] || {}) };
  if (text.trim()) d[m] = text.trim(); else delete d[m];
  if (Object.keys(d).length) H.meals[k] = d; else delete H.meals[k];
  draw(); house.setMeal(k, m, text);
}
function favorite(text, pinned) {
  H.favorites = pinned ? [{ text, pinned: true }, ...H.favorites.filter((f) => !same(f.text, text))] : H.favorites.filter((f) => !same(f.text, text));
  draw(); house.favorite(text, pinned);
}

/** A dish's picture: its recipe's own (kept from its page); with none, or one that won't load, its initial on a warm tile. */
const WARM = ['#d9662f', '#c98a1e', '#b8503a', '#7f9a45', '#c46f8a', '#a8763a'];
function dishPic(name) {
  const t = String(name || '').trim(), src = recipeOf(t)?.image;
  const letter = h('div', { class: 'q-letter', style: `--c:${WARM[[...t.toLowerCase()].reduce((n, ch, i) => n + ch.charCodeAt(0) * (i + 1), 0) % WARM.length]}`, 'aria-hidden': 'true' }, t[0]?.toUpperCase() || '');
  if (!src) return letter;
  const img = h('img', { class: 'q-photo', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' });
  img.addEventListener('error', () => { img.parentElement?.classList.remove('q-scrim'); img.replaceWith(letter); });
  return img;
}
const hasPic = (name) => !!recipeOf(String(name || '').trim())?.image;
/** A few of their own to tap for a meal: favorites first, then saved recipes (nothing made up). */
function picks() {
  const out = [];
  for (const x of [...(H.favorites || []).map((f) => f?.text ?? f), ...Object.values(H.recipes || {}).map((r) => r?.text)]) {
    const v = String(x || '').trim(); if (v && !out.some((p) => same(p, v))) out.push(v);
  }
  return out.slice(0, 3);
}

function view() {
  if (!H) return h('div');
  const days = [...Array(7)].map((_, i) => day(week * 7 + i)), meals = mealsFor(days.map((d) => house.dayKey(d)));
  const main = meals.includes('dinner') ? 'dinner' : meals.at(-1); // the meal a day's card is about
  const a = days[0], z = days[6], range = `${fmt(a, { month: 'short', day: 'numeric' })} – ${a.getMonth() === z.getMonth() ? z.getDate() : fmt(z, { month: 'short', day: 'numeric' })}`;
  return h('div', { class: 'screen' },
    h('div', { class: 'top' },
      h('div', { class: 'm-head' }, h('div', { class: 'q-label m-range' }, range), h('h1', { class: 'title' }, 'Meals ', h('span', null, week === 0 ? 'this week' : 'next week'))),
      round('left', () => { week--; draw(); }, { disabled: week <= 0, label: 'This week' }),
      h('div', { class: 'chip m-when' }, range),
      round('right', () => { week++; draw(); }, { disabled: week >= 1, label: 'Next week' }),
      round('meals', slotsCard, { label: 'Which meals to plan' })),
    h('div', { class: 'm-body', 'data-keep': 'week' },
      week === 0 ? tonight(days[0], meals, main) : null,
      h('div', { class: 'm-week' + (week === 0 ? '' : ' n7') }, (week === 0 ? days.slice(1) : days).map((d) => dayCard(d, meals, main)))));
}

/** Today: what's planned, on its picture; unplanned, three of theirs to tap. */
function tonight(d, meals, main) {
  const k = house.dayKey(d), text = planned(k, main), w = H.mealWork?.[`${k}|${main}`], some = text ? [] : picks();
  const others = meals.filter((m) => m !== main);
  return h('div', { class: 'q-panel m-hero' },
    h('div', { class: 'm-txt' },
      h('div', { class: 'q-label' }, `${main === 'dinner' ? 'Tonight' : `Today’s ${main}`} · ${fmt(d, { weekday: 'long' })}`),
      h('h2', { class: text && text.length > 18 ? 'long' : null }, text || 'Not planned yet'),
      w ? h('p', null, work(w)) : !text && some.length ? h('p', null, `Tap one and it’s ${main}.`) : null,
      others.length ? h('div', { class: 'm-others q-rows' }, others.map((m) => slotRow(k, m))) : null,
      h('div', { class: 'm-acts' },
        text && recipeOf(text) ? btn([icon('right'), 'Cook'], () => askApp('recipes', 'cook', { recipe: text })) : null,
        btn(text ? 'Change' : [icon('search'), 'Something else'], () => edit(k, main), { soft: true }))),
    text ? h('div', { class: 'm-picks one' }, h('div', { class: 'm-pick big' + (hasPic(text) ? ' q-scrim' : ''), tap: () => edit(k, main) }, dishPic(text)))
      : some.length ? h('div', { class: 'm-picks' }, some.map((p) => h('div', { class: 'm-pick' + (hasPic(p) ? ' q-scrim' : ''), 'aria-label': `Have ${p}`, tap: () => setMeal(k, main, p) },
        dishPic(p), h('span', { class: 'm-plus' }, icon('plus')), h('div', { class: 't' }, p))))
        : h('div', { class: 'm-picks one' }, h('div', { class: 'm-pick none', 'aria-label': 'Plan it', tap: () => edit(k, main) }, h('span', { class: 'm-o' }, icon('plus')))));
}

/** One of a day's other meals (breakfast, lunch), when they plan more than dinner. */
function slotRow(k, m) {
  const text = planned(k, m), w = H.mealWork?.[`${k}|${m}`];
  return h('div', { class: 'm-slot' + (text ? '' : ' open'), tap: () => edit(k, m) }, h('div', { class: 'q-label' }, cap(m)), h('b', null, text || 'Nothing yet'), w ? h('small', null, work(w)) : null);
}

function dayCard(d, meals, main) {
  const k = house.dayKey(d), text = planned(k, main), w = H.mealWork?.[`${k}|${main}`], others = meals.filter((m) => m !== main);
  const label = h('div', { class: 'q-label' }, fmt(d, { weekday: 'long' }) + (others.length ? ` · ${main}` : ''));
  const rest = others.length ? h('div', { class: 'q-rows' }, others.map((m) => slotRow(k, m))) : null;
  if (!text) return h('div', { class: 'm-day empty', tap: () => edit(k, main) },
    h('div', { class: 'im' }, h('span', { class: 'm-o' }, icon('plus'))),
    h('div', { class: 'b' }, label, h('b', null, 'Nothing yet'), rest));
  return h('div', { class: 'q-panel m-day', tap: () => edit(k, main) },
    h('div', { class: 'im' }, dishPic(text)),
    h('div', { class: 'b' }, label, h('b', null, text), w ? h('small', null, work(w)) : recipeOf(text) ? h('small', null, 'Recipe') : null, rest));
}

/** Which meals to plan each day. */
function slotsCard() {
  const s = openCard((close) => {
    const on = H.mealSlots || ['dinner'];
    const flip = (m) => { const next = on.includes(m) ? on.filter((x) => x !== m) : SLOTS.filter((x) => x === m || on.includes(x)); if (!next.length) return; H.mealSlots = next; draw(); house.mealSlots(next); };
    return [
      h('h2', null, 'Plan these meals'),
      h('div', { class: 'chips wrap' }, SLOTS.map((m) => chip(cap(m), on.includes(m), () => flip(m)))),
      h('div', { class: 'actions' }, btn('Done', close)),
    ];
  }, { width: 700 });
  return s;
}

/** A meal's recipe: read it, change it, or have the assistant write it. */
function recipeCard(text) {
  const key = `recipe|${text.toLowerCase()}`;
  const s = openCard((close) => {
    const r = recipeOf(text), w = H.mealWork?.[key];
    return [
      h('h2', null, text),
      r?.link ? h('div', { class: 'link' }, r.link) : null,
      r?.notes ? h('div', { class: 'recipe vscroll', 'data-keep': 'recipe' }, r.notes) : null,
      !r && !w ? h('p', { class: 'note' }, 'No recipe yet. Add a link or write it down' + (H.ai ? ', or have the assistant write one.' : '.')) : null,
      w ? h('p', { class: 'note' }, w.state === 'working' ? (w.photo ? 'Reading the recipe from the photo…' : 'Writing the recipe…') : w.state === 'error' ? (w.text || 'Couldn’t write it') : '') : null,
      h('div', { class: 'actions' },
        r ? btn('Take it out', () => { close(); confirmCard(`Take out the recipe for ${text}?`, 'Take it out', () => { delete H.recipes[text.toLowerCase()]; draw(); house.setRecipe(text, {}); }); }, { soft: true }) : null,
        H.ai && !r?.notes && w?.state !== 'working' ? btn('From a photo', () => { if (!phone.recipe(text)) openCard((close) => [h('h2', null, 'From a photo'), h('p', { class: 'note' }, 'This works on the display itself: a phone sends it the photo.'), h('div', { class: 'actions' }, btn('OK', close))]); }, { soft: true }) : null,
        H.ai && !r?.notes && w?.state !== 'working' ? btn('Write it for me', () => { H.mealWork = { ...H.mealWork, [key]: { state: 'working' } }; draw(); house.writeRecipe(text); }, { soft: true }) : null,
        btn(r ? 'Change' : 'Add', () => { close(); recipeEditor(text); }, { soft: true }),
        r ? btn('Cook', () => { close(); askApp('recipes', 'cook', { recipe: text }); }, { soft: true }) : null,
        btn('Done', close)),
    ];
  }, { width: 980 });
  return s;
}
function recipeEditor(text) {
  const r = recipeOf(text) || {};
  const link = h('input', { class: 'field small', placeholder: 'A link (https://…)', inputmode: 'url', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
  const notes = h('textarea', { class: 'field small notes', placeholder: 'Ingredients and steps', autocapitalize: 'sentences', spellcheck: 'false' });
  link.value = r.link || ''; notes.value = r.notes || '';
  const s = openCard((close) => [
    h('h2', null, `Recipe for ${text}`),
    link, notes,
    h('div', { class: 'actions' },
      btn('Cancel', () => { document.activeElement?.blur(); close(); }, { soft: true }),
      btn('Save', () => {
        let l = link.value.trim(); const n = notes.value.trim();
        if (l && !/^https?:\/\//i.test(l)) l = 'https://' + l;
        document.activeElement?.blur(); close();
        H.recipes ||= {};
        if (l || n) H.recipes[text.toLowerCase()] = { text, ...(l ? { link: l } : {}), ...(n ? { notes: n } : {}) }; else delete H.recipes[text.toLowerCase()];
        draw(); house.setRecipe(text, { link: l, notes: n }).then(told); recipeCard(text);
      })),
  ], { width: 980, onOutside: () => {} });
  requestAnimationFrame(() => notes.focus());
  return s;
}

function work(w) {
  if (w.state === 'working') return 'Adding groceries…';
  if (w.state === 'done') return w.added?.length ? `Added ${w.added.length} to Groceries` : 'Groceries already had it all';
  return w.text || 'Couldn’t add groceries';
}

function edit(k, m) {
  ask({ title: `${fmt(fromKey(k), { weekday: 'long' })} ${m}`, initial: planned(k, m) || '', hint: 'Tacos',
    extra: (s) => {
      const now = planned(k, m);
      const pinned = !!now && H.favorites.some((f) => f.pinned && same(f.text, now));
      return [
        // the meals they have often, favorites first (with a dot): one tap plans it
        H.favorites?.length ? h('div', { class: 'chips', 'data-keep': 'favs' },
          H.favorites.map((f) => chip(f.text, same(f.text, now), () => { s.close(); setMeal(k, m, f.text); }, f.pinned ? 'var(--gold)' : null))) : null,
        now ? h('div', { class: 'chips' },
          H.ai ? btn('Add to Groceries', () => { s.close(); H.mealWork = { ...H.mealWork, [`${k}|${m}`]: { state: 'working', added: [] } }; draw(); house.addIngredients(k, m); }, { soft: true }) : null,
          btn(recipeOf(now) ? 'Recipe' : 'Add a recipe', () => { s.close(); recipeCard(now); }, { soft: true }),
          recipeOf(now) ? btn('Cook', () => { s.close(); askApp('recipes', 'cook', { recipe: now }); }, { soft: true }) : null,
          btn(pinned ? 'Unfavorite' : 'Favorite', () => favorite(now, !pinned), { soft: true }),
          btn('Clear', () => { s.close(); setMeal(k, m, ''); }, { soft: true })) : null,
      ];
    },
    onDone: (text) => setMeal(k, m, text) });
}

house.subscribe((d) => { H = d; draw(); });
