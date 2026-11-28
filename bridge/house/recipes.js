// The recipe box (the Recipes app): recipes saved by link, typed, pasted, photographed or written by the assistant,
// made into cooking steps (cooking.js), and recipes found on the web. With no assistant, a recipe typed or pasted in
// the Ingredients / Steps shape, or a link whose page carries its own recipe data, is cooked from as it is
// (kit/recipe-text.js). Each recipe's steps say how they were made (cook.by: hand, page or model), and steps the
// household wrote (hand) are never rewritten by the model unless they ask.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cookSource, readRecipeLink, cookPrompt, COOK_SYSTEM, parseCook, cookAsNotes, youtube, findPrompt, FIND_SYSTEM, parseFound, withPictures } from '../cooking.js';
import { ROOM, str, keepLines, must } from './util.js';
import { asData } from '../as-data.js';
import { DISHES } from '../kit/dish-look.js';
import { parseRecipeText, cookFrom, recipeText } from '../kit/recipe-text.js';
import { RECIPE_LINK_MAX } from '../app-web.js';

/** Opie's starter recipes (defaults/apps/recipes/starters.json: where the built-in apps are, in this checkout or on the
 *  tablet), already in the box's cooking-steps shape. */
export function starterRecipes(file = null) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const d = process.env.DEFAULTS_DIR || path.join(here, '../../defaults'), apps = fs.existsSync(path.join(d, 'apps')) ? path.join(d, 'apps') : d;
  try { return JSON.parse(fs.readFileSync(file || path.join(apps, 'recipes', 'starters.json'), 'utf8')).recipes || []; } catch { return []; }
}
const COOK_V = 2; // the shape of the steps (2: titles, parts, waiting, ahead, full detail)

export default function (house) {
  const { data, save, changed, mealWork, FLYERS } = house;
  // A new household's box starts empty (since 2026-11-28: the owner preferred a blank slate). Boxes that got Opie's
  // starters before keep them, the household's to take out like any other; starters.json stays for those.
  if (!data.starters) {
    data.starters = 1;
    try { save(); } catch (e) { console.error('[recipes] starters not saved:', e.message); }
  } else {
    // Starters put in before they had a kind of dish (cook.dish, their drawn mark): theirs from the file, once.
    const kinds = new Map(starterRecipes(house.STARTERS).map((x) => [str(x?.name, 80).trim().toLowerCase(), x?.dish]));
    let added = 0;
    for (const r of Object.values(data.recipes)) {
      const d = r?.starter && r.cook && !r.cook.dish && kinds.get(String(r.cook.name || r.text || '').toLowerCase());
      if (d && Object.hasOwn(DISHES, d)) { r.cook.dish = d; added++; }
    }
    if (added) try { save(); } catch (e) { console.error('[recipes] starters not saved:', e.message); }
  }
  const NO_DATA = 'Opie can’t read the recipe on that page without an Opie account or your own OpenAI key. Paste or type it in instead.';
  const NO_SHAPE = 'To cook from it, put its ingredients under “Ingredients” and its steps under “Steps”, a line each.';
  const boxFull = () => (Object.keys(data.recipes).length >= ROOM.recipes ? { error: `The recipe box is full (${ROOM.recipes} recipes). Take one out first.`, code: 'full' } : null);
  /** A meal's recipe: a link and/or notes (ingredients, steps); both empty takes it out of the box. */
  function setRecipe(r) {
    const text = str(r?.meal, 80).trim(); if (!text) return { error: 'which meal?' };
    const k = text.toLowerCase(), link = str(r.link, RECIPE_LINK_MAX).trim(), notes = keepLines(r.notes, 4000);
    if (link && !/^https?:\/\//i.test(link)) return { error: 'A link starts with http:// or https://' };
    if (!link && !notes) { delete data.recipes[k]; save(); return { ok: true, did: [`took ${text}'s recipe out`] }; }
    const was = data.recipes[k], unchanged = !!was && cookSource(was) === cookSource({ link, notes });
    if (!was && boxFull()) return boxFull();
    // Its cooking steps (cooking.js) stay while it's the same recipe; a changed one is read again.
    // by: 'assistant' when the assistant wrote it (for its credit); photoFrom: the page its photo came from (photoFor)
    const by = r.by === 'assistant' ? 'assistant' : unchanged ? was.by : undefined;
    // hand: the household wrote its steps (typed or pasted), so a change to them is read as written, not by the model
    const hand = !!notes && (r.hand === true || (r.by !== 'assistant' && !!was && (was.hand || was.cook?.by === 'hand')));
    const serves = r.serves !== undefined ? str(r.serves, 40) : was?.serves || '';
    const minutes = r.minutes !== undefined ? Math.round(Number(r.minutes)) || 0 : was?.minutes || 0;
    const image = /^https:\/\/\S+$/.test(str(r.image, 600)) ? str(r.image, 600) : null; // a picture of its own (typed in): kept over its page's
    // reach: a shared app's link, read (redirects and all) only from the hosts its card said it reaches
    const reach = !link ? null : Array.isArray(r.reach) ? r.reach.map(String).slice(0, 50) : unchanged && Array.isArray(was.reach) ? was.reach : null;
    data.recipes[k] = { text: was?.text || text, ...(link ? { link } : {}), ...(reach ? { reach } : {}), ...(notes ? { notes } : {}), at: Date.now(), ...(by ? { by } : {}), ...(hand ? { hand } : {}), ...(serves ? { serves } : {}), ...(minutes > 0 && minutes < 10000 ? { minutes } : {}),
      ...(unchanged && was.photoFrom ? { photoFrom: was.photoFrom, photoAt: was.photoAt } : {}),
      ...(unchanged && was.cook ? { cook: was.cook } : {}), ...(unchanged && was.video ? { video: was.video } : {}), ...(unchanged && was.image ? { image: was.image, picsAt: was.picsAt } : {}), ...(r.video && youtube(r.video) ? { video: youtube(r.video) } : !unchanged && youtube(link) ? { video: youtube(link) } : {}),
      ...(image ? { image, ownImage: true, picsAt: Date.now(), checkedAt: Date.now() } : was?.ownImage && r.image === undefined ? { image: was.image, ownImage: true, picsAt: was.picsAt, checkedAt: was.checkedAt } : {}) };
    save();
    if (!unchanged && !r.quiet) setTimeout(() => prepareCook(text), 50).unref?.();
    return { ok: true, did: [`saved the recipe for ${text}`] };
  }
  /** A recipe turned into cooking steps, once (cooking.js), kept with it as {cook}; a link only is read first (watch
   *  mealWork["cook|meal"]). Again with force, else only when it has none or the recipe changed since. */
  function prepareCook(meal, { force = false } = {}) {
    const text = str(meal, 80).trim(), k = text.toLowerCase(), key = `cook|${k}`, r = data.recipes[k];
    if (!r) return { error: `There's no recipe for ${text || 'that'} yet.` };
    // (steps made before they had titles, parts and their full detail are made again, once: COOK_V)
    if (!force && r.cook && r.cook.for === cookSource(r) && r.cook.v === COOK_V) { if (r.link && !r.picsAt) pictures(k); if (!r.cook.minutes && !r.timeAt) howLong(k); if (!r.photoFrom && (r.link ? r.picsAt && !r.image : !r.image || r.by === 'assistant')) photoFor(k); else if (r.link && r.image && !r.photoFrom && !r.checkedAt) checkPhoto(k); return { ok: true, ready: true }; }
    const ai = !house.noAssistant('');
    // notes written from its own steps (a link only) aren't the recipe: its page is
    const ownNotes = !!(r.link && r.cook && r.notes === cookAsNotes(r.cook).slice(0, 4000));
    // Without an assistant every recipe is cooked from as written; steps the household wrote are made again from their
    // words, and only by the model when they ask (force: Make the steps again, after a yes).
    if (!ai || (r.hand && !force)) {
      const c = r.notes && !ownNotes ? ownCook(r) : null;
      if (c) { keepCook(k, c); changed(); return { ok: true, ready: true }; }
      if (!ai && !r.link) return { error: NO_SHAPE };
    }
    if (mealWork[key]?.state === 'working') return { ok: true };
    mealWork[key] = { state: 'working' }; changed();
    (async () => {
      try {
        let source = ownNotes ? '' : r.notes || '', video = r.video || null, page = null;
        // a link is read for the recipe (when it's all there is) and for its pictures: the dish and its steps' own photos
        if (r.link) page = await readRecipeLink(r.link, { reaches: r.reach }).catch((e) => { if (!source) throw e; return null; });
        if (page && !source) source = page.text;
        video ||= page?.video || null;
        if (!ai) { const c = ownCook(r, page); if (!c) throw new Error(NO_DATA); keepCook(k, c, page, video); }
        else {
          if (!source.trim()) throw new Error('That recipe has nothing in it to cook from.');
          let cook;
          try { cook = parseCook(await house.answer(cookPrompt(r.text, source, page?.links || []), COOK_SYSTEM), page?.links || []); }
          catch (e) { const c = ownCook(r, page) || (source === r.notes ? ownCook(r) : null); if (!c) throw e; cook = null; keepCook(k, c, page, video); } // (the page's own recipe, or theirs as written)
          if (cook) {
            if (page?.minutes) cook.minutes = page.minutes; // the page's own total time over the model's estimate
            // What it builds on ("make the Classic Pizza Sauce", linked on its page): each of those recipes read and made into
            // steps on its own (one answer for all of them takes longer than the cloud waits), as a part, in place of the step
            // that only says to make it (makes), so nothing is left as "prepare the sauce" with no way to.
            if (cook.needs?.length) cook = withNeeds(cook, (await Promise.all(cook.needs.slice(0, 3).map(async (x) => {
              try { const p = await readRecipeLink(x.url, { timeoutMs: 8000, reaches: r.reach }); const c = parseCook(await house.answer(cookPrompt(x.name, p.text.slice(0, 12000), [], `This is made for ${r.text}, whose own steps go on from where they use it: write only the steps that make the ${x.name} itself, and leave out what comes after it is ready (using it, baking, serving).`), COOK_SYSTEM)); if (p.minutes) c.minutes = p.minutes; return { name: x.name, cook: c }; } catch { return null; }
            }))).filter(Boolean));
            cook.steps = cook.steps.map(({ makes, ...st }) => st);
            delete cook.needs;
            keepCook(k, { ...cook, by: 'model' }, page, video);
          }
        }
        save();
        mealWork[key] = { state: 'done' };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 160) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3).unref?.();
    })();
    return { ok: true };
  }
  /** Steps made here with no model (kit/recipe-text.js): a page's own recipe data, else the notes as written; or null. */
  function ownCook(r, page = null) {
    if (page) return page.recipe && page.steps?.length ? cookFrom({ name: page.name || r.text, ingredients: page.ingredients, steps: page.steps, serves: page.serves, minutes: page.minutes }, 'page') : null;
    const p = parseRecipeText(r.notes);
    return p.steps.length ? cookFrom({ name: r.text, ingredients: p.ingredients, steps: p.steps, serves: r.serves, minutes: r.minutes }, 'hand') : null;
  }
  /** A recipe's cooking steps kept with it (and, from a page, its pictures and video). */
  function keepCook(k, cook, page = null, video = null) {
    const now = data.recipes[k]; if (!now) throw new Error('That recipe was taken out.');
    cook = withPictures(cook, page?.stepPics);
    const ownNotes = now.link && now.cook && now.notes === cookAsNotes(now.cook).slice(0, 4000);
    if (!now.notes || ownNotes) now.notes = cookAsNotes(cook).slice(0, 4000); // a link only: the Meals app shows it too
    if (cook.by === 'hand') now.hand = true; else delete now.hand;
    if (video && !now.video) now.video = video;
    if (page?.image && !now.ownImage) now.image = page.image;
    else if (!now.image) setTimeout(() => photoFor(k), 0); // (a page without a photo of the dish)
    if (now.link && page) now.picsAt = Date.now();
    now.cook = { ...cook, v: COOK_V, for: cookSource(now), at: Date.now() };
    save();
  }
  /** A recipe saved before stand-in pictures were caught (a site's logo for a recipe with no photo): its page read again;
   *  when its picture is the stand-in, it goes, and one of the dish is found (photoFor). */
  function checkPhoto(k) {
    const r = data.recipes[k]; if (!r?.link || r.checkedAt) return;
    r.checkedAt = Date.now(); save();
    readRecipeLink(r.link, { reaches: r.reach }).then((page) => {
      const now = data.recipes[k]; if (!now || page.image) return;
      delete now.image; save(); changed(); photoFor(k);
    }, () => {});
  }
  /** A recipe with no photo of its own (typed, pasted, written by the assistant, or a page without one): a photo of the
   *  dish from a recipe for it on the web (the household's text model searches, as findRecipes does; the first page with a picture), once. */
  function photoFor(k) {
    const r = data.recipes[k]; if (!r || r.starter || r.photoFrom || (r.image ? !(r.photoAt || r.by === 'assistant') : r.photoAt) || house.noAssistant('')) return; // (once; a photo of its own stays; one found before credits were kept is found again)
    r.photoAt = Date.now(); save();
    (async () => {
      const name = r.cook?.name || r.text;
      const found = parseFound(await house.answer(findPrompt(name), FIND_SYSTEM, [], { webSearch: true }));
      for (const f of found) {
        const img = (await readRecipeLink(f.url, { timeoutMs: 5000 }).catch(() => null))?.image;
        const now = data.recipes[k];
        if (img && now && !now.photoFrom && (!now.image || now.photoAt)) { now.image = img; now.photoFrom = f.url; save(); changed(); return; } // (its credit)
      }
    })().catch(() => {});
  }
  /** Steps made before they said how long the recipe takes: its page's total time, else the text model's estimate, once. */
  function howLong(k) {
    const r = data.recipes[k]; if (!r?.cook || r.timeAt) return;
    r.timeAt = Date.now();
    (async () => {
      let m = r.link ? (await readRecipeLink(r.link, { reaches: r.reach }).catch(() => null))?.minutes : null;
      if (!m && !house.noAssistant('')) m = Math.round(Number(String(await house.answer(`How many minutes does this recipe take, start to finish? Reply with only a number.\n\n${cookAsNotes(r.cook).slice(0, 6000)}`, 'Reply with only a number.')).match(/\d+/)?.[0]));
      const now = data.recipes[k];
      if (now?.cook && m > 0 && m < 10000) { now.cook.minutes = m; save(); changed(); }
    })().catch(() => {});
  }
  /** The recipes it builds on put in: each one's steps (as its part) where a step says only to make it, else before the
   *  rest; their ingredients after its own. */
  function withNeeds(cook, subs) {
    if (!subs.length) return cook;
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const steps = (sub) => sub.cook.steps.map(({ makes, ...st }) => ({ ...st, part: sub.name }));
    const placed = new Set(), out = [];
    for (const st of cook.steps) {
      const sub = st.makes && subs.find((x) => same(x.name, st.makes) && !placed.has(x));
      if (sub) { placed.add(sub); out.push(...steps(sub)); } else out.push(st);
    }
    const rest = subs.filter((x) => !placed.has(x)).flatMap(steps);
    const more = subs.flatMap((x) => x.cook.ingredients.map((i) => ({ ...i, part: x.name }))); // (listed under its name)
    const minutes = (cook.minutes || 0) + subs.reduce((n, x) => n + (x.cook.minutes || 0), 0); // (its dough's rise too)
    return { ...cook, ...(minutes ? { minutes } : {}), steps: [...rest, ...out].slice(0, 80), ingredients: [...more, ...cook.ingredients].slice(0, 80) };
  }
  /** A recipe made into steps before pictures were kept: its page read once more for the dish and step photos (no model). */
  function pictures(k) {
    const r = data.recipes[k]; if (!r?.link || r.picsAt) return;
    r.picsAt = Date.now();
    readRecipeLink(r.link, { reaches: r.reach }).then((page) => {
      const now = data.recipes[k]; if (!now?.cook) return;
      if (page.image && !now.ownImage) now.image = page.image;
      now.cook = withPictures({ ...now.cook, steps: now.cook.steps.map((st) => ({ ...st })) }, page.stepPics);
      save();
    }, () => {});
  }
  /** Recipes found on the web for a few words ("a good weeknight chili"): the household's text model searches with
   *  OpenAI's web search (the service they chose), then each page is read here for its picture, time and whether it
   *  really holds a recipe. Shown on the Recipes tab (recipeFind: {query, state, results: [{title, url, site, image,
   *  minutes, about}], text?}); not kept. Saving one is addRecipeLink with its title. */
  let recipeFind = null;
  function findRecipes(query) {
    const q = str(query, 200);
    if (!q) return { error: 'Find what?' };
    { const no = house.noAssistant('Finding recipes'); if (no) return { error: no }; }
    const mine = recipeFind = { query: q, state: 'working', at: Date.now() }; changed();
    (async () => {
      try {
        // A web search through the cloud now and then runs past its 25 s and comes back as an error: once more before giving up.
        const ask = () => house.answer(findPrompt(q), FIND_SYSTEM, [], { webSearch: true });
        const found = parseFound(await ask().catch(() => ask()));
        if (!found.length) throw new Error(`No recipes found for ${q}.`);
        // each page, read here (5 s each, all at once): its own picture and time; one with no recipe in it goes last
        const read = await Promise.all(found.map((f) => readRecipeLink(f.url, { timeoutMs: 5000 }).then((p) => ({ ...f,
          title: f.title || p.name, ...(p.image ? { image: p.image } : {}), ...(p.minutes ? { minutes: p.minutes } : {}), ok: p.recipe !== false }), () => ({ ...f, ok: false }))));
        const results = [...read.filter((r) => r.ok), ...read.filter((r) => !r.ok)].slice(0, 4).map(({ ok, ...r }) => r);
        if (recipeFind === mine) recipeFind = { query: q, state: 'done', at: mine.at, results };
      } catch (e) {
        // In words for the screen and the voice, never the service's own code ("ai service" showed where the search was)
        const said = String(e.message || e);
        if (recipeFind === mine) recipeFind = { query: q, state: 'error', at: mine.at, text: /^No recipes found/.test(said) ? said.slice(0, 160) : `Couldn't search the web for ${q} just now. Try again in a minute.` };
      }
      changed();
    })();
    return { ok: true };
  }
  /** A link shared from a phone (or typed): the page is read for its name, saved as that meal's recipe, and its steps
   *  made (mealWork["link"] while it's read; then mealWork["cook|meal"]). */
  function addRecipeLink({ link, meal = '', reach } = {}) {
    let l = str(link, RECIPE_LINK_MAX); if (l && !/^https?:\/\//i.test(l)) l = 'https://' + l;
    try { if (!/^https?:$/.test(new URL(l).protocol)) throw 0; } catch { return { error: 'That isn’t a link.' }; }
    if (str(meal)) { const x = setRecipe({ meal, link: l, quiet: true, reach }); if (x.error) return x; return prepareCook(meal); }
    if (boxFull()) return boxFull();
    if (mealWork.link?.state === 'working') return { error: 'Still reading the last link.' };
    mealWork.link = { state: 'working', link: l }; changed();
    (async () => {
      try { await saveLink(l, null, reach); } catch (e) { mealWork.link = { state: 'error', text: String(e.message || e).slice(0, 160) }; changed(); }
      setTimeout(() => { if (mealWork.link?.state !== 'working') { delete mealWork.link; changed(); } }, 60e3).unref?.();
    })();
    return { ok: true };
  }
  /** A recipe's page read and saved under its own name (its link kept, for its credit), and its steps made. */
  async function saveLink(l, page = null, reach = undefined) {
    page ||= await readRecipeLink(l, { reaches: reach });
    const ai = !house.noAssistant('');
    if (!ai && !page.recipe) throw new Error(NO_DATA);
    const name = str(page.name, 60) || new URL(l).hostname.replace(/^www\./, '');
    must(setRecipe({ meal: name, link: l, notes: ai && page.text.length < 4000 && /\bIngredients\b/.test(page.text) ? page.text : '', video: page.video || '', quiet: true, reach }));
    if (!ai) { const c = ownCook(data.recipes[name.toLowerCase()], page); if (!c) throw new Error(NO_DATA); keepCook(name.toLowerCase(), c, page, page.video); }
    mealWork.link = { state: 'done', meal: name };
    changed(); if (ai) prepareCook(name);
  }
  /** What someone typed in Add a recipe: a link (read as one), a recipe pasted in (kept as written, named by the model), or an
   *  idea ("something with leftover chicken"): a real recipe for it found on the web and saved as its link (its page, its
   *  photo, its credit); the model writes one only when none is found. Then its steps are made, as for a link. */
  function addRecipeText(input, { reach } = {}) {
    const text = String(input || '').trim().slice(0, 20000);
    if (!text) return { error: 'Nothing to add.' };
    if (/^\S+\.\S+$/.test(text) && !/\n/.test(text)) return addRecipeLink({ link: text, reach }); // one word with a dot in it: a link
    if (house.noAssistant('')) { // no model to tell a recipe from an idea: a recipe pasted in the Ingredients / Steps shape, cooked from as written
      const p = parseRecipeText(text);
      if (!p.steps.length) return { error: /\n/.test(text) ? NO_SHAPE : house.noAssistant('An idea') }; // (one line: an idea, not a recipe)
      if (!p.name) return { error: 'Put the recipe’s name on its first line.' };
      if (!data.recipes[p.name.toLowerCase()] && boxFull()) return boxFull();
      const x = setRecipe({ meal: p.name, notes: text.slice(0, 4000), quiet: true, hand: true }); if (x.error) return x;
      const c = prepareCook(p.name); if (c.error) return c;
      mealWork.link = { state: 'done', meal: p.name }; changed();
      setTimeout(() => { if (mealWork.link?.state === 'done') { delete mealWork.link; changed(); } }, 60e3).unref?.();
      return { ok: true, meal: p.name };
    }
    if (boxFull()) return boxFull(); // (before the work of finding or writing one: a new one wouldn't fit)
    if (mealWork.link?.state === 'working') return { error: 'Still adding the last one.' };
    mealWork.link = { state: 'working' }; changed();
    (async () => {
      try {
        // (typed on the tablet, or sent by an app: an app's words are data)
        const said = await house.answer(`Someone typed this to add a recipe to their family's recipe box:\n\n${asData(text, 'what was typed or sent by an app', { max: 20000 })}\n\n` +
          'If it is a recipe (its ingredients or steps), reply {"name": "the dish\'s name", "pasted": true}. If it is an idea or a dish\'s name, ' +
          'reply {"name": "the dish\'s name", "find": "what to search the web for to find one good recipe for it"}. Reply with only the JSON.',
          'You add recipes to a family\'s recipe box. Reply with only JSON. Use no tools.');
        const v = JSON.parse(String(said).match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (!v.pasted) { // an idea: the first recipe page found for it that has a recipe in it
          for (const f of parseFound(await house.answer(findPrompt(str(v.find, 200) || str(v.name, 60) || text.slice(0, 200)), FIND_SYSTEM, [], { webSearch: true }))) {
            const page = await readRecipeLink(f.url, { timeoutMs: 8000 }).catch(() => null);
            if (page?.recipe) { await saveLink(f.url, page); return; }
          }
        }
        const name = str(v.name, 60).trim();
        const notes = v.pasted ? text.slice(0, 4000) : (await house.answer(`Write a simple family recipe for "${name || text.slice(0, 200)}". First a line "Ingredients", then one ingredient per line starting with "- ", then a line "Steps", then numbered steps. Plain text, under 1500 characters.`,
          'You write short, reliable home recipes for a family. Reply with only the recipe. Use no tools.')).trim();
        if (!name || !notes) throw new Error('Couldn’t make a recipe from that.');
        must(setRecipe({ meal: name, notes, quiet: true, ...(v.pasted ? {} : { by: 'assistant' }) }));
        mealWork.link = { state: 'done', meal: name };
        changed(); prepareCook(name); photoFor(name.toLowerCase());
      } catch (e) { mealWork.link = { state: 'error', text: String(e.message || e).slice(0, 160) }; changed(); }
      finally { setTimeout(() => { if (mealWork.link?.state !== 'working') { delete mealWork.link; changed(); } }, 60e3).unref?.(); }
    })();
    return { ok: true };
  }
  /** A recipe typed in (the Recipes app's Type it in, save_recipe's name and steps): its name, ingredients and steps a
   *  line each (or lists); its link, picture, serves and minutes if given. Cooked from as written, with no model. */
  function addTyped(t = {}, { reach } = {}) {
    const name = str(t.name, 60); if (!name) return { error: 'Give it a name.' };
    const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim());
    const ingredients = lines(t.ingredients).map((x) => x.replace(/^(?:[-•*·]\s*)+/, '').slice(0, 160)).filter(Boolean).slice(0, 60);
    const steps = lines(t.steps).map((x) => x.replace(/^(?:step\s*)?\d{1,2}\s*[.):](?:\s+|$)/i, '').replace(/^[-•*·]\s*/, '').slice(0, 900)).filter(Boolean).slice(0, 80);
    if (!steps.length) return { error: 'Add its steps, a line each.' };
    if (!data.recipes[name.toLowerCase()] && boxFull()) return boxFull();
    let link = str(t.link, RECIPE_LINK_MAX); if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
    const x = setRecipe({ meal: name, link, notes: recipeText(ingredients, steps), quiet: true, hand: true, serves: t.serves ?? '', minutes: t.minutes ?? 0, image: t.picture || null, reach });
    if (x.error) return x;
    const c = prepareCook(name); if (c.error) return c;
    return { ok: true, meal: name, did: [`saved the recipe for ${name}`] };
  }
  /** The assistant writes a meal's recipe into the box (watch mealWork["recipe|meal"]). */
  function writeRecipe(meal) {
    const text = str(meal, 80).trim(), key = `recipe|${text.toLowerCase()}`;
    if (!text) return { error: 'which meal?' };
    { const no = house.noAssistant('That'); if (no) return { error: no }; }
    if (mealWork[key]?.state === 'working') return { ok: true };
    mealWork[key] = { state: 'working' }; changed();
    (async () => {
      try {
        const prompt = `Write a simple family recipe for "${text}". First a line "Ingredients", then one ingredient per line starting with "- ", then a line "Steps", then numbered steps. Plain text, no markdown headings or bold, under 1500 characters.`;
        const notes = (await house.answer(prompt, 'You write short, reliable home recipes for a family. Reply with only the recipe. Use no tools.')).trim();
        if (!notes) throw new Error('no recipe');
        must(setRecipe({ meal: text, link: data.recipes[text.toLowerCase()]?.link, notes, by: 'assistant' }));
        mealWork[key] = { state: 'done' };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 120) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3);
    })();
    return { ok: true };
  }
  /** A photo of a recipe for a meal: the assistant reads it into the recipe box (mealWork["recipe|meal"], photo: true). */
  function addRecipePhoto(bytes, meal) {
    const text = str(meal, 80).trim(), key = `recipe|${text.toLowerCase()}`;
    if (!text) return { error: 'which meal?' };
    { const no = house.noAssistant('Reading a recipe'); if (no) return { error: no }; }
    fs.mkdirSync(FLYERS, { recursive: true });
    fs.writeFileSync(path.join(FLYERS, Date.now() + '.jpg'), bytes);
    for (const f of fs.readdirSync(FLYERS).sort().slice(0, -5)) try { fs.unlinkSync(path.join(FLYERS, f)); } catch {}
    mealWork[key] = { state: 'working', photo: true }; changed();
    (async () => {
      try {
        const prompt = `Someone sent the family display a photo of a recipe for "${text}" (a recipe card, a cookbook page, a screenshot). It's attached (or the flyer_photo tool shows it). ` +
          'Type it out: first a line "Ingredients", then one ingredient per line starting with "- ", then a line "Steps", then numbered steps. Plain text, no markdown. Keep its amounts and words; leave out stories and ads. If you can\'t read a recipe in it, reply only NONE.';
        const notes = (await house.answer(prompt, 'You type recipes from photos for a family. Reply with only the recipe.', house.photoBytes())).trim();
        if (!notes || /^NONE\b/.test(notes)) throw new Error('Couldn’t read a recipe in that photo. Try closer, straight on.');
        must(setRecipe({ meal: text, link: data.recipes[text.toLowerCase()]?.link, notes: notes.slice(0, 4000) }));
        mealWork[key] = { state: 'done' };
      } catch (e) { mealWork[key] = { state: 'error', text: String(e.message || e).slice(0, 120) }; }
      changed();
      setTimeout(() => { if (mealWork[key]?.state !== 'working') { delete mealWork[key]; changed(); } }, 60e3);
    })();
    return { ok: true };
  }
  const recipeFindNow = () => recipeFind;
  function findDone() { recipeFind = null; changed(); return { ok: true }; }
  return { setRecipe, prepareCook, findRecipes, addRecipeLink, addRecipeText, addTyped, writeRecipe, addRecipePhoto, recipeFindNow, findDone };
}
