// The workshop (workshop.js): a computer pairs with a code, then its AI app changes the apps and the home screen
// through connect/openhouse-mcp.mjs, the way Claude Code would; every change goes in as one undoable change.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';
import { pairingFromCode, newCode, allowed, COMPUTER_SCOPES, DEFAULT_SCOPES } from '../screens.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(BRIDGE, '../connect/openhouse-mcp.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };

let child, url, lan, root, app, out = '', mcp, pairingFile, mdnsPort, startBridge;
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());
const git = (...a) => execFileSync('git', a, { cwd: app, encoding: 'utf8' }).trim();

/** The stdio MCP, as Claude Code runs it: one JSON message per line each way. */
function startMcp(file = pairingFile) {
  const p = spawn(process.execPath, [MCP], { env: { ...process.env, OPENHOUSE_PAIRING: file, OPENHOUSE_NAME: 'Test Mac' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(), notes = [];
  readline.createInterface({ input: p.stdout }).on('line', (l) => { const m = JSON.parse(l); if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else notes.push(m); });
  let n = 0;
  const rpc = (method, params = {}) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: r.result?.content?.map((c) => c.text).join('\n') || r.error?.message, error: !!(r.result?.isError || r.error) }; };
  return { p, rpc, call, notes };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-workshop-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  // The downloads the Connect page serves (scripts/build-mcpb.sh puts them in public/connect/): stand-ins here.
  fs.mkdirSync(path.join(root, 'bridge/public/connect'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/connect/openhouse.mcpb'), 'PK\x03\x04 stand-in');
  fs.copyFileSync(MCP, path.join(root, 'bridge/public/connect/openhouse-mcp.mjs'));
  app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  fs.mkdirSync(path.join(app, 'apps/chores'), { recursive: true });
  fs.writeFileSync(path.join(app, 'apps/chores/app.json'), '{"name":"Chores"}');
  fs.writeFileSync(path.join(app, 'apps/chores/index.html'), '<!doctype html><title>chores</title>');
  execFileSync('git', ['add', '-A'], { cwd: app }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'chores'], { cwd: app });
  pairingFile = path.join(root, 'pairing.json');
  const [port, lanPort] = [await freePort(), await freePort()];
  mdnsPort = 20000 + Math.floor(Math.random() * 20000);
  startBridge = async () => {
    child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
      env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, APP_DIR: app, CONNECT_HOSTNAME: 'openhouse-test.local', CONNECT_MDNS_PORT: String(mdnsPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
  };
  url = `http://127.0.0.1:${port}`; lan = `127.0.0.1:${lanPort}`;
  await startBridge();
  mcp = startMcp();
});
after(() => { mcp?.p.kill(); child?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

test('codes: 12 characters, the same pairing on both sides, typos forgiven', () => {
  const c = newCode();
  assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  const a = pairingFromCode(c), b = pairingFromCode(c.toLowerCase().replace(/-/g, ' '));
  assert.equal(a.pair, b.pair); assert.ok(a.key.equals(b.key)); assert.equal(a.key.length, 32);
  assert.equal(pairingFromCode('ABC'), null);
});

test('a computer gets only the workshop; screens never do', () => {
  assert.ok(allowed(COMPUTER_SCOPES, 'POST', '/workshop/mcp'));
  assert.ok(!allowed(COMPUTER_SCOPES, 'GET', '/home'));
  assert.ok(!allowed(COMPUTER_SCOPES, 'POST', '/undo'));
  assert.ok(!allowed(DEFAULT_SCOPES, 'POST', '/workshop/mcp'));
});

test('not paired: only the pairing tool', async () => {
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18' });
  const t = await mcp.rpc('tools/list');
  assert.deepEqual(t.result.tools.map((x) => x.name), ['pair_with_tablet', 'use_tablet_tool']);
});

test('a wrong code: the pairing ends after a few tries, and nothing is let in', async () => {
  const p = await post('/screens/pair', { kind: 'computer' });
  assert.match(p.code, /^\w{4}-\w{4}-\w{4}$/); assert.equal(p.key, undefined, 'a computer\'s key is never handed out: it comes from the code');
  const r = await mcp.call('pair_with_tablet', { code: 'ZZZZ-ZZZZ-ZZZZ', address: lan });
  assert.ok(r.error);
  assert.equal((await get('/screens')).asking.length, 0);
});

test('pairing: the code from the tablet, someone says yes, then the tablet\'s tools', async () => {
  const p = await post('/screens/pair', { kind: 'computer' });
  const paired = mcp.call('pair_with_tablet', { code: p.code.toLowerCase().replace(/-/g, ' '), address: `http://${lan}` });
  let asking;
  for (let i = 0; i < 100 && !asking; i++) { asking = (await get('/screens')).asking.find((a) => a.pair === p.pair); if (!asking) await wait(50); }
  assert.equal(asking?.name, 'Test Mac'); assert.equal(asking.kind, 'computer');
  await post('/screens/answer', { pair: p.pair, yes: true });
  const r = await paired;
  assert.ok(!r.error, r.text);
  const via = await mcp.call('use_tablet_tool', { name: 'list_files', arguments: {} });
  assert.ok(!via.error, via.text); assert.match(via.text, /chores/);
  assert.ok(mcp.notes.some((m) => m.method === 'notifications/tools/list_changed'));
  const listed = (await get('/screens')).screens.find((s) => s.name === 'Test Mac');
  assert.equal(listed.kind, 'computer'); assert.deepEqual(listed.scopes, ['workshop']);
  assert.equal(JSON.parse(fs.readFileSync(pairingFile, 'utf8')).name, 'Test Mac');
  assert.equal(fs.statSync(pairingFile).mode & 0o077, 0, 'only its owner can read the pairing');
  const tools = (await mcp.rpc('tools/list')).result.tools.map((t) => t.name);
  for (const t of ['start_editing', 'write_file', 'done_editing']) assert.ok(tools.includes(t), t);
});

test('an open change survives the bridge restarting (an update installed mid-change)', async () => {
  assert.ok(!(await mcp.call('start_editing', { what: 'A clock tab' })).error);
  await mcp.call('write_file', { path: 'apps/clock/index.html', content: '<!doctype html><script type="module" src="./main.js"></script>' });
  child.kill(); await new Promise((r) => child.on('exit', r));
  await startBridge();
  assert.match((await get('/home')).computer?.text || '', /A clock tab/, 'still shown as being changed');
  const w = await mcp.call('write_file', { path: 'apps/clock/main.js', content: 'export const x = 1;' });
  assert.ok(!w.error, w.text);
  const before = Number(git('rev-list', '--count', 'HEAD'));
  await mcp.call('set_home', { tabs: ['today', 'clock', 'apps'] });
  assert.ok(!(await mcp.call('done_editing', {})).error);
  assert.equal(Number(git('rev-list', '--count', 'HEAD')), before + 1, 'what was written before and after the restart is one change');
  await mcp.call('undo_latest');
});

test('the family\'s undo takes back a computer\'s change too', async () => {
  await mcp.call('start_editing', { what: 'A note app' });
  await mcp.call('write_file', { path: 'apps/notepad/index.html', content: '<!doctype html>' });
  await mcp.call('done_editing', {});
  assert.ok(fs.existsSync(path.join(app, 'apps/notepad/index.html')));
  const r = await post('/undo');
  assert.equal(r.undid, 'A note app');
  assert.ok(!fs.existsSync(path.join(app, 'apps/notepad')));
});

test('removed on the tablet: its key stops working, and it says to pair again', async () => {
  const s = (await get('/screens')).screens.find((x) => x.name === 'Test Mac');
  await post('/screens/revoke', { id: s.id });
  const r = await mcp.call('look_at_notes');
  assert.ok(r.error);
  assert.ok(!fs.existsSync(pairingFile));
  assert.deepEqual((await mcp.rpc('tools/list')).result.tools.map((x) => x.name), ['pair_with_tablet', 'use_tablet_tool']);
});

test('the Connect screen\'s page: only while it shows, only its page and downloads', async () => {
  const before = await fetch(`http://${lan}/`, { redirect: 'manual' });
  assert.equal(before.status, 302, 'no page without an open Connect screen');
  const p = await post('/screens/pair', { kind: 'computer', address: '192.168.7.9' });
  assert.equal(p.host, 'openhouse-test.local');
  const html = await (await fetch(`http://${lan}/`)).text();
  assert.ok(html.includes(p.code));
  assert.equal((await fetch(`http://${lan}/openhouse.mcpb`)).status, 200);
  assert.equal((await fetch(`http://${lan}/home`)).status, 404, 'nothing else');
  await post('/screens/pair/end', { pair: p.pair });
  assert.equal((await fetch(`http://${lan}/openhouse.mcpb`, { redirect: 'manual' })).status, 404, 'gone when the screen closes');
  assert.equal((await fetch(`http://${lan}/`, { redirect: 'manual' })).status, 302);
});
