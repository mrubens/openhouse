// Days in the display's own time zone: the one copy every part of the bridge takes them from (house/util.js passes
// them on to the house's parts). Nothing here keeps state.

export const pad = (n) => String(n).padStart(2, '0');
/** A day's key, "2026-11-24", in local time (toISOString's is tomorrow by evening). */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** n days from d by the calendar, at noon (not n × 24 hours: around a DST change that skips or repeats a day). */
export const daysFrom = (n, d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
/** The midnight n days after d's day (an all-day event's end: a day with a DST change is 23 or 25 hours). */
export const midnightAfter = (d, n = 1) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
