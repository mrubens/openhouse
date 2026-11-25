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
