// The builder as the bridge builds it (builderRoutes), not its parts: a yes on a made app reaches the registry. The
// parts' own tests (rails.test.mjs) build buildWaits themselves, so a slip in how builderRoutes wires it went unseen.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepo, editLock } from '../edits.js';
import { builderRoutes } from '../builder.js';

test("builderRoutes hands its grant to the build waits: keeping a limited app grants what its card named", () => {
  const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-wiring-')); initRepo(APP_DIR);
  const edits = editLock({ APP_DIR, UNDO_FILE: path.join(APP_DIR, '../undo-' + path.basename(APP_DIR) + '.json'), log: () => {} });
  const granted = [];
  const b = builderRoutes({ HERE: APP_DIR, APP_DIR, agentName: () => 'test', currentAgent: async () => ({}), edits,
    events: { emit: () => {}, setState: () => {}, state: { state: 'idle' } }, json: () => {},
    grant: (c) => granted.push(c), WAITS_FILE: path.join(APP_DIR, '../waits-' + path.basename(APP_DIR) + '.json') });
  assert.equal(b.waits.keep({ app: 'dino', limited: true, uses: ['lists'], reaches: ['example.com'] }), 'yes');
  assert.deepEqual(granted.map((c) => [c.app, c.uses, c.reaches]), [['dino', ['lists'], ['example.com']]]);
});

// A change made by the builder, through builderRoutes' own request (the voice's make_app, a typed one, a "later" run):
// to one of the household's own apps (every right) it never goes in unasked; from a run nobody is at it waits on Home.
async function made({ card, unattended = false, keepPin = false }) {
  const APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-made-')); initRepo(APP_DIR);
  fs.mkdirSync(path.join(APP_DIR, 'apps/chores')); fs.writeFileSync(path.join(APP_DIR, 'apps/chores/index.html'), '<p>Chores</p>');
  const edits = editLock({ APP_DIR, UNDO_FILE: path.join(APP_DIR, '../undo-' + path.basename(APP_DIR) + '.json'), log: () => {} });
  edits.git('add', '-A'); edits.git('commit', '-qm', 'chores');
  const head = edits.git('rev-parse', 'HEAD');
  const asked = [];
  let done; const finished = new Promise((r) => { done = r; });
  const state = { state: 'idle' };
  const b = builderRoutes({ HERE: APP_DIR, APP_DIR, agentName: () => 'fake', edits, json: () => {},
    currentAgent: async () => ({ run: async () => { fs.writeFileSync(path.join(APP_DIR, 'apps/chores/index.html'), '<p style="font-size:2em">Chores</p>'); return { ok: true, checked: true, text: 'Bigger.', card }; } }),
    events: { emit: (e) => { if (e.type === 'done') done(e); }, setState: (s) => Object.assign(state, s), state },
    ask: async (c) => { asked.push(c); return 'later'; }, keepPin: async () => keepPin,
    WAITS_FILE: path.join(APP_DIR, '../waits-' + path.basename(APP_DIR) + '.json') });
  assert.equal((await b.request('make the text on Chores bigger', null, unattended ? { unattended: true } : {})).ok, true);
  await finished;
  const r = { asked, committed: edits.git('rev-parse', 'HEAD') !== head, waiting: b.waits.waiting().map((w) => w.app) };
  b.waits.stop?.();
  return r;
}

test("a change to one of the household's own apps opens with its bar, even when it asks for nothing new", async () => {
  const r = await made({ card: { app: 'chores', name: 'Chores', limited: false, uses: [], reaches: [] } });
  assert.equal(r.asked.length, 1, 'the bar was put up');
  assert.equal(r.committed, false, 'nothing went in without a Keep it');
});

test('from a run nobody is at, a change that needs a yes waits on Home and never puts a bar up', async () => {
  const r = await made({ card: { app: 'chores', name: 'Chores', limited: false, uses: [], reaches: [] }, unattended: true });
  assert.deepEqual([r.asked.length, r.committed, r.waiting], [0, false, ['chores']]);
});

test('a limited app asking for nothing new still goes in quietly', async () => {
  const r = await made({ card: { app: 'chores', name: 'Chores', limited: true, uses: [], reaches: [] }, unattended: true });
  assert.deepEqual([r.asked.length, r.committed], [0, true]);
});
