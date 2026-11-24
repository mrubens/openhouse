// Recipes: the household's recipe box (the Meals app's recipe per meal, the same data), and cooking from it hands-free.
// A recipe comes in by a link (shared from a phone or typed here), a photo of a cookbook page, typed in, or written by
// the assistant; it's made into steps once (bridge/cooking.js) and kept, so cooking needs no internet.
//
// The box: every recipe a tile on its own picture (kept from its page; with none, its initial on a warm tile).
// Cooking: the whole recipe on one page: the dish and what it needs at the left (what's already gone in, faint), every
// step at the right, in its parts; the step they're on is the big one, with its timer, and is kept in view. "Opie, next", "go to the sauce", "go back",
// "how much cumin?" come in as the app's voice actions (app.json) and go through the same moves (cook.js), so the
// screen and the voice never disagree. While cooking the screen stays on and the live voice keeps listening a little after each
// answer (kit handsFree), so the next "next" needs no name for a while.
import { house, store, timer, phone, handsFree, onAction } from '/kit/openhouse.js';
import { findRecipe, mealsNow, move, sayAt, howMuch, needs, noteAt, timerWords, searchBox, sayFound, sayHits } from './cook.js';

// ---- drawing: small helpers (no framework) ----------------------------------------------------------------
const $app = document.getElementById('app');
const $over = document.body.appendChild(document.createElement('div'));

/** An element: h('div', { class, tap, hold, ...attributes }, ...children) (hold: a long press). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === 'tap' || k === 'hold') continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (props?.tap) press(el, props.tap, props.hold);
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
/** A tap: finger up without moving far (a wet wrist slides a little, so it's forgiving). */
function press(el, tap, hold = null) {
  let x = 0, y = 0, down = false, timer = 0;
  const off = () => { down = false; clearTimeout(timer); };
  el.addEventListener('pointerdown', (e) => { e.stopPropagation(); down = true; x = e.clientX; y = e.clientY;
    if (hold) { clearTimeout(timer); timer = setTimeout(() => { if (down) { down = false; hold(e); } }, 650); } });
  el.addEventListener('pointermove', (e) => { if (down && Math.hypot(e.clientX - x, e.clientY - y) > 40) off(); });
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerup', (e) => { const was = down; off(); if (was) { e.stopPropagation(); tap(e); } });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el && !el.disabled) { e.preventDefault(); tap(e); } });
}
const ICONS = { plus: '<path d="M12 4.5v15M4.5 12h15"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', left: '<path d="M14.5 5.5L8 12l6.5 6.5"/>', next: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 3h5"/>', steps: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4 6.5h.01M4 12h.01M4 17.5h.01"/>' };
const icon = (name, w = 2.2) => h('span', { class: 'icon', 'aria-hidden': 'true',
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });
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
const started = new Map(); // the steps whose timer was started here (key|at -> {end, total (s)}), so the step shows it running

const recipeOf = (key) => H?.recipes?.[key] || null;
const cookOf = (key) => recipeOf(key)?.cook || null;
const workOf = (key) => H?.mealWork?.[`cook|${key}`] || null;
const nameOf = (key) => cookOf(key)?.name || recipeOf(key)?.text || key;
const planned = () => mealsNow(H?.meals, house.dayKey(), new Date().getHours());
/** When a recipe is next planned, this week: "Tonight’s dinner", "Tuesday’s dinner" (null: it isn't). {days, text}. */
function plannedFor(r) {
  const names = [r.text, r.cook?.name].filter(Boolean).map((t) => t.toLowerCase());
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + i);
    for (const [m, t] of Object.entries(H?.meals?.[house.dayKey(d)] || {})) {
      if (names.includes(String(t || '').toLowerCase())) return { days: i, text: `${i === 0 ? (m === 'dinner' ? 'Tonight' : 'Today') : d.toLocaleDateString(undefined, { weekday: 'long' })}’s ${m}` };
    }
  }
  return null;
}
/** A recipe's picture: its page's own; with none, or one that won't load, its initial on a warm tile. */
const WARM = ['#d9662f', '#c98a1e', '#b8503a', '#7f9a45', '#c46f8a', '#a8763a'];
function dishPic(r, name) {
  const t = String(name || '').trim();
  const letter = h('div', { class: 'q-letter', style: `--c:${WARM[[...t.toLowerCase()].reduce((n, ch, i) => n + ch.charCodeAt(0) * (i + 1), 0) % WARM.length]}`, 'aria-hidden': 'true' }, t[0]?.toUpperCase() || '');
  if (!r?.image) return letter;
  const img = h('img', { class: 'q-photo', src: r.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' });
  img.addEventListener('error', () => { img.parentElement?.classList.remove('q-scrim'); img.replaceWith(letter); });
  return img;
}

function draw() {
  $count.textContent = Object.keys(H?.recipes || {}).length || '';
  $web.hidden = !$search.value.trim();
  $body.replaceChildren(cooking && cookOf(cooking.key) ? cookView() : boxView());
  for (const s of sheets) s.redraw();
}

// ---- cooking: the moves (the screen's taps and the voice both come here) ----
function begin(key, at = 1) { // (on the first step: what it needs is beside it)
  if (recipeOf(key)?.link && !recipeOf(key).picsAt) house.prepareCook(recipeOf(key).text); // (one made before pictures: they're fetched)
  cooking = { key, at: Math.max(1, at) }; waiting = null; video = null;
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
  started.set(`${cooking.key}|${cooking.at}`, { end: Date.now() + Math.round(m * 60) * 1000, total: Math.round(m * 60) }); draw();
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
const clock = (s) => { const x = Math.max(0, Math.ceil(s)), hh = Math.floor(x / 3600), mm = Math.floor(x % 3600 / 60), ss = String(x % 60).padStart(2, '0'); return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`; };
const shortTime = (m) => timerWords(m).replace('-minute', ' min').replace('-hour', ' hr').replace('-second', ' s');
const RING = 2 * Math.PI * 134;
/** A step's timer as a ring: how long it is; once started here, what's left of it (ringTick keeps it going). */
function ring(st, run) {
  const total = run ? run.total : Math.round(st.timer.minutes * 60);
  const el = h('div', { class: 'c-ring' + (total >= 3600 ? ' long' : ''), 'data-end': run ? String(run.end) : null, 'data-total': String(total),
    html: `<svg viewBox="0 0 300 300" aria-hidden="true"><circle class="bed" cx="150" cy="150" r="134"/><circle class="arc" cx="150" cy="150" r="134" stroke-dasharray="${RING} ${RING}"/></svg><div class="v"><b></b><span></span></div>` });
  ringTick(el);
  return el;
}
function ringTick(el = $body.querySelector('.c-ring')) {
  if (!el) return;
  const total = Number(el.dataset.total), end = Number(el.dataset.end) || 0, left = end ? Math.max(0, (end - Date.now()) / 1000) : total;
  el.querySelector('.arc').setAttribute('stroke-dasharray', `${RING * (total ? left / total : 0)} ${RING}`);
  el.querySelector('b').textContent = clock(left);
  el.querySelector('span').textContent = !end ? 'timer' : left <= 0 ? 'time’s up' : `of ${shortTime(total / 60)}`;
}
setInterval(() => ringTick(), 1000);

function cookView() {
  if (cooking.at < 1) cooking.at = 1; // (a cook kept from before there was no start page)
  const key = cooking.key, r = recipeOf(key), c = cookOf(key), n = c.steps.length, at = cooking.at, name = c.name || nameOf(key);
  if (!video && r?.video) video = { shown: false, playing: false }; // (also after a reload mid-cook)
  const vid = video?.shown && ytId(r?.video);
  const was = { rest: $body.querySelector('.c-rest')?.scrollTop || 0, ing: $body.querySelector('.c-ing')?.scrollTop || 0, all: $body.querySelector('.cook')?.scrollTop || 0 };
  const jump = (i) => go('to', i);
  const st = at <= n ? c.steps[at - 1] : null, k = `${key}|${at}`;
  const low = (s) => String(s || '').toLowerCase();
  const nowUses = new Set((st?.uses || []).map((u) => low(u.item)));

  // what it needs: amount first; this step's own in white, what the steps behind them used up faint
  const last = new Map(); // an ingredient -> the last step that uses it
  c.steps.forEach((s, i) => { for (const u of s.uses || []) last.set(low(u.item), i + 1); });
  const ingCls = (x) => (nowUses.has(low(x.item)) ? 'now' : (last.get(low(x.item)) || Infinity) < at ? 'used' : null);
  const ing = h('ul', { class: 'c-ing' }, c.ingredients.length ? ingGroups(c).flatMap(([part, xs]) => [
    part ? h('li', { class: 'c-part', 'data-part': part }, part) : null,
    ...xs.map((x) => h('li', { class: ingCls(x) }, x.amount ? h('b', null, x.amount + ' ') : null, x.item))])
    : [h('li', { class: 'used' }, 'The recipe doesn’t list them.')]);
  const left = h('div', { class: 'c-left' },
    h('div', { class: 'c-chips' },
      h('button', { class: 'c-chip', tap: () => stop() }, icon('left'), 'Recipes'),
      video ? h('button', { class: 'c-chip', tap: () => { video.shown = !video.shown; if (!video.shown) video.playing = false; draw(); } }, vid ? 'Hide video' : 'Video') : null),
    h('div', { class: 'c-photo' }, dishPic(r, name)),
    h('h1', null, name),
    h('div', { class: 'c-meta' }, [c.minutes ? howLong(c.minutes) : '', serves(c)].filter(Boolean).join(' · ')),
    credits(r).length ? h('div', { class: 'c-from' }, credits(r).map(([t, url], i) => [i ? ' · ' : '', h('span', { tap: () => openLink(url) }, t)])) : null,
    ing);

  // now: the step they're on, the only panel; its words at one of two sizes, what it uses, Next step (and its timer)
  const run = started.get(k);
  const label = st ? [st.part, `Step ${at} of ${n}`, st.title, st.wait ? 'mostly waiting' : '', st.ahead || ''].filter(Boolean).join(' · ') : 'Done';
  const now = h('div', { class: 'c-now' + (run ? ' timing' : '') },
    h('div', { class: 'c-now-tx' },
      h('div', { class: 'c-label' }, label),
      h('p', { class: st && st.text.length > 160 ? 'long' : null }, st ? st.text : 'That’s the whole recipe.'),
      st?.uses?.length ? h('ul', { class: 'c-uses' }, st.uses.map((x) => h('li', null, x.amount ? h('b', null, x.amount + ' ') : null, x.item))) : null,
      h('div', { class: 'c-do' },
        h('button', { class: 'c-next', tap: () => (st && at < n ? go('next') : stop()) }, st && at < n ? 'Next step' : 'Done', st && at < n ? icon('next', 2.4) : null),
        st?.timer && !run ? h('button', { class: 'c-glass', tap: () => startTimer() }, icon('timer'), `Start · ${shortTime(st.timer.minutes)}`) : null)),
    run ? ring(st, run) : st?.image ? h('img', { class: 'c-spic', src: st.image, alt: '', referrerpolicy: 'no-referrer', onerror: 'this.remove()' }) : null);

  // the rest: every other step a row (done ones faint, with a tick), by part; tap one to go to it
  const rows = [];
  let part = null;
  c.steps.forEach((s, i) => {
    if (i + 1 === at) return;
    if (s.part && s.part !== part) { part = s.part; rows.push(h('div', { class: 'c-part' }, part)); }
    rows.push(h('div', { class: 'c-row' + (i + 1 < at ? ' done' : ''), 'data-at': String(i + 1), tap: () => jump(i + 1) },
      h('span', { class: 'no' }, i + 1 < at ? icon('check', 2.6) : String(i + 1)),
      h('div', { class: 'tx' }, s.title ? h('b', null, s.title) : null, h('span', { class: s.title ? null : 'two' }, s.text)),
      s.timer ? h('span', { class: 'tm' }, icon('timer', 2), shortTime(s.timer.minutes)) : null));
  });
  const rest = h('div', { class: 'c-rest' }, vid ? h('div', { class: 'video spot' }) : null, rows);
  const view = h('div', { class: 'cook' },
    left, h('div', { class: 'c-right' }, now, rest));

  // keep their place on a redraw; when the step changes, the next one rests at the top of the list and its part of
  // what it needs comes into view
  requestAnimationFrame(() => {
    rest.scrollTop = was.rest; ing.scrollTop = was.ing; view.scrollTop = was.all;
    if (shownAt !== `${cooking?.key}|${at}`) {
      const first = shownAt == null; shownAt = `${cooking?.key}|${at}`;
      const next = rest.querySelector(`.c-row[data-at="${at + 1}"]`), b = first ? 'auto' : 'smooth';
      if (next) rest.scrollTo({ top: Math.max(0, next.offsetTop - rest.offsetTop - (next.previousElementSibling?.classList.contains('c-part') ? next.previousElementSibling.offsetHeight : 0)), behavior: b });
      const p = st?.part && [...ing.querySelectorAll('.c-part')].find((x) => x.dataset.part === st.part);
      if (p) ing.scrollTo({ top: p.offsetTop - ing.offsetTop, behavior: b });
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
const $count = h('span');
const $top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Recipes ', $count), h('label', { class: 'r-find' }, icon('search', 2), $search), $web,
  btn([icon('plus', 2.4), h('span', { class: 'lbl' }, 'Add a recipe')], addCard, { cls: 'add' }));
$top.lastChild.setAttribute('aria-label', 'Add a recipe');
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
function openWhenThere(key, tries = 40) { if (recipeOf(key)) openRecipe(key); else if (tries > 0) setTimeout(() => openWhenThere(key, tries - 1), 250); }
const minutesText = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

// ---- the box ----
function boxView() {
  const q = $search.value.trim(), hits = q ? searchBox(H?.recipes, H?.favorites, q) : null;
  const when = new Map(Object.entries(H?.recipes || {}).map(([key, r]) => [key, plannedFor(r)]));
  // what's planned soonest first, then by name
  const all = hits ? hits.filter((x) => x.key).map((x) => [x.key, H.recipes[x.key]])
    : Object.entries(H?.recipes || {}).sort((a, b) => (when.get(a[0])?.days ?? 9) - (when.get(b[0])?.days ?? 9) || (a[1].text || a[0]).localeCompare(b[1].text || b[0]));
  const tonight = findRecipe(H?.recipes, '', planned()), w = waiting && workOf(waiting.key);
  const link = H?.mealWork?.link, f = H?.recipeFind;
  return h('div', { style: 'display:contents' },
    f ? foundView(f) : null,
    waiting && !q && !f ? h('div', { class: 'q-panel r-wait' }, h('div', { class: 'what' }, h('div', { class: 'q-label' }, 'Getting it ready'),
      h('div', { class: 'name' }, w?.state === 'error' ? w.text : `${recipeOf(waiting.key)?.text || ''}: making the steps…`)),
      w?.state === 'error' ? btn('Try again', () => { house.prepareCook(recipeOf(waiting.key).text, true); }, { soft: true }) : null,
      btn('Cancel', () => { waiting = null; watch(); draw(); }, { soft: true })) : null,
    link?.state === 'error' ? h('p', { class: 'note' }, link.text) : null,
    q ? h('h3', { class: 'section' }, all.length ? 'In the recipe box' : `Nothing in the recipe box for ${q}`) : null,
    // one being added: a tile of its own, first, turning while it's found and read
    all.length || (link?.state === 'working' && !q) ? h('div', { class: 'r-grid vscroll' },
      link?.state === 'working' && !q ? h('div', { class: 'r-card r-skel' }, h('div', { class: 'r-spin' }), h('div', { class: 't' }, h('h2', null, 'Adding a recipe'), h('div', { class: 'm' }, link.link ? siteOf(link.link) : 'Finding it'))) : null,
      all.map(([key, r]) => recipeTile(key, r, when.get(key), !waiting && tonight?.key === key)))
      : q ? (f?.query === q ? null : btn(`Search the web for ${q}`, () => webFind(q), { soft: true, cls: 'webq' }))
      : h('p', { class: 'r-none' }, 'No recipes yet. Find one, or add one by its link, a photo of the page, or by typing it. Each one is made into steps you can cook from, hands-free.'),
    hits?.some((x) => !x.key) ? h('p', { class: 'note' }, `Favorite meals: ${hits.filter((x) => !x.key).map((x) => x.name).join(', ')} (no recipe yet).`) : null);
}
/** One recipe in the box: its picture, its name, a few facts; when it's planned, and Cook on the one planned for now. */
function recipeTile(key, r, when, now) {
  const name = r.cook?.name || r.text;
  return h('div', { class: 'r-card' + (when ? ' on' : '') + (now ? ' tonight' : ''), role: 'button', tabindex: '0', tap: () => openRecipe(key), hold: () => takeOut(key) },
    dishPic(r, name),
    workOf(key)?.state === 'working' ? h('div', { class: 'r-spin' }) : null,
    when ? h('span', { class: 'r-on' }, when.days === 0 ? 'Tonight' : when.text.split('’')[0]) : null,
    now ? h('span', { class: 'r-cook', role: 'button', tabindex: '0', tap: () => cook(r.text) }, 'Cook') : null,
    h('div', { class: 't' }, h('h2', null, name), h('div', { class: 'm' }, facts(key, r).join(' · '))));
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
/** A recipe's few facts for its tile: how many steps, who it serves, a video; or what's being done to it. */
function facts(key, r) {
  const w = workOf(key);
  if (w?.state === 'working') return ['Making the steps…'];
  if (w?.state === 'error') return [w.text];
  if (r.cook) return [r.cook.minutes && howLong(r.cook.minutes), serves(r.cook)].filter(Boolean);
  return [r.link && !r.notes ? 'A link' : 'Not ready to cook yet'];
}
/** The ingredients in the steps' order: each recipe it builds on (part) under its name, then its own, named for the part
 *  its own steps are in ("Pizza"); no headings when it has no parts. */
function ingGroups(c) {
  const own = c.ingredients.filter((x) => !x.part), parts = [...new Set(c.ingredients.filter((x) => x.part).map((x) => x.part))];
  if (!parts.length) return [['', own]];
  const ownPart = c.steps.map((s) => s.part).filter((p) => p && !parts.includes(p)).pop() || c.name || '';
  return [...parts.map((p) => [p, c.ingredients.filter((x) => x.part === p)]), ...(own.length ? [[ownPart, own]] : [])];
}
/** Where a recipe and its photo are from, each with its page: "From bonappetit.com", "Written by Opie · photo from
 *  kingarthurbaking.com". A tap opens the page (on the display: on a phone, by its QR code). */
function credits(r) {
  const out = [];
  if (r?.link) out.push([`From ${siteOf(r.link)}`, r.link]);
  else if (r?.by === 'assistant') out.push(['Written by Opie', null]);
  if (r?.photoFrom && r.image) out.push([`${out.length ? 'photo' : 'Photo'} from ${siteOf(r.photoFrom)}`, r.photoFrom]);
  return out;
}
function openLink(url) { if (url && !phone.link(url)) window.open(url, '_blank', 'noopener'); }
/** Where a recipe is from, for its credit: "bonappetit.com". */
const siteOf = (link) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } };
/** How long a recipe takes: "45 min", "1 hr 15 min". */
const howLong = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`);
/** "Serves 4", or the recipe's own words for what it makes ("Makes 12 muffins"). */
function serves(c) {
  const y = String(c?.serves || '').trim().replace(/\.$/, '');
  return !y ? '' : /^\d+(\s*(-|–|to)\s*\d+)?$/.test(y) ? `Serves ${y}` : `${y[0].toUpperCase()}${y.slice(1)}`;
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
/** A tap on a recipe: straight to cooking it (its steps made first when they aren't yet). The whole recipe only when no
 *  steps can be made. Take it out and Make the steps again are on its first page, before Start. */
let timed = false; // (recipes made into steps before they said how long: the bridge finds out, once each)
function askHowLong() { if (timed || !H?.recipes) return; timed = true; for (const r of Object.values(H.recipes)) if (r.cook && !r.cook.minutes) house.prepareCook(r.text); }
function openRecipe(key) {
  const r = recipeOf(key); if (!r) return;
  if (cookOf(key)?.v === 2) return begin(key);
  if (!H.ai) return recipeCard(key);
  waiting = { key, at: Date.now() };
  if (workOf(key)?.state !== 'working') house.prepareCook(r.text);
  watch(); draw();
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

/** Add one: one box for a link, a recipe pasted in, or an idea the assistant writes a recipe for (house.addRecipe). */
function addCard() {
  const text = h('textarea', { class: 'field notes add', placeholder: 'Paste a recipe or a link, or say what you’d like to make', autocapitalize: 'sentences', spellcheck: 'false' });
  const card = openCard((close) => [
    h('h2', null, 'Add a recipe'),
    text,
    !H?.ai ? h('p', { class: 'note' }, 'Adding recipes needs the assistant (Settings, Grown-ups, Live voice).') : null,
    h('div', { class: 'actions' },
      btn('Cancel', () => { document.activeElement?.blur(); close(); }, { soft: true }),
      btn('Add', () => {
        const t = text.value.trim();
        if (!t) { text.focus(); return; }
        document.activeElement?.blur(); close();
        house.addRecipe(t);
      }, { disabled: !H?.ai })),
  ], { width: 900 });
  requestAnimationFrame(() => text.focus());
  return card;
}

// ---- start ----
house.subscribe((d) => {
  H = d; askHowLong();
  if (waiting && cookOf(waiting.key)?.v === 2 && Date.now() - waiting.at < 5 * 60e3) begin(waiting.key); // its steps are ready: start
  else if (cooking && !recipeOf(cooking.key)) stop();
  else draw();
});
store.get('cooking').then((c) => { if (c?.key && Date.now() - (c.when || 0) < 3 * 3600e3 && !cooking) { cooking = { key: c.key, at: c.at || 0 }; video = null; saved(); draw(); } }).finally(watch);
// Keep the screen on and the voice listening while a cook goes on (the note lapses on its own if this page goes away).
setInterval(() => { if (cooking && cookOf(cooking.key)) handsFree({ note: noteAt(cookOf(cooking.key), cooking.at), listen: LISTEN_S, minutes: 40 }); }, 10 * 60e3);
