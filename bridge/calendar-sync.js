// Two-way calendars (docs/calendar-sync.md): the household's Google and iCloud (CalDAV) calendars, read and written.
// The sign-ins are the shell's (CalendarAccounts.kt, sealed, never here): every request to Google or iCloud goes
// through it (DeviceServer /calendar/request), which adds the authorization and only reaches that provider. What's
// here: which calendars are shown and written to, what they say (35 days back, 70 ahead, read every two minutes and
// after a change), and an outbox of changes made on the tablet, saved before anything is sent.
//
//   calendarSync({ FILE, shell, family?, now? }) -> { events(), calendars(), targets(), status(),
//     accounts(), discover(account), setCalendar(key, {mode?, who?, default?}), forget(account),
//     add(fields, calendar?), update(id, fields), remove(id, date?), pull(), flush() }
//   shell(path, body) -> the shell's answer ({ error } when it couldn't)
//
// A new event's id is made here before it's sent (Google: the event id; CalDAV: the UID and the file name), so a
// retry after a lost answer finds it already there instead of adding it twice. A change to an event that was changed
// elsewhere first (If-Match fails) is dropped: theirs stays, and the event says so (note).
// Event ids here: "c-<calendar key>-<remote id>"; a repeating one's times share it, each with its own date.
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import crypto from 'node:crypto';
import { parse } from './calendar.js';

const DAY = 86400e3;
const MIN = 60e3;
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const RRULES = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' };

/** A new event's id, made here: base32hex (Google allows a-v and 0-9), long enough never to meet another. */
export const newId = () => 'oh' + [...crypto.randomBytes(16)].map((b) => '0123456789abcdefghijklmnopqrstuv'[b & 31]).join('');

/** "repeat" (house.js's words) from an RRULE; "custom" for one it can't say (left as it is when changed here). */
export function repeatOf(rule) {
  const r = Object.fromEntries(String(rule || '').replace(/^RRULE:/i, '').split(';').filter(Boolean).map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), String(v || '').toUpperCase()]));
  if (!r.FREQ) return { repeat: null };
  const until = r.UNTIL ? `${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}` : null;
  const other = Object.keys(r).filter((k) => !['FREQ', 'INTERVAL', 'UNTIL', 'BYDAY', 'WKST'].includes(k));
  const n = Number(r.INTERVAL || 1);
  let repeat = 'custom';
  if (!other.length) {
    if (r.FREQ === 'DAILY' && n === 1 && !r.BYDAY) repeat = 'daily';
    else if (r.FREQ === 'WEEKLY' && n === 1 && r.BYDAY === 'MO,TU,WE,TH,FR') repeat = 'weekdays';
    else if (r.FREQ === 'WEEKLY' && n === 1 && (!r.BYDAY || !r.BYDAY.includes(','))) repeat = 'weekly';
    else if (r.FREQ === 'WEEKLY' && n === 2 && (!r.BYDAY || !r.BYDAY.includes(','))) repeat = 'biweekly';
    else if (r.FREQ === 'MONTHLY' && n === 1 && !r.BYDAY) repeat = 'monthly';
    else if (r.FREQ === 'YEARLY' && n === 1 && !r.BYDAY) repeat = 'yearly';
  }
  return { repeat, ...(until && repeat !== 'custom' ? { until } : {}) };
}
const ruleOf = (repeat, until) => `RRULE:${RRULES[repeat]}${until ? `;UNTIL=${until.replace(/-/g, '')}T235959Z` : ''}`;

export function calendarSync({ FILE, shell, family = () => [], now = Date.now, every = 2 * MIN, log = console.log }) {
  const blank = { calendars: {}, outbox: [], cache: {}, notes: {}, errors: {}, at: 0 };
  let st = { ...structuredClone(blank), ...readJson(FILE, {}) };
  // from the shell: [{ id, provider: 'google'|'caldav', name, who, server? }] (no secrets). The last list is kept (st.accounts),
  // so right after a restart the kept events show at once, not only once the shell has answered (Today's calendar was empty for seconds).
  let accounts = Array.isArray(st.accounts) ? st.accounts : [];
  let changed = () => {}, timer = null, pulling = null, flushing = null;
  let trail = []; // the methods and answers of the change being sent (no contents), for status()
  let read = null; // the last list's counts (no contents), kept per calendar in st.reads for Settings and debugging
  function save() {
    writeJson(FILE, st);
  }
  const window = () => { const t = now(); return { from: t - 35 * DAY, to: t + 70 * DAY }; };

  // ---- talking to Google and iCloud, through the shell -------------------------------------------------------
  async function req(account, method, url, { body, headers = {} } = {}) {
    for (let hop = 0; hop < 4; hop++) {
      const r = await shell('/calendar/request', { account, method, url, headers, body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body) });
      trail.push(`${method} ${r?.status || 'x'}`);
      if (r?.error && !r.status) throw Object.assign(new Error(str(r.error)), { offline: true });
      if (r.status >= 300 && r.status < 400 && r.headers?.location) { url = new URL(r.headers.location, url).toString(); continue; }
      return { status: r.status, etag: r.headers?.etag || null, text: r.body || '', json: () => { try { return JSON.parse(r.body || '{}'); } catch { return {}; } } };
    }
    throw new Error('too many redirects');
  }
  const acc = (id) => accounts.find((a) => a.id === id);
  const prov = (a) => (a?.provider === 'google' ? google : caldav);

  // ---- Google Calendar --------------------------------------------------------------------------------------
  const G = 'https://www.googleapis.com/calendar/v3';
  const gWhen = (iso, allDay) => (allDay ? { date: dayKey(new Date(iso)) } : { dateTime: new Date(iso).toISOString(), timeZone: zone() });
  const gBody = (f, id) => ({
    ...(id ? { id } : {}), summary: f.title, location: f.place || '', description: f.notes || '',
    start: gWhen(f.start, f.allDay), end: gWhen(f.end || f.start, f.allDay),
    ...(f.repeat && RRULES[f.repeat] ? { recurrence: [ruleOf(f.repeat, f.until)] } : f.repeat === null ? { recurrence: [] } : {}),
  });
  const gDate = (w, end) => (w?.date ? { t: new Date(w.date + 'T00:00:00').getTime(), allDay: true } : { t: Date.parse(w?.dateTime), allDay: false });
  const google = {
    async calendars(a) {
      const r = await req(a.id, 'GET', `${G}/users/me/calendarList?maxResults=250`);
      if (r.status !== 200) throw httpError(r);
      return (r.json().items || []).filter((c) => c.accessRole !== 'freeBusyReader').map((c) => ({
        remote: c.id, name: str(c.summaryOverride || c.summary, 60) || 'Calendar', color: c.backgroundColor || null,
        canWrite: c.accessRole === 'owner' || c.accessRole === 'writer', primary: !!c.primary }));
    },
    async list(a, c, { from, to }) {
      const base = `${G}/calendars/${encodeURIComponent(c.remote)}/events?timeMin=${new Date(from).toISOString()}&timeMax=${new Date(to).toISOString()}&maxResults=2500`;
      const all = async (q) => { const out = []; let page = ''; for (let i = 0; i < 8; i++) { const r = await req(a.id, 'GET', base + q + (page ? `&pageToken=${encodeURIComponent(page)}` : '')); if (r.status !== 200) throw httpError(r); const j = r.json(); out.push(...(j.items || [])); if (!(page = j.nextPageToken)) break; } return out; };
      const [masters, items] = [await all('&singleEvents=false'), await all('&singleEvents=true')];
      const series = new Map(masters.filter((m) => m.recurrence).map((m) => [m.id, m]));
      const events = {};
      for (const e of items) {
        if (e.status === 'cancelled' || !e.start) continue;
        const s = gDate(e.start), en = gDate(e.end);
        if (isNaN(s.t)) continue;
        const master = e.recurringEventId ? series.get(e.recurringEventId) : null;
        const sid = e.recurringEventId || e.id;
        const rule = master ? repeatOf((master.recurrence || []).find((x) => /^RRULE:/i.test(x))) : { repeat: null };
        const key = e.recurringEventId ? `${sid}|${dayKey(new Date(s.t))}` : sid;
        events[key] = {
          remote: sid, instance: e.id, etag: master?.etag || e.etag, ...(master ? { masterStart: master.start, masterEnd: master.end } : {}),
          ev: { title: str(e.summary, 80) || 'Busy', start: new Date(s.t).toISOString(), end: new Date(isNaN(en.t) ? s.t : en.t).toISOString(), allDay: s.allDay,
            ...(e.location ? { place: str(e.location, 80) } : {}), ...(e.description ? { notes: str(e.description.replace(/<[^>]+>/g, ' '), 400) } : {}),
            ...(rule.repeat ? rule : {}), ...(e.recurringEventId ? { date: dayKey(new Date(s.t)) } : {}) },
        };
      }
      return events;
    },
    async add(a, c, id, f) {
      const r = await req(a.id, 'POST', `${G}/calendars/${encodeURIComponent(c.remote)}/events`, { body: gBody(f, id), headers: { 'content-type': 'application/json' } });
      if (r.status === 409) return { ok: true, already: true }; // it went in the first time; the answer was lost
      if (r.status >= 300) throw httpError(r);
      return { ok: true, etag: r.json().etag };
    },
    async update(a, c, item, f) {
      const r = await req(a.id, 'PATCH', `${G}/calendars/${encodeURIComponent(c.remote)}/events/${encodeURIComponent(item.remote)}`, { body: gBody(seriesFields(item, f)), headers: { 'content-type': 'application/json', ...(item.etag ? { 'if-match': item.etag } : {}) } });
      if (r.status === 412) return { conflict: true };
      if (r.status === 404 || r.status === 410) return { gone: true };
      if (r.status >= 300) throw httpError(r);
      return { ok: true, etag: r.json().etag };
    },
    async remove(a, c, item, date) {
      const one = date && item.instance && item.instance !== item.remote;
      const r = await req(a.id, 'DELETE', `${G}/calendars/${encodeURIComponent(c.remote)}/events/${encodeURIComponent(one ? item.instance : item.remote)}`, { headers: !one && item.etag ? { 'if-match': item.etag } : {} });
      if (r.status === 412) return { conflict: true };
      if (r.status === 404 || r.status === 410) return { ok: true, already: true };
      if (r.status >= 300) throw httpError(r);
      return { ok: true };
    },
  };

  // ---- CalDAV (iCloud) --------------------------------------------------------------------------------------
  const tag = (name) => `(?:[\\w-]+:)?${name}`;
  const blocks = (xml, name) => [...String(xml).matchAll(new RegExp(`<${tag(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag(name)}>`, 'gi'))].map((m) => m[1]);
  const first = (xml, name) => blocks(xml, name)[0];
  const has = (xml, name) => new RegExp(`<${tag(name)}[\\s/>]`, 'i').test(String(xml || ''));
  const unxml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
  const href = (base, h) => new URL(unxml(h), base).toString();
  const okProps = (resp) => blocks(resp, 'propstat').filter((p) => /\s200\s/.test(first(p, 'status') || '')).map((p) => first(p, 'prop') || '').join('');
  const DAV = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
  const propfind = (a, url, depth, props) => req(a.id, 'PROPFIND', url, { body: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV} xmlns:x="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`, headers: { depth: String(depth), 'content-type': 'application/xml; charset=utf-8' } });
  const icsTime = (iso, allDay, tz) => {
    const d = new Date(iso);
    if (allDay) return { p: ';VALUE=DATE', v: dayKey(d).replace(/-/g, '') };
    if (tz) { // the household's wall clock, so a weekly 4 PM stays 4 PM across a time change
      const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
      return { p: `;TZID=${tz}`, v: `${q.year}${q.month}${q.day}T${q.hour}${q.minute}${q.second}` };
    }
    return { p: '', v: d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') };
  };
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const fold = (l) => { const out = []; let s = l; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); };
  /** The lines of one VEVENT's properties that this changes, for [f]. */
  function veventLines(f, uid, keepTz = null) {
    const tz = f.allDay ? null : keepTz || (f.repeat && RRULES[f.repeat] ? zone() : null); // an event's own zone stays its own
    const s = icsTime(f.start, f.allDay, tz), e = icsTime(f.end || f.start, f.allDay, tz);
    return [
      `UID:${uid}`, `DTSTAMP:${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`, `DTSTART${s.p}:${s.v}`, `DTEND${e.p}:${e.v}`, `SUMMARY:${esc(f.title)}`,
      ...(f.place ? [`LOCATION:${esc(f.place)}`] : []), ...(f.notes ? [`DESCRIPTION:${esc(f.notes)}`] : []),
      ...(f.repeat && RRULES[f.repeat] ? [ruleOf(f.repeat, f.until)] : []),
    ];
  }
  const vcal = (lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenHouse//Calendar//EN', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].map(fold).join('\r\n');
  /** An event's file changed in place: the master VEVENT's own properties swapped for [f]'s, the rest (alarms,
   *  attendees, moved times) kept. With [exdate]: only that time taken off a repeating one. */
  function patchIcs(raw, f, exdate) {
    const text = String(raw).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = text.split(/\r?\n/);
    const out = []; let inEv = false, isMaster = false, buf = [], depth = 0;
    for (const l of lines) {
      if (l === 'BEGIN:VEVENT') { inEv = true; buf = [l]; depth = 0; continue; }
      if (inEv) {
        if (/^BEGIN:/.test(l)) depth++;
        if (/^END:/.test(l) && l !== 'END:VEVENT') depth--;
        if (l === 'END:VEVENT') {
          isMaster = !buf.some((x) => /^RECURRENCE-ID/i.test(x));
          if (isMaster) {
            const uid = (buf.find((x) => /^UID:/i.test(x)) || '').slice(4);
            if (exdate) {
              const s = buf.find((x) => /^DTSTART/i.test(x)) || '', m = s.match(/^DTSTART([^:]*):(\d{8})(T\d{6}Z?)?/i);
              const v = m ? (m[3] ? exdate.replace(/-/g, '') + m[3] : exdate.replace(/-/g, '')) : exdate.replace(/-/g, '');
              buf.splice(buf.length, 0, `EXDATE${m ? m[1] : ';VALUE=DATE'}:${v}`);
            } else {
              const mine = new Set(['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'LOCATION', 'DESCRIPTION', ...(f.repeat === 'custom' ? [] : ['RRULE'])]);
              const tzid = (buf.find((x) => /^DTSTART;/i.test(x)) || '').match(/;TZID=([^;:]+)/i)?.[1] || null;
              buf = [buf[0], ...buf.slice(1).filter((x, i) => { const k = x.split(/[;:]/)[0].toUpperCase(); return !(mine.has(k) && depthAt(buf, i + 1) === 0); }), ...veventLines(f.repeat === 'custom' ? { ...f, repeat: null } : f, uid, tzid)];
            }
          }
          out.push(...buf, l); inEv = false; continue;
        }
        buf.push(l); continue;
      }
      out.push(l);
    }
    return out.filter((l, i, a) => l !== '' || i === a.length - 1).map(fold).join('\r\n');
  }
  function depthAt(buf, n) { let d = 0; for (let i = 1; i < n; i++) { if (/^BEGIN:/.test(buf[i])) d++; else if (/^END:/.test(buf[i])) d--; } return d; }
  const caldav = {
    async calendars(a) {
      const root = a.server || 'https://caldav.icloud.com/';
      let r = await propfind(a, root, 0, '<d:current-user-principal/>');
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('signin'), { signin: true });
      if (r.status !== 207) throw httpError(r);
      const principal = href(root, first(first(r.text, 'current-user-principal') || '', 'href') || '/');
      r = await propfind(a, principal, 0, '<c:calendar-home-set/>');
      if (r.status !== 207) throw httpError(r);
      const home = href(principal, first(first(r.text, 'calendar-home-set') || '', 'href') || '');
      r = await propfind(a, home, 1, '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/><x:calendar-color/>');
      if (r.status !== 207) throw httpError(r);
      return blocks(r.text, 'response').map((resp) => ({ url: href(home, first(resp, 'href')), p: okProps(resp) }))
        .filter(({ p }) => has(first(p, 'resourcetype') || '', 'calendar') && (!has(p, 'supported-calendar-component-set') || /VEVENT/i.test(first(p, 'supported-calendar-component-set') || '')))
        .map(({ url, p }) => ({ remote: url, name: str(unxml(first(p, 'displayname')), 60) || 'Calendar', color: (unxml(first(p, 'calendar-color')) || '').slice(0, 7) || null,
          canWrite: !has(p, 'current-user-privilege-set') || has(first(p, 'current-user-privilege-set'), 'write') || has(first(p, 'current-user-privilege-set'), 'all'), primary: false }));
    },
    async list(a, c, { from, to }) {
      const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
      const r = await req(a.id, 'REPORT', c.remote, { headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body:
        `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${DAV}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${t(from)}" end="${t(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>` });
      if (r.status !== 207) throw httpError(r);
      const events = {}, resps = blocks(r.text, 'response');
      read = { status: r.status, bytes: r.text.length, items: resps.length, withData: 0 };
      for (const resp of resps) {
        const p = okProps(resp), raw = unxml(first(p, 'calendar-data')), url = href(c.remote, first(resp, 'href')), etag = unxml(first(p, 'getetag')) || null;
        if (!raw) continue;
        read.withData++;
        const master = raw.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
        const rule = master.find((l) => /^RRULE:/i.test(l));
        for (const e of parse(raw, from, to)) {
          const [uid, date] = String(e.uid || '').split('|');
          const id = (uid || url).replace(/[^\w.@-]/g, '_').slice(0, 120);
          const key = date ? `${id}|${date}` : id;
          const rep = rule ? repeatOf(rule) : { repeat: null };
          events[key] = { remote: id, url, etag, raw, ev: { title: e.title, start: e.start, end: e.end || e.start, allDay: e.allDay, ...(e.place ? { place: e.place } : {}), ...(e.notes ? { notes: e.notes } : {}), ...(rep.repeat ? rep : {}), ...(date ? { date } : {}) } };
        }
      }
      return events;
    },
    async add(a, c, id, f) {
      const url = new URL(`${id}.ics`, c.remote.endsWith('/') ? c.remote : c.remote + '/').toString();
      const r = await req(a.id, 'PUT', url, { body: vcal(veventLines(f, `${id}@openhouse`)), headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' } });
      if (r.status === 412) { // already there (the first try went in)? iCloud also says 412 when it isn't, so look
        const g = await req(a.id, 'GET', url);
        if (g.status === 200) return { ok: true, already: true, etag: g.etag };
        if (g.status !== 404) throw httpError(g);
        const again = await req(a.id, 'PUT', url, { body: vcal(veventLines(f, `${id}@openhouse`)), headers: { 'content-type': 'text/calendar; charset=utf-8' } });
        if (again.status >= 300) throw httpError(again);
        return { ok: true, etag: again.etag };
      }
      if (r.status >= 300) throw httpError(r);
      return { ok: true, etag: r.etag };
    },
    async update(a, c, item, f) {
      const r = await req(a.id, 'PUT', item.url, { body: patchIcs(item.raw, seriesFields(item, f)), headers: { 'content-type': 'text/calendar; charset=utf-8', ...(item.etag ? { 'if-match': item.etag } : {}) } });
      if (r.status === 412) return { conflict: true };
      if (r.status === 404) return { gone: true };
      if (r.status >= 300) throw httpError(r);
      return { ok: true, etag: r.etag };
    },
    async remove(a, c, item, date) {
      const r = date && item.ev?.repeat
        ? await req(a.id, 'PUT', item.url, { body: patchIcs(item.raw, null, date), headers: { 'content-type': 'text/calendar; charset=utf-8', ...(item.etag ? { 'if-match': item.etag } : {}) } })
        : await req(a.id, 'DELETE', item.url, { headers: item.etag ? { 'if-match': item.etag } : {} });
      if (r.status === 412) return { conflict: true };
      if (r.status === 404 || r.status === 410) return { ok: true, already: true };
      if (r.status >= 300) throw httpError(r);
      return { ok: true };
    },
  };
  function httpError(r) {
    const e = new Error(r.status === 401 || r.status === 403 ? 'signin' : `HTTP ${r.status}`);
    if (r.status === 401 || r.status === 403) e.signin = true;
    if (r.status === 429 || r.status >= 500) e.offline = true; // try again later
    return e;
  }
  /** A whole series changed from one of its times: the series moves by as much as that time moved (not to its day). */
  function seriesFields(item, f) {
    if (!item.ev?.date || !item.ev.repeat) return f;
    const was = Date.parse(item.ev.start), moved = Date.parse(f.start) - was, len = Date.parse(f.end || f.start) - Date.parse(f.start);
    const ms = item.masterStart ? gDate(item.masterStart).t : null; // Google: the series' own first time
    const base = ms ?? (item.raw ? firstStart(item.raw) : null) ?? was;
    const start = new Date(base + moved);
    return { ...f, start: start.toISOString(), end: new Date(start.getTime() + len).toISOString() };
  }
  function firstStart(raw) {
    const evs = parse(raw, 0, Date.parse('2100-01-01'));
    return evs.length ? Date.parse(evs[0].start) : null;
  }

  // ---- what's shown ----------------------------------------------------------------------------------------
  const isOn = (c) => c && c.mode && c.mode !== 'off' && acc(c.account);
  const twoWay = (c) => isOn(c) && c.mode === 'two-way' && c.canWrite;
  const calName = (c) => (c.who && !c.name.toLowerCase().includes(c.who.toLowerCase()) && !/\S+@\S+/.test(c.name) ? `${c.name} (${c.who})` : c.name);
  function events() {
    const out = [];
    const pending = new Map(st.outbox.map((o) => [o.key, o]));
    for (const [k, c] of Object.entries(st.calendars)) {
      if (!isOn(c)) continue;
      for (const [key, item] of Object.entries(st.cache[k] || {})) {
        const id = `c-${k}-${item.remote}`;
        const p = pending.get(`${k}|${item.remote}`);
        if (p?.op === 'remove' && (!p.date || p.date === item.ev.date)) continue;
        const ev = p?.op === 'update' ? { ...item.ev, ...p.fields, ...(item.ev.date ? { start: shiftTo(item.ev, p).start, end: shiftTo(item.ev, p).end } : {}) } : item.ev;
        out.push({ ...ev, id, who: c.who || null, calendar: k, calendarName: calName(c), color: c.tone || null, uid: `${k}:${key}`, ...(twoWay(c) ? { editable: true } : {}),
          ...(st.notes[id] && st.notes[id].until > now() ? { note: st.notes[id].text } : {}) });
      }
    }
    for (const o of st.outbox) if (o.op === 'add' && isOn(st.calendars[o.calendar])) { // not sent yet: shown here meanwhile
      const c = st.calendars[o.calendar];
      out.push({ ...o.fields, id: `c-${o.calendar}-${o.remote}`, who: o.fields.who || c.who || null, calendar: o.calendar, calendarName: calName(c), color: c.tone || null, editable: true, ...(o.sent ? {} : { sending: true }) });
    }
    return out;
  }
  function shiftTo(ev, p) { // a pending change to a whole series, shown on this one time
    const moved = Date.parse(p.fields.start) - Date.parse(p.from || ev.start), len = Date.parse(p.fields.end || p.fields.start) - Date.parse(p.fields.start);
    const s = new Date(Date.parse(ev.start) + (p.from ? moved : 0));
    return { start: s.toISOString(), end: new Date(s.getTime() + len).toISOString() };
  }
  const calendars = () => Object.entries(st.calendars).filter(([, c]) => acc(c.account)).map(([key, c]) => ({ key, ...c, account: c.account, accountName: acc(c.account)?.name || '', provider: acc(c.account)?.provider, default: st.default === key, events: Object.keys(st.cache[key] || {}).length, read: st.reads?.[key] || null }));
  /** Where new events can go: two-way calendars (and which is the default). */
  const targets = () => calendars().filter((c) => twoWay(st.calendars[c.key])).map((c) => ({ key: c.key, name: calName(c), who: c.who || null, default: c.default }));
  /** Where an event for [who] goes: their own two-way calendar, else the household's default; null: stays on the tablet. */
  function targetFor(who) {
    const t = targets();
    const own = who && t.filter((c) => c.who && c.who.toLowerCase() === String(who).toLowerCase());
    return (own?.length ? own.find((c) => c.default) || own[0] : null)?.key || t.find((c) => c.default)?.key || null;
  }

  // ---- accounts and their calendars ---------------------------------------------------------------------------
  async function loadAccounts() {
    const r = await shell('/calendar/accounts', {});
    if (Array.isArray(r?.accounts)) { st.accounts = accounts = r.accounts.map((a) => ({ id: str(a.id, 40), provider: a.provider === 'google' ? 'google' : 'caldav', name: str(a.name, 80), who: str(a.who, 40) || null, server: a.server || null })); save(); }
    return accounts;
  }
  /** An account's calendars, found again; new ones start as the shell asked (shown, two-way when writable). */
  async function discover(accountId) {
    await loadAccounts();
    const a = acc(accountId); if (!a) return { error: 'No such account.' };
    try {
      const list = await prov(a).calendars(a);
      const fam = family().map((n) => String(n).toLowerCase());
      for (const c of list) {
        const k = keyOf(a.id, c.remote);
        const was = st.calendars[k];
        const guess = a.who || family().find((n) => c.name.toLowerCase().split(/[^a-z0-9]+/i).includes(String(n).toLowerCase())) || null;
        st.calendars[k] = { account: a.id, remote: c.remote, name: c.name, color: c.color, canWrite: c.canWrite, primary: c.primary,
          mode: was?.mode || (c.canWrite ? 'two-way' : 'read'), who: was ? was.who : guess && fam.includes(guess.toLowerCase()) ? guess : a.who || null };
      }
      if (!st.default || !st.calendars[st.default] || !twoWay(st.calendars[st.default])) st.default = targets().find((t) => st.calendars[t.key].primary)?.key || targets()[0]?.key || null;
      delete st.errors[a.id]; save(); changed();
      pull().catch(() => {});
      return { ok: true, calendars: calendars().filter((c) => c.account === a.id) };
    } catch (e) { st.errors[a.id] = e.signin ? 'signin' : str(e.message, 120); save(); return { error: e.signin ? 'The sign-in didn\'t work.' : `Couldn't reach it (${str(e.message, 80)}).`, signin: !!e.signin }; }
  }
  const keyOf = (account, remote) => crypto.createHash('sha256').update(`${account}|${remote}`).digest('base64url').replace(/[-_]/g, '').slice(0, 8);
  function setCalendar(key, b = {}) {
    const c = st.calendars[key]; if (!c) return { error: 'No such calendar.' };
    if (['off', 'read', 'two-way'].includes(b.mode)) c.mode = b.mode === 'two-way' && !c.canWrite ? 'read' : b.mode;
    if (b.who !== undefined) c.who = str(b.who, 40) || null;
    if (b.tone !== undefined) c.tone = /^#[0-9a-f]{6}$/i.test(b.tone || '') ? b.tone.toLowerCase() : null; // the color chosen here (its events'), not the provider's
    if (b.default) st.default = twoWay(c) ? key : st.default;
    if (st.default === key && !twoWay(c)) st.default = targets().find((t) => t.key !== key)?.key || null;
    save(); changed(); if (isOn(c)) pull().catch(() => {});
    return { ok: true, calendars: calendars() };
  }
  /** An account signed out (the shell forgot it): its calendars, their events and its changes not yet sent go. */
  function forget(accountId) {
    for (const [k, c] of Object.entries(st.calendars)) if (c.account === accountId) { delete st.calendars[k]; delete st.cache[k]; delete st.reads?.[k]; }
    st.outbox = st.outbox.filter((o) => st.calendars[o.calendar]);
    if (st.default && !st.calendars[st.default]) st.default = targets()[0]?.key || null;
    delete st.errors[accountId]; save(); changed(); return { ok: true };
  }

  // ---- reading ----------------------------------------------------------------------------------------------
  function pull() {
    if (pulling) return pulling;
    pulling = (async () => {
      try {
        await loadAccounts();
        const w = window();
        for (const [k, c] of Object.entries(st.calendars)) {
          const a = acc(c.account);
          if (!a || !isOn(c)) continue;
          try {
            read = null; const asked = now();
            st.cache[k] = await prov(a).list(a, c, w); delete st.errors[c.account];
            st.outbox = st.outbox.filter((o) => !(o.sent && o.calendar === k && o.sent <= asked)); // this read has them
            (st.reads ||= {})[k] = { ...(read || {}), events: Object.keys(st.cache[k]).length, at: now() };
          }
          catch (e) { st.errors[c.account] = e.signin ? 'signin' : str(e.message, 120); if (!e.offline && !e.signin) log(`[calendar-sync] ${a.provider}: ${str(e.message, 80)}`); }
        }
        st.at = now(); save(); changed();
      } finally { pulling = null; }
    })();
    return pulling;
  }

  // ---- writing ----------------------------------------------------------------------------------------------
  /** Find a synced event by its id here ("c-<key>-<remote>"), and the time of it asked for. */
  function find(id, date) {
    const m = /^c-([A-Za-z0-9]{8})-(.+)$/.exec(String(id || '')); if (!m) return null;
    const [, k, remote] = m, c = st.calendars[k]; if (!c) return null;
    const items = Object.values(st.cache[k] || {}).filter((i) => i.remote === remote);
    const item = (date && items.find((i) => i.ev.date === date)) || items.sort((x, y) => Date.parse(x.ev.start) - Date.parse(y.ev.start))[0] || null;
    const queued = st.outbox.find((o) => o.op === 'add' && !o.sent && o.calendar === k && o.remote === remote);
    return { key: k, remote, c, item, queued };
  }
  const isMine = (id) => /^c-[A-Za-z0-9]{8}-/.test(String(id || ''));
  function queue(o) {
    st.outbox.push({ ...o, at: now(), tries: 0 });
    save(); changed();
    flush().catch(() => {});
  }
  function add(fields, calendar) {
    const k = calendar && twoWay(st.calendars[calendar]) ? calendar : targetFor(fields.who);
    if (!k) return null; // stays on the tablet
    const remote = newId();
    queue({ op: 'add', calendar: k, remote, key: `${k}|${remote}`, fields });
    const c = st.calendars[k];
    return { ok: true, event: { ...fields, id: `c-${k}-${remote}`, calendar: k, calendarName: calName(c) }, calendarName: calName(c) };
  }
  function update(id, fields) {
    const f = find(id, fields.date); if (!f) return { error: `No event ${id}.` };
    if (!twoWay(f.c)) return { error: 'That calendar is shown here but changed where it comes from.' };
    if (f.queued) { f.queued.fields = { ...f.queued.fields, ...fields }; save(); changed(); flush().catch(() => {}); return { ok: true, event: { ...f.queued.fields, id } }; }
    if (!f.item) return { error: `No event ${id}.` };
    st.outbox = st.outbox.filter((o) => !(o.op === 'update' && o.key === `${f.key}|${f.remote}`)); // the latest change is the one that goes
    queue({ op: 'update', calendar: f.key, remote: f.remote, key: `${f.key}|${f.remote}`, fields, from: f.item.ev.date ? f.item.ev.start : null, date: f.item.ev.date || null });
    return { ok: true, event: { ...f.item.ev, ...fields, id } };
  }
  function remove(id, date) {
    const f = find(id, date); if (!f) return { error: `No event ${id}.` };
    if (!twoWay(f.c)) return { error: 'That calendar is shown here but changed where it comes from.' };
    if (f.queued && !date) { st.outbox = st.outbox.filter((o) => o !== f.queued); save(); changed(); return { ok: true, removed: [id] }; }
    if (!f.item) return { error: `No event ${id}.` };
    const one = date && f.item.ev.repeat ? date : null;
    queue({ op: 'remove', calendar: f.key, remote: f.remote, key: `${f.key}|${f.remote}`, date: one });
    return one ? { ok: true, removed: [], skipped: one } : { ok: true, removed: [id] };
  }

  /** Send what's waiting, oldest first. Kept (and tried again later) when Google or iCloud can't be reached. */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let did = false;
      try {
        await loadAccounts();
        for (const o of [...st.outbox]) {
          if (!st.outbox.includes(o) || o.sent) continue;
          if (o.next && o.next > now()) continue;
          const c = st.calendars[o.calendar], a = c && acc(c.account);
          if (!a) { if (!c) { st.outbox = st.outbox.filter((x) => x !== o); did = true; } continue; } // its account isn't here now: wait
          const item = o.op === 'add' ? null : (o.date && Object.values(st.cache[o.calendar] || {}).find((i) => i.remote === o.remote && i.ev.date === o.date)) || Object.values(st.cache[o.calendar] || {}).find((i) => i.remote === o.remote && (!o.from || i.ev.start === o.from)) || Object.values(st.cache[o.calendar] || {}).find((i) => i.remote === o.remote);
          let r;
          trail = [];
          try {
            r = o.op === 'add' ? await prov(a).add(a, c, o.remote, o.fields)
              : !item ? { gone: true }
              : o.op === 'update' ? await prov(a).update(a, c, item, { ...item.ev, ...o.fields })
              : await prov(a).remove(a, c, item, o.date);
          } catch (e) {
            st.sent = [{ op: o.op, at: now(), trail: [...trail], error: str(e.message, 60) }, ...(st.sent || [])].slice(0, 8);
            o.tries++; o.next = now() + Math.min(30 * MIN, 15e3 * 2 ** Math.min(o.tries, 7)); did = true;
            if (e.signin) st.errors[a.id] = 'signin';
            if (!e.offline && !e.signin && o.tries >= 6) { st.outbox = st.outbox.filter((x) => x !== o); log(`[calendar-sync] gave up on a change (${str(e.message, 60)})`); }
            continue;
          }
          // Gone in: still shown as changed until the next read brings it back changed (else it flickers back meanwhile).
          if (r.conflict || r.gone) st.outbox = st.outbox.filter((x) => x !== o); else { o.sent = now(); delete o.next; }
          did = true;
          st.sent = [{ op: o.op, at: now(), trail: [...trail], ...(r.already ? { already: true } : {}) }, ...(st.sent || [])].slice(0, 8);
          if (r.conflict || r.gone) { // changed (or deleted) elsewhere first: theirs stays
            st.notes[`c-${o.calendar}-${o.remote}`] = { text: r.gone ? 'Removed on its calendar before this change went in.' : `Changed on ${calName(c)} first, so that change is kept.`, until: now() + 3 * DAY };
          }
        }
      } finally {
        if (did) { save(); changed(); }
        flushing = null;
      }
      if (did) await pull().catch(() => {});
    })();
    return flushing;
  }

  function status() {
    return { at: st.at, waiting: st.outbox.filter((o) => !o.sent).length, sent: st.sent || [], accounts: accounts.map((a) => ({ ...a, error: st.errors[a.id] || null })) };
  }
  function start(onChange) {
    changed = onChange || changed;
    clearInterval(timer);
    timer = setInterval(() => { flush().catch(() => {}); pull().catch(() => {}); }, every);
    timer.unref?.();
    setTimeout(() => { flush().catch(() => {}); pull().catch(() => {}); }, 15e3).unref?.();
  }
  for (const n of Object.keys(st.notes)) if (st.notes[n].until < now()) delete st.notes[n];
  return { events, calendars, targets, targetFor, status, accounts: () => accounts.slice(), loadAccounts, discover, setCalendar, forget, add, update, remove, isMine, pull, flush, start, stop: () => clearInterval(timer), _patchIcs: patchIcs };
}
