// The bridge loads and serves at all: every module imports (a syntax error once crashed the tablet's bridge),
// and server.js starts and answers.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initRepo } from '../edits.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('every bridge module imports', async () => {
  // server.js runs as a process below; voice-worker.js is a worker thread's entry point.
  const skip = new Set(['server.js', 'voice-worker.js']);
  for (const f of fs.readdirSync(BRIDGE).filter((f) => f.endsWith('.js') && !skip.has(f))) {
    await import(pathToFileURL(path.join(BRIDGE, f)).href);
  }
});

test('server.js starts and serves', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-smoke-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$/.test(f) });
  const app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  const port = await freePort(), token = 'test-token';
  let out = '';
  const child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), OPENHOUSE_TOKEN: token, APP_DIR: app, CHAT_DIR: path.join(root, 'chats') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  try {
    let r;
    for (let i = 0; i < 100 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/state`, { headers: { 'x-openhouse-token': token } }); } catch { await wait(100); } }
    assert.ok(r, 'the bridge never answered:\n' + out.slice(-2000));
    assert.equal(r.status, 200, out.slice(-2000));
    await r.json();
    // A malformed address gets an error, and the bridge goes on answering.
    const bad = await new Promise((done, fail) => http.get({ host: '127.0.0.1', port, path: '//' }, (x) => { x.resume(); done(x.statusCode); }).on('error', fail));
    assert.ok(bad >= 400 && bad < 500, `GET // answered ${bad}`);
    const again = await fetch(`http://127.0.0.1:${port}/state`, { headers: { 'x-openhouse-token': token } });
    assert.equal(again.status, 200, out.slice(-2000));
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
