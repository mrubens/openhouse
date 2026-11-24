// The family's things (house.js) through the assistant's tools: rewards need a yes, a locked calendar, and no
// duplicate events. Runs house.js on its own, with a stand-in household, in a temp folder.
//   node --test bridge/test/*.test.mjs   (or: cd bridge && npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { houseRoutes, MAX_VIDEO } from '../house.js';

function house(synced = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-')), DIR = path.join(root, 'x');
  fs.mkdirSync(DIR);
  let chores = [{ who: 'Leo', task: 'Feed the cat' }];
  const board = { householdView: () => ({ family: [{ name: 'Leo' }, { name: 'Maya' }], chores, calendars: [] }), saveHousehold: (b) => { chores = b.chores; }, calendarEvents: () => synced };
  const h = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board });
  const call = async (name, a) => { const r = await h.call(name, a); assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  return { h, call };
}
const day = (plus) => { const d = new Date(); d.setDate(d.getDate() + plus); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('rewards: setting one up needs a yes on the display, and an app can never say yes to one', async () => {
  const http = await import('node:http');
  let answer = { yes: false }; const asked = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { asked.push(JSON.parse(b || '{}')); res.end(JSON.stringify(answer)); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-')), 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { device: { url: `http://127.0.0.1:${srv.address().port}/mcp`, headers: { Authorization: 'Bearer t' } } } }));
  const was = process.env.DEVICE_MCP_CONFIG; process.env.DEVICE_MCP_CONFIG = cfg;
  try {
    const { call } = house();
    const wait = () => new Promise((r) => setTimeout(r, 150));
    await call('change_rewards', { add: [{ title: 'Ice cream', stars: 1 }] }); await wait();
    assert.equal(asked.at(-1).pin, true);
    assert.equal((await call('family_things', {})).rewards.length, 0, 'a no on the card: not added');
    answer = { yes: true };
    await call('change_rewards', { add: [{ title: 'Movie night', stars: 1 }] }); await wait();
    const v = await call('family_things', {});
    assert.equal(v.rewards[0].title, 'Movie night');
  } finally { srv.close(); process.env.DEVICE_MCP_CONFIG = was; }
});

test('a locked calendar: apps change it only for a little while after the PIN on the display', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-')), DIR = path.join(root, 'x'); fs.mkdirSync(DIR);
  const board = { householdView: () => ({ family: [], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => [] };
  let out = null, next = {};
  const h = houseRoutes({ DIR, json: (res, code, obj) => { out = { code, obj }; }, body: async () => next, board });
  const post = async (p, b, app = false) => { next = b; out = null; await h({ method: 'POST', headers: app ? { 'x-openhouse-app': 'calendar' } : {} }, {}, new URL('http://x' + p)); return out; };
  const add = { add: { title: 'Game', start: '2026-12-01T10:00' } };
  assert.equal((await post('/house/event', add, true)).code, 200, 'no lock: fine');
  assert.equal((await post('/house/lock', { calendar: true }, true)).code, 403, 'an app can\'t lock or unlock');
  assert.equal((await post('/house/lock', { calendar: true })).code, 200);
  const r = await post('/house/event', add, true);
  assert.equal(r.code, 403); assert.equal(r.obj.locked, true);
  await post('/house/unlock', {});
  assert.equal((await post('/house/event', add, true)).code, 200, 'unlocked for a while');
  assert.equal((await post('/house/event', add)).code, 200, 'the display itself is never locked out');
});

test('Opie and a locked calendar: it asks, and only the PIN typed on the tablet lets the change in', async () => {
  const http = await import('node:http');
  let answer = { yes: false }; const asked = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { asked.push(JSON.parse(b || '{}')); res.end(JSON.stringify(answer)); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-')), 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { device: { url: `http://127.0.0.1:${srv.address().port}/mcp`, headers: { Authorization: 'Bearer t' } } } }));
  const was = process.env.DEVICE_MCP_CONFIG; process.env.DEVICE_MCP_CONFIG = cfg;
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-')), DIR = path.join(root, 'x'); fs.mkdirSync(DIR);
    let chores = [];
    const board = { householdView: () => ({ family: [{ name: 'Leo' }], chores, calendars: [] }), saveHousehold: (b) => { if (b.chores) chores = b.chores; }, calendarEvents: () => [] };
    let next = {};
    const h = houseRoutes({ DIR, json: () => {}, body: async () => next, board });
    next = { calendar: true }; await h({ method: 'POST', headers: {} }, {}, new URL('http://x/house/lock'));
    const opie = { by: 'assistant', who: null, conversation: 'live' };
    const events = async () => JSON.parse((await h.call('family_things', {})).content[0].text).events.length;
    // Opie's own words can't be the yes: the card (pin: true) is the only way in, and a no leaves the calendar as it was.
    const no = await h.call('calendar_event', { add: { title: 'Dentist', start: '2026-12-02T09:00' }, yes: true, pin: '1234' }, opie);
    assert.equal(no.isError, true); assert.equal(asked.length, 1); assert.equal(asked[0].pin, true);
    assert.equal(await events(), 0);
    // No card on the tablet (the shell not answering): never falls through to the change.
    process.env.DEVICE_MCP_CONFIG = path.join(root, 'none.json');
    assert.equal((await h.call('calendar_event', { remove: ['x'] }, opie)).isError, true);
    process.env.DEVICE_MCP_CONFIG = cfg;
    answer = { yes: true };
    assert.ok(!(await h.call('calendar_event', { add: { title: 'Dentist', start: '2026-12-02T09:00' } }, opie)).isError);
    assert.equal(await events(), 1);
    // A reward needs a grown-up's yes on the card too: a no gives nothing.
    await h.call('change_rewards', { add: [{ title: 'Ice cream', stars: 1 }] }, opie); await new Promise((ok) => setTimeout(ok, 150));
    await h.call('change_chores', { add: [{ who: 'Leo', task: 'Feed the cat' }] }, opie);
    await h.call('change_chores', { done: [{ who: 'Leo', task: 'Feed the cat' }] }, opie);
    const starsNow = async () => JSON.stringify(JSON.parse((await h.call('family_things', {})).content[0].text).stars);
    const before = await starsNow();
    answer = { yes: false }; const n = asked.length;
    const r = await h.call('change_rewards', { redeem: { who: 'Leo', reward: 'Ice cream' } }, opie);
    assert.equal(r.isError, true, r.content[0].text);
    assert.equal(asked.length, n + 1, r.content[0].text); assert.equal(asked.at(-1).pin, true);
    assert.equal(await starsNow(), before, 'no stars spent');
  } finally { srv.close(); process.env.DEVICE_MCP_CONFIG = was; }
});

test('the calendar: adding the same event again gives the one already there, and a list of ids is removed in one go', async () => {
  const { h, call } = house();
  const t = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const a = await call('calendar_event', { add: { title: 'Take Dolly to daycare', start: `${t}T12:30` } });
  const b = await call('calendar_event', { add: { title: 'take dolly to daycare', start: `${t}T12:30` } });
  assert.equal(b.already, true); assert.equal(b.event.id, a.event.id);
  const c = await call('calendar_event', { add: { title: 'Take Dolly to daycare', start: `${t}T15:00` } });
  const d = await call('calendar_event', { add: { title: 'Dentist', start: `${t}T09:00` } });
  const r = await call('calendar_event', { remove: [a.event.id, c.event.id, 'e-nope'] });
  assert.deepEqual(r.removed, [a.event.id, c.event.id]); assert.deepEqual(r.notFound, ['e-nope']);
  const left = (await call('family_things', {})).events?.map((e) => e.id) ?? JSON.stringify(await call('family_things', {}));
  assert.ok(JSON.stringify(left).includes(d.event.id) && !JSON.stringify(left).includes(a.event.id));
  const one = await call('calendar_event', { remove: d.event.id }); // a single id still works
  assert.deepEqual(one.removed, [d.event.id]);
});

test('the same event added again is changed, not added twice', async () => {
  const { h, call } = house();
  const a = await call('calendar_event', { add: { title: 'Take Dolly to daycare', start: `${day(0)}T12:30` } });
  const b = await call('calendar_event', { add: { title: 'take dolly to daycare', start: `${day(0)}T12:32`, who: 'Sam' } });
  assert.equal(b.event.id, a.event.id); assert.equal(b.already, true); assert.equal(b.event.who, 'Sam');
  assert.equal(h.localEvents().filter((e) => /dolly/i.test(e.title)).length, 1);
  await call('calendar_event', { add: { title: 'Take Dolly to daycare', start: `${day(0)}T16:30` } }); // (later that day: a second trip)
  assert.equal(h.localEvents().filter((e) => /dolly/i.test(e.title)).length, 2);
});

test('the calendar: a call with every part filled in (blank add, real remove) removes, and adds nothing', async () => {
  const { h, call } = house();
  const a = await call('calendar_event', { add: { title: 'Take Dolly to daycare', start: `${day(1)}T12:30` } });
  const b = await call('calendar_event', { add: { title: 'Dentist', start: `${day(2)}T09:00` } });
  const before = h.localEvents().length;
  const r = await call('calendar_event', { add: { title: 'x', start: `${day(3)}`, allDay: true, repeat: 'daily' }, update: { id: '' }, remove: [a.event.id] });
  assert.deepEqual(r.removed, [a.event.id]);
  assert.ok(!h.localEvents().some((e) => e.title === 'x'), 'nothing added');
  assert.ok(h.localEvents().some((e) => e.id === b.event.id));
  const r2 = await h.call('calendar_event', { add: { title: '', start: '', repeat: 'daily' }, update: { id: '' }, remove: [] });
  assert.ok(r2.isError, 'a call with nothing real in it is refused, not an empty event');
  assert.equal(h.localEvents().length, before - 1);
});

test('videos: one over the size cap is refused and nothing there is lost; one sent in parts arrives whole or not at all', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-')), DIR = path.join(root, 'x'), PHOTOS = path.join(root, 'photos');
  fs.mkdirSync(DIR);
  let last = null;
  const board = { householdView: () => ({ family: [], chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => [] };
  const h = houseRoutes({ DIR, json: (res, code, obj) => { last = { code, obj }; }, body: async () => ({}), board });
  const ftyp = (n, brand = 'isom') => { const b = Buffer.alloc(n); b.write('\0\0\0\x18ftyp' + brand, 'latin1'); return b; };
  const kept = h.addPhoto(ftyp(4000), 'clip.mp4');
  assert.ok(kept && fs.existsSync(path.join(PHOTOS, kept)));
  assert.equal(h.addPhoto(ftyp(MAX_VIDEO + 1), 'long.mov'), null, 'too big: not kept');
  assert.deepEqual(fs.readdirSync(PHOTOS).filter((n) => !n.startsWith('.')), [kept], 'and nothing else gone or half there');
  assert.match(h.addPhoto(ftyp(3000, 'qt  '), 'phone.jpg'), /\.mov$/, 'a video sent as phone.jpg is kept as a video');

  const part = async (q, bytes) => {
    const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield bytes; } };
    assert.ok(await h(req, {}, new URL('http://x/house/photo/part?' + new URLSearchParams(q))));
    return last;
  };
  const whole = ftyp(9000); whole.fill(7, 20);
  const before = fs.readdirSync(PHOTOS).length;
  assert.equal((await part({ id: 'abcdefgh1', n: 0, of: 3, name: 'party.mov' }, whole.subarray(0, 4000))).code, 200);
  assert.equal((await part({ id: 'abcdefgh1', n: 2, of: 3 }, whole.subarray(8000))).code, 409, 'out of order');
  assert.equal(fs.readdirSync(PHOTOS).length, before + 1, 'nothing shows until the last part (only the incoming folder)');
  assert.equal((await part({ id: 'abcdefgh1', n: 1, of: 3 }, whole.subarray(4000, 8000))).code, 200);
  const done = await part({ id: 'abcdefgh1', n: 2, of: 3, name: 'party.mov' }, whole.subarray(8000));
  assert.equal(done.code, 200);
  assert.deepEqual(fs.readFileSync(path.join(PHOTOS, done.obj.name)), whole, 'whole, byte for byte');
  assert.equal((await part({ id: 'zzzzzzzz2', n: 0, of: 2 }, Buffer.from('not a video at all'))).code, 400);
});
