// Backups to the household's own storage bucket (bucket-backup.js, hub/s3.mjs, docs/backups.md "Your own storage"):
// against a small S3 stand-in here, through a real keeper. Back up, list, restore, nothing lost; the bucket sees only
// ciphertext; the bridge never sees the secret; the host signs only what a backup needs.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keeperHost } from '../host.js';
import { backupRoutes } from '../backup.js';
import { bucketDestination } from '../bucket-backup.js';
import { presignRaw, sign } from '../../hub/s3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY_ID = 'opie-test-key', SECRET = `s3cret-${crypto.randomBytes(12).toString('hex')}`;
let child, host, root, s3, s3url;
const objects = new Map(); // "bucket/key" -> Buffer
const seen = []; // every URL the stand-in was sent

// The stand-in checks a presigned SigV4 request from what arrives, as a server sees it (its own reading of the spec).
function verified(req, u) {
  const q = u.searchParams, sig = q.get('X-Amz-Signature');
  const [keyId, day, region, svc, term] = String(q.get('X-Amz-Credential') || '').split('/');
  if (keyId !== KEY_ID) return 'InvalidAccessKeyId';
  const amz = q.get('X-Amz-Date') || '';
  const at = Date.UTC(+amz.slice(0, 4), +amz.slice(4, 6) - 1, +amz.slice(6, 8), +amz.slice(9, 11), +amz.slice(11, 13), +amz.slice(13, 15));
  if (!(Date.now() - at < Number(q.get('X-Amz-Expires')) * 1000)) return 'AccessDenied';
  const e = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const qs = [...q.entries()].filter(([k]) => k !== 'X-Amz-Signature').map(([k, v]) => [e(k), e(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((p) => p.join('=')).join('&');
  const canonical = [req.method, u.pathname, qs, `host:${req.headers.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const h = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  const toSign = ['AWS4-HMAC-SHA256', amz, `${day}/${region}/${svc}/${term}`, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const want = h(h(h(h(h('AWS4' + SECRET, day), region), svc), term), toSign).toString('hex');
  return want === sig ? null : 'SignatureDoesNotMatch';
}
const xmlErr = (res, status, code) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`); };

before(async () => {
  s3 = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); seen.push(req.url);
    const parts = []; for await (const c of req) parts.push(c);
    const bad = verified(req, u); if (bad) return xmlErr(res, 403, bad);
    const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/'), key = rest.join('/');
    if (bucket !== 'opie-backups') return xmlErr(res, 404, 'NoSuchBucket');
    if (!key && req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const pre = u.searchParams.get('prefix') || '', after = u.searchParams.get('continuation-token') || '';
      const all = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${pre}`)).map((k) => k.slice(bucket.length + 1)).sort().filter((k) => k > after);
      const page = all.slice(0, 2); // two at a time, so the bridge follows the continuation
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${objects.get(`${bucket}/${k}`).length}</Size></Contents>`).join('')}<IsTruncated>${all.length > 2}</IsTruncated>${all.length > 2 ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    const at = `${bucket}/${key}`;
    if (req.method === 'PUT') { objects.set(at, Buffer.concat(parts)); res.writeHead(200); return res.end(); }
    if (req.method === 'GET') { if (!objects.has(at)) return xmlErr(res, 404, 'NoSuchKey'); res.writeHead(200); return res.end(objects.get(at)); }
    if (req.method === 'DELETE') { objects.delete(at); res.writeHead(204); return res.end(); }
    xmlErr(res, 405, 'MethodNotAllowed');
  });
  await new Promise((ok) => s3.listen(0, '127.0.0.1', ok));
  s3url = `http://127.0.0.1:${s3.address().port}`;

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-'));
  const token = crypto.randomBytes(32).toString('base64url'), port = 20000 + crypto.randomInt(20000);
  child = spawn(process.execPath, [path.join(HERE, '..', '..', 'hub', 'keeper.mjs')], { stdio: 'ignore',
    env: { ...process.env, OPENHOUSE_KEEPER_TOKEN: token, KEEPER_PORT: String(port), OPENHOUSE_DATA: path.join(root, 'data'), OPENHOUSE_KEEPER_DIR: path.join(root, 'keeper'), OPENHOUSE_KEEPER_STORE: 'file', BRIDGE_URL: 'http://127.0.0.1:9' } });
  host = await keeperHost({ url: `http://127.0.0.1:${port}`, token }).ready();
});
after(() => { child?.kill(); s3?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("the signer matches Amazon's own presigned example", () => {
  const cfg = { endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'examplebucket', prefix: '', keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const u = presignRaw(cfg, { method: 'GET', key: 'test.txt', expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(new URL(u).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('the host signs only what a backup needs, only under the prefix', () => {
  const cfg = { endpoint: s3url, region: 'us-east-1', bucket: 'b', prefix: 'opie/', keyId: KEY_ID, secret: SECRET };
  for (const name of ['../x', 'a/b', '..', '', 'x'.repeat(201)]) assert.ok(sign(cfg, { method: 'GET', name }).error, name);
  for (const method of ['POST', 'PATCH', 'COPY']) assert.ok(sign(cfg, { method, name: 'a' }).error, method);
  assert.ok(sign(cfg, { method: 'PUT', list: true }).error);
  assert.match(sign(cfg, { method: 'PUT', name: 'a.backup' }).url, /\/b\/opie\/a\.backup\?/);
  assert.equal(new URL(sign(cfg, { method: 'GET', list: true }).url).searchParams.get('prefix'), 'opie/');
});

test('own storage: the Check refuses a wrong secret or bucket, then back up, list, restore, nothing lost', async () => {
  const set = (b) => host.call('/storage/set', { endpoint: s3url, region: 'us-east-1', bucket: 'opie-backups', prefix: 'sam-and-alex', keyId: KEY_ID, secret: SECRET, ...b });
  assert.equal((await set({ secret: 'not-the-secret' })).status, 400);
  assert.equal((await set({ keyId: 'someone-else' })).status, 400);
  assert.equal((await set({ bucket: 'no-such-bucket' })).status, 400);
  assert.equal((await host.call('/storage/status')).body.set, false, 'nothing kept when the Check fails');
  assert.equal((await host.call('/storage/sign', { method: 'GET', name: 'x' })).status, 409);
  const ok = await set({});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal([...objects.keys()].length, 0, 'the Check leaves nothing behind');

  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-display-'));
  const file = (f) => path.join(D, f);
  const put = (f, v) => { fs.mkdirSync(path.dirname(file(f)), { recursive: true }); fs.writeFileSync(file(f), JSON.stringify(v)); };
  const stores = ['household.json', 'later.json', 'things.json', 'chats/door.json'];
  for (const f of stores) put(f, { kept: f, who: ['Sam', 'Alex', 'Maya', 'Leo'] });
  fs.mkdirSync(file('photos'), { recursive: true }); fs.writeFileSync(file('photos/maple.jpg'), crypto.randomBytes(50_000));
  const photo = fs.readFileSync(file('photos/maple.jpg'));

  let t = Date.parse('2026-11-27T10:00:00Z'), exits = 0;
  const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const body = async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
  const b = backupRoutes({ DISPLAY: D, tick: 0, json, body, now: () => (t += 60e3), exit: () => { exits++; }, destinations: [bucketDestination({ h: host })] });
  const srv = http.createServer(async (req, res) => { if (!(await b.handle(req, res, new URL('http://x' + req.url)))) json(res, 404, {}); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const call = async (m, p, v) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: m, ...(v ? { body: JSON.stringify(v) } : {}) }); return { code: r.status, text: await r.clone().text(), obj: await r.json() }; };
  try {
    const st = await call('GET', '/backup/status');
    assert.equal(st.obj.dests[0].ready, true, JSON.stringify(st.obj));
    assert.equal((await call('POST', '/backup/dest', { id: 'bucket', on: true })).code, 200);
    for (let i = 0; i < 7; i++) assert.equal((await b.backup('manual')).ok, true); // more than are kept
    const listed = (await call('GET', '/backup/list')).obj.backups;
    assert.equal(listed.length, 5, 'the newest 5 manual ones are kept, the older deleted from the bucket');
    assert.equal(objects.size, 5);
    for (const [k, v] of objects) {
      assert.match(k, /^opie-backups\/sam-and-alex\/display-backup-.*\.backup$/);
      assert.equal(v.subarray(0, 4).toString(), 'DBK1');
      assert.ok(!v.includes(Buffer.from('Maya')) && !v.includes(photo.subarray(0, 64)), 'the bucket sees only ciphertext');
    }

    for (const f of stores) put(f, { changed: f });
    fs.rmSync(file('photos/maple.jpg'));
    const r = await call('POST', '/backup/restore', { dest: 'bucket', id: listed[0].id });
    assert.equal(r.code, 200, r.text);
    for (const f of stores) assert.deepEqual(JSON.parse(fs.readFileSync(file(f), 'utf8')), { kept: f, who: ['Sam', 'Alex', 'Maya', 'Leo'] }, f);
    assert.deepEqual(fs.readFileSync(file('photos/maple.jpg')), photo);

    // The secret: never in what the bridge was told, wrote, or sent.
    const everything = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? everything(path.join(dir, e.name)) : [fs.readFileSync(path.join(dir, e.name))]));
    for (const buf of everything(D)) assert.ok(!buf.includes(Buffer.from(SECRET)));
    assert.ok(!(await call('GET', '/backup/status')).text.includes(SECRET));
    assert.ok(!JSON.stringify((await host.call('/storage/status')).body).includes(SECRET));
    assert.ok(seen.length > 10 && seen.every((u) => !u.includes(SECRET)), 'only signatures cross, never the secret');
    for (const buf of everything(path.join(root, 'keeper'))) assert.ok(!buf.includes(Buffer.from(SECRET)), 'kept sealed in the keeper too');

    assert.equal((await call('POST', '/backup/storage/remove', {})).code, 200);
    assert.equal((await host.call('/storage/status')).body.set, false);
    assert.equal((await call('GET', '/backup/status')).obj.dests[0].on, false);
  } finally { srv.close(); await new Promise((ok) => setTimeout(ok, 1700)); fs.rmSync(D, { recursive: true, force: true }); }
});
