import { house } from '/kit/openhouse.js';
const KEY = 'app.whiteboard.';
const colors = ['#1f2329', '#2f6fd6', '#d64545', '#2e9e5b', '#e08a1e', '#8a4fd1'];
const sizes = [6, 14, 28];
let color = localStorage.getItem(KEY + 'color') || colors[0];
let size = +(localStorage.getItem(KEY + 'size') || 14);
let erasing = false;

const top = document.getElementById('top');
const board = document.getElementById('board');
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const dpr = Math.min(devicePixelRatio || 1, 2);

const eraserSvg = '<svg viewBox="0 0 24 24"><path d="M4 15.5l9-9 5.5 5.5-7 7H8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 10.5l5.5 5.5M11 19h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const undoSvg = '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const redoSvg = '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function el(cls, html, onTap, parent) {
  const b = document.createElement('button');
  b.className = cls; b.innerHTML = html;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); onTap(b); });
  parent.append(b); return b;
}
function group() { const g = document.createElement('div'); g.className = 'group'; top.append(g); return g; }

const pens = group();
const penBtns = colors.map((c) => {
  const b = el('pick', `<span class="dot" style="background:${c}"></span>`, () => { color = c; erasing = false; localStorage.setItem(KEY + 'color', c); mark(); }, pens);
  b.dataset.c = c; return b;
});
const eraseBtn = el('pick', eraserSvg, () => { erasing = true; mark(); }, pens);
const sizesG = group();
const sizeBtns = sizes.map((s) => {
  const d = Math.round(s * 1.1 + 6);
  const b = el('pick', `<span class="sz" style="width:calc(${d} * var(--u));height:calc(${d} * var(--u))"></span>`, () => { size = s; localStorage.setItem(KEY + 'size', s); mark(); }, sizesG);
  b.dataset.s = s; return b;
});
const historyG = group();
const undoBtn = el('pick', undoSvg, () => undo(), historyG);
const redoBtn = el('pick', redoSvg, () => redo(), historyG);
undoBtn.setAttribute('aria-label', 'Undo'); redoBtn.setAttribute('aria-label', 'Redo');
// Save: what's drawn, on white, goes into Photos (it stays on the board too).
let saving = false, saveMsgT;
const saveBtn = el('btn soft save', 'Save', async (b) => {
  if (saving || !ops.length && !base.width) return;
  saving = true; b.textContent = 'Saving…';
  let ok = false;
  try {
    const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
    const g = out.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height); g.drawImage(cv, 0, 0);
    const blob = await new Promise((done) => out.toBlob(done, 'image/png'));
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    await house.addPhoto(blob, `whiteboard-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`);
    ok = true;
  } catch {}
  saving = false; b.textContent = ok ? 'Saved to Photos' : 'Couldn’t save';
  clearTimeout(saveMsgT); saveMsgT = setTimeout(() => { b.textContent = 'Save'; }, 2500);
}, top);
let clearArmed = 0, clearT;
const clearBtn = el('btn soft clear', 'Clear', (b) => {
  // tap twice to wipe, so a stray tap doesn't erase everything (and Undo brings it back)
  if (Date.now() - clearArmed < 2500) { wipe(); clearArmed = 0; disarm(); return; }
  clearArmed = Date.now(); b.classList.add('armed'); b.textContent = 'Tap again';
  clearTimeout(clearT); clearT = setTimeout(disarm, 2500);
}, top);
function disarm() { clearBtn.classList.remove('armed'); clearBtn.textContent = 'Clear'; }

function mark() {
  penBtns.forEach((b) => b.classList.toggle('on', !erasing && b.dataset.c === color));
  eraseBtn.classList.toggle('on', erasing);
  sizeBtns.forEach((b) => b.classList.toggle('on', +b.dataset.s === size));
  undoBtn.style.opacity = ops.length ? '' : '.3';
  redoBtn.style.opacity = undone.length ? '' : '.3';
}

// What's drawn: a base picture (what was saved before, and strokes too old to undo) plus the strokes since, so undo
// and redo just draw it again. Each stroke is its points, color, width and whether it erased; Clear is a step too.
const KEEP = 60; // steps that can be undone
const ops = [], undone = [];
const strokes = new Map(); // being drawn, by finger
const base = document.createElement('canvas'); base.width = base.height = 0;
const bctx = base.getContext('2d');

function grow(w, h) {
  if (base.width >= w && base.height >= h) return;
  const old = document.createElement('canvas'); old.width = base.width; old.height = base.height;
  if (base.width && base.height) old.getContext('2d').drawImage(base, 0, 0);
  base.width = Math.max(w, base.width); base.height = Math.max(h, base.height);
  if (old.width && old.height) bctx.drawImage(old, 0, 0);
}
function paint(g, op) {
  if (op.clear) { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, g.canvas.width, g.canvas.height); g.restore(); return; }
  g.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
  g.fillStyle = g.strokeStyle = op.color; g.lineWidth = op.w; g.lineCap = 'round'; g.lineJoin = 'round';
  const p0 = op.pts[0];
  g.beginPath(); g.arc(p0[0], p0[1], op.w / 2, 0, Math.PI * 2); g.fill();
  if (op.pts.length > 1) { g.beginPath(); g.moveTo(p0[0], p0[1]); for (let i = 1; i < op.pts.length; i++) g.lineTo(op.pts[i][0], op.pts[i][1]); g.stroke(); }
  g.globalCompositeOperation = 'source-over';
}
function redraw() {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
  if (base.width && base.height) ctx.drawImage(base, 0, 0);
  ctx.restore();
  for (const op of ops) paint(ctx, op);
  for (const s of strokes.values()) paint(ctx, s);
}
function commit(op) {
  ops.push(op); undone.length = 0;
  while (ops.length > KEEP) { grow(cv.width, cv.height); bctx.setTransform(dpr, 0, 0, dpr, 0, 0); paint(bctx, ops.shift()); }
  save(); mark();
}
function undo() { if (strokes.size || !ops.length) return; undone.push(ops.pop()); redraw(); save(); mark(); }
function redo() { if (strokes.size || !undone.length) return; ops.push(undone.pop()); redraw(); save(); mark(); }
function wipe() { strokes.clear(); commit({ clear: true }); redraw(); }

const saved = localStorage.getItem(KEY + 'img');
if (saved) { const img = new Image(); img.onload = () => { grow(img.width, img.height); bctx.drawImage(img, 0, 0); redraw(); }; img.src = saved; }
function resize() {
  const r = board.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}
addEventListener('resize', resize);
resize();
mark();

let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY + 'img', cv.toDataURL()); } catch {} }, 400); }

function pos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const op = { erase: erasing, color, w: size, pts: [pos(e)] }; // the eraser is the size picked, like the pens
  strokes.set(e.pointerId, op);
  paint(ctx, op);
});
cv.addEventListener('pointermove', (e) => {
  const op = strokes.get(e.pointerId); if (!op) return;
  const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  const evs = co.length ? co : [e];
  const from = op.pts.length - 1;
  for (const ev of evs) op.pts.push(pos(ev));
  ctx.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = op.color; ctx.lineWidth = op.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(op.pts[from][0], op.pts[from][1]);
  for (let i = from + 1; i < op.pts.length; i++) ctx.lineTo(op.pts[i][0], op.pts[i][1]);
  ctx.stroke(); ctx.globalCompositeOperation = 'source-over';
});
const end = (e) => { const op = strokes.get(e.pointerId); if (!op) return; strokes.delete(e.pointerId); commit(op); };
cv.addEventListener('pointerup', end);
cv.addEventListener('pointercancel', end);
