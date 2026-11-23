// Device connections pin a device's own certificate to its address, on this machine's own Wi-Fi address
// (device connections refuse loopback, as they refuse the internet). docs/phones-and-tv.md
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))?.address;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-tv-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a device\'s own certificate is kept for its address: a different one there is refused', { skip: !lan && 'no Wi-Fi address on this machine' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const net = await import('../devices/net.js');
  const cert = (n) => {
    const k = path.join(tmp, `k${n}.pem`), c = path.join(tmp, `c${n}.pem`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k, '-out', c, '-days', '1', '-subj', `/CN=tv${n}`], { stdio: 'pipe' });
    return { key: fs.readFileSync(k), cert: fs.readFileSync(c) };
  };
  const kept = new Map();
  Object.assign(net.pins, { get: (w) => kept.get(w) || null, set: (w, fp) => kept.set(w, fp) });
  const serve = (c, port = 0) => new Promise((ok) => { const s = https.createServer(c, (q, r) => r.end('hi')).listen(port, lan, () => ok(s)); });
  const one = cert(1), two = cert(2);
  let s = await serve(one); const port = s.address().port;
  assert.equal((await net.request(`https://${lan}:${port}/`)).text, 'hi');
  assert.equal(kept.size, 1, 'kept the first time');
  assert.equal((await net.request(`https://${lan}:${port}/`)).text, 'hi', 'the same one again: fine');
  await new Promise((r) => s.close(r));
  s = await serve(two, port);
  await assert.rejects(net.request(`https://${lan}:${port}/`), /different certificate/);
  await new Promise((r) => s.close(r));
});
