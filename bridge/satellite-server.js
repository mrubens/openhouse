// The bridge on a tablet that's part of another tablet's household (docs/multi-tablet.md, satellite.js): the same
// loopback port and secret as the brain's, so this tablet's shell, its home screen page and its apps talk to it as they
// always do. It keeps none of the household's things. For each request it:
//   - answers what is this tablet's own: listening for "Hey Opie" (voice.js), the home screen's page and the kit, its
//     apps' keys, whether it's a satellite (GET /satellite) and leaving (POST /satellite/leave);
//   - passes on to the brain, sealed, whatever its pairing's scopes allow (screens.js TABLET_SCOPES), and whatever one of
//     its apps asks, marked with that app (the brain answers only what the app may do);
//   - refuses anything else with "That's on the main tablet" (the household's settings, undo, backups, the builder),
//     never answering a household route from something kept here.
// Nothing that runs on its own in the brain (the heartbeat, reminders, calendar sync, backups, mail, the relay, the
// home-network listener) starts here, so nothing happens twice.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guarded } from './guarded.js';
import { authorized, loopbackHost } from './auth.js';
import { homePath } from './home-screen.js';
import { voiceRoutes } from './voice.js';
import { appsRoutes } from './apps.js';
import { readPairing, forwarder, mirror, forgetPairing, satelliteDir, clientLib } from './satellite.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPLAY = process.env.CLOUD_DISPLAY || path.join(HERE, '..');
const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(HERE, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

const json = (res, status, j) => { if (res.headersSent) return res.end(); res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(j)); };
const MAX = 8e6;
const rawBody = (req) => new Promise((resolve) => {
  const parts = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n > MAX) req.destroy(); else parts.push(d); });
  req.on('end', () => resolve(n > MAX ? null : Buffer.concat(parts).toString()));
  req.on('error', () => resolve(null));
});
const body = async (req) => { const t = await rawBody(req); try { return t ? JSON.parse(t) : {}; } catch { return {}; } };

const pairing = readPairing(DISPLAY);
let removed = false;
const sat = forwarder(pairing, { lib: await clientLib(), DISPLAY, onRemoved: () => { removed = true; console.log('[satellite] the main tablet removed this tablet'); } });
const copies = mirror({ DISPLAY, sat, log: (t) => console.log(t) });
copies.start();
// This tablet's own: listening for its name (the models and its own wake on or off stay here, never the household's).
const VOICE_STATE = path.join(satelliteDir(DISPLAY), 'voice');
fs.mkdirSync(VOICE_STATE, { recursive: true });
const voice = voiceRoutes({ HERE, DIR: VOICE_STATE, json, body });
// Its apps' keys (they open from the copies of the brain's apps): what an app sends with its key goes to the brain as that app.
const apps = appsRoutes({ HERE, APP_DIR: copies.root, json, DATA: path.join(satelliteDir(DISPLAY), 'no-appdata') });
apps.setRightsOf((id) => (copies.meta.get(id)?.shared ? new Set() : null));
apps.setFrozenOf((id) => ({ reaches: copies.meta.get(id)?.reaches || [] }));

/** The display's own pages and those of its frames (no key: nothing secret in them), as the brain serves them. */
function page(req, res, url) {
  const m = req.method === 'GET' && url.pathname.match(/^\/(chat|app|screen)(\/.*)?$/);
  if (!m) return false;
  if (!m[2]) { res.writeHead(301, { location: url.pathname + '/' + (url.search || '') }); res.end(); return true; }
  const rel = m[2] === '/' ? 'index.html' : m[2].slice(1);
  const root = path.join(PUBLIC, m[1]);
  const f = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { json(res, 404, { error: 'not found' }); return true; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(fs.readFileSync(f));
  return true;
}

/** Who may talk to it: as the brain's (brain.js allowedOrigin): the display's own code, its pages, the dev server's. */
function allowedOrigin(req) {
  const o = req.headers.origin;
  if (!o || o === `http://${req.headers.host}`) return true;
  const m = /^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2|[a-z0-9][a-z0-9-]{0,60}\.localhost):(\d+)$/.exec(o);
  const vite = ['5173', String(process.env.VITE_PORT || '')];
  return !!m && (m[1].endsWith('.localhost') ? vite : [...vite, '8787', String(PORT)]).includes(m[2]);
}

// The shell's /events: nothing of the brain's agent at work comes here (the home screen's page follows the brain itself).
const streams = new Set();
setInterval(() => { for (const r of streams) r.write(': still here\n\n'); }, 20e3).unref();

http.createServer({ requestTimeout: 0 }, guarded('satellite', async (req, res) => {
  req.url = homePath(req.url);
  const url = new URL(req.url, 'http://x');
  if (!allowedOrigin(req)) { res.writeHead(403); return res.end(); }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': req.headers.origin || 'null', 'access-control-allow-headers': 'content-type, x-openhouse-token, x-openhouse-app, x-openhouse-key', 'access-control-allow-methods': 'GET, POST', vary: 'origin' });
    return res.end();
  }
  if (apps.kit(req, res, url)) return;
  if (req.method === 'GET' && loopbackHost(req) && page(req, res, url)) return;
  // One of this tablet's apps, with its key: to the brain, as that app (the brain checks what the app may do).
  const app = apps.caller(req);
  if (app) {
    if (!loopbackHost(req)) return json(res, 403, { error: 'not for apps' });
    if (url.pathname.startsWith('/voice/say')) return voice(req, res, url); // its words are said here, in this room
    const b = req.method === 'POST' ? await body(req) : undefined;
    return sat(req, res, url, { body: b, app });
  }
  if (!authorized(req, url)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
  const p = url.pathname;
  if (p === '/satellite' && req.method === 'GET') return json(res, 200, { satellite: true, ...sat.status(), removed: removed || sat.status().removed });
  if (p === '/satellite/leave' && req.method === 'POST') { // (the shell asks for the PIN first, and restarts the runtime after)
    forgetPairing(DISPLAY);
    json(res, 200, { ok: true, restart: true });
    console.log('[satellite] left the household: this tablet is its own again');
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (p === '/satellite/apps' && req.method === 'POST') { const ok = await copies.sync(); return json(res, 200, { ok }); } // (the brain's apps changed)
  if (p.startsWith('/voice/')) { if (await voice(req, res, url)) return; return json(res, 404, { error: 'not found' }); }
  if (p === '/apps/key') return apps.handle(req, res, url);
  if (p === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'state', state: 'idle', t: Date.now() })}\n\n`);
    streams.add(res); req.on('close', () => streams.delete(res));
    return;
  }
  // The shell's own housekeeping that only a brain needs: nothing to do here.
  if (req.method === 'POST' && p === '/screens/address') return json(res, 200, { ok: true });
  if (req.method === 'GET' && (p === '/setup/want' || p === '/setup/step')) return json(res, 200, { satellite: true });
  const b = req.method === 'POST' ? await body(req) : undefined;
  return sat(req, res, url, { body: b });
})).on('error', (e) => { console.error('[satellite] listener:', e.code || e.message); process.exit(1); })
  .listen(PORT, process.env.BRIDGE_HOST || '127.0.0.1', () => console.log(`bridge on :${PORT}, a satellite of ${pairing.home || pairing.base} (${pairing.id})`));
