// Plugins (plugins.js, docs/plugins.md): what's checked before a plugin goes in, the card's yes, one undoable change,
// and an app from a plugin getting only what it was granted.
//   cd bridge && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepo, editLock } from '../edits.js';
import { checkPlugin, parseSource, pluginsRoutes, cleanCatalog } from '../plugins.js';
import crypto from 'node:crypto';
import { appAllowed, houseFor } from '../apps.js';
import { reachMatches, appFetch, pinnedFetch } from '../app-web.js';
import net from 'node:net';
import { thingStore } from '../things.js';

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `openhouse-${n}-`));

/** A plugin folder: one app (twins-chores) using chores, a look, a suggested tab. */
function makePlugin(dir, { name = 'twins-chores', app = 'twins-chores', uses = ['chores', 'rewards'], reaches = [], pkg = {}, extra = () => {} } = {}) {
  fs.mkdirSync(path.join(dir, 'apps', app), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.0', description: 'A chore chart for two kids who share a room.', keywords: ['openhouse-plugin', 'pi-package'],
    openhouse: { apps: [`apps/${app}`], looks: ['looks/sage.json'], tabs: [{ app, name: 'Chores' }] }, ...pkg }));
  fs.writeFileSync(path.join(dir, 'apps', app, 'index.html'), '<!doctype html><script type="module" src="main.js"></script>');
  fs.writeFileSync(path.join(dir, 'apps', app, 'main.js'), 'document.body.textContent = "twins";\n');
  fs.writeFileSync(path.join(dir, 'apps', app, 'app.json'), JSON.stringify({ name: 'Twins chores', uses, reaches }));
  fs.mkdirSync(path.join(dir, 'looks'));
  fs.writeFileSync(path.join(dir, 'looks', 'sage.json'), JSON.stringify({ palette: 'sage', type: 'serif', door: '#ff0000' }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Twins chores\n');
  extra(dir);
  return dir;
}

test('sources: git links (pinned or not) and tarballs; nothing else', () => {
  assert.deepEqual(parseSource('git:github.com/fam/twins-chores@v1'), { kind: 'git', url: 'https://github.com/fam/twins-chores.git', ref: 'v1', label: 'github.com/fam/twins-chores', key: 'git:github.com/fam/twins-chores' });
  assert.equal(parseSource('https://github.com/fam/twins-chores').ref, null);
  assert.equal(parseSource('github.com/fam/twins-chores@v2').url, 'https://github.com/fam/twins-chores.git');
  assert.equal(parseSource('https://github.com/fam/twins-chores.git@3f2a1c9').ref, '3f2a1c9');
  assert.equal(parseSource('https://example.com/p/twins-1.2.0.tgz').kind, 'tar');
  for (const bad of ['http://github.com/a/b', 'file:///etc', '/tmp/x', 'github.com/a', 'ssh://git@github.com/a/b', 'git:localhost/a/b', '']) assert.equal(parseSource(bad), null, bad);
  assert.equal(parseSource('/tmp/x', { local: true }).kind, 'local');
});

test('what a plugin may hold: flat app folders of plain files, no code for the assistant', () => {
  const p = checkPlugin(makePlugin(tmp('p')));
  assert.equal(p.name, 'twins-chores');
  assert.deepEqual(p.apps.map((a) => [a.id, a.name, a.uses]), [['twins-chores', 'Twins chores', ['chores', 'rewards']]]);
  assert.deepEqual(p.look, { palette: 'sage', type: 'serif' }); // only the look's keys: not "door"
  assert.deepEqual(p.tabs, [{ app: 'twins-chores', name: 'Chores' }]);

  const refuse = (opts, re) => assert.throws(() => checkPlugin(makePlugin(tmp('p'), opts)), re);
  refuse({ pkg: { pi: { extensions: ['./ext'] } } }, /pi extensions/);
  refuse({ extra: (d) => fs.mkdirSync(path.join(d, 'extensions')) }, /pi extensions/);
  refuse({ uses: ['settings'] }, /can't have/);
  refuse({ reaches: ['https://evil.example/x'] }, /plain host names/);
  refuse({ extra: (d) => fs.symlinkSync('/etc/passwd', path.join(d, 'apps/twins-chores/x.js')) }, /link/);
  refuse({ extra: (d) => fs.mkdirSync(path.join(d, 'apps/twins-chores/assets')) }, /flat folder/);
  refuse({ app: 'home' }, /isn't one OpenHouse can use/);
  refuse({ pkg: { name: 'Bad Name!' } }, /name/);
});

test('an app from a plugin: only the groups it was granted, and only its part of the house', () => {
  assert.equal(appAllowed('POST', '/house/settings'), true); // the family's own app
  const r = new Set(['chores']);
  assert.equal(appAllowed('POST', '/house/chore', r), true);
  assert.equal(appAllowed('GET', '/house', r), true);
  assert.equal(appAllowed('POST', '/appdata/progress', r), true);
  for (const [m, p] of [['POST', '/house/settings'], ['POST', '/house/list'], ['POST', '/house/share'], ['GET', '/house/photo/a.jpg'], ['POST', '/voice/say'], ['GET', '/home']]) assert.equal(appAllowed(m, p, r), false, p);
  const view = { v: 3, today: 'd', family: [{ name: 'Maya' }], chores: [1], stars: {}, lists: [2], events: [3], photos: [4], flyer: 'x' };
  assert.deepEqual(Object.keys(houseFor(view, r)).sort(), ['chores', 'family', 'stars', 'today', 'v']);
  assert.deepEqual(Object.keys(houseFor(view, new Set())).sort(), ['today', 'v']);
});

test('the assistant\'s add_plugin: a yes on the card first, then one change that undo takes back', async () => {
  const app = tmp('webapp'); initRepo(app);
  fs.mkdirSync(path.join(app, 'apps/twins-chores'), { recursive: true }); fs.writeFileSync(path.join(app, 'apps/twins-chores/index.html'), 'the family\'s own'); // a clash
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'x', '--allow-empty'], { cwd: app }); execFileSync('git', ['add', '-A'], { cwd: app }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'own app'], { cwd: app });
  const edits = editLock({ APP_DIR: app, UNDO_FILE: path.join(app, '../undo-' + path.basename(app) + '.json'), log: () => {} });
  let style = { tabs: ['today', 'chores', 'apps'] }, asked = [];
  const homeScreen = { style: () => style, setLook: (b, owner) => { assert.equal(edits.holder(), owner); style = { ...style, ...b }; fs.writeFileSync(path.join(app, 'apps/home-style.json'), JSON.stringify(style)); return { style }; } };
  let answer = false;
  const pl = pluginsRoutes({ APP_DIR: app, edits, homeScreen, json: () => {}, body: async () => ({}), local: true, approve: async (title, detail, pin) => { asked.push({ title, detail, pin }); return answer; }, log: () => {} });
  const src = makePlugin(tmp('p'));
  const no = await pl.call('add_plugin', { source: src });
  assert.equal(no.isError, true);
  assert.equal(asked[0].pin, true);
  assert.equal(Object.keys(pl.readAll()).length, 0);

  answer = true;
  const yes = await pl.call('add_plugin', { source: src });
  assert.equal(yes.isError, undefined, yes.content[0].text);
  assert.ok(fs.existsSync(path.join(app, 'apps/twins-chores-2/main.js')), 'a new id: the family\'s own app keeps its name');
  assert.equal(fs.readFileSync(path.join(app, 'apps/twins-chores/index.html'), 'utf8'), 'the family\'s own');
  assert.deepEqual(style.tabs, ['today', 'chores', { id: 'twins-chores-2', name: 'Chores' }, 'apps']);
  assert.equal(style.palette, 'sage');
  assert.deepEqual([...pl.rightsOf('twins-chores-2')], ['chores', 'rewards']);
  assert.equal(pl.rightsOf('twins-chores'), null);
  assert.equal(edits.dirty(), false);
  assert.equal(pl.installed()[0].apps[0].changed, false);
  fs.appendFileSync(path.join(app, 'apps/twins-chores-2/main.js'), '// bigger stars\n');
  assert.equal(pl.installed()[0].apps[0].changed, true);
  fs.writeFileSync(path.join(app, 'apps/twins-chores-2/main.js'), 'document.body.textContent = "twins";\n');

  const u = edits.undoLatest();
  assert.equal(u.ok, true);
  assert.equal(fs.existsSync(path.join(app, 'apps/twins-chores-2')), false);
  assert.equal(pl.rightsOf('twins-chores-2'), null);
  assert.deepEqual(pl.installed(), []);

  // In again, then removed (a card without the PIN), and undo brings it back.
  await pl.call('add_plugin', { source: src, tabs: false });
  const rm = await pl.call('remove_plugin', { name: 'twins-chores' });
  assert.equal(rm.isError, undefined, rm.content[0].text);
  assert.equal(asked.at(-1).pin, false);
  assert.equal(fs.existsSync(path.join(app, 'apps/twins-chores-2')), false);
  edits.undoLatest();
  assert.ok(fs.existsSync(path.join(app, 'apps/twins-chores-2/main.js')));
  assert.deepEqual([...pl.rightsOf('twins-chores-2')], ['chores', 'rewards']);
});

test('an app reaching the web through the tablet: only its own hosts, never the home network; and only its own line on Home', async () => {
  // sources: a folder in a repo, as its web page shows it
  assert.deepEqual(parseSource('github.com/fam/things/tree/main/plugins/lunch'), { kind: 'git', url: 'https://github.com/fam/things.git', ref: 'main', sub: 'plugins/lunch', label: 'github.com/fam/things/plugins/lunch', key: 'github.com/fam/things/tree/main/plugins/lunch' });
  assert.equal(parseSource('github.com/fam/things/tree/main/../../etc'), null);
  // "*.example.com": names under it, never it or a look-alike; checked on the card too
  assert.ok(checkPlugin(makePlugin(tmp('p'), { reaches: ['*.api.example.com'] })).apps[0].reaches.includes('*.api.example.com'));
  assert.throws(() => checkPlugin(makePlugin(tmp('p'), { reaches: ['*.com'] })), /plain host names/);
  assert.deepEqual(['a.api.example.com', 'api.example.com', 'evilapi.example.com', 'a.api.example.com.evil.net'].map((h) => reachMatches(h, ['*.api.example.com'])), [true, false, false, false]);
  const lookup = async (h) => [{ address: h === 'inside.api.example.com' ? '192.168.1.1' : '93.184.216.34' }];
  const ok = async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  const to = (where) => async () => new Response('', { status: 302, headers: { location: where } });
  const r = ['*.api.example.com'];
  assert.equal((await appFetch('a', 'https://x.api.example.com/m', r, { fetch: ok, lookup })).text, '{"a":1}');
  for (const [url, f] of [['https://other.example.com/', ok], ['http://x.api.example.com/', ok], ['https://inside.api.example.com/', ok], ['https://x.api.example.com/', to('https://other.example.com/')],
    ['https://x.api.example.com/', to('https://inside.api.example.com/')], ['https://127.0.0.1/', ok]]) assert.ok((await appFetch('a', url, r, { fetch: f, lookup })).error, url);
  assert.ok((await appFetch('a', 'https://x.api.example.com/', [], { fetch: ok, lookup })).error);
  // DNS rebinding: it connects to the address it checked, never looking the name up again.
  let asked = 0, given = null;
  await appFetch('b', 'https://x.api.example.com/m', r, { lookup: async () => (asked++ ? [{ address: '192.168.1.1' }] : [{ address: '93.184.216.34' }]), fetch: async (u, o) => { given = o.address; return ok(); } });
  assert.equal(asked, 1); assert.equal(given, '93.184.216.34');
  const seen = await new Promise((done) => {
    const srv = net.createServer((sock) => { sock.destroy(); srv.close(); done(true); }).listen(0, '127.0.0.1', () => {
      pinnedFetch(`https://no-such-name.invalid:${srv.address().port}/`, { address: '127.0.0.1', family: 4 }).catch(() => {});
      setTimeout(() => { srv.close(); done(false); }, 3000);
    });
  });
  assert.ok(seen, 'the pinned address was reached without a lookup of the name');
  // the routes: a plugin's app needs "today" for its line; the fetch is a basic (its reaches decide)
  assert.equal(appAllowed('POST', '/today/line', new Set(['family'])), false);
  assert.equal(appAllowed('POST', '/today/line', new Set(['today'])), true);
  assert.equal(appAllowed('POST', '/apps/fetch', new Set()), true);
  // its own line only: another app's and the heartbeat's stay; a person's x keeps the same words down
  const things = thingStore({ DIR: path.join(tmp('t'), 'chats') });
  const soon = () => Date.now() + 3600e3;
  things.put({ text: 'Leave by 4:50 for swim', until: soon() });
  things.putApp('lunch', { text: 'Lunch: Popcorn Chicken', until: soon() });
  things.putApp('other', { text: 'Something else', until: soon() });
  things.putApp('lunch', { text: 'Leave by 4:50 for swim', until: soon() });
  assert.deepEqual(things.all().map((x) => `${x.kind} ${x.text}`).sort(), ['app Leave by 4:50 for swim', 'app Something else', 'suggestion Leave by 4:50 for swim']);
  things.take(things.all().find((x) => x.app === 'lunch').id);
  things.putApp('lunch', { text: 'Leave by 4:50 for swim', until: soon() });
  assert.equal(things.all().filter((x) => x.app === 'lunch').length, 0);
  things.putApp('lunch', { text: 'Lunch: Tacos', until: soon() });
  assert.equal(things.all().find((x) => x.app === 'lunch')?.text, 'Lunch: Tacos');
  things.takeApp('lunch');
  assert.deepEqual(things.all().map((x) => x.kind).sort(), ['app', 'suggestion']);
});

test('a website chosen at setup: never reachable without a yes on the card for it, and only for the app that asked', async () => {
  const app = tmp('webapp'); initRepo(app);
  const edits = editLock({ APP_DIR: app, UNDO_FILE: path.join(app, '../undo-' + path.basename(app) + '.json'), log: () => {} });
  const homeScreen = { style: () => ({}), setLook: () => ({}) };
  let answer = true; const asked = [];
  const pl = pluginsRoutes({ APP_DIR: app, edits, homeScreen, json: () => {}, body: async () => ({}), local: true, approve: async (title, detail, pin) => { asked.push({ title, detail, pin }); return answer; }, log: () => {} });
  const bus = makePlugin(tmp('p'), { name: 'bus', app: 'bus', uses: [], reaches: [{ setup: 'transit-feed', why: 'Live arrivals from your transit agency' }] });
  const other = makePlugin(tmp('p'), { name: 'other', app: 'other', uses: [], reaches: ['api.example.com'] });
  const card = await pl.inspect(bus);
  assert.match(pl.summary(card), /a website you choose when you set it up/);
  assert.equal(pl.put(card).ok, true); assert.equal(pl.put(await pl.inspect(other)).ok, true);
  asked.length = 0;
  assert.deepEqual(pl.reachesOf('bus'), [], 'nothing until a host is chosen');

  // Not a website: refused without a card.
  for (const h of ['*.example.org', '127.0.0.1', 'localhost', 'printer.local', 'feed.example.org:8443', '', 'http://feed.example.org']) assert.equal((await pl.askReach('bus', h)).ok, false, h);
  // An app whose card named no website chosen at setup can't ask; nor can the household's own app.
  assert.equal((await pl.askReach('other', 'feed.example.org')).ok, false);
  fs.mkdirSync(path.join(app, 'apps/mine'), { recursive: true }); fs.writeFileSync(path.join(app, 'apps/mine/index.html'), 'x');
  assert.equal((await pl.askReach('mine', 'feed.example.org')).ok, false);
  assert.equal(asked.length, 0, 'no card for any of those');

  answer = false;
  assert.equal((await pl.askReach('bus', 'feed.example.org')).ok, false);
  assert.equal(asked.length, 1); assert.equal(asked[0].pin, true); assert.match(asked[0].title, /feed\.example\.org/);
  assert.deepEqual(pl.reachesOf('bus'), [], 'a no adds nothing');

  answer = true;
  assert.equal((await pl.askReach('bus', 'Feed.Example.org')).ok, true);
  assert.deepEqual(pl.reachesOf('bus'), ['feed.example.org']);
  assert.deepEqual(pl.reachesOf('other'), ['api.example.com'], 'only the app that asked');
  assert.equal(edits.dirty(), false, 'one change, committed');
  assert.ok(!fs.readFileSync(path.join(app, 'apps/bus/app.json'), 'utf8').includes('feed.example.org'), 'kept in the manifest, not the app\'s files');
  // The app's own files can't widen it: an edit to app.json adds no host.
  fs.writeFileSync(path.join(app, 'apps/bus/app.json'), JSON.stringify({ name: 'Bus', reaches: ['evil.example.net'] }));
  assert.ok(!pl.reachesOf('bus').includes('evil.example.net'));

  assert.equal(pl.forgetReach('bus', 'feed.example.org').ok, true);
  assert.deepEqual(pl.reachesOf('bus'), []);
});

/** A plugin as a tarball (package/ at the root), the way the CDN serves them. */
function tarball(opts) {
  const d = tmp('tgz'); makePlugin(path.join(d, 'package'), opts);
  execFileSync('tar', ['-czf', path.join(d, 'p.tgz'), '-C', d, 'package']);
  return fs.readFileSync(path.join(d, 'p.tgz'));
}
const CDN = 'https://cdn.example.com/releases/plugins/';
const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** A fetch that serves an index and tarballs; anything else fails. */
const served = (files) => async (u) => { const b = files[String(u)]; if (!b) throw new Error('not served: ' + u); return new Response(b); };
function tablet(fetchImpl, more = {}) {
  const app = tmp('webapp'); initRepo(app);
  const edits = editLock({ APP_DIR: app, UNDO_FILE: path.join(app, '../undo-' + path.basename(app) + '.json'), log: () => {} });
  let style = { tabs: ['today', 'apps'] };
  const homeScreen = { style: () => style, setLook: (b) => { style = { ...style, ...b }; return { style }; } };
  fs.mkdirSync(path.join(app, 'plugins'), { recursive: true }); fs.writeFileSync(path.join(app, 'plugins/.v1'), '');
  const pl = pluginsRoutes({ APP_DIR: app, edits, homeScreen, json: () => {}, body: async () => ({}), approve: async () => true, fetchImpl, catalogUrl: CDN + 'index.json', log: () => {}, ...more });
  return { app, edits, pl };
}

test('the gallery: only tarballs on the list\'s own host, and only the exact one reviewed (sha256)', async () => {
  const good = tarball(), other = tarball({ uses: ['chores', 'photos'] });
  const entry = { name: 'twins-chores', title: 'Twins chores', version: '1.2.0', commit: 'abc1234', tarball: CDN + 'twins-chores-1.2.0-abc1234.tgz', sha256: hex(good), rights: ['Uses chores.'] };
  const clean = cleanCatalog({ plugins: [entry, { ...entry, name: 'elsewhere', tarball: 'https://evil.example/x.tgz' }, { ...entry, name: 'plain', tarball: CDN.replace('https', 'http') + 'x.tgz' },
    { ...entry, name: 'no-sha', sha256: undefined }, { ...entry, name: 'pic', image: 'https://evil.example/p.png' }] }, CDN + 'index.json');
  assert.deepEqual(clean.map((e) => e.name), ['twins-chores', 'pic']);
  assert.equal(clean[1].image, undefined);

  // The list's tarball, as reviewed: added by name, marked reviewed.
  const index = JSON.stringify({ plugins: [entry] });
  const t = tablet(served({ [CDN + 'index.json']: index, [entry.tarball]: good }));
  const yes = await t.pl.call('add_plugin', { source: 'twins-chores' });
  assert.equal(yes.isError, undefined, yes.content[0].text);
  assert.equal(t.pl.readAll()['twins-chores'].reviewed, true);
  assert.equal(t.pl.readAll()['twins-chores'].source, 'catalog:twins-chores');

  // The same address serving something else (asking for more): refused, nothing added.
  const t2 = tablet(served({ [CDN + 'index.json']: index, [entry.tarball]: other }));
  const no = await t2.pl.call('add_plugin', { source: 'twins-chores' });
  assert.equal(no.isError, true);
  assert.deepEqual(t2.pl.readAll(), {});
  assert.equal(t2.pl.rightsOf('twins-chores'), null);
});

test('both versions put together: the household\'s changes and theirs, and never more rights than the update\'s card', async () => {
  const v1 = tarball(), v2 = tarball({ extra: (d) => { fs.writeFileSync(path.join(d, 'apps/twins-chores/main.js'), 'document.body.textContent = "twins";\nconsole.log("v2");\n'); fs.writeFileSync(path.join(d, 'apps/twins-chores/new.css'), 'b{}'); } });
  const e1 = { name: 'twins-chores', title: 'Twins chores', version: '1.2.0', tarball: CDN + 'v1.tgz', sha256: hex(v1) };
  const files = { [CDN + 'index.json']: JSON.stringify({ plugins: [e1] }), [CDN + 'v1.tgz']: v1, [CDN + 'v2.tgz']: v2 };
  let asked = null;
  const t = tablet(served(files), { ai: async ({ input }) => { asked = input[0].content; return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ok: true, files: { 'twins-chores/main.js': 'document.body.textContent = "twins!";\nconsole.log("v2");\n// bigger stars\n', 'twins-chores/app.json': JSON.stringify({ name: 'Twins chores', uses: ['chores', 'rewards', 'photos', 'family'] }) }, note: 'Both.' }) }] }] }; } });
  assert.equal((await t.pl.call('add_plugin', { source: 'twins-chores' })).isError, undefined);
  // The household changes it, and its app.json asks for the photos too: that grants nothing.
  const dir = path.join(t.app, 'apps/twins-chores');
  fs.writeFileSync(path.join(dir, 'main.js'), 'document.body.textContent = "twins!";\n// bigger stars\n');
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ name: 'Twins chores', uses: ['chores', 'rewards', 'photos'] }));
  const hand = { id: 'x', kind: 'edit', text: 'Bigger stars' }; t.edits.tryAcquire(hand); t.edits.finish(hand, true);
  assert.equal(t.pl.installed().find((x) => x.name === 'twins-chores').basedOn, 'Twins chores 1.2.0');

  files[CDN + 'index.json'] = JSON.stringify({ plugins: [{ ...e1, version: '1.3.0', tarball: CDN + 'v2.tgz', sha256: hex(v2) }] });
  await t.pl.gallery({ fresh: true });
  const p = await t.pl.inspect('twins-chores', {});
  const r = await t.pl.merge('twins-chores', p);
  assert.equal(r.ok, true, r.error);
  assert.ok(asked.includes('--- base'), 'the model sees the version both started from');
  assert.ok(fs.readFileSync(path.join(dir, 'main.js'), 'utf8').includes('bigger stars'));
  assert.ok(fs.existsSync(path.join(dir, 'new.css')), 'a file only theirs added comes in');
  assert.deepEqual([...t.pl.rightsOf('twins-chores')].sort(), ['chores', 'rewards'], 'only what the cards granted');
  assert.ok(t.pl.installed().find((x) => x.name === 'twins-chores').basedOn);
  assert.equal(t.edits.dirty(), false);

  // A merge that can't be done cleanly changes nothing.
  const before = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const t2 = t;
  const bad = await pluginsRoutes({ APP_DIR: t.app, edits: t.edits, homeScreen: { style: () => ({}), setLook: () => ({}) }, json: () => {}, body: async () => ({}), fetchImpl: served(files), catalogUrl: CDN + 'index.json', log: () => {},
    ai: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok": false, "reason": "they contradict"}' }] }] }) });
  fs.writeFileSync(path.join(dir, 'main.js'), before + '// more\n'); const hand2 = { id: 'y', kind: 'edit', text: 'More' }; t2.edits.tryAcquire(hand2); t2.edits.finish(hand2, true);
  const p3 = { ...p, sha256: 'f'.repeat(64), apps: [{ ...p.apps[0], files: { ...p.apps[0].files, 'main.js': Buffer.from('document.body.textContent = "v3";\n') } }] };
  const r2 = await bad.merge('twins-chores', p3);
  assert.equal(r2.kept, true, JSON.stringify(r2));
  assert.equal(fs.readFileSync(path.join(dir, 'main.js'), 'utf8'), before + '// more\n');
});

test('the web through the tablet as bytes: the same hosts only', async () => {
  const r = await appFetch('bytes-app', 'https://elsewhere.example/feed.pb', ['feed.example.org'], { binary: true, lookup: async () => [{ address: '93.184.216.34', family: 4 }], fetch: async () => { throw new Error('not reached'); } });
  assert.equal(r.status, 403);
});
