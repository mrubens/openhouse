// Chores (the Chores app): which are up today, who did them, streaks and the stars they earn. The chores themselves
// are in household.json (board.js), where setup and update_household keep them; their checkmarks are in house.json.
// A chore repeats (every day, some weekdays, every few days) or is for one day (date). One for a day that isn't done
// stays, late, until it's done or taken off. A chore can have a time (at) and a reminder at that time (remind): it's
// one of the reminders due (house.reminders, with the events'), so it shows on the display and buzzes whose it is.
import { WEEKDAYS, PICS, dayKey, daysFrom, validDay, daysBetween, str, same, low, guessPic } from './util.js';

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

export default function (house) {
  const { data, save, prune, household, board } = house;
  const choreKey = (c) => `${low(c.who)}|${str(c.task).toLowerCase()}`;
  const doneOn = (c, d) => (data.done[dayKey(d)] || []).includes(choreKey(c));
  const onceKey = (c) => `${choreKey(c)}|${c.date}`;
  /** A chore for one day: the day it was done, or null. */
  const doneOnce = (c) => (c.date && data.onceDone[onceKey(c)]) || null;
  /** Is it a day for this chore? By weekday (none: every day); every N days from a day (since); or N days after it
   *  was last done (after: the day it's done, and until it's due again, it isn't up). */
  const todayIs = (c, d = new Date()) => {
    if (c.date) return dayKey(d) === c.date;
    if (c.every >= 2) {
      if (c.after) { for (let i = 1; i < c.every; i++) if (doneOn(c, daysFrom(-i, d))) return false; return true; }
      const n = daysBetween(c.since ? new Date(c.since + 'T12:00') : d, d);
      return n >= 0 && n % c.every === 0;
    }
    return !c.days?.length || c.days.includes(WEEKDAYS[d.getDay()]);
  };
  /** A chore that waits until done (keep): days since its last day came round undone; 0 when it isn't late. */
  function lateBy(c) {
    if (c.date) return !doneOnce(c) && c.date < dayKey() ? daysBetween(new Date(c.date + 'T12:00'), new Date()) : 0;
    if (!c.keep || !(c.days?.length || (c.every >= 2 && !c.after)) || todayIs(c)) return 0;
    for (let i = 1; i <= Math.max(14, c.every || 0); i++) {
      const d = daysFrom(-i);
      if ((data.done[dayKey(d)] || []).includes(choreKey(c)) || (data.skipped[dayKey(d)] || []).includes(choreKey(c))) return 0;
      if (todayIs(c, d)) return i;
    }
    return 0;
  }
  function chores() {
    const today = dayKey(), week = [...Array(7)].map((_, i) => dayKey(daysFrom(-i)));
    // (one for a day that was done before today is finished with: not shown)
    return (household().chores || []).filter((c) => !(doneOnce(c) && doneOnce(c) < today)).map((c) => {
      const late = lateBy(c), done = (data.done[today] || []).includes(choreKey(c));
      return {
      who: c.who || '', task: c.task, ...(c.date ? { date: c.date } : c.days?.length && !c.every ? { days: c.days } : {}), ...(c.every && !c.date ? { every: c.every, ...(c.after ? { after: true } : {}) } : {}),
      ...(c.at ? { at: c.at, ...(c.remind ? { remind: true } : {}) } : {}), today: todayIs(c) || late > 0 || (!!c.date && doneOnce(c) === today), stars: c.stars || 1,
      pic: PICS.includes(c.pic) ? c.pic : guessPic(c.task), ...(c.keep ? { keep: true } : {}), ...(late && !done ? { late } : {}),
      done: (data.done[today] || []).includes(choreKey(c)),
      ...((data.skipped[today] || []).includes(choreKey(c)) ? { skipped: true } : {}),
      ...(data.by[`${today}|${choreKey(c)}`] ? { by: data.by[`${today}|${choreKey(c)}`] } : {}),
      week: week.filter((k) => (data.done[k] || []).includes(choreKey(c))).length, // days done this past week
      };
    });
  }
  /** Days in a row each person did all their chores for the day (skipped ones don't break it; today counts once
   *  it's all done, and doesn't break it before). Days with nothing for them are passed over. */
  function streaks() {
    const out = {}, list = household().chores || [];
    for (const who of new Set(list.map((c) => c.who).filter(Boolean))) {
      const mine = list.filter((c) => same(c.who, who) && !c.after); // (after-done ones have no fixed day)
      let n = 0;
      for (let i = 0; i <= 60; i++) {
        const d = daysFrom(-i), k = dayKey(d), due = mine.filter((c) => todayIs(c, d));
        if (!due.length) continue;
        const all = due.every((c) => (data.done[k] || []).includes(choreKey(c)) || (data.skipped[k] || []).includes(choreKey(c)));
        if (all) n++; else if (i > 0) break;
      }
      if (n >= 2) out[who] = n;
    }
    return out;
  }
  const stars = (who) => Math.max(0, (data.earned[low(who)] || 0) - (data.spent[low(who)] || 0));
  function starsView() {
    const names = new Set([...(household().family || []).map((f) => f.name), ...(household().chores || []).map((c) => c.who).filter(Boolean)]);
    return Object.fromEntries([...names].map((n) => [n, stars(n)]));
  }
  /** Reminders due now for chores with a time and Remind me: on a day it's up, from its time for an hour, until it's
   *  done, skipped or put away (house.reminders adds these to the events'). who: whose it is (nobody's buzzes no phone). */
  function choreReminders(now = Date.now()) {
    const d = new Date(now), day = dayKey(d), away = new Set(data.reminded), out = [];
    for (const c of household().chores || []) {
      if (!c.remind || !TIME.test(c.at || '') || !todayIs(c, d)) continue;
      const k = choreKey(c), at = new Date(`${day}T${c.at}:00`).getTime(), key = `chore|${k}|${day}`;
      if (now < at || now >= at + 60 * 60e3 || away.has(key) || (data.done[day] || []).includes(k) || (data.skipped[day] || []).includes(k)) continue;
      out.push({ key, title: c.task, start: new Date(at).toISOString(), who: c.who || null, open: 'chores' });
    }
    return out;
  }
  /** Chores due now for whose they are, for the phones that asked to hear of them (chosen-buzz.js): one with a time,
   *  from its time for an hour; one without, from [untimed] for an hour. Not one with Remind me (that one already
   *  buzzes, above), nor done, skipped or nobody's. */
  function choresDue(now = Date.now(), untimed = '17:00') {
    const d = new Date(now), day = dayKey(d), out = [];
    for (const c of household().chores || []) {
      if (!c.who || c.remind || !todayIs(c, d)) continue;
      const k = choreKey(c), at = new Date(`${day}T${TIME.test(c.at || '') ? c.at : untimed}:00`).getTime();
      if (now < at || now >= at + 60 * 60e3 || (data.done[day] || []).includes(k) || (data.skipped[day] || []).includes(k)) continue;
      out.push({ key: `due|${k}|${day}`, who: c.who, task: c.task, ...(TIME.test(c.at || '') ? { at: c.at } : {}) });
    }
    return out;
  }
  /** Saved with one-day chores done over two months ago left out (their checkmarks are gone by then too). */
  function saveChores(list) {
    const cut = dayKey(daysFrom(-60)), keep = list.filter((c) => !(c.date && doneOnce(c) && doneOnce(c) < cut));
    for (const c of list) if (!keep.includes(c)) delete data.onceDone[onceKey(c)];
    // (each field it doesn't have said so: the household keeps one left out as it was, which would put a cleared one back)
    board.saveHousehold({ chores: keep.map((c) => ({ keep: false, every: 0, after: false, since: null, date: null, at: null, remind: false, ...c })) }, { quiet: true });
  }
  /** by: who did it, when known (a phone's person, the one Opie was talking to): chosen-buzz.js doesn't tell them. */
  function changeChores(a, { by = null } = {}) {
    const did = [];
    let list = [...(household().chores || [])];
    const match = (c, x) => same(c.task, x.task) && (!x.who || same(c.who, x.who));
    const fuzzy = (x) => list.find((c) => match(c, x)) || list.find((c) => (!x.who || same(c.who, x.who)) && str(c.task).toLowerCase().includes(str(x.task).toLowerCase()) && str(x.task).length > 2);
    const adds = (a.add ? [].concat(a.add) : []).filter((x) => str(x?.task));
    const removes = (a.remove ? [].concat(a.remove) : []).filter((x) => str(x?.task));
    const updates = (a.update ? [].concat(a.update) : []).filter((x) => str(x?.task));
    const dayList = (v) => { const d = (v || []).map((x) => String(x).slice(0, 3).toLowerCase()).filter((x) => WEEKDAYS.includes(x)); return d.length && d.length < 7 ? d : null; };
    const starsOf = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 10 ? n : null; };
    /** date: once, on that day (no weekdays, no every); empty or null: it repeats again. */
    const setDate = (c, v) => {
      if (validDay(v)) { c.date = v; delete c.days; delete c.every; delete c.after; delete c.since; delete c.keep; }
      else delete c.date;
    };
    /** at: its time ("16:30"); remind: a reminder then (only with a time). */
    const setTime = (c, at, remind) => {
      if (at !== undefined) { const t = TIME.test(String(at || '')) ? String(at).padStart(5, '0') : null; if (t) c.at = t; else { delete c.at; delete c.remind; } }
      if (remind !== undefined) { if (remind && c.at) c.remind = true; else delete c.remind; }
    };
    /** every: N days (2 to 90), from today, or after it's done (after); 0/null: by weekday again. */
    const setEvery = (c, every, after) => {
      const n = Math.round(Number(every));
      if (n >= 2 && n <= 90) { c.every = n; delete c.days; if (after) { c.after = true; delete c.since; } else { delete c.after; c.since = dayKey(); } }
      else { delete c.every; delete c.after; delete c.since; }
    };
    if (adds.length || removes.length || updates.length) {
      for (const x of adds) {
        // (one for a day that's done and gone gives way to the new one)
        const gone = list.find((c) => match(c, x) && same(c.who, x.who) && doneOnce(c) && doneOnce(c) < dayKey());
        if (gone) { list = list.filter((c) => c !== gone); delete data.onceDone[onceKey(gone)]; }
        if (list.some((c) => match(c, x) && same(c.who, x.who))) { did.push(`${x.task} was already there`); continue; }
        const days = dayList(x.days), n = starsOf(x.stars);
        const c = { who: str(x.who, 40), task: str(x.task), ...(days ? { days } : {}), ...(n > 1 ? { stars: n } : {}), ...(PICS.includes(x.pic) ? { pic: x.pic } : {}), ...(x.keep ? { keep: true } : {}) };
        if (x.every) setEvery(c, x.every, x.after);
        if (x.date) setDate(c, x.date);
        setTime(c, x.at, x.remind);
        list.push(c); did.push(`added ${x.task}${x.who ? ` for ${x.who}` : ''}`);
      }
      // Removing matches exactly (who and task) first; a near match only when it's the only one.
      for (const x of removes) {
        const exact = list.filter((c) => match(c, x)), c = exact.length === 1 ? exact[0] : exact.length ? null : fuzzy(x);
        if (!c) { did.push(exact.length ? `which "${x.task}"? say whose` : `no chore "${x.task}"`); continue; }
        list = list.filter((y) => y !== c); if (c.date) delete data.onceDone[onceKey(c)]; did.push(`removed ${c.task}`);
      }
      // Changing one: its words, whose, which days, how many stars. Today's tick and this week's go with it.
      for (const x of updates) {
        const c = list.find((y) => match(y, x)); if (!c) { did.push(`no chore "${x.task}"`); continue; }
        const to = x.to || {}, was = choreKey(c), wasOnce = c.date ? onceKey(c) : null, wasDate = c.date;
        if (str(to.task)) c.task = str(to.task);
        if (to.who !== undefined) c.who = str(to.who, 40);
        if (to.days !== undefined) { const d = dayList(to.days); if (d) c.days = d; else delete c.days; }
        if (to.stars !== undefined) c.stars = starsOf(to.stars) || 1; // (1 is the usual: not kept)
        if (to.pic !== undefined) { if (PICS.includes(to.pic)) c.pic = to.pic; else delete c.pic; }
        if (to.keep !== undefined) { if (to.keep) c.keep = true; else delete c.keep; }
        if (to.every !== undefined) setEvery(c, to.every, to.after ?? c.after);
        else if (to.after !== undefined && c.every) setEvery(c, c.every, to.after);
        if (to.every === undefined && to.days !== undefined && dayList(to.days)) { delete c.every; delete c.after; delete c.since; }
        // a day of its own, or repeating again (weekdays or every few days given: the day goes)
        if (to.date !== undefined) setDate(c, to.date);
        else if (c.date && ((to.days !== undefined && dayList(to.days)) || Number(to.every) >= 2)) setDate(c, null);
        setTime(c, to.at, to.remind);
        const now = choreKey(c);
        if (now !== was) for (const m of [data.done, data.skipped]) for (const k of Object.keys(m)) m[k] = m[k].map((y) => (y === was ? now : y));
        // done once: still done under its new words; a new day (or repeating now) is a fresh one
        if (wasOnce && data.onceDone[wasOnce]) { const d = data.onceDone[wasOnce]; delete data.onceDone[wasOnce]; if (c.date === wasDate) data.onceDone[onceKey(c)] = d; }
        did.push(`changed ${c.task}`);
      }
      try { saveChores(list); } catch (e) { if (e.code === 'full') return { error: e.message, code: 'full' }; throw e; }
    }
    // Skipped for a day (away, sick): not left to do, no stars, and it doesn't count against anyone.
    for (const [refs, value] of [[a.skip, true], [a.unskip, false]]) for (const x of (refs ? [].concat(refs) : []).filter((y) => str(y?.task))) {
      const c = fuzzy(x); if (!c) { did.push(`no chore "${x.task}"`); continue; }
      const day = validDay(x.date) ? x.date : dayKey(), set = new Set(data.skipped[day] || []);
      value ? set.add(choreKey(c)) : set.delete(choreKey(c)); data.skipped[day] = [...set];
      did.push(`${value ? 'skipped' : 'back on'}: ${c.task}`);
    }
    for (const [refs, value] of [[a.done, true], [a.undone, false]]) for (const x of (refs ? [].concat(refs) : []).filter((y) => str(y?.task))) {
      const c = fuzzy(x); if (!c) { did.push(`no chore "${x.task}"${x.who ? ` for ${x.who}` : ''}`); continue; }
      const day = validDay(x.date) ? x.date : dayKey(), k = choreKey(c);
      const set = new Set(data.done[day] || []), had = set.has(k);
      value ? set.add(k) : set.delete(k); data.done[day] = [...set];
      // Its stars go to whose it is; a chore anyone could do earns them for whoever did it (x.by).
      const byKey = `${day}|${k}`, who = c.who || (value ? str(x.by, 40) : data.by[byKey]) || '', w = low(who);
      if (!c.who) { if (value && w) data.by[byKey] = who; else if (!value) delete data.by[byKey]; }
      if (w && had !== value) data.earned[w] = Math.max(0, (data.earned[w] || 0) + (value ? 1 : -1) * (c.stars || 1));
      if (value) data.skipped[day] = (data.skipped[day] || []).filter((y) => y !== k);
      // one for a day: done (on whatever day it was) puts it away after that day; not done brings it back
      if (c.date) { if (value) data.onceDone[onceKey(c)] = day; else if (data.onceDone[onceKey(c)] === day) delete data.onceDone[onceKey(c)]; }
      did.push(`${value ? 'done' : 'not done'}: ${who ? who + ' ' : ''}${c.task}`);
      if (value && !had && who) house.noticed?.('choreDone', { who, task: c.task, by });
    }
    prune(); save();
    return { ok: true, did };
  }
  return { choreKey, chores, choreReminders, choresDue, streaks, stars, starsView, changeChores };
}
