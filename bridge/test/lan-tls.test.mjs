// The tablet's https name at home (lan-tls.js, acme.js): its key is made here and never sent anywhere (the cloud gets
// the address and the challenge's digest, the CA a signed request), every ACME request is signed with the account key,
// the links use https only while the name finds this tablet, and an unlinked tablet drops its name and certificate.
// A small CA stands in for Let's Encrypt here; openssl signs the request (skipped without openssl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lanTls } from '../lan-tls.js';
import { dnsValue } from '../acme.js';

const openssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** An ACME server (RFC 8555) that checks every request's signature and nonce, and issues with openssl. */
async function fakeCa(dir) {
  const caKey = path.join(dir, 'ca.key'), caCert = path.join(dir, 'ca.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '2', '-subj', '/CN=Test CA'], { stdio: 'ignore' });
  const nonces = new Set(), accounts = new Map(), seen = [];
  let base, challenge = null, order = null;
  const nonce = () => { const n = crypto.randomBytes(12).toString('base64url'); nonces.add(n); return n; };
  const server = http.createServer(async (req, res) => { try { await handle(req, res); } catch (e) { errors.push(e.message); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'test', detail: e.message })); } });
  const errors = [];
  async function handle(req, res) {
    let raw = ''; for await (const c of req) raw += c;
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'replay-nonce': nonce(), 'content-type': typeof body === 'string' ? 'application/pem-certificate-chain' : 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.url === '/dir') return send(200, { newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order` });
    if (req.method === 'HEAD') return send(200, {});
    seen.push(raw);
    const jws = JSON.parse(raw), h = JSON.parse(Buffer.from(jws.protected, 'base64url'));
    assert.ok(nonces.delete(h.nonce), 'a fresh nonce, once');
    assert.equal(h.url, base + req.url);
    const jwk = h.jwk || accounts.get(h.kid);
    assert.ok(jwk, 'a known account');
    assert.ok(crypto.verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url')), 'signed by the account key');
    const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url')) : null;
    if (req.url === '/acct') { const kid = `${base}/acct/1`; accounts.set(kid, jwk); return send(201, { status: 'valid' }, { location: kid }); }
    if (req.url === '/order') { order = { name: payload.identifiers[0].value, status: 'pending' }; challenge = { token: crypto.randomBytes(16).toString('base64url'), jwk }; return send(201, { status: 'pending', authorizations: [`${base}/authz`], finalize: `${base}/finalize` }, { location: `${base}/order/1` }); }
    if (req.url === '/authz') return send(200, { status: order.status === 'pending' ? (challenge.answered ? 'valid' : 'pending') : 'valid', challenges: [{ type: 'dns-01', url: `${base}/chal`, token: challenge.token }] });
    if (req.url === '/chal') { challenge.answered = true; return send(200, { status: 'processing' }); }
    if (req.url === '/finalize') {
      const csr = path.join(dir, 'req.der'), out = path.join(dir, 'cert.pem');
      fs.writeFileSync(csr, Buffer.from(payload.csr, 'base64url'));
      execFileSync('openssl', ['req', '-inform', 'DER', '-in', csr, '-verify', '-out', csr + '.pem'], { stdio: 'ignore' }); // (a request signed by the key it names)
      fs.writeFileSync(path.join(dir, 'ext.cnf'), `subjectAltName=DNS:${order.name}\n`);
      execFileSync('openssl', ['x509', '-req', '-in', csr + '.pem', '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-days', '90', '-extfile', path.join(dir, 'ext.cnf'), '-out', out], { stdio: 'ignore' });
      order.status = 'valid'; order.cert = fs.readFileSync(out, 'utf8') + fs.readFileSync(caCert, 'utf8');
      return send(200, { status: 'processing' });
    }
    if (req.url === '/order/1') return send(200, { status: order.status, ...(order.cert ? { certificate: `${base}/cert` } : {}) });
    if (req.url === '/cert') return send(200, order.cert);
    send(404, {});
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { directory: `${base}/dir`, seen, errors, token: () => challenge?.token, close: () => server.close() };
}

function fakeCloud() {
  const calls = [];
  let linked = true, revoked = false, id = 'd1';
  return { calls, unlink: (forGood = true) => { linked = false; revoked = forGood; }, relink: (to) => { linked = true; revoked = false; id = to; },
    linked: () => linked, revoked: () => !linked && revoked, linkId: () => (linked ? id : null),
    async lan(what, b) { calls.push([what, b]); if (what === 'name') return { name: 't-abcdefghjk.lan.example.com', ip: b.ip }; return { ok: true }; } };
}

test('gets its own certificate: key made and kept here, the cloud sees only the address and the digest', { skip: !openssl && 'no openssl' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-lan-tls-'));
  const ca = await fakeCa(dir), cloud = fakeCloud();
  let resolvesTo = '192.168.1.20';
  const t = lanTls({ DIR: path.join(dir, '.lan-tls'), cloud, PORT: 8788, directory: ca.directory, lookup: async () => resolvesTo, waitTxt: async () => true, log: (...a) => process.env.LAN_DEBUG && console.log('[lan]', ...a) });
  try {
    assert.equal(t.address('8.8.8.8'), false, 'only a home address');
    assert.equal(t.address('192.168.1.20'), true);
    await t.kick();
    const tls = t.tls();
    assert.ok(tls, 'a certificate');
    const cert = new crypto.X509Certificate(tls.cert);
    assert.ok(cert.checkHost('t-abcdefghjk.lan.example.com'));
    assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(tls.key)));
    // The cloud: the name for this address, the challenge's digest (for the account key), then it's taken away.
    assert.deepEqual(cloud.calls.map(([w]) => w), ['name', 'challenge', 'challenge/done']);
    assert.deepEqual(cloud.calls[0][1], { ip: '192.168.1.20' });
    const accountKey = fs.readFileSync(path.join(dir, '.lan-tls/account.key'), 'utf8');
    assert.deepEqual(cloud.calls[1][1], { value: dnsValue(ca.token(), accountKey) });
    // No private key went anywhere: not to the cloud, not to the CA.
    const sent = JSON.stringify(cloud.calls) + ca.seen.join('');
    for (const pem of [tls.key, accountKey]) {
      const { d } = crypto.createPrivateKey(pem).export({ format: 'jwk' });
      assert.ok(!sent.includes(d) && !sent.includes(pem.split('\n')[1]), 'no private key sent');
    }
    for (const f of ['key.pem', 'account.key']) assert.equal(fs.statSync(path.join(dir, '.lan-tls', f)).mode & 0o077, 0, `${f}: the bridge's only`);
    // Links use the name only while it finds this tablet here.
    await t.check();
    assert.equal(t.base(), 'https://t-abcdefghjk.lan.example.com:8788');
    resolvesTo = '192.168.1.99';
    await t.check();
    assert.equal(t.base(), null);
    // Not renewed while most of it is left: no new order.
    const before = ca.seen.length;
    await t.kick();
    assert.equal(ca.seen.length, before);
    // A 401 that isn't a revoke: the certificate stays; linked again, it asks for the name it had.
    cloud.unlink(false);
    await t.check(); await t.kick();
    assert.ok(t.tls(), 'kept');
    cloud.relink('d2');
    await t.kick();
    assert.deepEqual(cloud.calls.at(-1), ['name', { ip: '192.168.1.20', keep: 't-abcdefghjk.lan.example.com' }]);
    assert.ok(t.tls());
    // Revoked (the cloud took the name away): the certificate and the name go here too.
    cloud.unlink();
    await t.check();
    assert.equal(t.tls(), null);
    assert.equal(t.status().name, null);
    assert.ok(!fs.existsSync(path.join(dir, '.lan-tls/key.pem')));
  } finally { t.stop(); ca.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
