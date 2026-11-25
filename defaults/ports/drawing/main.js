// Atelier, the family's drawing studio: six tools on a 2000x1200 sheet of paper, S Pen pressure, palm rejection,
// pinch to zoom, undo/redo, and the drawing kept by the house (store) so it comes back on any screen.
import { house, store } from '/kit/openhouse.js';
import { W, H, argb, hex, css, toHsv, fromHsv, drawSegment, drawStroke } from './paint.js';

// ---- what the native app offered ----------------------------------------------------------------------------
const TOOLS = ['Bristle brush', 'Watercolor', 'Ink pen', 'Eraser', 'Graphite pencil', 'Soft marker'];
const PALETTE_NAMES = ['Classic', 'Pastels', 'Ocean', 'Sunset', 'Earth'];
const PALETTES = [
  ['#000000', '#E13C41', '#F09D1E', '#28A05A', '#2D71DC', '#974CCD', '#ED84B3', '#825133', '#FFFFFF'],
  ['#48465C', '#F5A9B8', '#FFD2AB', '#FFF0AD', '#B7DEC0', '#ACDCEC', '#BDB7EE', '#E4B9DC', '#FFFFFF'],
  ['#102B46', '#164B73', '#247BA0', '#39A9BB', '#5DD9C1', '#A7E8DE', '#8CBDE0', '#E7D4AF', '#FFFFFF'],
  ['#3E254F', '#763B76', '#B34F83', '#E66A85', '#F88E70', '#FFB366', '#FFD27D', '#FFE8B0', '#FFFFFF'],
  ['#302A24', '#65503C', '#A56C47', '#C68D63', '#D9B587', '#536847', '#85966A', '#B9C398', '#FFF8E7'],
].map((p) => p.map(hex));
const PAPERS = [['Warm ivory', argb(255, 250, 247, 237)], ['Pure white', argb(255, 255, 255, 255)], ['Cool gray', argb(255, 222, 228, 234)], ['Midnight', argb(255, 30, 38, 52)]];
const HISTORY = 40;

// ---- state ------------------------------------------------------------------------------------------------
const tool = { ink: PALETTES[0][0], brush: 32, medium: 0, erasing: false, opacity: 1 };
let paletteIndex = 0, paper = PAPERS[0][1];
let colors = PALETTES[0].slice();
let strokes = [], history = [], undone = [];          // snapshots share stroke objects, as the native lists did
let strokeStart = null, current = null, activeId = -1, stylusActive = false;
let tail = [];                                          // predicted points: drawn each frame, never kept
let zoom = 1, panX = 0, panY = 0, scale = 1, offX = 0, offY = 0, dpr = 1, rect = null;
const touches = new Map();                               // touch pointers down on the canvas: id -> {x, y}
let navigating = false, nav = null;
let ready = false;
let under = null, underImg = null;   // a past drawing kept only as a picture: drawn under the strokes
let changedSinceSave = false;        // strokes not yet kept as a copy in Photos
let savesCache = {};                 // photo name -> the key its strokes are kept under
const DRAWING = /Drawing-(\d+)\.png$/;

// ---- the page ------------------------------------------------------------------------------------------------
const app = document.getElementById('app');
app.innerHTML = `
  <header>
    <h1>ATELIER  /  Drawing studio</h1>
    <button class="btn" data-act="past">Drawings</button>
    <button class="btn" data-act="undo">Undo</button>
    <button class="btn" data-act="redo">Redo</button>
    <button class="btn" data-act="save">Save image</button>
  </header>
  <main>
    <div class="frame"><canvas id="view" aria-label="Drawing canvas"></canvas></div>
    <div class="tools">
      <div class="label">YOUR TOOLS</div>
      ${TOOLS.map((n, i) => `<button class="btn" data-tool="${i}">${n}</button>`).join('')}
      <div class="swatches">${colors.map((_, i) => `<button class="swatch" data-color="${i}"></button>`).join('')}</div>
      <button class="btn" data-act="palette"></button>
      <div class="gap"></div>
      <button class="btn" data-act="mix">Mix a color</button>
      <div class="label" id="sizeLabel">BRUSH SIZE · 32</div>
      <input type="range" id="size" min="1" max="120" value="32" aria-label="Brush size">
      <div class="label" id="opacityLabel">OPACITY · 100%</div>
      <input type="range" id="opacity" min="1" max="100" value="100" aria-label="Paint opacity">
      <div class="label">CANVAS · pinch to zoom</div>
      <button class="btn" data-act="fit">Fit canvas</button>
      <button class="btn" data-act="paper">Paper color</button>
      <button class="btn" data-act="clear">Clear canvas</button>
    </div>
  </main>
  <div class="scrim" id="scrim"><div class="card" id="card"></div></div>
  <div class="toast" id="toast" role="status"></div>`;

const view = document.getElementById('view');
const g = view.getContext('2d', { desynchronized: true, alpha: false });
const sheet = document.createElement('canvas'); sheet.width = W; sheet.height = H;  // the drawing itself, in canvas units
const sg = sheet.getContext('2d');
const $ = (s) => app.querySelector(s);
const toolButtons = [...app.querySelectorAll('[data-tool]')];
const swatches = [...app.querySelectorAll('[data-color]')];
const paletteButton = $('[data-act=palette]');

function refreshModes() {
  toolButtons.forEach((b, i) => {
    const on = i === 3 ? tool.erasing : !tool.erasing && tool.medium === (i > 3 ? i - 1 : i);
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  });
}
function refreshColors() {
  paletteButton.textContent = `Palette · ${PALETTE_NAMES[paletteIndex]}`;
  swatches.forEach((v, i) => {
    v.style.background = css(colors[i]);
    v.classList.toggle('on', tool.ink === colors[i]);
    v.setAttribute('aria-label', `${PALETTE_NAMES[paletteIndex]} color ${i + 1}`);
  });
}
function slider(input, label, text, set) {
  const show = () => { input.style.setProperty('--v', `${((input.value - input.min) / (input.max - input.min)) * 100}%`); label.textContent = text(+input.value); };
  input.addEventListener('input', () => { set(+input.value); show(); });
  show();
}
slider($('#size'), $('#sizeLabel'), (v) => `BRUSH SIZE · ${v}`, (v) => { tool.brush = v; });
slider($('#opacity'), $('#opacityLabel'), (v) => `OPACITY · ${v}%`, (v) => { tool.opacity = v / 100; });

app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tool]');
  if (t) { const i = +t.dataset.tool; tool.erasing = i === 3; if (i !== 3) tool.medium = i > 3 ? i - 1 : i; refreshModes(); return; }
  const c = e.target.closest('[data-color]');
  if (c) { tool.ink = colors[+c.dataset.color]; tool.erasing = false; refreshModes(); refreshColors(); return; }
  const a = e.target.closest('[data-act]')?.dataset.act;
  ({ undo, redo, save: exportImage, past: choosePast, palette: choosePalette, mix: mixColor, fit, paper: choosePaper, clear: confirmClear })[a]?.();
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- cards and the toast ----------------------------------------------------------------------------------------
const scrim = $('#scrim'), card = $('#card');
function openCard(html, width) {
  card.innerHTML = html; card.style.width = `calc(${width} * var(--u))`;
  scrim.classList.add('open');
  return card;
}
const closeCard = () => scrim.classList.remove('open');
scrim.addEventListener('click', (e) => { if (e.target === scrim || e.target.closest('[data-close]')) closeCard(); });

let toastTimer = 0;
function toast(text, long = false) {
  const t = $('#toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), long ? 3500 : 2000);
}

function choosePalette() {
  const c = openCard(`<h2>Choose a color palette</h2>
    ${PALETTE_NAMES.map((name, i) => `<button class="row${i === paletteIndex ? ' on' : ''}" data-pick="${i}" aria-label="${name} palette">
      <span class="name">${i === paletteIndex ? `${name} · selected` : name}</span>
      ${PALETTES[i].map((col) => `<span class="chip" style="background:${css(col)}"></span>`).join('')}</button>`).join('')}
    <div class="actions"><button class="btn" data-close>Cancel</button></div>`, 840);
  c.querySelectorAll('[data-pick]').forEach((row) => row.addEventListener('click', () => {
    const index = +row.dataset.pick, colorIndex = Math.max(0, colors.indexOf(tool.ink));
    paletteIndex = index; colors = PALETTES[index].slice();
    tool.ink = colors[colorIndex]; tool.erasing = false;
    saveSettings(); refreshColors(); refreshModes(); closeCard();
  }));
}

function mixColor() {
  const hsv = toHsv(tool.ink);
  const names = ['Hue', 'Saturation', 'Brightness'];
  const c = openCard(`<h2>Color studio</h2><div class="preview"></div>
    ${names.map((n, i) => `<div class="mixlabel">${n}<span></span></div>
      <input type="range" class="mix" data-i="${i}" min="0" max="${i === 0 ? 360 : 100}" value="${i === 0 ? Math.trunc(hsv[0]) : Math.trunc(hsv[i] * 100)}" aria-label="${n}">`).join('')}
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn go" data-use>Use color</button></div>`, 640);
  const inputs = [...c.querySelectorAll('input')], values = [...c.querySelectorAll('.mixlabel span')];
  const update = () => {
    c.querySelector('.preview').style.background = css(fromHsv(hsv));
    const full = css(fromHsv([hsv[0], hsv[1], 1]));
    inputs[0].style.setProperty('--track', 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)');
    inputs[1].style.setProperty('--track', `linear-gradient(90deg,${css(fromHsv([hsv[0], 0, hsv[2]]))},${css(fromHsv([hsv[0], 1, hsv[2]]))})`);
    inputs[2].style.setProperty('--track', `linear-gradient(90deg,#000,${hsv[1] > 0 ? full : '#fff'})`);
    values[0].textContent = `${Math.round(hsv[0])}°`; values[1].textContent = `${Math.round(hsv[1] * 100)}%`; values[2].textContent = `${Math.round(hsv[2] * 100)}%`;
  };
  inputs.forEach((input, i) => input.addEventListener('input', () => { hsv[i] = i === 0 ? +input.value : +input.value / 100; update(); }));
  update();
  c.querySelector('[data-use]').addEventListener('click', () => { tool.ink = fromHsv(hsv); tool.erasing = false; refreshModes(); refreshColors(); closeCard(); });
}

function choosePaper() {
  const c = openCard(`<h2>Choose your paper</h2>
    ${PAPERS.map(([name, col], i) => `<button class="row${col === paper ? ' on' : ''}" data-paper="${i}"><span class="paper" style="background:${css(col)}"></span>${name}</button>`).join('')}
    <div class="actions"><button class="btn" data-close>Cancel</button></div>`, 560);
  c.querySelectorAll('[data-paper]').forEach((row) => row.addEventListener('click', () => { changePaper(PAPERS[+row.dataset.paper][1]); closeCard(); }));
}

function confirmClear() {
  const c = openCard(`<h2>Clear the canvas?</h2><p>You can bring it back with Undo.</p>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn danger" data-yes>Clear</button></div>`, 620);
  c.querySelector('[data-yes]').addEventListener('click', () => { clear(); closeCard(); });
}

// ---- the drawing and its history -----------------------------------------------------------------------------
function rebuild() {
  sg.globalAlpha = 1; sg.fillStyle = css(paper); sg.fillRect(0, 0, W, H);
  if (underImg) { // scaled to fit, centred
    const k = Math.min(W / underImg.naturalWidth, H / underImg.naturalHeight), w = underImg.naturalWidth * k, h = underImg.naturalHeight * k;
    sg.drawImage(underImg, (W - w) / 2, (H - h) / 2, w, h);
  }
  for (const s of strokes) drawStroke(sg, s, paper);
  requestFrame();
}
function checkpoint() { history.push(strokes.slice()); if (history.length > HISTORY) history.shift(); undone = []; }
function undo() { finish(); if (history.length) { undone.push(strokes.slice()); strokes = history.pop(); rebuild(); schedule(); } }
function redo() {
  finish();
  if (!undone.length) { toast('Tap Undo first to bring a stroke back with Redo'); return; }
  history.push(strokes.slice()); strokes = undone.pop(); rebuild(); schedule();
}
function clear() { finish(); checkpoint(); strokes = []; rebuild(); schedule(); }
function changePaper(color) { finish(); paper = color; saveSettings(); rebuild(); schedule(); }
function fit() { zoom = 1; panX = 0; panY = 0; requestFrame(); }

function finish() {
  if (!current) return;
  if (strokeStart) { history.push(strokeStart); if (history.length > HISTORY) history.shift(); }
  undone = []; strokeStart = null; current = null; activeId = -1; stylusActive = false; tail = [];
  schedule(); requestFrame();
}
function cancelStroke() {
  if (!current) return;
  strokes.pop();
  strokeStart = null; current = null; activeId = -1; stylusActive = false; tail = [];
  rebuild(); schedule();
}

// ---- showing it ------------------------------------------------------------------------------------------------
// A fine linen weave over everything, paint and erased paper alike (the vertical and horizontal threads, like the
// native app's lines every 5 units).
const weaveV = new Path2D(), weaveH = new Path2D();
for (let x = 0; x < W; x += 5) { weaveV.moveTo(x, 0); weaveV.lineTo(x, H); }
for (let y = 0; y < H; y += 5) { weaveH.moveTo(0, y); weaveH.lineTo(W, y); }

let raf = 0;
function requestFrame() { if (!raf) raf = requestAnimationFrame(frame); }
function frame() {
  raf = 0;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
  g.fillStyle = 'rgb(38,46,59)'; g.fillRect(0, 0, view.width, view.height);
  const k = scale * zoom;
  g.setTransform(dpr * k, 0, 0, dpr * k, dpr * (offX + panX), dpr * (offY + panY));
  g.save();
  g.beginPath(); g.rect(0, 0, W, H); g.clip();
  g.drawImage(sheet, 0, 0);
  if (current && tail.length) {
    let last = current.p[current.p.length - 1];
    for (const p of tail) { drawSegment(g, current, last, p, paper); last = p; }
  }
  g.globalAlpha = 1; g.strokeStyle = 'rgba(115,94,65,0.0706)'; g.lineWidth = 0.65; g.lineCap = 'butt';
  g.stroke(weaveV); g.stroke(weaveH);
  g.restore();
}

function layout() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  view.width = Math.round(w * dpr); view.height = Math.round(h * dpr);
  scale = Math.min(w / W, h / H); offX = (w - W * scale) / 2; offY = (h - H * scale) / 2;
  rect = view.getBoundingClientRect();
  frame();
}
new ResizeObserver(layout).observe(view);

// ---- input ---------------------------------------------------------------------------------------------------
const round = (v, n) => Math.round(v * n) / n;
const local = (e) => [e.clientX - rect.left, e.clientY - rect.top];
function toCanvas(e, pressure) {
  const [x, y] = local(e), k = scale * zoom;
  return [round((x - offX - panX) / k, 100), round((y - offY - panY) / k, 100), round(pressure, 1000)];
}
function pressureOf(e) {
  if (!stylusActive) return 1;
  // A pen lifting reports 0; keep the last real pressure so the stroke doesn't end in a thin tick.
  if (e.pressure <= 0 && current?.p.length) return current.p[current.p.length - 1][2];
  return Math.min(1.5, Math.max(0.15, e.pressure));
}
function add(e) {
  const s = current; if (!s) return;
  const point = toCanvas(e, pressureOf(e));
  drawSegment(sg, s, s.p[s.p.length - 1] || point, point, paper);
  s.p.push(point);
}
const isEraserEnd = (e) => e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5);

function startNav() {
  const [a, b] = [...touches.values()];
  nav = { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}
function moveNav() {
  const [a, b] = [...touches.values()];
  if (!a || !b || !nav) return;
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const old = zoom;
  zoom = Math.min(5, Math.max(1, zoom * (d / nav.d)));
  const ratio = zoom / old;
  // Zoom around the fingers (as the native app's ScaleGestureDetector did), and follow them as they move together.
  panX = cx - offX - (cx - offX - panX) * ratio + (cx - nav.cx);
  panY = cy - offY - (cy - offY - panY) * ratio + (cy - nav.cy);
  if (zoom === 1) { panX = 0; panY = 0; }
  nav = { d, cx, cy };
  requestFrame();
}

view.addEventListener('pointerdown', (e) => {
  if (!ready) return;
  rect = view.getBoundingClientRect();
  const stylus = e.pointerType === 'pen';
  if (e.pointerType === 'touch') {
    const [x, y] = local(e); touches.set(e.pointerId, { x, y });
    if (touches.size > 1 && !stylusActive) {
      if (!navigating) { cancelStroke(); navigating = true; }
      startNav();
      return;
    }
  }
  if (navigating) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (current && !stylus) return;              // a second touch, or a palm under the pen
  if (stylusActive && !stylus) return;
  if (stylus && current && !stylusActive) cancelStroke(); // the pen came down while a palm was "drawing": the palm's stroke goes
  const point = toCanvas(e, 1);
  if (point[0] < 0 || point[0] > W || point[1] < 0 || point[1] > H) return;
  finish();
  strokeStart = strokes.slice(); activeId = e.pointerId; stylusActive = stylus;
  current = { c: tool.ink, s: tool.brush, e: tool.erasing || isEraserEnd(e), m: tool.medium, o: tool.opacity, p: [] };
  strokes.push(current);
  try { view.setPointerCapture(e.pointerId); } catch {}
  add(e);
  requestFrame();
  e.preventDefault();
});

view.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const [x, y] = local(e); touches.set(e.pointerId, { x, y });
    if (navigating) { moveNav(); return; }
  }
  if (e.pointerId !== activeId || !current) return;
  const events = e.getCoalescedEvents?.() || [];
  for (const c of events.length ? events : [e]) add(c);
  const predicted = e.getPredictedEvents?.() || [];
  const last = current.p[current.p.length - 1];
  tail = predicted.map((p) => toCanvas(p, stylusActive && p.pressure > 0 ? Math.min(1.5, Math.max(0.15, p.pressure)) : last[2]));
  requestFrame();
});

function lift(e, cancelled) {
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (navigating) { if (touches.size === 0) { navigating = false; nav = null; } else if (touches.size === 1) nav = null; else startNav(); return; }
  }
  if (e.pointerId !== activeId) return;
  if (cancelled) { cancelStroke(); return; }
  add(e); finish();
}
view.addEventListener('pointerup', (e) => lift(e, false));
view.addEventListener('pointercancel', (e) => lift(e, true));
view.addEventListener('lostpointercapture', (e) => { if (e.pointerId === activeId && current) finish(); });

// ---- saving ----------------------------------------------------------------------------------------------------
function serialize() {
  const pool = [], ids = new Map();
  const snapshot = (items) => items.map((s) => { let id = ids.get(s); if (id === undefined) { id = pool.length; ids.set(s, id); pool.push(s); } return id; });
  const drawing = snapshot(strokes), undo = history.map(snapshot), redo = undone.map(snapshot);
  return { pool: pool.map(({ c, s, e, m, o, p }) => ({ c, s, e, m, o, p })), drawing, undo, redo };
}
function parse(saved) {
  if (typeof saved === 'string') saved = JSON.parse(saved);
  const list = Array.isArray(saved) ? saved : saved.pool;
  const pool = list.map((o) => ({
    c: o.c | 0, s: +o.s, e: !!o.e, m: Number.isInteger(o.m) ? o.m : 2, o: typeof o.o === 'number' ? o.o : 1,
    p: o.p.map((q) => [+q[0], +q[1], +q[2]]),
  }));
  if (Array.isArray(saved)) return { strokes: pool, history: [], undone: [] };
  const snap = (ids) => ids.map((i) => { if (!pool[i]) throw new Error('bad id'); return pool[i]; });
  return { strokes: snap(saved.drawing), history: (saved.undo || []).map(snap).slice(-HISTORY), undone: (saved.redo || []).map(snap) };
}

let saveTimer = 0, saving = null, unsaved = false, again = false;
function schedule() { unsaved = true; changedSinceSave = true; clearTimeout(saveTimer); saveTimer = setTimeout(persist, 350); }
function persist() {
  clearTimeout(saveTimer);
  if (!ready || !unsaved) return saving;
  if (saving) { again = true; return saving; }
  unsaved = false;
  saving = store.set('drawing', { ...serialize(), under, changed: changedSinceSave })
    .catch(() => { unsaved = true; toast('Could not save drawing'); })
    .finally(() => { saving = null; if (again) { again = false; persist(); } });
  return saving;
}
const saveSettings = () => ready && store.set('settings', { paper, palette: paletteIndex }).catch(() => {});
function leaving() { finish(); persist(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) leaving(); });
window.addEventListener('pagehide', leaving);

// A save is a new PNG in the family's Photos plus its strokes (save-<ts>), so it can be opened again and edited.
const record = () => ({ ...serialize(), paper, under, changed: changedSinceSave });
function photoNamed(file) { return (house.data?.photos || []).find((n) => n === file || n.endsWith('-' + file)) || null; }
function waitForPhoto(file, ms = 6000) {
  const now = photoNamed(file);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); resolve(null); }, ms);
    stop = house.subscribe(() => { const n = photoNamed(file); if (n) { clearTimeout(timer); stop(); resolve(n); } });
  });
}
const strokesKey = (name) => { const all = savesCache; if (all[name]) return all[name]; const k = Object.keys(all).find((f) => name.endsWith('-' + f)); return k ? all[k] : null; };

async function saveCopy() {
  finish(); persist();
  const ts = Date.now(), file = `Drawing-${ts}.png`, key = `save-${ts}`, rec = record();
  const blob = await new Promise((resolve, reject) => sheet.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'));
  if ((await house.addPhoto(blob, file))?.ok === false) throw new Error('not kept in Photos');
  if ((await store.set(key, rec))?.ok === false) throw new Error('not saved');
  const name = (await waitForPhoto(file)) || file; // the bridge puts its own prefix on the name
  // Merge with what's there (and what this screen already knew), so no earlier entry is ever dropped.
  savesCache = { ...((await store.get('saves')) || {}), ...savesCache, [name]: key };
  await store.set('saves', savesCache);
  changedSinceSave = false; unsaved = true; persist();
}

let exporting = false;
async function exportImage() {
  if (exporting) return;
  const button = $('[data-act=save]');
  exporting = true; button.disabled = true;
  try { await saveCopy(); toast('Saved to Photos'); }
  catch { toast('Image could not be saved. Your drawing is still saved in the app.', true); }
  finally { exporting = false; button.disabled = false; }
}

// ---- past drawings -------------------------------------------------------------------------------------------------
const PLUS = '<svg viewBox="0 0 48 48" width="34%" aria-hidden="true"><path d="M24 8v32M8 24h32" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/></svg>';
const BACK = '<svg viewBox="0 0 48 48" width="34%" aria-hidden="true"><path d="M20 12 8 24l12 12M9 24h20a11 11 0 0 1 0 22h-6" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none" transform="translate(0 -5)"/></svg>';
async function choosePast() {
  const previous = await store.get('previous');
  const names = (house.data?.photos || []).filter((n) => DRAWING.test(n)).sort((a, b) => +b.match(DRAWING)[1] - +a.match(DRAWING)[1]);
  const c = openCard(`<h2>Your drawings</h2><div class="past">
    <button class="tile new" data-new>${PLUS}<span>New</span></button>
    ${previous ? `<button class="tile new" data-back>${BACK}<span>The one before</span></button>` : ''}
    ${names.map((n, i) => `<button class="tile" data-open="${i}" aria-label="Drawing ${i + 1}"><img alt=""></button>`).join('')}
    </div>${names.length ? '' : '<p>Drawings you save show up here.</p>'}
    <div class="actions"><button class="btn" data-close>Close</button></div>`, 1180);
  c.querySelectorAll('[data-open]').forEach((tile) => {
    const name = names[+tile.dataset.open];
    house.photo(name).then((url) => { tile.querySelector('img').src = url; }).catch(() => {});
    tile.addEventListener('click', () => { closeCard(); switchTo(() => openPast(name)); });
  });
  c.querySelector('[data-new]').addEventListener('click', () => { closeCard(); switchTo(async () => { strokes = []; history = []; undone = []; await setUnder(null); }); });
  c.querySelector('[data-back]')?.addEventListener('click', () => { closeCard(); switchTo(() => openDoc(previous)); });
}
async function setUnder(name) {
  under = name || null; underImg = null;
  if (!under) return;
  try { const img = new Image(); img.src = await house.photo(under); await img.decode(); underImg = img; } catch {}
}
async function openDoc(doc) {
  if (!take(doc)) throw new Error('could not read it');
  if (Number.isFinite(doc.paper)) { paper = doc.paper | 0; saveSettings(); }
  await setUnder(doc.under);
  return doc.changed === true;
}
async function openPast(name) {
  const key = strokesKey(name), doc = key && (await store.get(key));
  if (doc) return openDoc({ ...doc, changed: false });
  // An old picture with no strokes: it goes underneath, and new strokes go on top.
  strokes = []; history = []; undone = [];
  await setUnder(name);
  return false;
}
let switching = false;
/** Opening something replaces the drawing in progress: first it's kept as a copy (if it has anything unsaved) and
 *  as 'previous' (so "The one before" brings it back). If keeping it fails, nothing is replaced. */
async function switchTo(load) {
  if (switching) return; switching = true;
  try {
    finish();
    if (changedSinceSave && (strokes.length || under)) {
      try { await saveCopy(); } catch { toast('This drawing could not be kept as a copy, so it stays open.', true); return; }
    }
    const keep = record();
    try { await store.set('previous', keep); } catch {}
    const before = { strokes, history, undone, under, underImg, paper };
    let changed;
    try { changed = await load(); }
    catch { ({ strokes, history, undone, under, underImg, paper } = before); toast('That drawing could not be opened.'); return; }
    rebuild(); schedule(); changedSinceSave = !!changed;
    fit();
  } finally { switching = false; }
}

// ---- starting ----------------------------------------------------------------------------------------------------
function applySettings(st) {
  if (!st) return;
  const p = parseInt(st.palette, 10);
  if (p >= 0 && p < PALETTES.length) paletteIndex = p;
  const pp = typeof st.paper === 'number' ? st.paper | 0 : parseInt(st.paper, 10);
  if (Number.isFinite(pp)) paper = pp | 0;
}
function take(doc) {
  try { ({ strokes, history, undone } = parse(doc)); return true; } catch { strokes = []; history = []; undone = []; return false; }
}

async function start() {
  refreshModes(); refreshColors(); rebuild();
  house.subscribe(() => {}); // keeps house.data (the photos) current
  const [doc, settings, old, saves] = await Promise.all([store.get('drawing'), store.get('settings'), store.legacy(), store.get('saves')]);
  savesCache = saves && typeof saves === 'object' ? saves : {};
  applySettings(settings);
  let fresh = false;
  if (doc) {
    take(doc);
    changedSinceSave = doc.changed !== false && strokes.length > 0; // an autosave from before this flag existed counts as unsaved
    await setUnder(doc.under);
  } else if (old) {
    // What the native app saved: its drawing file and its preferences (strings, the paper a signed ARGB int).
    const text = old.files?.['drawing-current.json'];
    if (text) fresh = take(text);
    changedSinceSave = fresh && strokes.length > 0;
    if (!settings) applySettings(old.prefs?.['app.drawing']);
  }
  colors = PALETTES[paletteIndex].slice(); tool.ink = colors[0];
  refreshColors(); refreshModes(); rebuild();
  ready = true;
  if (old) {
    try {
      if (fresh) { unsaved = true; await persist(); }
      if (!settings) await saveSettings();
      if (!unsaved) await old.done(); // only once it's safely kept here
    } catch {}
  }
}
start();
