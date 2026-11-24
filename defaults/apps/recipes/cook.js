// The Recipes app's words and moves, with no screen: which recipe "the tacos" is, where "next" goes, how much cumin,
// and what the voice says for each. The screen (main.js) and the voice both go through these, so they never disagree
// on where you are. Plain functions (bridge/test/recipes-app.test.mjs runs them).
//
// A place in a recipe is a step number: 0 is "before you start" (everything it needs), 1..n its steps, n + 1 the end.

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')} `
  .replace(/ (the|a|an|some|my|our|recipe|for|of|to|make|cook|cooking) /g, ' ').replace(/ (the|a|an) /g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean).map((w) => (w.length > 3 && w.endsWith('es') && !w.endsWith('oes') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
const likeness = (a, b) => {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return 0;
  if (x.join(' ') === y.join(' ')) return 3;
  const hit = x.filter((w) => y.includes(w)).length;
  if (hit === x.length || hit === y.length) return 2 + hit / Math.max(x.length, y.length) / 10;
  return hit / Math.max(x.length, y.length);
};

/** The recipe they mean: by its meal name or its own, else (none given) the meal planned for now. {key, recipe} or null. */
export function findRecipe(recipes, name, planned = []) {
  const all = Object.entries(recipes || {});
  if (!String(name || '').trim()) {
    for (const meal of planned) { const k = String(meal || '').toLowerCase(); if (recipes?.[k]) return { key: k, recipe: recipes[k] }; }
    return null;
  }
  let best = null, score = 0;
  for (const [key, r] of all) {
    const s = Math.max(likeness(name, r.text || key), likeness(name, r.cook?.name || ''));
    if (s > score) { best = { key, recipe: r }; score = s; }
  }
  return score >= 0.5 ? best : null;
}

/** Today's planned meals, the one for now first (dinner after 3 PM, lunch late morning, else breakfast). */
export function mealsNow(meals, dayKey, hour) {
  const d = meals?.[dayKey] || {};
  const order = hour >= 15 ? ['dinner', 'lunch', 'breakfast'] : hour >= 10 ? ['lunch', 'dinner', 'breakfast'] : ['breakfast', 'lunch', 'dinner'];
  return order.map((m) => d[m]).filter(Boolean);
}

const amountOf = (i) => [i.amount, i.item].filter(Boolean).join(' ');
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const minutes = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60}-hour` : m === 0.5 ? '30-second' : `${m}-minute`);

/** The steps in short, for the voice to choose from: "1 Make the dough (Dough, waits, a day ahead)". */
export function outline(cook) {
  return cook.steps.map((s, i) => `${i + 1} ${(s.title || s.text.slice(0, 60)).replace(/[.;,:\s]+$/, '')}${[s.part, s.wait ? 'mostly waiting' : '', s.ahead].filter(Boolean).length ? ` (${[s.part, s.wait ? 'mostly waiting' : '', s.ahead].filter(Boolean).join(', ')})` : ''}`).join('; ');
}

/** What the voice says at a place: the step, then the timer it offers. */
export function sayAt(cook, at) {
  const n = cook.steps.length;
  if (at <= 0) return `${cook.name ? cook.name + ', ' : ''}${n} steps, all on the screen: ${outline(cook)}. ` +
    'Say which step to start at: the first one that needs them now, past anything done ahead or already done; if one has to be done ahead, say so first.';
  if (at > n) return "That was the last step. When you're done, say stop.";
  const s = cook.steps[at - 1];
  return `Step ${at} of ${n}. ${s.text}${s.timer ? ` Want a ${minutes(s.timer.minutes)} timer?` : ''}`;
}

/** Moving: {at, say}. go: next, back, again, ahead (what's after, staying put), first; to: a step's number. */
export function move(cook, at, go, to = null) {
  const n = cook.steps.length;
  if (Number.isInteger(to) && to >= 1 && to <= n) return { at: to, say: sayAt(cook, to) };
  if (go === 'next') { if (at > n) return { at, say: "That was the last step. Say stop when you're done." }; const to = at + 1; return { at: to, say: sayAt(cook, to) }; }
  if (go === 'back') { if (at <= 1) return { at: 1, say: `This is the first step. ${sayAt(cook, 1)}` }; const to = at - 1; return { at: to, say: sayAt(cook, to) }; }
  if (go === 'first') return { at: 1, say: sayAt(cook, 1) };
  if (go === 'ahead') {
    if (at >= n) return { at, say: 'Nothing: this is the last step.' };
    return { at, say: `After this, step ${at + 1}: ${cook.steps[at].text}` };
  }
  return { at, say: sayAt(cook, at) }; // again
}

/** "How much cumin?": in all, and in this step. */
export function howMuch(cook, at, what) {
  const matches = (i) => likeness(what, i.item) >= 0.5;
  const all = cook.ingredients.filter(matches);
  const here = (at >= 1 && at <= cook.steps.length ? cook.steps[at - 1].uses || [] : []).filter(matches);
  if (!all.length && !here.length) {
    const used = cook.steps.flatMap((s) => s.uses || []).filter(matches);
    return used.length ? `${list(used.map(amountOf))}.` : `The recipe doesn't list ${what}.`;
  }
  const inAll = all.map(amountOf);
  if (!here.length) return `${list(inAll)} in all${at >= 1 && at <= cook.steps.length ? ', none of it in this step' : ''}.`;
  const now = here.map(amountOf);
  return all.length && inAll.join() !== now.join() ? `${list(now)} in this step; ${list(inAll)} in all.` : `${list(now)}.`;
}

/** What this step needs, or everything. */
export function needs(cook, at, everything = false) {
  if (everything || at < 1 || at > cook.steps.length) return cook.ingredients.length ? `You need ${list(cook.ingredients.map(amountOf))}.` : "The recipe doesn't list its ingredients.";
  const u = cook.steps[at - 1].uses || [];
  return u.length ? `This step uses ${list(u.map(amountOf))}.` : 'This step adds nothing new.';
}

/** What the live voice is told is on the screen (the app's hands-free note). */
export function noteAt(cook, at) {
  const n = cook.steps.length, s = at >= 1 && at <= n ? cook.steps[at - 1] : null;
  return [
    `The Recipes app is showing ${cook.name || 'a recipe'}, all its steps on one page, ${at <= 0 ? 'at the start (what it needs)' : at > n ? 'after the last step' : `with step ${at} of ${n} marked: ${s.text}`}`,
    `Its steps: ${outline(cook)}.`,
    s?.uses?.length ? `This step uses: ${s.uses.map(amountOf).join('; ')}.` : '',
    s?.timer ? `It offers a ${minutes(s.timer.minutes)} timer (${s.timer.label}).` : '',
    at < n ? `Next, step ${at + 1}: ${cook.steps[at].text}` : '',
    `Everything it uses: ${cook.ingredients.map(amountOf).join('; ')}.`,
  ].filter(Boolean).join('\n');
}

const SKIP = new Set(['what', 'can', 'could', 'make', 'cook', 'with', 'have', 'got', 'we', 'i', 'and', 'or', 'something', 'anything', 'recipe', 'recipes', 'some', 'any', 'for', 'using', 'use', 'that', 'has', 'in', 'it', 'up', 'do', 'tonight', 'dinner', 'lunch', 'the', 'a', 'an', 'my', 'our']);
/** The words that matter in "what can I make with chicken and rice?". */
const asked = (q) => [...new Set(words(q).filter((w) => w.length > 1 && !SKIP.has(w)))];

/** Saved recipes (by name and ingredients) and favorite meals (by name) for some words, best first:
 *  [{key, name, hits}] (key null: a favorite with no recipe). */
export function searchBox(recipes, favorites, q) {
  const want = asked(q); if (!want.length) return [];
  const out = [];
  for (const [key, r] of Object.entries(recipes || {})) {
    const name = r.cook?.name || r.text || key;
    const what = words([name, r.text, ...(r.cook?.ingredients || []).map((i) => i.item), r.cook ? '' : r.notes].join(' '));
    const hits = want.filter((w) => what.includes(w)).length;
    if (hits) out.push({ key, name, hits });
  }
  for (const f of favorites || []) {
    const t = typeof f === 'string' ? f : f?.text; if (!t || out.some((o) => likeness(o.name, t) >= 2 || likeness(recipes?.[o.key]?.text, t) >= 2)) continue;
    const hits = want.filter((w) => words(t).includes(w)).length;
    if (hits) out.push({ key: null, name: t, hits });
  }
  return out.sort((a, b) => b.hits - a.hits || (a.key ? 0 : 1) - (b.key ? 0 : 1)).slice(0, 12);
}
/** What the voice says for searchBox's answer. */
export function sayHits(hits, q) {
  const saved = hits.filter((x) => x.key), favs = hits.filter((x) => !x.key);
  if (!saved.length && !favs.length) return `Nothing in the recipe box with ${asked(q).join(' and ') || 'that'}. I can look on the web.`;
  return [saved.length ? `You could make ${list(saved.slice(0, 4).map((x) => x.name))}.` : '',
    favs.length ? `${saved.length ? 'Also' : 'From your favorites,'} ${list(favs.slice(0, 3).map((x) => x.name))}${saved.length ? ' from your favorites' : ''}, with no recipe saved yet.` : ''].filter(Boolean).join(' ');
}
const ORD = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
/** What the voice says for recipes found on the web. */
export function sayFound(results) {
  if (!results?.length) return 'I couldn\'t find recipes for that.';
  const t = (m) => (m >= 60 ? `${Math.floor(m / 60)} hour${m >= 120 ? 's' : ''}${m % 60 ? ` ${m % 60} minutes` : ''}` : `${m} minutes`);
  return `Here ${results.length === 1 ? 'is one' : `are ${results.length}`}, on the screen. ` +
    results.map((r, i) => `${ORD[i]}: ${r.title}, from ${r.site}${r.minutes ? `, ${t(r.minutes)}` : ''}.`).join(' ') + ' Say the number to open one.';
}

export { minutes as timerWords };
