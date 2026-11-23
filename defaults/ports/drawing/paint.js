// How each tool lays paint down: the same as the native app's drawSegment (Android Paint with round caps and joins).
// A stroke is {c: color (signed ARGB int, like Android), s: size, e: eraser, m: medium, o: opacity, p: [[x, y, pressure]]}.
// Media: 0 bristle brush, 1 watercolor, 2 ink pen, 3 graphite pencil, 4 soft marker.

export const W = 2000, H = 1200;

// ---- colors as Android ints ------------------------------------------------------------------------------------
export const argb = (a, r, g, b) => ((a & 255) << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
export const hex = (h) => argb(255, parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
export const rgbOf = (c) => [(c >>> 16) & 255, (c >>> 8) & 255, c & 255];
export const css = (c) => `rgb(${rgbOf(c).join(',')})`;

/** Android's Color.colorToHSV: [hue 0..360, saturation 0..1, value 0..1]. */
export function toHsv(c) {
  const [r, g, b] = rgbOf(c).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
/** Android's Color.HSVToColor (opaque). */
export function fromHsv([h, s, v]) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return argb(255, Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}

// ---- drawing -------------------------------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function line(g, ax, ay, bx, by) {
  if (ax === bx && ay === by) return; // a zero-length line draws nothing on Android; the dots are drawn on purpose below
  g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
}
function dot(g, x, y, r) { g.beginPath(); g.arc(x, y, Math.max(0, r), 0, Math.PI * 2); g.fill(); }
const alpha = (g, a) => { g.globalAlpha = clamp(Math.trunc(a), 0, 255) / 255; };

/** One segment of stroke s from point a to point b, into g (in canvas units). paper: what the eraser paints. */
export function drawSegment(g, s, a, b, paper) {
  const color = css(s.e ? paper : s.c);
  g.strokeStyle = color; g.fillStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
  alpha(g, s.e ? 255 : 255 * s.o);
  const width = s.s * clamp((a[2] + b[2]) / 2, 0.25, 2);
  const same = a[0] === b[0] && a[1] === b[1];
  if (!s.e && (s.m === 3 || s.m === 4)) {
    if (s.m === 3) {
      // Graphite: five fine, faint lines side by side, the middle one darkest.
      g.lineWidth = Math.max(1, width * 0.22);
      for (let i = -2; i <= 2; i++) {
        alpha(g, s.o * (i === 0 ? 110 : 40));
        line(g, a[0] + i * 0.7, a[1] + i * 0.4, b[0] + i * 0.7, b[1] + i * 0.4);
      }
      if (same && a[2] === b[2]) dot(g, a[0], a[1], Math.max(1, width * 0.11));
    } else {
      // Soft marker: one wide translucent line.
      alpha(g, 90 * s.o);
      g.lineWidth = width;
      line(g, a[0], a[1], b[0], b[1]);
      if (same && a[2] === b[2]) dot(g, a[0], a[1], width / 2);
    }
    g.globalAlpha = 1;
    return;
  }
  if (!s.e && s.m !== 2) {
    const dx = b[0] - a[0], dy = b[1] - a[1], distance = Math.sqrt(dx * dx + dy * dy);
    if (s.m === 0) {
      // Parallel bristles leave narrow gaps and softly uneven edges.
      const nx = -0.38, ny = 0.925;
      g.lineWidth = width / 9;
      for (let bristle = 0; bristle <= 10; bristle++) {
        const offset = (bristle - 5) * width / 11;
        alpha(g, (bristle === 0 || bristle === 10 ? 70 : 165 + (bristle % 3) * 25) * s.o);
        const ax = a[0] + nx * offset, ay = a[1] + ny * offset;
        if (distance < 0.01) dot(g, ax, ay, g.lineWidth / 2);
        else line(g, ax, ay, b[0] + nx * offset, b[1] + ny * offset);
      }
    } else {
      // Watercolor: translucent overlapping pigment builds up as the brush passes.
      const steps = Math.max(1, Math.ceil(distance / Math.max(2, width * 0.16)));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps, x = a[0] + dx * t, y = a[1] + dy * t;
        alpha(g, 13 * s.o); dot(g, x, y, width * 0.54);
        alpha(g, 19 * s.o); dot(g, x, y, width * 0.43);
        alpha(g, 12 * s.o); dot(g, x, y, width * 0.31);
      }
    }
    g.globalAlpha = 1;
    return;
  }
  // Ink pen and eraser: to the midpoint, then on to b (two passes, as the native app drew them).
  g.lineWidth = width;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  line(g, a[0], a[1], mx, my);
  line(g, mx, my, b[0], b[1]);
  if (same) dot(g, a[0], a[1], width / 2);
  g.globalAlpha = 1;
}

/** Every point of a stroke, as the native app replayed it. */
export function drawStroke(g, s, paper) {
  const p = s.p;
  if (!p.length) return;
  drawSegment(g, s, p[0], p[0], paper);
  for (let i = 1; i < p.length; i++) drawSegment(g, s, p[i - 1], p[i], paper);
}
