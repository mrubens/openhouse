// Screens on the home network (screens.js): pairing, sealing, scopes and revoking, with the screen page's own client
// (chat/src/screen-client.js) and cipher (chat/src/seal.js).
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
import { pair, client, Removed } from '../../chat/src/screen-client.js';
import { CP, b64 } from '../../chat/src/seal.js';
import { allowed, DEFAULT_SCOPES } from '../screens.js';
import { pairingFromCode as codeInBrowser } from '../../chat/src/scrypt.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };

let child, url, lan, root, out = '';
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());

/** Pair a screen the way the page does: Settings starts it, the screen asks, the brain says yes (or no). */
async function join(name = 'Hall tablet', yes = true) {
  const p = await post('/screens/pair');
  const joined = pair({ base: lan, pair: p.pair, key: p.key, name });
  let asking;
  for (let i = 0; i < 50 && !asking; i++) { asking = (await get('/screens')).asking.find((a) => a.pair === p.pair); if (!asking) await wait(50); }
  assert.equal(asking?.name, name, 'the brain shows who is asking');
  await post('/screens/answer', { pair: p.pair, yes });
  return { p, welcome: await joined };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-screens-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  fs.mkdirSync(path.join(root, 'bridge/public/screen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/screen/index.html'), '<!doctype html><title>screen</title>');
  const app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  const [port, lanPort] = [await freePort(), await freePort()];
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  url = `http://127.0.0.1:${port}`; lan = `http://127.0.0.1:${lanPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
});
after(() => { child?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

test('off until a screen is added: nothing listens on the home network', async () => {
  assert.equal((await get('/screens')).lan, false);
  await assert.rejects(fetch(lan + '/screen/'));
});

test('pairing: QR key, the brain says yes, the screen gets its own key', async () => {
  const { welcome } = await join();
  assert.match(welcome.id, /^s-[0-9a-f]{8}$/);
  assert.equal(b64.dec(welcome.key).length, 32);
  assert.deepEqual(welcome.scopes, DEFAULT_SCOPES);
  const s = await get('/screens');
  assert.equal(s.lan, true);
  assert.ok(s.screens.some((x) => x.id === welcome.id && x.name === 'Hall tablet' && !('key' in x)), 'the list never shows keys');
  // The page itself is served on the home network, with no key.
  const page = await fetch(lan + '/screen/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('a pairing is used once, and a wrong key or a guess ends it', async () => {
  const { p } = await join('Once');
  const again = CP.seal(b64.dec(p.key), crypto.getRandomValues(new Uint8Array(12)), new TextEncoder().encode(`hello:${p.pair}`), new TextEncoder().encode('{"name":"x"}'));
  assert.equal((await fetch(lan + '/pair/hello', { method: 'POST', body: JSON.stringify({ pair: p.pair, box: b64.enc(again) }) })).status, 400, 'used pairing');

  const q = await post('/screens/pair');
  await assert.rejects(pair({ base: lan, pair: q.pair, key: b64.enc(crypto.randomBytes(32)), name: 'Wrong key' }));
  for (let i = 0; i < 5; i++) await fetch(lan + '/pair/hello', { method: 'POST', body: JSON.stringify({ pair: q.pair, box: 'AAAA' }) });
  await assert.rejects(pair({ base: lan, pair: q.pair, key: q.key, name: 'Too late' }), 'five misses end the pairing');
});

test('the brain can say no', async () => {
  const { welcome } = await join('Neighbour', false);
  assert.deepEqual(welcome, { refused: true });
  assert.ok(!(await get('/screens')).screens.some((x) => x.name === 'Neighbour'));
});

test('scopes: never undo, restore, apps, the builder, devices, the agents\' tools, the household, voices or screens', async () => {
  const { welcome } = await join('Curious');
  const c = client({ base: lan, ...welcome });
  for (const [m, p] of [['POST', '/undo'], ['POST', '/restore'], ['POST', '/apps/delete'], ['POST', '/request'], ['POST', '/cancel'], ['GET', '/devices'], ['POST', '/mcp/home'],
    ['POST', '/home/mcp'], ['GET', '/household'], ['POST', '/household'], ['POST', '/voice/wake'], ['GET', '/voice/events'], ['POST', '/calendar/feeds'], ['GET', '/screens'],
    ['POST', '/screens/pair'], ['POST', '/screens/answer'], ['POST', '/screens/revoke'], ['GET', '/events'], ['POST', '/board/refresh'], ['GET', '/chat/'], ['POST', '/house/photo']]) {
    assert.equal((await c.json(m, p, m === 'POST' ? {} : undefined)).status, 403, `${m} ${p}`);
  }
  assert.equal((await c.json('GET', '/home/../undo')).status, 403, 'paths are normalized before the check');
  // Without the home screen scope there's nothing at all.
  assert.equal(allowed(['ask'], 'GET', '/home'), false);
  assert.equal(allowed(['door'], 'POST', '/chat'), false);
  assert.equal(allowed(['door'], 'POST', '/home/arrange'), false);
  assert.equal(allowed(DEFAULT_SCOPES, 'GET', '/house/photo/a.jpg'), true);
});

test('the home network gets nothing unsealed: no display secret, no plain routes, no replays, no strangers', async () => {
  const { welcome } = await join('Replay');
  for (const p of ['/home', '/state', '/screens', '/chats']) assert.equal((await fetch(lan + p, { headers: H })).status, 404, `plain ${p}`);
  assert.equal((await fetch(lan + '/undo', { method: 'POST', headers: H })).status, 404);
  assert.equal((await fetch(lan + '/s', { method: 'POST', headers: { 'x-screen': 's-00000000' }, body: 'x' })).status, 401, 'unknown screen');
  assert.equal((await fetch(lan + '/s', { method: 'POST', headers: { 'x-screen': welcome.id }, body: crypto.randomBytes(60) })).status, 400, 'not sealed with its key');
  // The same sealed request twice: the second is refused.
  const K = b64.dec(welcome.key), te = new TextEncoder();
  const box = CP.seal(K, crypto.getRandomValues(new Uint8Array(12)), te.encode(`req:${welcome.id}`), te.encode(JSON.stringify({ n: Date.now() * 1000 + 999, m: 'GET', p: '/state' })));
  const send = () => fetch(lan + '/s', { method: 'POST', headers: { 'x-screen': welcome.id }, body: box });
  const first = await send(); await first.arrayBuffer();
  assert.equal(first.status, 200);
  assert.equal((await send()).status, 409);
  // Sealed for another screen: doesn't open.
  const other = (await join('Other')).welcome;
  assert.equal((await fetch(lan + '/s', { method: 'POST', headers: { 'x-screen': other.id }, body: box })).status, 400);
});

test('revoking: its open requests end now and the next one is refused', async () => {
  const { welcome } = await join('Old iPad');
  const c = client({ base: lan, ...welcome });
  const v = (await c.json('GET', '/home')).json.v;
  assert.equal((await c.json('GET', '/door')).json.v, v, 'the first name still answers, sealed too');
  const waiting = c.json('GET', `/home/wait?v=${v}`).then(() => 'answered', (e) => e);
  await wait(150);
  assert.equal((await post('/screens/revoke', { id: welcome.id })).ok, true);
  assert.ok((await waiting) instanceof Error, 'the long poll is cut off, not answered');
  await assert.rejects(c.json('GET', '/home'), Removed);
  assert.ok(!(await get('/screens')).screens.some((x) => x.id === welcome.id));
});

test('a TV shows a code, someone types it on the tablet, and the TV joins at once, only showing', async () => {
  const code = 'K7QM-2XD9-HPA4', via = codeInBrowser(code); // what the TV's page makes and shows
  assert.equal((await fetch(lan + '/tv', { redirect: 'manual' }).catch(() => null))?.headers.get('location') ?? '/screen/?tv', '/screen/?tv');
  assert.equal((await post('/screens/pair', { kind: 'tv', code: 'nope' })).error, "That isn't the TV's code. It's 12 letters and numbers.");
  assert.deepEqual(await fetch(lan + '/pair/ready?pair=' + via.pair).then((r) => r.json()), { ready: false });
  const p = await post('/screens/pair', { kind: 'tv', code: 'k7qm 2xd9 hpa4', name: 'Living room' });
  assert.equal(p.pair, via.pair);
  assert.deepEqual(await fetch(lan + '/pair/ready?pair=' + via.pair).then((r) => r.json()), { ready: true });
  const w = await pair({ base: lan, ...via, name: 'TV' }); // no Allow: typing the code was the yes
  assert.deepEqual(w.scopes, ['door']); assert.equal(w.kind, 'tv'); assert.equal(w.name, 'Living room');
  const c = client({ base: lan, id: w.id, key: w.key });
  assert.equal((await c.json('GET', '/house')).status, 200);
  assert.equal((await c.json('POST', '/house/list', { list: 'groceries', add: 'milk' })).status, 403, 'a TV only shows');
  assert.equal((await c.json('POST', '/chat', { text: 'hi' })).status, 403);
  // Asking whether it's ready costs nothing: a TV asks every few seconds without being shut out.
  for (let i = 0; i < 40; i++) await fetch(lan + '/pair/ready?pair=x' + i);
  assert.equal((await fetch(lan + '/pair/ready?pair=y')).status, 200);
});

test('a TV shows an app for screens: its files with the TV\'s own token, its reads sealed and read only', async () => {
  const apps = path.join(root, 'webapp/apps');
  fs.cpSync(path.join(BRIDGE, '../defaults/apps/tv'), path.join(apps, 'tv'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(apps, 'notes/index.html'), '<!doctype html>'); fs.writeFileSync(path.join(apps, 'notes/app.json'), '{"name":"Notes"}');
  const via = codeInBrowser('TV22-APPS-0001');
  await post('/screens/pair', { kind: 'tv', code: 'TV22-APPS-0001', name: 'Den' });
  const w = await pair({ base: lan, ...via, name: 'TV' });
  const c = client({ base: lan, id: w.id, key: w.key });
  const list = (await c.json('GET', '/screens/apps')).json;
  assert.deepEqual(list.map((a) => [a.id, a.name]), [['tv', 'TV']], 'only apps for TVs');
  assert.match(list[0].at, /^\/screen-app\/tv\/[\w-]{22}\/$/);
  assert.ok(!(await get('/apps')).some((a) => a.id === 'tv'), "the tablet doesn't list it");
  const page = await fetch(lan + list[0].at + 'index.html');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal((await fetch(lan + list[0].at + 'main.js')).headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(lan + list[0].at + 'app.json')).status, 404);
  assert.equal((await fetch(lan + list[0].at + '..%2f..%2fnotes/index.html')).status, 404);
  assert.equal((await fetch(lan + '/screen-app/tv/' + 'x'.repeat(22) + '/index.html')).status, 404, 'someone else\'s token');
  assert.equal((await fetch(lan + list[0].at.replace('/tv/', '/notes/') + 'index.html')).status, 404, 'not an app for TVs');
  // Its reads: marked with the app, GET only, and only an app this TV shows.
  assert.equal((await c.json('GET', '/house', undefined, { app: 'tv' })).status, 200);
  assert.equal((await c.json('POST', '/house/list', { list: 'groceries', add: 'x' }, { app: 'tv' })).status, 403);
  assert.equal((await c.json('GET', '/house', undefined, { app: 'notes' })).status, 403);
  // A TV layout from a link sees only what its card granted (here: the photos), as it would on the tablet; and the
  // household's own comes first.
  fs.mkdirSync(path.join(apps, 'frame'), { recursive: true });
  fs.writeFileSync(path.join(apps, 'frame/index.html'), '<!doctype html>'); fs.writeFileSync(path.join(apps, 'frame/app.json'), '{"name":"Frame","screens":["tv"]}');
  fs.mkdirSync(path.join(root, 'webapp/plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'webapp/plugins/frame.json'), JSON.stringify({ kind: 'shared', title: 'Frame', apps: { frame: { uses: ['photos'], screens: ['tv'] } } })); // (for a TV as its card said: fixed at install)
  const both = (await c.json('GET', '/screens/apps')).json.map((a) => a.id);
  assert.deepEqual(new Set(both), new Set(['tv', 'frame']));
  const seen = (await c.json('GET', '/house', undefined, { app: 'frame' })).json;
  assert.ok('photos' in seen && !('lists' in seen) && !('events' in seen), Object.keys(seen).join());
  assert.ok('lists' in (await c.json('GET', '/house', undefined, { app: 'tv' })).json);
  assert.equal((await c.json('GET', '/weather', undefined, { app: 'frame' })).status, 403);
  // Another screen (not a TV) has no apps of its own.
  const other = (await join('Den iPad')).welcome;
  assert.deepEqual((await client({ base: lan, id: other.id, key: other.key }).json('GET', '/screens/apps')).json, []);
});

test('a phone runs the household\'s apps: each call only what that app may do, its files only for an app on phones', async () => {
  const apps = path.join(root, 'webapp/apps');
  const mk = (id, meta, files = {}) => { fs.mkdirSync(path.join(apps, id), { recursive: true }); fs.writeFileSync(path.join(apps, id, 'app.json'), JSON.stringify(meta)); fs.writeFileSync(path.join(apps, id, 'index.html'), '<!doctype html><script type="module" src="./main.js"></script>'); for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(apps, id, f), t); };
  mk('jot', { name: 'Jot' }, { 'main.js': "import { house } from '/kit/openhouse.js';" });
  mk('bigboard', { name: 'Big board', screens: ['tablet'] }); // says it can't do a phone
  mk('chorly', { name: 'Chorly' });
  fs.mkdirSync(path.join(root, 'webapp/plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'webapp/plugins/chorly.json'), JSON.stringify({ kind: 'shared', title: 'Chorly', apps: { chorly: { uses: ['lists'] } } })); // from a link: lists only
  const p = await post('/screens/pair', { kind: 'phone', person: 'Maya', grownup: false });
  const w = await pair({ base: lan, pair: p.pair, key: p.key, name: "Maya's phone" });
  const c = client({ base: lan, id: w.id, key: w.key });
  const list = (await c.json('GET', '/screens/apps')).json, ids = list.map((a) => a.id);
  assert.ok(ids.includes('jot') && ids.includes('chorly'), ids.join());
  assert.ok(!ids.includes('bigboard') && !ids.includes('tv') && !ids.includes('frame'), 'not an app that says it can\'t, nor a TV\'s');
  assert.match(list.find((a) => a.id === 'jot').v, /^[\w-]{16}$/);
  // Its files, for its frame: never app.json; the kit files it names come along.
  const files = (await c.json('GET', '/screens/app-files?app=jot')).json;
  assert.ok(files.files['index.html'] && files.files['main.js'] && files.files['kit/openhouse.js'] && !files.files['app.json'], Object.keys(files.files).join());
  assert.equal((await c.json('GET', '/screens/app-files?app=bigboard')).status, 404);
  assert.equal((await c.json('GET', '/screens/app-files?app=..%2fjot')).status, 404);
  // A call marked with an app: that app's rights, as on the tablet.
  assert.equal((await c.json('POST', '/house/list', { list: 'groceries', add: 'eggs' }, { app: 'chorly' })).status, 200);
  assert.equal((await c.json('POST', '/house/chore', { add: { who: 'Maya', task: 'x' } }, { app: 'chorly' })).status, 403, 'not granted chores');
  const seen = (await c.json('GET', '/house', undefined, { app: 'chorly' })).json;
  assert.ok('lists' in seen && !('events' in seen) && !('chores' in seen), Object.keys(seen).join());
  assert.equal((await c.json('GET', '/house', undefined, { app: 'bigboard' })).status, 403, 'an app not on phones');
  assert.equal((await c.json('POST', '/voice/say', { text: 'hi' }, { app: 'jot' })).status, 403, 'a phone doesn\'t make the tablet speak');
  // Each app's own saved things: one app never reads another's.
  assert.equal((await c.json('POST', '/appdata/secret', { n: 1 }, { app: 'jot' })).status, 200);
  assert.deepEqual((await c.json('GET', '/appdata/secret', undefined, { app: 'jot' })).json, { n: 1 });
  assert.equal((await c.json('GET', '/appdata/secret', undefined, { app: 'chorly' })).status, 404);
  assert.equal((await c.json('GET', '/appdata/secret')).status, 403, 'and the phone itself has no app data');
  // The phone's own routes stay its scopes: an app's mark doesn't add to them, nor does a share key.
  assert.equal((await c.json('POST', '/chat', { text: 'hi' }, { app: 'jot' })).status, 403);
  // The frame's starting page: framed only by the phone's page, reaching nothing.
  fs.mkdirSync(path.join(root, 'bridge/public/phone'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/phone/frame.html'), '<!doctype html>');
  const fr = await fetch(lan + '/phone/frame.html');
  assert.match(fr.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(fr.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${lan}$`));
  // An app's own hosts (its "reaches"), named by the phone's page in the frame's address, and nothing else.
  const csp = (await fetch(lan + '/phone/frame.html?r=' + encodeURIComponent('tiles.example.org,*.maps.example.com,evil example.com,http://x.org,10.0.0.1'))).headers.get('content-security-policy');
  assert.match(csp, /connect-src https:\/\/tiles\.example\.org https:\/\/\*\.maps\.example\.com;/);
  assert.doesNotMatch(csp, /evil|x\.org|10\.0\.0\.1/);
  // A TV's app files never go to a phone's token, nor a phone's frames to a TV.
  const tvc = (await c.json('GET', '/screens/apps')).json.find((a) => a.at);
  assert.equal(tvc, undefined);
});

test('a phone is someone\'s: a kid\'s ticks and gets notes but can\'t ask; it gives its push address', async () => {
  const p = await post('/screens/pair', { kind: 'phone', person: 'Leo', grownup: false });
  // The code the tablet showed for Leo is the yes (whoever scans it is at the tablet): it joins with no Allow.
  const w = await pair({ base: lan, pair: p.pair, key: p.key, name: "Leo's phone" });
  assert.deepEqual(w.scopes, ['door', 'arrange', 'notify']); assert.equal(w.person, 'Leo');
  const c = client({ base: lan, id: w.id, key: w.key });
  assert.equal((await c.json('POST', '/house/list', { list: 'groceries', add: 'bread' })).status, 200);
  assert.equal((await c.json('POST', '/chat', { text: 'hi' })).status, 403, "a kid's phone doesn't ask");
  const k = await c.json('GET', '/phone/push');
  assert.equal(k.status, 200); assert.equal(Buffer.from(k.json.key, 'base64url').length, 65); assert.equal(k.json.on, false);
  const bad = await c.json('POST', '/phone/push', { subscription: { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } } });
  assert.equal(bad.status, 400, 'only real push services');
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: k.json.key, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } };
  assert.equal((await c.json('POST', '/phone/push', { subscription: sub })).json.on, true);
  assert.equal((await get('/screens')).screens.find((s) => s.id === w.id).push, true);
  // The display itself (no phone) can't set one.
  assert.equal((await fetch(url + '/phone/push', { headers: H })).status, 403);
  const adult = await post('/screens/pair', { kind: 'phone', person: '' });
  assert.equal(adult.error, 'whose phone?');
});
