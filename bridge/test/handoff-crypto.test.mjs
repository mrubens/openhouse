// The phone page (shell/app/src/main/assets/handoff.html) seals secrets with its own ChaCha20-Poly1305, since
// plain http has no WebCrypto. The shell opens them with Android's (the same as Node's). They must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const html = fs.readFileSync(new URL('../../shell/app/src/main/assets/handoff.html', import.meta.url), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const sandbox = { module: {}, atob, btoa, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, BigInt };
vm.runInNewContext(src, sandbox);
const { CP } = sandbox.module.exports;

const seal = (key, nonce, aad, pt) => { const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 }); c.setAAD(aad); return Buffer.concat([nonce, c.update(pt), c.final(), c.getAuthTag()]); };
const open = (key, aad, box) => { const d = crypto.createDecipheriv('chacha20-poly1305', key, box.subarray(0, 12), { authTagLength: 16 }); d.setAAD(aad); d.setAuthTag(box.subarray(box.length - 16)); return Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]); };

test('RFC 8439 2.8.2 vector', () => {
  const key = Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f', 'hex');
  const nonce = Buffer.from('070000004041424344454647', 'hex'), aad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex');
  const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const box = Buffer.from(CP.seal(new Uint8Array(key), new Uint8Array(nonce), new Uint8Array(aad), new Uint8Array(pt)));
  assert.equal(box.subarray(box.length - 16).toString('hex'), '1ae10b594f09e26a7e902ecbd0600691');
  assert.deepEqual(open(key, aad, box), pt);
});

test('page and native agree both ways, any length', () => {
  for (const n of [0, 1, 15, 16, 17, 63, 64, 65, 300, 2100]) {
    const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), aad = Buffer.from('send'), pt = crypto.randomBytes(n);
    assert.deepEqual(open(key, aad, Buffer.from(CP.seal(new Uint8Array(key), new Uint8Array(nonce), new Uint8Array(aad), new Uint8Array(pt)))), pt);
    assert.deepEqual(Buffer.from(CP.open(new Uint8Array(key), new Uint8Array(aad), new Uint8Array(seal(key, nonce, aad, pt)))), pt);
  }
});

test('a wrong key, label or changed byte is refused', () => {
  const key = crypto.randomBytes(32), box = seal(key, crypto.randomBytes(12), Buffer.from('info'), Buffer.from('{"a":1}'));
  assert.equal(CP.open(new Uint8Array(crypto.randomBytes(32)), new Uint8Array(Buffer.from('info')), new Uint8Array(box)), null);
  assert.equal(CP.open(new Uint8Array(key), new Uint8Array(Buffer.from('send')), new Uint8Array(box)), null);
  const bad = Buffer.from(box); bad[14] ^= 1;
  assert.equal(CP.open(new Uint8Array(key), new Uint8Array(Buffer.from('info')), new Uint8Array(bad)), null);
});

test('the recovery-code page (recovery.html) opens what the display seals, with the same code as handoff.html', () => {
  const page = fs.readFileSync(new URL('../../shell/app/src/main/assets/recovery.html', import.meta.url), 'utf8');
  const block = (h) => h.slice(h.indexOf("'use strict';"), h.indexOf('const te = new TextEncoder()'));
  assert.equal(block(page), block(html)); // one sealing code, copied: keep them the same
  const box = { module: {}, atob, btoa, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, BigInt };
  vm.runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], box);
  const key = crypto.randomBytes(32), info = Buffer.from(JSON.stringify({ title: 'Your family\'s recovery code', code: 'DJPQ-Y5GT-928Q-ZN9J-F2JZ-SQGX-Q4' }));
  const opened = box.module.exports.CP.open(new Uint8Array(key), new Uint8Array(Buffer.from('info')), new Uint8Array(seal(key, crypto.randomBytes(12), Buffer.from('info'), info)));
  assert.equal(JSON.parse(Buffer.from(opened).toString()).code, 'DJPQ-Y5GT-928Q-ZN9J-F2JZ-SQGX-Q4');
});
