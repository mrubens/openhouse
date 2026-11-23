// Pantry and freezer: what's on hand, kept by voice ("we have two bags of frozen peas", "we used the last of the rice")
// or by tap, and dinner ideas from it: the household's own meals (its recipe box and favorites, from Meals), each
// weighed against what's here by OpenHouse's small judgments (kit decide), and one tap (or "let's do that") puts it on
// tonight's dinner in Meals.
//
// The voice gives the item, where and how many as arguments (app.json actions); which kept item a spoken one means,
// when it isn't the same words, is a judgment too (decide), never a list of words here.
import { house, store, decide, onAction } from '/kit/openhouse.js';
import { h, sheet, field, dayKey, and, put, whenShown } from './ui.js';

const $app = document.getElementById('app');
const PLACES = ['pantry', 'freezer'];
let items = [];   // [{id, name, where, count, added}]
let meals = [];   // the household's meals: [{name, ingredients?}]
let ideas = null; // {at, list: [{name, p}]} or {working: true}
let tonight = null;

const save = () => store.set('items', { items });
/** What's kept now: another copy of this page may have changed it. */
const reload = async () => { items = (await store.get('items'))?.items || []; };
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
const shown = (i) => (i.count > 1 ? `${i.count} ${i.name}` : i.name);

/** Which kept item they mean: the same words, else the household's small judgment among the ones there. */
async function find(name, where = null) {
  const pool = items.filter((i) => !where || i.where === where);
  const same = pool.find((i) => norm(i.name) === norm(name));
  if (same || !pool.length) return same || null;
  // the only kept item whose name has all of their words in it ("peas" and "frozen peas"): no judgment needed
  const words = norm(name).split(' '), has = pool.filter((i) => words.every((w) => norm(i.name).split(' ').includes(w)));
  if (has.length === 1) return has[0];
  const a = await decide(`Someone said: "${name}". On hand: ${pool.map((i) => i.name).join('; ')}.`, [{ type: 'choice', name: 'item',
    instructions: 'Which item on hand do they mean? None if it is not one of them.',
    choices: [...pool.map((i, k) => ({ value: String(k), description: i.name })), { value: 'none', description: 'none of these' }] }]);
  if (!a) return null; // no small judgments here (no cloud, or not chosen)
  const c = a[0];
  return c && c.choice !== 'none' && c.confidence >= 0.6 ? pool[Number(c.choice)] : null;
}

async function add(name, where = 'pantry', count = 1) {
  await reload();
  const n = String(name || '').trim().slice(0, 60);
  if (!n) return null;
  const w = PLACES.includes(where) ? where : 'pantry';
  const had = items.find((i) => i.where === w && norm(i.name) === norm(n));
  if (had) { had.count += Math.max(1, count || 1); had.at = Date.now(); }
  else items.push({ id: Date.now() + Math.random(), name: n, where: w, count: Math.max(1, Math.round(count || 1)), added: dayKey(), at: Date.now() });
  ideas = null; await save(); draw();
  return had || items.at(-1);
}
async function use(item, count = null) {
  await reload(); item = items.find((i) => i.id === item.id); if (!item) return;
  if (count && item.count > count) item.count -= count; else items = items.filter((i) => i !== item);
  ideas = null; await save(); draw();
}

// ---- dinner ideas ----
async function think() {
  if (!meals.length) { ideas = { at: Date.now(), list: [], none: 'meals' }; draw(); return ideas; }
  if (!items.length) { ideas = { at: Date.now(), list: [], none: 'items' }; draw(); return ideas; }
  ideas = { working: true }; draw();
  const pool = meals.slice(0, 16);
  const onHand = items.map((i) => `${shown(i)} (${i.where})`).join('; ');
  const a = await decide(`On hand: ${onHand}.`, pool.map((m, k) => ({ type: 'predicate', name: `m${k}`,
    instructions: `Could this household make "${m.name}" for dinner tonight mostly from what is on hand${m.ingredients ? ` (it needs ${m.ingredients})` : ''}, needing at most a few common staples?` })));
  let list;
  if (a) list = pool.map((m, k) => ({ name: m.name, p: a.find((x) => x.name === `m${k}`)?.probability ?? 0 })).filter((x) => x.p >= 0.5).sort((x, y) => y.p - x.p).slice(0, 4);
  else {
    // No small judgments (no cloud, or not chosen): the meals whose recipe lists an ingredient that's on hand by name.
    list = pool.filter((m) => m.items?.some((g) => items.some((i) => norm(i.name).includes(norm(g)) || norm(g).includes(norm(i.name))))).slice(0, 4).map((m) => ({ name: m.name, p: null }));
  }
  ideas = { at: Date.now(), list, plain: !a };
  draw();
  return ideas;
}
const plan = async (name) => { await house.setMeal(dayKey(), 'dinner', name); tonight = name; draw(); };

// ---- the page ----
function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Pantry'),
    h('button', { class: 'btn soft', tap: () => think() }, 'Dinner ideas'),
    h('button', { class: 'btn', tap: () => openAdd() }, 'Add'));
  const col = (w) => {
    const list = items.filter((i) => i.where === w).sort((a, b) => a.name.localeCompare(b.name));
    return h('section', { class: 'place' }, h('div', { class: 'label' }, cap(w)),
      list.length ? list.map((i) => h('div', { class: 'line' },
        h('span', { class: 'grow' }, cap(i.name)),
        h('span', { class: 'count' },
          h('button', { class: 'x', 'aria-label': 'One fewer', tap: () => use(i, 1) }, '−'),
          h('span', { class: 'n' }, String(i.count)),
          h('button', { class: 'x', 'aria-label': 'One more', tap: async () => { await reload(); const x = items.find((y) => y.id === i.id); if (x) { x.count++; await save(); } draw(); } }, '+'))))
        : h('p', { class: 'soft' }, `Nothing in the ${w} yet. Say “we have frozen peas in the freezer”, or tap Add.`));
  };
  const idea = ideas?.working ? h('p', { class: 'soft' }, 'Thinking about dinner…')
    : ideas?.none === 'meals' ? h('p', { class: 'soft' }, 'Ideas come from your own meals: add some favorites or recipes in Meals first.')
      : ideas?.none === 'items' ? h('p', { class: 'soft' }, 'Add what’s on hand first.')
        : ideas ? (ideas.list.length ? ideas.list.map((x) => h('div', { class: 'line' }, h('span', { class: 'grow' }, x.name),
          tonight === x.name ? h('span', { class: 'side' }, 'Tonight’s dinner') : h('button', { class: 'btn soft', tap: () => plan(x.name) }, 'Tonight')))
          : h('p', { class: 'soft' }, 'None of your meals fit what’s here. Time to shop.')) : null;
  put($app, top, h('div', { class: 'body' },
    h('div', { class: 'cols', style: '--n:2' }, PLACES.map(col)),
    ideas ? h('section', { class: 'ideas' }, h('div', { class: 'label' }, 'Dinner from what’s here'), idea,
      ideas.plain ? h('p', { class: 'hint' }, 'Matched by the recipes’ ingredients only: turn on OpenHouse’s cloud for better ideas.') : null) : null));
}
function openAdd() {
  const name = h('input', { class: 'field', placeholder: 'Frozen peas' });
  const where = h('select', { class: 'field' }, PLACES.map((p) => h('option', { value: p }, cap(p))));
  const count = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '1', value: '1' });
  sheet('Add to the pantry or freezer', [field('What', name), h('div', { class: 'pair' }, field('Where', where), field('How many', count))], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Add', tap: async (c) => { if (!name.value.trim()) return; c(); await add(name.value, where.value, Number(count.value) || 1); } }]);
}

// ---- the voice ----
const actions = {
  async add({ item, where, count }) {
    await reload();
    const seen = items.find((x) => norm(x.name) === norm(item) && Date.now() - (x.at || 0) < 30e3); // one ask seen by two copies of this page
    const i = seen || await add(item, where, count || 1);
    return i ? `Added ${count > 1 ? count + ' ' : ''}${i.name} to the ${i.where}${i.count > (count || 1) ? `: ${i.count} now` : ''}.` : 'What should I add?';
  },
  async remove({ item, where, count, all }) {
    const i = await find(item, PLACES.includes(where) ? where : null);
    if (!i) return `There’s no ${item} ${where ? `in the ${where}` : 'in the pantry or freezer'}${items.length ? '' : ': it’s empty'}.`;
    await use(i, all ? null : count || 1);
    const left = items.find((x) => x.id === i.id)?.count || 0;
    return left ? `${cap(i.name)}: ${left} left in the ${i.where}.` : `Took ${i.name} off the ${i.where}.`;
  },
  async whats_there({ where, item }) {
    if (item) { const i = await find(item); return i ? `Yes, ${shown(i)} in the ${i.where}.` : `No ${item} in the pantry or freezer.`; }
    const ws = PLACES.includes(where) ? [where] : PLACES;
    return ws.map((w) => { const l = items.filter((i) => i.where === w); return l.length ? `In the ${w}: ${and(l.map(shown))}.` : `The ${w} is empty.`; }).join(' ');
  },
  async dinner_ideas() {
    const x = await think();
    if (x.none === 'meals') return 'I only suggest your own meals, and there aren’t any in Meals yet.';
    if (!x.list.length) return 'None of your usual meals fit what’s in the pantry and freezer.';
    return `From what’s here: ${and(x.list.map((m) => m.name))}. Want one for tonight?`;
  },
  async plan_dinner({ meal }) {
    const m = meals.find((x) => norm(x.name) === norm(meal)) || ideas?.list?.find((x) => norm(x.name) === norm(meal));
    const name = m?.name || String(meal || '').trim();
    if (!name) return 'Which meal?';
    await plan(name);
    return `${name} is tonight’s dinner.`;
  },
};

(async () => {
  items = (await store.get('items'))?.items || [];
  draw();
  house.subscribe((hv) => {
    const rec = Object.entries(hv.recipes || {}).map(([k, r]) => ({ name: r.text || r.cook?.name || cap(k), items: (r.cook?.ingredients || []).map((g) => g.item).filter(Boolean) }))
      .map((r) => ({ ...r, ingredients: r.items.slice(0, 14).join(', ') }));
    const fav = (hv.favorites || []).map((f) => ({ name: f.text, items: [] }));
    const seen = new Set();
    meals = [...rec, ...fav].filter((m) => m.name && !seen.has(norm(m.name)) && seen.add(norm(m.name)));
    tonight = hv.meals?.[dayKey()]?.dinner || null;
    draw();
  });
  whenShown(() => onAction(async (name, args) => { await reload(); return actions[name]?.(args) ?? null; }));
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) { await reload(); draw(); } });
})();
