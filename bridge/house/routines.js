// Routines (checklists: morning, bedtime): a few steps with pictures, shown in the Chores app during their hours.
import crypto from 'node:crypto';
import { WEEKDAYS, PICS, dayKey, hhmm, minutes, str, same, low, arr, guessPic } from './util.js';

export default function (house) {
  const { data, save, prune } = house;
  const activeNow = (c, d = new Date()) => {
    if (c.days?.length && !c.days.includes(WEEKDAYS[d.getDay()])) return false;
    const m = d.getHours() * 60 + d.getMinutes(), a = minutes(c.from), b = minutes(c.to);
    return a <= b ? m >= a && m < b : m >= a || m < b;
  };
  function checklists() {
    const today = data.checked[dayKey()] || [];
    return data.checklists.map((c) => ({ ...c, now: activeNow(c), done: today.filter((k) => k.startsWith(c.id + '|')).map((k) => k.slice(c.id.length + 1)) }));
  }
  // ---- checklists (morning, bedtime): a few steps with pictures, shown during their hours ----
  function steps(list) {
    return [].concat(list || []).map((s) => (typeof s === 'string' ? { text: s } : s)).filter((s) => str(s?.text))
      .map((s) => ({ text: str(s.text, 40), pic: PICS.includes(s.pic) ? s.pic : guessPic(s.text) })).slice(0, 10);
  }
  const findChecklist = (ref) => data.checklists.find((c) => c.id === ref || same(c.name, ref));
  function checklistFields(x, into = {}) {
    if (x.name != null) into.name = str(x.name, 30) || into.name || 'Routine';
    if (x.who != null) into.who = arr(x.who).map((w) => str(w, 40));
    if (x.from != null) into.from = hhmm(x.from, into.from || '06:30');
    if (x.to != null) into.to = hhmm(x.to, into.to || '09:00');
    if (x.days != null) { const d = arr(x.days).map((y) => y.slice(0, 3).toLowerCase()).filter((y) => WEEKDAYS.includes(y)); if (d.length && d.length < 7) into.days = d; else delete into.days; }
    if (x.steps != null) into.steps = steps(x.steps);
    return into;
  }
  function changeChecklists(a) {
    const did = [];
    for (const x of (a.add ? [].concat(a.add) : []).filter((y) => str(y?.name))) {
      if (findChecklist(x.name)) { did.push(`${x.name} is already there (update it instead)`); continue; }
      const c = checklistFields({ from: '06:30', to: '09:00', who: [], steps: [], ...x }, { id: 'c-' + crypto.randomUUID().slice(0, 6) });
      data.checklists.push(c); did.push(`added ${c.name}`);
    }
    for (const x of (a.update ? [].concat(a.update) : [])) {
      const c = findChecklist(x?.id || x?.name); if (!c) { did.push(`no routine "${x?.id || x?.name}"`); continue; }
      checklistFields({ ...x, name: x.rename ?? (x.id ? x.name : undefined) }, c); did.push(`changed ${c.name}`);
    }
    for (const ref of arr(a.remove)) { const c = findChecklist(ref); if (!c) { did.push(`no routine "${ref}"`); continue; } data.checklists = data.checklists.filter((y) => y !== c); did.push(`removed ${c.name}`); }
    for (const x of (a.check ? [].concat(a.check) : [])) {
      const c = findChecklist(x?.id || x?.name); const step = c?.steps.find((s) => same(s.text, x.step));
      if (!c || !step) { did.push(`no step "${x?.step}"`); continue; }
      const day = dayKey(), k = `${c.id}|${step.text}|${low(x.who)}`, set = new Set(data.checked[day] || []);
      x.done === false ? set.delete(k) : set.add(k); data.checked[day] = [...set];
      did.push(`${x.done === false ? 'unchecked' : 'checked'} ${step.text}${x.who ? ` for ${x.who}` : ''}`);
    }
    prune(); save();
    return { ok: true, did };
  }
  return { activeNow, checklists, changeChecklists };
}
