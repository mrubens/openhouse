// A recipe as people write it, read with no model: its ingredients and steps, a line each, and what goes on Groceries
// for it. The bridge (house/meals.js) and the Meals app (/kit/recipe-text.js) share it, so the sheet and asking Opie
// add the same things.
//
// The shape is the one Opie writes itself (cooking.js cookAsNotes): a line "Ingredients", one per line, a line "Steps",
// numbered steps. Pasted recipes often name those parts "Directions", "Instructions" or "Method". Without the
// headings, "- " lines are ingredients and numbered lines are steps.

const HEAD = /^\s*#*\s*(ingredients|steps|directions|instructions|method)\s*:?\s*$/i;
const BULLET = /^\s*(?:[-•*·▢□]|\[\s?\])\s*/;
const NUMBERED = /^\s*(?:step\s*)?\d{1,2}\s*[.):]\s*/i;
const tidy = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Some text in the recipe shape: {name, ingredients: [line], steps: [line]} (name: the first line before them). */
export function parseRecipeText(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { name: '', ingredients: [], steps: [] };
  let part = null, headed = false;
  for (const l of lines) {
    const hd = l.match(HEAD);
    if (hd) { part = /^ingredients$/i.test(hd[1]) ? 'ingredients' : 'steps'; headed = true; continue; }
    if (part === 'ingredients') { const t = tidy(l.replace(BULLET, ''), 160); if (t) out.ingredients.push(t); continue; }
    if (part === 'steps') { const t = tidy(l.replace(NUMBERED, ''), 900); if (t) out.steps.push(t); continue; }
    // before any heading: the name, then (no headings at all) bullets and numbered lines
    if (BULLET.test(l)) out.ingredients.push(tidy(l.replace(BULLET, ''), 160));
    else if (NUMBERED.test(l)) out.steps.push(tidy(l.replace(NUMBERED, ''), 900));
    else if (!out.name && !out.ingredients.length && !out.steps.length) out.name = tidy(l.replace(/^#+\s*/, ''), 80);
  }
  if (headed || out.ingredients.length || out.steps.length) {
    out.ingredients = out.ingredients.filter(Boolean).slice(0, 60);
    out.steps = out.steps.filter(Boolean).slice(0, 80);
  }
  return out;
}

/** "2 tsp ground cumin" -> {amount: "2 tsp", item: "ground cumin"}: the number at its start and the word after it, when
 *  more follows ("2 onions" keeps "onions" as the item). No number: all of it is the item. */
export function splitAmount(line) {
  const t = tidy(line, 160);
  const m = t.match(/^((?:about\s+)?(?:\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞])(?:\s*(?:\d+\/\d+|[½⅓⅔¼¾⅛⅜⅝⅞]))?(?:\s*(?:-|–|to)\s*\d+(?:[.,/]\d+)?)?(?:\s*\([^)]{1,30}\))?)\s+(.+)$/i);
  if (!m) return { item: t, amount: '' };
  const rest = m[2].match(/^(\S+)\s+(.+)$/);
  return rest && !/[,(]/.test(rest[1]) ? { amount: `${m[1]} ${rest[1]}`, item: rest[2] } : { amount: m[1], item: m[2] };
}

/** A thing to buy, from an ingredient: "onion, diced" -> "Onion" (what's after a comma and in brackets left out). */
export function groceryName(item) {
  const t = tidy(String(item || '').replace(/\([^)]*\)/g, ' ').split(/,|;|\bfor serving\b/i)[0], 40);
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** What a recipe says it needs, as things to buy: its cooking steps' ingredients, else the lines under "Ingredients" in
 *  its notes. Each once; [] when it lists none. */
export function groceriesOf(recipe) {
  const items = recipe?.cook?.ingredients?.length ? recipe.cook.ingredients.map((i) => i.item)
    : parseRecipeText(recipe?.notes).ingredients.map((l) => splitAmount(l).item);
  const out = [];
  for (const x of items.map(groceryName)) if (x && !out.some((o) => sameGrocery(o, x))) out.push(x);
  return out.slice(0, 40);
}

/** The same thing to buy: "Onions" and "onion". */
export const sameGrocery = (a, b) => {
  const k = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/(es|s)$/, '');
  return !!k(a) && k(a) === k(b);
};
