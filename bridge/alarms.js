// Alarm clocks: alarms that ring on the device itself at a set time, once or on chosen days, each with a label and whose
// it is. The bridge keeps them (household data: alarms.json, in backups); the home view carries them to every screen,
// and the shell (Alarms.kt) keeps its own copy and schedules the next one with Android's alarm manager, so an alarm
// still rings when the network is down or the bridge is restarting. The shell rings it, and says so here (ringing,
// snoozed, stopped); Opie or a screen stopping or snoozing one asks the shell to (host.js POST /alarms).
//
//   POST /home/alarm  {set: {time, days?, label?, who?}} | {change: {id, ...}} | {cancel: id} | {stop: true} | {snooze: true}
//                     from the display's own shell too: {ringing: id} | {snoozed: id, until} | {stopped: id}
//
// An alarm: {id, time: "07:00", days: [0..6] (Sunday is 0; none: once), date: "YYYY-MM-DD" (once: the day it rings),
// label, who, on, at}. A one-off that has rung is kept, turned off, so "turn my alarm back on" finds it.
// file: alarms.json next to the chats: { alarms: [...] }
import { readJson, writeJson, unsaved } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';

const MIN = 60e3;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const SNOOZE_MIN = 9;
const MAX = 30;
const plain = (t) => String(t || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "07:00", "7:30", "6:45 pm", "18:05" -> "HH:MM", or null. */
export function cleanTime(s) {
  const m = String(s ?? '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0), ap = m[3]?.[0];
  if (ap && (h < 1 || h > 12)) return null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : null;
}
/** Days as the tool or a screen gives them (["mon", "tue"] or [1, 2]) -> sorted 0..6, none for once. */
export function cleanDays(days) {
  if (!Array.isArray(days)) return [];
  const out = new Set();
  for (const d of days) {
    const i = typeof d === 'number' ? d : DAY_KEYS.indexOf(String(d).trim().toLowerCase().slice(0, 3));
    if (Number.isInteger(i) && i >= 0 && i <= 6) out.add(i);
  }
  return [...out].sort();
}

/** When [a] next rings after [now] (ms), or null (off, or a one-off whose time has passed). */
export function nextRing(a, now) {
  if (!a?.on || !cleanTime(a.time)) return null;
  const [h, m] = a.time.split(':').map(Number);
  if (a.days?.length) {
    for (let i = 0; i <= 7; i++) {
      const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
      if (+d > now && a.days.includes(d.getDay())) return +d;
    }
    return null;
  }
  const [y, mo, da] = String(a.date || '').split('-').map(Number);
  if (!y) return null;
  const t = +new Date(y, mo - 1, da, h, m, 0, 0);
  return t > now ? t : null;
}
/** The day a one-off at [time] rings: today if that's still ahead, else tomorrow. */
const onceDate = (time, now) => { const [h, m] = time.split(':').map(Number); const d = new Date(now); d.setHours(h, m, 0, 0); if (+d <= now) d.setDate(d.getDate() + 1); return dayKey(d); };

/** "weekdays", "every day", "Mon, Wed", "once" (for Opie's answers). */
export function daysText(days) {
  if (!days?.length) return 'once';
  const k = days.join();
  if (k === '0,1,2,3,4,5,6') return 'every day';
  if (k === '1,2,3,4,5') return 'weekdays';
  if (k === '0,6') return 'weekends';
  return days.map((d) => DAY_KEYS[d][0].toUpperCase() + DAY_KEYS[d].slice(1)).join(', ');
}

export const ALARM_TOOL = { name: 'alarm',
  description: 'Alarm clocks that ring on the tablet at a set time, with the alarm sound, until someone stops or snoozes them: for waking up or a set time of day ("wake me at 6:30 on weekdays", "an alarm for Maya at 7 tomorrow"). ' +
    'Not for a countdown (timer) or words said later (later). Actions: set (time, and days for one that repeats; none rings once, at the next such time), list, change (by id: time, days, label, who, or on false/true to turn it off or back on), cancel (by id, or all), ' +
    'and for one ringing now: stop or snooze. To stop or snooze, no list first. To change or cancel with one alarm, no list first either.',
  inputSchema: { type: 'object', required: ['action'], properties: {
    action: { type: 'string', enum: ['set', 'list', 'change', 'cancel', 'stop', 'snooze'] },
    id: { type: 'string', description: 'For change or cancel: which alarm, from list' },
    time: { type: 'string', description: 'For set or change: the time of day, 24-hour "HH:MM" ("06:30", "19:00")' },
    days: { type: 'array', items: { type: 'string', enum: DAY_KEYS }, description: 'For set or change: the days it repeats on (weekdays: mon to fri); leave out for once' },
    label: { type: 'string', description: 'A short name ("School", "Swim practice")' },
    who: { type: 'string', description: "Whose alarm it is: a family member's name, if it's someone's" },
    on: { type: 'boolean', description: 'For change: false turns it off without deleting it, true back on' },
    all: { type: 'boolean', description: 'For cancel: every alarm' },
    minutes: { type: 'number', description: 'For snooze: how long (else 9 minutes)' },
  } } };

/**
 * DIR: the chats folder. shell(path, body): a call to the device's shell (host.js), canRing(): it rings alarms. onChange: every screen told.
 */
export function alarmStore({ DIR, now = () => Date.now(), shell = async () => null, canRing = () => false, onChange = () => {} }) {
  const FILE = registered('alarms', path.join(DIR, '../alarms.json'));
  let st = { alarms: [], ...readJson(FILE, {}) };
  if (!Array.isArray(st.alarms)) st.alarms = [];
  // What the shell said is ringing or snoozed (not kept: the shell keeps its own, and says again after a restart).
  let ring = null; // {id, state: 'ringing'|'snoozed', until?, at}
  const save = (before) => {
    try { writeJson(FILE, st); }
    catch (e) { if (before) st = before; console.error('[alarms]', e.message); throw Object.assign(e, { unsaved: true }); }
    onChange();
  };
  const copy = () => structuredClone(st);

  /** One-offs whose time has passed (and aren't ringing or snoozed) turn off. */
  function expire() {
    const t = now();
    let changed = false;
    for (const a of st.alarms) if (a.on && !a.days?.length && nextRing(a, t) == null && ring?.id !== a.id) { a.on = false; changed = true; }
    if (changed) { try { save(); } catch {} }
  }
  const view1 = (a, t = now()) => ({ id: a.id, time: a.time, days: a.days || [], date: a.date || null, label: a.label || '', who: a.who || null, on: !!a.on, next: nextRing(a, t) });
  /** For the home view (every screen and the shell): the alarms, the next ring of each, and the one ringing. */
  function view() {
    const t = now();
    return { list: st.alarms.map((a) => view1(a, t)), ring: ring && st.alarms.some((a) => a.id === ring.id) ? ring : null };
  }

  function fields(b, was = {}) {
    const time = b.time !== undefined ? cleanTime(b.time) : was.time;
    if (!time) return { error: 'An alarm needs a time of day, like 06:30.' };
    const days = b.days !== undefined ? cleanDays(b.days) : was.days || [];
    const label = b.label !== undefined ? plain(b.label).slice(0, 40) : was.label || '';
    const who = b.who !== undefined ? (plain(b.who).slice(0, 40) || null) : was.who || null;
    const on = b.on !== undefined ? b.on !== false : was.on ?? true;
    const timeChanged = time !== was.time || String(days) !== String(was.days || []);
    // A one-off gets its day again when it's set, its time or days change, or it's turned back on.
    const date = days.length ? null : (timeChanged || (on && !was.on) || !was.date ? onceDate(time, now()) : was.date);
    return { time, days, label, who, on, date };
  }
  function set(b) {
    if (st.alarms.length >= MAX) return { error: `That's ${MAX} alarms already: cancel one first.` };
    const f = fields(b || {});
    if (f.error) return f;
    const before = copy(), t = now();
    const a = { id: `a-${t.toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...f, at: t };
    st.alarms.push(a);
    save(before);
    return { alarm: a };
  }
  function change(id, b) {
    const a = st.alarms.find((x) => x.id === id);
    if (!a) return { error: 'No such alarm.' };
    const f = fields(b || {}, a);
    if (f.error) return f;
    const before = copy();
    Object.assign(a, f, { at: now() });
    if (!a.on && ring?.id === a.id) stopRinging(); // (turned off while it rings or is snoozed)
    save(before);
    return { alarm: a };
  }
  function cancel(id) {
    const a = st.alarms.find((x) => x.id === id);
    if (!a) return null;
    const before = copy();
    st.alarms = st.alarms.filter((x) => x !== a);
    if (ring?.id === id) stopRinging();
    save(before);
    return a;
  }
  /** Stop or snooze the one ringing (or snoozed): the shell does it, and says so back. */
  async function stopRinging(snoozeMin = 0) {
    const r = await shell('/alarms', snoozeMin ? { do: 'snooze', minutes: snoozeMin } : { do: 'stop' }).catch(() => null);
    if (!snoozeMin) { ring = null; onChange(); }
    return r?.ok !== false;
  }
  /** What the shell says: it's ringing, snoozed until, or stopped. */
  function heard(b) {
    const t = now();
    if (b.ringing) ring = { id: String(b.ringing), state: 'ringing', at: t };
    else if (b.snoozed) ring = { id: String(b.snoozed), state: 'snoozed', until: Number(b.until) || t + SNOOZE_MIN * MIN, at: t };
    else if (b.stopped && (!ring || ring.id === String(b.stopped))) ring = null;
    expire();
    onChange();
  }

  const dayWord = (t) => { const a = new Date(now()); a.setHours(0, 0, 0, 0); const d = Math.round((new Date(t).setHours(0, 0, 0, 0) - a) / 864e5); return d === 0 ? 'today' : d === 1 ? 'tomorrow' : new Date(t).toLocaleDateString('en-US', { weekday: 'long' }); };
  const describe = (a) => {
    const n = nextRing(a, now());
    return `${a.label || 'Alarm'}${a.who ? ` (${a.who})` : ''}: ${hm(new Date(`2000-01-01T${a.time}`))} ${daysText(a.days)}, ${!a.on ? 'off' : n ? `rings ${dayWord(n)} at ${hm(n)}` : 'off'} (id ${a.id})`;
  };
  const list = () => (st.alarms.length ? st.alarms.map(describe).join('\n') : 'No alarms.');

  /** The voice's and the agents' alarm tool (live-tools.js, the home screen's MCP). */
  async function call(name, a = {}) {
    const ok = (t) => ({ content: [{ type: 'text', text: t }] }), err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (name !== ALARM_TOOL.name) return err(`unknown tool ${name}`);
    expire();
    try {
      if (a.action === 'list') return ok(list() + (ring ? `\nRinging now: ${ring.id}${ring.state === 'snoozed' ? ` (snoozed until ${hm(ring.until)})` : ''}` : ''));
      if (a.action === 'set') { const r = set(a); return r.error ? err(r.error) : ok(`Set: ${describe(r.alarm)}.`); }
      if (a.action === 'stop' || a.action === 'snooze') {
        if (!ring) return err('No alarm is ringing.');
        if (!canRing()) return err('This device can\'t ring alarms.');
        const m = a.action === 'snooze' ? Math.min(60, Math.max(1, Math.round(Number(a.minutes) || SNOOZE_MIN))) : 0;
        await stopRinging(m);
        return ok(m ? `Snoozed for ${m} minutes.` : 'Stopped.');
      }
      const one = a.id ? st.alarms.find((x) => x.id === a.id) : st.alarms.length === 1 ? st.alarms[0] : null;
      if (a.action === 'cancel' && a.all) { const n = st.alarms.length; for (const x of [...st.alarms]) cancel(x.id); return ok(n ? `Cancelled ${n} alarm${n > 1 ? 's' : ''}.` : 'No alarms.'); }
      if (!one) return err(st.alarms.length ? `Which one?\n${list()}` : 'No alarms.');
      if (a.action === 'cancel') { cancel(one.id); return ok(`Cancelled: ${one.label || 'the alarm'} at ${hm(new Date(`2000-01-01T${one.time}`))}.`); }
      if (a.action === 'change') { const r = change(one.id, a); return r.error ? err(r.error) : ok(`Changed: ${describe(r.alarm)}.`); }
    } catch (e) { return err(unsaved(e).error || e.message); }
    return err('Unknown action.');
  }

  /** POST /home/alarm, from a screen (set, change, cancel, stop, snooze) or the display's shell (what it rang). */
  async function handle(b, { display = false } = {}) {
    if (display && (b.ringing || b.snoozed || b.stopped)) { heard(b); return { ok: true }; }
    try {
      if (b.set) { const r = set(b.set); return r.error ? r : { ok: true, alarm: view1(r.alarm) }; }
      if (b.change?.id) { const r = change(String(b.change.id), b.change); return r.error ? r : { ok: true, alarm: view1(r.alarm) }; }
      if (b.cancel) return { ok: !!cancel(String(b.cancel)) };
      if (b.stop || b.snooze) return { ok: ring ? await stopRinging(b.snooze ? SNOOZE_MIN : 0) : false };
    } catch (e) { return unsaved(e); }
    return { error: 'Nothing to do.' };
  }

  setInterval(expire, MIN).unref?.();
  return { tools: [ALARM_TOOL], call, handle, view, list: () => st.alarms.map((a) => view1(a)), heard };
}
