// The dev server that serves the apps (device/vite.config.mjs): a shared app (from a link) only on its own origin and
// always under its CSP, whatever the path looks like; nothing of webapp/ but the apps, the kit and Vite's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../../device/vite.config.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-vite-'));
fs.mkdirSync(path.join(root, 'plugins'));
fs.writeFileSync(path.join(root, 'plugins/evil.json'), JSON.stringify({ kind: 'shared', apps: { evil: { uses: [], reaches: ['api.example.com'] } } }));
fs.writeFileSync(path.join(root, 'plugins/calendar.json'), JSON.stringify({ kind: 'builtin', apps: { calendar: {} } }));
let mw; config.plugins.find((p) => p.name === 'plugin-apps').configureServer({ config: { root }, middlewares: { use: (f) => { mw = f; } } });
/** What the middleware does with a request: {code: the status it answered with, or 'next' (Vite serves it), csp, host}. */
function hit(host, url) {
  const req = { url, headers: { host, 'x-openhouse-host': 'made-up' } }, h = {};
  let out = null;
  const res = { setHeader: (k, v) => { h[k.toLowerCase()] = v; }, end: () => { out = res.statusCode; } };
  mw(req, res, () => { out = 'next'; });
  return { code: out, csp: h['content-security-policy'] || null, host: req.headers['x-openhouse-host'] };
}

test('a shared app is served only on its own origin, under its CSP, whatever the path', () => {
  const odd = ['/apps//evil/w.js', '//apps/evil/w.js', '/./apps/evil/w.js', '/apps/./evil/w.js', '/apps/evil/../evil/w.js', '/apps%2Fevil/w.js', '/%61pps/evil/w.js', '/apps/evil%2fw.js', '/apps/%2e%2e/evil/w.js', '/@fs/etc/passwd', '/apps\\evil/w.js'];
  for (const u of ['/apps/evil/w.js', '/apps/evil/index.html', ...odd]) assert.notEqual(hit('127.0.0.1:5173', u).code, 'next', `not on the main origin: ${u}`);
  for (const u of odd) { const r = hit('evil.localhost:5173', u); assert.notEqual(r.code, 'next', u); assert.match(r.csp, /connect-src 'self' https:\/\/api\.example\.com;/, u); }
  for (const u of ['/apps/evil/w.js', '/apps/evil/', '/kit/openhouse.js', '/bridge/house', '/@vite/client', '/nope', '/apps/calendar/main.js']) assert.match(hit('evil.localhost:5173', u).csp || '', /default-src 'self'/, `its CSP on ${u}`);
  assert.equal(hit('evil.localhost:5173', '/apps/evil/w.js').code, 'next');
  assert.notEqual(hit('evil.localhost:5173', '/apps/calendar/main.js').code, 'next', 'no other app on its origin');
  assert.notEqual(hit('calendar.localhost:5173', '/apps/calendar/main.js').code, 'next', 'an origin of its own only for a shared app');
  assert.equal(hit('127.0.0.1:5173', '/apps/calendar/main.js').code, 'next');
  assert.equal(hit('127.0.0.1:5173', '/apps/calendar/main.js').csp, null, 'ours as it was');
  assert.notEqual(hit('evil.example:5173', '/apps/calendar/main.js').code, 'next', 'no other host');
  assert.equal(hit('evil.localhost:5173', '/apps/evil/w.js').host, 'evil.localhost:5173', 'the bridge is told the real host, over what the page sent');
});

test('nothing of webapp/ but the apps, the kit and Vite\'s own', () => {
  for (const h of ['127.0.0.1:5173', 'evil.localhost:5173']) {
    for (const u of ['/.git/config', '/.git/logs/HEAD', '/MEMORY.md', '/CLAUDE.md', '/plugins/evil.json', '/plugins.json', '/package.json', '/src/settings.json', '/apps/home/style.json', '/apps/calendar/.git/config', '/node_modules/../.git/config', '/node_modules/x/.env'])
      assert.notEqual(hit(h, u).code, 'next', `${h}${u}`);
  }
  for (const u of ['/kit/openhouse.js', '/bridge/house', '/@vite/client', '/node_modules/.vite/deps/three.js', '/apps/calendar/index.html?v=1']) assert.equal(hit('127.0.0.1:5173', u).code, 'next', u);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a website the household approved for a shared app is in its CSP; one it only named at setup is not', () => {
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plugins/bus.json'), JSON.stringify({ kind: 'shared', apps: { bus: { uses: [], reaches: [], setupReaches: [{ key: 'transit-feed', why: 'x' }], chosen: [{ host: 'feed.example.org', key: 'transit-feed' }] } } }));
  assert.match(hit('bus.localhost:5173', '/apps/bus/main.js').csp, /connect-src 'self' https:\/\/feed\.example\.org;/);
  fs.writeFileSync(path.join(root, 'plugins/bus.json'), JSON.stringify({ kind: 'shared', apps: { bus: { uses: [], reaches: [], setupReaches: [{ key: 'transit-feed', why: 'x' }] } } }));
  assert.match(hit('bus.localhost:5173', '/apps/bus/main.js').csp, /connect-src 'self';/);
});
