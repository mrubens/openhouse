// Backups (backup.js) to the cloud (cloud.js, against the real service code running locally: the cloud repo's lambda/local.ts)
// and to a USB drive (drive.js, against a stand-in for the shell's drive helper, a folder): link with a code someone
//  enters on the web, back up, restore, restore on a "new tablet" with the recovery code or the copy kept
// with Opie, and unlinking from the web.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cloudRoutes } from '../cloud.js';
import { backupRoutes, KEEP } from '../backup.js';
import { driveDestination } from '../drive.js';
import { newRecoveryCode, parseRecoveryCode, keyFromCode, encryptFile, decryptFile } from '../backup-format.js';
import { localCloud, SKIP } from './cloud-service.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
// The service's code is the cloud repo's (cloud-service.mjs); without a checkout the cloud tests are skipped.
process.env.GOOGLE_CLIENT_ID ||= 'test-client'; process.env.GOOGLE_CLIENT_SECRET ||= 'test-secret'; // (Google itself is never called here)
const local = await localCloud();
const svc = local ? await local.startLocal({ port: 0, dir: tmp(), host: '127.0.0.1' }) : null;
if (svc) svc.blobs.base = svc.url;
const servers = [];
after(() => { svc?.server.close(); servers.forEach((s) => s.close()); });

/** A display folder like the tablet's, with the family's things and things that must never leave. */
function display() {
  const D = tmp();
  const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { cwd: path.join(D, 'webapp') });
  fs.mkdirSync(path.join(D, 'webapp/apps/chores'), { recursive: true });
  fs.writeFileSync(path.join(D, 'webapp/apps/chores/index.html'), '<h1>MARKER-CHORES</h1>');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'Add chores');
  fs.mkdirSync(path.join(D, 'chats')); fs.writeFileSync(path.join(D, 'chats/door.json'), '{"look":"MARKER-LOOK"}');
  fs.mkdirSync(path.join(D, 'photos')); fs.writeFileSync(path.join(D, 'photos/a.jpg'), crypto.randomBytes(50000));
  fs.writeFileSync(path.join(D, 'household.json'), '{"family":[{"name":"MARKER-HOUSE"}]}');
  // Never in a backup
  fs.mkdirSync(path.join(D, 'bridge')); fs.writeFileSync(path.join(D, 'bridge/server.js'), 'code');
  fs.writeFileSync(path.join(D, '.bridge-token'), 'SECRET-TOKEN');
  fs.mkdirSync(path.join(D, 'rootfs/root/.claude'), { recursive: true }); fs.writeFileSync(path.join(D, 'rootfs/root/.claude/.credentials.json'), 'SECRET-SIGNIN');
  fs.symlinkSync(path.join(D, 'rootfs/root/.claude/.credentials.json'), path.join(D, 'webapp/apps/chores/sneaky.json')); // a link is kept as a link, never followed
  return D;
}

/** The shell's drive helper (BackupDrive.kt), over a folder: the same routes, token and copying by path. */
async function fakeDrive(D, { present = true } = {}) {
  const dir = tmp(), token = crypto.randomBytes(8).toString('hex'), st = { present };
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const j = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== `Bearer ${token}`) return j(401, { error: 'no' });
      const a = JSON.parse(b || '{}'), folder = path.join(dir, 'Display backups');
      if (req.url === '/status') return j(200, { chosen: true, present: st.present, name: 'KINGSTON' });
      if (!st.present) return j(409, { error: 'Plug in the drive.' });
      fs.mkdirSync(folder, { recursive: true });
      if (req.url === '/list') return j(200, { files: fs.readdirSync(folder).map((n) => ({ name: n, size: fs.statSync(path.join(folder, n)).size })) });
      if (req.url === '/put') { fs.copyFileSync(a.path, path.join(folder, a.name)); return j(200, { ok: true }); }
      if (req.url === '/get') { fs.copyFileSync(path.join(folder, a.name), a.path); return j(200, { ok: true }); }
      if (req.url === '/remove') { fs.rmSync(path.join(folder, a.name)); return j(200, { ok: true }); }
      j(404, {});
    });
  });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  servers.push(s);
  fs.mkdirSync(path.join(D, '.backup'), { recursive: true });
  fs.writeFileSync(path.join(D, '.backup/drive.json'), JSON.stringify({ port: s.address().port, token }));
  return { dir: path.join(dir, 'Display backups'), st };
}

function tablet(D, opts = {}) {
  let exited = 0;
  const json = (res, code, obj) => { res.code = code; res.obj = obj; };
  const body = async (req) => req.b || {};
  let backups = null;
  const cloud = cloudRoutes({ DISPLAY: D, tick: 0, json, body, agentName: () => 'cloud', backupBits: () => backups.bits() });
  backups = backupRoutes({ DISPLAY: D, tick: 0, json, body, destinations: [cloud.destination, driveDestination({ DISPLAY: D })], escrow: cloud.escrow, exit: () => { exited++; }, ...opts });
  const call = async (method, p, b) => { const res = {}; const h = p.startsWith('/cloud/') ? cloud : backups; assert.ok(await h.handle({ method, b }, res, new URL('http://x' + p)), p); return res; };
  return { cloud, backups, call, exited: () => exited };
}

// Someone on the web: sign in by email, enter the code.
let cookie = '';
async function web(p, b) {
  const r = await fetch(svc.url + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-openhouse': '1', cookie }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function signIn(email) {
  cookie = '';
  await web('/v1/auth/start', { email });
  const t = new URL(/https?:\S+/.exec(svc.mail.sent.at(-1).text)[0]).searchParams.get('t');
  assert.equal((await web('/v1/auth/finish', { token: t })).status, 200);
}
/** A code entered on the web, then the account that claimed it waiting for an answer at the tablet: [ok] links it. */
async function claimed(t) {
  assert.equal((await t.call('POST', '/cloud/config', { api: svc.url.replace('localhost', '127.0.0.1') })).code, 200);
  const s = await t.call('POST', '/cloud/link/start', { name: 'Kitchen' });
  assert.match(s.obj.display, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await t.call('POST', '/cloud/link/confirm', { ok: true })).code, 400); // nothing claimed it yet
  assert.equal((await web('/v1/account/claim', { code: s.obj.display })).status, 200);
  let st;
  for (let i = 0; i < 40 && !(st = (await t.call('GET', '/cloud/status')).obj).linking?.confirm; i++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(st.linking?.confirm, 'the tablet asks before it links');
  assert.equal(st.linked, false); // no credential until a yes
  return st.linking.confirm;
}
async function link(t) {
  await claimed(t);
  const r = await t.call('POST', '/cloud/link/confirm', { ok: true });
  assert.equal(r.code, 200); assert.equal(r.obj.linked, true);
  assert.equal((await t.call('GET', '/cloud/status')).obj.linked, true);
}
const until = async (t, f) => { for (let i = 0; i < 100; i++) { const s = (await t.call('GET', '/backup/status')).obj; if (f(s)) return s; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out'); };
const files = (d) => { const out = []; const w = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) e.isDirectory() ? w(path.join(x, e.name)) : out.push(path.join(x, e.name)); }; if (fs.existsSync(d)) w(d); return out; };
/** What a backup file holds, opened with the family's code; and that nothing readable is in it as stored. */
async function opened(file, code) {
  const raw = fs.readFileSync(file);
  for (const m of ['MARKER', 'SECRET', 'chores', 'Add chores']) assert.ok(!raw.includes(m), `${m} readable in the stored file`);
  const out = path.join(tmp(), 'x.tgz');
  await decryptFile(file, out, keyFromCode(code).key);
  return execFileSync('tar', ['-tvzf', out]).toString().split('\n');
}

test('recovery codes: 26 characters, forgiving to type, and the key follows from them', () => {
  const code = newRecoveryCode();
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/);
  assert.equal(parseRecoveryCode(code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')).toString('hex'), parseRecoveryCode(code).toString('hex'));
  assert.equal(parseRecoveryCode(code.slice(0, -1)), null);
  assert.notEqual(keyFromCode(code).keyId, keyFromCode(newRecoveryCode()).keyId);
});

test('encrypted files open only with their key, and any change to them is caught', async () => {
  const D = tmp(), src = path.join(D, 'a'), enc = path.join(D, 'a.backup'), out = path.join(D, 'b');
  fs.writeFileSync(src, 'hello family');
  const k = keyFromCode(newRecoveryCode());
  await encryptFile(src, enc, k);
  assert.ok(!fs.readFileSync(enc).includes('hello family'));
  await decryptFile(enc, out, k.key);
  assert.equal(fs.readFileSync(out, 'utf8'), 'hello family');
  await assert.rejects(decryptFile(enc, out, keyFromCode(newRecoveryCode()).key), /doesn't open/);
  const bytes = fs.readFileSync(enc); bytes[bytes.length - 20] ^= 1; fs.writeFileSync(enc, bytes);
  await assert.rejects(decryptFile(enc, out, k.key), /doesn't open/);
  assert.ok(!fs.existsSync(out));
});

test('USB drive, no cloud at all: off until chosen, then backs up, keeps a few, restores', async () => {
  const D = display(); const t = tablet(D);
  let s = (await t.call('GET', '/backup/status')).obj;
  assert.equal(s.key.has, false);
  assert.deepEqual(s.dests.map((d) => [d.id, d.on, d.ready]), [['cloud', false, false], ['drive', false, false]]); // no helper running yet
  assert.equal((await t.call('POST', '/backup/now')).code, 400);
  assert.ok(!fs.existsSync(path.join(D, '.backup/key.json')));
  const drive = await fakeDrive(D);
  assert.equal((await t.call('POST', '/backup/dest', { id: 'cloud', on: true })).code, 400); // not linked
  const on = await t.call('POST', '/backup/dest', { id: 'drive', on: true });
  const code = on.obj.recoveryCode;
  assert.ok(parseRecoveryCode(code));
  assert.equal(fs.statSync(path.join(D, '.backup/key.json')).mode & 0o077, 0);
  await t.call('POST', '/backup/recovery-code/confirmed');
  assert.equal((await t.call('POST', '/backup/dest', { id: 'drive', on: true })).obj.recoveryCode, undefined); // shown once unasked
  assert.equal((await t.call('POST', '/backup/escrow', { on: true })).code, 400); // the copy with Opie needs the cloud

  for (let i = 0; i < KEEP.manual + 2; i++) {
    assert.equal((await t.call('POST', '/backup/now')).obj.started, true);
    s = await until(t, (x) => !x.job && x.last && x.last.at && (i === 0 || x.dests[1].last.at !== s.dests[1].last.at));
    assert.equal(s.last.ok, true, s.last.error);
    await new Promise((r) => setTimeout(r, 1100)); // names have one-second times
  }
  assert.equal(fs.readdirSync(drive.dir).length, KEEP.manual);
  assert.match(fs.readdirSync(drive.dir)[0], /^display-backup-\d{8}T\d{6}Z-manual-[0-9a-f]{16}\.backup$/);
  const list = await opened(path.join(drive.dir, fs.readdirSync(drive.dir)[0]), code);
  for (const want of ['webapp/apps/chores/index.html', 'chats/door.json', 'photos/a.jpg', 'household.json']) assert.ok(list.some((l) => l.endsWith(want)), want);
  assert.ok(list.some((l) => l.includes('webapp/.git/')), 'git history');
  assert.ok(list.some((l) => l.startsWith('l') && l.includes('sneaky.json ->')), 'a link stays a link');
  for (const never of ['rootfs', 'bridge/', '.bridge-token', '.backup', '.cloud']) assert.ok(!list.some((l) => l.includes(` ${never}`)), never);

  const listed = (await t.call('GET', '/backup/list')).obj;
  assert.equal(listed.backups.length, KEEP.manual); assert.equal(listed.backups[0].dest, 'drive'); assert.equal(listed.backups[0].needsCode, false);

  fs.writeFileSync(path.join(D, 'household.json'), '{"family":[]}');
  const r = await t.call('POST', '/backup/restore', { dest: 'drive', id: listed.backups[0].id });
  assert.equal(r.code, 200, JSON.stringify(r.obj));
  assert.match(fs.readFileSync(path.join(D, 'household.json'), 'utf8'), /MARKER-HOUSE/);
  assert.equal(fs.readFileSync(path.join(D, '.backup/before-restore/household.json'), 'utf8'), '{"family":[]}');
  assert.match(execFileSync('git', ['log', '--oneline'], { cwd: path.join(D, 'webapp') }).toString(), /Add chores/);
  await new Promise((ok) => setTimeout(ok, 1700));
  assert.equal(t.exited(), 1);

  // The drive pulled out: the next backup says so plainly, as a type in the health check-in.
  drive.st.present = false;
  await t.call('POST', '/backup/now');
  s = await until(t, (x) => !x.job && !x.last.ok);
  assert.match(s.last.error, /Plug in the drive/);
  assert.equal((await t.call('GET', '/cloud/health-bits')).obj.lastErrorType, 'backup.drive.notready');
});

test('videos: a backup holds the newest up to its budget, and a restore keeps the ones it left out', async () => {
  const D = display(); const t = tablet(D, { videoBudget: 5000 });
  const mp4 = (n, at) => { fs.writeFileSync(path.join(D, 'photos', n), crypto.randomBytes(3000)); fs.utimesSync(path.join(D, 'photos', n), at, at); };
  mp4('new.mp4', new Date()); mp4('old.mov', new Date(Date.now() - 864e5));
  fs.mkdirSync(path.join(D, 'photos/.stills')); fs.writeFileSync(path.join(D, 'photos/.stills/old.mov.jpg'), 'still');
  const drive = await fakeDrive(D);
  const code = (await t.call('POST', '/backup/dest', { id: 'drive', on: true })).obj.recoveryCode;
  await t.call('POST', '/backup/now');
  const s = await until(t, (x) => !x.job && x.last?.at);
  assert.equal(s.last.ok, true, s.last.error);
  const list = await opened(path.join(drive.dir, fs.readdirSync(drive.dir)[0]), code);
  assert.ok(list.some((l) => l.endsWith('photos/new.mp4')), 'the newest video is in it');
  assert.ok(!list.some((l) => l.includes('old.mov')), 'the one past the budget is left out');
  assert.ok(list.some((l) => l.endsWith('photos/a.jpg')), 'photos always are');
  const id = (await t.call('GET', '/backup/list')).obj.backups[0].id;
  mp4('later.mp4', new Date()); // came after the backup
  assert.equal((await t.call('POST', '/backup/restore', { dest: 'drive', id })).code, 200);
  for (const n of ['a.jpg', 'new.mp4', 'old.mov', 'later.mp4', '.stills/old.mov.jpg']) assert.ok(fs.existsSync(path.join(D, 'photos', n)), n + ' is still on the tablet');
});

test('a code someone claimed links only after a yes at the tablet; a no leaves it unlinked', { skip: !svc && SKIP }, async () => {
  await signIn('sam@example.com');
  const t = tablet(display());
  assert.equal((await claimed(t)).by, 'sam@example.com'); // the card shows who claimed it
  const no = await t.call('POST', '/cloud/link/confirm', { ok: false });
  assert.equal(no.code, 200); assert.equal(no.obj.linked, false); assert.equal(no.obj.linking, null);
  assert.equal((await t.call('POST', '/cloud/link/confirm', { ok: true })).code, 400); // the answer was no; nothing to say yes to now
  assert.equal((await t.call('GET', '/cloud/status')).obj.linked, false);
});

test('a setup code: kept when the service is out of reach, links once it answers, and only the service refusing it says drop it', { skip: !svc && SKIP }, async () => {
  await signIn('alex@example.com');
  const { token } = (await web('/v1/account/setup', {})).json;
  const t = tablet(display());
  const api = svc.url.replace('localhost', '127.0.0.1');
  // Nothing listening there: the shell keeps the code (anything but 'refused') and tries again.
  const away = await t.call('POST', '/cloud/link/token', { token, api: 'http://127.0.0.1:9', name: 'Opie' });
  assert.equal(away.code, 400); assert.notEqual(away.obj.code, 'refused');
  const ok = await t.call('POST', '/cloud/link/token', { token, api, name: 'Opie' });
  assert.equal(ok.code, 200); assert.equal(ok.obj.linked, true);
  // Used now: the service says so, and that's the one answer the shell drops it for.
  const again = await t.call('POST', '/cloud/link/token', { token, api, name: 'Opie' });
  assert.equal(again.code, 400); assert.equal(again.obj.code, 'refused');
});

test('cloud and drive together; a new tablet restores with the code; the copy kept with Opie; unlink from the web', { skip: !svc && SKIP }, async () => {
  await signIn('pat@example.com');
  const D = display(); const t1 = tablet(D);
  const drive = await fakeDrive(D);
  await link(t1);
  assert.ok(!JSON.stringify((await t1.call('GET', '/cloud/status')).obj).includes('lh1_')); // the credential stays put
  const code = (await t1.call('POST', '/backup/dest', { id: 'cloud', on: true })).obj.recoveryCode;
  assert.equal((await t1.call('POST', '/backup/dest', { id: 'drive', on: true })).obj.recoveryCode, code); // one key for every destination
  await t1.call('POST', '/backup/recovery-code/confirmed');
  await t1.call('POST', '/backup/now');
  const s = await until(t1, (x) => !x.job && x.last);
  assert.equal(s.last.ok, true, s.last.error);
  assert.ok(s.dests.every((d) => d.last.ok));
  // The same format in both places, only ciphertext.
  const inCloud = files(svc.blobs.dir).filter((f) => f.endsWith('.backup'));
  assert.equal(inCloud.length, 1);
  await opened(inCloud[0], code);
  assert.equal(fs.readFileSync(inCloud[0]).subarray(0, 5).toString(), fs.readFileSync(path.join(drive.dir, fs.readdirSync(drive.dir)[0])).subarray(0, 5).toString());
  const listed = (await t1.call('GET', '/backup/list')).obj.backups;
  assert.deepEqual(listed.map((b) => b.dest).sort(), ['cloud', 'drive']);

  // A replacement tablet in the same family: its own key, so the old backup needs the family's code.
  const D2 = tmp(); const t2 = tablet(D2);
  await link(t2);
  const cloudItem = (await t2.call('GET', '/backup/list')).obj.backups.find((b) => b.dest === 'cloud');
  assert.equal(cloudItem.needsCode, true);
  assert.equal((await t2.call('POST', '/backup/restore', { dest: 'cloud', id: cloudItem.id, deviceId: cloudItem.deviceId })).obj.code, 'needcode');
  assert.equal((await t2.call('POST', '/backup/restore', { dest: 'cloud', id: cloudItem.id, deviceId: cloudItem.deviceId, recoveryCode: newRecoveryCode() })).obj.code, 'wrongcode');
  const yes = await t2.call('POST', '/backup/restore', { dest: 'cloud', id: cloudItem.id, deviceId: cloudItem.deviceId, recoveryCode: code.toLowerCase() });
  assert.equal(yes.code, 200, JSON.stringify(yes.obj));
  assert.match(fs.readFileSync(path.join(D2, 'webapp/apps/chores/index.html'), 'utf8'), /MARKER-CHORES/);
  assert.equal((await t2.call('GET', '/backup/recovery-code')).obj.code, code); // the family's code is this tablet's now

  // The copy kept with Opie (off unless asked): with it, a third tablet restores without typing anything.
  assert.equal((await t1.call('GET', '/backup/status')).obj.escrow.on, false);
  assert.equal((await t1.call('POST', '/backup/escrow', { on: true })).code, 200);
  assert.equal((await t1.call('GET', '/backup/status')).obj.escrow.kept, true);
  assert.equal((await web('/v1/account')).json.escrow.length, 1);
  const D3 = tmp(); const t3 = tablet(D3);
  await link(t3);
  const r3 = await t3.call('POST', '/backup/restore', { dest: 'cloud', id: cloudItem.id, deviceId: cloudItem.deviceId });
  assert.equal(r3.code, 200, JSON.stringify(r3.obj));
  // Turned off: Opie's copy goes.
  await t1.call('POST', '/backup/escrow', { on: false });
  assert.equal((await web('/v1/account')).json.escrow.length, 0);

  // Unlinked from the web: the next check finds out, and the tablet drops its credential; the drive still works.
  const id1 = JSON.parse(fs.readFileSync(path.join(D, '.cloud/device.json'), 'utf8')).deviceId;
  assert.equal((await web('/v1/account/revoke', { deviceId: id1 })).status, 200);
  const st = (await t1.call('GET', '/cloud/status?check=1')).obj;
  assert.equal(st.linked, false); assert.equal(st.unlinked.why, 'revoked');
  assert.ok(!fs.existsSync(path.join(D, '.cloud/device.json')));
  assert.equal((await t1.call('GET', '/backup/recovery-code')).obj.code, code);
  await t1.call('POST', '/backup/now');
  const after = await until(t1, (x) => !x.job && x.last && x.last.at !== s.last.at);
  assert.equal(after.dests.find((d) => d.id === 'drive').last.ok, true);
  assert.equal(after.dests.find((d) => d.id === 'cloud').last.ok, false);
});

test('a Google sign-in for the phone page starts only from a linked tablet, for its own page and kind', { skip: !svc && SKIP }, async () => {
  await signIn('alex@example.com');
  const t = tablet(display());
  const page = 'http://192.168.1.20:41234/';
  assert.equal((await t.call('POST', '/cloud/google/start', { r: page, k: 'cal' })).code, 409); // not linked yet
  await link(t);
  assert.equal((await t.call('POST', '/cloud/google/start', { r: 'https://example.com/' })).code, 400);
  for (const k of ['cal', undefined]) {
    const s = await t.call('POST', '/cloud/google/start', { r: page, k });
    assert.equal(s.code, 200);
    const r = await fetch(s.obj.url, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const to = new URL(r.headers.get('location'));
    assert.equal(to.hostname, 'accounts.google.com');
    assert.equal(/calendar/.test(to.searchParams.get('scope')), k === 'cal');
  }
});

test("a forgotten PIN reset through the account: only the shell asks, and a yes from the family's account page comes through once", { skip: !svc && SKIP }, async () => {
  await signIn('sam@example.com');
  const t = tablet(display());
  assert.equal((await t.call('POST', '/cloud/pin-reset/start')).code, 409); // not linked yet
  await link(t);
  const s = await t.call('POST', '/cloud/pin-reset/start');
  assert.equal(s.code, 200);
  assert.equal(s.obj.pollToken, undefined); // the poll token stays in the bridge
  // A paired device's call (a hub passes those on to /cloud/) is never the shell's.
  const res = {};
  await t.cloud.handle({ method: 'POST', b: {}, headers: { 'x-openhouse-screen': 'abc' } }, res, new URL('http://x/cloud/pin-reset/poll'));
  assert.equal(res.code, 403);
  assert.equal((await t.call('POST', '/cloud/pin-reset/poll')).obj.status, 'waiting');
  assert.equal((await web('/v1/account/pin-reset', { code: s.obj.display })).status, 200);
  assert.deepEqual((await t.call('POST', '/cloud/pin-reset/poll')).obj, { status: 'approved', by: 'sam@example.com' });
  assert.equal((await t.call('POST', '/cloud/pin-reset/poll')).obj.status, 'expired');
});
