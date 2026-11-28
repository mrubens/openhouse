// After a restore (backup.js) the bridge starts again on what came back. If it doesn't stay up (a start that throws on
// what the backup held), the device goes back to what it had before: the restored things are kept aside in
// .backup/failed-restore and what was there before comes back from .backup/before-restore, so a backup can never
// leave the device unable to start.
//
// restored(DISPLAY, {entries, kept}): written by the restore just before the bridge stops (entries: what it put back;
// kept: what it carried over from before into what came back, as this device's own node_modules and the videos the
// backup left out). guard(DISPLAY): first thing at every start, before anything reads the household's files; it counts
// the starts since, and the third one goes back. Once a start has stayed up a minute, the restore has held.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './store.js';

export const STARTS = 3; // the start that goes back: two after the restore didn't stay up
export const UP_MS = 60e3;

const dirOf = (DISPLAY) => path.join(DISPLAY, '.backup');
const markOf = (DISPLAY) => path.join(dirOf(DISPLAY), 'restore-pending.json');
const save = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); writeJson(f, v, { bak: false, mode: 0o600 }); };

/** The restore just put these back; the next starts are watched. */
export function restored(DISPLAY, { entries, kept = [] }) {
  save(markOf(DISPLAY), { at: new Date().toISOString(), entries, kept, starts: 0 });
}

/** What was there before the restore, put back (the restored things kept aside). Best effort, every piece. */
export function goBack(DISPLAY, { entries = [], kept = [] }) {
  const aside = path.join(dirOf(DISPLAY), 'before-restore'), failed = path.join(dirOf(DISPLAY), 'failed-restore');
  const move = (a, b) => { try { if (!fs.existsSync(a)) return; fs.mkdirSync(path.dirname(b), { recursive: true }); fs.rmSync(b, { recursive: true, force: true }); fs.renameSync(a, b); } catch (e) { console.error('[restore]', `couldn't move ${a}: ${e.message}`); } };
  const rel = (p) => String(p).split('/').filter((x) => x && x !== '..' && x !== '.').join(path.sep);
  // What the restore carried over from before goes back with what was there before.
  for (const k of kept) if (rel(k)) move(path.join(DISPLAY, rel(k)), path.join(aside, rel(k)));
  fs.rmSync(failed, { recursive: true, force: true });
  for (const e of entries.map(rel).filter(Boolean)) {
    move(path.join(DISPLAY, e), path.join(failed, e));
    move(path.join(aside, e), path.join(DISPLAY, e));
    move(path.join(aside, e + '.bak'), path.join(DISPLAY, e + '.bak'));
  }
}

/** At start: once a restore's starts haven't stayed up, go back. Returns 'back' when it went back. */
export function guard(DISPLAY, { setTimer = setTimeout } = {}) {
  const f = markOf(DISPLAY);
  let m; try { m = readJson(f, null, { bak: false }); } catch { m = null; }
  if (!m || typeof m !== 'object' || !Array.isArray(m.entries)) return null;
  const starts = (Number(m.starts) || 0) + 1;
  if (starts >= STARTS) {
    console.error('[restore] the device did not start on what the backup held: going back to what it had before');
    try { goBack(DISPLAY, { entries: m.entries, kept: Array.isArray(m.kept) ? m.kept : [] }); } catch (e) { console.error('[restore]', e.message); }
    try { fs.rmSync(f, { force: true }); } catch {}
    try {
      const sf = path.join(dirOf(DISPLAY), 'state.json'), s = readJson(sf, null, { bak: false }) || {};
      save(sf, { ...s, lastRestore: { at: new Date().toISOString(), ok: false, error: "The device didn't start with that backup, so it went back to what it had before.", wentBack: true } });
    } catch {}
    return 'back';
  }
  try { save(f, { ...m, starts }); } catch (e) { console.error('[restore]', e.message); }
  const t = setTimer(() => { try { fs.rmSync(f, { force: true }); } catch {} }, UP_MS);
  t?.unref?.();
  return 'watching';
}
