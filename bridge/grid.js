// The door's grid, like a phone's home screen: pages of cells, and everything on the door (notes, the clock, the
// weather, apps, the home app's own things) takes a whole number of them. The display (ui/DoorGrid.kt) lays the
// door out with the same rules, so what the assistant is told here is what the family sees.
//
// Positions are 0-based in door.json ({page, col, row, w, h}); the assistant's tools count from 1.

export const COLS = 8, ROWS = 5;
/** The bottom-right cell is the assistant's own corner (its sticky note sits there): nothing goes in it. */
export const RESERVED = [{ col: COLS - 1, row: ROWS - 1, w: 1, h: 1 }];
/** The shapes anything but an app can take, smallest first ("WxH": cells across, cells down). Apps are 1x1. */
export const SHAPES = ['1x1', '2x1', '2x2', '4x2', '4x4'];
/** Note sizes from before the grid, and what they became. */
export const OLD_SIZES = { small: '1x1', wide: '2x1', tall: '2x2', large: '2x2', big: '4x2', huge: '4x4' };
/** A cell in the old free-form door's units (u), for moving old places onto the grid. */
export const CELL_U = [182, 173];

export const dims = (shape) => { const [w, h] = String(shape).split('x').map(Number); return { w, h }; };
/** A shape from what was asked for ("2x2", "2×2", or an old size name); null if it isn't one. */
export function shapeOf(s) {
  const t = String(s ?? '').trim().toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '');
  if (SHAPES.includes(t)) return t;
  return OLD_SIZES[t] || null;
}
export const area = (shape) => { const { w, h } = dims(shape); return w * h; };

const overlaps = (a, b) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
const inBounds = (s) => s.col >= 0 && s.row >= 0 && s.col + s.w <= COLS && s.row + s.h <= ROWS;

/** Is [s] ({page, col, row, w, h}) free of everything in [items] (but [ignore]) and of the reserved corner? */
export function fits(items, s, ignore = null) {
  if (!inBounds(s) || RESERVED.some((r) => overlaps(r, s))) return false;
  return !items.some((i) => i.key !== ignore && i.page === s.page && overlaps(i, s));
}
export const pages = (items) => Math.max(1, ...items.map((i) => i.page + 1));

/** Every free spot for a w x h thing on [page], reading order. */
export function freeOn(items, page, w, h, ignore = null) {
  const out = [];
  for (let row = 0; row + h <= ROWS; row++) for (let col = 0; col + w <= COLS; col++) if (fits(items, { page, col, row, w, h }, ignore)) out.push({ page, col, row, w, h });
  return out;
}
/** The first free spot in reading order, from [fromPage] on (a page past the last one if they're all full). */
export function firstFree(items, w, h, fromPage = 0, ignore = null) {
  for (let p = fromPage; ; p++) { const f = freeOn(items, p, w, h, ignore); if (f.length) return f[0]; if (p > pages(items) + 1) return { page: p, col: 0, row: 0, w, h }; }
}
/** The free spot nearest [hint] ({page, col, row}): on its page if there's room (along its row first), else the next page with room. */
export function nearest(items, w, h, hint, ignore = null) {
  const cost = (s) => Math.abs(s.col - hint.col) + 1.5 * Math.abs(s.row - hint.row);
  for (let p = Math.max(0, hint.page | 0); ; p++) {
    const f = freeOn(items, p, w, h, ignore);
    if (f.length) return f.sort((a, b) => cost(a) - cost(b))[0];
    if (p > pages(items) + 1) return { page: p, col: 0, row: 0, w, h };
  }
}
/** A spot for a w x h thing as close to (col, row) as the grid's edges and the reserved corner allow (others not counted). */
export function clamp(s) {
  const c = { ...s, col: Math.max(0, Math.min(COLS - s.w, s.col | 0)), row: Math.max(0, Math.min(ROWS - s.h, s.row | 0)), page: Math.max(0, s.page | 0) };
  if (fits([], c)) return c;
  return nearest([], s.w, s.h, c); // only the reserved corner can be in the way
}

/**
 * [key] goes to [target] ({page, col, row, w, h}); whatever was there makes room, each to the free spot nearest where it
 * was (its own page first, else a later one). Returns the new list; nothing else moves.
 */
export function makeRoom(items, key, target) {
  const t = { ...clamp(target), key };
  const rest = items.filter((i) => i.key !== key);
  const inTheWay = rest.filter((i) => i.page === t.page && overlaps(i, t)).sort((a, b) => b.w * b.h - a.w * a.h);
  const out = [...rest.filter((i) => !inTheWay.includes(i)), t];
  for (const i of inTheWay) out.push({ ...i, ...nearest(out, i.w, i.h, i) });
  return out;
}

/** Anything that overlaps something before it (or the reserved corner, or the edges) moves to the nearest free spot. */
export function settle(items) {
  const out = [];
  for (const i of items) out.push(fits(out, i) ? i : { ...i, ...nearest(out, i.w, i.h, clamp(i)) });
  return out;
}

/** An old free-form spot (x, y in u, top-left) as the cell it was nearest, on the first page. */
export const cellFromU = (x, y, w = 1, h = 1) => clamp({ page: 0, col: Math.round((Number(x) || 0) / CELL_U[0]), row: Math.round((Number(y) || 0) / CELL_U[1]), w, h });

/** A picture of [page] for the assistant: a letter per cell (. free, # the assistant's corner), and what each letter is. */
export function map(items, page, label) {
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill('.'));
  for (const r of RESERVED) grid[r.row][r.col] = '#';
  const legend = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  items.filter((i) => i.page === page).forEach((i, n) => {
    const l = letters[n % letters.length];
    for (let r = i.row; r < i.row + i.h; r++) for (let c = i.col; c < i.col + i.w; c++) if (grid[r]?.[c] === '.') grid[r][c] = l;
    legend.push(`${l} ${label(i)} (${i.w}x${i.h} at col ${i.col + 1}, row ${i.row + 1})`);
  });
  return { rows: ['    ' + Array.from({ length: COLS }, (_, c) => c + 1).join(' '), ...grid.map((r, n) => `  ${n + 1} ${r.join(' ')}`)], legend };
}
