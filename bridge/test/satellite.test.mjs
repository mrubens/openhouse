// Two tablets, one household (docs/multi-tablet.md): the kitchen tablet is the brain; the den tablet joins it with the
// code it shows and becomes its satellite (satellite.js, satellite-server.js). Pairing, what a tablet may reach, and
// nothing of the den tablet's own lost or changed while it's a satellite, and back when it leaves.
//   cd bridge && npm test
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
import { client } from '../../chat/src/screen-client.js';
import { TABLET_SCOPES } from '../screens.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_SRC = path.join(BRIDGE, '../chat/src');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };

/** A tablet's display folder: the bridge (and the screen client it carries, as the runtime bundles it) and its apps. */
function tablet(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openhouse-${name}-`));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  fs.mkdirSync(path.join(root, 'bridge/public/screen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/screen/index.html'), '<!doctype html><title>screen</title>');
  fs.mkdirSync(path.join(root, 'chat/src'), { recursive: true });
  for (const f of ['screen-client.js', 'seal.js', 'relay-client.js']) fs.copyFileSync(path.join(CHAT_SRC, f), path.join(root, 'chat/src', f));
  fs.mkdirSync(path.join(root, 'webapp')); initRepo(path.join(root, 'webapp'));
  return root;
}
async function start(root, extra = {}) {
  const [port, lanPort] = [await freePort(), await freePort()];
  let out = '';
  const child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, MAIL: 'off', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
  const exited = new Promise((r) => child.once('exit', r));
  return { child, url, lan: `http://127.0.0.1:${lanPort}`, out: () => out, exited,
    get: (p) => fetch(url + p, { headers: H }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) })),
    post: (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) })) };
}
/** Every file of the household's own under a display folder, with its hash: what must not change on a satellite. */
function householdFiles(root) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name), rel = path.relative(root, f);
    if (/^(bridge|chat|novoice|\.satellite)(\/|$)/.test(rel) || /\.log$/.test(rel)) continue;
    if (e.isDirectory()) walk(f); else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  } };
  walk(root);
  return out;
}

let kitchen, den, denRoot, kitchenRoot, denOwn, joinedCode, sat;
before(async () => {
  kitchenRoot = tablet('kitchen'); denRoot = tablet('den');
  kitchen = await start(kitchenRoot);
  // The den tablet was its own Opie before: a household of its own, with a list.
  sat = await start(denRoot);
  assert.equal((await sat.post('/household', { family: [{ name: 'Leo' }] })).status, 200);
  assert.equal((await sat.post('/house/list', { list: 'Den things', add: ['Batteries'] })).status, 200);
  assert.equal((await sat.get('/satellite')).j.satellite, false);
});
after(() => { for (const t of [kitchen, sat]) t?.child.kill(); for (const r of [kitchenRoot, denRoot]) if (r) fs.rmSync(r, { recursive: true, force: true }); });

test('joining: the main tablet shows a code, the new tablet types it, and joins at once as a tablet, once', async () => {
  const p = await kitchen.post('/screens/pair', { kind: 'tablet', address: '127.0.0.1' });
  assert.equal(p.status, 200);
  assert.match(p.j.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(!('key' in p.j), 'the one-time key is never shown, only the code it comes from');
  joinedCode = p.j.code;
  // A wrong code is refused, and doesn't change the tablet.
  assert.equal((await sat.post('/satellite/join', { code: 'AAAA-BBBB-CCCC', base: kitchen.lan })).status, 400);
  assert.equal((await sat.get('/satellite')).j.satellite, false);
  denOwn = householdFiles(denRoot);
  assert.ok(Object.keys(denOwn).some((f) => f.endsWith('house.json') || f.endsWith('household.json')), 'the den tablet has things of its own');
  const r = await sat.post('/satellite/join', { code: `${kitchen.lan}/tablet#${p.j.code}`, name: 'Den tablet' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  await sat.exited; // it starts again as a satellite
  const listed = (await kitchen.get('/screens')).j.screens.find((s) => s.name === 'Den tablet');
  assert.equal(listed?.kind, 'tablet');
  assert.deepEqual(listed.scopes, TABLET_SCOPES);
  // The same code again (another tablet that saw it): used.
  const other = await start(tablet('other'));
  try { assert.equal((await other.post('/satellite/join', { code: p.j.code, base: kitchen.lan })).status, 400); }
  finally { other.child.kill(); }
  den = await start(denRoot);
  const s = (await den.get('/satellite')).j;
  assert.equal(s.satellite, true);
  assert.equal(s.id, listed.id);
});

test('the den tablet shows and changes the household on the main tablet, and nothing of its own', async () => {
  const add = await den.post('/house/list', { list: 'Groceries', add: ['Milk'], who: 'Maya' });
  assert.equal(add.status, 200, JSON.stringify(add.j));
  assert.match(JSON.stringify((await kitchen.get('/house')).j), /Milk/, 'on the kitchen tablet');
  const house = (await den.get('/house')).j;
  assert.match(JSON.stringify(house), /Milk/);
  assert.doesNotMatch(JSON.stringify(house), /Batteries/, "the den tablet's own list isn't shown: it's the household's that is");
  assert.equal((await den.get('/home')).j.v, (await kitchen.get('/home')).j.v, 'the same home screen');
  assert.deepEqual(householdFiles(denRoot), denOwn, "nothing of the den tablet's own was changed");
});

test("what's the main tablet's stays there: refused on the den tablet, and by the main tablet itself", async () => {
  for (const [m, p] of [['POST', '/undo'], ['POST', '/restore'], ['POST', '/apps/delete'], ['GET', '/screens'], ['POST', '/screens/pair'], ['POST', '/screens/revoke'],
    ['POST', '/backup/now'], ['POST', '/backup/restore'], ['POST', '/cloud/link/start'], ['POST', '/cloud/unlink'], ['POST', '/household'], ['POST', '/calendar/feeds'], ['GET', '/devices'], ['POST', '/home/mcp'], ['GET', '/memory']]) {
    const r = m === 'POST' ? await den.post(p, {}) : await den.get(p);
    assert.equal(r.status, 403, `${m} ${p} on the den tablet`);
  }
  // A den tablet that was changed to send them anyway: the main tablet checks the scopes itself.
  const pairing = JSON.parse(fs.readFileSync(path.join(denRoot, '.satellite/pairing.json'), 'utf8'));
  const c = client({ base: kitchen.lan, id: pairing.id, key: pairing.key });
  for (const [m, p] of [['POST', '/undo'], ['POST', '/restore'], ['GET', '/screens'], ['POST', '/backup/now'], ['POST', '/household'], ['POST', '/satellite/join'], ['GET', '/cloud/link/start']]) {
    assert.equal((await c.json(m, p, m === 'POST' ? {} : undefined)).status, 403, `${m} ${p} at the main tablet`);
  }
  assert.equal((await c.json('GET', '/cloud/status')).json.linking, undefined, 'never the link codes');
});

test('removed on the main tablet: the den tablet stops at once; leaving gives it back its own things as they were', async () => {
  const id = (await den.get('/satellite')).j.id;
  assert.equal((await kitchen.post('/screens/revoke', { id })).j.ok, true);
  assert.equal((await den.get('/home')).status, 410);
  assert.equal((await den.post('/satellite/leave')).status, 200);
  await den.exited;
  assert.ok(!fs.existsSync(path.join(denRoot, '.satellite/pairing.json')), 'the pairing is gone');
  den = await start(denRoot);
  assert.equal((await den.get('/satellite')).j.satellite, false);
  assert.deepEqual((await den.get('/household')).j.family.map((f) => f.name), ['Leo'], 'its own household, back');
  assert.match(JSON.stringify((await den.get('/house')).j), /Batteries/);
  assert.doesNotMatch(JSON.stringify((await den.get('/house')).j), /Milk/, "the household's things never came to it");
  sat = den;
});
