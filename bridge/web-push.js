// Web Push from the tablet itself (docs/phones-and-tv.md): a note for someone reaches their phone without any
// OpenHouse server. The message is encrypted for that phone (RFC 8291, aes128gcm) and signed with the tablet's own
// key (VAPID, RFC 8292), then posted to the phone's push service (Apple's, Google's or Mozilla's), which sees only
// that something arrived and how big it is. No packages: Node's crypto.
//
//   keys(file)                     the tablet's VAPID key pair, made once and kept in `file`
//   encrypt(sub, payload)          -> Buffer (the body), for a subscription {endpoint, keys: {p256dh, auth}}
//   send(sub, payload, {keys, ttl, urgency, fetch}) -> {ok, status, gone}  (gone: the phone unsubscribed; forget it)
import crypto from 'node:crypto';
import fs from 'node:fs';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/** The tablet's VAPID keys ({publicKey: base64url of the raw 65 bytes, privateKey: PEM}), made the first time. */
export function keys(file) {
  try { const k = JSON.parse(fs.readFileSync(file, 'utf8')); if (k.publicKey && k.privateKey) return k; } catch {}
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(ecdh.getPrivateKey()) };
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' }).export({ type: 'pkcs8', format: 'pem' });
  const k = { publicKey: b64u(pub), privateKey };
  try { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(k), { mode: 0o600 }); fs.renameSync(t, file); } catch {}
  return k;
}

/** RFC 8291: the body for one push message (a single record). `as` lets a test fix the sender's key and salt. */
export function encrypt(sub, payload, as = {}) {
  const uaPub = unb64u(sub?.keys?.p256dh), auth = unb64u(sub?.keys?.auth);
  if (uaPub.length !== 65 || auth.length !== 16) throw new Error('not a push subscription');
  const ecdh = crypto.createECDH('prime256v1');
  if (as.privateKey) ecdh.setPrivateKey(as.privateKey); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPub);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const salt = as.salt || crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const text = Buffer.concat([Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), Buffer.from([2])]); // 2: the last record
  if (text.length > 3993) throw new Error('too long for one push');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(text), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, asPub, body]);
}

/** RFC 8292: the Authorization header for one push service. */
export function vapid(endpoint, k, { subject = 'https://openhouse.computer', hours = 12 } = {}) {
  const aud = new URL(endpoint).origin;
  const part = (o) => b64u(JSON.stringify(o));
  const data = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp: Math.floor(Date.now() / 1000) + hours * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${k.publicKey}`;
}

/** Only real push services: https, on the public internet. A phone can't make the tablet post somewhere else. */
export function okEndpoint(endpoint) {
  let u; try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.port && u.port !== '443') return false;
  return /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(u.hostname);
}

export async function send(sub, payload, { keys: k, ttl = 6 * 3600, urgency = 'normal', topic, fetch: f = fetch } = {}) {
  if (!okEndpoint(sub?.endpoint)) return { ok: false, status: 0, gone: true };
  const body = encrypt(sub, payload);
  const r = await f(sub.endpoint, { method: 'POST', body, signal: AbortSignal.timeout(10000), headers: {
    authorization: vapid(sub.endpoint, k), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
    ttl: String(ttl), urgency, ...(topic ? { topic } : {}) } });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
}
