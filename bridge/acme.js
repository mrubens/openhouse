// A small ACME client (RFC 8555) for one thing: a certificate for the tablet's own https name at home (lan-tls.js),
// from Let's Encrypt, proved by DNS-01. Only node:crypto and fetch: the bridge has no packages. The keys are made here
// and never leave the tablet; the CA gets a certificate request (the public key and the name), and whoever sets the
// TXT record (the cloud, for this tablet's name only) gets the challenge's digest, nothing else.
import crypto from 'node:crypto';

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/** A new P-256 key, as PEM. */
export const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

function jwkOf(key) {
  const { kty, crv, x, y } = crypto.createPublicKey(key).export({ format: 'jwk' });
  return { crv, kty, x, y }; // (RFC 7638's member order, for the thumbprint)
}
export const thumbprint = (key) => b64u(sha256(JSON.stringify(jwkOf(key))));
/** The TXT value DNS-01 wants for a challenge's token (RFC 8555 8.4). */
export const dnsValue = (token, accountKey) => b64u(sha256(`${token}.${thumbprint(accountKey)}`));

// --- DER, just enough for a certificate request --------------------------------------------------------------
const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map(Buffer.from)); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = (s) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) { const bytes = [n & 0x7f]; for (let v = n >> 7; v; v >>= 7) bytes.unshift((v & 0x7f) | 0x80); out.push(...bytes); }
  return tlv(0x06, Buffer.from(out));
};

/** A PKCS#10 certificate request for one DNS name (in its CN and its subjectAltName), signed with key, as DER. */
export function csr(name, key) {
  if (!/^[a-z0-9.-]{1,253}$/.test(name)) throw new Error('name');
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const san = seq(seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, Buffer.from(name))))));
  const info = seq(
    tlv(0x02, Buffer.from([0])), // version 1
    seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(name))))), // CN=name
    spki,
    tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(san))), // extensionRequest: subjectAltName
  );
  const sig = crypto.sign('sha256', info, key); // ECDSA, DER
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

// --- the protocol ----------------------------------------------------------------------------------------------
/**
 * One certificate for name: makes an order, has setTxt(value) put the DNS-01 value at _acme-challenge.<name> and
 * waitTxt(value) wait until it's visible, finalizes with a request for certKey, and returns the chain (PEM).
 * clearTxt() runs whatever happens. accountKey: PEM (kept by the caller; an account is made or found with it).
 */
export async function certificate({ directory = LETS_ENCRYPT, accountKey, certKey, name, setTxt, waitTxt = async () => {}, clearTxt = async () => {}, fetch: f = globalThis.fetch, poll = 2000, log = () => {} }) {
  const dir = await (await f(directory)).json();
  let nonce = null, kid = null;
  const freshNonce = async () => (await f(dir.newNonce, { method: 'HEAD' })).headers.get('replay-nonce');
  async function post(url, payload, retry = true) {
    nonce ??= await freshNonce();
    const header = { alg: 'ES256', nonce, url, ...(kid ? { kid } : { jwk: jwkOf(accountKey) }) };
    const protectedB64 = b64u(JSON.stringify(header)), payloadB64 = payload === null ? '' : b64u(JSON.stringify(payload));
    const signature = b64u(crypto.sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), { key: accountKey, dsaEncoding: 'ieee-p1363' }));
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/jose+json' }, body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature }) });
    nonce = r.headers.get('replay-nonce');
    const type = r.headers.get('content-type') || '';
    const body = type.includes('json') ? await r.json() : await r.text();
    if (r.status >= 400) {
      if (retry && body?.type === 'urn:ietf:params:acme:error:badNonce') return post(url, payload, false);
      throw Object.assign(new Error(`ACME ${r.status}: ${body?.detail || body?.type || ''}`.slice(0, 300)), { status: r.status, acme: body?.type || null });
    }
    return { body, location: r.headers.get('location') };
  }
  const until = async (url, done) => {
    for (let i = 0; i < 90; i++) {
      const { body } = await post(url, null);
      if (done(body)) return body;
      if (body.status === 'invalid') throw new Error(`ACME: ${JSON.stringify(body.error || body.challenges?.find((c) => c.error)?.error || 'invalid').slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, poll));
    }
    throw new Error('ACME: took too long');
  };

  kid = (await post(dir.newAccount, { termsOfServiceAgreed: true })).location;
  const { body: order, location: orderUrl } = await post(dir.newOrder, { identifiers: [{ type: 'dns', value: name }] });
  try {
    for (const authzUrl of order.authorizations) {
      const { body: authz } = await post(authzUrl, null);
      if (authz.status === 'valid') continue; // (proved lately: the CA keeps it a while)
      const ch = authz.challenges.find((c) => c.type === 'dns-01');
      if (!ch) throw new Error('ACME: no dns-01 challenge');
      const value = dnsValue(ch.token, accountKey);
      await setTxt(value);
      await waitTxt(value);
      log('asking the CA to check');
      await post(ch.url, {});
      await until(authzUrl, (a) => a.status === 'valid');
    }
  } finally { await clearTxt().catch(() => {}); }
  await post(order.finalize, { csr: b64u(csr(name, certKey)) });
  const done = await until(orderUrl, (o) => o.status === 'valid' && o.certificate);
  const { body: chain } = await post(done.certificate, null);
  if (typeof chain !== 'string' || !chain.includes('BEGIN CERTIFICATE')) throw new Error('ACME: no certificate');
  return chain;
}
