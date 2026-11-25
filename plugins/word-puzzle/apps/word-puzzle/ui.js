// Small helpers for the page: making elements, dates in the household's own time, and one sheet at a time.
// No kit here, so the same file works in the app and its card on Home.

/** h('div', {class, tap, oninput, ...attrs}, ...children) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'tap') el.addEventListener('click', (e) => { e.stopPropagation(); v(e); });
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

const pad = (n) => String(n).padStart(2, '0');
/** YYYY-MM-DD, local. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const addDays = (k, n) => { const d = dateOf(k); d.setDate(d.getDate() + n); return dayKey(d); };
export const weekday = (k, long = true) => dateOf(k).toLocaleDateString('en-US', { weekday: long ? 'long' : 'short' });
export const monthDay = (k) => dateOf(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const hm = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
/** "today", "tomorrow", "Thursday" (this week) or "Thursday, Dec 3". */
export function whenDay(k, from = dayKey()) {
  if (k === from) return 'today';
  if (k === addDays(from, 1)) return 'tomorrow';
  const n = Math.round((dateOf(k) - dateOf(from)) / 864e5);
  return n > 0 && n < 7 ? weekday(k) : `${weekday(k)}, ${monthDay(k)}`;
}
/** "a, b and c" */
export const and = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`);
/** "HH:MM" today as a Date. */
export function at(hhmm, day = new Date()) { const [hh, mm] = String(hhmm || '0:0').split(':').map(Number); const d = new Date(day); d.setHours(hh || 0, mm || 0, 0, 0); return d; }

/** One sheet over the page: title, its rows, and the buttons at the bottom ([{text, tap, soft}]). Returns close(). */
export function sheet(title, rows, buttons) {
  document.querySelector('.scrim')?.remove();
  const close = () => scrim.remove();
  const scrim = h('div', { class: 'scrim', onclick: close },
    h('div', { class: 'sheet', onclick: (e) => e.stopPropagation() },
      h('h2', {}, title), rows,
      h('div', { class: 'actions' }, h('span', { class: 'grow' }),
        buttons.map((b) => h('button', { class: 'btn' + (b.soft ? ' soft' : ''), tap: () => b.tap(close) }, b.text)))));
  document.body.append(scrim);
  return close;
}
/** A labelled field for a sheet. */
export const field = (label, input, hint = null) => h('label', { class: 'row' }, h('span', { class: 'label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
/** el's children replaced by kids, leaving out null, false and empty lists (replaceChildren would print "null"). */
export const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c.nodeType ? c : String(c))));
/** Runs start() (which returns its stop) only while this page is on the screen: its own window, its tab, its card;
 *  not the copy the home screen keeps hidden to run in the background. For the kit's onAction, so one ask is done
 *  once, by the copy that's showing (an action with "open" brings it up). */
export function whenShown(start) {
  let stop = null;
  const check = () => {
    const on = window.innerWidth > 0 && window.innerHeight > 0 && !document.hidden;
    if (on && !stop) stop = start(); else if (!on && stop) { stop(); stop = null; }
  };
  check(); addEventListener('resize', check); document.addEventListener('visibilitychange', check); setInterval(check, 1500);
}
