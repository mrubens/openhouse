// Send to Opie (docs/phones.md): a phone's share key, which the cloud seals its shortcut's items with, opens one route
// on the tablet and nothing else, only for a phone that may ask Opie, and never twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { screensRoutes, seal, open, shareKey } from '../screens.js';

const b64 = () => crypto.randomBytes(32).toString('base64url');

test('a share key opens only POST /phone/share, only for a phone that may ask, and only once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-share-')), FILE = path.join(dir, 'screens.json');
  const sam = { id: 's-sam', kind: 'phone', person: 'Sam', key: b64(), scopes: ['door', 'arrange', 'ask', 'notify', 'voice'] };
  const leo = { id: 's-leo', kind: 'phone', person: 'Leo', key: b64(), scopes: ['door', 'arrange', 'notify'] };
  const tv = { id: 's-tv', kind: 'tv', key: b64(), scopes: ['door'] };
  fs.writeFileSync(FILE, JSON.stringify({ lan: true, screens: [sam, leo, tv] }));
  const PORT = 20000 + crypto.randomInt(20000), reached = [];
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const s = screensRoutes({ HERE: dir, FILE, PORT, HOST: '127.0.0.1', json, body: async () => ({}), dispatch: (req, res, url) => { reached.push(`${req.method} ${url.pathname}`); json(res, 200, { text: 'Saved.' }); } });
  t.after(() => s.stop());
  await new Promise((r) => setTimeout(r, 200));

  let n = Date.now() * 1000;
  async function send(who, { key = shareKey(who.key), aad = `share:${who.id}`, p = '/phone/share', m = 'POST', at = ++n } = {}) {
    const box = seal(key, aad, Buffer.from(JSON.stringify({ n: at, m, p, b: { text: 'https://example.com/chili' } })));
    const r = await fetch(`http://127.0.0.1:${PORT}/s`, { method: 'POST', headers: { 'x-screen': who.id, 'content-type': 'application/octet-stream' }, body: box });
    const body = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) return { status: r.status };
    const len = body.readUInt32BE(0), head = open(key, `res:${who.id}:${at}:0`, body.subarray(4, 4 + len));
    return { status: JSON.parse(head.subarray(1).toString()).status, at };
  }

  const ok = await send(sam);
  assert.equal(ok.status, 200);
  assert.deepEqual(reached, ['POST /phone/share']);
  assert.equal((await send(sam, { at: ok.at })).status, 409, 'the same request again is refused');
  assert.equal((await send(sam, { at: (Date.now() - 10 * 60e3) * 1000 })).status, 409, 'an old one is refused');
  for (const p of ['/house/list', '/chat', '/phone/share-key', '/phone/push', '/screens']) assert.equal((await send(sam, { p })).status, 403, p);
  assert.equal((await send(sam, { m: 'GET' })).status, 403);
  assert.equal((await send(leo)).status, 403, "a phone that may not ask Opie can't send to it");
  assert.equal((await send(tv)).status, 400, 'only phones have share keys');
  assert.equal((await send(sam, { aad: `req:${sam.id}` })).status, 400, "the share key isn't the phone's key");
  assert.equal((await send(sam, { key: crypto.randomBytes(32) })).status, 400, 'a made-up key opens nothing');
  assert.equal(reached.length, 1, 'nothing else reached the tablet');
});

// An app on a phone reaches only what that phone itself may (screens.js APP_RULES), whatever the app's own rights:
// naming an app never takes a kid's phone to the house's settings, where the household lives, or the recipe links.
test("an app on a phone is cut to the phone's own scopes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-appscope-')), FILE = path.join(dir, 'screens.json');
  const sam = { id: 's-sam', kind: 'phone', person: 'Sam', key: b64(), scopes: ['door', 'arrange', 'ask', 'notify', 'voice'] };
  const leo = { id: 's-leo', kind: 'phone', person: 'Leo', key: b64(), scopes: ['door', 'arrange', 'notify'] };
  fs.writeFileSync(FILE, JSON.stringify({ lan: true, screens: [sam, leo] }));
  const PORT = 20000 + crypto.randomInt(20000), reached = [];
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const s = screensRoutes({ HERE: dir, FILE, PORT, HOST: '127.0.0.1', json, body: async () => ({}), screenApps: () => [{ id: 'chores', name: 'Chores' }],
    dispatch: (req, res, url) => { reached.push(`${req.headers['x-openhouse-screen']} ${req.method} ${url.pathname}`); json(res, 200, {}); } });
  t.after(() => s.stop());
  await new Promise((r) => setTimeout(r, 200));
  let n = Date.now() * 1000;
  async function send(who, m, p) {
    const key = Buffer.from(who.key, 'base64url'), at = ++n;
    const box = seal(key, `req:${who.id}`, Buffer.from(JSON.stringify({ n: at, m, p, a: 'chores', ...(m === 'POST' ? { b: {} } : {}) })));
    const r = await fetch(`http://127.0.0.1:${PORT}/s`, { method: 'POST', headers: { 'x-screen': who.id, 'content-type': 'application/octet-stream' }, body: box });
    const body = Buffer.from(await r.arrayBuffer()), len = body.readUInt32BE(0);
    return JSON.parse(open(key, `res:${who.id}:${at}:0`, body.subarray(4, 4 + len)).subarray(1).toString()).status;
  }
  for (const p of ['/house/settings', '/household/location', '/house/recipe-link', '/house/photo/remove', '/house/share', '/map/place'])
    assert.equal(await send(leo, 'POST', p), 403, `a kid's phone: ${p}`);
  for (const p of ['/house/settings', '/household/location', '/house/share']) assert.equal(await send(sam, 'POST', p), 403, `any phone: ${p}`);
  assert.equal(await send(leo, 'POST', '/house/chore'), 200);
  assert.equal(await send(leo, 'GET', '/house'), 200);
  assert.equal(await send(sam, 'POST', '/house/recipe-link'), 200);
  assert.deepEqual(reached, ['s-leo POST /house/chore', 's-leo GET /house', 's-sam POST /house/recipe-link']);
});
