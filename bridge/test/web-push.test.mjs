// Web Push from the tablet (web-push.js): RFC 8291's own example, a phone opening what was sent, VAPID, and only real
// push services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../web-push.js';

const u = (s) => Buffer.from(s, 'base64url');

/** What the phone's browser does with a push body (RFC 8291, the receiving side). */
function open(body, uaPriv, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(uaPriv);
  const shared = ecdh.computeSecret(asPub), uaPub = ecdh.getPublicKey();
  const h = (s, k, i, n) => Buffer.from(crypto.hkdfSync('sha256', k, s, i, n));
  const ikm = h(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', h(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), h(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2);
  return pt.subarray(0, pt.length - 1).toString();
}
function phone() {
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const auth = crypto.randomBytes(16);
  return { priv: e.getPrivateKey(), auth, sub: { endpoint: 'https://web.push.apple.com/' + crypto.randomBytes(6).toString('hex'), keys: { p256dh: e.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}

test('RFC 8291 appendix A: the same bytes', () => {
  const uaPriv = u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
  const ua = crypto.createECDH('prime256v1'); ua.setPrivateKey(uaPriv);
  const sub = { endpoint: 'https://push.example.net', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
  const body = P.encrypt(sub, 'When I grow up, I want to be a watermelon', { privateKey: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: u('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a phone opens what the tablet sent, and the push service gets a signed request', async () => {
  const ph = phone(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-push-'));
  const k = P.keys(path.join(dir, 'push.json'));
  assert.deepEqual(P.keys(path.join(dir, 'push.json')), k, 'made once, then kept');
  let got;
  const r = await P.send(ph.sub, { title: 'Dentist at 4', body: 'Sam, the car is at 3:30.' }, { keys: k, fetch: async (url, o) => { got = { url, ...o }; return { status: 201 }; } });
  assert.deepEqual(r, { ok: true, status: 201, gone: false });
  assert.equal(got.url, ph.sub.endpoint);
  assert.equal(got.headers['content-encoding'], 'aes128gcm');
  assert.deepEqual(JSON.parse(open(got.body, ph.priv, ph.auth)), { title: 'Dentist at 4', body: 'Sam, the car is at 3:30.' });
  // VAPID: a JWT for the push service's origin, signed with the tablet's key, and that key alongside.
  const [, t, kk] = got.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(kk, k.publicKey);
  const [h, c, s] = t.split('.');
  assert.equal(JSON.parse(u(c)).aud, 'https://web.push.apple.com');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: u(k.publicKey).subarray(1, 33).toString('base64url'), y: u(k.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, u(s)));
  // An unsubscribed phone: the service says gone, so the tablet forgets it.
  assert.equal((await P.send(ph.sub, 'x', { keys: k, fetch: async () => ({ status: 410 }) })).gone, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only real push services: a phone can\'t make the tablet post anywhere else', async () => {
  for (const e of ['http://fcm.googleapis.com/x', 'https://192.168.1.5/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://localhost/x', 'https://fcm.googleapis.com:8443/x'])
    assert.equal(P.okEndpoint(e), false, e);
  for (const e of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc'])
    assert.equal(P.okEndpoint(e), true, e);
  let called = false;
  const r = await P.send({ endpoint: 'https://evil.example/x', keys: phone().sub.keys }, 'x', { keys: {}, fetch: async () => { called = true; } });
  assert.equal(called, false); assert.equal(r.ok, false);
});
