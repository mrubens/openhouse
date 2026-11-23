// Every app is a plugin (plugins.js, docs/plugins.md §11): ours (built-in), the household's own (local), from a link
// (shared). The one-time move, our updates, a household change making their own version, undo of one plugin, putting
// ours back, voice actions, and the move (and a start-up after it) on copies of the family tablet's backups.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRepo, editLock } from '../edits.js';
import { pluginsRoutes } from '../plugins.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `openhouse-${n}-`));
const gitIn = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f) => fs.readFileSync(f, 'utf8');

/** Our starting apps: a folder like defaults/apps. */
function defaults(dir, apps = { calendar: 'cal v1', chores: 'chores v1' }) {
  for (const [id, text] of Object.entries(apps)) {
    write(path.join(dir, id, 'index.html'), `<!doctype html>${text}`);
    write(path.join(dir, id, 'app.json'), JSON.stringify({ name: id[0].toUpperCase() + id.slice(1), version: text.split(' ')[1] }));
  }
  return dir;
}
/** A tablet's webapp as the old seeding left it: starting apps committed as "Starting apps…", plus what the family made. */
function tablet({ seeded = ['calendar', 'chores'], defs } = {}) {
  const app = tmp('webapp'); initRepo(app);
  for (const id of seeded) fs.cpSync(path.join(defs, id), path.join(app, 'apps', id), { recursive: true });
  write(path.join(app, 'apps/home/style.json'), JSON.stringify({ tabs: ['today', 'calendar', 'chores', 'apps'] }));
  gitIn(app, 'add', '-A'); gitIn(app, 'commit', '-qm', `Starting apps: ${seeded.join(' ')}`);
  return app;
}
function setup({ app, defs, seededFile = null, approve = async () => true }) {
  const edits = editLock({ APP_DIR: app, UNDO_FILE: path.join(app, '../undo-' + path.basename(app) + '.json'), log: () => {} });
  let style = JSON.parse(read(path.join(app, 'apps/home/style.json')));
  const door = { style: () => style, setLook: (b) => { style = { ...style, ...b }; write(path.join(app, 'apps/home/style.json'), JSON.stringify(style)); return { style }; }, showTab: () => {} };
  const DATA = tmp('appdata');
  const pl = pluginsRoutes({ APP_DIR: app, edits, door, json: () => {}, body: async () => ({}), local: true, approve, DATA, DEFAULTS: defs, SEEDED: seededFile, log: () => {} });
  /** One household change, as a conversation turn makes it. */
  const change = (text, fn) => { const t = edits.begin({ who: 'Maya', text }); edits.claim(t); fn(); return edits.end(t, true); };
  return { edits, pl, door, DATA, change };
}
const kinds = (pl) => Object.fromEntries(Object.entries(pl.readAll()).map(([n, e]) => [n, e.kind + (e.overriddenBy ? ' over by ' + e.overriddenBy : '') + (e.removed ? ' removed' : '') + (e.overrides ? ' over ' + e.overrides : '')]));

test('the move: every app becomes a plugin, nothing else changes, one commit that undo leaves alone, and it goes back', () => {
  const defs = defaults(tmp('defs'), { calendar: 'cal v1', chores: 'chores v1', meals: 'meals v1', photos: 'photos v1' });
  const app = tablet({ seeded: ['calendar', 'chores', 'meals'], defs });
  const seededFile = path.join(tmp('display'), '.defaults-seeded'); write(seededFile, 'calendar\nchores\nmeals\nphotos\n');
  // The family: changed Chores, made a game, deleted Photos long ago (never here now), and has a plugin from a link (v1's lock).
  write(path.join(app, 'apps/chores/index.html'), 'bigger stars'); gitIn(app, 'commit', '-qam', 'make the stars bigger');
  write(path.join(app, 'apps/glow-drop/index.html'), 'game'); write(path.join(app, 'apps/glow-drop/app.json'), '{"name":"Glow Drop"}');
  write(path.join(app, 'apps/twins/index.html'), 'twins');
  write(path.join(app, 'plugins.json'), JSON.stringify({ twins: { source: 'git:github.com/f/twins', title: 'Twins', apps: { twins: { uses: ['chores'], reaches: [], files: {} } } } }));
  gitIn(app, 'add', '-A'); gitIn(app, 'commit', '-qm', 'Sam: Can you make a fun game?');
  const before = gitIn(app, 'ls-files', '-s', 'apps');
  const { pl, edits } = setup({ app, defs, seededFile });
  const stackBefore = edits.stack().length;
  const r = pl.migrate();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.builtin, ['calendar', 'meals']);
  assert.deepEqual(r.overridden, ['chores']);
  assert.deepEqual(r.local, ['glow-drop']);
  assert.deepEqual(r.shared, ['twins']);
  assert.deepEqual(r.removed, ['photos']);
  assert.deepEqual(kinds(pl), {
    'glow-drop': 'local', chores: 'local over openhouse-chores', twins: 'shared',
    'openhouse-calendar': 'builtin', 'openhouse-meals': 'builtin', 'openhouse-chores': 'builtin over by chores', 'openhouse-photos': 'builtin removed',
  });
  assert.equal(gitIn(app, 'ls-files', '-s', 'apps'), before, 'not a file of an app changed');
  assert.equal(fs.existsSync(path.join(app, 'plugins.json')), false);
  assert.equal(gitIn(app, 'log', '-1', '--format=%s'), 'Apps became plugins');
  assert.equal(edits.stack().length, stackBefore, '"undo" never takes the move back');
  assert.equal(pl.rightsOf('twins').has('chores'), true);
  assert.equal(pl.rightsOf('glow-drop'), null);
  assert.equal(pl.migrate().already, true); // once

  const back = pl.unmigrate();
  assert.equal(back.ok, true, back.error);
  assert.equal(fs.existsSync(pl.DIR), false);
  assert.deepEqual(Object.keys(JSON.parse(read(path.join(app, 'plugins.json')))), ['twins']);
  assert.equal(gitIn(app, 'ls-files', '-s', 'apps'), before);
  assert.equal(pl.migrate().ok, true); // and again
});

test('our updates: new ones go in, untouched ones update, the household\'s version and taken-off ones stay theirs', () => {
  const defs = defaults(tmp('defs'), { calendar: 'cal v1', chores: 'chores v1', meals: 'meals v1' });
  const app = tablet({ seeded: ['calendar', 'chores', 'meals'], defs });
  const { pl, change } = setup({ app, defs });
  pl.migrate();
  change('make the stars bigger', () => write(path.join(app, 'apps/chores/index.html'), 'bigger stars'));
  assert.equal(pl.readAll().chores.overrides, 'openhouse-chores'); // their change made their own version, in that same commit
  assert.match(gitIn(app, 'show', '--name-only', '--format=', 'HEAD'), /plugins\/chores\.json/);
  change('take meals off', () => fs.rmSync(path.join(app, 'apps/meals'), { recursive: true }));
  assert.equal(pl.readAll()['openhouse-meals'].removed, true);

  defaults(defs, { calendar: 'cal v2', chores: 'chores v2', meals: 'meals v2', weather: 'weather v2' }); // the next release
  const s = pl.syncBuiltins();
  assert.deepEqual(s.added, ['weather']);
  assert.deepEqual(s.updated, ['calendar v2']);
  assert.match(read(path.join(app, 'apps/calendar/index.html')), /cal v2/);
  assert.equal(read(path.join(app, 'apps/chores/index.html')), 'bigger stars');
  assert.equal(fs.existsSync(path.join(app, 'apps/meals')), false);
  assert.equal(pl.installed().find((p) => p.name === 'openhouse-chores').latest, 'v2'); // ours is newer; theirs is used
  assert.equal(pl.installed().find((p) => p.name === 'openhouse-calendar').version, 'v2');
  assert.equal(pl.syncBuiltins().commit, null, 'nothing new: no commit');
});

test('undo_plugin takes back one plugin\'s latest change and keeps the others; reset_plugin puts ours back, undo brings theirs', async () => {
  const defs = defaults(tmp('defs'));
  const app = tablet({ defs });
  const { pl, change } = setup({ app, defs });
  pl.migrate();
  change('calendar: two weeks', () => write(path.join(app, 'apps/calendar/index.html'), 'two weeks'));
  change('chores: bigger stars', () => write(path.join(app, 'apps/chores/index.html'), 'bigger stars'));
  let r = await pl.call('undo_plugin', { name: 'calendar' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(read(path.join(app, 'apps/calendar/index.html')), /cal v1/);
  assert.equal(read(path.join(app, 'apps/chores/index.html')), 'bigger stars');
  assert.equal(pl.readAll().calendar, undefined); // their version went with its only change
  assert.equal(pl.readAll()['openhouse-calendar'].overriddenBy, undefined);
  r = await pl.call('undo_plugin', { name: 'calendar' }); // the one before it was ours (Starting apps): never taken back this way
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Nothing to take back/);

  r = await pl.call('reset_plugin', { name: 'Chores' });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(read(path.join(app, 'apps/chores/index.html')), /chores v1/);
  assert.equal(pl.readAll().chores, undefined);
  assert.equal(pl.readAll()['openhouse-chores'].overriddenBy, undefined);
  const { edits } = setup({ app, defs }); // a fresh lock reads the same undo stack from disk
  edits.undoLatest();
  assert.equal(read(path.join(app, 'apps/chores/index.html')), 'bigger stars');
  assert.equal(pl.readAll()['openhouse-chores'].overriddenBy, 'chores');
});

// The family tablet's backups (scripts/tablet-backup.sh writes them), on a copy: read, never written. The move is tried
// on the newest one from before it (no webapp/plugins/.v1), and a start-up on the newest one after it. Each is skipped
// where there's none (CI, another computer).
const BACKUPS = process.env.OPENHOUSE_BACKUPS || path.join(os.homedir(), 'Documents/openhouse-backups');
const backups = (() => { try { return fs.readdirSync(BACKUPS).filter((f) => /^tablet-\d{8}-\d{4}.*\.tgz$/.test(f)).sort().reverse(); } catch { return []; } })();
const members = new Map();
const listOf = (f) => { if (!members.has(f)) members.set(f, execFileSync('tar', ['tzf', path.join(BACKUPS, f)], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')); return members.get(f); };
const isMoved = (f) => listOf(f).includes('./webapp/plugins/.v1');
const beforeMove = backups.find((f) => !isMoved(f)) || null;
const afterMove = backups[0] && isMoved(backups[0]) ? backups[0] : null;
/** A copy of a backup's webapp, appdata and .defaults-seeded (the ones it has). */
function unpack(f) {
  const copy = tmp('family'), want = ['./webapp', './appdata', './.defaults-seeded'].filter((m) => listOf(f).some((l) => l === m || l.startsWith(m + '/')));
  execFileSync('tar', ['xzf', path.join(BACKUPS, f), '-C', copy, ...want], { stdio: 'pipe' });
  fs.mkdirSync(path.join(copy, 'appdata'), { recursive: true });
  const app = path.join(copy, 'webapp'), appdata = path.join(copy, 'appdata');
  const snap = () => ({
    apps: gitIn(app, 'ls-files', '-s', 'apps'),
    tabs: read(path.join(app, 'apps/home/style.json')),
    data: execFileSync('find', ['.', '-type', 'f', '-exec', 'shasum', '{}', '+'], { cwd: appdata, encoding: 'utf8' }).split('\n').sort().join('\n'),
    status: gitIn(app, 'status', '--porcelain'),
  });
  const ids = fs.readdirSync(path.join(app, 'apps')).filter((d) => d !== 'home' && fs.statSync(path.join(app, 'apps', d)).isDirectory());
  return { copy, app, snap, ids, ...setup({ app, defs: path.join(REPO, 'defaults/apps'), seededFile: path.join(copy, '.defaults-seeded') }) };
}
const localFiles = (pl, app) => Object.fromEntries(Object.entries(pl.readAll()).filter(([, e]) => e.kind === 'local').map(([n, e]) => [n, Object.keys(e.apps).map((id) => gitIn(app, 'ls-files', '-s', `apps/${id}`)).join()]));

test('the move on a copy of the family tablet\'s newest backup from before it: apps, app data and tabs exactly as they were', { skip: !beforeMove && 'no tablet backup from before the move here' }, () => {
  const { app, snap, ids, pl, edits } = unpack(beforeMove);
  const before = snap();
  const stack = edits.stack().length;
  const m = pl.migrate();
  assert.equal(m.ok, true, m.error);
  const after = snap();
  assert.equal(after.apps, before.apps, 'no app file changed');
  assert.equal(after.tabs, before.tabs, 'tabs as they were');
  assert.equal(after.data, before.data, 'app data as it was');
  assert.equal(after.status, '', 'nothing left uncommitted');
  assert.equal(edits.stack().length, stack);
  // Every app now belongs to exactly one plugin.
  for (const id of ids) assert.ok(pl.ownerOf(id), `${id} has a plugin`);
  const all = pl.readAll();
  for (const id of ['drawing', 'glow-drop', 'pocket-pet', 'typing-garden', 'whiteboard']) if (ids.includes(id)) assert.equal(all[id]?.kind, 'local', id);
  // Weather was made from the laptop before ours existed: theirs, over ours.
  if (ids.includes('weather')) assert.equal(all['openhouse-weather'].overriddenBy, 'weather');
  fs.writeFileSync(path.join(os.tmpdir(), 'openhouse-family-move.json'), JSON.stringify({ backup: beforeMove, ...m, plugins: kinds(pl) }, null, 1));

  // Then this release's built-ins: only the ones the family never changed update; their own stay byte for byte.
  const theirs = localFiles(pl, app);
  const s = pl.syncBuiltins();
  assert.equal(s.error, undefined, s.error);
  assert.deepEqual(localFiles(pl, app), theirs, 'the household\'s own untouched by our update');
  assert.equal(read(path.join(app, 'apps/home/style.json')), before.tabs);
  assert.equal(snap().data, before.data);

  // And back.
  const back = pl.unmigrate();
  assert.equal(back.ok, true, back.error);
  assert.equal(fs.existsSync(pl.DIR), false);
});

test('start-up on a copy of the family tablet\'s newest backup, already moved: nothing moves again, the household\'s own stay as they are', { skip: !afterMove && 'the newest tablet backup here is from before the move' }, () => {
  const { app, snap, ids, pl, edits } = unpack(afterMove);
  const before = snap(), manifests = gitIn(app, 'ls-files', '-s', 'plugins'), theirs = localFiles(pl, app), stack = edits.stack().length;
  const r = pl.start();
  assert.equal(r.migrate.already, true);
  assert.equal(r.sync.error, undefined, r.sync.error);
  for (const id of ids) assert.ok(pl.ownerOf(id), `${id} has a plugin`);
  assert.deepEqual(localFiles(pl, app), theirs);
  assert.equal(snap().tabs, before.tabs);
  assert.equal(snap().data, before.data);
  assert.equal(snap().status, '');
  assert.equal(edits.stack().length, stack, 'our update is never on the undo stack');
  if (!r.sync.commit) assert.equal(gitIn(app, 'ls-files', '-s', 'plugins'), manifests, 'nothing new from us: the manifests as they were');
});
