// Notes for the iPhone app (docs/iphone-app.md) go through the cloud and APNs: what leaves the tablet must be sealed so
// only that phone opens it, a token is taken only from a phone that may get notes, and a token APNs says is gone stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { screensRoutes, open, noteKey, shareKey } from '../screens.js';

const b64 = () => crypto.randomBytes(32).toString('base64url');

test('an iPhone gets its notes sealed with its own note key, through the cloud', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-apns-')), FILE = path.join(dir, 'screens.json');
  const sam = { id: 's-sam', kind: 'phone', person: 'Sam', key: b64(), scopes: ['door', 'arrange', 'ask', 'notify'] };
  const tv = { id: 's-tv', kind: 'tv', key: b64(), scopes: ['door'] };
  fs.writeFileSync(FILE, JSON.stringify({ lan: true, screens: [sam, tv] }));
  const sent = [];
  let answer = { ok: true };
  const out = {}, json = (res, code, obj) => Object.assign(out, { code, obj });
  let posted = {};
  const s = screensRoutes({ HERE: dir, FILE, PORT: 20000 + crypto.randomInt(20000), HOST: '127.0.0.1', json, body: async () => posted, apns: async (b) => { sent.push(b); return answer; } });
  t.after(() => s.stop());
  const phone = async (who, b) => { posted = b; await s.phone({ method: 'POST', headers: { 'x-openhouse-screen': who } }, {}, new URL('http://x/phone/push')); return out; };

  const token = 'ab'.repeat(32);
  assert.equal((await phone('s-tv', { apns: { token, env: 'production' } })).code, 403, 'only a phone that may get notes');
  assert.equal((await phone('s-sam', { apns: { token: 'not-hex', env: 'production' } })).code, 400);
  assert.equal((await phone('s-sam', { apns: { token, env: 'elsewhere' } })).code, 400);
  assert.equal((await phone('s-sam', { apns: { token, env: 'sandbox' } })).obj.on, true);

  assert.equal(await s.notify('Sam', { title: 'Dentist', body: 'In 15 minutes', tag: 'ev-1' }), 1);
  assert.equal(sent.length, 1);
  const [x] = sent;
  assert.equal(x.token, token); assert.equal(x.env, 'sandbox');
  assert.ok(!JSON.stringify(x).includes('Dentist') && !JSON.stringify(x).includes('ev-1'), 'nothing readable leaves the tablet');
  const box = Buffer.from(x.box, 'base64url');
  assert.equal(JSON.parse(open(noteKey(sam.key), 'note:s-sam', box)).title, 'Dentist');
  assert.equal(open(Buffer.from(sam.key, 'base64url'), 'note:s-sam', box), null, 'not with the phone key itself');
  assert.equal(open(shareKey(sam.key), 'note:s-sam', box), null);
  assert.equal(open(noteKey(sam.key), 'note:s-tv', box), null);

  answer = { gone: true };
  await s.notify('Sam', { title: 'Again', body: 'x' });
  sent.length = 0;
  assert.equal(await s.notify('Sam', { title: 'After', body: 'x' }), 0);
  assert.equal(sent.length, 0, 'a token APNs said is gone is dropped');
});
