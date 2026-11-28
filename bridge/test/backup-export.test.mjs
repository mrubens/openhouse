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
import { pack, INCLUDE } from '../backup-format.js';
import { folderDestination } from '../folder-backup.js';
import { writeJson, releaseWrites } from '../store.js';
import { guard } from '../restore-guard.js';

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

// Household data safety: a backup holds every household store (not their spare copies), and a restore isn't written
// over by a save from what the bridge still held in memory before it restarts.
test('backup and restore: every store comes back, and no save right after writes old memory over it', async () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  const file = (f) => path.join(D, f);
  const put = (f, v) => { fs.mkdirSync(path.dirname(file(f)), { recursive: true }); fs.writeFileSync(file(f), JSON.stringify(v)); };
  const stores = ['later.json', 'calendar-sync.json', 'things.json', 'day-notes.json', 'house.json', 'household.json'];
  for (const f of stores) put(f, { kept: f });
  for (const f of ['house.json.bak', 'house.json.tmp', 'house.json.damaged-1']) put(f, { spare: f });

  const tgz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pack-')), 'b.tgz');
  await pack(D, tgz);
  const names = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of stores) assert.ok(names.includes(f), f);
  for (const f of names) assert.doesNotMatch(f, /\.bak$|\.tmp$|\.damaged-/, f);

  let exits = 0;
  const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const body = async (req) => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {}; };
  const b = backupRoutes({ DISPLAY: D, tick: 0, json, body, exit: () => { exits++; }, destinations: [folderDestination({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dest-')) })] });
  const s = http.createServer(async (req, res) => { if (!(await b.handle(req, res, new URL('http://x' + req.url)))) json(res, 404, {}); });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const call = async (m, p, v) => { const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`, { method: m, ...(v ? { body: JSON.stringify(v) } : {}) }); return { code: r.status, obj: await r.json() }; };
  try {
    assert.equal((await call('POST', '/backup/dest', { id: 'folder', on: true })).code, 200);
    assert.equal((await b.backup('manual')).ok, true);
    const [item] = (await call('GET', '/backup/list')).obj.backups;

    for (const f of stores) put(f, { changed: f }); // what happened since
    const r = await call('POST', '/backup/restore', { dest: 'folder', id: item.id });
    assert.equal(r.code, 200, JSON.stringify(r.obj));
    for (const f of stores) assert.deepEqual(JSON.parse(fs.readFileSync(file(f), 'utf8')), { kept: f }, f);
    assert.ok(!fs.existsSync(file('house.json.bak')), "the old .bak went aside with the file it was the copy of");

    // A save from the old memory, in the moments before the restart: refused, and the restored file stays.
    assert.throws(() => writeJson(file('later.json'), { changed: 'later.json' }), (e) => e.code === 'held');
    assert.throws(() => writeJson(file('chats/x.json'), {}), (e) => e.code === 'held');
    assert.deepEqual(JSON.parse(fs.readFileSync(file('later.json'), 'utf8')), { kept: 'later.json' });
    fs.mkdirSync(file('bridge')); writeJson(file('bridge/undo.json'), []); // (what a backup doesn't hold is written as usual)
    await new Promise((ok) => setTimeout(ok, 1700));
    assert.equal(exits, 1, 'the bridge starts again on what came back');
  } finally { s.close(); }
});

// Household data safety: what a restore puts back can't leave the device unable to start (the starts after it go back
// to what was there before), this device's own things inside what came back stay, and a backup bigger than the room
// left is never unpacked.
test('a restore that does not start goes back; the device keeps its own clips and node_modules; unpacking is capped', async () => {
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-back-'));
  const file = (f) => path.join(D, f), read = (f) => fs.readFileSync(file(f), 'utf8');
  const put = (f, t) => { fs.mkdirSync(path.dirname(file(f)), { recursive: true }); fs.writeFileSync(file(f), t); };
  put('house.json', 'before'); put('chats/door.json', '{}'); put('webapp/index.html', 'apps');
  const dest = folderDestination({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dest-')) });
  const json = () => {};
  const make = (o = {}) => backupRoutes({ DISPLAY: D, tick: 0, json, body: async () => ({}), exit: () => {}, destinations: [dest], ...o });
  let b = make();
  fs.mkdirSync(path.join(D, '.backup'));
  writeJson(path.join(D, '.backup/key.json'), { code: '0000-0000-0000-0000-0000-0000-00', confirmed: true }, { bak: false });
  writeJson(path.join(D, '.backup/state.json'), { dests: { folder: { on: true } } }, { bak: false });
  assert.equal((await b.backup('manual')).ok, true);
  const [item] = await dest.list();

  // Unpacking stops once it is past the room there is (a backup's tar can be far bigger than its file).
  await assert.rejects(make({ maxUnpack: 10 }).restore({ dest: 'folder', id: item.id }), (e) => e.code === 'toobig');
  releaseWrites(INCLUDE.map((e) => path.join(D, e)));
  assert.equal(read('house.json'), 'before', 'nothing put back');

  // Since: the house changed, the microphone kept clips, the apps' dev server has its node_modules here.
  put('house.json', 'since'); put('chats/voice-clips/a.wav', 'wav'); put('webapp/node_modules/vite/v.js', 'vite');
  b = make();
  assert.equal((await b.restore({ dest: 'folder', id: item.id })).ok, true);
  releaseWrites(INCLUDE.map((e) => path.join(D, e)));
  assert.equal(read('house.json'), 'before');
  assert.equal(read('chats/voice-clips/a.wav'), 'wav', "this device's clips stay");
  assert.equal(read('webapp/node_modules/vite/v.js'), 'vite', "this device's node_modules stay");

  // The bridge doesn't stay up on what came back: the third start goes back to what was there before.
  const timers = [];
  assert.equal(guard(D, { setTimer: (f) => timers.push(f) }), 'watching');
  assert.equal(guard(D, { setTimer: (f) => timers.push(f) }), 'watching');
  assert.equal(guard(D, { setTimer: (f) => timers.push(f) }), 'back');
  assert.equal(read('house.json'), 'since', 'what was there before is back');
  assert.equal(read('chats/voice-clips/a.wav'), 'wav');
  assert.equal(read('webapp/node_modules/vite/v.js'), 'vite');
  assert.equal(fs.readFileSync(path.join(D, '.backup/failed-restore/house.json'), 'utf8'), 'before', 'what came back is kept aside');
  assert.equal(guard(D), null, 'and only once');

  // A restore whose start stays up holds: once a start has run a while, nothing goes back.
  b = make();
  assert.equal((await b.restore({ dest: 'folder', id: item.id })).ok, true);
  releaseWrites(INCLUDE.map((e) => path.join(D, e)));
  timers.length = 0;
  assert.equal(guard(D, { setTimer: (f) => timers.push(f) }), 'watching');
  timers.forEach((f) => f());
  assert.equal(guard(D), null);
  assert.equal(read('house.json'), 'before');
  fs.rmSync(D, { recursive: true, force: true });
});
