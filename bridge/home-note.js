// A note someone types for Home: from their phone's page, or the plus on Home itself. Words (280 characters at most),
// for one person or everyone, now or at a time, and said aloud if they ask. It goes in the same notes put_note puts up
// (home-screen.js), as the family's own; one for later waits in door.json with the rest of the home screen (pending),
// so a restart keeps it. Said aloud is the device's own speech engine (voice.js say {own}: shell Speech.kt), never a
// model or the cloud's voice; never in the night hours or after Sleep now, when it's only the note.
//
//   POST /home/note {text, for?, at?: ms or a local time ("16:00", "2026-11-28T16:00"), aloud?}  -> {ok, id?, at?}
//
// A phone may send PER_HOUR of them an hour, as with shares (phone-share.js). Opie does the same with put_note's at and aloud.
import { parseWhen } from './later.js';

const PER_HOUR = 20, MAX = 280, LATE = 3600e3, SAY_LATE = 15 * 60e3;

export function homeNoteRoutes({ homeScreen, screens, json, body, say = () => false, quiet = () => false, people = () => [], now = () => Date.now(), every = 20e3 }) {
  const recent = new Map(); // phone id -> [times]
  const personOf = (name) => { const n = String(name || '').trim().toLowerCase(); return n ? people().find((p) => p.toLowerCase() === n) || false : null; };

  /** Put it up now (and say it), or keep it for its time. {error} | {note} | {at}. */
  function add(a, from = null) {
    const text = String(a.text ?? a.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return { error: 'Nothing to put up.' };
    if (text.length > MAX) return { error: `At most ${MAX} characters.` };
    const who = personOf(a.for);
    if (who === false) return { error: `${String(a.for).slice(0, 40)} isn't in the household.` };
    let at = null;
    if (a.at != null && a.at !== '') {
      at = typeof a.at === 'number' ? a.at : parseWhen(a.at, null, now());
      if (!Number.isFinite(at)) return { error: 'That time isn’t one I can read.' };
      if (at <= now() + 30e3) at = null; // (now, near enough)
      else if (at > now() + 366 * 864e5) return { error: 'At most a year ahead.' };
    }
    const item = { text, for: who || null, from: from || null, aloud: !!a.aloud };
    if (at) { homeScreen.pending.add({ ...item, at }); return { at }; }
    return { note: show(item) };
  }
  function show(x, late = 0) {
    const r = homeScreen.put({ title: x.from ? `From ${x.from}` : x.for ? `For ${x.for}` : 'Note', content: x.text, for: x.for, keep: true }, {}, { by: 'family', who: x.from, conversation: null, touched: null });
    if (r.error) return null;
    if (x.aloud && late < SAY_LATE && !quiet(now())) say(`${x.for ? `${x.for}, ` : ''}${x.from ? `from ${x.from}: ` : ''}${x.text}`);
    return r.note;
  }
  /** Each one whose time came: up on Home (said, unless it's very late); one more than an hour late is up, but quietly. */
  function tick() {
    const t = now();
    for (const x of homeScreen.pending.list()) if (x.at <= t) { homeScreen.pending.remove(x.id); show(x, t - x.at > LATE ? LATE : t - x.at); }
  }
  if (every) setInterval(tick, every).unref?.();

  async function handle(req, res, url) {
    if (url.pathname !== '/home/note' || req.method !== 'POST') return false;
    const id = String(req.headers['x-openhouse-screen'] || '');
    const s = id ? screens.who(id) : null;
    if (id && !s) { json(res, 403, { error: 'not paired' }); return true; }
    if (s) { // (the display itself has no limit)
      const t = now(), times = (recent.get(s.id) || []).filter((x) => x > t - 3600e3);
      if (times.length >= PER_HOUR) { json(res, 429, { error: 'That’s a lot of notes at once. Try again in a while.' }); return true; }
      recent.set(s.id, [...times, t]);
    }
    const b = await body(req);
    const r = add(b, s?.person || (s ? null : personOf(b.from) || null));
    if (r.error) { json(res, 400, { error: r.error }); return true; }
    json(res, 200, { ok: true, ...(r.note ? { id: r.note.id } : { at: r.at }) });
    return true;
  }
  return Object.assign(handle, { add, tick });
}
