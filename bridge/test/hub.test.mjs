// The hub (hub.js, docs/hub.md): the bridge with no tablet. The settings device from the code printed at start-up,
// what it may reach (and what nothing else may), and backups to a folder.
//   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../edits.js';
import { pair, client } from '../../chat/src/screen-client.js';
import { pairingFromCode } from '../../chat/src/scrypt.js';
import { allowed, PHONE_SCOPES, DEFAULT_SCOPES, ADMIN_SCOPES } from '../screens.js';
import { folderDestination } from '../folder-backup.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'hub-token', H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };

let child, url, lan, root, out = '';

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-hub-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$|screens\.json$/.test(f) });
  fs.mkdirSync(path.join(root, 'hub')); for (const f of ['keeper.mjs', 's3.mjs']) fs.copyFileSync(path.join(BRIDGE, '../hub', f), path.join(root, 'hub', f)); // (the keeper: the bridge's host here, host.js)
  fs.mkdirSync(path.join(root, 'bridge/public/hub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bridge/public/hub/index.html'), '<!doctype html><title>hub</title>');
  fs.mkdirSync(path.join(root, 'webapp')); initRepo(path.join(root, 'webapp'));
  const [port, lanPort] = [await freePort(), await freePort()];
  child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), SCREENS_PORT: String(lanPort), SCREENS_HOST: '127.0.0.1', AGENT: 'fake', HEARTBEAT: 'off', VOICE_DIR: path.join(root, 'novoice'),
      OPENHOUSE_TOKEN: TOKEN, OPENHOUSE_HOST: 'keeper', OPENHOUSE_BACKUP_DIR: path.join(root, 'backups'), OPENHOUSE_CODE_DIR: root, OPENHOUSE_CLOUD_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  url = `http://127.0.0.1:${port}`; lan = `http://127.0.0.1:${lanPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
});
after(() => { child?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

let admin = null;
test('at start-up with no settings device: a code, printed and in hub-setup.txt, and the home network is on', async () => {
  const m = out.match(/type\s+([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})/);
  assert.ok(m, 'the code is in the log: ' + out.slice(0, 400));
  assert.match(fs.readFileSync(path.join(root, 'hub-setup.txt'), 'utf8'), new RegExp(m[1]));
  assert.equal((await fetch(lan + '/hub/')).status, 200, 'the settings page is served on the home network');
  // Typing it joins at once, as a settings device (there's no screen on the hub to say yes on).
  const w = await pair({ base: lan, ...pairingFromCode(m[1]), name: 'A computer (settings)' });
  assert.deepEqual(w.scopes, ADMIN_SCOPES);
  admin = client({ base: lan, id: w.id, key: w.key });
  // Used once.
  await assert.rejects(pair({ base: lan, ...pairingFromCode(m[1]), name: 'again' }));
});

test('the settings device reaches the hub settings; a plain screen and a phone do not', async () => {
  const s = await admin.json('GET', '/screens');
  assert.equal(s.status, 200);
  assert.ok(s.json.screens.some((x) => x.scopes.includes('admin')));
  assert.equal((await admin.json('GET', '/hub')).json.hub, true);
  assert.equal((await admin.json('GET', '/backup/status')).status, 200);
  assert.equal((await admin.json('GET', '/cloud/status')).json.linked, false);
  for (const [m, p] of [['GET', '/screens'], ['POST', '/screens/pair'], ['POST', '/cloud/link/start'], ['POST', '/cloud/link/confirm'], ['POST', '/backup/restore'], ['POST', '/hub/update'], ['POST', '/relay']]) {
    assert.ok(allowed(ADMIN_SCOPES, m, p), `${m} ${p} for settings`);
    assert.ok(!allowed(DEFAULT_SCOPES, m, p) && !allowed(PHONE_SCOPES.grownup, m, p), `${m} ${p} not for a screen or a phone`);
  }
  // A new code for a settings device only from the hub itself (its console: the bridge's secret).
  assert.ok(!allowed(ADMIN_SCOPES, 'POST', '/hub/owner-code'));
  assert.equal((await admin.json('POST', '/hub/owner-code', {})).status, 403);
});

test('backups to a folder: the same files as a USB drive, kept, listed, restored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-folder-'));
  const d = folderDestination({ dir });
  assert.equal((await d.ready()).ok, true);
  const src = path.join(dir, 'x.backup'); fs.writeFileSync(src, 'sealed');
  for (let i = 0; i < 3; i++) await d.put(src, { kind: 'manual', keyId: '0123456789abcdef', createdAt: `2026-11-2${i}T10:00:00.000Z` });
  await d.put(src, { kind: 'manual', keyId: 'fedcba9876543210', createdAt: '2026-11-01T10:00:00.000Z' }); // another device's, older
  assert.equal((await d.list()).length, 4);
  await d.prune(7, 2, '0123456789abcdef');
  const left = (await d.list()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  assert.equal(left.length, 3);
  assert.ok(left.some((x) => x.keyId === 'fedcba9876543210'), "another key's backup is never pruned");
  await d.get(left[0], path.join(dir, 'back'));
  assert.equal(fs.readFileSync(path.join(dir, 'back'), 'utf8'), 'sealed');
  fs.rmSync(dir, { recursive: true, force: true });
  // And through the bridge: the hub's folder is a destination, and a backup lands there.
  await admin.json('POST', '/backup/dest', { id: 'folder', on: true });
  const now = await admin.json('POST', '/backup/now', {});
  assert.equal(now.status, 200, JSON.stringify(now.json));
  for (let i = 0; i < 100; i++) { if (fs.existsSync(path.join(root, 'backups/Display backups')) && fs.readdirSync(path.join(root, 'backups/Display backups')).some((n) => n.endsWith('.backup'))) break; await wait(100); }
  assert.ok(fs.readdirSync(path.join(root, 'backups/Display backups')).some((n) => /^display-backup-.*-manual-[0-9a-f]{16}\.backup$/.test(n)));
  assert.equal((await fetch(url + '/backup/status', { headers: H }).then((r) => r.json())).dests.find((x) => x.id === 'folder').last.ok, true);
});

test("the setup doesn't end without a PIN", async () => {
  const go = async (step) => (await admin.json('POST', '/setup/go', { step })).json.step;
  assert.equal(await go('pin'), 'pin');
  assert.equal(await go('android'), 'pin', 'past the PIN with none set');
  assert.equal((await admin.json('POST', '/hub/pin', { pin: '2468' })).status, 200);
  assert.equal(await go('android'), null);
});
