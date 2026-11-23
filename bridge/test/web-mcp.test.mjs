// The tablet's own connector (web-mcp.js, docs/web-chat-building.md "Your own address"): with no OpenHouse cloud, the
// bridge serves OAuth and MCP itself, for a household's tunnel to make public. Signing in is the tablet's code and a
// yes on the tablet; then MCP reaches the workshop as that paired computer. The real bridge; a test redirect on
// localhost stands in for claude.ai's.
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

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };
const REDIRECT = 'http://localhost:9/callback', PUBLIC = 'https://kitchen.tail1234.ts.net';
const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');
let child, url, web, root;
const get = (p) => fetch(url + p, { headers: H }).then((r) => r.json());
const post = (p, b = {}) => fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then((r) => r.json());
const until = async (f, what) => { for (let i = 0; i < 100; i++) { const v = await f(); if (v) return v; await wait(50); } throw new Error('timed out: ' + what); };
const pub = (p, init = {}) => fetch(web + p, init);
const jpost = (p, b) => pub(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const mcp = (token, msg) => pub('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...msg }) });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-webmcp-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$|web-mcp\.json$/.test(f) });
  fs.mkdirSync(path.join(root, 'bridge/public/screen'), { recursive: true });
  const app = path.join(root, 'webapp'); fs.mkdirSync(app); initRepo(app);
  const [port, lanPort, webPort] = [await freePort(), await freePort(), await freePort()];
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', WEB_MCP_PORT: String(webPort), WEB_MCP_HOST: '127.0.0.1', AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: TOKEN, CLOUD_DISPLAY: path.join(root, 'display'), HEARTBEAT: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = `http://127.0.0.1:${port}`; web = `http://127.0.0.1:${webPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
});
after(() => { child?.kill(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('off until someone turns it on with an https address', async () => {
  assert.equal((await get('/webmcp')).on, false);
  await assert.rejects(fetch(web + '/mcp', { method: 'POST' })); // no listener at all
  assert.match((await post('/webmcp', { on: true, url: 'http://not-https.example' })).error, /https/);
  const on = await post('/webmcp', { on: true, url: PUBLIC + '/' });
  assert.deepEqual([on.on, on.connector], [true, PUBLIC + '/mcp']);
  await until(async () => (await get('/webmcp')).listening, 'listening');
});

test('signing in is the tablet code and Allow; then MCP reaches the workshop, until it is removed in Screens', async () => {
  const r = await pub('/mcp', { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), new RegExp(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`));
  assert.equal((await (await pub('/.well-known/oauth-protected-resource')).json()).resource, PUBLIC + '/mcp');
  assert.equal((await (await pub('/.well-known/oauth-authorization-server')).json()).issuer, PUBLIC);
  assert.equal((await jpost('/oauth/register', { redirect_uris: ['https://evil.example/cb'] })).status, 400);
  const clientId = (await jpost('/oauth/register', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).client_id;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: s256(verifier), code_challenge_method: 'S256', state: 's1' });
  const sid = /const sid="([^"]+)"/.exec(await (await pub('/oauth/authorize?' + q)).text())[1];
  assert.equal((await jpost('/oauth/pair', { sid, code: 'K7QM-2XD9-HPA4' })).status, 400, 'a code the tablet isn\'t showing');
  const p = await post('/screens/pair', { kind: 'computer' });
  assert.equal((await jpost('/oauth/pair', { sid, code: p.code })).asked, true);
  await until(async () => (await get('/screens')).asking.find((a) => a.pair === p.pair), 'the tablet asks');
  assert.equal((await jpost('/oauth/wait', { sid })).waiting, true);
  await post('/screens/answer', { pair: p.pair, yes: true });
  const w = await until(async () => { const x = await jpost('/oauth/wait', { sid }); return x.redirect && x; }, 'welcome');
  const back = new URL(w.redirect);
  assert.deepEqual([back.searchParams.get('state'), back.searchParams.get('iss')], ['s1', PUBLIC]);
  const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
  const t = await (await pub('/oauth/token', form({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }))).json();
  assert.match(t.access_token, /^ohla_/);
  const rpc = async (method, params) => (await (await mcp(t.access_token, { id: 1, method, params })).json()).result;
  assert.ok((await rpc('tools/list')).tools.some((x) => x.name === 'write_file'));
  assert.ok(!(await rpc('tools/call', { name: 'change_list', arguments: { list: 'Groceries', add: ['eggs'] } })).isError);
  assert.match((await rpc('tools/call', { name: 'family_things', arguments: {} })).content[0].text, /eggs/i);
  // Refresh rotates.
  const r2 = await (await pub('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId }))).json();
  assert.equal((await mcp(r2.access_token, { id: 1, method: 'ping' })).status, 200);
  // Removed in Screens: refused at once. The key never left the tablet, so there is nothing else to take back.
  const c = (await get('/screens')).screens.find((s) => s.name === 'A test app on this computer');
  await post('/screens/revoke', { id: c.id });
  assert.equal((await mcp(r2.access_token, { id: 1, method: 'tools/list' })).status, 401);
  // Off: the listener goes.
  await post('/webmcp', { on: false });
  await assert.rejects(fetch(web + '/mcp', { method: 'POST' }));
});
