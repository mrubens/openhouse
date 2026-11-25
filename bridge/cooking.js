// Recipes turned into cooking steps, once, for the Recipes app (defaults/apps/recipes): a recipe in the box (house.js
// data.recipes, the Meals app's recipe per meal: a link and/or notes) is read into clean steps, each with the
// ingredients and amounts it uses and a timer when it says to wait ("simmer 20 minutes"). The result is kept with the
// recipe ({cook}), so cooking needs no internet.
//
// A link is read here on the tablet (the page the household shared: its schema.org Recipe when it has one, else its
// text). The steps are written by the household's own assistant (the cloud's text model, house.js answer), the
// service they already use; nothing else is sent anywhere. Only public https pages are read, never the home network
// (app-web.js publicGet: every redirect checked again, and the address checked is the one reached).
import { asData } from './as-data.js';
import crypto from 'node:crypto';
import { publicGet, pinnedFetch, reachMatches } from './app-web.js';

/** What a recipe's cooking steps were made from: they're good while this is the same. */
export const cookSource = (r) => crypto.createHash('sha1').update(`${r?.link || ''}\n${r?.notes || ''}`).digest('hex').slice(0, 16);

const clean = (v, n = 200) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&#8217;/g, '’').replace(/&quot;|&#34;/g, '"')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/\s+/g, ' ').trim().slice(0, n);

/** A YouTube watch link in some text, normalized (or null). */
export function youtube(text) {
  const id = String(text || '').match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/)?.[1];
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** An ISO 8601 duration (PT1H30M) in minutes, or 0. */
export const isoMinutes = (d) => { const m = String(d || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/); return m ? (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
/** A picture's https address from a schema.org image (a string, a list, an ImageObject), or null. */
const imageOf = (v) => { for (const x of [].concat(v || [])) { const u = typeof x === 'string' ? x : x?.url || x?.contentUrl; if (/^https:\/\/\S+$/.test(String(u || ''))) return String(u).slice(0, 600); } return null; };
/** A page's og:image, when its Recipe has no picture. */
const ogImage = (html) => imageOf(String(html).match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || String(html).match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1]);

/** The schema.org Recipe in a page's JSON-LD, as plain text (name, ingredients, steps) and its video; or null. */
export function recipeFromHtml(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const found = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object' || found.length) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const t = [].concat(v['@type'] || []).map(String);
    if (t.includes('Recipe')) { found.push(v); return; }
    for (const k of ['@graph', 'mainEntity', 'itemListElement']) if (v[k]) walk(v[k]);
  };
  for (const b of blocks) { try { walk(JSON.parse(b.trim())); } catch {} }
  const r = found[0]; if (!r) return null;
  const steps = [], stepPics = [];
  const addStep = (s) => {
    if (!s) return;
    if (typeof s === 'string') { const t = clean(s, 800); if (t) steps.push(t); return; }
    if (Array.isArray(s)) { s.forEach(addStep); return; }
    if (s.itemListElement) { if (s.name && [].concat(s['@type']).includes('HowToSection')) steps.push(`(${clean(s.name, 80)})`); addStep(s.itemListElement); return; }
    const pic = imageOf(s.image); // a step's own photo, when the site gives one
    if (pic) stepPics.push({ text: clean(s.text || s.name, 800), image: pic });
    addStep(s.text || s.name);
  };
  addStep(r.recipeInstructions);
  const ingredients = [].concat(r.recipeIngredient || r.ingredients || []).map((x) => clean(x, 160)).filter(Boolean);
  if (!steps.length && !ingredients.length) return null;
  const videoOf = (v) => [].concat(v || []).map((x) => youtube(typeof x === 'string' ? x : `${x?.embedUrl || ''} ${x?.contentUrl || ''} ${x?.url || ''}`)).find(Boolean) || null;
  const name = clean(r.name, 80), serves = clean([].concat(r.recipeYield || [])[0], 40);
  return {
    name, serves, video: videoOf(r.video), image: imageOf(r.image), stepPics, minutes: isoMinutes(r.totalTime) || (isoMinutes(r.prepTime) + isoMinutes(r.cookTime)) || null,
    text: [name, serves ? `Serves ${serves}` : '', 'Ingredients', ...ingredients.map((i) => `- ${i}`), 'Steps', ...steps.map((s, i) => `${i + 1}. ${s}`)].filter(Boolean).join('\n'),
  };
}

/** A page's readable text, when it has no Recipe in it (scripts, styles and menus left out). */
export function textFromHtml(html, n = 14000) {
  const title = clean(String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 120);
  const body = String(html).replace(/<(head|title|script|style|noscript|svg|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  const text = body.split('\n').map((l) => clean(l, 600)).filter((l) => l.length > 1).join('\n');
  return { title, text: text.slice(0, n) };
}

/** The page's links to other pages (its text and address), for finding the recipes it builds on ("make the Classic Pizza
 *  Sauce"): https only, each once, not the page itself; the model picks which ones the recipe needs. */
export function linksFromHtml(html, base, n = 60, recipe = '') {
  const out = [], seen = new Set([String(base).split('#')[0]]);
  // A page's menus come first in it; the links in the recipe's own words ("our Classic Pizza Dough") are put first.
  if (recipe) {
    const all = linksFromHtml(html, base, 1000), said = String(recipe).toLowerCase();
    const inIt = all.filter((l) => said.includes(l.text.toLowerCase()));
    return [...inIt, ...all.filter((l) => !inIt.includes(l))].slice(0, n);
  }
  for (const m of String(html).matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url; try { url = new URL(m[1], base); } catch { continue; }
    const text = clean(m[2], 80);
    if (url.protocol !== 'https:' || text.length < 3 || seen.has(url.href)) continue;
    seen.add(url.href); out.push({ text, url: url.href });
    if (out.length >= n) break;
  }
  return out;
}

/** A page's picture, unless it's the site's own stand-in (a logo, a banner: the same picture its home page shows), as some
 *  sites give for a recipe with no photo of its own. */
const fileOf = (u) => { try { return new URL(u).pathname.match(/[^/]+?\.(?:jpe?g|png|webp|avif|gif)/i)?.[0]?.toLowerCase() || u; } catch { return u; } };
const PAGE_HEADERS = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) OpenHouse', accept: 'text/html,*/*' };
async function notPlaceholder(image, url, get) {
  if (!image) return null;
  const r = await publicGet(url.origin + '/', { ...get, timeoutMs: 5000, headers: PAGE_HEADERS });
  if (r.error) return image;
  const home = ogImage(r.buf.toString('utf8').slice(0, 1e6));
  return home && fileOf(home) === fileOf(image) ? null : image;
}

/** Read a shared link: {name, text, video} (the Recipe when the page has one), or throws with words. An http link is
 *  read over https. reaches (a link a shared app gave): the page and every redirect only from those hosts (app-web.js). */
export async function readRecipeLink(link, { fetch = pinnedFetch, lookup, timeoutMs = 12000, reaches = null } = {}) {
  let url; try { url = new URL(String(link ?? '').trim()); } catch { throw new Error('A link starts with https://'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('A link starts with https://');
  if (url.protocol === 'http:') { url.protocol = 'https:'; if (url.port === '80') url.port = ''; }
  const get = { fetch, lookup };
  const allow = Array.isArray(reaches) ? (u) => (reachMatches(u.host, reaches) ? null : { error: 'reach' }) : undefined;
  const r = await publicGet(url.href, { ...get, timeoutMs, max: 3e6, headers: PAGE_HEADERS, ...(allow ? { allow } : {}) });
  if (r.error) throw new Error(r.error === 'timeout' ? 'That page took too long to open.' : r.error === 'home' ? 'That page isn’t on the web.' : r.error === 'reach' ? 'That page sent it to a site this app doesn’t reach.' : 'That page didn’t open.');
  if (r.status < 200 || r.status > 299) throw new Error(`That page didn’t open (${r.status}).`);
  const html = r.buf.toString('utf8').slice(0, 3e6), at = r.url;
  const rec = recipeFromHtml(html), links = linksFromHtml(html, at.href, 60, rec?.text || '');
  if (rec) return { ...rec, image: await notPlaceholder(rec.image || ogImage(html), at, get), recipe: true, links };
  const { title, text } = textFromHtml(html);
  return { name: title.replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, '').slice(0, 80), text, video: youtube(link) || youtube(html), image: ogImage(html), stepPics: [], minutes: null, recipe: false, links };
}

/** Finding recipes on the web (house.js findRecipes): the household's text model searches with OpenAI's web search. */
export const FIND_SYSTEM = 'You find recipes on the web for a family. Use web search. Reply with only JSON, nothing else.';
export function findPrompt(query) {
  return `Find 4 good recipes for: ${String(query).slice(0, 200)}\n` +
    'Pick pages from well-known recipe sites with the full recipe on the page (ingredients and steps), not videos, lists of recipes, or forums. ' +
    'Reply with a JSON array: [{"title": "Weeknight Chili", "url": "https://...", "site": "Serious Eats", "minutes": 45, "about": "a few words on why it fits"}]. ' +
    'url must be the recipe page itself. minutes: the total time if the page says it, else leave it out.';
}
/** The model's list, checked: up to 6 https pages, each once. */
export function parseFound(said) {
  let v; try { v = JSON.parse(String(said).match(/\[[\s\S]*\]/)?.[0] || '[]'); } catch { v = []; }
  const seen = new Set();
  return (Array.isArray(v) ? v : []).map((x) => {
    let url; try { url = new URL(String(x?.url || '')); } catch { return null; }
    if (url.protocol !== 'https:' || seen.has(url.href)) return null; seen.add(url.href);
    const min = Number(x.minutes);
    return { title: clean(x.title, 80) || url.hostname, url: url.href, site: clean(x.site, 40) || url.hostname.replace(/^www\./, ''), ...(min > 0 && min < 2000 ? { minutes: Math.round(min) } : {}), about: clean(x.about, 120) };
  }).filter(Boolean).slice(0, 6);
}

/** What the assistant is asked, and how it answers (JSON only). */
export const COOK_SYSTEM = 'You turn a recipe into the steps a family cooks from, shown all on one page in the kitchen and read aloud. Reply with only JSON, nothing else. Use no tools.';
/** links: the page's links (linksFromHtml), on the first read; the recipes it builds on are asked for as needs.
 *  also: our own words about it, outside the recipe's (a recipe made for another one). */
export function cookPrompt(meal, source, links = [], also = '') {
  // The recipe is a page's words (or someone's paste): marked as data (as-data.js), never as ours.
  const recipe = `The recipe for "${String(meal).slice(0, 200)}":\n\n${String(source).slice(0, 24000)}` +
    (links.length ? `\n\nLinks on its page:\n${links.map((l) => `- ${l.text}: ${l.url}`).join('\n').slice(0, 6000)}` : '');
  return `${asData(recipe, 'a recipe, from its page or as someone wrote it', { max: 31000 })}\n\n${also ? also + '\n\n' : ''}` +
    'Write it as JSON: {"name": "...", "serves": "4", "minutes": 45, "ingredients": [{"item": "ground cumin", "amount": "2 tsp"}], ' +
    '"steps": [{"title": "Simmer the sauce", "part": "Sauce", "text": "...", "uses": [{"item": "ground cumin", "amount": "1 tsp"}], "timer": {"minutes": 20, "label": "Simmer the sauce"}, "hands": "busy", "ahead": "the day before"}]' +
    (links.length ? ', "needs": [{"name": "Classic Pizza Sauce", "url": "https://..."}]' : '') + '}.\n' +
    '- Keep the recipe\'s detail: its own amounts, units, temperatures, sizes, times, and how to tell when something is done. Don\'t shorten or summarize; leave out only stories, ads, nutrition and tips that aren\'t steps.\n' +
    '- One step per thing to do, in order; a long one may be split where the recipe moves on to something else.\n' +
    '- title: 2 to 5 words naming the step, for a list of steps. part: when the recipe has parts (a dough, a sauce, the pizza), the part it belongs to; leave it out otherwise.\n' +
    '- hands: "busy" when someone has to work through it, "wait" when it mostly waits (rising, resting, chilling, an oven heating, baking). ahead: when it has to be done well before (the day before, 2 hours ahead), say so; leave it out otherwise.\n' +
    (links.length ? '- needs: the linked recipes this one says to make or use (a dough, a sauce) whose steps are not written out here; leave it out when there are none. Don\'t list related or suggested recipes.\n' +
      '- makes: on a step that only says to make one of the needs ("prepare the pizza sauce"), that need\'s name exactly as in needs; its own steps go there. Leave it out otherwise.\n' : '') +
    '- amount: short, one measure, no alternatives: the recipe\'s weight and one cup or spoon measure when it gives both ("1 ½ cups (368 g)"); a choice of kinds goes in item, not amount.\n' +
    '- uses: the ingredients that step adds, each with the amount for that step (split an amount used in two steps).\n' +
    '- minutes: how long the whole recipe takes, start to finish: the recipe\'s own total time when it gives one, else your best estimate from its steps.\n' +
    '- timer: only when the step says to wait, cook, bake, rest or simmer for a time; minutes is the shortest time it gives. Leave it out otherwise.\n' +
    '- If there is no recipe in it, reply {"none": true}.';
}

/** The assistant's answer, checked: {name, serves, ingredients, steps}; throws with words. */
export function parseCook(said) {
  let v;
  try { v = JSON.parse(String(said).match(/\{[\s\S]*\}/)?.[0] || ''); } catch { throw new Error('Couldn’t make steps from that recipe.'); }
  if (v?.none) throw new Error('There’s no recipe in that.');
  const ing = (x) => ({ item: clean(x?.item ?? x?.name, 80), amount: clean(x?.amount, 90) });
  const ingredients = (Array.isArray(v?.ingredients) ? v.ingredients : []).map(ing).filter((x) => x.item).slice(0, 60);
  const steps = (Array.isArray(v?.steps) ? v.steps : []).map((s) => {
    const text = clean(typeof s === 'string' ? s : s?.text, 900); if (!text) return null;
    const uses = (Array.isArray(s?.uses) ? s.uses : []).map(ing).filter((x) => x.item).slice(0, 20);
    const min = Number(s?.timer?.minutes);
    const timer = Number.isFinite(min) && min > 0 && min <= 24 * 60 ? { minutes: Math.round(min * 10) / 10, label: clean(s.timer.label, 40) || text.split(/[,.;]/)[0].slice(0, 40) } : null;
    const title = clean(s?.title, 50), part = clean(s?.part, 40), ahead = clean(s?.ahead, 40);
    const makes = clean(s?.makes, 80);
    return { text, ...(makes ? { makes } : {}), ...(title ? { title } : {}), ...(part ? { part } : {}), ...(s?.hands === 'wait' ? { wait: true } : {}), ...(ahead ? { ahead } : {}),
      ...(uses.length ? { uses } : {}), ...(timer ? { timer } : {}) };
  }).filter(Boolean).slice(0, 80);
  if (!steps.length) throw new Error('Couldn’t make steps from that recipe.');
  const needs = (Array.isArray(v?.needs) ? v.needs : []).map((x) => { try { const u = new URL(String(x?.url || '')); return u.protocol === 'https:' ? { name: clean(x?.name, 80) || u.hostname, url: u.href } : null; } catch { return null; } }).filter(Boolean).slice(0, 3);
  const minutes = Math.round(Number(v?.minutes));
  return { name: clean(v.name, 80), serves: clean(v.serves, 40), ...(minutes > 0 && minutes < 10000 ? { minutes } : {}), ingredients, steps, ...(needs.length ? { needs } : {}) };
}

/** The page's step photos put on the steps they belong to. The model splits and rewords steps, so each photo goes to
 *  the step sharing most of its words (at least 40%), the first one if several do; no photo is used twice. */
export function withPictures(cook, stepPics = []) {
  const w = (t) => new Set(String(t).toLowerCase().match(/[a-z]{3,}/g) || []);
  const used = new Set();
  for (const p of stepPics || []) {
    const pw = w(p.text); if (!pw.size) continue;
    let best = -1, score = 0.4;
    cook.steps.forEach((st, i) => {
      if (st.image || used.has(i)) return;
      const sw = w(st.text); let hit = 0; for (const x of sw) if (pw.has(x)) hit++;
      const sc = hit / Math.max(1, Math.min(sw.size, pw.size));
      if (sc > score) { score = sc; best = i; }
    });
    if (best >= 0) { cook.steps[best] = { ...cook.steps[best], image: p.image }; used.add(best); }
  }
  return cook;
}

/** Steps as the plain notes the Meals app shows (when a recipe came in as a link only). */
export const cookAsNotes = (c) => ['Ingredients', ...c.ingredients.map((i) => `- ${[i.amount, i.item].filter(Boolean).join(' ')}`), 'Steps', ...c.steps.map((s, i) => `${i + 1}. ${s.part ? `(${s.part}) ` : ''}${s.text}`)].join('\n');
