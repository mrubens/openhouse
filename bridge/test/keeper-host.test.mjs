// The keeper as the bridge's host (hub/keeper.mjs, host.js, docs/host.md): a card's yes needs the PIN once one is
// set, checked in the keeper; the setup's PIN is chosen only while none is set; what it can't do it says so.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keeperHost } from '../host.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let child, host, root, url;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-'));
  const token = crypto.randomBytes(32).toString('base64url'), port = 20000 + crypto.randomInt(20000);
  child = spawn(process.execPath, [path.join(HERE, '..', '..', 'hub', 'keeper.mjs')], { stdio: 'ignore',
    env: { ...process.env, OPENHOUSE_KEEPER_TOKEN: token, KEEPER_PORT: String(port), OPENHOUSE_DATA: path.join(root, 'data'), OPENHOUSE_KEEPER_DIR: path.join(root, 'keeper'), OPENHOUSE_KEEPER_STORE: 'file', BRIDGE_URL: 'http://127.0.0.1:9' } });
  url = `http://127.0.0.1:${port}`;
  host = await keeperHost({ url, token }).ready();
});
after(() => { child?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

test('the keeper says what it can do, and refuses another token', async () => {
  assert.ok(host.can('cards') && host.can('approve'));
  assert.ok(!host.can('screen') && !host.can('bluetooth'));
  assert.equal((await host.call('/camera', {})).ok, false);
  assert.equal((await keeperHost({ url, token: 'x'.repeat(43) }).call('/status')).status, 403);
});

test('the setup chooses the PIN once; a card that needs it takes a yes only with it', async () => {
  assert.equal((await host.call('/setup/pin', { pin: '4826' })).ok, true);
  assert.equal((await host.call('/setup/pin', { pin: '1111' })).status, 409); // (never replaced from the setup)
  const waiting = host.call('/approve', { title: 'Put it in?', grownup: true, waitMs: 10e3 });
  let cards = [];
  for (let i = 0; i < 20 && !cards.length; i++) { cards = (await host.call('/cards')).body.cards; if (!cards.length) await new Promise((ok) => setTimeout(ok, 50)); }
  assert.equal(cards[0].pin, true);
  assert.equal((await host.call('/cards/answer', { id: cards[0].id, yes: true, pin: '1111' })).ok, false);
  assert.equal((await host.call('/cards')).body.cards.length, 1); // still waiting
  assert.equal((await host.call('/cards/answer', { id: cards[0].id, yes: true, pin: '4826' })).ok, true);
  assert.deepEqual((await waiting).body, { yes: true, answered: true });
});
