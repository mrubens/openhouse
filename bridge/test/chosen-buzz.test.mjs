// The buzzes a phone chooses (chosen-buzz.js): never at night, never to someone it isn't for (nor to whoever did it
// themselves), never a stream; and a phone gets a kind only when that phone has it on (screens.notify).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chosenBuzz, GAP } from '../chosen-buzz.js';
import { screensRoutes } from '../screens.js';

const FAMILY = [{ name: 'Sam', kind: 'adult' }, { name: 'Alex', kind: 'adult' }, { name: 'Maya', kind: 'kid' }, { name: 'Leo', kind: 'kid' }];
const at = (hhmm, day = '2026-12-01') => new Date(`${day}T${hhmm}:00`).getTime();
const rig = (due = () => []) => {
  let t = at('12:00');
  const sent = [];
  const b = chosenBuzz({ notify: async (p, m, kind) => { sent.push({ p, kind, ...m }); return 1; }, family: () => FAMILY, night: () => ({ from: '21:30', to: '06:30' }), choresDue: (x) => due(x), now: () => t });
  return { b, sent, set: (x) => { t = x; } };
};
const ev = (title, who, also = []) => ({ event: { title, start: '2026-12-03T16:00', who, also } });

test('only the people it is for, and not whoever did it', async () => {
  const { b, sent } = rig();
  b.noticed('added', { ...ev('Dentist', 'Maya', ['Sam']), by: 'Sam' });
  b.noticed('added', { ...ev('Piano', 'Leo'), by: 'Leo' }); // their own
  b.noticed('added', ev('Picnic', null)); // nobody's
  b.noticed('choreDone', { who: 'Maya', task: 'Feed the cat', by: 'Alex' });
  b.noticed('choreDone', { who: 'Sam', task: 'Dishes', by: null }); // an adult's: no one is told
  await b.tick();
  assert.deepEqual(sent.map((x) => `${x.p}:${x.kind}`).sort(), ['Maya:events', 'Sam:kidsDone']);
});

test('nothing in the night hours; a new event waits for the morning, the rest are dropped', async () => {
  let due = [];
  const { b, sent, set } = rig(() => due);
  set(at('23:10'));
  b.noticed('added', ev('Swim meet', 'Maya'));
  b.noticed('choreDone', { who: 'Leo', task: 'Set the table' });
  due = [{ key: 'due|leo|x', who: 'Leo', task: 'Make bed' }];
  await b.tick();
  set(at('03:00', '2026-12-02')); await b.tick();
  assert.equal(sent.length, 0);
  due = [];
  set(at('07:00', '2026-12-02')); await b.tick();
  assert.deepEqual(sent.map((x) => `${x.p}:${x.kind}`), ['Maya:events']);
});

test('at most one buzz per person and kind in a while: what comes between is gathered into the next', async () => {
  const { b, sent, set } = rig();
  b.noticed('added', ev('Dentist', 'Maya')); await b.tick();
  b.noticed('added', ev('Piano', 'Maya')); b.noticed('added', ev('Swim', 'Maya')); await b.tick();
  assert.equal(sent.length, 1);
  set(at('12:00') + GAP); await b.tick();
  assert.equal(sent.length, 2);
  assert.ok(sent[1].body.includes('Piano') && sent[1].body.includes('Swim'));
});

test('a phone gets a chosen buzz only when it has that kind on; a kid\'s phone never gets other kids\' chores', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-buzz-')), FILE = path.join(dir, 'screens.json');
  const key = () => crypto.randomBytes(32).toString('base64url'), token = (c) => c.repeat(64);
  const phone = (id, person, scopes) => ({ id, kind: 'phone', person, key: key(), scopes, apns: { token: token(id.slice(-1)), env: 'production' } });
  const adult = ['door', 'arrange', 'ask', 'notify', 'voice'], kid = ['door', 'arrange', 'notify'];
  fs.writeFileSync(FILE, JSON.stringify({ lan: true, screens: [phone('s-a', 'Sam', adult), phone('s-b', 'Sam', adult), phone('s-c', 'Maya', kid)] }));
  const sent = [], out = {};
  let posted = {};
  const s = screensRoutes({ HERE: dir, FILE, PORT: 20000 + crypto.randomInt(20000), HOST: '127.0.0.1', json: (res, code, obj) => Object.assign(out, { code, obj }), body: async () => posted, apns: async (x) => { sent.push(x.token); return { ok: true }; } });
  t.after(() => s.stop());
  const ask = async (id, method, b = {}) => { posted = b; await s.phone({ method, headers: { 'x-openhouse-screen': id } }, {}, new URL('http://x/phone/push')); return out.obj; };

  assert.equal((await ask('s-c', 'GET')).buzz.kidsDone, undefined, 'not offered on a kid\'s phone');
  assert.equal((await ask('s-c', 'POST', { buzz: { kidsDone: true } })).buzz.kidsDone, undefined);
  assert.equal(await s.notify('Maya', { title: 'x' }, { kind: 'kidsDone' }), 0);

  assert.equal(await s.notify('Sam', { title: 'x' }, { kind: 'kidsDone' }), 0, 'off until chosen');
  await ask('s-a', 'POST', { buzz: { kidsDone: true, events: false } });
  sent.length = 0;
  assert.equal(await s.notify('Sam', { title: 'x' }, { kind: 'kidsDone' }), 1);
  assert.deepEqual(sent, [token('a')], 'only the phone that chose it');
  sent.length = 0;
  assert.equal(await s.notify('Sam', { title: 'x' }, { kind: 'events' }), 1);
  assert.deepEqual(sent, [token('b')], 'the other phone keeps its own');
  assert.equal(await s.notify('Sam', { title: 'note' }), 2, 'what every phone gets is unchanged');
});
