// Away from home (relay.js, docs/networking.md): the bridge dials out to the cloud's relay (the real service code,
// the cloud repo's lambda/local.ts), and a paired screen or computer that isn't on the home network reaches it through the
// relay with the same sealed requests (chat/src/screen-client.js, relay-client.js); a phone list page too.
//   cd bridge && npm test      (needs a checkout of the cloud repo: cloud-service.mjs; without one this is skipped)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';
import { pair, client, Removed } from '../../chat/src/screen-client.js';
import { relayTransport } from '../../chat/src/relay-client.js';
import { localCloud, SKIP } from './cloud-service.mjs';

const local = await localCloud();
const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };
const opts = { skip: !local && SKIP };

let svc, child, url, lan, root, D, out = '', handoff;
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());
const until = async (f, what) => { for (let i = 0; i < 100; i++) { const v = await f(); if (v) return v; await wait(50); } throw new Error('timed out: ' + what); };

before(async () => {
  if (!local) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-relay-'));
  svc = await local.startLocal({ port: 0, dir: path.join(root, 'cloud'), host: '127.0.0.1', shuffle: true }); // out of order, as the cloud's relay can be
  // A tablet linked to a family, as linking leaves it (cloud.test.mjs links the long way).
  const secret = crypto.randomBytes(24).toString('base64url');
  await svc.store.put({ pk: 'DEVICE#00112233445566ff', sk: 'META', familyId: 'f1', credHash: sha(secret) });
  D = path.join(root, 'display');
  fs.mkdirSync(path.join(D, '.cloud'), { recursive: true });
  fs.writeFileSync(path.join(D, '.cloud/device.json'), JSON.stringify({ api: svc.url.replace('localhost', '127.0.0.1'), credential: `lh1_00112233445566ff_${secret}` }));

  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  fs.mkdirSync(path.join(root, 'bridge/public/screen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/screen/index.html'), '<!doctype html><title>screen</title>');
  const app = path.join(root, 'webapp'); fs.mkdirSync(app); initRepo(app);
  const [port, lanPort] = [await freePort(), await freePort()];
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, CLOUD_DISPLAY: D, HEARTBEAT: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  url = `http://127.0.0.1:${port}`; lan = `http://127.0.0.1:${lanPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
  // The shell's phone list page (Handoff.kt), as a stand-in: /i answers sealed bytes, /s takes them.
  handoff = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { res.writeHead(req.url === '/s' ? 200 : 200, { 'content-type': 'text/plain' }); res.end(req.url === '/i' ? 'SEALED-INFO' : `GOT:${b}`); }); });
  await new Promise((r) => handoff.listen(0, '127.0.0.1', r));
});
after(() => { child?.kill(); handoff?.close(); svc?.server.close(); svc?.server.closeAllConnections(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

async function join(name) {
  const p = await post('/screens/pair');
  const joined = pair({ base: lan, pair: p.pair, key: p.key, name });
  await until(async () => (await get('/screens')).asking.find((a) => a.pair === p.pair), 'asking');
  await post('/screens/answer', { pair: p.pair, yes: true });
  return joined;
}

test('off until someone turns it on: no socket, and devices are told it is off', opts, async () => {
  const s = await get('/relay');
  assert.deepEqual([s.on, s.linked, s.connected], [false, true, false]);
  assert.equal(svc.sockets.count(), 0);
  const w = await join('Phone');
  const c = client({ base: lan, id: w.id, key: w.key });
  assert.deepEqual((await c.json('GET', '/relay/me')).json, { off: true });
  // Not something an app or screen may change.
  assert.equal((await c.json('POST', '/relay', { on: true })).status, 403);
});

test('on: the tablet dials out; a device learns the relay at home and keeps working away, sealed the same', opts, async () => {
  assert.equal((await post('/relay', { on: true })).on, true);
  await until(async () => (await get('/relay')).connected, 'connected');
  const w = await join('Laptop');
  let cfg;
  const home = client({ base: lan, id: w.id, key: w.key, onRelay: (r) => (cfg = r) });
  assert.equal((await home.json('GET', '/state')).status, 200);
  await until(() => cfg, 'relay config');
  assert.match(cfg.relay, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(cfg.url, svc.url.replace('http', 'ws').replace('localhost', '127.0.0.1') + '/relay');

  // Away: the home network doesn't answer (a closed port stands in for it), so the relay carries it.
  const away = client({ base: 'http://127.0.0.1:1', id: w.id, key: w.key, relay: cfg, onRelay: () => {} });
  const r = await away.json('GET', '/state');
  assert.equal(r.status, 200); assert.ok(r.json && typeof r.json === 'object');
  assert.equal(away.where(), 'away');
  // A bigger answer, in many relay messages.
  const big = await away.request('GET', '/door');
  assert.equal(big.status, 200);
  const screens = (await get('/screens')).screens;
  assert.ok(screens.find((s) => s.id === w.id).away, 'the Screens list shows it came from away');

  // Removed on the tablet: the relay stops taking its requests.
  await post('/screens/revoke', { id: w.id });
  await assert.rejects(away.json('GET', '/state'), (e) => e instanceof Removed || /not paired|relay closed/.test(e.message));
});

test('a phone list page reaches its page on the tablet through the relay, only while it lasts', opts, async () => {
  const base = `http://127.0.0.1:${handoff.address().port}`;
  const h = await post('/relay/handoff', { base, minutes: 1 });
  assert.ok(h.token && h.relay);
  assert.equal(h.page, svc.url.replace('localhost', '127.0.0.1') + '/l', 'the same page, from the service, for the QR code');
  const t = relayTransport(h);
  await until(async () => { try { const r = await t.request({ k: 'h', p: 'i' }, new Uint8Array(0)); return (await r.text()) === 'SEALED-INFO'; } catch { return false; } }, 'list page through the relay');
  const s = await t.request({ k: 'h', p: 's' }, new TextEncoder().encode('tick'));
  assert.equal(await s.text(), 'GOT:tick');
  const many = 'x'.repeat(60_000); // more than one relay message each way
  assert.equal(await (await t.request({ k: 'h', p: 's' }, new TextEncoder().encode(many))).text(), 'GOT:' + many);
  assert.equal((await t.request({ k: 'h', p: '../etc' }, new Uint8Array(0))).status, 404);
  t.close();
  assert.equal((await post('/relay/handoff', { base: 'http://example.com:80' })).error, 'base');
  // The household's lasting photo page keeps its own token, and its page is the service's /p/ (PhotoShare.kt).
  const lasting = 'L'.repeat(24);
  const p = await post('/relay/handoff', { base, minutes: 60, token: lasting, page: 'p' });
  assert.equal(p.token, lasting);
  assert.equal(p.page, svc.url.replace('localhost', '127.0.0.1') + '/p');
  const pt = relayTransport(p);
  await until(async () => { try { return (await (await pt.request({ k: 'h', p: 'i' }, new Uint8Array(0))).text()) === 'SEALED-INFO'; } catch { return false; } }, 'photo page through the relay');
  pt.close();
  // A new link (or turned off): the old token comes off the relay's list at once.
  assert.equal((await post('/relay/handoff/end', { token: lasting })).ended, true);
  const gone = relayTransport(p);
  await assert.rejects(gone.request({ k: 'h', p: 'i' }, new Uint8Array(0)));
  gone.close();
  assert.notEqual((await post('/relay/handoff', { base, token: 'short' })).token, 'short');
});

test('off again: the socket closes', opts, async () => {
  await post('/relay', { on: false });
  await until(async () => !(await get('/relay')).connected && svc.sockets.count() === 0, 'closed');
});
