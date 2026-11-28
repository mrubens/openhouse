// Follow-ups for later (later.js, repeat-rule.js) are never lost or said twice: a repeating one comes once a day at
// the same local time across the DST changes, a restart doesn't say it again, COUNT and UNTIL stop it.
//   cd bridge && npm test
process.env.TZ = 'America/Chicago'; // the tablet's zone (set before any date is made)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laterRoutes } from '../later.js';
import { parseRule, nextAfter } from '../repeat-rule.js';
import { liveToolRoutes } from '../live-tools.js';
import { fileURLToPath } from 'node:url';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const local = (s) => new Date(s).getTime();
const stamp = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const MIN = 60e3;

/** A later.js on its own folder, its clock moved by the test; said: [[when, words]]. */
function setup(DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'later-')), 'chats'), at = 0) {
  fs.mkdirSync(DIR, { recursive: true });
  const clock = { t: at }, said = [];
  const l = laterRoutes({ DIR, now: () => clock.t, say: (w) => { said.push([stamp(clock.t), w]); return true; }, every: 0 });
  const add = async (a) => { const r = await l.call('later', { kind: 'say', ...a }); assert.ok(!r.isError, r.content[0].text); };
  /** The bridge's look every `step` from..to (it looks every 20 seconds; 5 minutes is enough here). */
  const run = async (from, to, step = 5 * MIN) => { for (clock.t = from; clock.t <= to; clock.t += step) await l.tick(); };
  return { l, clock, said, add, run, DIR };
}

test('a daily reminder across the fall change: said once each day at 7:30, none skipped or repeated', async () => {
  const s = setup(undefined, local('2026-10-29T20:00'));
  await s.add({ what: 'Shoes on, Maya and Leo.', when: '2026-10-30T07:30', repeat: 'FREQ=DAILY' });
  await s.run(local('2026-10-29T20:00'), local('2026-11-04T09:00'));
  assert.deepEqual(s.said.map(([t]) => t), ['2026-10-30 07:30', '2026-10-31 07:30', '2026-11-01 07:30', '2026-11-02 07:30', '2026-11-03 07:30', '2026-11-04 07:30']);
  assert.equal(s.l.items().length, 1); // still set, for Nov 5
  assert.equal(stamp(s.l.items()[0].at), '2026-11-05 07:30');
});

test('at the hour that happens twice (fall) and the one that never comes (spring), a repeat is said once that day', async () => {
  const fall = setup(undefined, local('2026-10-30T12:00'));
  await fall.add({ what: 'Bins out.', when: '2026-10-31T01:30', repeat: 'FREQ=DAILY' });
  await fall.run(local('2026-10-30T12:00'), local('2026-11-02T12:00'), MIN);
  assert.equal(fall.said.length, 3); // Oct 31, Nov 1 (1:30 twice on the clock), Nov 2
  assert.deepEqual(fall.said.map(([t]) => t.slice(0, 10)), ['2026-10-31', '2026-11-01', '2026-11-02']);
  const spring = setup(undefined, local('2027-03-13T12:00'));
  await spring.add({ what: 'Bins out.', when: '2027-03-14T02:30', repeat: 'FREQ=WEEKLY;BYDAY=SU' });
  await spring.run(local('2027-03-13T12:00'), local('2027-03-22T12:00'), MIN);
  assert.deepEqual(spring.said.map(([t]) => t.slice(0, 10)), ['2027-03-14', '2027-03-21']);
});

test('a restart right after one is said doesn\'t say it again; one missed while off is said once if under an hour late', async () => {
  const a = setup(undefined, local('2026-11-09T07:00'));
  await a.add({ what: 'Lunch boxes.', when: '2026-11-09T07:30', repeat: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' });
  await a.run(local('2026-11-09T07:00'), local('2026-11-09T07:35'));
  assert.equal(a.said.length, 1);
  const b = setup(a.DIR, local('2026-11-09T07:36')); // the bridge starts again from what's on disk
  await b.run(local('2026-11-09T07:36'), local('2026-11-09T08:00'));
  assert.equal(b.said.length, 0);
  // Off from 7 to 8:40 Tuesday: over an hour late, dropped (that day only); off until 7:50 Wednesday: said then, once.
  const c = setup(a.DIR, local('2026-11-10T08:40'));
  await c.run(local('2026-11-10T08:40'), local('2026-11-10T09:00'));
  assert.equal(c.said.length, 0);
  const d = setup(a.DIR, local('2026-11-11T07:50'));
  await d.run(local('2026-11-11T07:50'), local('2026-11-11T09:00'));
  assert.deepEqual(d.said.map(([t]) => t), ['2026-11-11 07:50']);
  assert.equal(stamp(d.l.items()[0].at), '2026-11-12 07:30');
});

test('COUNT and UNTIL end a repeat: said that many times, through that day, then gone', async () => {
  const s = setup(undefined, local('2026-11-02T08:00'));
  await s.add({ what: 'Vitamins, Alex.', when: '2026-11-02T09:00', repeat: 'FREQ=DAILY;COUNT=3' });
  await s.add({ what: 'Library books, Sam.', when: '2026-11-02T18:00', repeat: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116' });
  await s.run(local('2026-11-02T08:00'), local('2026-11-30T20:00'), 15 * MIN);
  assert.deepEqual(s.said.filter(([, w]) => /Vitamins/.test(w)).map(([t]) => t), ['2026-11-02 09:00', '2026-11-03 09:00', '2026-11-04 09:00']);
  assert.deepEqual(s.said.filter(([, w]) => /Library/.test(w)).map(([t]) => t), ['2026-11-02 18:00', '2026-11-09 18:00', '2026-11-16 18:00']);
  assert.equal(s.l.items().length, 0);
});

test('every other hour by the clock across the fall change: each hour once, none twice', () => {
  const r = parseRule('FREQ=HOURLY;INTERVAL=2;BYHOUR=0,2,4,6,8');
  const out = []; let t = local('2026-10-31T23:00');
  for (let i = 0; i < 6; i++) { t = nextAfter(r, local('2026-10-31T00:00'), t); out.push(stamp(t)); }
  assert.deepEqual(out, ['2026-11-01 00:00', '2026-11-01 02:00', '2026-11-01 04:00', '2026-11-01 06:00', '2026-11-01 08:00', '2026-11-02 00:00']);
});

// A "do" run nobody is at (later.js doIt) gets only the household's things and looking up (live-tools.js
// UNATTENDED_TOOLS), through the voice's own tools: never making apps, the device or settings; message_family only
// when the one who set it asked for a message. And a repeat comes at most once an hour.
test('a run nobody is at: few tools, a message only when asked for, and at most once an hour', async () => {
  const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
  const homeScreen = { tools: () => ['change_list', 'set_home', 'heartbeat_settings', 'house_rules', 'undo_change', 'add_plugin', 'later'].map(tool), call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
  const live = liveToolRoutes({ HERE, homeScreen, weather: { current: async () => ({}) }, json: () => {}, body: async () => ({}), household: { read: () => ({ family: [{ name: 'Sam' }] }) } });
  const built = [];
  live.setBuild(async (text) => { built.push(text); return { ok: true }; });
  live.setTv({ volume: async () => ({ ok: true, text: 'ok' }) });
  live.setPhones({ phones: () => [], message: async () => ({ sent: [] }) });
  const offered = [];
  const ai = async ({ tools, input }) => {
    if (input.length === 1) { offered.push(tools.map((t) => t.name)); return { output: [{ type: 'function_call', name: 'make_app', call_id: 'c1', arguments: '{"what":"a game"}' }] }; }
    return { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] };
  };
  const DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'later-')), 'chats'); fs.mkdirSync(DIR, { recursive: true });
  const clock = { t: local('2026-12-01T08:00') };
  const l = laterRoutes({ DIR, now: () => clock.t, ai, live, every: 0 });
  assert.equal((await l.call('later', { kind: 'say', what: 'Water', when: '09:00', repeat: 'FREQ=HOURLY;BYMINUTE=0,30' })).isError, true, 'every half hour is too often');
  for (const a of [{ what: 'Check the weather' }, { what: 'Check the weather and text Sam', message: true }]) assert.ok(!(await l.call('later', { kind: 'do', when: '09:00', ...a })).isError);
  clock.t = local('2026-12-01T09:00'); await l.tick();
  assert.equal(offered.length, 2);
  for (const names of offered) for (const t of ['make_app', 'volume', 'set_home', 'heartbeat_settings', 'house_rules', 'undo_change', 'add_plugin', 'later']) assert.ok(!names.includes(t), t);
  assert.ok(offered.every((n) => n.includes('change_list')));
  assert.deepEqual(offered.map((n) => n.includes('message_family')), [false, true]);
  assert.deepEqual(built, [], 'make_app called anyway is refused');
});
