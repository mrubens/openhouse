// Relay boxes (docs/networking.md): something big comes to the tablet as a key in one relay message, and the tablet
// fetches it through its own cloud with its own credential. A message can't make the tablet fetch from anywhere else,
// or take a box meant for another household.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relayRoutes } from '../relay.js';

test("the tablet fetches only its own relay boxes, only through its own cloud", async () => {
  const DISPLAY = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-box-'));
  fs.mkdirSync(path.join(DISPLAY, '.cloud')); fs.writeFileSync(path.join(DISPLAY, '.cloud/relay.json'), JSON.stringify({ on: true }));
  const out = [], fetched = [], RELAY = 'R'.repeat(22), OTHER = 'O'.repeat(22);
  let sock;
  class WS { constructor() { sock = this; this.readyState = 1; setTimeout(() => this.onopen?.(), 0); } send(t) { out.push(JSON.parse(t)); } close() {} }
  const cloud = { credential: () => 'lh1_x', relayAddress: async () => ({ url: 'wss://relay.example/v1' }), relayBox: async (key) => { fetched.push(key); throw new Error('stand-in'); } };
  const screens = { relayTokens: () => [], computerPairs: () => [] };
  const r = relayRoutes({ DISPLAY, json: () => {}, body: async () => ({}), screens, cloud, WS });
  await new Promise((ok) => setTimeout(ok, 20));
  sock.onmessage({ data: JSON.stringify({ t: 'ok', relay: RELAY }) });
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const ask = async (rid, key, m = 's') => { sock.onmessage({ data: JSON.stringify({ t: 'req', rid, from: 'c1', k: 'b', m, id: 's-1', i: 0, d: b64(key) }) }); await new Promise((ok) => setTimeout(ok, 150)); return out.find((x) => x.t === 'res' && x.rid === rid && x.s)?.s; };

  for (const [rid, key] of [['a', 'https://evil.example/x'], ['b', `box/${OTHER}/${'k'.repeat(32)}`], ['c', `box/${RELAY}/../../etc`], ['d', `box/${RELAY}/${'k'.repeat(31)}`]]) {
    assert.equal(await ask(rid, key), 400, key);
  }
  assert.equal(await ask('e', `box/${RELAY}/${'k'.repeat(32)}`, 'x'), 400, 'only a screen or a hand-off');
  assert.deepEqual(fetched, [], 'nothing fetched for any of those');
  assert.equal(await ask('f', `box/${RELAY}/${'k'.repeat(32)}`), 502);
  assert.deepEqual(fetched, [`box/${RELAY}/${'k'.repeat(32)}`], 'its own: through its own cloud');
  // In parts, only something small.
  const big = Buffer.alloc(16384).toString('base64url');
  for (let i = 0; i < 5; i++) sock.onmessage({ data: JSON.stringify({ t: 'req', rid: 'g', from: 'c1', k: 's', id: 's-1', i, d: big, ...(i < 4 ? { more: 1 } : {}) }) });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(out.find((x) => x.t === 'res' && x.rid === 'g' && x.s)?.s, 413);
  r.stop?.();
});
