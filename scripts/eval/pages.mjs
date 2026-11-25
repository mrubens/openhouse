// The eval's view of an app's page (luna-build.mjs, rails-e2e.mjs): a small server for the apps' pages with the dev
// bridge behind /bridge and /kit and the tablet's installed libraries by name (as the display's dev server), and a
// headless Chrome load of a page with the app's key, collecting what it threw.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const IMPORTS = `<script type="importmap">${JSON.stringify({ imports: { phaser: '/node_modules/phaser/dist/phaser.esm.js', three: '/node_modules/three/build/three.module.js', 'three/webgpu': '/node_modules/three/build/three.webgpu.js', 'three/tsl': '/node_modules/three/build/three.tsl.js', 'three/addons/': '/node_modules/three/examples/jsm/', '@dimforge/rapier2d-compat': '/node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs', '@dimforge/rapier3d-compat': '/node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs' } })}</script>`;

/** { load(app, shot?, {viewport, picture}) -> {errs, text, png}, close() }. */
export async function pages({ BRIDGE, APP_DIR, LIBS = null, PLAYWRIGHT }) {
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/bridge/') || u.pathname.startsWith('/kit/')) {
      const target = BRIDGE + (u.pathname.startsWith('/bridge/') ? u.pathname.slice(7) : u.pathname) + u.search;
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = { ...req.headers }; delete headers.host;
      // An app limited like one from a link runs on its own origin, <id>.localhost (the dev server says so in
      // x-openhouse-host, over anything the page sent); the others on the display's, which the bridge takes as its own.
      const sub = /^([a-z0-9-]+\.localhost)(:\d+)?$/.exec(String(req.headers.host || ''))?.[1];
      delete headers['x-openhouse-host'];
      if (sub) { delete headers.origin; headers['x-openhouse-host'] = sub; }
      else if (headers.origin) headers.origin = BRIDGE;
      try {
        const r = await fetch(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch { res.writeHead(502); res.end(); }
      return;
    }
    const lib = u.pathname.startsWith('/node_modules/') && LIBS ? path.join(LIBS, path.normalize(u.pathname.slice(14)).replace(/^(\.\.[/\\])+/, '')) : null;
    if (lib && fs.existsSync(lib) && fs.statSync(lib).isFile()) { res.writeHead(200, { 'content-type': MIME[path.extname(lib)] || 'application/octet-stream' }); res.end(fs.readFileSync(lib)); return; }
    const m = u.pathname.match(/^\/apps\/([a-z0-9-]+)\/(.*)$/);
    const file = m ? path.join(APP_DIR, 'apps', m[1], m[2] || 'index.html') : null;
    if (!file || !file.startsWith(path.join(APP_DIR, 'apps')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(u.pathname === '/favicon.ico' ? 204 : 404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(path.extname(file) === '.html' ? fs.readFileSync(file, 'utf8').replace(/<head[^>]*>/i, (h) => h + IMPORTS) : fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PAGES = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /** Load an app's page as the tablet would (its key from the bridge), poke it a little (unless picture), and collect what it threw. */
  async function load(app, shot = null, { viewport = { width: 1536, height: 864 }, picture = false } = {}) {
    const { key, shared } = await (await fetch(`${BRIDGE}/apps/key?app=${app}`)).json();
    const base = shared ? PAGES.replace('127.0.0.1', `${app}.localhost`) : PAGES; // (Chrome takes *.localhost as this machine)
    const page = await browser.newPage({ viewport });
    const errs = [];
    let png = null;
    await page.addInitScript(([a, k]) => { window.OpenhouseApp = { app: () => a, key: () => k }; }, [app, key]);
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });
    page.on('response', (r) => { if (r.status() >= 400 && !(r.status() === 404 && r.url().includes('/bridge/appdata/'))) errs.push(`${r.status()} for ${new URL(r.url()).pathname}`); }); // (404 on appdata: nothing saved yet)
    page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 300)));
    try {
      await page.goto(`${base}/apps/${app}/index.html`, { waitUntil: 'load', timeout: 15e3 });
      await page.waitForTimeout(1500);
      if (!picture) {
        await page.mouse.click(768, 432); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space');
        await page.mouse.click(400, 600); await page.waitForTimeout(1000);
      }
      if (shot) await page.screenshot({ path: shot });
      if (picture) png = await page.screenshot({ type: 'jpeg', quality: 70 });
    } catch (e) { errs.push(`load: ${e.message.split('\n')[0]}`); }
    const text = await page.innerText('body').catch(() => '');
    await page.close();
    return { errs: [...new Set(errs)], text: text.slice(0, picture ? 1500 : 400), png };
  }
  return { load, close: async () => { await browser.close(); server.close(); } };
}
