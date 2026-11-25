// The calendar: events added on the display (they can repeat), the synced ones with what this display keeps about them
// (whose, a countdown, a reminder), the reminders due now, and the PIN lock on changes from apps and from Opie.
import crypto from 'node:crypto';
import { DAY, REPEATS, dayKey, midnightAfter, wholeDays, validDay, str, same, arr } from './util.js';

export default function (house) {
  const { data, save, changed, prune, board, appEvents, calendarEvents } = house;
  let unlockedUntil = 0; // the PIN was given on the display: apps may change the calendar until then
  // Events added here can repeat; each time it comes up is one event (same id, its own start).
  function occurrences(e, from, to) {
    if (!e.repeat) return [e];
    const s = new Date(e.start), dur = new Date(e.end || e.start) - s, out = [];
    const endOf = (d) => (e.allDay ? midnightAfter(d, wholeDays(dur)) : new Date(d.getTime() + dur));
    const until = e.until ? new Date(e.until + 'T23:59:59') : null, skip = new Set(e.skip || []);
    // Start near `from`, not at the first time it came up (a weekly event from years ago).
    const step = { daily: 1, weekdays: 1, weekly: 7, biweekly: 14 }[e.repeat];
    const i0 = step ? Math.max(0, Math.floor((from - s - dur) / (step * DAY)) - 1) : e.repeat === 'monthly' ? Math.max(0, Math.floor((from - s - dur) / (31 * DAY)) - 1) : e.repeat === 'yearly' ? Math.max(0, Math.floor((from - s - dur) / (366 * DAY)) - 1) : 0;
    for (let i = i0; i < i0 + 5000; i++) {
      const d = new Date(s);
      if (e.repeat === 'daily' || e.repeat === 'weekdays') d.setDate(s.getDate() + i);
      else if (e.repeat === 'weekly') d.setDate(s.getDate() + 7 * i);
      else if (e.repeat === 'biweekly') d.setDate(s.getDate() + 14 * i);
      else if (e.repeat === 'monthly') { d.setMonth(s.getMonth() + i); if (d.getDate() !== s.getDate()) continue; } // no Feb 30th
      else if (e.repeat === 'yearly') { d.setFullYear(s.getFullYear() + i); if (d.getMonth() !== s.getMonth()) continue; }
      if (d >= to || (until && d > until)) break;
      if (e.repeat === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue;
      if (endOf(d) < from || skip.has(dayKey(d))) continue;
      out.push({ ...e, start: d.toISOString(), end: endOf(d).toISOString(), date: dayKey(d) });
    }
    return out;
  }
  let localCache = null; // events added here, expanded: kept while the data and the minute are the same
  function events() {
    const minute = Math.floor(Date.now() / 60e3), from = (minute * 60e3) - 35 * DAY, to = (minute * 60e3) + 70 * DAY; // enough for a month view either way
    if (localCache?.rev !== house.rev() || localCache.minute !== minute) localCache = { rev: house.rev(), minute, list: data.events.flatMap((e) => occurrences(e, from, to)).map((e) => ({ ...e, local: true })) };
    const local = localCache.list;
    // A countdown is on that one event; once it's over it's gone (a weekly class counting down again every week isn't
    // worth the space: the user, "who cares?").
    const cd = new Set(data.countdowns);
    const counted = (uid) => cd.has(uid);
    const all = data.settings.remind ?? null;
    const remindOf = (e) => { if (e.allDay || e.fromApp) return null; /* (an app's events: read-only, no chime) */ const m = e.local ? e.remind ?? all : e.uid && data.reminds[e.uid] !== undefined ? data.reminds[e.uid] : all; return m == null || m < 0 ? null : m; };
    const whose = (e) => (e.calendar && e.uid && data.whose[e.uid.replace(/\|.*$/, '')] ? { ...e, ...data.whose[e.uid.replace(/\|.*$/, '')] } : e); // (a repeat's times share one)
    return [...calendarEvents().map(whose).map((e) => (e.uid && counted(e.uid) ? { ...e, countdown: true } : e)), ...local, ...appEvents()]
      .filter((e) => new Date(e.end || e.start) > from && new Date(e.start) < to)
      .map((e) => { // remind: its own minutes (the household's when absent); remindAt: when it's due
        const own = !e.local && e.uid && data.reminds[e.uid] !== undefined ? { remind: data.reminds[e.uid] } : {}, m = remindOf(e);
        return m == null ? { ...e, ...own } : { ...e, ...own, remindAt: new Date(new Date(e.start).getTime() - m * 60e3).toISOString(), remindMin: m };
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  const remindKey = (e) => `${e.uid || e.id}|${e.start}`;
  /** The reminders due now: from their time until ten minutes after the start (or the end, if sooner), unless put away. [list]: the events, when a view has them already. */
  function reminders(now = Date.now(), list = events()) {
    const away = new Set(data.reminded);
    return list.filter((e) => e.remindAt && new Date(e.remindAt) <= now && now < Math.min(new Date(e.start).getTime() + 10 * 60e3, new Date(e.end || e.start).getTime() + 60e3) && !away.has(remindKey(e)))
      .map((e) => ({ key: remindKey(e), title: e.title, start: e.start, who: [e.who, ...(e.also || [])].filter(Boolean).join(' & ') || null, ...(e.place ? { place: e.place } : {}) }));
  }
  // ---- events added on the display ----
  /** An event's fields from what was asked (add, or an update over what it was). */
  function eventFields(e, was = {}) {
    const startIn = e.start ?? was.start, start = new Date(startIn);
    const title = e.title !== undefined ? str(e.title, 80) : was.title;
    if (!title || isNaN(start)) return { error: 'An event needs a title and a start (ISO date or date-time).' };
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(startIn));
    const allDay = e.allDay !== undefined ? !!e.allDay || dateOnly : e.start !== undefined ? dateOnly : !!was.allDay;
    const s = allDay ? (dateOnly ? new Date(String(startIn) + 'T00:00:00') : new Date(start.getFullYear(), start.getMonth(), start.getDate())) : start;
    // The end: as given; else as long as it was (when it moved); else an hour, or the day.
    const dur = was.start && was.end ? new Date(was.end) - new Date(was.start) : null;
    let end = e.end && !isNaN(new Date(e.end)) ? new Date(e.end) : dur && allDay === !!was.allDay ? (allDay ? midnightAfter(s, wholeDays(dur)) : new Date(s.getTime() + dur)) : allDay ? midnightAfter(s) : new Date(s.getTime() + 3600e3);
    if (end <= s) end = allDay ? midnightAfter(s) : new Date(s.getTime() + 3600e3);
    const repeat = e.repeat !== undefined ? (REPEATS.includes(e.repeat) ? e.repeat : null) : was.repeat || null;
    const until = e.until !== undefined ? (validDay(e.until) ? e.until : null) : was.until || null;
    const pick = (k, n) => (e[k] !== undefined ? str(e[k], n) : was[k] || '');
    const who = e.who !== undefined ? str(e.who, 40) || null : was.who || null;
    const also = (e.also !== undefined ? arr(e.also) : was.also || []).map((n) => str(n, 40)).filter((n) => n && !same(n, who)).slice(0, 6); // whoever else it's for
    const countdown = e.countdown !== undefined ? !!e.countdown : !!was.countdown;
    const remind = e.remind !== undefined ? remindMin(e.remind) : was.remind; // minutes before; -1 none; absent: the household's
    return { title, start: s.toISOString(), end: end.toISOString(), allDay, who, ...(who && also.length ? { also } : {}),
      ...(pick('place', 80) ? { place: pick('place', 80) } : {}), ...(pick('notes', 400) ? { notes: pick('notes', 400) } : {}),
      ...(repeat ? { repeat } : {}), ...(repeat && until ? { until } : {}), ...(countdown ? { countdown: true } : {}), ...(remind != null ? { remind } : {}), ...(repeat && was.skip ? { skip: was.skip } : {}) };
  }
  /** What this display keeps about a two-way synced event that its calendar doesn't: whose (when not the calendar's
   *  own person), a countdown, its reminder. By uid ("<calendar>:<id>"). [asked]: only what an update changed. */
  function keepOnSynced(uid, f, cal, asked = null) {
    const has = (k) => !asked || asked[k] !== undefined;
    if (has('who') || has('also')) {
      if ((f.who && !same(f.who, cal?.who)) || f.also?.length) data.whose[uid] = { who: f.who || null, ...(f.also?.length ? { also: f.also } : {}) };
      else delete data.whose[uid];
      const keys = Object.keys(data.whose); if (keys.length > 400) delete data.whose[keys[0]];
    }
    if (has('countdown')) data.countdowns = f.countdown ? [...new Set([...data.countdowns, uid])].slice(-40) : data.countdowns.filter((x) => x !== uid);
    if (has('remind')) { if (f.remind == null) delete data.reminds[uid]; else data.reminds[uid] = f.remind; }
  }
  /** Minutes before an event, from what was asked: 0 at the start, up to a day; "none"/false/-1 no reminder; null/"default" the household's. */
  function remindMin(v) {
    if (v === null || v === undefined || v === 'default') return undefined;
    if (v === false || v === 'none' || v === 'off' || Number(v) < 0) return -1;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(n, 1440) : undefined;
  }
  function changeEvents(a) {
    // One thing per call, and only one that was really asked for: the voice's backend sends every part of this tool at
    // once (an add with defaults and no title beside the remove it meant), so an add needs a title and a start, an
    // update an id, and a remove wins over everything else. (It had been adding "x" on 1 January instead of removing.)
    if (a.add && !(str(a.add.title) && str(a.add.start))) delete a.add;
    if (a.update && !str(a.update.id)) delete a.update;
    if (a.countdown && !(str(a.countdown.uid) || str(a.countdown.id))) delete a.countdown;
    if (a.remind && !(str(a.remind.uid) || str(a.remind.id))) delete a.remind;
    if (a.remove != null && ![].concat(a.remove).some((x) => str(x))) delete a.remove;
    if (a.remove) { delete a.add; delete a.update; delete a.countdown; delete a.remind; }
    else if (a.update) delete a.add;
    const sync = board.sync;
    if (a.add && sync && a.add.calendar !== 'here') { // into a two-way calendar (the person's, else the household's default)
      const f = eventFields(a.add);
      if (f.error) return f;
      const twin = sync.events().find((e) => e.editable && same(e.title, f.title) && Math.abs(new Date(e.start) - new Date(f.start)) <= 5 * 60e3);
      if (twin) { const r = changeEvents({ update: { ...a.add, id: twin.id, date: twin.date } }); return r.error ? r : { ...r, already: true, note: 'Already on the calendar, so it was changed rather than added again. Nothing more to add; to change it later, update it by id.' }; }
      const { countdown, remind, also, ...send } = f;
      const r = sync.add(send, a.add.calendar || null);
      if (r) {
        const k = /^c-([A-Za-z0-9]{8})-(.+)$/.exec(r.event.id), uid = `${k[1]}:${k[2]}`;
        keepOnSynced(uid, f, sync.calendars().find((c) => c.key === k[1]));
        save();
        return { ok: true, event: { ...f, id: r.event.id }, calendar: r.calendarName };
      }
    }
    if ((a.update || a.remove) && sync) { // one in a two-way calendar
      const ids = a.remove ? [].concat(a.remove).map(String) : [String(a.update.id)];
      if (ids.every((id) => sync.isMine(id))) {
        if (a.remove) {
          const gone = [], errs = [];
          for (const id of ids) { const r = sync.remove(id, ids.length === 1 && validDay(a.date) ? a.date : null); if (r.error) errs.push(r.error); else if (r.skipped) return { ok: true, removed: [], skipped: r.skipped, note: `Only ${r.skipped} is off; it still repeats. Leave out date to remove it entirely.` }; else gone.push(id); }
          return gone.length ? { ok: true, removed: gone } : { error: errs[0] };
        }
        const was = sync.events().find((e) => e.id === a.update.id && (!a.update.date || e.date === a.update.date)) || sync.events().find((e) => e.id === a.update.id);
        if (!was) return { error: `No event ${a.update.id}.` };
        const f = eventFields(a.update, was);
        if (f.error) return f;
        const { countdown, remind, also, who, ...send } = f;
        if (a.update.repeat === undefined && was.repeat === 'custom') send.repeat = 'custom'; // a rule this can't say: left as it is
        if (a.update.repeat === 'custom') send.repeat = 'custom';
        const r = sync.update(a.update.id, { ...send, date: was.date });
        if (r.error) return r;
        const k = /^c-([A-Za-z0-9]{8})-(.+)$/.exec(a.update.id), uid = `${k[1]}:${k[2]}`;
        keepOnSynced(uid, f, sync.calendars().find((c) => c.key === k[1]), a.update);
        save();
        return { ok: true, event: { ...was, ...f, id: a.update.id } };
      }
    }
    if (a.add) {
      const f = eventFields(a.add);
      if (f.error) return f;
      // The same event again (the same title within a few minutes of the same start): it's already there, so it's
      // changed rather than added twice.
      const twin = data.events.find((e) => same(e.title, f.title) && Math.abs(new Date(e.start) - new Date(f.start)) <= 5 * 60e3);
      if (twin) {
        for (const k of Object.keys(twin)) if (k !== 'id') delete twin[k];
        Object.assign(twin, f); save();
        return { ok: true, already: true, event: twin, note: 'Already on the calendar, so it was changed rather than added again. Nothing more to add; to change it later, update it by id.' };
      }
      const ev = { id: 'e-' + crypto.randomUUID().slice(0, 6), ...f };
      data.events.push(ev); prune(); save();
      return { ok: true, event: ev };
    }
    if (a.update) { // one added on the display: anything about it (what isn't given stays)
      const ev = data.events.find((e) => e.id === a.update.id);
      if (!ev) return { error: `No event ${a.update.id} added on the display (synced calendars are changed where they come from; a countdown on one is { countdown: { uid, on } }).` };
      const f = eventFields(a.update, ev);
      if (f.error) return f;
      for (const k of Object.keys(ev)) if (k !== 'id') delete ev[k];
      Object.assign(ev, f); save();
      return { ok: true, event: ev };
    }
    if (a.countdown) { // a synced event (by its uid), or one added here (by id): count down to it on Home and the idle screen
      const { uid, id, on = true } = a.countdown;
      const ev = id && data.events.find((e) => e.id === id);
      if (ev) { if (on) ev.countdown = true; else delete ev.countdown; save(); return { ok: true }; }
      if (!str(uid)) return { error: 'Which event (its uid, or id for one added here)?' };
      const u = str(uid, 140);
      data.countdowns = on ? [...new Set([...data.countdowns, u])].slice(-40) : data.countdowns.filter((x) => x !== u);
      save(); return { ok: true };
    }
    if (a.remind) { // a reminder on a synced event (by its uid), or one added here (by id); minutes: null for the household's
      const { uid, id } = a.remind, m = remindMin(a.remind.minutes);
      const ev = id && data.events.find((e) => e.id === id);
      if (ev) { if (m === undefined) delete ev.remind; else ev.remind = m; save(); return { ok: true }; }
      if (!str(uid)) return { error: 'Which event (its uid, or id for one added here)?' };
      const u = str(uid, 140);
      if (m === undefined) delete data.reminds[u]; else data.reminds[u] = m;
      const keys = Object.keys(data.reminds); if (keys.length > 200) delete data.reminds[keys[0]];
      save(); return { ok: true };
    }
    if (a.remove) {
      const ids = [].concat(a.remove).map(String), gone = [], missing = [];
      for (const id of ids) {
        const ev = data.events.find((e) => e.id === id);
        if (!ev) { missing.push(id); continue; }
        if (ev.repeat && validDay(a.date) && ids.length === 1) { ev.skip = [...new Set([...(ev.skip || []), a.date])]; save(); return { ok: true, removed: [], skipped: a.date, note: `Only ${a.date} is off; it still repeats ${ev.repeat}. Leave out date to remove it entirely.` }; }
        data.events = data.events.filter((e) => e !== ev); gone.push(id);
      }
      if (gone.length) save();
      if (!gone.length) return { error: `No event ${missing.join(', ')} added on the display (synced calendars can only be changed where they come from).` };
      return { ok: true, removed: gone, ...(missing.length ? { notFound: missing } : {}) };
    }
    return { error: 'add or remove' };
  }
  /** Opie changing a locked calendar (Settings, Calendar needs the PIN): it asks, and the tablet's card takes the PIN
   *  from a person, as the Calendar app's unlock does; then the calendar stays open a few minutes, as after that unlock.
   *  Nothing Opie says or types answers it (the card is the shell's own: DeviceAccess.approve). A computer's workshop
   *  is a grown-up's own (paired with the PIN), so it isn't asked. */
  async function calendarPin(a, ctx) {
    if (!data.settings.calendarLock || unlockedUntil > Date.now() || ctx?.workshop) return null;
    const changes = ['add', 'update', 'remove', 'countdown', 'remind'].some((k) => a?.[k] != null) ||
      (a?.settings && ['remind', 'remind_aloud', 'app_notes'].some((k) => a.settings[k] != null));
    if (!changes) return null;
    const what = a.add?.title ? `Add "${str(a.add.title, 60)}"` : a.update ? 'Change an event' : a.remove ? 'Remove an event' : 'Change the calendar';
    const r = await house.shell('/approve', { title: `${what} on the calendar?`, detail: 'Opie was asked to. The calendar needs the PIN.', pin: true, yes: 'Allow' }, 100_000);
    if (r?.yes === true) { unlockedUntil = Date.now() + 5 * 60e3; changed(); return null; }
    return { content: [{ type: 'text', text: r == null || r.why ? 'Not changed: the calendar needs the PIN, and the tablet can\'t ask for it right now. Someone can unlock it in the Calendar app.' : 'Not changed: the calendar needs the PIN, and nobody typed it on the tablet. Say so; they can ask again when someone is at the tablet.' }], isError: true };
  }
  const unlocked = () => unlockedUntil;
  function setUnlocked(ms) { unlockedUntil = ms; }
  return { occurrences, events, reminders, changeEvents, remindMin, calendarPin, unlocked, setUnlocked };
}
