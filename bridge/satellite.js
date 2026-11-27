// Another Opie tablet in the same household (docs/multi-tablet.md): a satellite of the household's main tablet (its
// brain, which can be any device that keeps the household: a tablet or a hub). It keeps none of the household's things
// itself: its bridge passes the household's routes, sealed, to the brain as a paired device of the kind 'tablet'
// (screens.js TABLET_SCOPES), on the Wi-Fi, over the household's tailnet, or through the cloud's relay
// (chat/src/screen-client.js). The brain checks the scopes again, so a satellite reaches only what its pairing allows.
//
//   .satellite/pairing.json   in the display folder (0600, never in a backup): {home, base, id, key, scopes, relay,
//                             tailnet, name, joined}. Its being there is what makes this tablet a satellite (server.js).
//   .satellite/webapp/        the brain's apps, copied for this tablet's own dev server (mirror below): only a cache,
//                             made again whenever the brain's apps change.
//
// Joining is a code the main tablet shows (Linked devices, Add, Another Opie tablet; behind its PIN): scanned or typed
// here, it joins at once, as a phone does. Leaving takes the pairing away; whatever this tablet kept before it joined
// was never opened while it was a satellite, and it's there again as it was.
import fs from 'node:fs';
import path from 'node:path';
import { pairingFromCode, cleanCode } from './pair-code.js';
import { allowed } from './screens.js';

/** The screen page's own client (chat/src/screen-client.js), loaded only where it's used: a brain never needs it. */
export const clientLib = () => import('../chat/src/screen-client.js');

export const satelliteDir = (DISPLAY) => path.join(DISPLAY, '.satellite');
const pairingFile = (DISPLAY) => path.join(satelliteDir(DISPLAY), 'pairing.json');

/** This tablet's pairing with its household's brain, or null when it's a brain itself. */
export function readPairing(DISPLAY) {
  try {
    const p = JSON.parse(fs.readFileSync(pairingFile(DISPLAY), 'utf8'));
    return p && typeof p.id === 'string' && typeof p.key === 'string' && typeof p.base === 'string' && Array.isArray(p.scopes) ? p : null;
  } catch { return null; }
}
export function writePairing(DISPLAY, p) {
  fs.mkdirSync(satelliteDir(DISPLAY), { recursive: true, mode: 0o700 });
  const f = pairingFile(DISPLAY), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
/** Leaving the household: only the pairing goes (and the copies of the brain's apps). Nothing of this tablet's own. */
export function forgetPairing(DISPLAY) {
  fs.rmSync(pairingFile(DISPLAY), { force: true });
  fs.rmSync(path.join(satelliteDir(DISPLAY), 'webapp'), { recursive: true, force: true });
}

/** What someone scanned or typed: the main tablet's link (http(s)://<address>:8788/tablet#<code>) or the code alone. */
export function parseJoin(text) {
  const t = String(text || '').trim();
  const m = /^(https?:\/\/[a-z0-9.[\]:-]{1,200})\/tablet\/?#([0-9a-z-]{12,16})$/i.exec(t);
  if (m) { const code = cleanCode(m[2]); return code ? { code, base: m[1].toLowerCase() } : null; } // (a code box that types capitals: HTTP://10.0.0.5:8788)
  const code = cleanCode(t);
  return code ? { code, base: null } : null;
}

/**
 * Join the household whose brain is at base, with the code it showed. Resolves to the pairing (kept), or throws an
 * Error in the household's words. Run on a tablet that's still its own brain: the bridge restarts as a satellite after.
 */
export async function join({ DISPLAY, code, base, name = 'Tablet', fetch: f = fetch }) {
  const { pair: screenPair } = await clientLib();
  const from = pairingFromCode(code);
  if (!from) throw new Error("That isn't the code. It's 12 letters and numbers, like K7QM-2XD9-HPA4.");
  if (!/^https?:\/\/[^/]+$/.test(String(base || ''))) throw new Error("Couldn't find the main device on this Wi-Fi.");
  let w;
  try { w = await screenPair({ base, pair: from.pair, key: Buffer.from(from.key).toString('base64url'), name: String(name).slice(0, 40), fetch: f, signal: AbortSignal.timeout(60e3) }); }
  catch { throw new Error('That code has run out or was already used. Show a new one on the main device.'); }
  if (w.refused) throw new Error('The main device said no.');
  if (w.kind !== 'tablet') throw new Error("That code is for a phone or screen. On the main device choose Another Opie device.");
  const p = { home: base, base: w.base || base, id: w.id, key: w.key, scopes: w.scopes, relay: w.relay || null, tailnet: w.tailnet || null, name: w.name, joined: Date.now() };
  writePairing(DISPLAY, p);
  return p;
}

// What this tablet's shell asks its own bridge under names the brain answers differently (the live voice's start
// goes through the brain's own cloud link, docs/hub.md).
const RENAMED = { '/cloud/live/start': '/live/start', '/cloud/live/usage': '/live/usage' };
/** Answers kept for while the brain is away: the home screen and the house as it last showed them. */
const KEEP = /^\/(home|house|weather|board|apps|state|household|cloud\/voice|cloud\/status)$/;
const WAITS = /^\/(home|house)\/wait$/;

/**
 * The satellite's way to the brain. handle(req, res, url, { body, app }) answers a request this tablet's shell or one
 * of its apps sent its own bridge, from the brain (lib: await clientLib()). app: the app asking (its key checked here), for which the brain
 * answers only what that app may do. Always answers.
 */
export function forwarder(pairing, { lib, DISPLAY = null, fetch: f = fetch, WS = globalThis.WebSocket, onRemoved = () => {}, probeMs = 2000 } = {}) {
  const save = (patch) => { Object.assign(pairing, patch); if (DISPLAY) try { writePairing(DISPLAY, pairing); } catch {} };
  const { client: screenClient, Removed } = lib;
  const c = screenClient({ base: pairing.home || pairing.base, id: pairing.id, key: pairing.key, fetch: f, WS, probeMs,
    relay: pairing.relay || null, onRelay: (relay) => save({ relay }), tailnet: pairing.tailnet || null, onTailnet: (tailnet) => save({ tailnet }) });
  const kept = new Map(); // path -> { status, type, body }
  let reachable = true, removed = false, seen = 0;

  const json = (res, status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };

  async function handle(req, res, url, { body, app = null } = {}) {
    const m = req.method, p = RENAMED[url.pathname] || url.pathname;
    if (removed) return json(res, 410, { error: 'This device was removed from the household.', removed: true });
    if (!app && !allowed(pairing.scopes, m, p)) return json(res, 403, { error: "That's on the main device.", brain: true });
    let head = null;
    const keep = m === 'GET' && !app && KEEP.test(p), parts = [];
    try {
      const r = await c.request(m, p + (url.search || ''), m === 'GET' ? undefined : body ?? {}, {
        app: app || undefined, big: m === 'GET',
        onHead: (h) => { head = h; res.writeHead(h.status, { 'content-type': h.type || 'application/octet-stream', 'cache-control': 'no-store' }); },
        onData: (d) => { if (keep) parts.push(Buffer.from(d)); if (!res.writableEnded) res.write(d); },
      });
      reachable = true; seen = Date.now();
      res.end();
      if (keep && r.status === 200) kept.set(p, { type: r.type, body: Buffer.concat(parts) });
      return;
    } catch (e) {
      if (head) { res.end(); return; } // cut off mid-answer: what came is what it gets
      if (e instanceof Removed) { removed = true; try { onRemoved(); } catch {} return json(res, 410, { error: 'This device was removed from the household.', removed: true }); }
      reachable = false;
      const last = keep && kept.get(p);
      if (last) { // the home screen as it last was, marked so the page can say the main tablet is away
        let j = null; try { j = JSON.parse(last.body.toString('utf8')); } catch {}
        if (j && typeof j === 'object' && !Array.isArray(j)) return json(res, 200, { ...j, away: true });
        res.writeHead(200, { 'content-type': last.type || 'application/json' }); return res.end(last.body);
      }
      if (WAITS.test(p)) await new Promise((ok) => setTimeout(ok, 3000)); // (a page waiting for changes asks again: not at once)
      return json(res, 503, { error: "Can't reach the main device.", away: true });
    }
  }
  /** GETs answered whole, for this bridge's own use (the apps' copy, the home screen kept while away). */
  handle.json = async (p, opts) => { const r = await c.json('GET', p, undefined, { big: true, ...opts }); reachable = true; seen = Date.now(); return r; };
  handle.status = () => ({ brain: pairing.home || pairing.base, id: pairing.id, name: pairing.name, scopes: pairing.scopes, joined: pairing.joined, reachable, removed, seen: seen || null, where: c.where?.() || null });
  handle.kept = kept;
  return handle;
}

/**
 * The brain's apps, copied into .satellite/webapp for this tablet's own dev server, so they open here as they do there
 * (their pages and the libraries they import); everything they read or change goes to the brain, marked with the app
 * (satellite-server.js). Checked every 30 s and when asked (the apps changed). Only ever a cache: nothing here is the
 * household's, and leaving takes it away.
 */
export function mirror({ DISPLAY, sat, every = 30e3, log = () => {} }) {
  const root = path.join(satelliteDir(DISPLAY), 'webapp'), apps = path.join(root, 'apps');
  const versions = new Map(); // id -> v copied
  const meta = new Map(); // id -> { shared, reaches, name, kit }
  let running = null, timer = null;
  try { for (const d of fs.readdirSync(apps)) { try { const j = JSON.parse(fs.readFileSync(path.join(apps, d, '.v'), 'utf8')); versions.set(d, j.v); } catch {} } } catch {}
  const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
  async function sync() {
    if (running) return running;
    running = (async () => {
      const r = await sat.json('/screens/apps');
      if (r.status !== 200 || !Array.isArray(r.json)) return false;
      fs.mkdirSync(apps, { recursive: true });
      const want = new Set();
      for (const a of r.json) {
        if (!ID.test(String(a.id || '')) || a.id === 'home') continue;
        want.add(a.id);
        meta.set(a.id, { shared: !!a.shared, reaches: Array.isArray(a.reaches) ? a.reaches.filter((h) => typeof h === 'string') : [], name: String(a.name || a.id), kit: Number.isInteger(a.kit) ? a.kit : null });
        if (versions.get(a.id) === a.v && fs.existsSync(path.join(apps, a.id))) continue;
        const files = await sat.json('/screens/app-files?app=' + encodeURIComponent(a.id));
        if (files.status !== 200 || !files.json?.files) continue;
        const tmp = path.join(root, '.in-' + a.id);
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const [rel, x] of Object.entries(files.json.files)) {
          if (rel.startsWith('kit/') || rel.split('/').some((s) => !s || s.startsWith('.') || s === '..')) continue; // (the kit is this bridge's own)
          const f = path.join(tmp, rel);
          if (!f.startsWith(tmp + path.sep)) continue;
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, x.s != null ? x.s : Buffer.from(String(x.b || ''), 'base64'));
        }
        const m = meta.get(a.id);
        fs.writeFileSync(path.join(tmp, 'app.json'), JSON.stringify({ name: m.name, ...(m.kit != null ? { kit: m.kit } : {}) }));
        fs.writeFileSync(path.join(tmp, '.v'), JSON.stringify({ v: files.json.v ?? a.v }));
        const dest = path.join(apps, a.id), old = path.join(root, '.old-' + a.id);
        fs.rmSync(old, { recursive: true, force: true });
        if (fs.existsSync(dest)) fs.renameSync(dest, old);
        fs.renameSync(tmp, dest);
        fs.rmSync(old, { recursive: true, force: true });
        versions.set(a.id, a.v);
        log(`[satellite] ${a.id} copied from the main tablet`);
      }
      for (const d of fs.readdirSync(apps)) if (!want.has(d)) { fs.rmSync(path.join(apps, d), { recursive: true, force: true }); versions.delete(d); meta.delete(d); }
      // The shared apps' grants, as the dev server reads them (device/vite.config.mjs grants): what each may reach.
      fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
      const shared = Object.fromEntries([...meta].filter(([, m]) => m.shared).map(([id, m]) => [id, { reaches: m.reaches }]));
      fs.writeFileSync(path.join(root, 'plugins', 'satellite.json'), JSON.stringify({ kind: 'shared', apps: shared }));
      return true;
    })().catch((e) => { log('[satellite] apps: ' + (e?.message || e)); return false; }).finally(() => { running = null; });
    return running;
  }
  const start = () => { sync(); timer = setInterval(sync, every); timer.unref?.(); };
  return { sync, start, stop: () => clearInterval(timer), meta, root };
}
