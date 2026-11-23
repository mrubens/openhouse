// The live voice gets only the household's quick tools, never ones that change the tablet (live-tools.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveToolRoutes, LIVE_TOOLS } from '../live-tools.js';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const calls = [];
const door = {
  tools: () => [{ name: 'change_list', description: 'Lists', inputSchema: { type: 'object', properties: { list: { type: 'string' } } } }, { name: 'set_home', description: 'Home', inputSchema: {} }, { name: 'calendar_event', description: 'Calendar', inputSchema: { type: 'object' } }],
  call: async (name, a, ctx) => { calls.push({ name, a, ctx }); return { content: [{ type: 'text', text: `Added ${a.item || '?'}.` }] }; },
};
const weather = { current: async () => ({ place: 'Springfield', temp: 56, condition: 'Clear', hours: Array(24).fill({ t: 1 }), days: [] }) };
const res = () => ({ code: 0, obj: null });
const json = (r, code, obj) => { r.code = code; r.obj = obj; };

test('only the household tools, never ones that change the tablet', async () => {
  const live = liveToolRoutes({ HERE, door, weather, prefsBlock: () => '\nPREFS: short answers', assistantName: () => 'Hazel', json, body: async (r) => r.b });
  const r = res(); assert.ok(await live({ method: 'GET' }, r, new URL('http://x/live/setup')));
  for (const t of ['set_home', 'start_editing', 'write_file', 'device_action']) assert.ok(!r.obj.tools.some((x) => x.name === t), t);
  assert.ok(!LIVE_TOOLS.includes('set_home') && !LIVE_TOOLS.includes('start_editing'));
  const t1 = res(); await live({ method: 'POST', b: { name: 'set_home', args: {} } }, t1, new URL('http://x/live/tool'));
  assert.equal(t1.obj.isError, true); assert.equal(calls.length, 0);
  const t2 = res(); await live({ method: 'POST', b: { name: 'change_list', args: { item: 'milk' } } }, t2, new URL('http://x/live/tool'));
  assert.ok(!t2.obj.isError); assert.equal(calls[0].ctx.conversation, 'live');
});
