// Apps made on the tablet (rails.js): the model writes only into the one app it started, can't change what an app
// may reach, and a new app goes in only with a parent's yes, with none of the family's things and no websites.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepo, editLock } from '../edits.js';
import { pluginsRoutes } from '../plugins.js';
import { appAllowed } from '../apps.js';
import { rails } from '../rails.js';

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `openhouse-${n}-`));
/** A stand-in for the cloud's model: each answer is the next list of tool calls (or a plain reply when there are none). */
function scripted(steps) {
  let i = 0, call = 0;
  return async () => {
    const step = steps[i++] || [];
    return { output: step.map(([name, args]) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: `c${call++}` })), usage: { input_tokens: 10, output_tokens: 5 } };
  };
}
function setup() {
  const APP_DIR = tmp('webapp'); initRepo(APP_DIR);
  fs.mkdirSync(path.join(APP_DIR, 'apps/chores'), { recursive: true });
  fs.writeFileSync(path.join(APP_DIR, 'apps/chores/index.html'), '<!doctype html><script type="module" src="./main.js"></script>');
  fs.writeFileSync(path.join(APP_DIR, 'apps/chores/main.js'), 'document.body.textContent = "chores";\n');
  fs.writeFileSync(path.join(APP_DIR, 'apps/chores/app.json'), JSON.stringify({ name: 'Chores' }));
  const edits = editLock({ APP_DIR, UNDO_FILE: path.join(APP_DIR, '../undo-' + path.basename(APP_DIR) + '.json'), log: () => {} });
  const pl = pluginsRoutes({ APP_DIR, edits, homeScreen: { style: () => ({}) }, json: () => {}, body: async () => ({}), local: true, approve: async () => true, log: () => {} });
  pl.start(); // every app a plugin (chores: the household's own, full rights)
  return { APP_DIR, edits, pl };
}

test('made on the tablet: only its own app, nothing about what it may reach, and none of the family\'s things', async () => {
  const { APP_DIR, edits, pl } = setup();
  const asked = [];
  const outside = [
    ['write_file', { path: 'apps/chores/main.js', content: 'stolen' }], // another app
    ['write_file', { path: 'apps/dino/../chores/main.js', content: 'x' }], // out by ..
    ['write_file', { path: 'apps/dino/sub/x.js', content: 'x' }], // a folder
    ['write_file', { path: '../../etc/x.js', content: 'x' }],
    ['write_file', { path: 'apps/dino/index.html', content: '<script src="https://evil.example/x.js"></script>' }], // the template's page
    ['write_file', { path: 'apps/dino/game.js', content: 'x' }], // the engine
    ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino', reaches: ['evil.example'] }) }],
    ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino', uses: ['settings'] }) }],
  ];
  const b = rails({
    APP_DIR, ai: scripted([
      [['write_file', { path: 'apps/dino/main.js', content: 'x' }]], // before start
      [['start', { kind: 'game', app: 'dino', name: 'Dino Eggs' }]],
      outside,
      [['write_file', { path: 'apps/dino/main.js', content: 'import { start } from "./game.js";\nstart({ setup() {} });\n' }],
        ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino Eggs', kit: 1, uses: ['lists'] }) }]],
      [['done', { summary: 'A dinosaur catches eggs.' }]],
    ]),
    approve: async (title, detail, pin, extra) => { asked.push({ title, pin, extra }); return true; },
    madeHere: (id, o) => pl.madeHere(id, o), limited: (id) => pl.limited(id),
  });
  const owner = { kind: 'build', who: 'Leo', text: 'a dinosaur game' };
  assert.ok(await edits.acquire(owner, {}));
  const outs = [];
  const r = await b.run({ prompt: 'Leo asks: a dinosaur game', owner, onEvent: (e) => e.kind === 'tool-done' && outs.push(e.ok) });
  assert.equal(r.ok, true, r.text);
  assert.equal(outs.slice(0, 1 + 1 + outside.length).filter((ok) => ok).length, 1, 'only start went through, of the calls before it wrote its own main.js');
  assert.equal(fs.readFileSync(path.join(APP_DIR, 'apps/chores/main.js'), 'utf8'), 'document.body.textContent = "chores";\n');
  assert.ok(!fs.readFileSync(path.join(APP_DIR, 'apps/dino/index.html'), 'utf8').includes('evil'));
  assert.equal(fs.readFileSync(path.join(APP_DIR, 'apps/dino/game.js'), 'utf8'), fs.readFileSync(new URL('../templates/game/game.js', import.meta.url), 'utf8'));
  // A parent's yes, with the PIN, on a card that says what it may use; then it's limited to that
  assert.equal(asked.length, 1); assert.equal(asked[0].pin, true);
  assert.ok(asked[0].extra.rights.some((x) => x.kind === 'offline'));
  edits.finish(owner, true);
  assert.deepEqual([...pl.rightsOf('dino')], ['lists']);
  assert.deepEqual(pl.reachesOf('dino'), []);
  assert.equal(appAllowed('POST', '/house/event', pl.rightsOf('dino')), false);
  assert.equal(appAllowed('POST', '/house/settings', pl.rightsOf('dino')), false);
  assert.equal(pl.rightsOf('chores'), null); // the household's own app keeps its own rights
  // Its app.json saying otherwise later changes nothing: what it may reach is the plugin registry's, not its own file's
  fs.writeFileSync(path.join(APP_DIR, 'apps/dino/app.json'), JSON.stringify({ name: 'Dino', reaches: ['evil.example'], uses: ['settings', 'events'] }));
  assert.deepEqual(pl.reachesOf('dino'), []);
  assert.deepEqual([...pl.rightsOf('dino')], ['lists']);
});

test('made on the tablet: a no on the card keeps nothing; a change to the household\'s app keeps its rights as they were', async () => {
  const { APP_DIR, edits, pl } = setup();
  const no = rails({ APP_DIR, ai: scripted([[['start', { kind: 'tab', app: 'snacks' }]], [['done', { summary: 'Snacks.' }]]]), approve: async () => false,
    madeHere: (id, o) => pl.madeHere(id, o), limited: (id) => pl.limited(id) });
  const owner = { kind: 'build', who: 'Sam', text: 'snacks' };
  assert.ok(await edits.acquire(owner, {}));
  const r = await no.run({ prompt: 'snacks', owner });
  assert.equal(r.ok, false);
  edits.finish(owner, r.ok); // the builder puts it back
  assert.equal(fs.existsSync(path.join(APP_DIR, 'apps/snacks')), false);
  assert.equal(pl.rightsOf('snacks'), null);

  const change = rails({ APP_DIR, ai: scripted([
    [['start', { kind: 'change', app: 'chores' }]],
    [['edit_file', { path: 'apps/chores/app.json', old: '"Chores"', new: '"Chores", "reaches": ["evil.example"]' }], ['edit_file', { path: 'apps/chores/main.js', old: '"chores"', new: '"Chores!"' }]],
    [['done', { summary: 'Bigger.' }]]]), approve: async () => true, madeHere: (id, o) => pl.madeHere(id, o), limited: (id) => pl.limited(id) });
  const o2 = { kind: 'build', who: 'Alex', text: 'bigger' };
  assert.ok(await edits.acquire(o2, {}));
  assert.equal((await change.run({ prompt: 'bigger', owner: o2 })).ok, true);
  edits.finish(o2, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'apps/chores/app.json'), 'utf8')).reaches, undefined);
  assert.match(fs.readFileSync(path.join(APP_DIR, 'apps/chores/main.js'), 'utf8'), /Chores!/);
  assert.equal(pl.rightsOf('chores'), null);
});
