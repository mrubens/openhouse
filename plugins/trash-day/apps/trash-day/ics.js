// A team's schedule from its calendar link (iCalendar, what TeamSnap, GameChanger, SportsEngine, LeagueApps and
// Google Calendar give out). No page or kit here. Each game is one event in the feed; a repeating event (RRULE) is
// taken as its first time only, as team apps list each game on its own.
const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** webcal:// or https:// → https, else null. */
export function feedUrl(s) {
  let u; try { u = new URL(String(s || '').trim().replace(/^webcals?:\/\//i, 'https://')); } catch { return null; }
  return u.protocol === 'https:' ? u.href : null;
}
/** A DTSTART/DTEND line's value as {at: 'YYYY-MM-DDTHH:MM' local, or date: 'YYYY-MM-DD'}. */
function when(params, v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  if (!m[4] || /VALUE=DATE(?!-)/i.test(params)) return { date: `${m[1]}-${m[2]}-${m[3]}` };
  // UTC turns into the tablet's own time; a TZID time is taken as written (a local team's games are in local time)
  if (m[7]) return { at: local(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]))) };
  return { at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` };
}
const unescape = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').replace(/\s+/g, ' ').trim();

/** The feed's text as [{uid, title, start: {at|date}, end?, place}], in order. */
export function readIcs(text) {
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = []; let e = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { e = {}; continue; }
    if (l === 'END:VEVENT') { if (e?.start && e.title && !e.cancelled) out.push(e); e = null; continue; }
    if (!e) continue;
    const i = l.indexOf(':'); if (i < 0) continue;
    const [name, ...ps] = l.slice(0, i).split(';'), params = ps.join(';'), v = l.slice(i + 1);
    if (name === 'SUMMARY') e.title = unescape(v).slice(0, 120);
    else if (name === 'LOCATION') e.place = unescape(v).slice(0, 120);
    else if (name === 'UID') e.uid = v;
    else if (name === 'DTSTART') e.start = when(params, v);
    else if (name === 'DTEND') e.end = when(params, v);
    else if (name === 'STATUS' && /CANCELLED/i.test(v)) e.cancelled = true;
  }
  return out.sort((a, b) => (a.start.at || a.start.date).localeCompare(b.start.at || b.start.date));
}
