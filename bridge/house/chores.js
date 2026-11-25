// Chores (the Chores app): which are up today, who did them, streaks and the stars they earn. The chores themselves
// are in household.json (board.js), where setup and update_household keep them; their checkmarks are in house.json.
import { WEEKDAYS, PICS, dayKey, daysFrom, validDay, daysBetween, str, same, low, guessPic } from './util.js';

export default function (house) {
  const { data, save, prune, household, board } = house;
  const choreKey = (c) => `${low(c.who)}|${str(c.task).toLowerCase()}`;
  const doneOn = (c, d) => (data.done[dayKey(d)] || []).includes(choreKey(c));
  /** Is it a day for this chore? By weekday (none: every day); every N days from a day (since); or N days after it
   *  was last done (after: the day it's done, and until it's due again, it isn't up). */
  const todayIs = (c, d = new Date()) => {
    if (c.every >= 2) {
      if (c.after) { for (let i = 1; i < c.every; i++) if (doneOn(c, daysFrom(-i, d))) return false; return true; }
      const n = daysBetween(c.since ? new Date(c.since + 'T12:00') : d, d);
      return n >= 0 && n % c.every === 0;
    }
    return !c.days?.length || c.days.includes(WEEKDAYS[d.getDay()]);
  };
  /** A chore that waits until done (keep): days since its last day came round undone; 0 when it isn't late. */
  function lateBy(c) {
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
    return (household().chores || []).map((c) => {
      const late = lateBy(c), done = (data.done[today] || []).includes(choreKey(c));
      return {
      who: c.who || '', task: c.task, ...(c.days?.length && !c.every ? { days: c.days } : {}), ...(c.every ? { every: c.every, ...(c.after ? { after: true } : {}) } : {}), today: todayIs(c) || late > 0, stars: c.stars || 1,
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
  function saveChores(list) { board.saveHousehold({ chores: list }, { quiet: true }); }
  function changeChores(a) {
    const did = [];
    let list = [...(household().chores || [])];
    const match = (c, x) => same(c.task, x.task) && (!x.who || same(c.who, x.who));
    const fuzzy = (x) => list.find((c) => match(c, x)) || list.find((c) => (!x.who || same(c.who, x.who)) && str(c.task).toLowerCase().includes(str(x.task).toLowerCase()) && str(x.task).length > 2);
    const adds = (a.add ? [].concat(a.add) : []).filter((x) => str(x?.task));
    const removes = (a.remove ? [].concat(a.remove) : []).filter((x) => str(x?.task));
    const updates = (a.update ? [].concat(a.update) : []).filter((x) => str(x?.task));
    const dayList = (v) => { const d = (v || []).map((x) => String(x).slice(0, 3).toLowerCase()).filter((x) => WEEKDAYS.includes(x)); return d.length && d.length < 7 ? d : null; };
    const starsOf = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 10 ? n : null; };
    /** every: N days (2 to 90), from today, or after it's done (after); 0/null: by weekday again. */
    const setEvery = (c, every, after) => {
      const n = Math.round(Number(every));
      if (n >= 2 && n <= 90) { c.every = n; delete c.days; if (after) { c.after = true; delete c.since; } else { delete c.after; c.since = dayKey(); } }
      else { delete c.every; delete c.after; delete c.since; }
    };
    if (adds.length || removes.length || updates.length) {
      for (const x of adds) {
        if (list.some((c) => match(c, x) && same(c.who, x.who))) { did.push(`${x.task} was already there`); continue; }
        const days = dayList(x.days), n = starsOf(x.stars);
        const c = { who: str(x.who, 40), task: str(x.task), ...(days ? { days } : {}), ...(n > 1 ? { stars: n } : {}), ...(PICS.includes(x.pic) ? { pic: x.pic } : {}), ...(x.keep ? { keep: true } : {}) };
        if (x.every) setEvery(c, x.every, x.after);
        list.push(c); did.push(`added ${x.task}${x.who ? ` for ${x.who}` : ''}`);
      }
      // Removing matches exactly (who and task) first; a near match only when it's the only one.
      for (const x of removes) {
        const exact = list.filter((c) => match(c, x)), c = exact.length === 1 ? exact[0] : exact.length ? null : fuzzy(x);
        if (!c) { did.push(exact.length ? `which "${x.task}"? say whose` : `no chore "${x.task}"`); continue; }
        list = list.filter((y) => y !== c); did.push(`removed ${c.task}`);
      }
      // Changing one: its words, whose, which days, how many stars. Today's tick and this week's go with it.
      for (const x of updates) {
        const c = list.find((y) => match(y, x)); if (!c) { did.push(`no chore "${x.task}"`); continue; }
        const to = x.to || {}, was = choreKey(c);
        if (str(to.task)) c.task = str(to.task);
        if (to.who !== undefined) c.who = str(to.who, 40);
        if (to.days !== undefined) { const d = dayList(to.days); if (d) c.days = d; else delete c.days; }
        if (to.stars !== undefined) c.stars = starsOf(to.stars) || 1; // (1 is the usual: not kept)
        if (to.pic !== undefined) { if (PICS.includes(to.pic)) c.pic = to.pic; else delete c.pic; }
        if (to.keep !== undefined) { if (to.keep) c.keep = true; else delete c.keep; }
        if (to.every !== undefined) setEvery(c, to.every, to.after ?? c.after);
        else if (to.after !== undefined && c.every) setEvery(c, c.every, to.after);
        if (to.every === undefined && to.days !== undefined && dayList(to.days)) { delete c.every; delete c.after; delete c.since; }
        const now = choreKey(c);
        if (now !== was) for (const m of [data.done, data.skipped]) for (const k of Object.keys(m)) m[k] = m[k].map((y) => (y === was ? now : y));
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
      did.push(`${value ? 'done' : 'not done'}: ${who ? who + ' ' : ''}${c.task}`);
    }
    prune(); save();
    return { ok: true, did };
  }
  return { choreKey, chores, streaks, stars, starsView, changeChores };
}
