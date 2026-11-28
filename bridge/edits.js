// Who may change the family's apps (webapp/) right now, and taking a change back.
//
// One edit lock: whoever holds it (a conversation turn, the app builder, a delete, an undo) is the
// only one changing files, so when it lets go, everything that changed is its change and is
// committed with its words. Conversations still run side by side: a turn takes the lock only when it
// starts editing (the start_editing tool, an edit the agent reports, or a file changing while it is
// the only conversation running). A turn that wants to edit while another holds it waits.
//
// Undo is `git revert` of that change's commit, so the changes made after it stay, and HEAD never
// moves back. A run that fails, is stopped or throws puts back only the files changed since it took
// the lock (HEAD stays). Only the watchdog's explicit /restore resets.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readJson, writeJson, unsaved } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';

/**
 * For every git the bridge runs on the household's repos: nothing in the repo itself runs (hooks, a file monitor, a
 * signing program, anything inside an embedded repo), whatever its .git holds, as when it came back from a backup.
 * Filter, diff and merge programs come only from config, and quietRepo gives a restored repo a fresh one.
 * device/runtime-start.sh passes the same settings.
 */
export const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false'];

// What may stay of a repo's own config: how its objects and refs are stored (read with git config --file, which runs
// nothing and follows no includes). The rest of it, and every other config git would read from .git, goes.
const FORMAT = { 'extensions.objectformat': /^(sha1|sha256)$/, 'extensions.refstorage': /^(files|reftable)$/ };
// Files in .git that point git somewhere else: another git dir, other objects.
const POINTERS = ['commondir', 'gitdir', 'objects/info/alternates', 'objects/info/http-alternates'];
// Hooks, the per-worktree config, attributes, linked worktrees and submodules' repos, old remotes, and any operation
// left half-done: none are ours.
const DROP = ['hooks', 'config.worktree', 'info/attributes', 'worktrees', 'modules', 'branches', 'remotes', 'sequencer', 'rebase-merge',
  'rebase-apply', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index.lock'];

/** Anything in dir that isn't a plain file or folder: a link, a pipe, a socket, a device. */
function hasOdd(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (hasOdd(path.join(dir, e.name))) return true; } else if (!e.isFile()) return true;
  }
  return false;
}
/** Every repo inside this one (a .git below its top, folder or file, in any case: a disk may not tell .GIT from .git)
 *  taken out: its files stay, as plain files. A folder it can't read throws: it could hold one. */
function dropNested(dir, top = true) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name.toLowerCase() === '.git') { if (!top) fs.rmSync(p, { recursive: true, force: true }); continue; }
    if (e.isDirectory()) dropNested(p, false);
  }
}

/**
 * A repo that came from somewhere else (a backup being restored), made so that nothing of its own runs: a fresh
 * config holding only how it is stored, with hooks pointed nowhere, and the rest of DROP gone; a repo inside it is
 * taken out (its files stay). A .git that isn't a plain folder (a file pointing elsewhere, a link), holds anything
 * but plain files and folders or points outside itself, or that git can't read after that, is replaced by a new repo
 * of the files as they are (the history of the changes doesn't come back). Returns false when there's no .git at all.
 */
export function quietRepo(repo) {
  if (!fs.lstatSync(repo).isDirectory()) return false; // (a file restored: no repo in it)
  dropNested(repo); // (throws when part of it can't be read: the restore stops there)
  const dotGit = path.join(repo, '.git');
  let st; try { st = fs.lstatSync(dotGit); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const g = (...a) => execFileSync('git', [...GIT_SAFE, '-c', 'user.name=display', '-c', 'user.email=display@local', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let fresh = !st.isDirectory() || hasOdd(dotGit) || POINTERS.some((p) => fs.existsSync(path.join(dotGit, p)));
  const keep = {};
  if (!fresh) {
    const cfg = path.join(dotGit, 'config');
    for (const [k, ok] of Object.entries(FORMAT)) {
      let v = '';
      try { v = execFileSync('git', ['config', '--file', cfg, '--get', k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase(); } catch {}
      if (v && !ok.test(v)) fresh = true; else if (v) keep[k] = v;
    }
  }
  if (!fresh) {
    for (const d of DROP) fs.rmSync(path.join(dotGit, d), { recursive: true, force: true });
    const ext = Object.entries(keep);
    const lines = ['[core]', `\trepositoryformatversion = ${ext.length ? 1 : 0}`, '\tbare = false', '\tlogallrefupdates = true', '\thooksPath = /dev/null'];
    if (ext.length) lines.push('[extensions]', ...ext.map(([k, v]) => `\t${k.split('.')[1]} = ${v}`));
    fs.rmSync(path.join(dotGit, 'config'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dotGit, 'config'), lines.join('\n') + '\n');
    try { g('rev-parse', '--verify', '-q', 'HEAD^{commit}'); } catch { fresh = true; }
  }
  if (fresh) {
    fs.rmSync(dotGit, { recursive: true, force: true });
    g('init', '-q', '--template=');
    g('config', 'core.hooksPath', '/dev/null');
    g('add', '-A');
    g('commit', '-qm', 'Restored from a backup', '--allow-empty');
    g('tag', '-f', 'last-good');
  }
  return true;
}

export function editLock({ APP_DIR, UNDO_FILE, onLanded = () => {}, beforeCommit = null, log = (...a) => console.log('[edits]', ...a) }) {
  const git = (...args) => execFileSync('git', [...GIT_SAFE, '-c', 'user.name=display', '-c', 'user.email=display@local', ...args], {
    cwd: APP_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const dirty = () => !!git('status', '--porcelain');
  const exists = (sha) => { try { git('cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; } };
  // Every commit made here passes through snapshot: the apps it changed are handed to beforeCommit first (plugins.js
  // keeps each app's plugin manifest right: a new app becomes a local plugin, a changed built-in a local one that
  // overrides it), so the manifest lands in the same commit as the files and undo takes both back together.
  let hook = beforeCommit;
  function snapshot(msg) {
    git('add', '-A');
    if (hook) {
      const apps = new Set(git('diff', '--cached', '--no-renames', '--name-only').split('\n').map((f) => f.match(/^apps\/([^/]+)\//)?.[1]).filter(Boolean));
      if (apps.size) { try { if (hook(apps)) git('add', '-A'); } catch (e) { log('plugin manifests not updated:', e.message); } }
    }
    git('commit', '-qm', msg);
  }
  const inHistory = (sha) => { try { git('merge-base', '--is-ancestor', sha, 'HEAD'); return true; } catch { return false; } };

  // ---- the undo stack: the family's latest changes, newest last. Kept on disk for "undo" after a restart. ----
  let stack = (() => { const s = readJson(registered('undo', UNDO_FILE), []); return Array.isArray(s) ? s : []; })();
  // Older entries kept the commit *before* the change ({ base }): the change is the next commit after it.
  stack = stack.map((e) => {
    if (e.commit || !e.base) return e;
    try { const c = git('rev-list', '--reverse', '--ancestry-path', `${e.base}..HEAD`).split('\n')[0]; return c ? { commit: c, text: e.text, who: e.who || null } : null; } catch { return null; }
  }).filter(Boolean);
  // null when saved, else what to say (store.js unsaved). A change is in git either way; the list here only says which
  // to take back. Undo checks first that the list can be saved, so it never takes a change back that the list on disk
  // would still offer after a restart.
  const saveStack = () => { try { writeJson(UNDO_FILE, stack); return null; } catch (e) { console.error('[edits] undo list not saved:', e.message); return unsaved(e).error; } };

  // ---- the lock ----
  let holder = null; // { id, kind, who, text, base }
  const queue = []; // [{ owner, opts, resolve }]
  const turns = new Map(); // conversation turns running now: id -> owner
  let nextId = 1;

  function take(owner, { checkpoint = false } = {}) {
    // Changes nobody owns (made by hand) become their own commit first, so they aren't this change.
    if (checkpoint && dirty()) snapshot('checkpoint');
    holder = owner;
    owner.base = git('rev-parse', 'HEAD');
  }
  function tryAcquire(owner, opts) {
    if (holder === owner) return true;
    if (holder || queue.length) return false;
    take(owner, opts);
    return true;
  }
  /** Wait for the lock. Resolves true once held, false on timeout or abort. */
  function acquire(owner, { signal, timeoutMs, ...opts } = {}) {
    if (tryAcquire(owner, opts)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = { owner, opts, resolve: (v) => { clearTimeout(t); signal?.removeEventListener('abort', gone); resolve(v); } };
      const gone = () => { const i = queue.indexOf(w); if (i >= 0) { queue.splice(i, 1); w.resolve(false); } };
      const t = timeoutMs ? setTimeout(gone, timeoutMs) : null;
      signal?.addEventListener('abort', gone);
      queue.push(w);
    });
  }
  function release(owner) {
    if (holder !== owner) return;
    holder = null;
    while (!holder && queue.length) {
      const w = queue.shift();
      try { take(w.owner, w.opts); w.resolve(true); } catch (e) { log('lock hand-over failed:', e.message); w.resolve(false); }
    }
  }

  /**
   * The holder's changes so far become one commit, with its words. Returns the commit, or null if nothing changed.
   * quiet: not one of the family's changes (an Opie update of a built-in plugin, the move to plugins): "undo"
   * doesn't take it back, though undo_change and undo_plugin still can.
   */
  function commit(owner, { quiet = false } = {}) {
    if (holder !== owner || !dirty()) return null;
    const msg = `${owner.who ? owner.who + ': ' : ''}${owner.text}`.slice(0, 300);
    snapshot(msg);
    const sha = git('rev-parse', 'HEAD');
    if (quiet) { git('tag', '-f', 'last-good', sha); owner.base = sha; owner.changed = true; return sha; }
    land(sha, owner.text, owner.who);
    owner.base = sha; owner.changed = true;
    return sha;
  }
  function land(sha, text, who) {
    git('tag', '-f', 'last-good', sha);
    stack.push({ commit: sha, text, who: who || null });
    if (stack.length > 30) stack.shift();
    saveStack();
    onLanded(text);
  }
  /** Put back what the holder changed since it took the lock (or since its last commit). HEAD stays. */
  function discard(owner) {
    if (holder !== owner || !dirty()) return false;
    git('reset', '-q'); // unstage only
    git('checkout', '--', '.');
    git('clean', '-fdq');
    log(`put back what ${owner.kind}${owner.who ? ' (' + owner.who + ')' : ''} changed: "${String(owner.text).slice(0, 60)}"`);
    return true;
  }
  /** It's done: ok keeps (commits) its change, anything else puts it back. Then the next one may edit. */
  function finish(owner, ok, opts) {
    let sha = null;
    try { if (holder === owner) { if (ok) sha = commit(owner, opts); else discard(owner); } }
    finally { release(owner); }
    return sha;
  }

  const busyText = () => holder && `Busy with ${holder.who ? holder.who + "'s" : 'another'} change ("${String(holder.text || '').slice(0, 80)}"); try again in a moment.`;

  /** Take back one change: a revert commit (so later changes stay). As `by` (a turn holding the lock), or on its own. */
  function revert(sha, by) {
    const msg = git('log', '-1', '--format=%s', sha);
    if (by && holder === by) commit(by); // its own edits so far are a change of their own first
    try { git('revert', '--no-edit', sha); }
    catch (e) {
      try { git('revert', '--abort'); } catch {}
      return { ok: false, error: `Later changes touched the same code, so it can't be taken back on its own. (${String(e.stderr || e.message).slice(0, 300)})` };
    }
    if (by && holder === by) by.base = git('rev-parse', 'HEAD');
    return { ok: true, msg };
  }
  function withLock(by, fn, { checkpoint = true } = {}) {
    if (by && holder === by) return fn();
    const owner = { id: `x${nextId++}`, kind: 'undo', who: null, text: 'undo' };
    if (!tryAcquire(owner, { checkpoint })) return { ok: false, error: busyText() };
    try { return fn(); } finally { release(owner); }
  }

  return {
    setBeforeCommit: (fn) => { hook = fn; },
    git, dirty, snapshot, tryAcquire, acquire, release, commit, discard, finish,
    holder: () => holder,
    busyText,
    stack: () => stack,

    /** A conversation turn starts: it may edit later. */
    begin({ who = null, text = '', conversation = null } = {}) {
      const t = { id: `t${nextId++}`, kind: 'chat', who, text, conversation, started: Date.now() };
      // Nobody is changing anything right now, so what's uncommitted was made by hand: not this turn's change.
      if (!holder && !queue.length && !turns.size && dirty()) snapshot('checkpoint');
      turns.set(t.id, t);
      return t;
    },
    /** It's about to edit, or just did (an edit it reported): it holds the lock now if it's free. */
    claim(t) {
      if (holder === t) return true;
      if (tryAcquire(t)) { log(`${t.who || 'someone'} is editing: "${String(t.text).slice(0, 60)}"`); return true; }
      if (holder) log(`${t.who || 'a conversation'} edited while ${holder.who || holder.kind} holds the lock`);
      return false;
    },
    /** start_editing: wait (up to timeoutMs) until no one else is changing the apps. */
    async startEditing(t, { timeoutMs = 150e3, signal } = {}) {
      if (holder === t) return { ok: true };
      const ok = await acquire(t, { timeoutMs, signal });
      return ok ? { ok: true } : { ok: false, error: busyText() || 'Someone else is still changing the apps.' };
    },
    /** The turn ended. Its change (if it made one) is committed when ok, put back when not. */
    end(t, ok) {
      turns.delete(t.id);
      // It changed files without saying so and the watcher's word came late (or not at all): nobody else was editing and
      // what was there before it began was set aside (begin), so what's changed now is this turn's.
      if (ok && !holder && !queue.length && !turns.size && dirty()) tryAcquire(t);
      return finish(t, ok);
    },
    turns: () => [...turns.values()],

    /** "Undo": the latest change (that is still there), reverted. */
    undoLatest(by = null) {
      return withLock(by, () => {
        { const no = saveStack(); if (no) return { ok: false, error: no }; }
        // A change nobody saved yet (a turn that just ended, its edits not committed): that is the latest one, so it's
        // the one "undo" means, not the change before it. Saved first, so it can be taken back like any other.
        if (holder?.kind === 'undo' && dirty()) { snapshot('A change not yet saved'); stack.push({ commit: git('rev-parse', 'HEAD'), text: 'the latest change', who: null }); saveStack(); }
        while (stack.length) {
          const last = stack.pop();
          { const no = saveStack(); if (no) { stack.push(last); return { ok: false, error: no }; } }
          if (!exists(last.commit) || !inHistory(last.commit)) continue;
          const r = revert(last.commit, by);
          if (!r.ok) { stack.push(last); saveStack(); return r; }
          git('tag', '-f', 'last-good', 'HEAD');
          return { ok: true, undid: last.text, latest: stack.at(-1)?.text || null };
        }
        return { ok: false, error: 'nothing to undo', nothing: true };
      }, { checkpoint: false });
    },
    /** undo_change: one change by its id, keeping later ones. Itself a change, so it can be undone too. */
    undoChange(id, by = null) {
      if (!/^[0-9a-f]{7,40}$/.test(String(id || ''))) return { ok: false, error: 'Which change? Use its id from list_changes.' };
      return withLock(by, () => {
        let sha; try { sha = git('rev-parse', '--verify', `${id}^{commit}`); } catch { return { ok: false, error: `No change ${id}.` }; }
        if (!inHistory(sha)) return { ok: false, error: `Change ${id} isn't part of the apps now.` };
        { const no = saveStack(); if (no) return { ok: false, error: no }; }
        const r = revert(sha, by);
        if (!r.ok) return r;
        stack = stack.filter((e) => e.commit !== sha);
        land(git('rev-parse', 'HEAD'), `Undo: ${r.msg}`, by?.who);
        if (by && holder === by) by.base = git('rev-parse', 'HEAD');
        return { ok: true, undid: r.msg };
      });
    },
    listChanges: () => git('log', '-30', '--format=%h\t%cr\t%s').split('\n').filter((l) => l && !/\tcheckpoint$/.test(l)).slice(0, 15)
      .map((l) => { const [id, when, msg] = l.split('\t'); return { id, when, change: msg }; }),

    /**
     * Edits the agent doesn't report (a shell command): a file changing in the apps while exactly one
     * conversation runs and nobody holds the lock is that conversation's edit.
     */
    watch() {
      let timer = null;
      const check = () => {
        timer = null;
        if (holder) return;
        const live = [...turns.values()];
        if (!live.length || !dirty()) return; // our own commits and put-backs leave it clean
        if (live.length === 1) { tryAcquire(live[0]); log(`a file changed: ${live[0].who || 'the conversation'} is editing`); }
        else log(`a file changed with ${live.length} conversations running and none editing; it goes with the next change`);
      };
      try {
        const w = fs.watch(APP_DIR, { recursive: true }, (_, f) => {
          const p = String(f || '');
          if (!p || /^(\.git|node_modules|dist|build)([\\/]|$)/.test(p)) return;
          timer ||= setTimeout(check, 150);
        });
        w.unref?.();
        return w;
      } catch (e) { log('no file watching:', e.message); return null; }
    },
  };
}

/** A git repo for tests, with one commit. */
export function initRepo(dir) {
  fs.mkdirSync(path.join(dir, 'apps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'apps\n');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'Starting point'); g('tag', 'last-good');
}
