// Away from home with Tailscale (tailscale.js): the tailnet is one more carrier, never a way around sealing. Requests
// that come over it (tailscale serve passes them on to the home network's port, from this machine, with the tailnet
// name as their Host) get only what the Wi-Fi gets: sealed requests from a paired device, within its scopes. And on a
// computer with Tailscale of its own, turning it off takes only our address away, never the computer's sign-in.
// A stand-in for the `tailscale` CLI plays a signed-in node with HTTPS on.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';
import { pair, client } from '../../chat/src/screen-client.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };
const NAME = 'opie.tail-test.ts.net';

let child, url, lan, lanPort, root, calls;
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());

/** A request to the home network's port as tailscale serve passes one on: from this machine, Host the tailnet name. */
function overTailnet(u, { method = 'GET', headers = {}, body } = {}) {
  const x = new URL(u);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: lanPort, path: x.pathname + x.search, method, headers: { ...headers, host: NAME, 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' } }, (res) => {
      resolve(new Response([204, 304].includes(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode, headers: Object.entries(res.headers).filter(([, v]) => typeof v === 'string') }));
    });
    r.on('error', reject);
    if (body) r.write(Buffer.from(body instanceof Uint8Array ? body : String(body)));
    r.end();
  });
}
const tsFetch = (u, o = {}) => overTailnet(u, { method: o.method || 'GET', headers: o.headers || {}, body: o.body });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-tailscale-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  fs.mkdirSync(path.join(root, 'bridge/public/screen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/screen/index.html'), '<!doctype html><title>screen</title>');
  const app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  // The stand-in CLI: every call written down; a node that's signed in, with HTTPS on for the tailnet.
  calls = path.join(root, 'calls.txt');
  const cli = path.join(root, 'tailscale');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst fs = require('fs'); const a = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, a.join(' ') + '\\n');\n` +
    `if (a[0] === 'status') console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '${NAME}.', TailscaleIPs: ['100.101.102.1'] }, CertDomains: ['${NAME}'] }));\n`, { mode: 0o755 });
  const port = await freePort(); lanPort = await freePort();
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, OPENHOUSE_TAILSCALE: cli },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  url = `http://127.0.0.1:${port}`; lan = `http://127.0.0.1:${lanPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
});
after(() => { child?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

test('over the tailnet: links use its address, and it reaches only sealed requests within a device\'s scopes', async () => {
  assert.equal((await get('/tailscale')).on, false, 'off until someone turns it on');
  await post('/tailscale', { on: true });
  let t; for (let i = 0; i < 50 && t?.state !== 'on'; i++) { await wait(100); t = await get('/tailscale'); }
  assert.equal(t.address, `https://${NAME}:${lanPort}`, "a computer's own Tailscale: our address on the home network's port, not its 443");

  // A screen's QR code points at the tailnet address now.
  const p = await post('/screens/pair');
  assert.equal(p.base, t.address); assert.equal(p.via, 'tailscale');
  const joined = pair({ base: lan, pair: p.pair, key: p.key, name: 'Hall tablet' });
  let asking; for (let i = 0; i < 50 && !asking; i++) { asking = (await get('/screens')).asking.find((a) => a.pair === p.pair); if (!asking) await wait(50); }
  await post('/screens/answer', { pair: p.pair, yes: true });
  const w = await joined;

  // Nothing unsealed: Settings' own routes aren't on that port, an unknown device or a box that doesn't open is refused.
  assert.equal((await overTailnet(lan + '/screens')).status, 404);
  assert.equal((await overTailnet(lan + '/state')).status, 404);
  const unknown = await overTailnet(lan + '/s', { method: 'POST', headers: { 'x-screen': 's-00000000' }, body: 'x'.repeat(40) });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.headers.get('access-control-allow-origin'), '*', 'a page on the Wi-Fi\'s address may send sealed requests here');
  assert.equal((await overTailnet(lan + '/s', { method: 'POST', headers: { 'x-screen': w.id }, body: 'x'.repeat(40) })).status, 400, 'not sealed with its key');
  // Another origin may read only /s and the "am I home?" check, and only over the tailnet.
  assert.equal((await overTailnet(lan + '/pair/hello', { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(lan + '/s', { method: 'POST', headers: { 'x-screen': 's-00000000' }, body: 'x' })).headers.get('access-control-allow-origin'), null, 'not on the Wi-Fi');

  // The device's own client, with the Wi-Fi missing: over the tailnet, sealed, and its scopes as on the Wi-Fi.
  const c = client({ base: 'http://127.0.0.1:1', id: w.id, key: w.key, tailnet: lan, fetch: tsFetch, probeMs: 500 });
  assert.equal((await c.json('GET', '/house')).status, 200);
  assert.equal((await c.json('GET', '/screens')).status, 403, 'scopes are the same over the tailnet');
  const me = await c.json('GET', '/relay/me');
  assert.equal(me.json.tailnet, t.address, 'paired devices learn the address, sealed');

  // Off: our address goes, the computer's own Tailscale stays signed in.
  await post('/tailscale', { on: false });
  const said = fs.readFileSync(calls, 'utf8');
  assert.match(said, new RegExp(`serve --https=${lanPort} off`));
  assert.doesNotMatch(said, /^logout/m, 'never signs a computer\'s own Tailscale out');
  assert.equal((await post('/screens/pair')).via, undefined);
});
