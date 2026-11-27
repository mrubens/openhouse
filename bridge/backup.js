// Backups of the family's things (backup-format.js), kept wherever the household chooses: the cloud (cloud.js, once
// the tablet is linked), a USB drive plugged into the tablet (drive.js, through the shell) and/or their own storage
// bucket (bucket-backup.js, its key kept by the host). One format, one key, one schedule; restore works the same from
// any of them. Self-hosters get all of it except the hosted cloud.
//
// Settings (Backups) calls these, with the display's secret like every bridge route:
//   GET  /backup/status                       key, each destination (on, ready, last), what's running
//   POST /backup/dest {id, on}                a destination on/off; the first one on makes the family's key
//   GET  /backup/recovery-code                POST /backup/recovery-code/confirmed
//   POST /backup/escrow {on}                  keep a copy of the code with Opie (cloud only; off unless asked)
//   POST /backup/now                          to every destination that's on, now
//   GET  /backup/list                         every backup on every destination that answers
//   POST /backup/restore {dest, id, deviceId?, recoveryCode?}
//   POST /backup/storage {endpoint, region, bucket, prefix, keyId, secret}   their own storage, from a settings page:
//                                             passed on to the host, which checks and keeps it (never kept here)
//   POST /backup/storage/remove               forgotten there, and off here
//
// A destination: { id, label, ready() -> {ok, why?, name?}, put(file, meta), list() -> [{id, kind, size, keyId,
// createdAt, deviceId?, deviceName?}], get(item, toFile), prune?(keepNightly, keepManual) }.
import fs from 'node:fs';
import { readJson, writeJson, holdWrites, releaseWrites } from './store.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { quietRepo } from './edits.js';
import { newRecoveryCode, keyFromCode, normalCode, encryptFile, decryptFile, pack, run, INCLUDE, VIDEO_BUDGET, keptVideos } from './backup-format.js';

export const KEEP = { nightly: 7, manual: 5 };

/**
 * One thing a restore unpacked, made plain before it's put in place: whatever isn't a plain file or folder (a link,
 * a pipe, a device) is left out, as are node_modules folders and every .git below the thing's own top. Returns
 * whether the thing itself is still there (false when it was itself a link or the like).
 */
export function plain(p, top = true) {
  let st; try { st = fs.lstatSync(p); } catch { return false; }
  if (st.isFile()) return true;
  if (!st.isDirectory()) { fs.rmSync(p, { force: true }); return false; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.name === 'node_modules' || (e.name === '.git' && !top)) fs.rmSync(q, { recursive: true, force: true });
    else plain(q, false);
  }
  return true;
}

export function backupRoutes({ DISPLAY, json, body, destinations = [], escrow = null, busy = () => false, exit = () => process.exit(0), now = Date.now, tick = 15 * 60e3, videoBudget = VIDEO_BUDGET }) {
  const DIR = path.join(DISPLAY, '.backup'); // never in a backup (not in INCLUDE)
  const TMP = path.join(DIR, 'tmp');
  const f = (n) => path.join(DIR, n);
  const read = (n) => readJson(f(n), null, { bak: false }); // (keys: no .bak copies lying around)
  const write = (n, v) => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeJson(f(n), v, { bak: false, mode: 0o600, space: 2 }); };
  const state = () => read('state.json') || { dests: {} };
  const setState = (p) => write('state.json', { ...state(), ...p });
  const setDest = (id, p) => { const s = state(); setState({ dests: { ...s.dests, [id]: { ...(s.dests?.[id] || {}), ...p } } }); };
  const iso = () => new Date(now()).toISOString();
  const byId = (id) => destinations.find((d) => d.id === id);
  let job = null;

  // --- the family's key --------------------------------------------------------------------------------------
  function key() { const k = read('key.json'); return k ? { ...keyFromCode(k.code), code: k.code, confirmed: !!k.confirmed } : null; }
  function setKey(code, confirmed) { write('key.json', { code: normalCode(code), keyId: keyFromCode(code).keyId, createdAt: iso(), confirmed }); }
  async function escrowNow() {
    const k = key();
    if (!k || !state().escrow || !escrow?.available()) return;
    await escrow.put(k.keyId, k.code);
    setState({ escrowedKeyId: k.keyId });
  }

  // --- backing up --------------------------------------------------------------------------------------------
  async function backup(kind) {
    if (job) throw new Error(`A ${job.kind} is already running.`);
    const k = key();
    const on = destinations.filter((d) => state().dests?.[d.id]?.on);
    if (!k || !on.length) throw new Error('Backups are off.');
    job = { kind: 'backup', step: 'packing', startedAt: iso() };
    fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
    const tgz = path.join(TMP, 'backup.tar.gz'), file = path.join(TMP, 'backup.backup');
    const results = {};
    try {
      try {
        const entries = await pack(DISPLAY, tgz, { videoBudget });
        job.step = 'locking';
        await encryptFile(tgz, file, k, { entries });
        fs.rmSync(tgz, { force: true });
      } catch (e) {
        console.log('[backup] packing failed:', e.message);
        const err = { at: iso(), ok: false, error: job.step === 'packing' ? "The family's things couldn't be packed up." : "The backup couldn't be locked.", errorType: `backup.${job.step}`, kind };
        for (const d of on) setDest(d.id, { last: err });
        setState({ last: err });
        throw new Error(err.error);
      }
      const size = fs.statSync(file).size, meta = { kind, size, keyId: k.keyId, createdAt: iso() };
      for (const d of on) {
        job.step = `sending:${d.id}`;
        try {
          const r = await d.ready();
          if (!r.ok) throw Object.assign(new Error(r.why || `${d.label} isn't there.`), { code: 'notready' });
          await d.put(file, meta);
          await d.prune?.(KEEP.nightly, KEEP.manual).catch((e) => console.log(`[backup] pruning ${d.id}:`, e.message));
          results[d.id] = { at: iso(), ok: true, size, kind };
        } catch (e) {
          console.log(`[backup] ${d.id} failed:`, e.message);
          results[d.id] = { at: iso(), ok: false, error: e.code === 'notready' || e.code === 'unlinked' ? e.message : `${d.label} couldn't be reached. It tries again tonight.`, errorType: `backup.${d.id}.${e.code || 'failed'}`.replace(/[^a-z0-9_.-]/g, ''), kind };
        }
        setDest(d.id, { last: results[d.id], ...(results[d.id].ok ? { lastOkAt: results[d.id].at } : {}) });
      }
      const ok = Object.values(results).every((r) => r.ok);
      const last = ok ? { at: iso(), ok, size, kind } : Object.values(results).find((r) => !r.ok);
      setState({ last, ...(ok ? { lastOkAt: iso() } : {}) });
      return { ok, results };
    } finally { job = null; fs.rmSync(TMP, { recursive: true, force: true }); }
  }

  async function listAll() {
    const out = [], missing = [];
    // Every place that answers, on or not here: a new tablet restores from what an old one left.
    for (const d of destinations) {
      const r = await d.ready().catch((e) => ({ ok: false, why: e.message }));
      if (!r.ok) { if (state().dests?.[d.id]?.on) missing.push({ dest: d.id, label: d.label, why: r.why }); continue; }
      try { for (const b of await d.list()) out.push({ ...b, dest: d.id, destLabel: d.label }); }
      catch (e) { missing.push({ dest: d.id, label: d.label, why: e.message }); }
    }
    const k = key();
    return { backups: out.map((b) => ({ ...b, needsCode: !k || b.keyId !== k.keyId })).sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1)), missing };
  }

  // --- restoring ---------------------------------------------------------------------------------------------
  async function restore({ dest, id, deviceId, recoveryCode }) {
    if (job) throw new Error(`A ${job.kind} is already running.`);
    if (busy()) throw new Error('The assistant is changing something. Try again when it has finished.');
    const d = byId(dest);
    if (!d) throw new Error('No such place.');
    job = { kind: 'restore', step: 'checking', startedAt: iso() };
    fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
    let held = null, moved = false;
    try {
      const item = (await d.list()).find((b) => b.id === id && (!deviceId || !b.deviceId || b.deviceId === deviceId));
      if (!item) throw new Error("That backup isn't there any more.");
      let k = key(), adopt = null;
      if (!k || k.keyId !== item.keyId) {
        let typed = recoveryCode && keyFromCode(recoveryCode);
        if (!typed && escrow?.available()) { // a copy kept with Opie, if the family asked for that
          const kept = await escrow.get(item.keyId).catch(() => null);
          if (kept && keyFromCode(kept)?.keyId === item.keyId) { typed = keyFromCode(kept); recoveryCode = kept; }
        }
        if (!typed) throw Object.assign(new Error('This backup was made with another recovery code. Type that code to restore it.'), { code: 'needcode' });
        if (typed.keyId !== item.keyId) throw Object.assign(new Error("That recovery code doesn't fit this backup."), { code: 'wrongcode' });
        k = typed; adopt = recoveryCode;
      }
      job.step = 'fetching';
      const file = path.join(TMP, 'restore.backup'), tgz = path.join(TMP, 'restore.tar.gz'), out = path.join(TMP, 'restore');
      await d.get(item, file);
      job.step = 'unlocking';
      const header = await decryptFile(file, tgz, k.key);
      fs.rmSync(file, { force: true });
      job.step = 'unpacking';
      fs.mkdirSync(out);
      await run('tar', ['-xzf', tgz, '-C', out, '--no-same-owner']);
      fs.rmSync(tgz, { force: true });
      // Only what a backup may hold; what is there now is kept aside in .backup/before-restore until the next one.
      // Only plain files and folders come back, with no node_modules (the next start installs them) and no repo inside
      // another; and a repo that comes back (webapp/) runs nothing of its own.
      const entries = (header.entries || []).filter((e) => INCLUDE.includes(e) && plain(path.join(out, e)));
      for (const e of entries) quietRepo(path.join(out, e));
      if (!entries.length) throw new Error('the backup is empty');
      job.step = 'putting back';
      // From here until the bridge starts again, nothing saves over what comes back from what it still holds in
      // memory (the lists, the reminders, the calendars' outbox...): every write to these is refused (store.js), and
      // the restart below reads them all again.
      held = INCLUDE.map((e) => path.join(DISPLAY, e));
      holdWrites(held, 'A backup is being restored. Try again in a moment, once the tablet has started again.');
      const aside = f('before-restore');
      fs.rmSync(aside, { recursive: true, force: true }); fs.mkdirSync(aside, { recursive: true });
      for (const e of entries) {
        if (fs.existsSync(path.join(DISPLAY, e))) { fs.renameSync(path.join(DISPLAY, e), path.join(aside, e)); moved = true; }
        // (a file's .bak goes aside with it: it is the version before the one set aside, never a copy of what came back)
        if (fs.existsSync(path.join(DISPLAY, e + '.bak'))) fs.renameSync(path.join(DISPLAY, e + '.bak'), path.join(aside, e + '.bak'));
        fs.renameSync(path.join(out, e), path.join(DISPLAY, e)); moved = true;
      }
      if (entries.includes('photos')) keptVideos(path.join(aside, 'photos'), path.join(DISPLAY, 'photos')); // (videos the backup left out stay)
      if (adopt) { setKey(adopt, true); escrowNow().catch(() => {}); } // the family's code is this tablet's code now
      setState({ lastRestore: { at: iso(), ok: true, dest, id, from: header.createdAt } });
      // Start fresh on what came back: the shell's watchdog starts the bridge again in a few seconds.
      setTimeout(exit, 1500).unref?.();
      return { ok: true, restarting: true, from: header.createdAt };
    } catch (e) {
      setState({ lastRestore: { at: iso(), ok: false, error: e.message.slice(0, 200) } });
      // Nothing put back yet: carry on as before. Some of it: start again on what is on disk now, never on memory.
      if (held && !moved) releaseWrites(held); else if (held) setTimeout(exit, 1500).unref?.();
      throw e;
    } finally { job = null; fs.rmSync(TMP, { recursive: true, force: true }); }
  }

  // --- nightly, when nobody is using it ----------------------------------------------------------------------
  async function nightly() {
    const s = state();
    if (job || busy() || !key() || !destinations.some((d) => s.dests?.[d.id]?.on)) return;
    const hour = new Date(now()).getHours(); // the family's time (the runtime has TZ)
    if (hour < 2 || hour >= 5) return;
    const lastOk = s.lastOkAt ? Date.parse(s.lastOkAt) : 0;
    if (now() - lastOk < 20 * 3600e3) return;
    if (s.last && !s.last.ok && now() - Date.parse(s.last.at) < 30 * 60e3) return; // a failed one waits a little
    try { await backup('nightly'); } catch (e) { console.log('[backup] nightly backup failed:', e.message); }
  }
  const timer = tick ? setInterval(() => nightly().catch(() => {}), tick) : null;
  timer?.unref?.();

  async function status() {
    const s = state(), k = key();
    const dests = [];
    for (const d of destinations) {
      const r = await d.ready().catch((e) => ({ ok: false, why: e.message }));
      dests.push({ id: d.id, label: d.label, on: !!s.dests?.[d.id]?.on, ready: r.ok, why: r.ok ? null : r.why || null, name: r.name || null, last: s.dests?.[d.id]?.last || null });
    }
    return {
      key: { has: !!k, confirmed: !!k?.confirmed }, dests, last: s.last || null, lastRestore: s.lastRestore || null, job,
      escrow: { available: !!escrow?.available(), on: !!s.escrow, kept: !!(k && s.escrowedKeyId === k.keyId) },
    };
  }

  /** For health check-ins: on or off, and the last failure as a type only. */
  function bits() {
    const s = state();
    return { on: !!key() && destinations.some((d) => s.dests?.[d.id]?.on), lastErrorType: s.last && !s.last.ok ? String(s.last.errorType || 'backup.failed').slice(0, 40) : null, lastErrorAt: s.last && !s.last.ok ? Date.parse(s.last.at) : 0 };
  }

  const reply = async (res, fn) => {
    try { json(res, 200, await fn()); } catch (e) { json(res, 400, { error: e.message, code: e.code || null }); }
  };

  const EXPORT_SKIP = ['./voice', './bridge', './defaults', './ports', './build', './buildserver', './webapp.tgz', './webapp/node_modules', './agent', './.backup/tmp', './.tailscale', './.tailscale-bin'];
  function exportAll(res) {
    const t = spawn('tar', ['-czf', '-', '-C', DISPLAY, ...EXPORT_SKIP.map((x) => `--exclude=${x}`), '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    t.stderr.on('data', (d) => (err += d));
    res.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="openhouse-family.tgz"' });
    t.stdout.pipe(res);
    // tar warns (exit 1) when a file changes while it's read, as the bridge's own log does; the copy is still whole.
    t.on('close', (c) => { if (c > 1) console.error(`backup export: tar exited ${c}: ${err.slice(-300)}`); });
    res.on('close', () => { if (t.exitCode === null) t.kill(); });
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/backup/')) return false;
    if (req.method === 'GET' && p === '/backup/status') { json(res, 200, await status()); return true; }
    if (req.method === 'GET' && p === '/backup/recovery-code') { const k = key(); json(res, k ? 200 : 404, k ? { code: k.code, confirmed: k.confirmed } : { error: 'no key' }); return true; }
    if (req.method === 'GET' && p === '/backup/list') { await reply(res, listAll); return true; }
    // The whole family folder as one .tar.gz, for a copy on the computer before an install (scripts/tablet-backup.sh).
    // A release build can't be read with run-as, so this is the way in; the display's token only, like every route.
    // Left out: what the display or an update puts back (the runtime's pieces, voice models, builds, the assistant's
    // own app folder) and backups' scratch space.
    if (req.method === 'GET' && p === '/backup/export') { exportAll(res); return true; }
    if (req.method !== 'POST') { json(res, 404, { error: 'not found' }); return true; }
    const b = await body(req);
    switch (p) {
      case '/backup/dest':
        await reply(res, async () => {
          const d = byId(String(b.id || ''));
          if (!d) throw new Error('No such place.');
          if (b.on) { const r = await d.ready(); if (!r.ok) throw new Error(r.why || `${d.label} isn't there.`); }
          if (b.on && !key()) setKey(newRecoveryCode(), false);
          setDest(d.id, { on: !!b.on });
          const k = key();
          return { on: !!b.on, recoveryCode: b.on && !k.confirmed ? k.code : undefined };
        });
        return true;
      case '/backup/recovery-code/confirmed': {
        const k = read('key.json');
        if (k) write('key.json', { ...k, confirmed: true });
        json(res, k ? 200 : 404, { ok: !!k }); return true;
      }
      case '/backup/escrow':
        await reply(res, async () => {
          if (b.on) {
            if (!escrow?.available()) throw new Error('Link the tablet to a family account first.');
            setState({ escrow: true });
            await escrowNow();
          } else {
            const kept = state().escrowedKeyId;
            setState({ escrow: false, escrowedKeyId: null });
            if (kept && escrow?.available()) await escrow.remove(kept).catch(() => {});
          }
          return { on: !!b.on };
        });
        return true;
      case '/backup/now': {
        // Answers at once; Settings follows it in /backup/status.
        if (job) { json(res, 409, { error: `A ${job.kind} is already running.` }); return true; }
        if (!key() || !destinations.some((d) => state().dests?.[d.id]?.on)) { json(res, 400, { error: 'Turn backups on first.' }); return true; }
        backup('manual').catch((e) => console.log('[backup] failed:', e.message));
        json(res, 200, { started: true }); return true;
      }
      // Their own storage (bucket-backup.js): passed straight on to the host, which checks it and keeps the secret.
      case '/backup/storage':
        await reply(res, async () => {
          const d = byId('bucket');
          if (!d?.setUp) throw new Error('This device can’t keep a storage key.');
          return d.setUp(b);
        });
        return true;
      case '/backup/storage/remove':
        await reply(res, async () => {
          const d = byId('bucket');
          if (!d?.remove) throw new Error('No such place.');
          await d.remove(); setDest(d.id, { on: false });
          return { ok: true };
        });
        return true;
      case '/backup/restore':
        await reply(res, () => restore({ dest: String(b.dest || ''), id: String(b.id || ''), deviceId: b.deviceId ? String(b.deviceId) : null, recoveryCode: b.recoveryCode ? String(b.recoveryCode) : null }));
        return true;
    }
    json(res, 404, { error: 'not found' }); return true; // the body is read: nothing after this may read it again
  }
  return { handle, status, backup, restore, nightly, bits, escrowNow, stop: () => timer && clearInterval(timer) };
}
