// The edit lock, undo and the home screen's per-run context, against a real bridge with the fake agent.
//   node --test bridge/test/*.test.mjs   (or: cd bridge && npm test)
// Each server runs from a copy of bridge/ in a temp folder, with its own webapp git repo, so nothing
// here touches the checkout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { initRepo, editLock, quietRepo } from '../edits.js';
import { plain } from '../backup.js';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// The bridge wants the display's secret on every request (auth.js).
const TOKEN = 'test-token', H = { 'x-openhouse-token': TOKEN };

async function startBridge(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-test-'));
  fs.cpSync(BRIDGE, path.join(root, 'bridge'), { recursive: true, filter: (f) => !/[\\/](node_modules|test|public)$|\.jsonl$|undo\.json$/.test(f) });
  const app = path.join(root, 'webapp');
  fs.mkdirSync(app); initRepo(app);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'bridge/server.js')], {
    env: { ...process.env, PORT: String(port), AGENT: 'fake', VOICE_DIR: path.join(root, 'novoice'), FAKE_RUN_MS: '1500', OPENHOUSE_TOKEN: TOKEN, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(url + '/state', { headers: H }); break; } catch { await wait(100); } }
  const git = (...a) => execFileSync('git', a, { cwd: app, encoding: 'utf8' }).trim();
  return {
    url, app, root, git, log: () => log,
    stop: () => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); },
    /** One conversation turn; resolves with its events once it's done. */
    async chat(text, who, extra = {}) {
      const r = await fetch(url + '/chat', { method: 'POST', headers: H, body: JSON.stringify({ text, who, ...extra }) });
      const events = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { events, id: events.find((e) => e.type === 'start')?.id, done: events.find((e) => e.type === 'done') };
    },
    post: async (p, b = {}) => { const r = await fetch(url + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; },
    get: async (p) => (await fetch(url + p, { headers: H })).json(),
    /** Commits since the start, oldest first: { sha, msg, files } */
    commits() {
      return git('log', '--reverse', '--format=%H\t%s', 'HEAD').split('\n').slice(1).map((l) => {
        const [sha, msg] = l.split('\t');
        return { sha, msg, files: git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean) };
      });
    },
    read: (f) => { try { return fs.readFileSync(path.join(app, f), 'utf8'); } catch { return null; } },
    clean: () => !git('status', '--porcelain'),
  };
}

test('nothing in the repo itself runs: hooks and programs in its config, as a restored backup could bring', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-quiet-')), app = path.join(root, 'webapp'), mark = path.join(root, 'ran');
  fs.mkdirSync(app); initRepo(app);
  const hook = path.join(app, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${mark}'\n`, { mode: 0o755 });
  execFileSync('git', ['config', 'filter.x.clean', `touch '${mark}'; cat`], { cwd: app });
  const edits = editLock({ APP_DIR: app, UNDO_FILE: path.join(root, 'undo.json'), log: () => {} });
  const hand = { id: 'h', kind: 'edit', text: 'A change' };
  edits.tryAcquire(hand); fs.writeFileSync(path.join(app, 'apps/a.txt'), 'a'); edits.finish(hand, true);
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: app, encoding: 'utf8' }).trim(), 'A change');
  assert.equal(fs.existsSync(mark), false, 'the hook never ran');
  quietRepo(app);
  assert.equal(fs.existsSync(hook), false);
  const cfg = execFileSync('git', ['config', '--file', path.join(app, '.git/config'), '--list'], { encoding: 'utf8' });
  assert.doesNotMatch(cfg, /^filter\./m);
  assert.match(cfg, /^core\.hookspath=\/dev\/null$/m);
  fs.rmSync(root, { recursive: true, force: true });
});

// A restored repo whose filter program would run on the bridge's next `git add`, once quietRepo has seen it.
function restoredRepo(make) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhouse-quiet-')), app = path.join(root, 'webapp'), mark = path.join(root, 'ran');
  fs.mkdirSync(app); initRepo(app);
  fs.writeFileSync(path.join(app, '.gitattributes'), '* filter=x diff=x\n');
  make({ root, app, run: `touch '${mark}'; cat` });
  return { root, app, mark };
}
function changeOnce(root, app) {
  const edits = editLock({ APP_DIR: app, UNDO_FILE: path.join(root, 'undo.json'), log: () => {} });
  const hand = { id: 'h', kind: 'edit', text: 'A change' };
  edits.tryAcquire(hand); fs.writeFileSync(path.join(app, 'apps/a.txt'), 'a'); edits.finish(hand, true);
  return execFileSync('git', ['log', '--format=%s'], { cwd: app, encoding: 'utf8' }).trim().split('\n');
}

test('a restored repo with a per-worktree config naming a filter runs nothing, and keeps its history', () => {
  const { root, app, mark } = restoredRepo(({ app, run }) => {
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: app });
    execFileSync('git', ['config', '--worktree', 'filter.x.clean', run], { cwd: app });
    execFileSync('git', ['config', '--worktree', 'diff.x.textconv', run], { cwd: app });
    fs.mkdirSync(path.join(app, '.git/info'), { recursive: true });
    fs.writeFileSync(path.join(app, '.git/info/attributes'), '* filter=x\n');
  });
  assert.equal(quietRepo(app), true);
  assert.equal(fs.existsSync(path.join(app, '.git/config.worktree')), false);
  const log = changeOnce(root, app);
  assert.deepEqual(log, ['A change', 'Starting point']);
  assert.equal(fs.existsSync(mark), false, 'the filter never ran');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a restored repo whose .git is a file pointing elsewhere becomes a repo of its own that runs nothing', () => {
  const { root, app, mark } = restoredRepo(({ root, app, run }) => {
    const away = path.join(root, 'away.git');
    fs.renameSync(path.join(app, '.git'), away);
    execFileSync('git', ['config', '--file', path.join(away, 'config'), 'filter.x.clean', run]);
    execFileSync('git', ['config', '--file', path.join(away, 'config'), 'core.worktree', app]);
    fs.writeFileSync(path.join(app, '.git'), `gitdir: ${away}\n`);
  });
  assert.equal(quietRepo(app), true);
  assert.ok(fs.lstatSync(path.join(app, '.git')).isDirectory());
  const log = changeOnce(root, app);
  assert.equal(log[0], 'A change');
  assert.equal(fs.existsSync(mark), false, 'the filter never ran');
  assert.equal(fs.readFileSync(path.join(app, 'README.md'), 'utf8'), 'apps\n', 'the files stay');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a restored tree: no repo inside the repo, no node_modules, nothing but plain files and folders, and a pipe for a config hangs nothing', () => {
  const { root, app, mark } = restoredRepo(({ app, run }) => {
    const x = path.join(app, 'apps/x');
    fs.mkdirSync(x, { recursive: true }); fs.writeFileSync(path.join(x, 'index.html'), 'x');
    execFileSync('git', ['init', '-q'], { cwd: x });
    execFileSync('git', ['config', 'filter.x.clean', run], { cwd: x });
    fs.writeFileSync(path.join(x, '.gitattributes'), '* filter=x\n');
    fs.mkdirSync(path.join(app, 'node_modules/vite'), { recursive: true }); fs.writeFileSync(path.join(app, 'node_modules/vite/vite.js'), run);
    fs.mkdirSync(path.join(app, 'apps/y/.GIT/hooks'), { recursive: true }); fs.writeFileSync(path.join(app, 'apps/y/.GIT/config'), `[core]\n\thooksPath = ${run}\n`); // (a disk that doesn't tell .GIT from .git)
    fs.symlinkSync('/etc', path.join(app, 'apps/link'));
    execFileSync('mkfifo', [path.join(app, 'apps/pipe')]);
  });
  assert.equal(plain(app), true);
  assert.equal(quietRepo(app), true);
  for (const gone of ['apps/x/.git', 'apps/y/.GIT', 'node_modules', 'apps/link', 'apps/pipe']) assert.equal(fs.existsSync(path.join(app, gone)) || isLink(path.join(app, gone)), false, gone);
  assert.ok(fs.existsSync(path.join(app, 'apps/x/index.html')), 'the inner repo\'s files stay');
  changeOnce(root, app);
  assert.equal(fs.existsSync(mark), false, 'nothing ran');
  // quietRepo on its own: a .git holding a pipe is made fresh, never read (reading it would wait forever).
  fs.rmSync(path.join(app, '.git/config')); execFileSync('mkfifo', [path.join(app, '.git/config')]);
  assert.equal(quietRepo(app), true);
  assert.ok(fs.lstatSync(path.join(app, '.git/config')).isFile());
  fs.rmSync(root, { recursive: true, force: true });
});
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

let b;
before(async () => { b = await startBridge(); });
after(() => b?.stop());

test('a conversation that only talks does not commit another one\'s half-done edits', async () => {
  const n = b.commits().length;
  const mom = b.chat('make the clock bigger [edit:apps/clock/a.txt=one] [wait:800] [edit:apps/clock/a.txt=two]', 'Mom');
  await wait(200);
  const kid = await b.chat('what is the weather', 'Kid'); // finishes while Mom's turn is mid-edit
  assert.equal(kid.done.ok, true);
  assert.equal(b.commits().length, n, 'the talking turn committed nothing');
  await mom;
  const c = b.commits().slice(n);
  assert.equal(c.length, 1);
  assert.equal(c[0].msg, 'Mom: make the clock bigger [edit:apps/clock/a.txt=one] [wait:800] [edit:apps/clock/a.txt=two]');
  assert.deepEqual(c[0].files.filter((f) => !f.startsWith('plugins/')), ['apps/clock/a.txt']);
  assert.equal(b.read('apps/clock/a.txt'), 'one\ntwo\n');
  assert.ok(b.clean());
});

test('two overlapping turns that both edit each commit their own change, with their own words', async () => {
  const n = b.commits().length;
  const mom = b.chat('a game [start_editing] [edit:apps/game/g.txt=mom1] [wait:600] [edit:apps/game/g.txt=mom2]', 'Mom');
  await wait(150);
  const kid = b.chat('a pet [start_editing] [edit:apps/pet/p.txt=kid]', 'Kid'); // waits for Mom's change to end
  const [m, k] = await Promise.all([mom, kid]);
  assert.equal(m.done.ok, true); assert.equal(k.done.ok, true);
  assert.ok(k.events.some((e) => e.type === 'status' && /Waiting/.test(e.text)), 'the second one said it was waiting');
  const c = b.commits().slice(n);
  assert.equal(c.length, 2);
  assert.match(c[0].msg, /^Mom: a game/); assert.deepEqual(c[0].files.filter((f) => !f.startsWith('plugins/')), ['apps/game/g.txt']);
  assert.match(c[1].msg, /^Kid: a pet/); assert.deepEqual(c[1].files.filter((f) => !f.startsWith('plugins/')), ['apps/pet/p.txt']);
  assert.ok(b.clean());
});

test('an edit made with a shell command (only the watcher sees it) is still that turn\'s change', async () => {
  const n = b.commits().length;
  const r = await b.chat('quiet edit [sh:apps/shell/s.txt=x] [wait:600]', 'Dad');
  assert.equal(r.done.ok, true);
  const c = b.commits().slice(n);
  assert.equal(c.length, 1); assert.match(c[0].msg, /^Dad: quiet edit/); assert.deepEqual(c[0].files.filter((f) => !f.startsWith('plugins/')), ['apps/shell/s.txt']);
});

test('"undo" right after a change that was never saved takes back that change, not the one before it', async () => {
  await b.chat('keep [edit:apps/v/keep.txt=keep]', 'Mom');
  fs.writeFileSync(path.join(b.app, 'apps/v/loose.txt'), 'loose\n'); // a turn's edit nobody committed
  const r = (await b.post('/undo')).body;
  assert.equal(r.ok, true);
  assert.equal(b.read('apps/v/loose.txt'), null, 'the unsaved change is the one taken back');
  assert.equal(b.read('apps/v/keep.txt'), 'keep\n', 'the change before it stays');
});

test('changes made by hand before a turn are not that turn\'s change', async () => {
  fs.writeFileSync(path.join(b.app, 'apps/hand.txt'), 'by hand\n');
  const n = b.commits().length;
  await b.chat('mine [edit:apps/mine/m.txt=m]', 'Kid');
  const c = b.commits().slice(n);
  assert.deepEqual(c.map((x) => x.msg.split(' ')[0]), ['checkpoint', 'Kid:']);
  assert.deepEqual(c[1].files.filter((f) => !f.startsWith('plugins/')), ['apps/mine/m.txt']);
});

test('undo of one change by id keeps the ones after it; undo takes back the latest', async () => {
  await b.chat('x [edit:apps/u/x.txt=x]', 'Mom');
  await b.chat('y [edit:apps/u/y.txt=y]', 'Mom');
  await b.chat('z [edit:apps/u/z.txt=z]', 'Mom');
  const y = b.commits().find((c) => c.msg.startsWith('Mom: y '));
  const before = b.commits().length;
  const r = await b.chat(`undo the y change [undo:${y.sha.slice(0, 8)}]`, 'Kid');
  assert.match(r.done.text, /Took back: Mom: y/);
  assert.equal(b.read('apps/u/y.txt'), null);
  assert.equal(b.read('apps/u/x.txt'), 'x\n'); assert.equal(b.read('apps/u/z.txt'), 'z\n');
  assert.equal(b.commits().length, before + 1, 'a revert commit; nothing dropped from history');
  // "undo" takes back the latest change: that undo was one, so y comes back; then z goes
  assert.match((await b.post('/undo')).body.undid, /^Undo: Mom: y/);
  assert.equal(b.read('apps/u/y.txt'), 'y\n');
  assert.match((await b.post('/undo')).body.undid, /^z /);
  assert.equal(b.read('apps/u/z.txt'), null);
  assert.equal(b.read('apps/u/x.txt'), 'x\n');
  assert.ok(b.git('log', '--format=%s').includes('Mom: y'), 'history is kept');
  assert.ok(b.clean());
});

test('a stopped turn puts back its half-done change and lets go of the lock', async () => {
  const n = b.commits().length, head = b.git('rev-parse', 'HEAD');
  const p = b.chat('a long one [edit:apps/stop/s.txt=half] [wait:5000] [edit:apps/stop/s.txt=rest]', 'Mom');
  await wait(400);
  assert.equal(b.read('apps/stop/s.txt'), 'half\n');
  const { id } = (await b.get('/chats'))[0];
  await b.post('/chat/stop', { id });
  const r = await p;
  assert.equal(r.done.ok, false);
  assert.equal(b.read('apps/stop/s.txt'), null);
  assert.equal(b.commits().length, n); assert.equal(b.git('rev-parse', 'HEAD'), head);
  assert.ok(b.clean());
  const next = await b.chat('after [edit:apps/stop/after.txt=ok]', 'Kid');
  assert.equal(next.done.ok, true);
  assert.match(b.commits().at(-1).msg, /^Kid: after/);
});

test('a turn that throws puts back what it changed', async () => {
  const head = b.git('rev-parse', 'HEAD');
  const r = await b.chat('boom [edit:apps/boom/b.txt=x] [throw]', 'Kid');
  assert.equal(r.done.ok, false);
  assert.equal(b.read('apps/boom/b.txt'), null);
  assert.equal(b.git('rev-parse', 'HEAD'), head);
  assert.ok(b.clean());
});

test('a cancelled build puts back only its own work and never resets history', async () => {
  const head = b.git('rev-parse', 'HEAD');
  assert.equal((await b.post('/request', { text: 'tint it', who: 'Mom' })).status, 202);
  await wait(300);
  assert.equal((await b.post('/cancel')).status, 200);
  await wait(1800); // the fake agent stops
  assert.equal(b.git('rev-parse', 'HEAD'), head);
  assert.ok(b.clean());
  const r = await b.chat('after the build [edit:apps/b2/x.txt=x]', 'Kid');
  assert.equal(r.done.ok, true); assert.match(b.commits().at(-1).msg, /^Kid: after the build/);
});

test('a build asked for while one is being made waits its turn, and both go in', async () => {
  assert.equal((await b.post('/request', { text: 'first queued build', who: 'Mom' })).status, 202);
  const second = await b.post('/request', { text: 'second queued build', who: 'Mom' });
  assert.equal(second.status, 202); assert.equal(second.body.queued, 1);
  const both = () => /first queued build[\s\S]*second queued build/.test(b.read('src/theme.css') || '');
  for (let i = 0; i < 50 && !(both() && b.clean()); i++) await wait(200);
  assert.ok(both(), 'the second ran after the first'); assert.ok(b.clean());
});

async function homeIsolation(br) {
  const mom = br.chat('recipe [wait:300] [note:Mom note] [progress:Mom working] [wait:400]', 'Mom');
  await wait(100);
  const kid = br.chat('bye [note:Kid note] [end] [wait:500]', 'Kid');
  const [m, k] = await Promise.all([mom, kid]);
  const homeScreen = await br.get('/home');
  const note = (t) => homeScreen.notes.find((n) => n.title === t);
  assert.equal(note('Mom note').askedBy, 'Mom'); assert.equal(note('Mom note').conversation, m.id);
  assert.equal(note('Kid note').askedBy, 'Kid'); assert.equal(note('Kid note').conversation, k.id);
  assert.ok(m.events.some((e) => e.type === 'progress' && e.text === 'Mom working'));
  assert.ok(!k.events.some((e) => e.type === 'progress'), "Mom's progress didn't go to Kid");
  assert.equal(k.done.end, true, 'Kid ended their conversation');
  assert.ok(!m.done.end, "Kid's end_conversation didn't end Mom's");
  assert.deepEqual(m.events.find((e) => e.type === 'notes').notes.map((n) => n.title), ['Mom note']);
  assert.deepEqual(k.events.find((e) => e.type === 'notes').notes.map((n) => n.title), ['Kid note']);
}

test('home-screen tools: each overlapping turn gets its own context (per-turn tokens)', () => homeIsolation(b));

test('unknown home-screen tokens are refused', async () => {
  const r = await fetch(b.url + '/home/mcp', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(r.status, 401);
});
