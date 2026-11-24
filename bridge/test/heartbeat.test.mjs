// What a background heartbeat run may do at each level (heartbeat.js; home-screen.js refuses the rest).
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsFor } from '../heartbeat.js';

test('a background run has no device tools at any level, and Notice only can\'t take things down', () => {
  for (const l of ['notice', 'tidy', 'fix']) for (const t of ['open_app', 'device_action', 'set_home', 'change_list', 'calendar_event']) assert.ok(!toolsFor(l).has(t), `${l} ${t}`);
  assert.ok(!toolsFor('notice').has('take_down_thing'));
  for (const l of ['notice', 'tidy', 'fix']) for (const t of ['put_note', 'update_note', 'take_down_note']) assert.ok(!toolsFor(l).has(t), `no notes: ${l} ${t}`);
});
