// The family's apps (apps.js): the list, each app's own key and what it opens, the kit, and the home screen page.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };

let child, url, root;
const get = (p, h = H) => fetch(url + p, { headers: h });
const KIT_V2 = '// the kit, version 2\nexport const house = {};\n';
const asApp = (app, key) => ({ 'x-openhouse-app': app, 'x-openhouse-key': key, 'content-type': 'application/json' });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-apps-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  // A kit version 2 as a later release would add it, so version 1 is seen kept for an app that names it.
  fs.writeFileSync(path.join(root, 'bridge/kit/openhouse-v2.js'), KIT_V2);
  const kv = path.join(root, 'bridge/kit-version.js');
  fs.writeFileSync(kv, fs.readFileSync(kv, 'utf8').replace("{ 1: 'openhouse.js' }", "{ 1: 'openhouse.js', 2: 'openhouse-v2.js' }").replace('KIT_LATEST = 1', 'KIT_LATEST = 2'));
  fs.mkdirSync(path.join(root, 'bridge/public/screen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/screen/index.html'), '<!doctype html><title>home</title>');
  const app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  for (const [id, meta] of [['lists', { name: 'Lists' }], ['snack-attack', { name: 'Snack Attack' }], ['jot', { name: 'Jot', kit: 1 }]]) {
    fs.mkdirSync(path.join(app, 'apps', id), { recursive: true });
    fs.writeFileSync(path.join(app, 'apps', id, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(app, 'apps', id, 'app.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(app, 'apps', id, 'icon.svg'), '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
  }
  fs.mkdirSync(path.join(app, 'apps', 'half-made')); // no index.html yet: not an app
  fs.mkdirSync(path.join(app, 'apps', 'home'));
  fs.writeFileSync(path.join(app, 'apps', 'home', 'style.json'), JSON.stringify({ door: '#c8d4e0', clock: false }));
  fs.writeFileSync(path.join(app, 'apps', 'home', 'index.html'), '<!doctype html>');
  // A Sonos and a phone, as a scan left them (nothing is reached on the network: no shell here to ask, so changes are refused).
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ scannedAt: new Date().toISOString(), recipes: {}, pairing: { 'mac-aabbccddeeff': { allowed: true } }, devices: [
    { id: 'mac-aabbccddeeff', name: 'Living Room', kind: 'speaker', maker: 'Sonos', model: 'Play:3', driver: 'sonos', address: '10.9.8.7', mac: 'aa:bb:cc:dd:ee:ff', room: 'Living Room', present: true, evidence: { mdns: [], ssdp: [], ports: [1400] } },
    { id: 'mac-112233445566', name: 'Maya\'s phone', kind: 'phone', driver: null, address: '10.9.8.8', mac: '11:22:33:44:55:66', present: true, evidence: { mdns: [], ssdp: [], ports: [] } }] }));
  const port = await freePort();
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), APP_DIR: app, AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, DEVICES_FILE: path.join(root, 'devices.json'), DEVICE_MCP_CONFIG: path.join(root, 'no-shell.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
});
after(() => { child?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

const keyFor = async (id) => (await (await get('/apps/key?app=' + id)).json()).key;

test('only the display gets an app\'s key', async () => {
  assert.equal((await get('/apps/key?app=lists', {})).status, 401);
  const k = await keyFor('lists');
  assert.ok(k.length > 20);
  assert.equal(await keyFor('lists'), k, 'the same key until the bridge restarts');
  assert.notEqual(await keyFor('snack-attack'), k);
  assert.equal((await get('/apps/key?app=lists', asApp('lists', k))).status, 403, 'an app can\'t ask for keys');
});

test('an app\'s key opens the house, the home screen, timers and speaking, and nothing else', async () => {
  const k = await keyFor('lists'), h = asApp('lists', k);
  assert.equal((await get('/house', h)).status, 200);
  assert.equal((await get('/home', h)).status, 200);
  assert.equal((await get('/door', h)).status, 200, 'the first name still answers');
  assert.equal((await get('/apps', h)).status, 200);
  const r = await fetch(url + '/house/list', { method: 'POST', headers: h, body: JSON.stringify({ list: 'Groceries', add: ['Milk'] }) });
  assert.equal(r.status, 200);
  assert.ok((await (await get('/house')).json()).lists.find((l) => l.id === 'groceries').items.some((i) => i.text === 'Milk'));
  assert.equal((await fetch(url + '/home/timer', { method: 'POST', headers: h, body: JSON.stringify({ start: { label: 'Tea', seconds: 60 } }) })).status, 200);
  for (const [m, p] of [['POST', '/undo'], ['POST', '/restore'], ['POST', '/apps/delete'], ['POST', '/request'], ['POST', '/cancel'], ['POST', '/chat'], ['GET', '/chats'],
    ['GET', '/devices'], ['POST', '/home/mcp'], ['POST', '/mcp/home'], ['POST', '/home/arrange'], ['POST', '/home/remove'], ['GET', '/household'], ['POST', '/household'],
    ['POST', '/voice/wake'], ['GET', '/voice/events'], ['GET', '/screens'], ['POST', '/screens/pair'], ['POST', '/calendar/feeds'], ['GET', '/events']]) {
    const res = await fetch(url + p, { method: m, headers: h, ...(m === 'POST' ? { body: '{}' } : {}) });
    assert.equal(res.status, 403, `${m} ${p}`);
  }
});

test('an app gets the kit version its app.json names; /kit/openhouse.js is the newest for the rest', async () => {
  const v1 = fs.readFileSync(path.join(BRIDGE, 'kit/openhouse.js'), 'utf8');
  const kit = (p, h = {}) => fetch(url + p, { headers: h }).then(async (r) => [r.status, await r.text()]);
  assert.deepEqual(await kit('/kit/v1/openhouse.js'), [200, v1]);
  assert.deepEqual(await kit('/kit/openhouse.js', { referer: 'http://127.0.0.1:5173/apps/jot/main.js' }), [200, v1], 'jot says "kit": 1');
  assert.deepEqual(await kit('/kit/openhouse.js', { 'x-openhouse-host': 'jot.localhost:5173' }), [200, v1], 'on its own origin too');
  assert.deepEqual(await kit('/kit/openhouse.js', { referer: 'http://127.0.0.1:5173/apps/lists/main.js' }), [200, KIT_V2], 'one that names none');
  assert.deepEqual(await kit('/kit/openhouse.js'), [200, KIT_V2]);
  assert.equal((await fetch(url + '/kit/v9/openhouse.js')).status, 404);
});

test('a wrong key, or one app\'s key for another, opens nothing', async () => {
  const k = await keyFor('lists');
  assert.equal((await get('/house', asApp('lists', k + 'x'))).status, 401);
  assert.equal((await get('/house', asApp('snack-attack', k))).status, 401);
  assert.equal((await get('/house', asApp('../x', k))).status, 401);
});

test('the kit and the home screen page need no key; nothing else does', async () => {
  const js = await fetch(url + '/kit/openhouse.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('access-control-allow-origin'), '*');
  assert.match(await js.text(), /export const house/);
  assert.equal((await fetch(url + '/kit/openhouse.css')).status, 200);
  assert.equal((await fetch(url + '/kit/../server.js')).status, 401);
  assert.equal((await fetch(url + '/screen/')).status, 200);
  const rebound = await new Promise((r) => http.get(url + '/screen/', { headers: { host: 'evil.example' } }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(rebound, 401, 'not for a page that rebound its name to this device');
  assert.equal((await fetch(url + '/house')).status, 401);
  assert.equal((await fetch(url + '/apps')).status, 401);
});

test('each app keeps its own saved things; nobody else reads them', async () => {
  const lists = asApp('lists', await keyFor('lists')), snack = asApp('snack-attack', await keyFor('snack-attack'));
  const put = (h, name, v) => fetch(url + '/appdata/' + name, { method: 'POST', headers: h, body: JSON.stringify(v) });
  assert.equal((await put(lists, 'progress', { level: 3 })).status, 200);
  assert.deepEqual(await (await get('/appdata/progress', lists)).json(), { level: 3 });
  assert.equal((await get('/appdata/progress', snack)).status, 404, 'another app sees nothing');
  assert.equal((await get('/appdata/progress')).status, 403, 'not the display either: it is the app\'s');
  assert.equal((await get('/appdata/../house', lists)).status, 200, 'a path that leaves /appdata is just another route');
  assert.equal((await fetch(url + '/appdata/progress', { method: 'POST', headers: lists, body: 'not json' })).status, 400);
  assert.equal((await put(lists, 'progress', null)).status, 200);
  assert.equal((await get('/appdata/progress', lists)).status, 404, 'null deletes it');
});

test('the home\'s devices: only for an app granted "devices", with no addresses, and its changes still ask', async () => {
  const plugins = path.join(root, 'webapp/plugins');
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, 'remote.json'), JSON.stringify({ kind: 'shared', title: 'Remote', apps: { remote: { uses: ['devices'] } } }));
  fs.writeFileSync(path.join(plugins, 'clock.json'), JSON.stringify({ kind: 'shared', title: 'Clock', apps: { clock: { uses: ['weather'] } } }));
  const shared = new Set(['remote', 'clock']); // a shared app's key works only from its own origin
  const post = async (app, p, b) => fetch(url + p, { method: 'POST', headers: { ...asApp(app, await keyFor(app)), ...(shared.has(app) ? { 'x-openhouse-host': `${app}.localhost:5173` } : {}) }, body: JSON.stringify(b) });
  for (const p of ['/apps/devices', '/apps/devices/get', '/apps/devices/do']) assert.equal((await post('clock', p, {})).status, 403, `not granted: ${p}`);
  const r = await post('remote', '/apps/devices', {});
  assert.equal(r.status, 200);
  const text = await r.text(), { devices } = JSON.parse(text);
  assert.equal(devices.length, 1, 'the speaker, not the phone');
  assert.ok(devices[0].actions.some((a) => a.name === 'play'));
  assert.ok(!/10\.9\.8|aa:bb|aabbcc|mac-/i.test(text), 'no address, MAC or the bridge\'s own id');
  assert.equal(devices[0].id, (await (await post('lists', '/apps/devices', {})).json()).devices[0].id, 'the family\'s own app has it too');
  // The assistant's yes isn't the app's: with nobody here to ask, a change is refused before the speaker is reached.
  assert.equal((await (await post('remote', '/apps/devices/do', { id: devices[0].id, action: 'pause' })).json()).ok, false);
  assert.equal((await (await post('remote', '/apps/devices/do', { id: 'mac-aabbccddeeff', action: 'pause' })).json()).ok, false, 'not by the real id');
});

test('a key works only from its own app\'s origin: a shared app\'s from <id>.localhost, ours not from a shared app\'s', async () => {
  fs.mkdirSync(path.join(root, 'webapp/plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'webapp/plugins/thief.json'), JSON.stringify({ kind: 'shared', title: 'Thief', apps: { thief: { uses: [] } } }));
  const ours = asApp('lists', await keyFor('lists')), theirs = asApp('thief', await keyFor('thief'));
  const at = (h, host, origin) => get('/house', { ...h, ...(host ? { 'x-openhouse-host': host } : {}), ...(origin ? { origin } : {}) });
  assert.equal((await at(ours, '127.0.0.1:5173')).status, 200);
  assert.equal((await at(ours, null, 'http://127.0.0.1:5173')).status, 200);
  assert.equal((await at(ours, 'thief.localhost:5173')).status, 401, 'our key from a shared app\'s page, through the dev server');
  assert.equal((await at(ours, null, 'http://thief.localhost:5173')).status, 401, 'our key from a shared app\'s page, straight to the bridge');
  assert.equal((await at(ours, '127.0.0.1:5173', 'http://thief.localhost:5173')).status, 401, 'its Origin wins over a host it made up');
  assert.equal((await at(theirs, 'thief.localhost:5173')).status, 200);
  assert.equal((await at(theirs, '127.0.0.1:5173')).status, 401, 'a shared app\'s key only on its own host');
  assert.equal((await at(theirs, null)).status, 401);
  assert.equal((await at(theirs, 'other.localhost:5173')).status, 401);
  assert.equal((await get('/house', { ...theirs, origin: 'null' })).status, 403, 'an opaque page is refused outright');
});

test('a calendar note\'s photos come only from hosts its app reaches, over https', async () => {
  const { picsOf } = await import('../day-notes.js');
  const { reachMatches } = await import('../app-web.js');
  const ok = (u) => reachMatches(u.host, ['*.nutrislice.com']);
  const pics = picsOf({ pics: [{ text: 'A', image: 'https://images.nutrislice.com/a.jpg' }, { text: 'B', image: 'https://elsewhere.example/b.jpg' },
    { text: 'C', image: 'http://images.nutrislice.com/c.jpg' }, { text: 'D', image: 'https://user:pw@images.nutrislice.com/d.jpg' }] }, ok);
  assert.deepEqual(pics.map((p) => !!p.image), [true, false, false, false]);
  assert.equal(picsOf({ pics: [{ text: 'A', image: 'https://images.nutrislice.com/a.jpg' }] })[0].image, undefined); // no reaches: no photos
});

test('an app reports only its own page\'s errors, whatever app its report names; the display names the app', async () => {
  const lists = asApp('lists', await keyFor('lists'));
  const report = (h, text) => fetch(url + '/apperror', { method: 'POST', headers: h, body: JSON.stringify({ app: 'snack-attack', text }) });
  assert.equal((await report(lists, 'marker-from-lists')).status, 200);
  assert.equal((await report(H, 'marker-from-display')).status, 200);
  const r = await (await fetch(url + '/workshop/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_build', arguments: { app: 'snack-attack' } } }) })).json();
  const said = JSON.stringify(r.result);
  assert.ok(said.includes('marker-from-display'), said);
  assert.ok(!said.includes('marker-from-lists'), 'another app\'s report never lands on this one');
});
