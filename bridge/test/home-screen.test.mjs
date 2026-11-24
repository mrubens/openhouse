// The home screen's trash and put-back, and the speech log off by default.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };

let b;
before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-home-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$/.test(f) });
  const app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
  const get = async (p) => (await fetch(url + p, { headers: H })).json();
  const post = async (p, body = {}) => (await fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
  b = { root, url, get, post, stop: () => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); } };
});
after(() => b?.stop());

test('a note dragged to the trash can be put back, as it was', async () => {
  const n = await b.post('/board/pin', { title: 'Swim bag', text: 'Pack the swim bag' });
  assert.ok(n.id);
  await b.post('/home/arrange', { items: [{ key: n.id, page: 1, col: 3, row: 2, w: 2, h: 2 }] });
  await b.post('/home/remove', { id: n.id });
  let d = await b.get('/home');
  assert.equal(d.notes.find((x) => x.id === n.id), undefined);
  assert.deepEqual(d.trash.map((x) => x.id), [n.id]);
  assert.deepEqual(await b.post('/home/putback', { key: n.id }), { ok: true });
  d = await b.get('/home');
  const back = d.notes.find((x) => x.id === n.id);
  assert.ok(back, 'back on the home screen');
  assert.deepEqual([back.page, back.col, back.row, back.size], [1, 3, 2, '2x2']);
  assert.equal(back.trashed, undefined);
  assert.equal(d.trash.length, 0);
  assert.deepEqual(await b.post('/home/putback', { key: n.id }), { ok: false }, 'nothing to put back twice');
});

test('anything else on the home screen goes in the trash the same way (hidden), and comes back where it was', async () => {
  for (const key of ['clock', 'weather', 'app:lists', 'own:garden']) {
    await b.post('/home/arrange', { items: [{ key, page: 0, col: 3, row: 2, w: 2, h: 2 }] });
    await b.post('/home/place', { key, hidden: true });
    let d = await b.get('/home');
    assert.equal(d.places[key].hidden, true, key);
    assert.deepEqual(await b.post('/home/putback', { key }), { ok: true }, key);
    d = await b.get('/home');
    assert.deepEqual(d.places[key], { page: 0, col: 3, row: 2, w: 2, h: 2, hidden: false }, key);
  }
});

test('the speech log is off until someone turns it on', async () => {
  const s = await b.get('/voice/status');
  assert.equal(s.log, false);
  await b.post('/voice/log/setting', { on: true });
  assert.equal((await b.get('/voice/status')).log, true);
  await b.post('/voice/log/setting', { on: false });
  assert.equal((await b.get('/voice/status')).log, false);
});
