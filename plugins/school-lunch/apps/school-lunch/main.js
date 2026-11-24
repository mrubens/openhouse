// School lunch: each kid's school lunch menu for the week, from Nutrislice (the link the household pastes per kid), with
// today marked. Kids at the same school share one row. Today's lunch shows on Today through the calendar's day notes (kit days.set),
// and the voice can ask for any day's (app.json "lunch" and "week"). The menus are fetched through the tablet (kit
// web.json: Nutrislice's API doesn't let other pages read it), this week and next, once a day and when it's opened,
// and kept in the app's own store so it works offline.
import { house, store, today, days, web, onAction } from '/kit/openhouse.js';
import { parseLink, menuKey, weekUrl, weekMenus, everyDay, sayDay, dayKey, dateOf, addDays, and } from './menu.js';

// ---- small helpers ----
const $app = document.getElementById('app');
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'tap') el.addEventListener('click', (e) => { e.stopPropagation(); v(e); });
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const weekday = (k, long = false) => dateOf(k).toLocaleDateString('en-US', { weekday: long ? 'long' : 'short' });
const monthDay = (k) => dateOf(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const hm = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const sunday = (k) => addDays(k, -dateOf(k).getDay());
/** The first week shown: this one, or from Saturday on the coming one. */
const firstWeek = (k = dayKey()) => addDays(sunday(k), dateOf(k).getDay() === 6 ? 7 : 0);

// ---- state ----
let kids = [];          // [{name, link}] (store "setup")
const uniqPics = (a) => [...new Set(a)];
let saved = { menus: {}, at: 0 }; // store "menus": { menus: { key: { days: {date: dayMenu}, at, error? } }, at }
let family = [];        // the household's names (house.family)
let week = 0;           // 0 this week, 1 next
let asked = null;       // {day, who} the voice last asked about: marked on the page
let editing = null;     // the setup sheet's rows while it's open
let loading = false;

/** The kids, grouped by the menu they share: [{ key, menu: {district, school, type}, names }]. */
function groups() {
  const out = new Map();
  for (const k of kids) {
    const m = parseLink(k.link); if (!m) continue;
    const key = menuKey(m);
    if (!out.has(key)) out.set(key, { key, menu: m, names: [] });
    if (k.name) out.get(key).names.push(k.name);
  }
  return [...out.values()];
}
const daysOf = (key) => saved.menus[key]?.days || {};

// ---- fetching ----
async function refresh({ force = false } = {}) {
  const gs = groups();
  if (!gs.length || loading) return;
  const fresh = saved.v === 3 && Date.now() - (saved.at || 0) < 20 * 3600e3 && dayKey(new Date(saved.at)) === dayKey(); // v3: with every dish's photo
  if (fresh && !force && gs.every((g) => saved.menus[g.key]?.weeks?.includes(addDays(firstWeek(), 7)))) { update(); return; }
  loading = true; draw();
  const t = dayKey(), base = firstWeek(t);
  for (const g of gs) {
    const was = saved.menus[g.key] || { days: {} };
    try {
      const weeks = await Promise.all([base, addDays(base, 7)].map((d) => web.json(weekUrl(g.menu, addDays(d, 1)))));
      const days = Object.assign({}, ...weeks.map(weekMenus));
      // (older days kept a week, so last week's view isn't empty; the fetched weeks replace what they cover)
      const keep = Object.fromEntries(Object.entries(was.days).filter(([d]) => d >= addDays(sunday(t), -7) && d < base));
      saved.menus[g.key] = { days: { ...keep, ...days }, at: Date.now(), weeks: [base, addDays(base, 7)] };
    } catch (e) {
      saved.menus[g.key] = { ...was, error: String(e.message || e).slice(0, 160) };
    }
  }
  for (const k of Object.keys(saved.menus)) if (!gs.some((g) => g.key === k)) delete saved.menus[k];
  if (gs.every((g) => !saved.menus[g.key].error)) { saved.at = Date.now(); saved.v = 3; }
  loading = false;
  await store.set('menus', saved);
  update();
}
/** One day's menu for a group, fetching its week if it isn't kept (a day further ahead). */
async function menuOn(g, d) {
  if (!(d in daysOf(g.key)) && !saved.menus[g.key]?.weeks?.includes(sunday(d))) {
    try {
      const days = weekMenus(await web.json(weekUrl(g.menu, d)));
      const m = saved.menus[g.key] || (saved.menus[g.key] = { days: {}, at: Date.now() });
      Object.assign(m.days, days);
      m.weeks = [...new Set([...(m.weeks || []), sunday(d)])].slice(-6);
      store.set('menus', saved);
    } catch {}
  }
  return daysOf(g.key)[d] || null;
}

// ---- the line on Today ----
let lineFor = null;
// Today's lunch is on Today through the calendar (Today's calendar card shows the day's notes), so this app's own line
// on Today, from before, is taken down once and not put up again.
let cleared = false;
function todayLine() { if (!cleared) { cleared = true; today.clear(); } }
// ---- on the calendar: each school day's lunch, a note on that day (kit days.set), the next two weeks. A note, not an
// event: nobody has to be anywhere for it. Label "Lunch", the main dish as the short words, the whole of it as the text;
// whose it is when the kids are at different schools.
let daysFor = null;
function calendarDays() {
  const t = dayKey(), gs = groups(), list = [];
  for (const g of gs) for (const [d, m] of Object.entries(daysOf(g.key))) {
    if (d < t || d > addDays(t, 14) || !m?.main?.length) continue;
    const other = (m.also || []).find((x) => x !== m.main[0]);
    const pics = [m.main[0], other].filter(Boolean).map((x) => ({ text: x, ...(m.pics?.[x] ? { image: m.pics[x] } : {}) }));
    list.push({ pics, date: d, label: 'School lunch', short: m.main[0], text: `${m.main[0]}${other ? ` or ${other}` : ''}`, ...(gs.length > 1 && g.names.length ? { who: and(g.names) } : {}) });
  }
  const key = JSON.stringify(list);
  if (key === daysFor) return;
  daysFor = key;
  days.set(list);
}
function update() { todayLine(); calendarDays(); draw(); }

// ---- the page ----
function draw() {
  const gs = groups(), t = dayKey();
  const start = addDays(firstWeek(t), 7 * week);
  const all = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
  // weekdays always; a weekend day only when one of the menus has something on it
  const shown = all.filter((d) => { const w = dateOf(d).getDay(); return (w > 0 && w < 6) || gs.some((g) => daysOf(g.key)[d]); });
  const err = gs.map((g) => saved.menus[g.key]?.error).find(Boolean);

  const top = h('div', { class: 'top' },
    h('h1', { class: 'title' }, 'School lunch'),
    gs.length ? h('div', { class: 'weeks' },
      [0, 1].map((w) => h('button', { class: 'chip' + (week === w ? ' on' : ''), tap: () => { week = w; draw(); } }, `Week of ${monthDay(addDays(firstWeek(t), 7 * w + 1))}`))) : null,
    h('button', { class: 'btn soft', tap: openSetup }, gs.length ? 'Kids and schools' : 'Set up'));

  if (!gs.length) {
    $app.replaceChildren(top, h('div', { class: 'empty' },
      h('p', { class: 'lead' }, 'See what each kid’s school is serving for lunch this week.'),
      h('p', { class: 'soft' }, 'Many schools post their menus on Nutrislice. Open your kid’s menu there, copy the address, and add it here with their name.'),
      h('button', { class: 'btn', tap: openSetup }, 'Add a kid')));
    return;
  }

  const rows = gs.map((g) => {
    const days = daysOf(g.key), daily = everyDay(days);
    return h('section', { class: 'group' },
      h('div', { class: 'who' }, h('span', { class: 'names' }, and(g.names) || 'Lunch'), h('span', { class: 'school' }, g.menu.school.replace(/[-_]+/g, ' '))),
      h('div', { class: 'days', style: `--n:${shown.length}` }, shown.map((d) => {
        const m = days[d], isAsked = asked && asked.day === d && (!asked.who || g.names.includes(asked.who));
        return h('div', { class: 'day' + (d === t ? ' today' : '') + (d < t ? ' past' : '') + (isAsked ? ' asked' : '') },
          h('div', { class: 'dow' }, d === t ? 'Today' : weekday(d), h('span', { class: 'date' }, monthDay(d))),
          !m ? h('div', { class: 'none' }, loading && !Object.keys(days).length ? '' : 'No menu')
            : m.note ? h('div', { class: 'none' }, m.note)
              : [(() => { // every picture on the day's menu, main dishes first, in a row above the words
                  const ps = uniqPics([...m.main, ...m.sides, ...m.also.filter((x) => !daily.includes(x))].map((x) => m.pics?.[x]).filter(Boolean));
                  return ps.length ? h('div', { class: 'pics' + (ps.length === 1 ? ' one' : '') }, ps.map((src) => h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }))) : null; })(),
                h('div', { class: 'main' }, m.main.map((x) => h('div', { class: 'dish' }, h('span', {}, x)))),
                m.sides.length ? h('div', { class: 'sides' }, m.sides.join(', ')) : null,
                m.also.filter((x) => !daily.includes(x)).length ? h('div', { class: 'also' }, 'Or ' + and(m.also.filter((x) => !daily.includes(x)))) : null]);
      })),
      daily.length ? h('div', { class: 'daily' }, 'Every day: ' + and(daily)) : null);
  });
  const foot = h('div', { class: 'foot' },
    loading ? 'Getting the menus…' : err ? `Couldn’t get the newest menus${saved.at ? `, so these are from ${dateOf(dayKey(new Date(saved.at))).toLocaleDateString('en-US', { weekday: 'long' })}` : ''}.` : saved.at ? `Updated ${hm(saved.at)}` : '');
  $app.replaceChildren(top, h('div', { class: 'groups' }, rows), foot);
}

// ---- setup: a name and a menu link per kid ----
function openSetup() {
  editing = kids.length ? kids.map((k) => ({ ...k })) : [{ name: family[0] || '', link: '' }];
  drawSetup();
}
function drawSetup() {
  document.querySelector('.scrim')?.remove();
  if (!editing) return;
  const names = family.length ? family : [];
  const rows = editing.map((k, i) => {
    const bad = !!k.link.trim() && !parseLink(k.link);
    const hint = h('div', { class: 'hint', hidden: !bad }, 'That isn’t a Nutrislice menu address. Open the menu on nutrislice.com and copy the address from the top.');
    const check = (e) => { const b = !!k.link.trim() && !parseLink(k.link); e.target.classList.toggle('bad', b); hint.hidden = !b; };
    return h('div', { class: 'kid' },
      names.length
        ? h('select', { class: 'field name', onchange: (e) => { k.name = e.target.value; } },
          [...new Set([...names, ...(k.name && !names.includes(k.name) ? [k.name] : [])])].map((n) => h('option', { value: n, selected: n === k.name }, n)))
        : h('input', { class: 'field name', placeholder: 'Name', value: k.name, oninput: (e) => { k.name = e.target.value; } }),
      h('input', { class: 'field link' + (bad ? ' bad' : ''), placeholder: 'https://….nutrislice.com/menu/…', value: k.link, inputmode: 'url', autocapitalize: 'off', spellcheck: 'false',
        oninput: (e) => { k.link = e.target.value; }, onchange: check }),
      h('button', { class: 'round', 'aria-label': 'Take off', tap: () => { editing.splice(i, 1); drawSetup(); } }, '×'),
      hint);
  });
  const sheet = h('div', { class: 'sheet', onclick: (e) => e.stopPropagation() },
    h('h2', {}, 'Kids and schools'),
    h('p', { class: 'soft' }, 'Each kid’s lunch menu link from Nutrislice. Kids at the same school can have the same link.'),
    rows,
    h('div', { class: 'actions' },
      h('button', { class: 'btn soft', tap: () => { editing.push({ name: family.find((n) => !editing.some((k) => k.name === n)) || '', link: editing.at(-1)?.link || '' }); drawSetup(); } }, 'Add a kid'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn soft', tap: () => { editing = null; drawSetup(); } }, 'Cancel'),
      h('button', { class: 'btn', tap: saveSetup }, 'Save')));
  document.body.append(h('div', { class: 'scrim', onclick: () => { editing = null; drawSetup(); } }, sheet));
}
async function saveSetup() {
  if (editing.some((k) => k.link.trim() && !parseLink(k.link))) { drawSetup(); return; }
  kids = editing.filter((k) => k.link.trim()).map((k) => ({ name: String(k.name || '').trim().slice(0, 40), link: k.link.trim() }));
  editing = null; drawSetup();
  await store.set('setup', { kids });
  lineFor = null;
  draw();
  refresh({ force: true });
}

// ---- the voice (app.json "actions"): the menu for a day, or the week ----
const groupsFor = (who) => {
  const gs = groups();
  if (!who) return { gs };
  const w = String(who).trim().toLowerCase();
  const hit = gs.filter((g) => g.names.some((n) => n.toLowerCase() === w || n.toLowerCase().split(/\s+/)[0] === w.split(/\s+/)[0]));
  return hit.length ? { gs: hit, who: hit[0].names.find((n) => n.toLowerCase().split(/\s+/)[0] === w.split(/\s+/)[0]) } : { gs: [], missing: who };
};
/** The day they mean: the date given, else the next school day (today until early afternoon). */
async function dayFor(date, gs) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return date;
  const t = dayKey();
  const from = new Date().getHours() < 14 ? t : addDays(t, 1);
  for (let i = 0; i < 14; i++) { const d = addDays(from, i); for (const g of gs) if ((await menuOn(g, d))?.main) return d; }
  return from;
}
async function answerDay({ date, who }) {
  if (!groups().length) return 'No kids are set up in School lunch yet: add their menu links there.';
  const f = groupsFor(who);
  if (f.missing) return `School lunch has no menu for ${f.missing}. It has ${and(kids.map((k) => k.name).filter(Boolean)) || 'no names'}.`;
  const d = await dayFor(date, f.gs);
  asked = { day: d, who: f.who || null }; week = d >= addDays(firstWeek(), 7) ? 1 : 0; draw();
  const parts = [];
  for (const g of f.gs) {
    const m = await menuOn(g, d), said = sayDay(d, m, { daily: everyDay(daysOf(g.key)) });
    parts.push(f.gs.length > 1 || (groups().length > 1 && !who) ? `${and(g.names)}: ${said}` : said);
  }
  return parts.join(' ');
}
async function answerWeek({ who, next }) {
  if (!groups().length) return 'No kids are set up in School lunch yet: add their menu links there.';
  const f = groupsFor(who);
  if (f.missing) return `School lunch has no menu for ${f.missing}.`;
  week = next ? 1 : 0; asked = null; draw();
  const start = addDays(firstWeek(), next ? 7 : 0);
  const out = [];
  for (const g of f.gs) {
    const lines = [];
    for (let i = 1; i < 6; i++) { const d = addDays(start, i), m = await menuOn(g, d); lines.push(`${weekday(d, true)}: ${!m ? 'no menu' : m.note || and(m.main)}`); }
    out.push((f.gs.length > 1 ? `${and(g.names)}. ` : '') + lines.join('. ') + '.');
  }
  return out.join(' ');
}

// ---- start ----
(async () => {
  kids = (await store.get('setup'))?.kids || [];
  saved = (await store.get('menus')) || saved;
  saved.menus ||= {};
  draw();
  house.subscribe((hv) => {
    const names = (hv.family || []).map((p) => p.name).filter(Boolean);
    if (names.join('|') !== family.join('|')) { family = names; if (editing) drawSetup(); }
  });
  onAction(async (name, args) => {
    if (name === 'lunch') return answerDay(args);
    if (name === 'week') return answerWeek(args);
    return null;
  });
  refresh();
  // once a day (and at midnight the line on Today moves on), while the page is open or kept as a tab
  setInterval(() => { refresh(); todayLine(); }, 10 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
