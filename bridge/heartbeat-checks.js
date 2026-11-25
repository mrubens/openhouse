// Checks an app declares (docs/heartbeat.md, "Checks from apps and plugins"): data only, in its app.json, like its
// voice actions. The bridge reads them and runs them itself; nothing from a plugin is ever run as code.
//
//   "checks": [{
//     "id": "no-chores-3d",                          lowercase, digits and dashes
//     "text": "No chores checked off in 3 days",      what the finding says (up to 200 characters)
//     "level": "notice" | "tidy",                     the least the heartbeat must be at to act on it (default notice)
//     "source": { "data": "progress" }                 the app's own saved things (GET /appdata/progress)
//            | { "house": "meals" },                   or a key of the house's data the app may see (its uses groups)
//     "path": "days.{today}.done",                    where in it; {today} is today's date (YYYY-MM-DD)
//     "test": "missing" | "empty" | "older_than" | "count_below" | "count_above" | "equals" | "not_equals",
//     "hours": 72, "n": 1, "value": "x",              what the test needs (older_than: hours; count_*: n; equals: value)
//     "after": "15:00", "before": "20:00",            only at these times of day (optional)
//     "for": "Maya"                                   who it's about (optional)
//   }]
//
// A check that doesn't fit is left out with the reason (GET /heartbeat lists them). An app from a link (a shared
// plugin) keeps the checks its card showed, fixed when it was added (plugins.js checksOf); editing its app.json can't
// add one. The family's own and Opie's apps are read live from app.json.
import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from './dates.js';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TESTS = { missing: [], empty: [], older_than: ['hours'], count_below: ['n'], count_above: ['n'], equals: ['value'], not_equals: ['value'] };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);

/** One app's checks, as it declared them: { checks: [...valid], problems: [why one was left out] }. */
export function validateChecks(list, { houseKeys = null } = {}) {
  const checks = [], problems = [];
  if (list == null) return { checks, problems };
  if (!Array.isArray(list)) return { checks, problems: ['"checks" must be a list'] };
  for (const [i, c] of list.entries()) {
    const why = (w) => problems.push(`check ${c?.id || i + 1}: ${w}`);
    if (!c || typeof c !== 'object') { why('not an object'); continue; }
    if (!ID.test(String(c.id || ''))) { why('id: lowercase letters, digits and dashes'); continue; }
    if (checks.some((x) => x.id === c.id)) { why('the same id twice'); continue; }
    const text = String(c.text || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length > 200) { why('text: 1 to 200 characters'); continue; }
    const level = c.level == null ? 'notice' : c.level;
    if (!['notice', 'tidy'].includes(level)) { why('level: notice or tidy'); continue; }
    const src = c.source || {};
    const source = typeof src.data === 'string' && /^[\w.-]{1,40}$/.test(src.data) ? { data: src.data }
      : typeof src.house === 'string' && /^\w{1,40}$/.test(src.house) ? { house: src.house } : null;
    if (!source) { why('source: {"data": name} or {"house": key}'); continue; }
    if (source.house && houseKeys && !houseKeys.has(source.house)) { why(`it may not see the house's ${source.house}`); continue; }
    const p = c.path == null ? '' : String(c.path);
    if (p.length > 200 || !/^[\w.{}-]*$/.test(p)) { why('path: names and dots'); continue; }
    if (!Object.hasOwn(TESTS, c.test)) { why(`test: ${Object.keys(TESTS).join(', ')}`); continue; }
    const need = TESTS[c.test].find((k) => c[k] === undefined || (k !== 'value' && !(Number(c[k]) >= 0)));
    if (need) { why(`${c.test} needs ${need}`); continue; }
    if ((c.after && !TIME.test(c.after)) || (c.before && !TIME.test(c.before))) { why('after and before: HH:MM'); continue; }
    if (c.value !== undefined && (typeof c.value === 'object' && c.value !== null)) { why('value: a string, number, true/false or null'); continue; }
    checks.push({ id: c.id, text, level, source, path: p, test: c.test, ...(c.hours != null ? { hours: +c.hours } : {}), ...(c.n != null ? { n: +c.n } : {}),
      ...(c.value !== undefined ? { value: c.value } : {}), ...(c.after ? { after: c.after } : {}), ...(c.before ? { before: c.before } : {}),
      ...(c.for ? { for: String(c.for).slice(0, 40) } : {}) });
  }
  return { checks, problems };
}

const at = (v, p, d) => p.split('.').filter(Boolean).map((k) => k.replace('{today}', dayKey(d))).reduce((x, k) => (x == null ? undefined : x[k]), v);
const size = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : typeof v === 'string' ? v.length : v == null ? 0 : 1);
const when = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));

/** Does this check find something now? value: the source's data (its whole JSON). */
export function fires(c, value, d) {
  const m = d.getHours() * 60 + d.getMinutes();
  if (c.after && m < mins(c.after)) return false;
  if (c.before && m >= mins(c.before)) return false;
  if (value === undefined && c.test !== 'missing') return false; // nothing saved yet: not a problem to report
  const v = at(value, c.path, d);
  switch (c.test) {
    case 'missing': return v === undefined || v === null;
    case 'empty': return size(v) === 0;
    case 'older_than': { const t = when(v); return Number.isFinite(t) && +d - t > c.hours * 3600e3; }
    case 'count_below': return size(v) < c.n;
    case 'count_above': return size(v) > c.n;
    case 'equals': return v === c.value;
    case 'not_equals': return v !== undefined && v !== c.value;
  }
  return false;
}

/**
 * Every app's checks, run. deps: APP_DIR (apps/<id>/app.json), readData(app, name) -> parsed or undefined,
 * houseView() -> the house's data, houseKeysOf(app) -> Set of keys it may see (null: all, the family's own apps),
 * fixedChecks(app) -> the checks a shared plugin's card showed (null: read its app.json).
 */
export function appChecks({ APP_DIR, readData, houseView = () => ({}), houseKeysOf = () => null, fixedChecks = () => null }) {
  const appsDir = path.join(APP_DIR || '', 'apps');
  let last = { problems: {} };
  function declared() {
    const out = [], problems = {};
    let ids = []; try { ids = fs.readdirSync(appsDir); } catch {}
    for (const app of ids) {
      let j; try { j = JSON.parse(fs.readFileSync(path.join(appsDir, app, 'app.json'), 'utf8')); } catch { continue; }
      let raw = j?.checks; try { const fixed = fixedChecks(app); if (fixed) raw = fixed; } catch {}
      if (!raw) continue;
      const r = validateChecks(raw, { houseKeys: houseKeysOf(app) });
      if (r.problems.length) problems[app] = r.problems;
      for (const c of r.checks) out.push({ app, name: j.name || app, ...c });
    }
    last = { problems };
    return out;
  }
  /** The findings, in the heartbeat's shape. */
  function run(d) {
    let house = {}; try { house = houseView() || {}; } catch {}
    const out = [];
    for (const c of declared()) {
      const value = c.source.house ? house[c.source.house] : (() => { try { return readData(c.app, c.source.data); } catch { return undefined; } })();
      let hit = false; try { hit = fires(c, value, d); } catch {}
      if (hit) out.push({ key: `app:${c.app}:${c.id}`, kind: 'app', level: c.level, app: c.app, text: `${c.name}: ${c.text}`, ...(c.for ? { for: c.for } : {}) });
    }
    return out;
  }
  return { run, declared, problems: () => last.problems };
}

/** An app's saved thing (apps.js keeps them as <DATA>/<app>/<name>.json). */
export const dataReader = (DATA) => (app, name) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, app, `${name}.json`), 'utf8')); } catch { return undefined; }
};
