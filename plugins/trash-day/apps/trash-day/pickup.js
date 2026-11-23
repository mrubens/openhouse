// The household's own pickup schedule, as they set it: the weekday, whether recycling (and yard waste) goes every
// week or every other week, and whether a weekday holiday moves the rest of that week a day later. Or their city's
// pickup calendar (iCal), whose own dates and words are used as they are. No page or kit here.
import { dayKey, dateOf, addDays } from './ui.js';

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The weekday holidays many US cities move pickup for, in a year: [{date, name}]. Rules, not a list of dates. */
export function holidays(y) {
  const nth = (m, wd, n) => { const d = new Date(y, m, 1, 12); d.setDate(1 + ((wd - d.getDay() + 7) % 7) + 7 * (n - 1)); return d; };
  const last = (m, wd) => { const d = new Date(y, m + 1, 0, 12); d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7)); return d; };
  return [[new Date(y, 0, 1, 12), 'New Year’s Day'], [last(4, 1), 'Memorial Day'], [new Date(y, 6, 4, 12), 'the Fourth of July'],
    [nth(8, 1, 1), 'Labor Day'], [nth(10, 4, 4), 'Thanksgiving'], [new Date(y, 11, 25, 12), 'Christmas']]
    .filter(([d]) => d.getDay() > 0 && d.getDay() < 6).map(([d, name]) => ({ date: dayKey(d), name }));
}

const mondayOf = (k) => addDays(k, -((dateOf(k).getDay() + 6) % 7));
/** Is the week of that Monday one of the weeks counted from `start` (a day in a week it goes), every `every` weeks? */
const onWeek = (monday, start, every) => every === 1 || (Math.round((dateOf(monday) - dateOf(mondayOf(start || monday))) / (7 * 864e5)) % 2 + 2) % 2 === 0;
/** Is a month (0-11) inside the season from..to (0-11, wrapping round the new year)? */
const inSeason = (m, from, to) => (from <= to ? m >= from && m <= to : m >= from || m <= to);

/**
 * The pickups from a day on, by the household's rule:
 * s = { day: 'Tuesday', recycling: 'weekly' | 'alternate' | 'none', recyclingWeek: a date in a recycling week,
 *       yard: 'none' | 'weekly' | 'alternate', yardWeek, yardFrom: 0-11, yardTo: 0-11, holidays: true | false }
 * -> [{date, recycling, yard, moved: the holiday's name | null}]
 */
export function pickups(s, from = dayKey(), weeks = 6) {
  const wd = DAYS.indexOf(s?.day);
  if (wd < 0) return [];
  const out = [];
  let monday = mondayOf(from);
  for (let i = 0; i < weeks + 1; i++, monday = addDays(monday, 7)) {
    let date = addDays(monday, (wd + 6) % 7), moved = null;
    if (s.holidays) {
      const y = dateOf(monday).getFullYear(), h = [...holidays(y), ...holidays(y + 1)].find((x) => x.date >= monday && x.date <= date);
      if (h) { date = addDays(date, 1); moved = h.name; }
    }
    const recycling = s.recycling !== 'none' && onWeek(monday, s.recyclingWeek, s.recycling === 'alternate' ? 2 : 1);
    const yard = s.yard && s.yard !== 'none' && inSeason(dateOf(date).getMonth(), s.yardFrom ?? 3, s.yardTo ?? 10) && onWeek(monday, s.yardWeek, s.yard === 'alternate' ? 2 : 1);
    if (date >= from) out.push({ date, recycling, yard: !!yard, moved });
  }
  return out.slice(0, weeks);
}

/** A city calendar's events as pickups: [{date, text}] from today on, their own words. */
export function fromCalendar(events, from = dayKey()) {
  const byDay = new Map();
  for (const e of events) {
    const date = e.start.date || e.start.at?.slice(0, 10);
    if (!date || date < from) continue;
    byDay.set(date, [...(byDay.get(date) || []), e.title]);
  }
  return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, l]) => ({ date, text: [...new Set(l)].join(', ') }));
}

const cap = (t) => t.replace(/^./, (c) => c.toUpperCase());
/** What goes out, in words: "trash, recycling and yard waste" (or the city calendar's own words). */
export function what(p) {
  if (p.text) return p.text;
  const l = ['trash', ...(p.recycling ? ['recycling'] : []), ...(p.yard ? ['yard waste'] : [])];
  return l.length < 2 ? l[0] : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`;
}
export const What = (p) => cap(what(p));
