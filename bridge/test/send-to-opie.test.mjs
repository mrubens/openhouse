// Send to Opie from an iPhone's share sheet (docs/phones.md): the shortcut posts to the service's /send
// (the cloud repo's lambda/send.ts), which seals it with the phone's share key and passes it through the relay to the tablet,
// whose Opie takes it as from that person (phone-share.js) and answers. The real bridge and the real service code.
//   cd bridge && npm test      (needs a checkout of the cloud repo: cloud-service.mjs; without one this is skipped)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';
import { pair } from '../../chat/src/screen-client.js';
import { shareKey, relayToken } from '../screens.js';
import { localCloud, SKIP } from './cloud-service.mjs';

const local = await localCloud();
const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };
const opts = { skip: !local && SKIP };

let svc, child, url, lan, root;
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());
const until = async (f, what) => { for (let i = 0; i < 100; i++) { const v = await f(); if (v) return v; await wait(50); } throw new Error('timed out: ' + what); };

before(async () => {
  if (!local) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-send-'));
  svc = await local.startLocal({ port: 0, dir: path.join(root, 'cloud'), host: '127.0.0.1', shuffle: true }); // out of order, as the cloud's relay can be
  const secret = crypto.randomBytes(24).toString('base64url');
  await svc.store.put({ pk: 'DEVICE#00112233445566ff', sk: 'META', familyId: 'f1', credHash: sha(secret) });
  const D = path.join(root, 'display');
  fs.mkdirSync(path.join(D, '.cloud'), { recursive: true });
  fs.writeFileSync(path.join(D, '.cloud/device.json'), JSON.stringify({ api: svc.url.replace('localhost', '127.0.0.1'), credential: `lh1_00112233445566ff_${secret}` }));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  fs.mkdirSync(path.join(root, 'bridge/public/screen'), { recursive: true });
  const app = path.join(root, 'webapp'); fs.mkdirSync(app); initRepo(app);
  const [port, lanPort] = [await freePort(), await freePort()];
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, APP_DIR: app, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake-chat', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, CLOUD_DISPLAY: D, HEARTBEAT: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = `http://127.0.0.1:${port}`; lan = `http://127.0.0.1:${lanPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
});
after(() => { child?.kill(); svc?.server.close(); svc?.server.closeAllConnections(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

test("a link shared from Sam's iPhone reaches Opie as from Sam, and the answer comes back", opts, async () => {
  assert.equal((await post('/relay', { on: true })).on, true);
  const relay = await until(async () => { const r = await get('/relay'); return r.connected && r; }, 'connected');
  const join = async (person, grownup) => { const p = await post('/screens/pair', { kind: 'phone', person, grownup }); return pair({ base: lan, pair: p.pair, key: p.key, name: `${person}'s phone` }); };
  const sam = await join('Sam', true), leo = await join('Leo', false);
  const relayId = relay.relay || (await svc.store.scan('RELAY#'))[0].pk.slice(6);
  const auth = (w) => `OpenHouse ${relayId}.${w.id}.${relayToken(w.key)}.${shareKey(w.key).toString('base64url')}`;
  const send = (w, body, extra = {}) => fetch(svc.url + '/send', { method: 'POST', headers: { authorization: auth(w), 'content-type': 'text/plain', ...extra }, body });
  // The relay hears of the new phones' tokens.
  const r = await until(async () => { const x = await send(sam, 'https://example.com/chili'); return x.status !== 401 && x; }, 'the relay knows the phone');
  assert.equal(r.status, 200);
  assert.ok((await r.text()).length > 0, 'Opie answered');
  const chats = await get('/chats');
  const c = await get('/chats/' + chats[0].id);
  assert.equal(c.turns[0].who, 'Sam');
  assert.match(c.turns[0].text, /share sheet[\s\S]*https:\/\/example\.com\/chili/);
  // A kid's phone, a wrong key and no key get nowhere.
  assert.equal((await send(leo, 'hi')).status, 403);
  assert.equal((await fetch(svc.url + '/send', { method: 'POST', headers: { authorization: auth(sam).replace(/.{4}$/, 'AAAA') }, body: 'hi' })).status, 502);
  assert.equal((await fetch(svc.url + '/send', { method: 'POST', body: 'hi' })).status, 401);
  // Removing the phone ends its share key too.
  await post('/screens/revoke', { id: sam.id });
  assert.equal((await until(async () => { const x = await send(sam, 'again'); return x.status === 401 && x; }, 'refused once removed')).status, 401);
});
