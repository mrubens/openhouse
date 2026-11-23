// Typing Garden: twelve typing lessons, each growing a flower. Drawn on a canvas with a 1536x960 layout scaled to fit.
// The learners are the family (from the kit); each one's best accuracy and speed per lesson are kept in the app's store.
import { house, store } from '/kit/openhouse.js';

const W = 1536, H = 960;
const canvas = document.getElementById('garden');
const ctx = canvas.getContext('2d');
const field = document.getElementById('type');

const names = ['Home row: F & J', 'Add D & K', 'Add S & L', 'Add A & ;', 'Home row words', 'Reach to E & I', 'Reach to R & U', 'Top row adventures', 'Bottom row', 'Little sentences', 'Big letters', 'Numbers & punctuation'];
const baseDrills = [
  'fff jjj fjf jfj ff jj fj jf fj fj',
  'ddd kkk df jk fd kj fj dk fd jk',
  'sss lll sls lsl ds kl fl sk sld kls',
  'aaa ;;; as df jk l; all fall ask;',
  'dad adds a salad; a lass asks dad;',
  'eee iii did kid like ride side idle',
  'rrr uuu fur rug red jug ride rude',
  'the quiet owl sat up high at the lake',
  'zzz xxx ccc vvv bbb nnn mmm zoom mix cave bunny',
  'a little cat can hop and run. the sun is warm.',
  null, // "Big letters": made from the family's names
  '1 2 3 4 5 6 7 8 9 0. I have 2 cats, 3 dogs!',
];
const colors = ['#E8A99A', '#E9C475', '#ABD3A2', '#9CCBD1', '#9CCBD1', '#ABD3A2', '#E9C475', '#E8A99A'];

// ---- state -----------------------------------------------------------------------------------------------
let family = [];          // names, in the family's order
let person = '';          // the chosen learner
let progress = { person: '', scores: {} };
let page = 'home', lesson = 0, target = '', position = 0, mistakes = 0, attempts = 0, started = 0;
let wrong = false, finished = false, resultWpm = 0, resultAccuracy = 100, shifted = false;
let hits = [];
let scale = 1, offX = 0, offY = 0;

const firstName = (n) => String(n || '').trim().split(/\s+/)[0];
function drill(i) {
  if (baseDrills[i] !== null) return baseDrills[i];
  const [a, b] = family.map(firstName).filter(Boolean);
  return a && b ? `${a} and ${b} can type. I like my garden!` : 'We can type. I like my garden!';
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function scoresOf(who) {
  const k = Object.keys(progress.scores).find((n) => same(n, who));
  return k === undefined ? {} : progress.scores[k];
}
const best = (what, i) => Number(scoresOf(person)[`${what}.${i}`]) || 0;
function setBest(what, i, n) {
  let k = Object.keys(progress.scores).find((x) => same(x, person));
  if (k === undefined) { k = person; progress.scores[k] = {}; }
  const key = `${what}.${i}`;
  progress.scores[k][key] = Math.max(n, Number(progress.scores[k][key]) || 0);
}
function save() { progress.person = person; store.set('progress', progress).catch((e) => console.warn(e.message)); }

// ---- drawing helpers (the Kotlin's Paint calls, on a 2D canvas) -----------------------------------------------
function rect(x, y, w, h, color, radius = 22) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2)); ctx.fill();
}
function text(s, x, y, size, color = '#244638', bold = false) {
  ctx.fillStyle = color; ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`; ctx.textBaseline = 'alphabetic'; ctx.fillText(s, x, y);
}
function hit(x, y, w, h, action) { hits.push({ x, y, w, h, action }); }
function button(label, x, y, w, h, selected, action) {
  rect(x, y, w, h, selected ? '#315B4B' : '#FFFFFF');
  if (label) text(label, x + 20, y + h / 2 + 9, 25, selected ? '#FFFFFF' : '#244638', true);
  hit(x, y, w, h, action);
}
function oval(l, t, r, b) { ctx.beginPath(); ctx.ellipse((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, 0, 0, Math.PI * 2); }

function flower(x, ground, growth, tint, size = 1) {
  const g = Math.min(1, Math.max(0, growth));
  const top = -38 - g * 48;
  ctx.save(); ctx.translate(x, ground); ctx.scale(size, size);
  ctx.lineCap = 'round';
  ctx.fillStyle = '#D6DFC8'; oval(-32, -5, 34, 4); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(-12, -28, 12, top + 27, 0, top);
  ctx.strokeStyle = '#436E51'; ctx.lineWidth = 4; ctx.stroke();
  for (const side of [-1, 1]) {
    const y = side < 0 ? -23 : -40;
    ctx.beginPath(); ctx.moveTo(0, y);
    ctx.bezierCurveTo(side * 13, y - 25, side * 34, y - 20, side * 35, y - 24);
    ctx.bezierCurveTo(side * 30, y + 1, side * 13, y + 8, 0, y);
    ctx.fillStyle = side < 0 ? '#638C58' : '#88A66B'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, y); ctx.quadraticCurveTo(side * 17, y - 6, side * 29, y - 18);
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#D1DDB2'; ctx.stroke();
  }
  ctx.save(); ctx.translate(0, top);
  if (g < 0.55) {
    ctx.fillStyle = '#729161'; oval(-11, -14, 11, 13); ctx.fill();
    ctx.fillStyle = tint; oval(-8, -18, 8, 6); ctx.fill();
    ctx.fillStyle = '#F6DDD0'; oval(-4, -15, 0, 1); ctx.fill();
  } else {
    const bloom = 0.65 + 0.35 * ((g - 0.55) / 0.45);
    ctx.scale(bloom, bloom);
    for (let i = 0; i <= 7; i++) {
      ctx.save(); ctx.rotate(i * 45 * Math.PI / 180);
      ctx.beginPath(); ctx.moveTo(-3, 2);
      ctx.bezierCurveTo(-25, -15, -18, -41, 0, -39);
      ctx.bezierCurveTo(18, -41, 25, -15, 3, 2); ctx.closePath();
      ctx.fillStyle = tint; ctx.fill();
      ctx.lineWidth = 1.3; ctx.strokeStyle = '#FFFFFF'; ctx.globalAlpha = 95 / 255; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.quadraticCurveTo(-5, -22, 0, -31);
      ctx.strokeStyle = '#FFFFFF'; ctx.globalAlpha = 95 / 255; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.restore();
    }
    ctx.fillStyle = '#BD823A'; ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#F2CC71'; ctx.beginPath(); ctx.arc(0, -2, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#A97635';
    for (let i = 0; i <= 5; i++) {
      const angle = i * Math.PI / 3;
      ctx.beginPath(); ctx.arc(Math.cos(angle) * 6, Math.sin(angle) * 6 - 2, 1.3, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore(); ctx.restore();
}

function fingerColor(ch) {
  const c = ch.toLowerCase();
  if ('aqz1p0;/'.includes(c)) return colors[0];
  if ('swx2lo.9'.includes(c)) return colors[1];
  if ('dec3ki,8'.includes(c)) return colors[2];
  return colors[3];
}
function finger(ch) {
  const c = ch.toLowerCase();
  let f;
  if ('aqz1'.includes(c)) f = 'Left little finger';
  else if ('swx2'.includes(c)) f = 'Left ring finger';
  else if ('dec3'.includes(c)) f = 'Left middle finger';
  else if ('frtgvb45'.includes(c)) f = 'Left index finger';
  else if ('jyuhnm67'.includes(c)) f = 'Right index finger';
  else if ('ki,8'.includes(c)) f = 'Right middle finger';
  else if ('lo.9'.includes(c)) f = 'Right ring finger';
  else if (c === ' ') f = 'Either thumb';
  else f = 'Right little finger';
  const upper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
  return f + (upper || ch === '!' ? ' + opposite Shift' : '');
}

// ---- pages -----------------------------------------------------------------------------------------------
function learnerButtons() {
  // Up to four of the family, right-aligned where the Kotlin had its two, keeping the chosen one on screen.
  ctx.font = 'bold 25px sans-serif';
  const width = (n) => Math.max(175, Math.ceil(ctx.measureText(n).width) + 40);
  let shown = family.slice(0, 4);
  const fits = (list) => list.reduce((s, n) => s + width(n), 0) + 20 * (list.length - 1) <= 1420 - 420;
  while (shown.length > 1 && !fits(shown)) shown.pop();
  if (person && !shown.some((n) => same(n, person))) {
    const me = family.find((n) => same(n, person));
    if (me) { shown[shown.length - 1] = me; while (shown.length > 1 && !fits(shown)) shown.splice(shown.length - 2, 1); }
  }
  let x = 1420 - (shown.reduce((s, n) => s + width(n), 0) + 20 * (shown.length - 1));
  for (const n of shown) {
    const w = width(n);
    button(n, x, 38, w, 76, same(n, person), () => { if (!same(n, person)) { person = n; save(); } draw(); });
    x += w + 20;
  }
}

function drawHome() {
  learnerButtons();
  const stars = names.filter((_, i) => best('accuracy', i) >= 90).length;
  text(person ? `${person}’s lessons` : 'Lessons', 54, 180, 32, '#244638', true);
  text(`${stars} / 12 flowers earned  ·  Aim for 90% accuracy`, 700, 178, 26);
  names.forEach((name, i) => {
    const x = 54 + (i % 3) * 474, y = 210 + Math.floor(i / 3) * 151;
    const accuracy = best('accuracy', i);
    rect(x, y, 450, 133, accuracy >= 90 ? '#D9E9CF' : '#FFFFFF');
    text(`${i + 1}. ${name}`, x + 20, y + 40, 24, '#244638', true);
    flower(x + 400, y + 117, accuracy >= 90 ? 0.8 : 0.15, colors[i % colors.length], 0.62);
    text(accuracy > 0 ? `Best: ${accuracy}%  ·  ${best('wpm', i)} WPM` : i === 0 ? 'Start with F & J' : 'Tap to grow', x + 20, y + 83, 19, '#637866');
    hit(x, y, 450, 133, () => begin(i));
  });
  text('Use a physical keyboard, or tap the keys to explore.', 54, 866, 26);
  text('Rest fingers on A S D F and J K L ;. Look at the words as you type.', 54, 909, 23, '#637866');
}

function drawLesson() {
  button('Lessons', 1240, 38, 190, 76, false, () => { page = 'home'; field.blur(); draw(); });
  text(`${lesson + 1}. ${names[lesson]}`, 54, 179, 31, '#244638', true);
  if (finished) { drawResult(); return; }
  const accuracy = attempts === 0 ? 100 : Math.floor((attempts - mistakes) * 100 / attempts);
  text(`${position} / ${target.length} letters   ·   ${accuracy}% accuracy`, 790, 178, 25);
  rect(54, 209, 1376, 14, '#D6DFCE', 7);
  if (position > 0) rect(54, 209, 1376 * position / target.length, 14, '#709D65', 7);
  rect(54, 250, 1376, 205, '#FFFFFF');
  const start = Math.floor(position / 36) * 36;
  const shown = target.substring(start, Math.min(start + 36, target.length));
  [...shown].forEach((ch, i) => {
    const absolute = start + i, x = 81 + i * 26;
    if (absolute === position) rect(x - 2, 288, 26, 60, wrong ? '#F3C7BC' : '#D9E9CF', 5);
    text(ch === ' ' ? '·' : ch, x, 330, 34, absolute < position ? '#73956C' : '#244638', true);
  });
  const next = target[position];
  text(wrong ? 'Try the highlighted key — take your time.' : `${next === ' ' ? 'Space' : `Next: ${next}`}   ·   ${finger(next)}`, 82, 408, 27);
  rect(1160, 276, 231, 157, '#EFF3E7');
  flower(1275, 425, position / target.length, '#E8A99A');
  drawKeyboard(next);
  button('Start again', 54, 853, 225, 72, false, () => begin(lesson));
  text('Accuracy first. Speed grows with practice.', 322, 898, 25, '#637866');
}

function drawKeyboard(next) {
  const rows = ['1234567890', 'qwertyuiop', 'asdfghjkl;', 'zxcvbnm,./'];
  rows.forEach((row, r) => {
    const x0 = 170 + [0, 22, 49, 96][r];
    [...row].forEach((raw, i) => {
      const ch = shifted ? (raw === '1' ? '!' : raw.toUpperCase()) : raw;
      const x = x0 + i * 112, y = 483 + r * 77;
      const highlight = raw === next.toLowerCase() || (raw === '1' && next === '!');
      rect(x, y, 101, 66, highlight ? '#315B4B' : fingerColor(raw), 12);
      if (highlight) {
        ctx.strokeStyle = '#F3C953'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.roundRect(x - 3, y - 3, 107, 72, 15); ctx.stroke();
      }
      text(ch, x + 37, y + 43, 29, highlight ? '#FFFFFF' : '#244638', true);
      if (raw === 'f' || raw === 'j') rect(x + 36, y + 54, 27, 3, highlight ? '#FFFFFF' : '#315B4B', 1);
      hit(x, y, 101, 66, () => type(ch));
    });
  });
  button('Shift', 90, 799, 200, 62, shifted, () => { shifted = !shifted; draw(); });
  button('Space', 390, 799, 690, 62, next === ' ', () => type(' '));
  button('', 1120, 799, 175, 62, false, backspace);
  // The Backspace key's label: a drawn arrow pointing left.
  const ax = 1140, ay = 830;
  ctx.strokeStyle = '#244638'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(ax + 44, ay); ctx.lineTo(ax + 4, ay); ctx.moveTo(ax + 16, ay - 12); ctx.lineTo(ax + 4, ay); ctx.lineTo(ax + 16, ay + 12); ctx.stroke();
}

function drawResult() {
  const great = resultAccuracy >= 90;
  rect(54, 224, 1376, 541, '#FFFFFF');
  text(great ? 'A flower for your garden!' : 'Your garden is growing', 100, 305, 43, '#244638', true);
  text(`${resultAccuracy}% accuracy`, 100, 402, 52, '#244638', true);
  text(`${resultWpm} words per minute`, 100, 461, 30);
  text(great ? 'Great care with those keys. Try the next lesson when you’re ready.' : 'Try again slowly. Earn a flower with 90% accuracy.', 100, 537, 27);
  flower(1250, 602, great ? 1 : 0.45, '#E8A99A');
  text('Speed counts correct letters, including spaces. Practice without rushing.', 100, 590, 23, '#637866');
  button('Practice again', 100, 650, 295, 80, true, () => begin(lesson));
  if (lesson < names.length - 1) button('Next lesson', 420, 650, 270, 80, false, () => begin(lesson + 1));
  button('All lessons', 715, 650, 250, 80, false, () => { page = 'home'; draw(); });
}

function draw() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = innerWidth, ch = innerHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
  scale = Math.min(cw / W, ch / H); offX = (cw - W * scale) / 2; offY = (ch - H * scale) / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#EFF3E7'; ctx.fillRect(0, 0, cw, ch);
  ctx.translate(offX, offY); ctx.scale(scale, scale);
  hits = [];
  text('Typing Garden', 52, 72, 43, '#244638', true);
  text('Watch your practice bloom.', 54, 111, 23, '#637866');
  if (page === 'home') drawHome(); else drawLesson();
}

// ---- typing ------------------------------------------------------------------------------------------------
function begin(n) {
  lesson = n; target = drill(n); position = 0; mistakes = 0; attempts = 0; started = 0;
  wrong = false; finished = false; page = 'lesson'; draw();
}
function type(ch) {
  if (page !== 'lesson' || finished) return;
  if (started === 0) started = performance.now();
  attempts++;
  if (ch === target[position]) { position++; wrong = false; shifted = false; } else { mistakes++; wrong = true; }
  if (position === target.length) {
    finished = true;
    const elapsed = Math.max(1000, performance.now() - started);
    resultWpm = Math.floor(position * 12000 / elapsed);
    resultAccuracy = Math.floor((attempts - mistakes) * 100 / Math.max(1, attempts));
    setBest('accuracy', lesson, resultAccuracy); setBest('wpm', lesson, resultWpm); save();
    field.blur();
  }
  draw();
}
function backspace() { if (page === 'lesson' && !finished) { if (position > 0) position--; wrong = false; draw(); } }
const typing = () => page === 'lesson' && !finished;

document.addEventListener('keydown', (e) => {
  if (!typing() || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
  else if (e.key.length === 1) { e.preventDefault(); type(e.key); }
});
field.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'deleteContentBackward') { e.preventDefault(); backspace(); }
});
field.addEventListener('input', () => {
  const v = field.value; field.value = '';
  for (const ch of v) type(ch);
});

canvas.addEventListener('pointerdown', (e) => e.preventDefault()); // keeps the hidden field focused
canvas.addEventListener('mousedown', (e) => e.preventDefault());
canvas.addEventListener('pointerup', (e) => {
  const x = (e.clientX - offX) / scale, y = (e.clientY - offY) / scale;
  const h = hits.findLast((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  h?.action();
  if (typing()) field.focus({ preventScroll: true });
});
addEventListener('resize', draw);

// ---- loading -------------------------------------------------------------------------------------------------
function chooseLearner() {
  const me = family.find((n) => same(n, person));
  const want = me || family[0] || '';
  if (want !== person) { person = want; if (want && progress.person !== want) save(); }
}

async function load() {
  const saved = await store.get('progress');
  if (saved && typeof saved === 'object') progress = { person: saved.person || '', scores: saved.scores || {} };
  let changed = false;
  try {
    const old = await store.legacy();
    const prefs = old?.prefs?.['app.typing-garden'];
    if (old) {
      if (prefs) {
        for (const [k, v] of Object.entries(prefs)) {
          const m = /^(.*)\.(accuracy|wpm)\.(\d+)$/.exec(k);
          if (!m) continue;
          const n = parseInt(v, 10) || 0;
          let who = Object.keys(progress.scores).find((x) => same(x, m[1]));
          if (who === undefined) { who = m[1]; progress.scores[who] = {}; }
          const key = `${m[2]}.${m[3]}`;
          progress.scores[who][key] = Math.max(n, Number(progress.scores[who][key]) || 0);
        }
        if (!progress.person && prefs.person) progress.person = prefs.person;
        changed = true;
      }
      if (changed) await store.set('progress', progress);
      await old.done();
    }
  } catch (e) { console.warn(e.message); }
  person = progress.person || '';
  house.subscribe((h) => {
    family = (h.family || []).map((p) => p.name).filter(Boolean);
    chooseLearner();
    draw();
  });
  draw();
}

draw();
load();
