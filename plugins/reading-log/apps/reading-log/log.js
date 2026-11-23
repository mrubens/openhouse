// The reading log's sums: minutes a day, a week's days, streaks. No page or kit here.
import { dayKey, addDays, dateOf } from './ui.js';

/** Minutes read by someone on a day. */
export const minutesOn = (log, who, day) => log.filter((e) => e.who === who && e.day === day).reduce((s, e) => s + e.minutes, 0);
/** The week (Monday first) holding a day: its seven days. */
export const weekOf = (day = dayKey()) => { const mon = addDays(day, -((dateOf(day).getDay() + 6) % 7)); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i)); };
/** Days in a row with at least `goal` minutes, up to today (today counts once it's reached; until then, up to yesterday). */
export function streak(log, who, goal, today = dayKey()) {
  let d = minutesOn(log, who, today) >= goal ? today : addDays(today, -1), n = 0;
  while (minutesOn(log, who, d) >= goal && n < 3650) { n++; d = addDays(d, -1); }
  return n;
}
/** The longest such run there's been. */
export function best(log, who, goal) {
  const days = [...new Set(log.filter((e) => e.who === who).map((e) => e.day))].sort();
  let top = 0, run = 0, prev = null;
  for (const d of days) {
    if (minutesOn(log, who, d) < goal) { run = 0; prev = d; continue; }
    run = prev && addDays(prev, 1) === d && run ? run + 1 : 1; prev = d; top = Math.max(top, run);
  }
  return top;
}
