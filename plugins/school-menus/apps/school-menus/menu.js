// School lunch menus from Nutrislice: the link a household pastes, the week's JSON, and the day's dishes in plain words.
// No page or kit here, so it runs the same in a test.

/** A kid's menu link (https://springfield.nutrislice.com/menu/maple/lunch/2026-11-23, or the API's own address):
 *  { district, school, type } or null. */
export function parseLink(s) {
  let u; try { u = new URL(String(s || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().match(/^([a-z0-9-]+)(\.api)?\.nutrislice\.com$/);
  if (!host || host[1] === 'www' || host[1] === 'api') return null;
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());
  const slug = (p) => (/^[a-z0-9][a-z0-9_-]{0,100}$/.test(p || '') ? p : null);
  let school = null, type = null;
  const api = parts.indexOf('school');
  if (parts[0] === 'menu' && parts[1] === 'api' && api > 0) { school = slug(parts[api + 1]); type = slug(parts[parts.indexOf('menu-type') + 1]); }
  else if (parts[0] === 'menu') { school = slug(parts[1]); type = slug(parts[2]); }
  if (!school || !type) return null;
  return { district: host[1], school, type };
}
export const menuKey = (m) => `${m.district}/${m.school}/${m.type}`;
/** The week (Sunday to Saturday) holding that day, from the public API. */
export function weekUrl(m, day) {
  const [y, mo, d] = day.split('-');
  return `https://${m.district}.api.nutrislice.com/menu/api/weeks/school/${m.school}/menu-type/${m.type}/${y}/${mo}/${d}/`;
}

const pad = (n) => String(n).padStart(2, '0');
/** YYYY-MM-DD, local. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const addDays = (k, n) => { const d = dateOf(k); d.setDate(d.getDate() + n); return dayKey(d); };

// How Nutrislice files each item: the dish itself, a side, or something on the table. Its own categories, as the data
// gives them (not words for food).
const SIDE = new Set(['grain', 'vegetable', 'fruit']);
const TABLE = new Set(['condiment', 'beverage']);
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const uniq = (l) => [...new Set(l)];

/**
 * One day of the week's JSON, in plain words: { main: [dishes], sides: [...], also: [other choices], pics: {dish: photo
 * address} }, or { note }
 * for a day with only words on it (a break), or null for a day with nothing (a weekend). The first station is the
 * day's lunch; the other stations' dishes are the other choices; condiments, drinks and the salad bar's pieces go.
 */
export function dayMenu(day) {
  const items = Array.isArray(day?.menu_items) ? day.menu_items : [];
  const stations = []; let cur = null;
  for (const i of items) {
    if (i.is_section_title || i.is_station_header) { cur = { title: clean(i.text), items: [] }; stations.push(cur); continue; }
    const name = clean(i.food?.name);
    if (!name) continue;
    if (!cur) { cur = { title: '', items: [] }; stations.push(cur); }
    const image = /^https:\/\/[\w.-]+\.nutrislice\.com\//.test(i.food?.image_url || '') ? i.food.image_url : null;
    cur.items.push({ name, cat: String(i.category || i.food?.food_category || '').toLowerCase(), image });
  }
  const st = stations.filter((s) => s.items.length);
  if (!st.length) {
    const note = items.map((i) => clean(i.text)).find(Boolean);
    return note ? { note: note.slice(0, 80) } : null;
  }
  const isMain = (x) => !SIDE.has(x.cat) && !TABLE.has(x.cat);
  let main = uniq(st[0].items.filter(isMain).map((x) => x.name));
  if (!main.length) main = st[0].items.filter((x) => !TABLE.has(x.cat)).slice(0, 1).map((x) => x.name);
  const sides = uniq(st[0].items.filter((x) => SIDE.has(x.cat)).map((x) => x.name)).filter((x) => !main.includes(x));
  const also = uniq(st.slice(1).flatMap((s) => s.items.filter(isMain).map((x) => x.name))).filter((x) => !main.includes(x));
  // the main dishes' and other choices' photos, where Nutrislice has one
  const pics = Object.fromEntries(st.flatMap((s) => s.items).filter((x) => x.image && (main.includes(x.name) || also.includes(x.name))).map((x) => [x.name, x.image]));
  return { main, sides, also, pics };
}

/** A week's JSON: { "YYYY-MM-DD": dayMenu } for the days with something on them. */
export function weekMenus(json) {
  const out = {};
  for (const d of json?.days || []) { const m = dayMenu(d); if (m && /^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) out[d.date] = m; }
  return out;
}

/** The other choices that are there every school day (shown once, not on each day). */
export function everyDay(days) {
  const school = Object.values(days).filter((m) => m.main);
  if (school.length < 3) return [];
  return school[0].also.filter((x) => school.every((m) => m.also.includes(x)));
}

/** "Popcorn Chicken and Brown Rice" */
export const and = (l) => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`);

/** What the voice says for one day: "Tuesday: Beef Taco Meat, with Tortilla Chips and Seasoned Corn. Or Refried Beans." */
export function sayDay(k, m, { today = dayKey(), daily = [] } = {}) {
  const name = k === today ? 'Today' : k === addDays(today, 1) ? 'Tomorrow' : dateOf(k).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  if (!m) return `${name}: there's no school lunch menu.`;
  if (m.note) return `${name}: ${m.note}, no school lunch.`;
  const also = m.also.filter((x) => !daily.includes(x));
  return `${name}: ${and(m.main)}${m.sides.length ? `, with ${and(m.sides)}` : ''}.${also.length ? ` Or ${and(also)}.` : ''}`;
}
