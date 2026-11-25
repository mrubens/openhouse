// The family's calendars: each person can add a private calendar link (the "secret address in
// iCal format" Google Calendar, iCloud and Outlook all offer). The link itself is the permission, so the
// bridge never has it: the shell keeps the links (CalendarLinks.kt, out of the agent's reach), reads them
// every 15 minutes and posts what they say here. This keeps the next two weeks of events and whose they are.
//
//   calendars({ DIR, onChange }) -> { events(), labels(), status(), setFeeds(feeds) }
//     feeds: [{ id, who, name?, only?, ics?, error? }]   (from the shell: POST /calendar/feeds)
//     only: which of a calendar's events to keep, in the words they used ("home games"): each event is judged once by
//     the cloud's decision model (useCalendarDecide), never by matching words; until judged an event isn't shown.
//   events: [{ who, title, start (ISO), end?, allDay, place?, notes?, uid? }]
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';

const DAY = 86400e3;
const str = (v, n) => String(v ?? '').trim().slice(0, n);
let decideFn = null;
/** The judge for calendars kept only in part: (input, questions) -> {answers} (the cloud's /v1/decide). */
export function useCalendarDecide(f) { decideFn = f; }

export function calendars({ DIR, onChange = () => {} }) {
  const CACHE = registered('calendar', path.join(DIR, '../calendar.json'));
  const empty = { events: [], at: 0, errors: {}, labels: [] };
  let cache = { ...empty, ...readJson(CACHE, {}, { bak: false }) }; // (read again from the calendars: no .bak)
  // Errors from before the links moved to the shell were keyed by the start of the link.
  if (Object.keys(cache.errors || {}).some((k) => /^(https?|webcals?):/i.test(k))) cache.errors = {};
  // Verdicts for calendars kept only in part: { [only]: { [title + place]: true | false } }.
  const ONLY = registered('calendar-only', path.join(DIR, '../calendar-only.json'));
  let verdicts = readJson(ONLY, {}, { bak: false }) || {};
  let lastFeeds = null, judging = false;
  const keyOf = (e) => `${e.title || ''}\u0000${e.place || ''}`;
  async function judge(pending) {
    if (judging || !decideFn) return;
    judging = true;
    try {
      for (const [only, list] of pending) {
        for (let i = 0; i < list.length; i += 100) {
          const part = list.slice(i, i + 100);
          const input = `A household added a calendar to their home display and wants to see only some of its events: "${only}". Each question is about one event from that calendar.`;
          const qs = part.map((e, j) => ({ type: 'predicate', name: `e${j}`, instructions: `Is this event one they want to see? "${e.title}"${e.place ? `, at ${e.place}` : ''}` }));
          const { answers } = await decideFn(input, qs);
          const v = (verdicts[only] ||= {});
          part.forEach((e, j) => { const p = (answers || []).find((a) => a.name === `e${j}`)?.probability; if (typeof p === 'number') v[keyOf(e)] = p >= 0.5; });
        }
      }
      try { writeJson(ONLY, verdicts, { bak: false }); } catch {}
    } catch (e) { console.log(`[calendar] couldn't judge which events to keep (${e?.message || e})`); judging = false; return; }
    judging = false;
    if (lastFeeds) setFeeds(lastFeeds);
  }

  function setFeeds(feeds) {
    const from = Date.now() - 35 * DAY, to = Date.now() + 70 * DAY; // the Calendar app shows a month either way
    const events = [], errors = {}, labels = [];
    lastFeeds = feeds;
    const pending = new Map(); // only -> [events not judged yet]
    for (const f of Array.isArray(feeds) ? feeds.slice(0, 12) : []) {
      const who = str(f.who, 40) || null, name = str(f.name, 60) || null, only = str(f.only, 200);
      const label = name || (who ? `${who}'s calendar` : 'A calendar'), tone = /^#[0-9a-f]{6}$/i.test(f.tone || '') ? f.tone.toLowerCase() : null;
      labels.push({ id: str(f.id, 40), who, label, ...(name ? { name } : {}), ...(only ? { only } : {}) });
      try {
        if (f.error) throw new Error(str(f.error, 120));
        const text = String(f.ics || '');
        if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('not a calendar (iCal) link');
        for (const e of parse(text, from, to)) {
          if (only) {
            const v = verdicts[only]?.[keyOf(e)];
            if (v === undefined) { const l = pending.get(only) || []; if (l.length < 400 && !l.some((x) => keyOf(x) === keyOf(e))) l.push(e); pending.set(only, l); }
            if (v !== true) continue;
          }
          events.push({ who, ...(name ? { calendarName: name } : {}), ...(tone ? { color: tone } : {}), ...e }); // (its color: Settings, Calendars)
        }
      } catch (e) { errors[label] = e.message; }
    }
    if (pending.size) judge(pending);
    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    const was = JSON.stringify([cache.events, cache.labels, cache.errors]);
    cache = { events, at: Date.now(), errors, labels };
    try { writeJson(CACHE, cache, { bak: false }); } catch {}
    console.log(`[calendar] ${events.length} events from ${labels.length} calendar(s)${Object.keys(errors).length ? `; ${Object.keys(errors).length} couldn't be read` : ''}`);
    // (a read that brought nothing new doesn't make every screen fetch the house again)
    if (JSON.stringify([events, labels, errors]) !== was) try { onChange(); } catch (e) { console.error('[calendar]', e.message); }
    return status();
  }
  const status = () => ({ at: cache.at, count: cache.events.length, errors: cache.errors });

  return {
    // Everything read at the last sync (35 days back to 70 ahead): past days in the Calendar app show what happened.
    events: () => cache.events.slice(),
    labels: () => cache.labels.map((l) => ({ ...l })),
    status,
    setFeeds,
  };
}

// --- iCal parsing: enough for real Google/iCloud/Outlook calendars --------------------------------

/** Events in [from, to], recurring ones expanded. */
export function parse(text, from, to) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const vevents = [];
  let cur = null, inner = 0; // inner: inside an alarm (its DESCRIPTION isn't the event's)
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { cur = {}; inner = 0; }
    else if (l === 'END:VEVENT') { if (cur) vevents.push(cur); cur = null; }
    else if (cur && /^BEGIN:/i.test(l)) inner++;
    else if (cur && /^END:/i.test(l)) inner = Math.max(0, inner - 1);
    else if (cur && !inner) {
      const i = l.indexOf(':'); if (i < 0) continue;
      const [name, ...params] = l.slice(0, i).split(';');
      const p = Object.fromEntries(params.map((x) => x.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
      const key = name.toUpperCase(), value = l.slice(i + 1);
      if (key === 'EXDATE') (cur.EXDATE ||= []).push(...value.split(',').map((v) => ({ value: v, p })));
      else cur[key] = { value, p };
    }
  }
  const unescape = (s) => String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
  // Moved or edited single occurrences of a recurring event replace that occurrence.
  const moved = new Set(vevents.filter((v) => v['RECURRENCE-ID']).map((v) => `${v.UID?.value}|${when(v['RECURRENCE-ID']).t}`));
  const out = [];
  for (const v of vevents) {
    if (!v.DTSTART || v.STATUS?.value === 'CANCELLED') continue;
    const s = when(v.DTSTART);
    const dur = v.DTEND ? when(v.DTEND).t - s.t : v.DURATION ? duration(v.DURATION.value) : s.allDay ? DAY : 0;
    const ex = new Set((v.EXDATE || []).map((x) => when(x).t));
    const starts = v.RRULE && !v['RECURRENCE-ID'] ? expand(s, v.RRULE.value, from - dur, to) : [s.t];
    // An all-day one ends a number of days later, at that midnight (a day with a DST change isn't 24 hours).
    const days = s.allDay ? Math.max(1, Math.round(dur / DAY)) : 0;
    const endOf = (t) => { if (!days) return t + dur; const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime(); };
    for (const t of starts) {
      if (ex.has(t) || (v.RRULE && moved.has(`${v.UID?.value}|${t}`))) continue;
      const end = endOf(t);
      if (end < from || t > to) continue;
      out.push({
        title: unescape(v.SUMMARY?.value) || 'Busy', start: new Date(t).toISOString(),
        ...(end > t ? { end: new Date(end).toISOString() } : {}), allDay: s.allDay,
        ...(v.LOCATION?.value ? { place: unescape(v.LOCATION.value).slice(0, 80) } : {}),
        ...(v.DESCRIPTION?.value ? { notes: unescape(v.DESCRIPTION.value).slice(0, 400) } : {}),
        // Which event this is, the same at every sync (a countdown on it, say): its UID and, for a repeat, the day.
        ...(v.UID?.value ? { uid: `${String(v.UID.value).slice(0, 120)}${v.RRULE || v['RECURRENCE-ID'] ? '|' + new Date(t).toISOString().slice(0, 10) : ''}` } : {}),
      });
    }
  }
  return out;
}

/** A DTSTART-like value → { t (ms), allDay, wall: [y, m, d, h, mi, s], tz } */
function when({ value, p }) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return { t: NaN, allDay: false };
  const wall = [+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
  const allDay = p?.VALUE === 'DATE' || !m[4];
  const tz = m[7] ? 'UTC' : allDay ? null : (p?.TZID || null);
  return { t: toTime(wall, tz), allDay, wall, tz };
}

/** Wall-clock time in a zone (null: this device's zone) → ms. */
function toTime([y, mo, d, h, mi, s], tz) {
  if (!tz) return new Date(y, mo, d, h, mi, s).getTime();
  const guess = Date.UTC(y, mo, d, h, mi, s);
  if (tz === 'UTC') return guess;
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const off = (t) => { const q = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, +x.value])); return Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - t; };
    const t = guess - off(guess);
    return guess - off(t); // twice, for times near a DST change
  } catch { return new Date(y, mo, d, h, mi, s).getTime(); }
}

function duration(v) {
  const m = String(v).match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!m) return 0;
  return (+(m[1] || 0) * 7 + +(m[2] || 0)) * DAY + (+(m[3] || 0) * 3600 + +(m[4] || 0) * 60 + +(m[5] || 0)) * 1000;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Occurrence start times of a recurring event between `from` and `to` (DAILY, WEEKLY, MONTHLY, YEARLY; BYDAY,
 *  BYMONTHDAY, BYSETPOS, INTERVAL, COUNT, UNTIL). Dates that don't exist (the 31st of a short month, Feb 29th in other
 *  years) are skipped, as the standard says, never rolled into the next month. */
function expand(s, rule, from, to) {
  const r = Object.fromEntries(rule.split(';').map((x) => x.split('=')));
  const freq = r.FREQ, every = Math.max(1, +(r.INTERVAL || 1)), count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? when({ value: r.UNTIL, p: {} }).t : Infinity;
  const [y, mo, d, h, mi, sec] = s.wall;
  const at = (Y, M, D) => toTime([Y, M, D, h, mi, sec], s.tz);
  const real = (Y, M, D) => { const x = new Date(Y, M, D); return x.getMonth() === ((M % 12) + 12) % 12 && x.getDate() === D; };
  const out = []; let n = 0;
  const push = (t) => { if (t < s.t) return true; n++; if (n > count || t > until) return false; if (t >= from) out.push(t); return t <= to; };
  const byday = (r.BYDAY || '').split(',').filter(Boolean).map((b) => ({ nth: parseInt(b, 10) || 0, wd: DAYS.indexOf(b.slice(-2)) })).filter((b) => b.wd >= 0);
  const bymonthday = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number).filter((x) => x && Math.abs(x) <= 31);
  const setpos = (r.BYSETPOS || '').split(',').filter(Boolean).map(Number).filter(Boolean);
  // With no COUNT, start near `from` instead of at the first occurrence (an event repeating daily for years).
  const per = freq === 'DAILY' ? DAY * every : freq === 'WEEKLY' ? 7 * DAY * every : 0;
  const k0 = count === Infinity && per ? Math.max(0, Math.floor((from - s.t) / per) - 1) : 0;
  /** The days of month M (0-based, may run past 11) that this rule picks, in order. */
  function monthDays(Y, M) {
    const last = new Date(Y, M + 1, 0).getDate();
    let days = [];
    if (bymonthday.length) days = bymonthday.map((x) => (x > 0 ? x : last + 1 + x)).filter((x) => x >= 1 && x <= last);
    else if (byday.length) {
      for (const b of byday) {
        const all = []; for (let D = 1; D <= last; D++) if (new Date(Y, M, D).getDay() === b.wd) all.push(D);
        if (!b.nth) days.push(...all); // every Tuesday of the month
        else { const pick = b.nth > 0 ? all[b.nth - 1] : all[all.length + b.nth]; if (pick) days.push(pick); } // 2TU, -1FR
      }
    } else if (real(Y, M, d)) days = [d];
    days = [...new Set(days)].sort((a, b) => a - b);
    if (setpos.length) days = setpos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter(Boolean).sort((a, b) => a - b);
    return days;
  }
  for (let k = k0; k < k0 + 2000; k++) {
    if (freq === 'DAILY') { if (!push(at(y, mo, d + k * every))) break; }
    else if (freq === 'WEEKLY') {
      const base = new Date(y, mo, d + k * 7 * every); base.setDate(base.getDate() - base.getDay()); // that week's Sunday
      const days = byday.length ? byday.map((b) => b.wd) : [new Date(y, mo, d).getDay()];
      let go = true;
      for (const wd of [...new Set(days)].sort()) { const x = new Date(base); x.setDate(x.getDate() + wd); if (!push(at(x.getFullYear(), x.getMonth(), x.getDate()))) { go = false; break; } }
      if (!go) break;
    } else if (freq === 'MONTHLY') {
      const M = mo + k * every;
      let go = true;
      for (const D of monthDays(y, M)) if (!push(at(y, M, D))) { go = false; break; }
      if (!go) break;
    } else if (freq === 'YEARLY') {
      const Y = y + k * every;
      if (r.BYMONTH || byday.length || bymonthday.length) { // e.g. Thanksgiving: BYMONTH=11;BYDAY=4TH
        const months = r.BYMONTH ? r.BYMONTH.split(',').map((x) => +x - 1) : [mo];
        let go = true;
        for (const M of months) for (const D of (byday.length || bymonthday.length ? monthDays(Y, M) : (real(Y, M, d) ? [d] : []))) if (!push(at(Y, M, D))) { go = false; break; }
        if (!go) break;
      } else if (real(Y, mo, d) && !push(at(Y, mo, d))) break; // Feb 29th only in leap years
    }
    else break;
  }
  return out;
}
