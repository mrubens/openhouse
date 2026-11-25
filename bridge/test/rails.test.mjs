// Apps made on the tablet (rails.js): the model writes only into the one app it started, can't change what an app
// may reach, and a new app goes in only with a grown-up's yes (the PIN always), with only the family's things and the
// exact websites its card named. A build nobody answers waits (build-waits.js): nothing of it is in, and nothing of it is lost.
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
import { buildWaits, markBuilding, putBackUnfinished } from '../build-waits.js';

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
  /** The builder's side of the card (build-waits.js), answering with [answers] in turn. */
  const waitsWith = (answers, o = {}) => {
    const asked = [];
    const w = buildWaits({ FILE: path.join(APP_DIR, '../waits-' + path.basename(APP_DIR) + '.json'), edits, log: () => {},
      ask: async (c) => { asked.push(c); return answers.length ? answers.shift() : 'later'; }, grant: (c) => pl.madeHere(c.app, { uses: c.uses, reaches: c.reaches }), unmake: (id) => pl.unmake(id), APP_DIR, ...o });
    return Object.assign(w, { asked });
  };
  return { APP_DIR, edits, pl, waitsWith };
}

test('made on the tablet: only its own app, and only the family\'s things and exact websites its card granted', async () => {
  const { APP_DIR, edits, pl, waitsWith } = setup();
  const outside = [
    ['write_file', { path: 'apps/chores/main.js', content: 'stolen' }], // another app
    ['write_file', { path: 'apps/dino/../chores/main.js', content: 'x' }], // out by ..
    ['write_file', { path: 'apps/dino/sub/x.js', content: 'x' }], // a folder
    ['write_file', { path: '../../etc/x.js', content: 'x' }],
    ['write_file', { path: 'apps/dino/index.html', content: '<script src="https://evil.example/x.js"></script>' }], // the template's page
    ['write_file', { path: 'apps/dino/game.js', content: 'x' }], // the engine
    ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino', reaches: ['*.evil.example'] }) }], // any name under a site
    ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino', reaches: ['https://evil.example/x'] }) }],
    ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino', reaches: ['192.168.1.1'] }) }], // the home network
    ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino', reaches: ['a.example', 'b.example', 'c.example', 'd.example', 'e.example'] }) }],
    ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino', uses: ['settings'] }) }],
  ];
  const b = rails({
    APP_DIR, ai: scripted([
      [['write_file', { path: 'apps/dino/main.js', content: 'x' }]], // before start
      [['start', { kind: 'game', app: 'dino', name: 'Dino Eggs' }]],
      outside,
      [['write_file', { path: 'apps/dino/main.js', content: 'import { start } from "./game.js";\nstart({ setup() {} });\n' }],
        ['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino Eggs', kit: 1, uses: ['lists'], reaches: ['api.weather.gov'] }) }]],
      [['done', { summary: 'A dinosaur catches eggs.' }]],
    ]),
    limited: (id) => pl.limited(id), register: (id) => pl.madeHere(id, {}),
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
  // While it's being made, and until a grown-up's yes: limited like an app from a link, with nothing granted, whatever
  // its app.json asks (so it's on its own origin, and none of the family's things)
  assert.deepEqual([...pl.rightsOf('dino')], []);
  assert.deepEqual(pl.reachesOf('dino'), []);
  assert.equal(appAllowed('POST', '/house/list', pl.rightsOf('dino')), false);
  // With no screen to ask a grown-up (a hub), it doesn't go in, and nothing is granted
  const nobody = waitsWith([null]);
  assert.equal(await nobody.decide(owner, r.card), 'no'); nobody.stop();
  assert.deepEqual([...pl.rightsOf('dino')], []);
  // A grown-up's yes, on a card that always takes the PIN and names the sites it may reach
  const waits = waitsWith(['yes']);
  assert.equal(await waits.decide(owner, r.card), 'yes');
  assert.equal(waits.asked.length, 1); assert.equal(waits.asked[0].pin, true); assert.equal(waits.asked[0].grownup, true);
  assert.ok(waits.asked[0].rights.some((x) => x.kind === 'web' && x.text.includes('api.weather.gov')));
  edits.finish(owner, true); waits.stop();
  assert.deepEqual([...pl.rightsOf('dino')], ['lists']);
  assert.deepEqual(pl.reachesOf('dino'), ['api.weather.gov']);
  assert.deepEqual(pl.frozenOf('dino').reaches, ['api.weather.gov']);
  assert.equal(appAllowed('POST', '/house/event', pl.rightsOf('dino')), false);
  assert.equal(appAllowed('POST', '/house/settings', pl.rightsOf('dino')), false);
  assert.equal(pl.rightsOf('chores'), null); // the household's own app keeps its own rights
  // Its app.json saying otherwise later changes nothing: what it may reach is the plugin registry's, not its own file's
  fs.writeFileSync(path.join(APP_DIR, 'apps/dino/app.json'), JSON.stringify({ name: 'Dino', reaches: ['evil.example'], uses: ['settings', 'events'] }));
  assert.deepEqual(pl.reachesOf('dino'), ['api.weather.gov']);
  assert.deepEqual([...pl.rightsOf('dino')], ['lists']);
  // A no on a later change's card grants none of the sites it asked for
  const later = rails({ APP_DIR, ai: scripted([
    [['start', { kind: 'change', app: 'dino' }]],
    [['write_file', { path: 'apps/dino/app.json', content: JSON.stringify({ name: 'Dino Eggs', kit: 1, uses: ['lists'], reaches: ['api.weather.gov', 'evil.example'] }) }]],
    [['done', { summary: 'Weather eggs.' }]]]), limited: (id) => pl.limited(id), register: (id) => pl.madeHere(id, {}) });
  const o2 = { kind: 'build', who: 'Leo', text: 'more' };
  assert.ok(await edits.acquire(o2, {}));
  const r2 = await later.run({ prompt: 'more', owner: o2 });
  const no = waitsWith(['no']);
  assert.equal(await no.decide(o2, r2.card), 'no'); no.stop();
  edits.finish(o2, false);
  assert.deepEqual(pl.reachesOf('dino'), ['api.weather.gov']);
});

test('made on the tablet: a no on the card keeps nothing; a change to the household\'s app keeps its rights as they were', async () => {
  const { APP_DIR, edits, pl, waitsWith } = setup();
  const no = rails({ APP_DIR, ai: scripted([[['start', { kind: 'tab', app: 'snacks' }]], [['done', { summary: 'Snacks.' }]]]), limited: (id) => pl.limited(id), register: (id) => pl.madeHere(id, {}) });
  const owner = { kind: 'build', who: 'Sam', text: 'snacks' };
  assert.ok(await edits.acquire(owner, {}));
  const r = await no.run({ prompt: 'snacks', owner });
  const waits = waitsWith(['no']);
  assert.equal(await waits.decide(owner, r.card), 'no'); waits.stop();
  edits.finish(owner, false); // the builder puts it back
  assert.equal(fs.existsSync(path.join(APP_DIR, 'apps/snacks')), false);
  assert.equal(pl.rightsOf('snacks'), null);
  assert.equal(edits.dirty(), false, 'its registry entry went back with its files');

  const change = rails({ APP_DIR, ai: scripted([
    [['start', { kind: 'change', app: 'chores' }]],
    [['edit_file', { path: 'apps/chores/app.json', old: '"Chores"', new: '"Chores", "reaches": ["evil.example"]' }], ['edit_file', { path: 'apps/chores/main.js', old: '"chores"', new: '"Chores!"' }]],
    [['done', { summary: 'Bigger.' }]]]), limited: (id) => pl.limited(id), register: (id) => pl.madeHere(id, {}) });
  const o2 = { kind: 'build', who: 'Alex', text: 'bigger' };
  assert.ok(await edits.acquire(o2, {}));
  const r2 = await change.run({ prompt: 'bigger', owner: o2 });
  assert.equal(r2.ok, true); assert.equal(r2.card.limited, false);
  // The household's app, with its own rights, isn't rewritten live: the change is in a draft that has none
  assert.equal(fs.readFileSync(path.join(APP_DIR, 'apps/chores/main.js'), 'utf8'), 'document.body.textContent = "chores";\n');
  assert.ok(r2.card.draft);
  assert.match(fs.readFileSync(path.join(APP_DIR, 'apps', r2.card.draft, 'main.js'), 'utf8'), /Chores!/);
  assert.deepEqual([...pl.rightsOf(r2.card.draft)], []);
  // and swapped in on the yes, the draft gone
  const yes = waitsWith(['yes']);
  assert.equal(await yes.decide(o2, r2.card), 'yes'); yes.stop();
  assert.equal(fs.existsSync(path.join(APP_DIR, 'apps', r2.card.draft)), false);
  assert.equal(pl.rightsOf(r2.card.draft), null);
  edits.finish(o2, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'apps/chores/app.json'), 'utf8')).reaches, undefined);
  assert.match(fs.readFileSync(path.join(APP_DIR, 'apps/chores/main.js'), 'utf8'), /Chores!/);
  assert.equal(pl.rightsOf('chores'), null);
});

test('a build nobody answers waits: nothing of it is in or granted, a later yes puts it in, a no or a day puts it back', async () => {
  const { APP_DIR, edits, pl, waitsWith } = setup();
  const head = () => edits.git('rev-parse', 'HEAD');
  const make = async (id) => {
    const b = rails({ APP_DIR, ai: scripted([[['start', { kind: 'tab', app: id, name: id }]], [['done', { summary: `${id}: a list.` }]]]), limited: (x) => pl.limited(x), register: (x) => pl.madeHere(x, {}) });
    const owner = { kind: 'build', who: 'Maya', text: `make ${id}` };
    assert.ok(await edits.acquire(owner, {}));
    return { owner, r: await b.run({ prompt: id, owner }) };
  };
  let t = Date.now();
  const lines = [];
  const waits = waitsWith(['later', 'yes', 'later', 'no'], { now: () => t, line: (x) => lines.push(x) });

  // Nobody answers: set aside, the files put back and the lock free, nothing committed or granted
  const before = head();
  const a = await make('streak');
  assert.equal(await waits.decide(a.owner, a.r.card), 'later');
  waits.park(a.owner, a.r.card); edits.release(a.owner);
  assert.equal(head(), before);
  assert.equal(fs.existsSync(path.join(APP_DIR, 'apps/streak')), false);
  assert.equal(edits.dirty(), false);
  assert.equal(pl.rightsOf('streak'), null);
  assert.deepEqual(waits.waiting().map((w) => w.app), ['streak']);
  // Asked again (Home's line), a yes: in, with only what the card granted
  const id = waits.waiting()[0].id;
  assert.equal((await waits.open(id)).answer, 'yes');
  assert.equal(waits.asked.at(-1).pin, true); assert.equal(waits.asked.at(-1).grownup, true);
  assert.notEqual(head(), before);
  assert.ok(fs.existsSync(path.join(APP_DIR, 'apps/streak/main.js')));
  assert.deepEqual([...pl.rightsOf('streak')], []);
  assert.deepEqual(waits.waiting(), []);
  assert.equal(edits.holder(), null);

  // Another: waits, then a no puts it back for good
  t += 1000;
  const b = await make('jokes');
  assert.equal(await waits.decide(b.owner, b.r.card), 'later');
  waits.park(b.owner, b.r.card); edits.release(b.owner);
  const at = head();
  assert.equal((await waits.open(waits.waiting()[0].id)).answer, 'no');
  assert.equal(head(), at);
  assert.equal(fs.existsSync(path.join(APP_DIR, 'apps/jokes')), false);
  assert.deepEqual(waits.waiting(), []);
  assert.equal(pl.rightsOf('jokes'), null);

  // And one nobody answers for a day: put back, with a line on Home saying so
  t += 1000;
  const c = await make('dots');
  waits.park(c.owner, c.r.card); edits.release(c.owner);
  assert.equal(waits.waiting().length, 1);
  t += 25 * 3600e3;
  assert.deepEqual(waits.waiting(), []);
  assert.equal(lines.length, 1);
  assert.equal((await waits.open('dots')).ok, false);
  assert.equal(fs.existsSync(path.join(APP_DIR, 'apps/dots')), false);
  waits.stop();
});

test('a build the bridge stopped in the middle of is put back on the next start, not taken in', async () => {
  const { APP_DIR, edits, pl } = setup();
  const HERE = tmp('bridge-here'), head = edits.git('rev-parse', 'HEAD');
  const b = rails({ APP_DIR, ai: scripted([[['start', { kind: 'tab', app: 'half', name: 'Half' }]]]), limited: (id) => pl.limited(id), register: (id) => pl.madeHere(id, {}) });
  const owner = { kind: 'build', who: 'Leo', text: 'half a thing' };
  assert.ok(await edits.acquire(owner, {}));
  markBuilding(HERE, owner);
  await b.run({ prompt: 'half', owner }); // (then the bridge stops: nothing releases or puts back)
  assert.ok(fs.existsSync(path.join(APP_DIR, 'apps/half')));
  // The next start: a fresh lock over the same folder
  const again = editLock({ APP_DIR, UNDO_FILE: path.join(APP_DIR, '../undo2-' + path.basename(APP_DIR) + '.json'), log: () => {} });
  assert.equal(putBackUnfinished({ HERE, edits: again, log: () => {} }), true);
  assert.equal(fs.existsSync(path.join(APP_DIR, 'apps/half')), false);
  assert.equal(again.dirty(), false);
  assert.equal(again.git('rev-parse', 'HEAD'), head, 'nothing committed');
  assert.equal(putBackUnfinished({ HERE, edits: again, log: () => {} }), false, 'once');
});
