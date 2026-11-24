// Sealed mail (docs/tablet-email.md, "How the parts talk"): the cloud seals each message it receives for the tablet's
// mail key, so the copy waiting in the cloud is one only the tablet can open. The cloud's seal copies seal() here.
//
//   OHM1 (4) | ephemeral X25519 public key (32) | nonce (12) | AES-256-GCM(raw MIME) | tag (16)
//   key = HKDF-SHA256(X25519(ephemeral, tablet), salt = ephemeral pub | tablet pub, info 'openhouse-mail-v1', 32)
//   additional data: the 4 magic bytes
import crypto from 'node:crypto';

const MAGIC = Buffer.from('OHM1');
const INFO = Buffer.from('openhouse-mail-v1');
const b64u = (b) => Buffer.from(b).toString('base64url');

/** The raw 32-byte public key of an X25519 KeyObject. */
const rawPublic = (k) => Buffer.from(k.export({ format: 'jwk' }).x, 'base64url');
const publicFromRaw = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' });

/** A new mail key: {pub, priv}, both base64url (priv: the JWK's d). */
export function newMailKey() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const j = privateKey.export({ format: 'jwk' });
  return { pub: j.x, priv: j.d };
}

function aesKey(shared, ephPub, tabletPub) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, tabletPub]), INFO, 32));
}

/** Seal bytes for a tablet's public key (base64url). */
export function seal(pub, bytes) {
  const tabletPub = Buffer.from(String(pub), 'base64url');
  if (tabletPub.length !== 32) throw new Error('mail key');
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = rawPublic(eph.publicKey);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(tabletPub) });
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(shared, ephPub, tabletPub), nonce);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([MAGIC, ephPub, nonce, body, c.getAuthTag()]);
}

/** Open a sealed message with the tablet's key ({pub, priv}); throws if it isn't one sealed for this key. */
export function open(key, sealed) {
  const b = Buffer.from(sealed);
  if (b.length < 4 + 32 + 12 + 16 || !b.subarray(0, 4).equals(MAGIC)) throw new Error('not sealed mail');
  const ephPub = b.subarray(4, 36), nonce = b.subarray(36, 48), tag = b.subarray(b.length - 16), body = b.subarray(48, b.length - 16);
  const tabletPub = Buffer.from(key.pub, 'base64url');
  const priv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: key.pub, d: key.priv }, format: 'jwk' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: publicFromRaw(ephPub) });
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(shared, ephPub, tabletPub), nonce);
  d.setAAD(MAGIC); d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

/** A sender's hash for the cloud's list: hex HMAC-SHA256 of the address, lowercased and trimmed. */
export const senderHash = (hashKey, address) => crypto.createHmac('sha256', Buffer.from(String(hashKey), 'base64url')).update(String(address).trim().toLowerCase()).digest('hex');
