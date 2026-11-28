// The time, for the few things on screen that show it (a clock, a timer's seconds, a photo that moves on). One clock for
// the page, read each second; a part that uses it draws again only when its own step has passed (a minute for a clock,
// a second for a timer), so the rest of the screen isn't drawn again every second.
import { useSyncExternalStore } from 'react';

let current = Date.now(), timer = null;
const subs = new Set();
function subscribe(cb) {
  subs.add(cb);
  if (!timer) { current = Date.now(); timer = setInterval(() => { current = Date.now(); for (const f of subs) f(); }, 1000); }
  return () => { subs.delete(cb); if (!subs.size) { clearInterval(timer); timer = null; } };
}

/** The page's time (ms), as of its last second; the caller draws again each time [step] ms (on the clock) have passed. */
export function useNow(step = 1000) {
  useSyncExternalStore(subscribe, () => { if (!timer) current = Date.now(); return Math.floor(current / step); });
  return current;
}

/** Midnight to 4am: still last night to the people up, so "today" and "tomorrow" would read a day off. Screens use
 *  the weekday's name instead ("Wednesday", "Thursday") until 4. */
export const smallHours = (now) => new Date(now).getHours() < 4;

/** Is [now] in the household's night hours ({from, to} "HH:MM", which may run past midnight)? */
export function isNight(n, now) {
  if (!n?.from || !n?.to) return false;
  const d = new Date(now), m = d.getHours() * 60 + d.getMinutes(), min = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const f = min(n.from), t = min(n.to);
  return f <= t ? m >= f && m < t : m >= f || m < t;
}

/** The resting screen as the household set it (bridge house/settings.js RESTING), with its defaults for an older bridge. */
export const RESTING = { after: 8, every: 15, order: 'order', fit: 'fit', show: { time: true, weather: true, next: true, captions: true }, calendar: false };
export const restingOf = (house) => ({ ...RESTING, ...(house?.resting || {}), show: { ...RESTING.show, ...(house?.resting?.show || {}) } });
