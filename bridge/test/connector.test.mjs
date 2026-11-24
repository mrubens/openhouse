// The web connector (the cloud repo's lambda/connector.ts, docs/web-chat-building.md): claude.ai or ChatGPT, as an OAuth client
// with PKCE, signs in by pairing with the tablet's code through the relay, someone says yes on the tablet, and then
// its MCP calls reach the tablet's workshop (bridge/workshop.js) sealed, through the relay. The real bridge and the
// real service code (the cloud repo's lambda/local.ts); a test redirect on localhost stands in for claude.ai's.
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
import { localCloud, SKIP } from './cloud-service.mjs';

const local = await localCloud();
const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };
const opts = { skip: !local && SKIP };

let svc, child, url, lan, root, D, out = '';
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());
const until = async (f, what) => { for (let i = 0; i < 100; i++) { const v = await f(); if (v) return v; await wait(50); } throw new Error('timed out: ' + what); };

before(async () => {
  if (!local) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-connector-'));
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
});
after(() => { child?.kill(); svc?.server.close(); svc?.server.closeAllConnections(); if (root) fs.rmSync(root, { recursive: true, force: true }); });


const REDIRECT = 'http://localhost:9/callback';
const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');
const api = (p, init = {}) => fetch(svc.url + p, init);
const mcp = (token, msg) => api('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', ...msg }) });
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
let tokens, clientId;

test('discovery: MCP without a token says where to sign in', opts, async () => {
  const r = await mcp('nope', { id: 1, method: 'initialize', params: {} });
  assert.equal(r.status, 401);
  const meta = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate'))[1];
  const pr = await (await fetch(meta)).json();
  assert.equal(pr.resource, svc.url.replace('localhost', '127.0.0.1') + '/mcp');
  const as = await (await fetch(pr.authorization_servers[0] + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.client_id_metadata_document_supported, true);
  // Only Claude and ChatGPT's addresses (and this computer's) may be sent back to.
  assert.equal((await api('/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) })).status, 400);
  const reg = await (await api('/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude', token_endpoint_auth_method: 'none' }) })).json();
  clientId = reg.client_id;
  assert.match(clientId, /^oc_/);
});

test('signing in is pairing: the code, a yes on the tablet, then tokens', opts, async () => {
  assert.equal((await post('/relay', { on: true })).on, true);
  await until(async () => (await get('/relay')).connected, 'connected');
  assert.equal((await get('/relay')).connector, svc.url.replace('localhost', '127.0.0.1') + '/mcp', 'the address the Connect screen shows');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: 'S256', state: 'st8', resource: svc.url + '/mcp' });
  const pageText = await (await api('/oauth/authorize?' + q)).text();
  const sid = /const sid="([^"]+)"/.exec(pageText)[1];
  const call = (p, b) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // A code no tablet shows gets nowhere.
  assert.equal((await call('/oauth/pair', { sid, code: 'K7QM-2XD9-HPA4' })).status, 400);
  const p = await post('/screens/pair', { kind: 'computer' });
  await until(async () => (await svc.store.scan('PAIRING#')).length, 'the relay hears of the code');
  const paired = await call('/oauth/pair', { sid, code: p.code.toLowerCase() });
  assert.equal(paired.asked, true, JSON.stringify(paired));
  const asking = await until(async () => (await get('/screens')).asking.find((a) => a.pair === p.pair), 'the tablet asks');
  assert.equal(asking.name, 'Claude on a computer');
  assert.equal((await call('/oauth/wait', { sid })).waiting, true);
  await post('/screens/answer', { pair: p.pair, yes: true });
  const w = await until(async () => { const r = await call('/oauth/wait', { sid }); return r.redirect && r; }, 'welcome');
  const back = new URL(w.redirect);
  assert.equal(back.searchParams.get('state'), 'st8');
  assert.equal(back.searchParams.get('iss'), svc.url.replace('localhost', '127.0.0.1'));
  const code = back.searchParams.get('code');
  // The wrong verifier is refused, and a code works once.
  assert.equal((await api('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(43) }))).status, 400);
  // (that try used the code up, so the right verifier is too late: sign in again, the way a person would)
  assert.equal((await api('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }))).status, 400);
  // Again, properly.
  const q2 = new URLSearchParams({ ...Object.fromEntries(q), state: 'two' });
  const sid2 = /const sid="([^"]+)"/.exec(await (await api('/oauth/authorize?' + q2)).text())[1];
  const p2 = await post('/screens/pair', { kind: 'computer' });
  await until(async () => (await svc.store.get(`PAIRING#${p2.pair}`, 'META')), 'the relay hears of the second code');
  assert.equal((await call('/oauth/pair', { sid: sid2, code: p2.code })).asked, true);
  await until(async () => (await get('/screens')).asking.find((a) => a.pair === p2.pair), 'asks again');
  await post('/screens/answer', { pair: p2.pair, yes: true });
  const w2 = await until(async () => { const r = await call('/oauth/wait', { sid: sid2 }); return r.redirect && r; }, 'welcome again');
  const t = await (await api('/oauth/token', form({ grant_type: 'authorization_code', code: new URL(w2.redirect).searchParams.get('code'), client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }))).json();
  assert.match(t.access_token, /^oha_/); assert.match(t.refresh_token, /^ohr_/);
  tokens = t;
  // The tablet lists it among its computers.
  assert.ok((await get('/screens')).screens.some((s) => s.kind === 'computer' && s.name === 'Claude on a computer'));
  // Nothing in the table opens the key without a token.
  const grants = await svc.store.scan('GRANT#');
  assert.ok(grants.every((g) => !JSON.stringify(g).includes(t.access_token.split('.')[1])));
});

test('MCP through the relay: the workshop answers, sealed', opts, async () => {
  const init = await (await mcp(tokens.access_token, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
  assert.ok(init.result);
  assert.equal((await mcp(tokens.access_token, { method: 'notifications/initialized' })).status, 202);
  const list = await (await mcp(tokens.access_token, { id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map((x) => x.name);
  for (const n of ['start_editing', 'write_file', 'done_editing']) assert.ok(names.includes(n), n);
  // A change from the web, made and undone like any other.
  const call = async (name, args) => (await (await mcp(tokens.access_token, { id: 9, method: 'tools/call', params: { name, arguments: args } })).json()).result;
  assert.ok(!(await call('start_editing', { what: 'A hello app' })).isError);
  assert.ok(!(await call('write_file', { path: 'apps/hello/index.html', content: '<!doctype html><title>Hello</title><p>Hi there</p>' })).isError);
  const ed = await call('edit_file', { path: 'apps/hello/index.html', old: 'Hi there', new: 'Hello, house' });
  assert.ok(!ed.isError, JSON.stringify(ed));
  assert.match((await call('read_file', { path: 'apps/hello/index.html' })).content[0].text, /Hello, house/);
  assert.ok(!(await call('done_editing', { summary: 'A hello app.' })).isError);
  assert.ok(!(await call('undo_latest', {})).isError);
});

test('refresh rotates; removing it on the tablet ends it at once', opts, async () => {
  const r = await (await api('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))).json();
  assert.match(r.access_token, /^oha_/);
  assert.notEqual(r.refresh_token, tokens.refresh_token);
  assert.equal((await mcp(r.access_token, { id: 1, method: 'ping' })).status, 200);
  for (const c of (await get('/screens')).screens.filter((s) => s.name === 'Claude on a computer')) await post('/screens/revoke', { id: c.id });
  await until(async () => (await mcp(r.access_token, { id: 1, method: 'tools/list' })).status === 401, 'refused after removal');
  assert.equal((await mcp(r.access_token, { id: 1, method: 'tools/list' })).status, 401, 'and stays refused');
});
