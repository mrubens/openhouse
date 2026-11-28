// The meal plan (the Meals app): what's for each meal, favorites, which meals are planned, and a meal's groceries.
import { validDay, str, same, arr, must } from './util.js';
import { asData } from '../as-data.js';
import { groceriesOf, sameGrocery } from '../kit/recipe-text.js';

export default function (house) {
  const { data, save, prune, changed, mealWork } = house;
  function favorites() {
    const pinned = data.favorites.map((t) => ({ text: t, pinned: true }));
    const often = Object.values(data.mealCounts).filter((m) => !data.favorites.some((f) => same(f, m.text)))
      .sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last))).map((m) => ({ text: m.text, pinned: false }));
    return [...pinned, ...often].slice(0, 16);
  }
  // ---- meals ----
  function setMeals(list) {
    const did = [];
    for (const m of [].concat(list || [])) {
      if (!validDay(m?.date)) { did.push(`bad date ${m?.date}`); continue; }
      const meal = str(m.meal || 'dinner', 20).toLowerCase(), text = str(m.text, 80);
      const day = { ...(data.meals[m.date] || {}) };
      if (text && !same(day[meal], text)) { // what they eat often comes back as a one-tap choice
        const k = text.toLowerCase(), c = data.mealCounts[k];
        data.mealCounts[k] = { text, n: (c?.n || 0) + 1, last: m.date };
        const keys = Object.keys(data.mealCounts); if (keys.length > 80) delete data.mealCounts[keys.sort((a, b) => data.mealCounts[a].n - data.mealCounts[b].n)[0]];
      }
      if (text) day[meal] = text; else delete day[meal];
      if (Object.keys(day).length) data.meals[m.date] = day; else delete data.meals[m.date];
      did.push(text ? `${m.date} ${meal}: ${text}` : `cleared ${m.date} ${meal}`);
    }
    prune(); save();
    return { ok: true, did };
  }
  function favorite(text, value = true) {
    const t = str(text, 80); if (!t) return { error: 'which meal?' };
    data.favorites = data.favorites.filter((f) => !same(f, t));
    if (value) data.favorites.unshift(t); else delete data.mealCounts[t.toLowerCase()]; // unpinning a suggestion forgets it
    data.favorites = data.favorites.slice(0, 16);
    save(); return { ok: true };
  }
  const SLOTS = ['breakfast', 'lunch', 'dinner'];
  function setSlots(list) {
    const s = SLOTS.filter((x) => arr(list).some((y) => same(y, x)));
    data.mealSlots = s.length ? s : ['dinner']; save(); return { ok: true, slots: data.mealSlots };
  }
  /** A meal's groceries onto Groceries (watch mealWork["date|meal"]). items: just these (the Meals app's sheet, ticked).
   *  Else what its recipe lists (its cooking steps' ingredients, or the lines under "Ingredients" in its notes), with no
   *  model; only a meal with no recipe that lists them asks the assistant. */
  async function ingredients(date, meal = 'dinner', { items = null } = {}) {
    const text = data.meals[date]?.[meal], key = `${date}|${meal}`;
    if (!text) return { error: 'Nothing planned for that meal.' };
    const listed = items != null ? arr(items).map((x) => str(x, 40)).filter(Boolean) : groceriesOf(data.recipes[text.toLowerCase()]);
    if (items != null || listed.length) {
      const groceries = house.findList('Groceries', true);
      const want = listed.filter((t, i) => !listed.slice(0, i).some((o) => sameGrocery(o, t)));
      const fresh = want.filter((t) => !groceries.items.some((i) => !i.done && sameGrocery(i.text, t)));
      if (fresh.length) { const r = house.changeList({ list: 'Groceries', add: fresh }); if (r.error) return r; }
      mealWork[key] = { state: 'done', added: fresh }; changed();
      setTimeout(() => { if (mealWork[key]?.state === 'done') { delete mealWork[key]; changed(); } }, 60e3).unref?.();
      return { ok: true, added: fresh, had: want.filter((t) => !fresh.includes(t)) };
    }
    { const no = house.noAssistant(''); if (no) return { error: `Add a recipe for ${text} first.`, code: 'recipe' }; }
    if (mealWork[key]?.state === 'working') return { ok: true };
    mealWork[key] = { state: 'working' }; changed();
    (async () => {
      try {
        const groceries = house.findList('Groceries', true), open = groceries.items.filter((i) => !i.done).map((i) => i.text);
        // The meal's name, the list and the recipe may be an app's words (or a recipe page's): marked as data.
        const prompt = `What groceries does a family need to make the ${meal} below? The meal, what's already on the grocery list and their recipe for it, if any:\n` +
          `${asData(JSON.stringify({ meal: text, onTheList: open, recipe: data.recipes[text.toLowerCase()]?.notes || null }, null, 1), "the planned meal, the grocery list and the meal's recipe, in the words of whoever wrote them (the household's apps, a recipe's page)", { max: 8000 })}\n` +
          'Reply with only a JSON array of short item names, like ["Tortillas", "Ground beef", "Shredded cheese"]. Leave out what is already on the list and pantry staples (salt, pepper, oil, flour, sugar, spices). At most 10.';
        const sys = 'You turn a planned meal into the few groceries to buy for it. Reply with only a JSON array of strings, nothing else. Use no tools.';
        const said = await house.answer(prompt, sys);
        const items = JSON.parse(said.match(/\[[\s\S]*\]/)?.[0] || '[]').map((x) => str(x, 40)).filter(Boolean).slice(0, 12);
        const fresh = items.filter((t) => !groceries.items.some((i) => !i.done && same(i.text, t)));
        if (fresh.length) must(house.changeList({ list: 'Groceries', add: fresh }));
        mealWork[key] = { state: 'done', added: fresh };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 120) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3);
    })();
    return { ok: true };
  }
  return { favorites, setMeals, favorite, setSlots, ingredients };
}
