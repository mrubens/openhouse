// The setup's own phone or computer (screens.js 'setup', brain.js /setup/*), through the real routes: its code alone
// doesn't let it in, it reaches /setup/* only while a step shows, what's typed on a plain http page (the PIN, iCloud's
// password) never leaves it, a calendar from it asks at the tablet, and its powers go when the setup ends.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';
import { pair, client } from '../../chat/src/screen-client.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };

let child, url, lan, root, shell, out = '';
const toShell = []; // what reached the tablet's shell: [path, body]
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());

before(async () => {
  // A stand-in for the tablet's shell (DeviceServer.kt): it records each call and says yes.
  shell = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    toShell.push([req.url, JSON.parse(b || '{}')]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/calendar' ? { added: true } : req.url === '/host' ? {} : { ok: true, here: true }));
  }); });
  await new Promise((r) => shell.listen(0, '127.0.0.1', r));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-setup-'));
  const cfg = path.join(root, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { device: { url: `http://127.0.0.1:${shell.address().port}/mcp`, headers: { Authorization: 'Bearer t' } } } }));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  const app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  const [port, lanPort, mdnsPort] = [await freePort(), await freePort(), await freePort()];
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, APP_DIR: app,
      DEVICE_MCP_CONFIG: cfg, CONNECT_HOSTNAME: 'openhouse-test.local', CONNECT_MDNS_PORT: String(mdnsPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  url = `http://127.0.0.1:${port}`; lan = `http://127.0.0.1:${lanPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
});
after(() => { child?.kill(); shell?.close(); fs.rmSync(root, { recursive: true, force: true }); });

/** The setup's code, used by a phone or computer: it asks, and joins only once the tablet says yes. */
async function setupDevice(yes = true) {
  const p = await post('/screens/pair', { setup: true, person: 'Sam', address: '127.0.0.1' });
  assert.equal(p.host, undefined, 'no name for a computer to type: anyone on the Wi-Fi could answer one');
  const joined = pair({ base: lan, pair: p.pair, key: p.key, name: 'A computer' });
  let asking;
  for (let i = 0; i < 50 && !asking; i++) { asking = (await get('/screens')).asking.find((a) => a.pair === p.pair); if (!asking) await wait(50); }
  assert.equal(asking?.name, 'A computer', 'the code alone is not a yes: the tablet shows what asked');
  assert.ok(!(await get('/screens')).screens.some((s) => (s.scopes || []).includes('setup')), 'not in before the yes');
  await post('/screens/answer', { pair: p.pair, yes });
  return joined;
}

test('the setup: a yes at the tablet, /setup/* only while a step shows, nothing typed on plain http sent, and its powers end with it', async () => {
  const w = await setupDevice();
  assert.ok(w.scopes.includes('setup'));
  assert.equal(w.base, lan, 'where it finds the tablet afterwards: its own address, not a name');
  const c = client({ base: lan, ...w });
  assert.equal((await c.json('POST', '/setup/household', { location: 'Springfield' })).status, 409, 'no setup step showing: refused');
  assert.equal((await c.json('POST', '/setup/invite', { person: 'Alex' })).status, 409);

  await post('/setup/step', { step: 'people' });
  assert.equal((await c.json('POST', '/setup/household', { location: 'Springfield' })).status, 200, 'a step showing: in');
  // Linking: the setup device may start it and see how far it is, but the yes to an account is a person's tap there.
  assert.equal((await c.json('GET', '/setup/link')).json.linked, false);
  assert.equal((await c.json('POST', '/cloud/link/confirm', { ok: true })).status, 403, 'the yes to an account is the tablet\'s own');
  assert.equal((await c.json('POST', '/cloud/link/start', {})).status, 403);

  // Its page came over plain http: the PIN and iCloud's password are typed at the device, never sent from here.
  toShell.length = 0;
  assert.equal((await c.json('POST', '/setup/pin', { pin: '4826' })).json.here, true);
  assert.equal((await c.json('POST', '/setup/icloud', { user: 'sam@example.com', pass: 'abcd-efgh-ijkl-mnop', who: 'Sam' })).json.here, true);
  const sent = JSON.stringify(toShell);
  assert.ok(!sent.includes('4826') && !sent.includes('abcd-efgh'), 'the PIN and the password never reach the shell from here');
  assert.deepEqual(toShell.map(([p, b]) => [p, b.here]), [['/setup/pin', true], ['/setup/icloud', true]]);

  // A calendar's link from it: the tablet's own card asks (not trusted).
  toShell.length = 0;
  await c.json('POST', '/setup/calendar', { link: 'https://example.com/basic.ics', who: 'Sam' });
  const cal = toShell.find(([p]) => p === '/calendar');
  assert.equal(cal?.[1].trusted, false, 'a yes at the tablet');

  // The setup ends: no setup scope on any device, and /setup/* is refused for good.
  await post('/setup/step', { step: null });
  assert.ok(!(await get('/screens')).screens.some((s) => (s.scopes || []).includes('setup')), 'the setup scope went with the setup');
  assert.equal((await c.json('POST', '/setup/invite', { person: 'Alex' })).status, 403);
  assert.equal((await c.json('POST', '/setup/household', { family: [{ name: 'Mallory' }] })).status, 403);
  await post('/setup/step', { step: 'people' }); // (even a step shown again doesn't bring them back)
  assert.equal((await c.json('POST', '/setup/household', { location: 'Elsewhere' })).status, 403);
  await post('/setup/step', { step: null });
});

test('the setup: a no at the tablet keeps it out', async () => {
  const w = await setupDevice(false);
  assert.deepEqual(w, { refused: true });
});
