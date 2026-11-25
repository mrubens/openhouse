// The family's lists (the Lists app): groceries, to do, and any they make.
import crypto from 'node:crypto';
import { ROOM, str, objs, same, arr } from './util.js';

export default function (house) {
  const { data, save } = house;
  function findList(name, create) {
    const n = str(name, 40) || 'Groceries';
    let l = data.lists.find((x) => same(x.id, n) || same(x.name, n) || same(x.name.replace(/s$/i, ''), n.replace(/s$/i, '')));
    if (!l && create) { l = { id: n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list-' + crypto.randomUUID().slice(0, 4), name: n[0].toUpperCase() + n.slice(1), items: [] }; data.lists.push(l); }
    return l;
  }
  const item = (l, ref) => l.items.find((i) => i.id === ref) || l.items.find((i) => same(i.text, ref)) ||
    l.items.find((i) => str(i.text).toLowerCase().includes(str(ref).toLowerCase()) && str(ref).length > 2);
  function changeList(a) {
    const l = findList(a.list, arr(a.add).length > 0 || a.create);
    if (!l) return { error: `No list "${str(a.list)}". Lists: ${data.lists.map((x) => x.name).join(', ')}.` };
    const did = [];
    { const adding = new Set(arr(a.add).filter((t) => !l.items.some((i) => same(i.text, t))).map((t) => t.toLowerCase()));
      if (adding.size && l.items.length + adding.size > ROOM.listItems)
        return { error: `${l.name} is full (${ROOM.listItems} things). Clear the checked ones or take some off first.`, code: 'full' }; }
    if (a.byAisle !== undefined) { l.byAisle = !!a.byAisle; did.push(a.byAisle ? 'sorted by aisle' : 'in the order added'); }
    for (const t of arr(a.add)) {
      const was = l.items.find((i) => same(i.text, t));
      if (was) { if (was.done) { was.done = false; did.push(`put ${was.text} back on`); } else did.push(`${was.text} was already on it`); continue; }
      l.items.push({ id: crypto.randomUUID().slice(0, 8), text: t[0].toUpperCase() + t.slice(1), done: false, who: str(a.who, 40) || null, at: Date.now() });
      did.push(`added ${t}`);
    }
    for (const [refs, done] of [[arr(a.check), true], [arr(a.uncheck), false]]) for (const r of refs) {
      const i = item(l, r); if (!i) { did.push(`no "${r}" on it`); continue; }
      i.done = done; i.doneAt = done ? Date.now() : null; did.push(`${done ? 'checked off' : 'unchecked'} ${i.text}`);
    }
    for (const r of arr(a.remove)) {
      const i = item(l, r); if (!i) { did.push(`no "${r}" on it`); continue; }
      l.items = l.items.filter((x) => x !== i); did.push(`removed ${i.text}`);
    }
    for (const e of objs(a.edit)) {
      const i = item(l, e?.item ?? e?.id); if (!i) { did.push(`no "${str(e?.item ?? e?.id)}" on it`); continue; }
      const t = str(e.text, 200).trim(); if (t) i.text = t[0].toUpperCase() + t.slice(1);
      if ('who' in e) i.who = str(e.who, 40) || null;
      did.push(`changed ${i.text}`);
    }
    if (a.clearChecked) { const n = l.items.filter((i) => i.done).length; l.items = l.items.filter((i) => !i.done); did.push(`cleared ${n} checked`); }
    if (a.rename) { const n = str(a.rename, 40).trim(); if (n && !data.lists.some((x) => x !== l && same(x.name, n))) l.name = n; else if (n) did.push(`there's already a list called ${n}`); }
    if (a.deleteList) data.lists = data.lists.filter((x) => x !== l);
    save();
    return { ok: true, list: l.name, did };
  }
  return { findList, changeList };
}
