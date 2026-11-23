// The dev server for the family's apps (webapp/apps/<id>/), as the display runs it (start.sh). Kept outside the apps
// folder, so it stays as the display ships it. Apps reach the bridge through /bridge and load the kit from /kit, both
// passed on to the bridge, so an app's page and its data come from one origin.
import fs from 'node:fs';
import path from 'node:path';

const bridge = { target: `http://127.0.0.1:${process.env.PORT || 8787}`, changeOrigin: true }; // (PORT: a hub sharing a computer, hub/start.sh)

// Files the agent creates that nothing imports yet (or that an undo left in Vite's module graph) would otherwise
// trigger a full page reload. Skip them; the edit that imports them will hot-update the importer. An app's own files
// (apps/<id>/) go through: the app reloads.
const skipOrphans = {
  name: 'skip-orphans',
  handleHotUpdate({ modules }) { return modules.filter((m) => m.importers.size > 0 || m.url === '/src/main.js' || m.url.startsWith('/apps/')); },
};

// The kit (/kit/openhouse.js) comes from the bridge at run time, through the proxy: not something to bundle.
const kitOutside = { name: 'kit-outside', enforce: 'pre', resolveId(id) { if (id.startsWith('/kit/')) return { id, external: true }; } };

// An app that came in a plugin (bridge/plugins.js, docs/plugins.md) runs on an origin of its own, http://<id>.localhost:5173
// (the shell and the home page load it there), so no other app's page can reach into it or it into theirs, and the
// bridge takes its key only from there (apps.js caller). Everything served on that host carries its CSP: it reaches only
// its own origin and the hosts its plugin was granted ("reaches" in webapp/plugins/<name>.json, shown on the install
// card), so the family's data goes nowhere they didn't say. Ours and the household's stay on 127.0.0.1, as they were.
//
// Only what pages need is served, on either host: an app's own folder, the kit and the bridge (passed on), and Vite's
// own modules and packages. Never the rest of webapp/ (its git history, the lock files, the agent's notes), and never a
// path that isn't plainly written (//, /./, ..., encoded slashes or dots, /@fs/).
let granted = { stamp: null, apps: new Map() };
function grants(root) {
  // webapp/plugins/<name>.json, one per plugin; only the ones from a link ("kind": "shared", or none: v1's) are bound.
  // Before the move to plugins: v1's one webapp/plugins.json.
  const dir = path.join(root, 'plugins'), legacy = path.join(root, 'plugins.json');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)); } catch {}
  if (!files.length && fs.existsSync(legacy)) files = [legacy];
  const stamp = files.map((f) => { try { const st = fs.statSync(f); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return f; } }).join('|');
  if (stamp !== granted.stamp) {
    const apps = new Map();
    for (const f of files) {
      try {
        const v = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const p of f === legacy ? Object.values(v) : [v]) {
          if (p?.kind && p.kind !== 'shared') continue;
          for (const [app, a] of Object.entries(p?.apps || {})) apps.set(app, [...(a.reaches || []), ...(a.chosen || []).map((c) => c?.host)].filter((h) => typeof h === 'string').filter((h) => /^(\*\.)?[a-z0-9.-]+(:\d+)?$/.test(h)).map((h) => `https://${h}`));
        }
      } catch {}
    }
    granted = { stamp, apps };
  }
  return granted.apps;
}
/** The hosts a shared app was granted (["https://…"]), or null when the app isn't a shared one. */
export const reachesOf = (root, id) => grants(root).get(id) ?? null;
export const pluginCsp = (hosts) => {
  const h = hosts.length ? ' ' + hosts.join(' ') : '';
  return `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; ` +
    `img-src 'self' data: blob:${h}; media-src 'self' data: blob:${h}; connect-src 'self'${h}; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; form-action 'self'; base-uri 'self'`;
};

const APP_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
const MAIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '10.0.2.2']); // (10.0.2.2: an emulator on the computer running this)
/** Which host a request came to: {main: true}, {app: id} (<id>.localhost), or null (anything else is refused). */
export function hostKind(hostHeader) {
  const h = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  if (MAIN_HOSTS.has(h)) return { main: true };
  const m = /^([a-z0-9][a-z0-9-]{0,60})\.localhost$/.exec(h);
  return m ? { app: m[1] } : null;
}
/**
 * Whether a path is one of the few things served (and plainly written), and which app's folder it is in:
 * {ok: true, app?: id} or {ok: false}. Raw request path, before any decoding.
 */
export function servable(rawUrl) {
  const raw = String(rawUrl || '').split(/[?#]/)[0];
  if (!raw.startsWith('/') || raw.includes('//') || raw.includes('\\') || /%(2f|5c|2e|00)/i.test(raw)) return { ok: false };
  let p; try { p = decodeURIComponent(raw); } catch { return { ok: false }; }
  if (p !== raw.replace(/%20/g, ' ') && /%/.test(raw)) return { ok: false }; // only spaces may be written encoded
  if (p.includes('\0') || path.posix.normalize(p) !== p || /(^|\/)\.\.?(\/|$)/.test(p)) return { ok: false };
  const seg = p.split('/').slice(1);
  if (p === '/') return { ok: true, root: true };
  if (seg[0] === 'kit' || seg[0] === 'bridge') return { ok: true, pass: true }; // passed on to the bridge, which checks them itself
  if (p === '/@vite/client' || p === '/@vite/env' || p.startsWith('/@id/')) return { ok: true };
  if (seg[0] === 'node_modules') return { ok: seg.slice(1).every((s, i) => !s.startsWith('.') || (i === 0 && s === '.vite')) };
  if (seg[0] === 'apps' && APP_ID.test(seg[1] || '') && seg[1] !== 'home' && seg.slice(2).every((s) => !s.startsWith('.'))) return { ok: true, app: seg[1] };
  return { ok: false };
}
const pluginApps = {
  name: 'plugin-apps',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const root = server.config.root, where = hostKind(req.headers.host), what = servable(req.url);
      const shared = (id) => reachesOf(root, id) !== null;
      const no = (code = 404) => { res.statusCode = code; res.setHeader('content-type', 'text/plain'); res.end(code === 403 ? 'Not here.' : 'Not found.'); };
      // The bridge learns which host a page was on from this, set here over anything the page sent (apps.js caller).
      req.headers['x-openhouse-host'] = String(req.headers.host || '').toLowerCase();
      if (!where) return no(403);
      if (where.app) {
        // A shared app's own host: its CSP on everything, workers and errors included, and nothing of the other apps.
        res.setHeader('Content-Security-Policy', pluginCsp(reachesOf(root, where.app) || []));
        if (!shared(where.app)) return no(403);
        if (!what.ok || what.root || (what.app && what.app !== where.app)) return no();
        return next();
      }
      if (!what.ok) return no();
      if (what.root) { res.statusCode = 200; res.setHeader('content-type', 'text/plain'); return res.end('vite'); } // (the shell's check that it's up)
      if (what.app && shared(what.app)) return no(); // a shared app is only on its own host
      next();
    });
  },
};

export default {
  plugins: [kitOutside, skipOrphans, pluginApps],
  server: {
    host: '127.0.0.1', port: Number(process.env.VITE_PORT || 5173), strictPort: true, hmr: { overlay: true },
    cors: false, // no page on another origin (a shared app's) reads what is served here
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'] }, // (Vite's own list, and git: a second line under pluginApps)
    proxy: { '/bridge': { ...bridge, rewrite: (p) => p.replace(/^\/bridge/, '') }, '/kit': bridge },
  },
  // Pre-bundle the game libraries at startup, so the first game doesn't wait (or reload) for it.
  optimizeDeps: { include: ['three', 'three/webgpu', 'three/tsl', 'phaser', '@dimforge/rapier2d-compat', '@dimforge/rapier3d-compat'] },
};
