// The family's apps and games: web pages in webapp/apps/<id>/ (index.html, main.js, app.json, icon.svg), served by
// the dev server (Vite, :5173) so they reload as the assistant edits them. They run full screen in the shell's web
// view, each as its own installed Android app.
//
// An app reaches the family's data through the kit (/kit/openhouse.js) with its own key: the shell asks for it
// (GET /apps/key, the display's secret) and hands it to the app's page. That key only opens the routes in APP_RULES
// (the house's data, the home screen, timers, speaking, the home's speakers and TVs; for an app from a plugin, only what it was
// granted); never undo, deleting apps, the builder, the devices' own routes (scanning, recipes, pairing), the agents'
// tools, the household's settings or screens.
//
// GET /apps                      [{id, meta: app.json, icon (svg), web, widget, today}], the home style and apps for screens left out
//                                (today: "small" or "wide", the card it offers on Today: a widget.html and app.json
//                                "today": {"size"}; a plugin's app only with "today-card" granted)
// GET /apps/key?app=<id>         that app's key (the display only)
// GET|POST /appdata/<name>       an app's own saved things (a drawing in progress, progress in a game), kept by the
//                                bridge so they survive the app's window being reinstalled and reach other screens.
//                                Only with that app's key: each app sees its own. JSON, up to 8 MB each.
// POST /appdata/import?app=<id>  (the display only) what an app saved before it was a web page, handed over once by its
//                                old window: {files: {name: text}, prefs: {file: {key: value}}}, kept as legacy.json
// GET /kit/<file>                the kit: openhouse.js, openhouse.css, fonts (no key: plain code and fonts)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
// What an app may call, by what it's for. The family's own apps get every group. An app that came in a plugin
// (plugins.js) gets only the groups its plugin's lock entry granted (webapp/plugins.json, from its app.json "uses",
// shown on the install card), plus the basics; and the house's data it reads (GET /house) is cut to those groups.
const APP_GROUPS = {
  basics: [['GET', /^\/(state|apps)$/], ['POST', /^\/apperror$/], ['GET', /^\/appdata\/[\w.-]{1,40}$/], ['POST', /^\/appdata\/[\w.-]{1,40}$/],
    ['GET', /^\/house(\/wait)?$/], // the house's data, cut to what the app may see (houseFor)
    ['POST', /^\/apps\/fetch$/], // the web through the bridge, only the hosts in its "reaches" (app-web.js)
    ['POST', /^\/apps\/reach(\/forget)?$/]], // asking for a website its card said it would choose at setup (plugins.js askReach): the tablet's card decides
  lists: [['POST', /^\/house\/list$/]],
  chores: [['POST', /^\/house\/(chore|checklist)$/]],
  rewards: [['POST', /^\/house\/reward$/]],
  meals: [['POST', /^\/house\/(meal|meal\/ingredients|recipe-link)$/]],
  events: [['POST', /^\/house\/(event|remind)$/]],
  photos: [['GET', /^\/house\/photo\/[^/]{1,120}$/], ['POST', /^\/house\/(photo|photo\/remove|photo\/album|photo\/caption|photo\/restore)$/]],
  family: [],
  weather: [['GET', /^\/weather$/]],
  home: [['GET', /^\/(home|home\/wait|board)$/]],
  timer: [['POST', /^\/home\/timer$/], ['GET', /^\/home\/timer$/]], // start and stop the kitchen timers, and see which are running
  say: [['POST', /^\/(voice\/say|home\/handsfree)$/]], // speaking, and being used hands-free (the voice listens longer)
  decide: [['POST', /^\/cloud\/decide$/]], // OpenAI Decisions through the family's account: counts against its allowance
  today: [['POST', /^\/today\/line$/]], // its own one line on Today, with an until (things.js putApp)
  days: [['POST', /^\/calendar\/days$/]], // its own notes on the calendar's days (day-notes.js)
  'calendar-events': [['POST', /^\/calendar\/events$/]], // its own events on the calendar, read-only there (day-notes.js); not the family's
  // The home's speakers and TVs, through the bridge's own drivers, under the same asks as Opie (devices/index.js forApp):
  // list, a device's state, an action. Never the devices' addresses, scanning, recipes or pairing.
  devices: [['POST', /^\/apps\/devices(\/(get|do))?$/]],
  'today-card': [], // its widget.html as a card of its own on Today, once the household turns it on (list: today)
  // The family's own apps only: the house's settings, handing something to a phone, the scanned flyer.
  own: [['POST', /^\/house\/(settings|share|flyer\/clear)$/], ['POST', /^\/household\/location$/],
    ['GET', /^\/map(\/route)?$/], ['POST', /^\/map\/(on|place|place\/remove|clear)$/], // the Map (maps.js)
    ['POST', /^\/apps\/ask$/]], // apps/ask: another app's voice action (plugins.js)
};
/** What a plugin's app may ask for in "uses" (app.json): every group but the basics (always) and the family's own. */
export const USES = Object.keys(APP_GROUPS).filter((g) => g !== 'basics' && g !== 'own');
const ALL = Object.values(APP_GROUPS).flat();
/**
 * Whether an app runs on a kind of screen ('tablet', 'phone', 'tv'), by its app.json "screens": with none, the tablet
 * and the household's phones; with a list, only those ("tablet": true as well still means the tablet). A TV shows only
 * an app that says "tv" (docs/plugins.md, "Phones").
 */
export function onScreen(meta, kind) {
  const s = meta?.screens;
  if (!Array.isArray(s)) return kind === 'tablet' || kind === 'phone';
  return s.includes(kind) || (kind === 'tablet' && meta.tablet === true);
}
/** rights: null for the family's own app (everything), else the Set of groups a plugin's app was granted. */
export function appAllowed(method, pathname, rights = null) {
  const rules = rights ? ['basics', ...rights].flatMap((g) => APP_GROUPS[g] || []) : ALL;
  return rules.some(([m, re]) => m === method && re.test(pathname));
}
// The house's data (house.js view()), by group: what a plugin's app sees of it. Keys not named here it never sees.
const HOUSE_KEYS = {
  basics: ['v', 'today', 'night', 'ai'],
  family: ['family'],
  lists: ['lists', 'aisles'],
  chores: ['chores', 'streaks', 'stars', 'checklists', 'family'],
  rewards: ['stars', 'rewards', 'asks', 'got', 'family'],
  meals: ['meals', 'favorites', 'mealWork', 'recipes', 'recipeFind', 'mealSlots'],
  events: ['events', 'dayNotes', 'fromApps', 'calendars', 'calendarLock', 'unlockedUntil', 'reminders', 'family'],
  photos: ['photos', 'removed', 'albums', 'captions', 'screensaver'],
};
/** GET /house as a plugin's app sees it. */
export function houseFor(view, rights) {
  if (!rights || !view || typeof view !== 'object') return view;
  const keys = new Set(['basics', ...rights].flatMap((g) => HOUSE_KEYS[g] || []));
  return Object.fromEntries(Object.entries(view).filter(([k]) => keys.has(k)));
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain' };

export function appsRoutes({ HERE, APP_DIR, json, DATA = path.resolve(process.env.CHAT_DIR || path.join(HERE, '../chats'), '../appdata') }) {
  const MAX = 8e6;
  const dataFile = (id, name) => path.join(DATA, id, name + '.json');
  const readRaw = (req) => new Promise((resolve) => {
    const parts = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > MAX) req.destroy(); else parts.push(d); });
    req.on('end', () => resolve(n > MAX ? null : Buffer.concat(parts).toString()));
    req.on('error', () => resolve(null));
  });
  function writeData(id, name, text) {
    fs.mkdirSync(path.join(DATA, id), { recursive: true });
    const f = dataFile(id, name), tmp = f + '.tmp';
    fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
  }
  const secret = crypto.randomBytes(32); // keys last until the bridge restarts; the shell asks again each time it opens an app
  const keyOf = (id) => crypto.createHmac('sha256', secret).update('app:' + id).digest('base64url');
  const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  let rightsOf = () => null; // plugins.js rightsOf (server.js): a plugin's app offers a Today card only if it was granted one
  // plugins.js frozenOf: what a shared app's card fixed of its app.json ({background, screens, tablet}), never read live.
  let frozenOf = () => null;
  const todayOf = (id, meta, widget) => { const t = meta.today; if (!widget || !t || typeof t !== 'object') return null; const r = rightsOf(id); return r && !r.has('today-card') ? null : t.size === 'wide' ? 'wide' : 'small'; };
  function list() {
    const dir = path.join(APP_DIR, 'apps');
    let ids = [];
    // An app made before apps were web pages (only Kotlin left) is listed with web: false: the home screen doesn't show it,
    // but its window (and what it saved) isn't removed until the app is gone.
    try { ids = fs.readdirSync(dir).filter((d) => ID.test(d) && d !== 'home' && (fs.existsSync(path.join(dir, d, 'index.html')) || fs.existsSync(path.join(dir, d, 'app.json')))); } catch {}
    return ids.sort().map((id) => {
      let meta = { name: id }, icon = null;
      const web = fs.existsSync(path.join(dir, id, 'index.html'));
      try { meta = { name: id, ...JSON.parse(fs.readFileSync(path.join(dir, id, 'app.json'), 'utf8')) }; } catch {}
      try { icon = fs.readFileSync(path.join(dir, id, 'icon.svg'), 'utf8').slice(0, 20000); } catch {}
      const widget = web && fs.existsSync(path.join(dir, id, 'widget.html'));
      // A shared app (from a link) runs on its own origin (<id>.localhost, device/vite.config.mjs), and keeps running in
      // the background or is for a TV only as its card said.
      const shared = !!rightsOf(id);
      if (shared) { const f = frozenOf(id) || {}; meta = { ...meta, background: f.background === true, screens: f.screens, tablet: f.tablet === true }; if (!f.screens) delete meta.screens; }
      return { id, meta, icon, web, widget, today: todayOf(id, meta, widget), ...(shared ? { shared: true } : {}) };
    });
  }

  /**
   * The app a request comes from, if it carries a good key (x-openhouse-app, x-openhouse-key) from that app's own
   * origin; else null. A shared app's key works only from <id>.localhost, and ours and the household's only from the
   * dev server's usual host (or with no page at all: the shell), so a key that got out is no use to another app's page.
   * The page's host: its Origin, else the host the dev server saw it on (x-openhouse-host, which the dev server sets
   * over anything the page sent). A page can't send a request to the bridge with neither, except through the dev server.
   */
  function caller(req) {
    const id = String(req.headers['x-openhouse-app'] || '');
    if (!ID.test(id) || !same(req.headers['x-openhouse-key'], keyOf(id))) return null;
    const o = req.headers.origin;
    let host = req.headers['x-openhouse-host'] || null;
    if (o) { try { host = new URL(o).host; } catch { return null; } }
    const h = host == null ? null : String(host).toLowerCase().replace(/:\d+$/, '');
    const sub = h && /^([a-z0-9][a-z0-9-]{0,60})\.localhost$/.exec(h)?.[1];
    if (rightsOf(id)) return sub === id ? id : null;
    return h == null || /^(127\.0\.0\.1|localhost|\[::1\]|10\.0\.2\.2)$/.test(h) ? id : null;
  }

  /** Kit files: no key needed (served to the apps' own origin, the dev server's). */
  function kit(req, res, url) {
    const m = req.method === 'GET' && url.pathname.match(/^\/kit\/([\w.-]+(?:\/[\w.-]+)?)$/);
    if (!m) return false;
    const roots = [path.join(HERE, 'kit'), path.join(HERE, '../shell/app/src/main/assets')]; // fonts: copied into kit/ on the device; the shell's own in a checkout
    for (const root of roots) {
      const f = path.join(root, path.normalize(m[1]).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' });
        res.end(fs.readFileSync(f));
        return true;
      }
    }
    json(res, 404, { error: 'not found' });
    return true;
  }

  /** The display's routes, and an app's own data ([app]: the app the key belongs to, from server.js). */
  async function handle(req, res, url, app = null) {
    const d = url.pathname.match(/^\/appdata\/([\w.-]{1,40})$/);
    if (d && d[1] === 'import') {
      const id = String(url.searchParams.get('app') || '');
      if (app || req.method !== 'POST' || !ID.test(id)) { json(res, 403, { error: 'the display only' }); return true; }
      const text = await readRaw(req);
      let v = null; try { v = JSON.parse(text); } catch {}
      if (!v || typeof v !== 'object') { json(res, 400, { error: 'json please' }); return true; }
      if (fs.existsSync(dataFile(id, 'legacy')) || fs.existsSync(dataFile(id, 'legacy-done'))) { json(res, 200, { ok: true, already: true }); return true; } // once
      writeData(id, 'legacy', JSON.stringify(v));
      json(res, 200, { ok: true });
      return true;
    }
    if (d) {
      if (!app) { json(res, 403, { error: 'an app\'s own data' }); return true; }
      if (req.method === 'GET') {
        try { const b = fs.readFileSync(dataFile(app, d[1])); res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(b); }
        catch { json(res, 404, { error: 'nothing saved' }); }
        return true;
      }
      const text = await readRaw(req);
      if (text == null) { json(res, 413, { error: 'too big' }); return true; }
      if (text === '' || text === 'null') { try { fs.unlinkSync(dataFile(app, d[1])); } catch {} json(res, 200, { ok: true }); return true; }
      try { JSON.parse(text); } catch { json(res, 400, { error: 'json please' }); return true; }
      writeData(app, d[1], text);
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method !== 'GET') return false;
    // An app for screens (app.json "screens": ["tv"]) isn't one of the tablet's: it's what a TV shows (screens.js).
    if (url.pathname === '/apps') { json(res, 200, list().filter((a) => onScreen(a.meta, 'tablet'))); return true; }
    if (url.pathname === '/apps/key') {
      const id = String(url.searchParams.get('app') || '');
      if (!ID.test(id)) { json(res, 400, { error: 'which app?' }); return true; }
      // shared: load it from http://<id>.localhost:<port>; its web view lets it reach only these (WebApps.kt)
      json(res, 200, { app: id, key: keyOf(id), ...(rightsOf(id) ? { shared: true, reaches: frozenOf(id)?.reaches || [] } : {}) });
      return true;
    }
    return false;
  }
  return { handle, kit, caller, list, setRightsOf: (fn) => { rightsOf = fn; }, setFrozenOf: (fn) => { frozenOf = fn; } };
}
