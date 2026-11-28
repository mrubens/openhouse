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
