// Recipes: the household's recipe box (the Meals app's recipe per meal, the same data), and cooking from it hands-free.
// A recipe comes in by a link (shared from a phone or typed here), a photo of a cookbook page, typed in, or written by
// the assistant; it's made into steps once (bridge/cooking.js) and kept, so cooking needs no internet.
//
// Cooking: the whole recipe on one page (what it needs, then every step, in its parts), with a list of the steps down
// the side to jump to one; the step they're on is marked and kept in view. "Opie, next", "go to the sauce", "go back",
// "how much cumin?" come in as the app's voice actions (app.json) and go through the same moves (cook.js), so the
// screen and the voice never disagree. While cooking the screen stays on and the live voice keeps listening a little after each
// answer (kit handsFree), so the next "next" needs no name for a while.
import { house, store, timer, phone, handsFree, onAction } from '/kit/openhouse.js';
import { findRecipe, mealsNow, move, sayAt, howMuch, needs, noteAt, timerWords, searchBox, sayFound, sayHits } from './cook.js';

// ---- drawing: small helpers (no framework) ----------------------------------------------------------------
const $app = document.getElementById('app');
const $over = document.body.appendChild(document.createElement('div'));

/** An element: h('div', { class, tap, ...attributes }, ...children). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'tap') continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (props?.tap) press(el, props.tap);
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
/** A tap: finger up without moving far (a wet wrist slides a little, so it's forgiving). */
function press(el, tap) {
  let x = 0, y = 0, down = false;
  el.addEventListener('pointerdown', (e) => { e.stopPropagation(); down = true; x = e.clientX; y = e.clientY; });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - x, e.clientY - y) > 40) down = false; });
  el.addEventListener('pointercancel', () => { down = false; });
  el.addEventListener('pointerup', (e) => { const was = down; down = false; if (was) { e.stopPropagation(); tap(e); } });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el && !el.disabled) { e.preventDefault(); tap(e); } });
}
const btn = (label, tap, { soft = false, disabled = false, cls = '' } = {}) => h('button', { class: `btn ${soft ? 'soft' : ''} ${cls}`, disabled, tap: disabled ? null : tap }, label);

// ---- cards over the app ----
const sheets = [];
function openCard(render, { width = 820 } = {}) {
  const card = h('div', { class: 'sheet', style: `width:calc(${width} * var(--u))`, tap: () => {} });
  const s = { redraw: () => card.replaceChildren(...[render(s.close)].flat().filter(Boolean)), close: () => { sheets.splice(sheets.indexOf(s) >>> 0, 1); scrim.remove(); } };
  const scrim = h('div', { class: 'scrim high', tap: () => s.close() }, card);
  sheets.push(s); $over.append(scrim); s.redraw();
  return s;
}

// ---- state ----
let H = null;
/** Cooking now: {key, at} (at: 0 before step 1, 1..n the steps, n + 1 the end), kept so a reload carries on. */
let cooking = null;
/** A recipe asked for while its steps were still being made: cooking starts when they're ready. */
let waiting = null;
let video = null; // {shown, playing} while cooking a recipe with a video
const started = new Set(); // the steps whose timer was started (key|at), so the button says so

const recipeOf = (key) => H?.recipes?.[key] || null;
const cookOf = (key) => recipeOf(key)?.cook || null;
const workOf = (key) => H?.mealWork?.[`cook|${key}`] || null;
const nameOf = (key) => cookOf(key)?.name || recipeOf(key)?.text || key;
const planned = () => mealsNow(H?.meals, house.dayKey(), new Date().getHours());

function draw() {
  $body.replaceChildren(cooking && cookOf(cooking.key) ? cookView() : boxView());
  for (const s of sheets) s.redraw();
}

// ---- cooking: the moves (the screen's taps and the voice both come here) ----
function begin(key, at = 0) {
  if (recipeOf(key)?.link && !recipeOf(key).picsAt) house.prepareCook(recipeOf(key).text); // (one made before pictures: they're fetched)
  cooking = { key, at }; waiting = null; video = null;
  for (const s of [...sheets]) s.close();
  saved(); draw();
}
function go(where, to = null) {
  if (!cooking) return 'Nothing is cooking. Say which recipe.';
  const c = cookOf(cooking.key), r = move(c, cooking.at, where, to);
  cooking.at = Math.max(0, Math.min(c.steps.length + 1, r.at)); saved(); draw();
  return r.say;
}
function stop() { cooking = null; video = null; playerFor(null); saved(); draw(); return 'Stopped cooking.'; }
function startTimer(min = null) {
  if (!cooking) return 'Nothing is cooking.';
  const c = cookOf(cooking.key), s = c.steps[cooking.at - 1], m = Number(min) > 0 ? Number(min) : s?.timer?.minutes;
  if (!m) return "This step doesn't say how long. Say how many minutes.";
  const own = s?.timer && (!(Number(min) > 0) || Number(min) === s.timer.minutes); // the step's own timer, by its label
  const label = String((own ? s.timer.label : c.name || nameOf(cooking.key)) || 'Cooking').slice(0, 40);
  timer.start(label, Math.round(m * 60));
  started.add(`${cooking.key}|${cooking.at}`); draw();
  return `${timerWords(m).replace('-', ' ')} timer on${label ? ` for ${label.toLowerCase()}` : ''}.`;
}
/** The place, kept (a reload carries on) and told to the live voice (what's on the screen now). */
function saved() {
  store.set('cooking', cooking ? { ...cooking, when: Date.now() } : null);
  if (cooking && cookOf(cooking.key)) handsFree({ note: noteAt(cookOf(cooking.key), cooking.at), listen: LISTEN_S, minutes: 40 });
  else handsFree(null);
  watch();
}
/** How long the live voice stays after the last words while cooking (LiveVoice ends it then): "next" works without the name for
 *  this long; then it's "Opie, next" again. 30 s: docs/recipes.md has the costs this was chosen from. */
const LISTEN_S = 30;

/** Cook a recipe by name (none: the meal planned for now). What the voice says. */
function cook(name) {
  const f = findRecipe(H?.recipes, name, planned());
  if (!f) return name ? `There's no recipe for ${name} in the box yet. Add one in Recipes or Meals.` : "Nothing with a recipe is planned for now. Which recipe?";
  if (cookOf(f.key)?.v === 2) { begin(f.key); return sayAt(cookOf(f.key), 0); } // (older steps, or a changed recipe's, are made again by the bridge)
  waiting = { key: f.key, at: Date.now() };
  if (workOf(f.key)?.state !== 'working') house.prepareCook(f.recipe.text);
  draw();
  return `Getting ${f.recipe.text} ready to cook. It takes about half a minute; it'll be on the screen.`;
}

// ---- the voice's actions (app.json) ----
let stopActions = null, every = 0;
function watch() { // look often while cooking (an answer is waited for), now and then otherwise
  const want = cooking || waiting ? 400 : 1000;
  if (want === every) return;
  stopActions?.(); every = want;
  stopActions = onAction(act, want);
}
async function act(name, a) {
  if (!H) await new Promise((r) => { const t = setInterval(() => { if (H) { clearInterval(t); r(); } }, 100); });
  if (name === 'cook') return cook(a.recipe || (chosen && Date.now() - chosen.at < 30 * 60e3 ? recipeOf(chosen.key)?.text || '' : ''));
  if (name === 'find') return findAndSay(String(a.what || ''));
  if (name === 'choose') return choose(Math.round(Number(a.number) || 1) - 1);
  if (name === 'look') { $search.value = String(a.for || ''); draw(); return sayHits(searchBox(H?.recipes, H?.favorites, a.for || ''), a.for || ''); }
  if (!cooking || !cookOf(cooking.key)) return name === 'stop' ? 'Nothing is cooking.' : 'Nothing is cooking right now. Say which recipe to make.';
  const c = cookOf(cooking.key);
  if (name === 'step') return go(a.go || 'again', Number.isInteger(Number(a.to)) && a.to !== '' && a.to != null ? Number(a.to) : null);
  if (name === 'how_much') return howMuch(c, cooking.at, a.ingredient || '');
  if (name === 'ingredients') return needs(c, cooking.at, !!a.all);
  if (name === 'timer') return startTimer(a.minutes);
  if (name === 'video') return videoDo(a.do);
  if (name === 'stop') return stop();
  return "That isn't something Recipes does.";
}

/** "Find a good weeknight chili": search, and say the options once they're on the screen (the bridge waits for this answer). */
async function findAndSay(q) {
  if (!q) return 'Find what?';
  if (cooking) stop();
  $search.value = q; webFind(q);
  if (!H?.ai) return 'Finding recipes needs the assistant turned on.';
  for (let t = 0; t < 104; t++) { // up to 26 s
    await new Promise((r) => setTimeout(r, 250));
    const f = H?.recipeFind;
    if (f?.query === q && f.state !== 'working') return f.state === 'error' ? f.text : sayFound(f.results);
  }
  return `Still looking for ${q}. The options will be on the Recipes screen in a moment.`;
}

// ---- the recipe's video (YouTube, beside the steps), driven by the voice too ----
function videoDo(what) {
  if (!recipeOf(cooking.key)?.video) return "This recipe doesn't have a video.";
  video ||= { shown: false, playing: false };
  if (what === 'hide') { video.shown = false; video.playing = false; draw(); return 'Video hidden.'; }
  if (!video.shown) { video.shown = true; video.playing = what !== 'pause'; draw(); return what === 'show' ? 'Here is the video. Say play when you want it.' : 'Playing the video.'; }
  const f = $video.querySelector('iframe');
  const cmd = (func, args = []) => f?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
  if (what === 'pause') { cmd('pauseVideo'); video.playing = false; return 'Paused.'; }
  if (what === 'back') { ytBack(cmd); return 'Back ten seconds.'; }
  cmd('playVideo'); video.playing = true; return 'Playing.';
}
let ytTime = 0;
addEventListener('message', (e) => { // the player tells its time (the IFrame API's infoDelivery), for "back ten seconds"
  if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin || 'http://x').hostname)) return;
  try { const m = JSON.parse(e.data); if (m?.info?.currentTime != null) window.ytTime = ytTime = m.info.currentTime; } catch {}
});
/** The player sends its time only once it's asked to (the IFrame API's "listening"). */
const listen = (f) => f.addEventListener('load', () => f.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'recipes', channel: 'widget' }), '*'));
const ytBack = (cmd) => { cmd('seekTo', [Math.max(0, ytTime - 10), true]); cmd('playVideo'); };
/** The video's player: one frame over the side column's spot, kept from one draw to the next (an iframe taken out of
 *  the page and put back loads again, and moving to the next step mustn't start the video over). */
const $video = document.body.appendChild(h('div', { class: 'video over', hidden: true, tap: () => {} }));
function playerFor(id) {
  const f = $video.firstChild;
  if (!id) { $video.hidden = true; if (f) f.remove(); return; }
  $video.hidden = false;
  if (f?.dataset.id === id) return;
  const nf = h('iframe', { 'data-id': id, src: `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&playsinline=1&rel=0&origin=${encodeURIComponent(location.origin)}`, allow: 'autoplay; encrypted-media', title: 'Video' });
  nf.addEventListener('load', () => setTimeout(() => { if (video?.playing) nf.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*'); }, 600));
  listen(nf); $video.replaceChildren(nf);
}
const ytId = (u) => String(u || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)?.[1];

// ---- the cooking view ----
let shownAt = null; // the step last scrolled into view (a redraw for anything else keeps their place)
function cookView() {
  const c = cookOf(cooking.key), n = c.steps.length, at = cooking.at;
  if (!video && recipeOf(cooking.key)?.video) video = { shown: false, playing: false }; // (also after a reload mid-cook)
  const vid = video?.shown && ytId(recipeOf(cooking.key)?.video);
  const was = { page: $body.querySelector('.cook .page')?.scrollTop || 0, toc: $body.querySelector('.cook .toc-list')?.scrollTop || 0 };
  const jump = (i) => go('to', i);
  const y = String(c.serves || '').trim().replace(/\.$/, '');
  const makes = !y ? '' : /^\d+(\s*(-|–|to)\s*\d+)?$/.test(y) ? `Serves ${y}` : `${y[0].toUpperCase()}${y.slice(1)}`;
  const short = (st) => st.title || st.text.split(/[.;]/)[0].slice(0, 40);
  const notes = (st) => [st.ahead ? st.ahead[0].toUpperCase() + st.ahead.slice(1) : '', st.wait ? 'Mostly waiting' : ''].filter(Boolean).join(' · ');

  // the list of steps, by part: tap one to go there
  const toc = [h('button', { class: 'ti need' + (at <= 0 ? ' on' : ''), tap: () => { cooking.at = 0; saved(); draw(); } }, h('span', { class: 't' }, 'What you need'))];
  let part = null;
  c.steps.forEach((st, i) => {
    if (st.part && st.part !== part) { part = st.part; toc.push(h('div', { class: 'tpart' }, part)); }
    toc.push(h('button', { class: 'ti' + (at === i + 1 ? ' on' : '') + (at > i + 1 ? ' done' : ''), tap: () => jump(i + 1) },
      h('span', { class: 'n' }, String(i + 1)), h('span', { class: 't' }, short(st))));
  });
  const tocList = h('div', { class: 'toc-list vscroll' }, toc);
  const side = h('div', { class: 'toc' },
    h('div', { class: 'toc-top' }, h('div', { class: 'dish' }, c.name || nameOf(cooking.key)), h('button', { class: 'stop', tap: () => stop() }, 'Stop')),
    tocList,
    video ? h('button', { class: 'vid', tap: () => { video.shown = !video.shown; if (!video.shown) video.playing = false; draw(); } }, vid ? 'Hide video' : 'Video') : null);

  // the page: what it needs, then every step
  const photo = recipeOf(cooking.key)?.image;
  const page = [h('div', { class: 'need' + (at <= 0 ? ' on' : ''), 'data-at': '0' },
    h('div', { class: 'need-head' },
      h('div', null, h('h1', null, c.name || nameOf(cooking.key)), makes ? h('div', { class: 'makes' }, makes) : null, h('h2', null, 'What you need')),
      photo && !vid ? h('img', { class: 'dishpic', src: photo, alt: '', referrerpolicy: 'no-referrer', onerror: 'this.remove()' }) : null),
    c.ingredients.length ? h('ul', { class: 'all' }, c.ingredients.map((x) => h('li', null, x.amount ? h('b', null, x.amount + ' ') : null, x.item))) : h('p', { class: 'none' }, 'The recipe doesn’t list them.'))];
  part = null;
  c.steps.forEach((st, i) => {
    if (st.part && st.part !== part) { part = st.part; page.push(h('h2', { class: 'part' }, part)); }
    const key = `${cooking.key}|${i + 1}`, on = at === i + 1;
    page.push(h('div', { class: 'rstep' + (on ? ' on' : '') + (at > i + 1 ? ' done' : ''), 'data-at': String(i + 1), tap: () => { if (!on) jump(i + 1); } },
      h('div', { class: 'num' }, String(i + 1)),
      h('div', { class: 'body' },
        h('p', null, st.text),
        on && notes(st) ? h('div', { class: 'snote' }, notes(st)) : null,
        on && st.uses?.length ? h('div', { class: 'suses' }, st.uses.map((x) => h('span', null, x.amount ? h('b', null, x.amount + ' ') : null, x.item))) : null,
        on && st.timer ? h('button', { class: 'timer' + (started.has(key) ? ' on' : ''), tap: (e) => { cooking.at = i + 1; startTimer(); } },
          started.has(key) ? `${timerWords(st.timer.minutes).replace('-', ' ')} timer on` : `Start ${timerWords(st.timer.minutes).replace('-minute', ' min').replace('-hour', ' hr').replace('-second', ' s')} timer`) : null),
      on && st.image ? h('img', { class: 'spic', src: st.image, alt: '', referrerpolicy: 'no-referrer', onerror: 'this.remove()' }) : null));
  });
  page.push(h('div', { class: 'end' + (at > n ? ' on' : ''), 'data-at': String(n + 1) }, h('div', { class: 'big' }, 'That’s the whole recipe.'), btn('Done cooking', () => stop())));
  const pageEl = h('div', { class: 'page vscroll' }, vid ? h('div', { class: 'video spot' }) : null, page);
  const view = h('div', { class: 'cook' }, side, pageEl);

  // keep their place on a redraw; bring the marked step into view when it changes
  requestAnimationFrame(() => {
    tocList.scrollTop = was.toc; pageEl.scrollTop = was.page;
    if (shownAt !== `${cooking?.key}|${at}`) {
      shownAt = `${cooking?.key}|${at}`;
      pageEl.querySelector(`[data-at="${Math.min(at, n + 1)}"]`)?.scrollIntoView({ block: at <= 0 ? 'start' : 'center', behavior: was.page ? 'smooth' : 'auto' });
      tocList.querySelector('.ti.on')?.scrollIntoView({ block: 'nearest' });
    }
  });
  playerFor(vid);
  return view;
}

// ---- finding one: the search field (saved ones as you type; Enter or Search the web for new ones) ----
const $search = h('input', { class: 'field search', placeholder: 'Find a recipe', enterkeyhint: 'search', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
$search.addEventListener('input', () => { draw(); });
$search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && $search.value.trim()) { e.preventDefault(); $search.blur(); webFind($search.value.trim()); } });
const $web = btn('Search the web', () => { const q = $search.value.trim(); if (q) { $search.blur(); webFind(q); } else $search.focus(); }, { soft: true });
const $top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Recipes'), $search, $web, btn('Add a recipe', addCard, { soft: true }));
const $body = h('div', { class: 'body' });
$app.append($top, $body);

/** Recipes found on the web for these words (the bridge searches through the household's text model: findRecipes). */
function webFind(q) {
  if (!H?.ai) { openCard((close) => [h('h2', null, 'Search the web'), h('p', { class: 'note' }, 'Finding recipes on the web needs the assistant (Settings, Voice).'), h('div', { class: 'actions' }, btn('OK', close))]); return; }
  H.recipeFind = { query: q, state: 'working', at: Date.now() }; draw();
  house.findRecipes(q);
}
/** One of the recipes found, saved into the box (made into steps as it goes in) and opened. What the voice says. */
let chosen = null; // {key, at}: the one picked last, so "let's make it" knows which
function choose(i) {
  const r = H?.recipeFind?.results?.[i];
  if (!r) return H?.recipeFind?.results?.length ? `There are only ${H.recipeFind.results.length}.` : 'Nothing has been found yet. Say what to look for.';
  const have = Object.entries(H.recipes || {}).find(([, x]) => x.link === r.url);
  const key = have ? have[0] : r.title.toLowerCase();
  chosen = { key, at: Date.now() };
  if (!have) house.addRecipeLink(r.url, r.title);
  openWhenThere(key);
  return have ? `${r.title} is already in the recipe box.${cookOf(key) ? ' Say let\'s make it to start.' : ''}` : `Saved ${r.title}. Making the steps now; say let's make it when you're ready.`;
}
function openWhenThere(key, tries = 40) { if (recipeOf(key)) recipeCard(key); else if (tries > 0) setTimeout(() => openWhenThere(key, tries - 1), 250); }
const minutesText = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

// ---- the box ----
function boxView() {
  const q = $search.value.trim(), hits = q ? searchBox(H?.recipes, H?.favorites, q) : null;
  const all = hits ? hits.filter((x) => x.key).map((x) => [x.key, H.recipes[x.key]]) : Object.entries(H?.recipes || {}).sort((a, b) => (a[1].text || a[0]).localeCompare(b[1].text || b[0]));
  const tonight = findRecipe(H?.recipes, '', planned()), w = waiting && workOf(waiting.key);
  const link = H?.mealWork?.link, f = H?.recipeFind;
  return h('div', { style: 'display:contents' },
    f ? foundView(f) : null,
    q || f ? null : waiting ? h('div', { class: 'tonight' }, h('div', { class: 'what' }, h('div', { class: 'when' }, 'Getting it ready'),
      h('div', { class: 'name' }, w?.state === 'error' ? w.text : `${recipeOf(waiting.key)?.text || ''}: making the steps…`)),
      w?.state === 'error' ? btn('Try again', () => { house.prepareCook(recipeOf(waiting.key).text, true); }, { soft: true }) : null,
      btn('Cancel', () => { waiting = null; watch(); draw(); }, { soft: true }))
      : tonight ? h('div', { class: 'tonight' }, h('div', { class: 'what' }, h('div', { class: 'when' }, 'Planned for now'), h('div', { class: 'name' }, nameOf(tonight.key))),
        btn('Cook', () => cook(tonight.recipe.text), { cls: 'go' })) : null,
    link ? h('p', { class: 'note' }, link.state === 'working' ? 'Reading the recipe from that link…' : link.state === 'error' ? link.text : `Added ${link.meal}.`) : null,
    q ? h('h3', { class: 'section' }, all.length ? 'In the recipe box' : `Nothing in the recipe box for ${q}`) : null,
    all.length ? h('div', { class: 'grid vscroll' }, all.map(([key, r]) => h('button', { class: 'card' + (r.image ? ' with-pic' : ''), tap: () => recipeCard(key) },
      r.image ? h('img', { class: 'thumb', src: r.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: 'this.remove()' }) : null,
      h('div', { class: 'words' }, h('div', { class: 'name' }, r.cook?.name || r.text), h('div', { class: 'about' }, about(key, r))))))
      : q ? (f?.query === q ? null : btn(`Search the web for ${q}`, () => webFind(q), { soft: true, cls: 'webq' }))
      : h('p', { class: 'empty' }, 'No recipes yet. Find one, or add one by its link, a photo of the page, or by typing it. Each one is made into steps you can cook from, hands-free.'),
    hits?.some((x) => !x.key) ? h('p', { class: 'note' }, `Favorite meals: ${hits.filter((x) => !x.key).map((x) => x.name).join(', ')} (no recipe yet).`) : null);
}
/** The recipes found on the web: a picture from its own site, the name, the time, the site. */
function foundView(f) {
  const working = f.state === 'working', none = f.state === 'error' || (f.state === 'done' && !f.results?.length);
  return h('div', { class: 'found' + (working ? ' working' : '') },
    h('div', { class: 'found-head' },
      h('div', { class: 'looking' }, working ? `Looking for ${f.query}…` : none ? (f.text || `Nothing found for ${f.query}.`) : `Found for ${f.query}`),
      none ? btn('Try again', () => webFind(f.query), { soft: true }) : null,
      working ? null : btn('Close', () => { H.recipeFind = null; draw(); house.findDone(); }, { soft: true })),
    // while it looks: a quiet line moving across, and the spaces the options will take
    working ? h('div', { class: 'moving' }, h('i')) : null,
    working ? h('div', { class: 'options' }, [0, 1, 2, 3].map(() => h('div', { class: 'option empty' }, h('div', { class: 'pic' }), h('div', { class: 'bar' }), h('div', { class: 'bar short' })))) : null,
    f.results?.length ? h('div', { class: 'options' }, f.results.map((r, i) => h('button', { class: 'option', tap: () => choose(i) },
      h('div', { class: 'pic' }, r.image ? h('img', { src: r.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: 'this.remove()' }) : null, h('span', { class: 'n' }, String(i + 1))),
      h('div', { class: 'name' }, r.title),
      h('div', { class: 'about' }, [r.minutes && minutesText(r.minutes), r.site].filter(Boolean).join(' · '))))) : null);
}
function about(key, r) {
  const w = workOf(key);
  if (w?.state === 'working') return 'Making the steps…';
  if (w?.state === 'error') return w.text;
  if (r.cook) return [`${r.cook.steps.length} step${r.cook.steps.length === 1 ? "" : "s"}`, r.cook.serves && `serves ${r.cook.serves}`, r.video && 'video'].filter(Boolean).join(' · ');
  return r.link && !r.notes ? 'A link' : 'Not ready to cook yet';
}

/** One recipe: what it needs and its steps, Cook, and the rest. */
function recipeCard(key) {
  openCard((close) => {
    const r = recipeOf(key); if (!r) { close(); return []; }
    const c = r.cook, w = workOf(key);
    return [
      h('h2', null, c?.name || r.text),
      r.link ? h('div', { class: 'link' }, r.link) : null,
      c ? h('div', { class: 'recipe vscroll' }, ['You need', ...c.ingredients.map((i) => `· ${[i.amount, i.item].filter(Boolean).join(' ')}`), '', ...c.steps.map((s, i) => `${i + 1}. ${s.text}`)].join('\n'))
        : r.notes ? h('div', { class: 'recipe vscroll' }, r.notes) : null,
      w ? h('p', { class: 'note' }, w.state === 'working' ? 'Making the steps…' : w.state === 'error' ? w.text : '') : null,
      h('div', { class: 'actions' },
        btn('Take it out', () => { close(); takeOut(key); }, { soft: true, cls: 'left' }),
        H.ai && w?.state !== 'working' ? btn(c ? 'Make the steps again' : 'Make the steps', () => house.prepareCook(r.text, true), { soft: true }) : null,
        btn('Close', close, { soft: true }),
        c ? btn('Cook', () => { close(); begin(key); }) : null),
    ];
  }, { width: 1000 });
}
/** Take a recipe out of the box (the Meals app's recipe for that meal too: it's the same one), after a yes. */
function takeOut(key) {
  const r = recipeOf(key); if (!r) return;
  openCard((close) => [
    h('h2', null, `Take out ${r.cook?.name || r.text}?`),
    h('p', { class: 'note' }, 'It comes out of the recipe box, and off that meal in Meals.'),
    h('div', { class: 'actions' }, btn('Keep it', close, { soft: true }), btn('Take it out', () => {
      close();
      if (cooking?.key === key) stop();
      delete H.recipes[key]; draw();
      house.setRecipe(r.text, {});
    }, { cls: 'red' })),
  ], { width: 760 });
}

/** Add one: a link (or have a phone send it), typed, a photo of the page, or written by the assistant. */
function addCard() {
  const link = h('input', { class: 'field', placeholder: 'A link to the recipe (https://…)', inputmode: 'url', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
  const name = h('input', { class: 'field', placeholder: 'Or its name (Tacos)', autocapitalize: 'sentences', autocomplete: 'off', spellcheck: 'false' });
  const notes = h('textarea', { class: 'field notes', placeholder: 'Ingredients and steps, typed or pasted (optional)', autocapitalize: 'sentences', spellcheck: 'false' });
  const card = openCard((close) => [
    h('h2', null, 'Add a recipe'),
    link, name, notes,
    !H?.ai ? h('p', { class: 'note' }, 'Making steps from a recipe needs the assistant (Settings, Grown-ups, Live voice).') : h('p', { class: 'note' }, 'From a phone: share the recipe page to OpenHouse, or take a photo of the page.'),
    h('div', { class: 'actions' },
      btn('Cancel', () => { document.activeElement?.blur(); close(); }, { soft: true }),
      H?.ai ? btn('From a photo', () => { const t = name.value.trim(); if (!t) { name.focus(); name.placeholder = 'Its name first (Tacos)'; return; } document.activeElement?.blur(); close(); if (!phone.recipe(t)) openCard((c2) => [h('h2', null, 'From a photo'), h('p', { class: 'note' }, 'This works on the tablet itself: a phone sends it the photo.'), h('div', { class: 'actions' }, btn('OK', c2))]); }, { soft: true }) : null,
      H?.ai ? btn('Write one for me', () => { const t = name.value.trim(); if (!t) { name.focus(); name.placeholder = 'Its name first (Tacos)'; return; } document.activeElement?.blur(); close(); house.writeRecipe(t); }, { soft: true }) : null,
      btn('Add', () => {
        const l = link.value.trim(), t = name.value.trim(), n = notes.value.trim();
        if (!l && !(t && n)) { (l || t ? notes : link).focus(); return; }
        document.activeElement?.blur(); close();
        if (l && !t && !n) house.addRecipeLink(l);
        else house.setRecipe(t || 'Recipe', { link: l && !/^https?:\/\//i.test(l) ? 'https://' + l : l, notes: n });
      })),
  ], { width: 980 });
  requestAnimationFrame(() => link.focus());
  return card;
}

// ---- start ----
house.subscribe((d) => {
  H = d;
  if (waiting && cookOf(waiting.key)?.v === 2 && Date.now() - waiting.at < 5 * 60e3) begin(waiting.key); // its steps are ready: start
  else if (cooking && !recipeOf(cooking.key)) stop();
  else draw();
});
store.get('cooking').then((c) => { if (c?.key && Date.now() - (c.when || 0) < 3 * 3600e3 && !cooking) { cooking = { key: c.key, at: c.at || 0 }; video = null; saved(); draw(); } }).finally(watch);
// Keep the screen on and the voice listening while a cook goes on (the note lapses on its own if this page goes away).
setInterval(() => { if (cooking && cookOf(cooking.key)) handsFree({ note: noteAt(cookOf(cooking.key), cooking.at), listen: LISTEN_S, minutes: 40 }); }, 10 * 60e3);
