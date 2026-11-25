// A dish with no picture of its own, drawn: a quiet line mark for the kind of dish it is (a bowl, a pan, a loaf…) on a
// warm tint, shared by the Recipes and Meals tabs (defaults/apps/recipes, meals) and Home (chat/src/home.jsx), in place
// of a photo. The kind is the recipe's own data: cook.dish, which the model picks from DISHES when it makes the cooking
// steps (bridge/cooking.js), and the starters carry (defaults/apps/recipes/starters.json). One without it is a plate.

/** The kinds of dish there is a mark for, and what each is for (the words the model picks by). */
export const DISHES = {
  bowl: 'soups, stews, curries, chili and porridge',
  noodles: 'pasta and noodle dishes',
  pan: 'stir-fries, fried rice, skillet and one-pan stovetop dishes',
  tray: 'traybakes, roasts, casseroles, lasagne and other oven dishes',
  loaf: 'breads, cakes, muffins, cookies and other baking',
  handheld: 'tacos, wraps, burritos, sandwiches and burgers',
  salad: 'salads and slaws',
  plate: 'anything else',
};

const BOWL = '<path d="M14 46h68c0 18-15 30-34 30S14 64 14 46z"/><path d="M38 80h20"/>';
const MARKS = {
  bowl: BOWL + '<path d="M36 36c-4-5 4-8 0-14M48 34c-4-5 4-8 0-14M60 36c-4-5 4-8 0-14"/>',
  noodles: BOWL + '<path d="M22 46c2-8 9-11 15-8 4-6 14-7 19-1 6-4 15-1 17 9"/><path d="M33 44c3-4 8-4 10 0M49 42c3-4 9-4 11 1"/><path d="M59 42l11-24M66.4 16.3l7.2 3.4M66.4 16.3l3.8-8.2M70 18l3.8-8.2M73.6 19.7l3.8-8.2"/>',
  pan: '<circle cx="40" cy="52" r="25"/><path d="M28 52a12 12 0 0 1 12-12"/><path d="M65 50h19a3 3 0 0 1 0 6H65"/><path d="M34 60h.01M44 56h.01M40 66h.01M50 62h.01"/>',
  tray: '<rect x="14" y="42" width="68" height="30" rx="7"/><path d="M8 50h6M82 50h6"/><path d="M24 42c1-7 11-7 12 0M40 42c1-8 13-8 14 0M58 42c1-7 11-7 12 0"/>',
  loaf: '<path d="M18 52c0-14 11-22 30-22s30 8 30 22v18a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z"/><path d="M32 42l5 7M45 39l5 7M58 42l5 7"/>',
  handheld: '<path d="M14 68a34 34 0 0 1 68 0z"/><path d="M20 52c4-3 7 1 11-2s7-6 11-4 7-3 12-1 8 2 11 1 7 2 9 5"/><path d="M30 60h.01M48 58h.01M64 60h.01"/>',
  salad: BOWL + '<path d="M26 46c-2-9 4-15 12-14 0 7-4 12-12 14zM44 46c0-10 6-16 14-16 0 9-6 15-14 16zM62 46c1-7 7-11 14-9-2 6-7 9-14 9z"/>',
  plate: '<circle cx="48" cy="50" r="24"/><circle cx="48" cy="50" r="15"/><path d="M14 24v14a4 4 0 0 0 8 0V24M18 24v52"/><path d="M80 76V24c-6 4-7 14-7 22h7"/>',
};

/** The kind for a recipe's cooking steps (cook.dish), or the plate. */
export const dishOf = (cook) => (Object.hasOwn(MARKS, cook?.dish) ? cook.dish : 'plate');

/** The mark, as an inline SVG string (currentColor; size it with CSS). */
export function dishMark(kind) {
  return `<svg class="dish-mark" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MARKS[kind] || MARKS.plate}</svg>`;
}

/** A warm tint for a dish, the same for the same name everywhere (give it to the tile as --c). */
const WARM = ['#d9662f', '#c98a1e', '#b8503a', '#7f9a45', '#c46f8a', '#a8763a'];
export const dishTint = (name) => WARM[[...String(name || '').trim().toLowerCase()].reduce((n, ch, i) => n + ch.charCodeAt(0) * (i + 1), 0) % WARM.length];
