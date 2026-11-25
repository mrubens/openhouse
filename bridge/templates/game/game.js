// A tiny game engine for one-screen games: a 1920x1080 world on a canvas that fits the screen, a loop, things that
// move and draw, touch and keys, collisions, gravity and platforms, on-screen buttons, a score, particles, sounds, and
// a "game over / play again" card. A game's own main.js imports it and only says what its things are and do.
//
//   import { start, add, remove, things, hit, near, button, pointer, keys, solids, burst, shake, beep, over, text, rand } from './game.js';
//   start({ background: '#0b1a2a', setup() { ... add things ... }, update(dt, t) { ... each frame ... }, draw(ctx) { ... over everything ... } });
//
// A thing is a plain object: { x, y, w, h } (its center and size, in world units), optional vx, vy (units/s),
// gravity (units/s², pulled down), solid: true (others stand on it), tag: 'egg', update(dt, thing), draw(ctx, thing).
// With no draw, a thing is a rounded box in its color. Things with gravity land on solids: thing.onGround says so.
// Buttons stay down while touched: button({ x, y, r, label }) returns { down, tapped } (tapped: this frame only).
// pointer: { x, y, down, tapped } in world units. keys: a Set of held keys ('ArrowLeft', ' ', ...).
// over('You got 12!', { best }) shows a card with a Play again button; it calls setup again.
export const W = 1920, H = 1080;
export const things = [];
export const keys = new Set();
export const pointer = { x: W / 2, y: H / 2, down: false, tapped: false };
let game = null, canvas = null, ctx = null, scale = 1, ox = 0, oy = 0, last = 0, running = false, shakeMs = 0, card = null, audio = null;
const buttons = [], parts = [];

export const rand = (a, b) => a + Math.random() * (b - a);
export const add = (t) => { things.push(t); return t; };
export const remove = (t) => { const i = things.indexOf(t); if (i >= 0) things.splice(i, 1); };
/** Boxes overlap (centers and sizes). */
export const hit = (a, b) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
/** Centers within d. */
export const near = (a, b, d) => Math.hypot(a.x - b.x, a.y - b.y) < d;
export const solids = () => things.filter((t) => t.solid);
export function shake(ms = 250) { shakeMs = Math.max(shakeMs, ms); }
export function burst(x, y, color = '#ffd34d', n = 16) {
  for (let i = 0; i < n; i++) { const a = rand(0, Math.PI * 2), s = rand(150, 600); parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.4, 0.9), color }); }
}
/** A short tone (Web Audio): beep(660, 0.1). */
export function beep(freq = 440, sec = 0.1, type = 'sine') {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(0.15, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + sec);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + sec);
  } catch {}
}
/** Big text, centered on x unless align says otherwise. */
export function text(c, s, x, y, { size = 56, color = '#fff', align = 'center', weight = 800 } = {}) {
  c.font = `${weight} ${size}px system-ui, sans-serif`; c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle'; c.fillText(String(s), x, y);
}
/** An on-screen button, held while touched. Call once (in setup); read .down / .tapped each frame. */
export function button({ x, y, r = 90, label = '', color = 'rgba(255,255,255,.18)' }) {
  const b = { x, y, r, label, color, down: false, tapped: false };
  buttons.push(b);
  return b;
}
/** The end of a round: a card with what happened and Play again (which runs setup again). */
export function over(message, { best = null } = {}) { card = { message, best }; beep(220, 0.3, 'triangle'); }

function fit() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  scale = Math.min(innerWidth / W, innerHeight / H) * dpr;
  ox = (canvas.width - W * scale) / 2; oy = (canvas.height - H * scale) / 2;
}
function toWorld(e) { const dpr = Math.min(devicePixelRatio || 1, 2); return { x: (e.clientX * dpr - ox) / scale, y: (e.clientY * dpr - oy) / scale }; }
const touches = new Map(); // pointer id -> world point (several fingers: left and jump at once)
function pressed() {
  for (const b of buttons) b.down = [...touches.values()].some((p) => Math.hypot(p.x - b.x, p.y - b.y) < b.r * 1.2);
}

function restart() {
  things.length = 0; parts.length = 0; buttons.length = 0; card = null;
  game.setup?.();
}
function frame(now) {
  if (!running) return;
  const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
  const wasDown = buttons.map((b) => b.down);
  if (!card) {
    game.update?.(dt, now / 1000);
    for (const t of [...things]) {
      if (t.gravity) t.vy = (t.vy || 0) + t.gravity * dt;
      const px = t.x, py = t.y;
      t.x += (t.vx || 0) * dt; t.y += (t.vy || 0) * dt;
      if (t.gravity) { // land on solids from above; stop at their sides and undersides
        t.onGround = false;
        for (const s of things) {
          if (!s.solid || s === t || !hit(t, s)) continue;
          if (py + t.h / 2 <= s.y - s.h / 2 + 1 && t.vy >= 0) { t.y = s.y - s.h / 2 - t.h / 2; t.vy = 0; t.onGround = true; }
          else if (py - t.h / 2 >= s.y + s.h / 2 - 1 && t.vy < 0) { t.y = s.y + s.h / 2 + t.h / 2; t.vy = 0; }
          else t.x = px;
        }
      }
      t.update?.(dt, t);
    }
  }
  for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; p.life -= dt; }
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
  // draw
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  shakeMs = Math.max(0, shakeMs - dt * 1000);
  const sx = shakeMs ? rand(-8, 8) : 0, sy = shakeMs ? rand(-8, 8) : 0;
  ctx.setTransform(scale, 0, 0, scale, ox + sx * scale, oy + sy * scale);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  ctx.fillStyle = game.background || '#14202e'; ctx.fillRect(0, 0, W, H);
  game.drawBehind?.(ctx);
  for (const t of things) {
    if (t.draw) { t.draw(ctx, t); continue; }
    ctx.fillStyle = t.color || '#8fd1ff'; ctx.beginPath(); ctx.roundRect(t.x - t.w / 2, t.y - t.h / 2, t.w, t.h, Math.min(t.w, t.h) * 0.2); ctx.fill();
  }
  for (const p of parts) { ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
  game.draw?.(ctx);
  for (const b of buttons) {
    ctx.fillStyle = b.down ? 'rgba(255,255,255,.35)' : b.color; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    text(ctx, b.label, b.x, b.y, { size: b.r * 0.7 });
  }
  if (card) {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(W / 2 - 420, H / 2 - 240, 840, 480, 40); ctx.fill();
    text(ctx, card.message, W / 2, H / 2 - 110, { size: 72, color: '#1c2430' });
    if (card.best != null) text(ctx, `Best: ${card.best}`, W / 2, H / 2 - 10, { size: 44, color: '#56606e', weight: 600 });
    ctx.fillStyle = '#2f7de1'; ctx.beginPath(); ctx.roundRect(W / 2 - 220, H / 2 + 70, 440, 120, 60); ctx.fill();
    text(ctx, 'Play again', W / 2, H / 2 + 130, { size: 52 });
  }
  ctx.restore();
  buttons.forEach((b, i) => { b.tapped = b.down && !wasDown[i]; });
  pointer.tapped = false;
  requestAnimationFrame(frame);
}

/** Start the game: { background, setup(), update(dt, t), drawBehind(ctx), draw(ctx) }. */
export function start(g) {
  game = g;
  document.documentElement.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#000;touch-action:none';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden';
  canvas = document.createElement('canvas'); canvas.style.cssText = 'display:block;width:100vw;height:100vh;touch-action:none';
  document.body.append(canvas); ctx = canvas.getContext('2d');
  fit(); addEventListener('resize', fit);
  canvas.addEventListener('pointerdown', (e) => {
    const p = toWorld(e); touches.set(e.pointerId, p); Object.assign(pointer, p, { down: true, tapped: true }); pressed();
    if (card && Math.abs(p.x - W / 2) < 220 && Math.abs(p.y - (H / 2 + 130)) < 60) restart();
  });
  canvas.addEventListener('pointermove', (e) => { const p = toWorld(e); if (touches.has(e.pointerId)) touches.set(e.pointerId, p); Object.assign(pointer, p); pressed(); });
  const up = (e) => { touches.delete(e.pointerId); pointer.down = touches.size > 0; pressed(); };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  addEventListener('keydown', (e) => keys.add(e.key));
  addEventListener('keyup', (e) => keys.delete(e.key));
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { last = performance.now(); requestAnimationFrame(frame); } });
  restart();
  running = true; last = performance.now(); requestAnimationFrame(frame);
}
