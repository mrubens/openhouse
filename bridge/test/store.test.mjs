// Household data safety: a save cut off midway, or a store file left unreadable, never loses what was there
// (store.js, which every whole-file store goes through).
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from '../store.js';
import { boardRoutes } from '../board.js';
import { houseRoutes } from '../house.js';
import { execFileSync } from 'node:child_process';
import { registered, STORES, backedUp } from '../stores.js';
import { INCLUDE, pack } from '../backup-format.js';
import { laterRoutes } from '../later.js';
import { homeScreenRoutes } from '../home-screen.js';
import { dayNotes } from '../day-notes.js';

const family = [{ name: 'Sam' }, { name: 'Alex' }, { name: 'Maya' }, { name: 'Leo' }];
const names = (h) => (h.family || []).map((f) => f.name);
const halve = (f) => { const t = fs.readFileSync(f); fs.writeFileSync(f, t.subarray(0, Math.floor(t.length / 2))); };

test('a cut-off save or an unreadable store keeps the previous contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-')), DIR = path.join(root, 'chats');
  fs.mkdirSync(DIR);
  const errors = console.error; console.error = () => {};
  try {
    // A save that dies partway through writing (a kill, a power cut): the file is still the previous version.
    const f = path.join(root, 'later.json');
    writeJson(f, { items: [1] }); writeJson(f, { items: [1, 2] });
    const write = fs.writeSync;
    fs.writeSync = (fd, text) => { write(fd, String(text).slice(0, 5)); throw new Error('power cut'); };
    try { assert.throws(() => writeJson(f, { items: [] })); } finally { fs.writeSync = write; }
    assert.deepEqual(readJson(f, null), { items: [1, 2] });

    // household.json cut in half (as a save before this one could leave it): read as the previous version, and a
    // change saved over it keeps the family; the unreadable file is set aside, not written over.
    const board = boardRoutes({ HERE: root, DIR, WORK: root, json: () => {}, body: async () => ({}), homeScreen: { migrate: () => {} } });
    board.saveHousehold({ family, location: 'Springfield' }, { quiet: true });
    board.saveHousehold({ chores: [] }, { quiet: true }); // (the version before this one is kept as the .bak)
    const HOUSE = path.join(root, 'household.json');
    halve(HOUSE);
    assert.deepEqual(names(board.householdView()), names({ family }));
    const saved = board.saveHousehold({ chores: [{ who: 'Leo', task: 'Feed the cat' }] }, { quiet: true });
    assert.deepEqual(names(saved), names({ family }));
    assert.equal(saved.location, 'Springfield');
    assert.ok(fs.readdirSync(root).some((n) => n.startsWith('household.json.damaged-')), 'the unreadable file is kept');
    board.sync.stop?.();

    // house.json (lists, chores done, meals, photos): unreadable at start, the bridge comes back with what it had.
    const stub = { householdView: () => ({ family, chores: [], calendars: [] }), saveHousehold: () => {}, calendarEvents: () => [] };
    const one = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board: stub });
    assert.ok(!(await one.call('change_list', { list: 'Groceries', add: ['milk'] })).isError);
    assert.ok(!(await one.call('change_list', { list: 'Groceries', add: ['eggs'] })).isError);
    halve(path.join(root, 'house.json'));
    const two = houseRoutes({ DIR, json: () => {}, body: async () => ({}), board: stub });
    const items = (await two.call('family_things', {})).content[0].text.toLowerCase();
    assert.ok(items.includes('milk'), 'the list came back');
  } finally {
    console.error = errors;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a short write (a full disk) leaves the file and its .bak as they were', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-short-')), f = path.join(root, 'later.json');
  const errors = console.error; console.error = () => {};
  const write = fs.writeSync;
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  try {
    writeJson(f, { items: [1] }); writeJson(f, { items: [1, 2] }); // (.bak: the first)
    // The disk fills partway: writeSync writes some of what it's given, then nothing, without throwing.
    let calls = 0;
    fs.writeSync = (fd, buf, off = 0, len = buf.length - off) => (calls++ ? 0 : write(fd, buf, off, Math.max(1, len >> 1)));
    try { assert.throws(() => writeJson(f, { items: [1, 2, 3] })); } finally { fs.writeSync = write; }
    assert.deepEqual(read(f), { items: [1, 2] });
    assert.deepEqual(read(f + '.bak'), { items: [1] });
    assert.ok(!fs.existsSync(f + '.tmp'));

    // Only the .bak's copy runs short: the save goes in, and the .bak is still a whole earlier version.
    let n = 0;
    fs.writeSync = (fd, buf, off = 0, len = buf.length - off) => (n++ === 0 ? write(fd, buf, off, len) : 0);
    try { writeJson(f, { items: [1, 2, 3] }); } finally { fs.writeSync = write; }
    assert.deepEqual(read(f), { items: [1, 2, 3] });
    assert.deepEqual(read(f + '.bak'), { items: [1] });
    assert.ok(!fs.existsSync(f + '.bak.tmp'));
  } finally { fs.writeSync = write; console.error = errors; fs.rmSync(root, { recursive: true, force: true }); }
});

test('a store saved by a newer release is never saved over by this one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-v-')), DIR = path.join(root, 'chats');
  fs.mkdirSync(DIR);
  const errors = console.error; console.error = () => {};
  try {
    // later.json as a later release left it (its version past what this code knows), then the tablet went back.
    const f = path.join(root, 'later.json');
    const newer = JSON.stringify({ $v: 999, items: [{ id: 'a', text: 'Call Alex', newShape: { at: 1 } }] });
    fs.writeFileSync(f, newer);
    assert.equal(readJson(registered('later', f), {}).items[0].text, 'Call Alex', 'read best-effort');
    assert.ok(!('$v' in readJson(f, {})), 'readers never see the stamp');
    assert.throws(() => writeJson(f, { items: [] }), (e) => e.code === 'newer');
    // The store's own code saving (it keeps going on what it holds in memory): the file stays as the newer one left it.
    // What wasn't saved is said to fail (never "Set"), and isn't held in memory either (it would be gone at a restart).
    const later = laterRoutes({ DIR, every: 0 });
    const r = await later.call('later', { kind: 'say', what: 'Feed the cat, Leo.', in_minutes: 60 });
    assert.equal(r.isError, true);
    assert.equal(later.items().length, 0);
    assert.equal(fs.readFileSync(f, 'utf8'), newer);
    assert.ok(!fs.existsSync(f + '.bak'));
    // house.json the same: a tap on a list (POST /house/list) and Opie's change_list both fail, and the list stays as it was.
    const hf = path.join(root, 'house.json'), houseNewer = JSON.stringify({ $v: 999, lists: [{ id: 'groceries', name: 'Groceries', items: [{ id: 'i1', text: 'Milk' }] }] });
    fs.writeFileSync(hf, houseNewer);
    let out = null;
    const board = { householdView: () => ({ family, chores: [], calendars: [] }), calendarEvents: () => [] };
    const h = houseRoutes({ DIR, json: (res, code, obj) => { out = { code, obj }; }, body: async () => ({ list: 'groceries', add: ['Eggs'] }), board });
    await h({ method: 'POST', headers: {} }, {}, new URL('http://x/house/list'));
    assert.ok(out.code >= 400, `a tap is told it failed (${out.code})`);
    const t = await h.call('change_list', { list: 'groceries', add: ['Bread'] });
    assert.equal(t.isError, true);
    assert.deepEqual(h.view().lists.find((l) => l.id === 'groceries').items.map((i) => i.text), ['Milk']);
    assert.equal(fs.readFileSync(hf, 'utf8'), houseNewer);
    // An unstamped file (every file before versions) is version 0: read and saved as before.
    const g = registered('things', path.join(root, 'things.json'));
    fs.writeFileSync(g, JSON.stringify({ items: [{ id: 1 }] }));
    writeJson(g, { ...readJson(g, {}), more: true });
    assert.deepEqual(readJson(g, {}), { items: [{ id: 1 }], more: true });
  } finally {
    console.error = errors;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the home screen and the apps\' calendar notes: a refused save is said to fail and nothing of it is kept, and start-up goes on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-r-')), DIR = path.join(root, 'chats');
  fs.mkdirSync(DIR);
  const errors = console.error; console.error = () => {};
  try {
    // door.json as a later release left it: start-up's own one-time moves can't be saved, and it starts anyway.
    const door = path.join(DIR, 'door.json'), doorNewer = JSON.stringify({ $v: 999, notes: [], places: { 'app:lists': { page: 0, col: 0, row: 0 } } });
    fs.writeFileSync(door, doorNewer);
    let out = null;
    const hs = homeScreenRoutes({ DIR, json: (res, code, obj) => { out = { code, obj }; }, body: async () => ({ key: 'app:lists', hidden: true }), APP_DIR: root });
    await hs({ method: 'POST', headers: {} }, { headersSent: false }, new URL('http://x/home/place'));
    assert.ok(out.code >= 400, `a tap is told it failed (${out.code})`);
    out = null; await hs({ method: 'GET', headers: {} }, {}, new URL('http://x/home'));
    assert.ok(!out.obj.places?.['app:lists']?.hidden, 'not kept');
    assert.equal(fs.readFileSync(door, 'utf8'), doorNewer);

    // day-notes.json the same: an app's notes aren't kept when they can't be saved.
    const dn = path.join(root, 'day-notes.json'), dnNewer = JSON.stringify({ $v: 999, byApp: {}, first: {} });
    fs.writeFileSync(dn, dnNewer);
    const notes = dayNotes({ DIR });
    const day = new Date().toISOString().slice(0, 10);
    assert.throws(() => notes.put('lunch', 'Lunch', [{ date: day, text: 'Lunch: Tacos' }]), (e) => e.unsaved);
    assert.deepEqual(notes.apps(), []);
    assert.equal(fs.readFileSync(dn, 'utf8'), dnNewer);
  } finally {
    console.error = errors;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a backup holds exactly the registry's household stores", async () => {
  assert.deepEqual([...INCLUDE].sort(), backedUp().sort());
  // Every store, made in a display folder, then packed: the household's are in it, keys, pairings and caches aren't.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-b-')), D = path.join(root, 'display');
  try {
    for (const s of [...STORES].sort((a, b) => Number(!!b.dir) - Number(!!a.dir))) {
      const p = path.join(D, s.path);
      if (s.dir) fs.mkdirSync(p, { recursive: true }); else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '{}'); }
      if (s.dir) fs.writeFileSync(path.join(p, 'x.txt'), 'x');
    }
    // A TV's pairing is this device's own, like a key: the backup's devices.json has the household's yes, not the token.
    fs.writeFileSync(path.join(D, 'devices.json'), JSON.stringify({ devices: [{ id: 'tv' }], pairing: { tv: { allowed: true, token: 'samsung-token' }, lg: { clientKey: 'lg-key' } } }));
    const tgz = path.join(root, 'b.tgz');
    await pack(D, tgz);
    const devices = JSON.parse(execFileSync('tar', ['-xzOf', tgz, 'devices.json'], { encoding: 'utf8' }));
    assert.deepEqual(devices.pairing, { tv: { allowed: true }, lg: {} });
    assert.deepEqual(devices.devices, [{ id: 'tv' }]);
    const held = new Set(execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').map((l) => l.replace(/\/$/, '')).filter(Boolean));
    for (const s of STORES) {
      const where = s.dir ? `${s.path}/x.txt` : s.path;
      const under = STORES.find((d) => d.dir && s.path.startsWith(d.path + '/'));
      const want = s.backup && (!under || under.backup);
      assert.equal(held.has(where), want, `${s.path} ${want ? 'is' : "isn't"} in a backup`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('people saved before Adult, Kid and Pet keep everything; only a birth year under 18 makes a kid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinds-')), DIR = path.join(root, 'chats');
  fs.mkdirSync(DIR);
  const y = new Date().getFullYear();
  const before = { location: 'Springfield', chores: [{ who: 'Leo', task: 'Feed the cat' }], family: [
    { name: 'Sam', note: 'Mom', born: 1985, color: '#74acff' }, { name: 'Alex', note: 'the youngest at heart' },
    { name: 'Maya', born: y - 9, color: '#56d6a0' }, { name: 'Leo', note: 'the youngest', born: y - 6 }, { name: 'Rex', note: 'the dog' }] };
  fs.writeFileSync(path.join(root, 'household.json'), JSON.stringify(before));
  const board = boardRoutes({ HERE: root, DIR, WORK: root, json: () => {}, body: async () => ({}), homeScreen: { migrate: () => {} } });
  const after = JSON.parse(fs.readFileSync(path.join(root, 'household.json'), 'utf8'));
  assert.deepEqual(after.family.map((f) => f.kind), [undefined, undefined, 'kid', 'kid', undefined], 'nothing guessed from a note');
  assert.deepEqual(after.family.map(({ kind, ...f }) => f), before.family, 'notes, birth years and colors as they were');
  assert.deepEqual({ ...after, family: null }, { ...before, family: null });
  assert.deepEqual(board.householdView().family.map((f) => f.kind), ['adult', 'adult', 'kid', 'kid', 'adult']);
  // Saved again from the setup (a name, kind and color only), what it doesn't ask is kept.
  board.saveHousehold({ family: [{ name: 'Sam', kind: 'adult' }, { name: 'Alex' }, { name: 'Maya' }, { name: 'Leo' }, { name: 'Rex', kind: 'pet' }] }, { quiet: true });
  const again = JSON.parse(fs.readFileSync(path.join(root, 'household.json'), 'utf8')).family;
  assert.deepEqual(again.map(({ kind, ...f }) => f), before.family);
  assert.deepEqual(again.map((f) => f.kind), ['adult', undefined, 'kid', 'kid', 'pet']);
});
