// How the bridge keeps a whole file of the household's data (house.json, household.json, the home screen, chats…)
// so a crash, a kill or a power cut in the middle of a save never loses what was there before.
//
// writeJson / writeFileAtomic: the new contents go to a temp file in the same folder, are flushed to disk, and only
// then take the file's place (a rename), so the file is always either the old version or the new one, whole.
// With bak (the default for writeJson), the version being replaced is kept as <file>.bak first.
// readJson: a file that doesn't parse is never read as empty: its .bak is read instead. If neither parses the
// caller's default comes back, and the next save sets the unreadable file aside (<file>.damaged-<time>) instead
// of writing over it, so nothing on disk is ever lost to a default.
import fs from 'node:fs';
import path from 'node:path';

const good = new Map(); // file -> "size:mtime" of the version last read or written whole by this process
const damaged = new Set(); // files read as unparseable with no readable .bak: the next save sets them aside
const warned = new Set(); // (each is said once in the log, not on every read)
const stamp = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };
const warn = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.error('[store]', msg); } };

function parseFile(f) { // { ok, value } | { missing } | { bad }
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { bad: true, error: e }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { bad: true, error: e }; }
}

/** The file's contents, else its .bak's, else `fallback` (missing, or unreadable with no good .bak). */
export function readJson(file, fallback, { bak = true } = {}) {
  const main = parseFile(file);
  if (main.ok) { good.set(file, stamp(file)); damaged.delete(file); warned.delete(file); return main.value; }
  if (main.bad) warn(file, `${file} is unreadable (${main.error.message})${bak ? '; reading its .bak' : ''}`);
  if (bak) {
    const b = parseFile(file + '.bak');
    if (b.ok) { if (main.missing) warn(file, `${file} is missing; reading its .bak`); return b.value; }
  }
  if (main.bad) { damaged.add(file); warn(file + '!', `${file} has no readable copy; it is kept aside at the next save`); }
  return typeof fallback === 'function' ? fallback() : fallback;
}

/** Whether the file on disk now parses (what this process last wrote or read whole is known without reading). */
function parsesNow(file) {
  const s = stamp(file);
  if (s && good.get(file) === s) return true;
  return !!parseFile(file).ok;
}

/** Replace a file's contents in one step. json: the file holds JSON, so an unparseable one is set aside, never
 *  overwritten or kept as the .bak. mode: the file's permissions (0o600 for keys). */
export function writeFileAtomic(file, text, { bak = false, mode, json = false } = {}) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', mode ?? 0o666);
  try {
    if (mode != null) fs.fchmodSync(fd, mode);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) {
    if (json && (damaged.has(file) || !parsesNow(file))) {
      const aside = `${file}.damaged-${Date.now()}`;
      try { fs.renameSync(file, aside); console.error('[store]', `${file} was unreadable; kept it as ${path.basename(aside)}`); } catch {}
    } else if (bak) {
      try { fs.copyFileSync(file, file + '.bak'); if (mode != null) fs.chmodSync(file + '.bak', mode); } catch (e) { console.error('[store] no .bak for', file, e.message); }
    }
  }
  fs.renameSync(tmp, file);
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {} // the rename itself, on disk
  damaged.delete(file); warned.delete(file);
  if (json) good.set(file, stamp(file));
}

/** Save a value as JSON (space: indent; newline: end with one). Keeps a .bak of the previous version unless bak: false. */
export function writeJson(file, value, { bak = true, mode, space, newline = false } = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, space) + (newline ? '\n' : ''), { bak, mode, json: true });
}
