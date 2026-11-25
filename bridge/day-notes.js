// What the household's apps put on the calendar, two kinds, and the app says which:
//  - day notes: a fact about a day with no time (a school lunch, trash day, books due, whose turn it is): {date, label
//    ("Lunch"), short ("Popcorn Chicken"), text (the whole of it), who?}, one per app a day (per person). Quiet, not
//    events: one outlined card a day after its events in the Calendar's week and on Home, the full text in the day and list views.
//    Optional pics: [{text, image?}], up to 4 things a note is made of (the day's dishes), each with a photo from a host
//    the app reaches (put's imageOk): Today shows them as small photos beside their names.
//  - events: someone has to be somewhere, or the day changes shape (a game, a half day, no school): {date or start,
//    end?, allDay?, title, place?, who?}, shown exactly like the family's other events, read-only, "From <app>".
// Each app's set of each kind is replaced whole each time it sends one. Never synced to Google or iCloud; gone when the
// app is. Whether and where each app's show (Week and Home, Home only, Off) and their order are the household's
// settings (house.js), handed in with setPrefs.
//
// file: day-notes.json next to the chats: { byApp: { [app]: { name, at, items: [note], events: [event] } }, first: { [app]: ms } }
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';
import { dayKey } from './dates.js';
import { asData } from './as-data.js';

const DAY = 864e5, PER_APP = 120, EVENTS_PER_APP = 200;
const plain = (t, n) => String(t ?? '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Cut at a word, never in the middle of one. */
const words = (t, n) => { const s = plain(t, 400); if (s.length <= n) return s; const c = s.slice(0, n + 1).replace(/\s+\S*$/, ''); return c || s.slice(0, n); };
const DATE = /^\d{4}-\d{2}-\d{2}$/, WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, ZONED = /(Z|[+-]\d{2}:?\d{2})$/i;
const midnight = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

/** A note as an app sends it, in the new shape or the old one ({text}: "Lunch: Popcorn Chicken" or just the words). */
export function noteOf(x, appName) {
  let label = plain(x?.label, 24), text = plain(x?.text, 160), short = plain(x?.short, 60);
  if (!label) {
    const m = text.match(/^([^:]{1,24}):\s*(.+)$/);
    if (m) { label = m[1].trim(); text = m[2].trim(); } else label = plain(appName, 24);
  } else if (text.toLowerCase().startsWith(label.toLowerCase() + ':')) text = text.slice(label.length + 1).trim();
  if (!text) text = short;
  if (!text) return null;
  return { label: label || 'Note', short: words(short || text, 32), text };
}
/** A note's pics: [{text, image?}] (up to 4), an image only when https and imageOk(url) says the app may show it. */
export function picsOf(x, imageOk = () => false) {
  if (!Array.isArray(x?.pics)) return null;
  const out = x.pics.slice(0, 4).map((p) => {
    const text = plain(p?.text, 48); if (!text) return null;
    let image = null;
    try { const u = new URL(String(p?.image || '')); if (u.protocol === 'https:' && !u.username && !u.password && u.href.length <= 400 && imageOk(u)) image = u.href; } catch {}
    return { text, ...(image ? { image } : {}) };
  }).filter(Boolean);
  return out.length ? out : null;
}

export function dayNotes({ DIR, now = () => Date.now(), onChange = () => {} }) {
  const FILE = registered('day-notes', path.join(DIR, '../day-notes.json'));
  let st = { byApp: {}, first: {} }, alive = () => true; // alive(app): is it still there (one taken off leaves nothing)
  let prefs = { show: () => 'today', order: () => [] }; // the household's (house.js)
  st = { byApp: {}, first: {}, ...readJson(FILE, {}) };
  for (const s of Object.values(st.byApp)) s.items = (s.items || []).map((x) => (x.label ? x : x.date && { date: x.date, ...noteOf(x, s.name), ...(x.who ? { who: x.who } : {}) })).filter((x) => x && x.text); // kept before notes had a label
  // A save that's refused or fails takes the change back in memory too, and throws (marked unsaved: store.js unsaved
  // says what to answer), so the app is told and what shows is what's on disk.
  const save = (before) => {
    try { writeJson(FILE, st); }
    catch (e) { st = before; console.error('[day-notes]', e.message); throw Object.assign(e, { unsaved: true }); }
    onChange();
  };
  const range = () => { const t = now(); return { from: dayKey(new Date(t - 14 * DAY)), to: dayKey(new Date(t + 92 * DAY)) }; };
  const entry = (app, name) => {
    st.first[app] ||= now();
    return (st.byApp[app] ||= { name: plain(name, 40) || app, at: now(), items: [], events: [] });
  };
  const tidy = (app) => { const s = st.byApp[app]; if (s && !s.items?.length && !s.events?.length) delete st.byApp[app]; };

  /** An app's whole set of day notes, replacing the one before ([] takes them all off). Days from two weeks back to three months on. */
  function put(app, name, items, { imageOk = () => false } = {}) {
    const { from, to } = range(), seen = new Set();
    const list = (Array.isArray(items) ? items : []).map((x) => {
      const date = String(x?.date || '').slice(0, 10), n = noteOf(x, name), who = plain(x?.who, 40) || null;
      if (!DATE.test(date) || date < from || date > to || !n) return null;
      const k = `${date}|${(who || '').toLowerCase()}`; if (seen.has(k)) return null; seen.add(k); // one a day (each person's)
      const pics = picsOf(x, imageOk);
      return { date, ...n, ...(who ? { who } : {}), ...(pics ? { pics } : {}) };
    }).filter(Boolean).slice(0, PER_APP);
    const before = structuredClone(st);
    const s = entry(app, name); s.items = list; s.name = plain(name, 40) || app; s.at = now(); tidy(app);
    save(before);
    return list.length;
  }
  /** An app's whole set of events, replacing the one before. {date or start, end?, allDay?, title, place?, who?}. */
  function putEvents(app, name, items) {
    const { from, to } = range();
    const list = (Array.isArray(items) ? items : []).map((x) => {
      const title = plain(x?.title, 120); if (!title) return null;
      const s = String(x?.start || x?.date || ''), e = String(x?.end || '');
      const allDay = !!x?.allDay || DATE.test(s);
      let start, end;
      if (allDay) {
        const a = s.slice(0, 10); if (!DATE.test(a)) return null;
        const b = DATE.test(e.slice(0, 10)) && e.slice(0, 10) >= a ? e.slice(0, 10) : a; // the last day it's on
        if (b < from || a > to) return null;
        const last = midnight(b); last.setDate(last.getDate() + 1);
        start = midnight(a).toISOString(); end = last.toISOString();
        return { title, start, end, allDay: true, date: a, ...extra(x) };
      }
      if (!WHEN.test(s)) return null;
      // The household's clock ("2026-11-22T13:00"); one with its zone ("…T18:00:00.000Z", toISOString's) keeps it, not
      // read as 6 PM.
      const at = (x) => new Date(ZONED.test(x) ? x : x.slice(0, 16));
      const t0 = at(s), t1 = WHEN.test(e) ? at(e) : null;
      if (isNaN(t0) || dayKey(t0) < from || dayKey(t0) > to) return null;
      start = t0.toISOString(); end = new Date(t1 && t1 > t0 ? t1 : +t0 + 3600e3).toISOString();
      return { title, start, end, allDay: false, ...extra(x) };
    }).filter(Boolean).slice(0, EVENTS_PER_APP);
    const before = structuredClone(st);
    const s = entry(app, name); s.events = list; s.name = plain(name, 40) || app; s.at = now(); tidy(app);
    save(before);
    return list.length;
  }
  const extra = (x) => { const place = plain(x?.place, 120), who = plain(x?.who, 40); return { ...(place ? { place } : {}), ...(who ? { who } : {}) }; };
  const drop = (app) => { if (st.byApp[app]) { const before = structuredClone(st); delete st.byApp[app]; save(before); } };

  /** The apps that put anything on the calendar, in the household's order (else by when each first did), with how each shows. */
  function apps() {
    const order = prefs.order() || [], at = (a) => { const i = order.indexOf(a); return i < 0 ? Infinity : i; };
    return Object.entries(st.byApp).filter(([app]) => alive(app))
      .map(([app, s]) => ({ app, name: s.name, show: prefs.show(app), notes: !!s.items?.length, events: !!s.events?.length, first: st.first[app] || s.at || 0 }))
      .sort((a, b) => at(a.app) - at(b.app) || a.first - b.first || a.app.localeCompare(b.app));
  }
  /** Every app's notes by day, in order, not the ones turned off: { 'YYYY-MM-DD': [{app, name, show, label, short, text, who?}] }. */
  function byDay({ all = false } = {}) {
    const from = range().from, out = {};
    for (const a of apps()) if (all || a.show !== 'off') for (const x of st.byApp[a.app].items || []) if (x.date >= from) (out[x.date] ||= []).push({ app: a.app, name: a.name, show: a.show, ...x });
    return out;
  }
  /** The apps' events, as the house's events are (not the ones turned off): read-only, fromApp and appName on each. */
  function events() {
    const out = [];
    for (const a of apps()) if (a.show !== 'off') (st.byApp[a.app].events || []).forEach((e, i) => out.push({ id: `app:${a.app}:${i}`, ...e, fromApp: a.app, appName: a.name }));
    return out;
  }
  /** For Opie: the next few days' notes, a line each. */
  function describe(days = 7) {
    const b = byDay(), out = [];
    for (let i = 0; i < days; i++) { const k = dayKey(new Date(now() + i * DAY)); for (const x of b[k] || []) out.push(`${k}: ${x.label}: ${x.text}${x.who ? ` (${x.who})` : ''} [from ${x.name}]`); }
    return out.length ? asData(out.join('\n'), "the household's apps' notes on the calendar's days, a line each, in the apps' own words") : '';
  }
  return { put, putEvents, drop, apps, byDay, events, describe, setAlive: (f) => { alive = f; }, setPrefs: (p) => { prefs = { ...prefs, ...p }; } };
}
