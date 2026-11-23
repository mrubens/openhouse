// GET /backup/export: the family folder as one .tar.gz for the computer's copy before an install, without what the
// display or an update puts back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { backupRoutes } from '../backup.js';

test('backup export: the family folder as a .tar.gz, without the runtime pieces, voice models or builds', async () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  const put = (f, s = 'x') => { fs.mkdirSync(path.dirname(path.join(D, f)), { recursive: true }); fs.writeFileSync(path.join(D, f), s); };
  for (const f of ['household.json', 'preferences.md', 'heartbeat.json', 'chats/a.json', 'webapp/apps/chores/index.html', 'photos/1.jpg', 'flyers/f.jpg'])
    put(f, f);
  for (const f of ['voice/model.onnx', 'bridge/server.js', 'agent/home/x', 'webapp/node_modules/m/index.js', 'build/out', 'webapp.tgz', '.backup/tmp/t'])
    put(f);
  const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const b = backupRoutes({ DISPLAY: D, tick: 0, json, body: async () => ({}), destinations: [] });
  const s = http.createServer(async (req, res) => { if (!(await b.handle(req, res, new URL('http://x' + req.url)))) json(res, 404, {}); });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/backup/export`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/gzip');
    const tgz = path.join(D, '..', path.basename(D) + '.tgz');
    fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    const names = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').map((n) => n.replace(/^\.\//, '')).filter((n) => n && !n.endsWith('/'));
    for (const f of ['household.json', 'preferences.md', 'heartbeat.json', 'chats/a.json', 'webapp/apps/chores/index.html', 'photos/1.jpg', 'flyers/f.jpg']) assert.ok(names.includes(f), f);
    for (const f of names) assert.doesNotMatch(f, /^(voice|bridge|agent|build|webapp\/node_modules|\.backup\/tmp)\/|^webapp\.tgz$/, f);
  } finally { s.close(); }
});
