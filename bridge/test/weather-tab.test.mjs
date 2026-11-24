// The built-in Weather tab: it can say where home is when nobody has yet, and only the family's own apps may.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardRoutes } from '../board.js';
import { appAllowed } from '../apps.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-wx-')), DIR = path.join(root, 'chats');
fs.mkdirSync(DIR);
fs.writeFileSync(path.join(root, 'household.json'), JSON.stringify({ family: [{ name: 'Alex' }], chores: [] }));
const json = (res, code, obj) => { res.code = code; res.body = obj; };
const homeScreen = { migrate() {}, describe: () => '', during: async () => ({ result: { ok: false, text: 'no agent' }, notes: [] }) };
const board = boardRoutes({ HERE: root, DIR, WORK: root, currentAgent: async () => ({}), agentName: () => 'test', json, body: async (r) => r.body, homeScreen });
const call = async (method, p, b) => { const res = {}; await board({ method, body: b }, res, new URL('http://x' + p)); return res; };

test('POST /household/location sets only the place, and keeps the family', async () => {
  assert.equal((await call('POST', '/household/location', { location: '  ' })).code, 400);
  const r = await call('POST', '/household/location', { location: 'Portland, OR', family: [] });
  assert.equal(r.code, 200);
  const h = (await call('GET', '/household')).body;
  assert.equal(h.location, 'Portland, OR');
  assert.equal(h.family[0].name, 'Alex');
});

test("the family's own apps may set the place; a plugin's app may not", () => {
  assert.ok(appAllowed('POST', '/household/location', null));
  assert.ok(!appAllowed('POST', '/household/location', new Set(['weather'])));
  assert.ok(appAllowed('GET', '/weather', new Set(['weather'])));
});
