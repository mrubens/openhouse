// A note typed for Home (home-note.js): one for later survives a restart, it's read aloud only by the device's own
// voice and never at night, a phone has an hourly limit, and only a phone that may tick things reaches it.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeScreenRoutes } from '../home-screen.js';
import { homeNoteRoutes } from '../home-note.js';
import { allowed, PHONE_SCOPES, TV_SCOPES } from '../screens.js';

const json = (res, code, obj) => { res.code = code; res.body = obj; };
const post = (h, b, screen) => { const res = {}; return h({ method: 'POST', headers: screen ? { 'x-openhouse-screen': screen } : {} }, res, new URL('http://x/home/note')).then(() => res); };

function setup(dir, { clock, said, night = () => false }) {
  const homeScreen = homeScreenRoutes({ DIR: dir, json, body: async () => ({}), APP_DIR: path.join(dir, '..', 'app') });
  let next = {};
  const screens = { who: (id) => ({ 's-sam': { id: 's-sam', kind: 'phone', person: 'Sam', scopes: PHONE_SCOPES.grownup } })[id] || null };
  const notes = homeNoteRoutes({ homeScreen, screens, json, body: async () => next, say: (t) => said.push(t), quiet: (t) => night(t), people: () => ['Sam', 'Alex', 'Maya', 'Leo'], now: () => clock.t, every: 0 });
  homeScreen.typed = notes;
  return { homeScreen, notes, send: (b, screen) => { next = b; return post(notes, b, screen); } };
}

test('a note for later waits through a restart, then goes up and is said in the device\'s own voice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-note-')), chats = path.join(dir, 'chats'); fs.mkdirSync(chats);
  const clock = { t: Date.now() }, said = [];
  const a = setup(chats, { clock, said });
  const r = await a.send({ text: 'Pizza at six', for: 'maya', at: clock.t + 3600e3, aloud: true }, 's-sam');
  assert.equal(r.code, 200); assert.ok(r.body.at);
  assert.equal(a.homeScreen.pending.list().length, 1);

  const b = setup(chats, { clock, said }); // the bridge started again
  assert.equal(b.homeScreen.pending.list().length, 1, 'still waiting after a restart');
  b.notes.tick(); assert.equal(said.length, 0, 'not before its time');
  clock.t += 3601e3; b.notes.tick();
  assert.equal(b.homeScreen.pending.list().length, 0);
  const view = JSON.parse(fs.readFileSync(path.join(chats, 'door.json'), 'utf8'));
  const n = view.notes.find((x) => x.content === 'Pizza at six');
  assert.ok(n, 'up on Home'); assert.equal(n.for, 'Maya'); assert.equal(n.by, 'family');
  assert.equal(said.length, 1, 'said once');
});

test('at night a note goes up but isn\'t said', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-note-')), chats = path.join(dir, 'chats'); fs.mkdirSync(chats);
  const clock = { t: Date.now() }, said = [];
  const { send } = setup(chats, { clock, said, night: () => true });
  assert.equal((await send({ text: 'Back late', aloud: true }, 's-sam')).code, 200);
  assert.equal(said.length, 0);
});

test('a phone has an hourly limit; a kid\'s phone may send one, a TV may not; a name outside the household is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-note-')), chats = path.join(dir, 'chats'); fs.mkdirSync(chats);
  const clock = { t: Date.now() }, said = [];
  const { send } = setup(chats, { clock, said });
  assert.equal((await send({ text: 'hi', for: 'Nobody' }, 's-sam')).code, 400);
  assert.equal((await send({ text: 'x'.repeat(281) }, 's-sam')).code, 400);
  let last; for (let i = 0; i < 25; i++) last = await send({ text: `note ${i}` }, 's-sam');
  assert.equal(last.code, 429);
  assert.equal((await send({ text: 'from the device itself' })).code, 200, 'the display has no limit');
  assert.equal((await send({ text: 'who?' }, 's-gone')).code, 403);
  assert.equal(allowed(PHONE_SCOPES.kid, 'POST', '/home/note'), true);
  assert.equal(allowed(TV_SCOPES, 'POST', '/home/note'), false);
});
