// Repeating follow-ups (later.js): when they repeat is an iCal repeat rule (RFC 5545 RRULE), which the model writes
// from what they said: "Mondays, Wednesdays and Fridays at 7:30" is FREQ=WEEKLY;BYDAY=MO,WE,FR, "every 2 hours from 8 to
// 6" is FREQ=HOURLY;INTERVAL=2;BYHOUR=8,10,12,14,16,18, "the last Friday of the month" FREQ=MONTHLY;BYDAY=-1FR, "until
// school's out" UNTIL=20270604. Here: reading one, the next time it comes (in the tablet's local time), and what it is in
// plain words, said back so they can hear it's right.
//
// Supported: FREQ (HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY (with a number in a month or year: 2TU,
// -1FR), BYMONTHDAY, BYMONTH, BYHOUR, BYMINUTE, COUNT, UNTIL. Weeks start on Monday (the standard's default).

const DAY = 864e5;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WD_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FREQS = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const nums = (v, lo, hi) => String(v || '').split(',').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= hi && (n >= lo || n < 0));

/** A rule from its text: {freq, interval, byday: [{nth, wd}], bymonthday, bymonth, byhour, byminute, count, until, text}
 *  or {error}. */
export function parseRule(s) {
  const raw = String(s || '').trim().replace(/^RRULE:/i, '').toUpperCase();
  if (!raw) return { error: 'No rule.' };
  const r = Object.fromEntries(raw.split(';').filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  if (!FREQS.includes(r.FREQ)) return { error: `FREQ must be one of ${FREQS.join(', ')}.` };
  const byday = String(r.BYDAY || '').split(',').filter(Boolean).map((b) => {
    const m = b.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { nth: m[1] ? parseInt(m[1], 10) : 0, wd: WD.indexOf(m[2]) } : null;
  });
  if (byday.includes(null)) return { error: 'BYDAY: days like MO,WE,FR, or 2TU, -1FR in a month.' };
  let until = null;
  if (r.UNTIL) {
    const m = r.UNTIL.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
    if (!m) return { error: 'UNTIL: a date like 20270604.' };
    until = m[4] ? +new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : +new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59);
  }
  const rule = {
    freq: r.FREQ, interval: Math.max(1, Math.min(999, parseInt(r.INTERVAL || '1', 10) || 1)), byday,
    bymonthday: nums(r.BYMONTHDAY, 1, 31), bymonth: nums(r.BYMONTH, 1, 12).filter((n) => n > 0),
    byhour: String(r.BYHOUR || '').split(',').filter((x) => x !== '').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23),
    byminute: String(r.BYMINUTE || '').split(',').filter((x) => x !== '').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 59),
    count: r.COUNT ? Math.max(1, parseInt(r.COUNT, 10) || 1) : null, until,
  };
  rule.text = toText(rule);
  return rule;
}
/** The rule back as RRULE text (what's kept). */
export function toText(r) {
  const p = [`FREQ=${r.freq}`];
  if (r.interval > 1) p.push(`INTERVAL=${r.interval}`);
  if (r.byday.length) p.push(`BYDAY=${r.byday.map((b) => (b.nth ? b.nth : '') + WD[b.wd]).join(',')}`);
  if (r.bymonthday.length) p.push(`BYMONTHDAY=${r.bymonthday.join(',')}`);
  if (r.bymonth.length) p.push(`BYMONTH=${r.bymonth.join(',')}`);
  if (r.byhour.length) p.push(`BYHOUR=${r.byhour.join(',')}`);
  if (r.byminute.length) p.push(`BYMINUTE=${r.byminute.join(',')}`);
  if (r.count) p.push(`COUNT=${r.count}`);
  if (r.until) { const d = new Date(r.until), z = (n) => String(n).padStart(2, '0'); p.push(`UNTIL=${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`); }
  return p.join(';');
}

const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return +d; };
const daysBetween = (a, b) => Math.round((midnight(b) - midnight(a)) / DAY);
const monday = (t) => { const d = new Date(midnight(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return +d; };
const monthsBetween = (a, b) => { const x = new Date(a), y = new Date(b); return (y.getFullYear() - x.getFullYear()) * 12 + y.getMonth() - x.getMonth(); };
/** The nth weekday of a month: 2TU is the second Tuesday, -1FR the last Friday. */
function nthOf(d, b) {
  const day = d.getDate(), last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (d.getDay() !== b.wd) return false;
  if (!b.nth) return true;
  return b.nth > 0 ? Math.ceil(day / 7) === b.nth : Math.ceil((last - day + 1) / 7) === -b.nth;
}
const monthDayOk = (d, list) => { const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); return list.some((n) => (n > 0 ? n : last + 1 + n) === d.getDate()); };

/** Is this day one the rule comes on (start: its first time)? */
function dayOk(r, start, t) {
  const d = new Date(t), s = new Date(start);
  if (r.bymonth.length && !r.bymonth.includes(d.getMonth() + 1)) return false;
  switch (r.freq) {
    case 'HOURLY':
      return (!r.byday.length || r.byday.some((b) => b.wd === d.getDay())) && (!r.bymonthday.length || monthDayOk(d, r.bymonthday));
    case 'DAILY':
      return daysBetween(start, t) % r.interval === 0 && (!r.byday.length || r.byday.some((b) => b.wd === d.getDay())) && (!r.bymonthday.length || monthDayOk(d, r.bymonthday));
    case 'WEEKLY':
      return Math.round((monday(t) - monday(start)) / (7 * DAY)) % r.interval === 0 && (r.byday.length ? r.byday.some((b) => b.wd === d.getDay()) : d.getDay() === s.getDay());
    case 'MONTHLY':
      if (monthsBetween(start, t) % r.interval) return false;
      return r.bymonthday.length ? monthDayOk(d, r.bymonthday) : r.byday.length ? r.byday.some((b) => nthOf(d, b)) : d.getDate() === s.getDate();
    case 'YEARLY':
      if ((d.getFullYear() - s.getFullYear()) % r.interval) return false;
      if (!r.bymonth.length && d.getMonth() !== s.getMonth()) return false;
      return r.bymonthday.length ? monthDayOk(d, r.bymonthday) : r.byday.length ? r.byday.some((b) => nthOf(d, b)) : d.getDate() === s.getDate();
  }
  return false;
}
/** The times on such a day, ms, in order. */
function timesOn(r, start, day) {
  const s = new Date(start), mins = r.byminute.length ? r.byminute : [s.getMinutes()];
  let hours = r.byhour.length ? r.byhour : [s.getHours()];
  if (r.freq === 'HOURLY') {
    const all = []; for (let h = 0; h < 24; h++) all.push(h);
    // Hours by the clock since its first time (not elapsed: after a DST change "every 2 hours from 8" stays 8, 10, 12).
    const base = daysBetween(start, day) * 24 - s.getHours();
    hours = all.filter((h) => (!r.byhour.length || r.byhour.includes(h)) && (base + h) % r.interval === 0);
  }
  const out = [];
  for (const h of [...hours].sort((a, b) => a - b)) for (const m of [...mins].sort((a, b) => a - b)) { const d = new Date(day); d.setHours(h, m, 0, 0); out.push(+d); }
  return out;
}
/** The first time the rule comes after `after` (start: its first time; fired: how many times it has come), or null when
 *  it's over (UNTIL passed, COUNT reached, or nothing within about two years). */
export function nextAfter(r, start, after, fired = 0) {
  if (r.count && fired >= r.count) return null;
  for (let i = 0, day = midnight(Math.max(after, start)); i < 800; i++, day = midnight(day + DAY + 3 * 36e5)) {
    if (r.until && day > r.until) return null;
    if (!dayOk(r, start, day)) continue;
    for (const t of timesOn(r, start, day)) if (t > after && t >= start) return r.until && t > r.until ? null : t;
  }
  return null;
}

const ORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last', '-2': 'second to last' };
const nth = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const clock = (h, m) => new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: m ? '2-digit' : undefined });
const every = (n, one, many) => (n === 1 ? `every ${one}` : n === 2 ? `every other ${one}` : `every ${n} ${many}`);
/** The rule in plain words, with its times: "Mondays, Wednesdays and Fridays at 7:30 AM", "every 2 hours from 8 AM to 6 PM". */
export function ruleWords(r, start) {
  const s = new Date(start);
  const daysOf = (bs) => {
    const w = [...new Set(bs.map((b) => b.wd))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (w.join() === '1,2,3,4,5') return 'weekdays';
    if (w.length === 2 && w.includes(0) && w.includes(6)) return 'weekends';
    if (w.length === 7) return 'every day';
    return list(w.map((x) => WD_NAME[x] + 's'));
  };
  const inMonth = () => r.bymonthday.length ? `the ${list(r.bymonthday.map((n) => (n > 0 ? nth(n) : n === -1 ? 'last day' : `${nth(-n)} to last day`)))}`
    : r.byday.length ? `the ${list(r.byday.map((b) => `${ORD[b.nth] || nth(Math.abs(b.nth))} ${WD_NAME[b.wd]}`))}` : `the ${nth(s.getDate())}`;
  let what;
  switch (r.freq) {
    case 'HOURLY': {
      what = every(r.interval, 'hour', 'hours');
      if (r.byhour.length > 1) { const hs = [...r.byhour].sort((a, b) => a - b); what += ` from ${clock(hs[0], s.getMinutes())} to ${clock(hs.at(-1), s.getMinutes())}`; }
      if (r.byday.length) what += ` on ${daysOf(r.byday)}`;
      break;
    }
    case 'DAILY': what = r.byday.length ? `on ${daysOf(r.byday)}` : every(r.interval, 'day', 'days'); break;
    case 'WEEKLY': {
      const days = r.byday.length ? daysOf(r.byday) : WD_NAME[s.getDay()] + 's';
      what = r.interval === 1 ? days : `${every(r.interval, 'week', 'weeks')} on ${days.replace(/s\b/g, '').replace('weekday', 'weekdays').replace('weekend', 'weekends')}`;
      break;
    }
    case 'MONTHLY': what = `${inMonth()} of ${r.interval === 1 ? 'every month' : every(r.interval, 'month', 'months')}`; break;
    case 'YEARLY': {
      const months = r.bymonth.length ? list(r.bymonth.map((m) => MONTHS[m - 1])) : MONTHS[s.getMonth()];
      what = r.byday.length || r.bymonthday.length ? `${inMonth()} of ${months}, ${every(r.interval, 'year', 'years')}` : `${months} ${nth(s.getDate())}, ${every(r.interval, 'year', 'years')}`;
      break;
    }
  }
  if (r.freq !== 'HOURLY') {
    const hs = r.byhour.length ? r.byhour : [s.getHours()], ms = r.byminute.length ? r.byminute : [s.getMinutes()];
    what += ` at ${list(hs.flatMap((h) => ms.map((m) => clock(h, m))))}`;
  }
  if (r.until) what += `, until ${new Date(r.until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: new Date(r.until).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })}`;
  if (r.count) what += `, ${r.count} time${r.count === 1 ? '' : 's'}`;
  return what[0].toUpperCase() + what.slice(1);
}

/** What the older follow-ups kept (repeat: daily, weekdays, weekends, weekly), as a rule. */
export function fromOld(repeat, dow) {
  return { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekends: 'FREQ=WEEKLY;BYDAY=SA,SU', weekly: `FREQ=WEEKLY;BYDAY=${WD[dow ?? 1]}` }[repeat] || null;
}
