// The buzzes a phone chooses (docs/phones.md, "Notifications"), beside the ones every phone gets (a note for you, your
// event's reminder, your chore's Remind me: phone-buzz.js):
//   events    a new event for you that someone else put on the calendar (on by default)
//   chores    your chore when it's due: at its time, or the ones without one in the late afternoon (off by default)
//   kidsDone  a kid's chore done, to an adult's phone (off by default)
// Each is switched on that phone (screens.js, POST /phone/push {buzz}); screens.notify sends a kind only to the phones
// of that person that have it on. None in the household's night hours: a new event waits for the morning, the rest are
// dropped. And never a stream: one buzz per person and kind at most every GAP, what came in between gathered into it.
import { inNight } from './phone-buzz.js';

const MIN = 60e3;
/** The kinds, and whether a phone has each before anyone switches it (on: events, rare and news; off: chores, every day). */
export const BUZZ_KINDS = { events: { on: true }, chores: { on: false }, kidsDone: { on: false, adults: true } };
/** At most one buzz of a kind for a person this often. */
export const GAP = 15 * MIN;
/** When chores without a time are "due" (if they're still not done). */
export const CHORES_AT = '17:00';

const when = (e) => {
  const d = new Date(e.allDay && /^\d{4}-\d{2}-\d{2}$/.test(e.start) ? e.start + 'T12:00' : e.start);
  if (isNaN(d)) return '';
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return e.allDay ? day : `${day}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};
const list = (xs) => xs.slice(0, 4).join(', ') + (xs.length > 4 ? ` and ${xs.length - 4} more` : '');

/** The words of one buzz for what was gathered (items, oldest first). */
function words(kind, items) {
  if (kind === 'events') return items.length === 1 ? { title: `New: ${items[0].title}`, body: when(items[0]) } : { title: `${items.length} new events`, body: list(items.map((x) => x.title)) };
  if (kind === 'chores') return items.length === 1 ? { title: items[0].task, body: items[0].at ? 'Now' : 'Still to do today' } : { title: `${items.length} chores to do`, body: list(items.map((x) => x.task)) };
  const kids = [...new Set(items.map((x) => x.who))];
  if (items.length === 1) return { title: `${items[0].who} did ${items[0].task}`, body: '' };
  return kids.length === 1 ? { title: `${kids[0]} did ${items.length} chores`, body: list(items.map((x) => x.task)) }
    : { title: `${items.length} chores done`, body: kids.map((k) => `${k}: ${items.filter((x) => x.who === k).map((x) => x.task).join(', ')}`).join(' · ') };
}

/**
 * notify(person, msg, kind): to that person's phones with that kind on (screens.notify); family(): [{name, kind}];
 * night(): the household's night hours; choresDue(t): [{key, who, task, at?}] due now (house/chores.js).
 */
export function chosenBuzz({ notify, family = () => [], night = () => null, choresDue = () => [], now = () => Date.now(), gap = GAP }) {
  const queues = new Map(); // "person|kind" -> { items, last }
  const seen = new Map(); // chores due already handled today: key -> when
  const isPerson = (n) => family().find((p) => String(p.name).toLowerCase() === String(n || '').toLowerCase());
  function add(person, kind, item) {
    const p = isPerson(person); if (!p) return;
    const k = `${p.name}|${kind}`, q = queues.get(k) || { items: [], last: 0 };
    q.items.push(item); queues.set(k, q);
  }
  /** Something happened in the house (house.js noticed): an event added, a chore done. by: who did it, when known. */
  function noticed(type, x) {
    const by = String(x?.by || '').toLowerCase();
    if (type === 'added' && x?.event) {
      const e = x.event, t = Date.parse(e.start);
      if (!(t > now() - 24 * 60 * MIN)) return; // (one that's over: nothing to tell)
      for (const n of new Set([e.who, ...(e.also || [])].filter(Boolean))) if (String(n).toLowerCase() !== by) add(n, 'events', { title: String(e.title || ''), start: e.start, allDay: !!e.allDay });
    }
    if (type === 'choreDone' && x?.who && isPerson(x.who)?.kind === 'kid') {
      for (const a of family().filter((p) => (p.kind || 'adult') === 'adult')) if (a.name.toLowerCase() !== by) add(a.name, 'kidsDone', { who: isPerson(x.who).name, task: String(x.task || '') });
    }
  }
  async function tick() {
    const t = now(), quiet = inNight(night(), t);
    for (const [k, at] of seen) if (at < t - 24 * 60 * MIN) seen.delete(k);
    let due = [];
    try { due = choresDue(t) || []; } catch (e) { console.error('[chosen-buzz]', e.message); }
    for (const c of due) { if (!c?.key || seen.has(c.key)) continue; seen.set(c.key, t); if (!quiet) add(c.who, 'chores', { task: c.task, at: c.at || null }); }
    let n = 0;
    for (const [k, q] of queues) {
      const [person, kind] = k.split('|');
      if (quiet) { if (kind !== 'events') q.items = []; continue; } // (a new event keeps till morning; the rest would be old news)
      if (!q.items.length || t - q.last < gap) continue;
      const items = q.items; q.items = []; q.last = t;
      try { n += await notify(person, { ...words(kind, items), tag: `buzz-${kind}-${t}` }, kind) || 0; } catch {}
    }
    for (const [k, q] of queues) if (!q.items.length && t - q.last >= gap) queues.delete(k);
    return n;
  }
  return { noticed, tick };
}
