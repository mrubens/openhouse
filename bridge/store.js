// How the bridge keeps a whole file of the household's data (house.json, household.json, the home screen, chats…)
// so a crash, a kill or a power cut in the middle of a save never loses what was there before.
//
// writeJson / writeFileAtomic: the new contents go to a temp file in the same folder, are flushed to disk, and only
// then take the file's place (a rename), so the file is always either the old version or the new one, whole.
// With bak (the default for writeJson), the version being replaced is kept as <file>.bak first.
// readJson: a file that doesn't parse is never read as empty: its .bak is read instead. If neither parses the
// caller's default comes back, and the next save sets the unreadable file aside (<file>.damaged-<time>) instead
// of writing over it, so nothing on disk is ever lost to a default.
//
// Each store is declared in stores.js (backed up or not, .bak or not, its schema version and migration). A file
// whose "$v" is newer than this code knows was saved by a later release (the tablet then went back to its rescue
// build): it is read as it is, and every save to it is refused, so its newer shape is never written over.
import fs from 'node:fs';
import path from 'node:path';
import { storeOf } from './stores.js';

const good = new Map(); // file -> "size:mtime" of the version last read or written whole by this process
const damaged = new Set(); // files read as unparseable with no readable .bak: the next save sets them aside
const warned = new Set(); // (each is said once in the log, not on every read)
const stamp = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };
const warn = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.error('[store]', msg); } };

// While a restore puts the backup's files in place (backup.js), nothing may save over them from what this process
// still holds in memory: a write under a held path is refused (it throws, so a tap or a tool gets an answer) until the
// bridge starts again on what came back. held: path -> why.
const held = new Map();
/** Refuse every write to these files and folders (and what's in them) from now on, with this reason. */
export function holdWrites(paths, why) { for (const p of paths) held.set(path.resolve(p), why); }
/** Writes to them again (a restore that failed before anything was put back). */
export function releaseWrites(paths) { for (const p of paths) held.delete(path.resolve(p)); }
function heldWhy(file) {
  if (!held.size) return null;
  const f = path.resolve(file);
  for (const [p, why] of held) if (f === p || f.startsWith(p + path.sep)) return why;
  return null;
}

// --- schema versions (stores.js) ---
const V = '$v';
const versionOf = (x) => (x && typeof x === 'object' && !Array.isArray(x) && Number.isInteger(x[V]) ? x[V] : 0);
const unstamp = (x) => { if (!(x && typeof x === 'object' && !Array.isArray(x) && V in x)) return x; const { [V]: _, ...rest } = x; return rest; };
const versions = new Map(); // file -> { at: stamp, v } of the version on disk, last read or written
const unmigrated = new Map(); // file -> why: its migration failed, so it is not saved over
const said = new Map(); // file -> when a refused save was last logged
function loud(file, msg) {
  const t = Date.now();
  if (t - (said.get(file) || 0) < 60e3) return;
  said.set(file, t);
  console.error('[store] !!!', msg);
}
const newerWhy = (file, v, known) => `${path.basename(file)} was saved by a newer version of Opie (its version ${v}; this one knows ${known}). It is not saved over until that version is back.`;
/** The stored value as this code's shape: "$v" taken out, an older one migrated, a newer one as it is. */
function shaped(file, value, entry, fromBak) {
  const v = versionOf(value), known = entry?.version || 0;
  if (!fromBak) versions.set(file, { at: stamp(file), v });
  value = unstamp(value);
  if (!entry) return value;
  if (!fromBak) unmigrated.delete(file);
  if (v > known) { loud(file, `${file}${fromBak ? '.bak' : ''}: ${newerWhy(file, v, known)} Reading it best-effort; refusing every save to it.`); return value; }
  if (v < known && entry.migrate) {
    try { return entry.migrate(value, v); }
    catch (e) {
      unmigrated.set(file, `${path.basename(file)} couldn't be brought up to date (${e.message}). It is not saved over.`);
      loud(file, `${file}: migrating from version ${v} to ${known} failed (${e.message}): refusing every save to it`);
    }
  }
  return value;
}
/** The schema version of a file on disk now (0 when it has none or is missing; null when it doesn't parse). */
function diskVersion(file) {
  const s = stamp(file);
  if (!s) return 0;
  const k = versions.get(file);
  if (k && k.at === s) return k.v;
  const p = parseFile(file);
  const v = p.ok ? versionOf(p.value) : null;
  versions.set(file, { at: s, v });
  return v;
}
/** Why a save to this store's file is refused, or null. */
function refused(file, entry) {
  const known = entry.version || 0;
  let v = diskVersion(file);
  if (v == null) v = diskVersion(file + '.bak') ?? 0; // (unreadable: what is read is its .bak)
  if (v > known) return newerWhy(file, v, known);
  return unmigrated.get(file) || null;
}

function parseFile(f) { // { ok, value } | { missing } | { bad }
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { missing: true } : { bad: true, error: e }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { bad: true, error: e }; }
}

// --- shapes (stores.js shape): a file that parses but has the wrong shape (a restored backup, a hand edit, a bug) is
// read as the nearest right one, so no reader ever stops on it: a top level of the wrong kind reads as the caller's
// default; a key of the wrong kind is left out at the top (the reader's own default takes its place) and is empty
// below it; a list's or a map's entries of the wrong kind are dropped. Nothing is changed on disk until the next save.
// A shape: {} an object ({key: shape} with its keys' shapes, {'*': shape} every value's), [] a list ([shape] of
// those), '' a string.
const kind = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
const fits = (v, shape) => kind(v) === kind(shape);
const empty = (shape) => (Array.isArray(shape) ? [] : {});
function coerce(v, shape, fixed, top = false) {
  if (Array.isArray(shape)) {
    if (!shape.length) return v;
    const out = v.filter((x) => fits(x, shape[0]));
    if (out.length !== v.length) fixed.n++;
    return out.map((x) => coerce(x, shape[0], fixed));
  }
  if (kind(shape) !== 'object' || !Object.keys(shape).length) return v;
  const out = { ...v };
  for (const k of Object.keys(out)) {
    const sh = Object.hasOwn(shape, k) && k !== '*' ? shape[k] : shape['*'];
    if (sh === undefined) continue;
    if (fits(out[k], sh)) { out[k] = coerce(out[k], sh, fixed); continue; }
    fixed.n++;
    if (top || kind(sh) !== 'object' && kind(sh) !== 'array' || Object.hasOwn(shape, '*') && !Object.hasOwn(shape, k)) delete out[k];
    else out[k] = empty(sh);
  }
  return out;
}
/** The value as its store's shape says (a JSON store with none is an object at its top). */
function inShape(file, value, entry, fallback) {
  if (!entry || entry.text) return value;
  const shape = entry.shape ?? {};
  if (!fits(value, shape)) {
    warn(file + '~', `${file} isn't the shape it should be (a ${kind(value)}); read as empty`);
    return typeof fallback === 'function' ? fallback() : fallback;
  }
  const fixed = { n: 0 }, out = coerce(value, shape, fixed, true);
  if (fixed.n) warn(file + '~', `${file} had ${fixed.n} part(s) of the wrong shape; read without them`);
  return out;
}

/** The file's contents, else its .bak's, else `fallback` (missing, or unreadable with no good .bak). A store's file of
 *  the wrong shape is read as the nearest right one (above). */
export function readJson(file, fallback, { bak } = {}) {
  const entry = storeOf(file);
  bak ??= entry?.bak ?? true;
  const main = parseFile(file);
  if (main.ok) { good.set(file, stamp(file)); damaged.delete(file); warned.delete(file); return inShape(file, shaped(file, main.value, entry, false), entry, fallback); }
  if (main.bad) warn(file, `${file} is unreadable (${main.error.message})${bak ? '; reading its .bak' : ''}`);
  if (bak) {
    const b = parseFile(file + '.bak');
    if (b.ok) { if (main.missing) warn(file, `${file} is missing; reading its .bak`); return inShape(file, shaped(file, b.value, entry, true), entry, fallback); }
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

/** Write all of buf to f (new or replaced), on disk, and check it's all there; on any failure f is removed and this
 *  throws. (fs.writeSync can write less than it was given, as on a full disk.) */
function writeWhole(f, buf, mode) {
  try {
    const fd = fs.openSync(f, 'w', mode ?? 0o666);
    try {
      if (mode != null) fs.fchmodSync(fd, mode);
      for (let at = 0; at < buf.length;) {
        const n = fs.writeSync(fd, buf, at, buf.length - at);
        if (!(n > 0)) throw Object.assign(new Error(`could not write ${f} (wrote ${at} of ${buf.length} bytes)`), { code: 'short' });
        at += n;
      }
      fs.fsyncSync(fd);
      const size = fs.fstatSync(fd).size;
      if (size !== buf.length) throw Object.assign(new Error(`${f} is ${size} bytes, not ${buf.length}`), { code: 'short' });
    } finally { fs.closeSync(fd); }
  } catch (e) { try { fs.rmSync(f, { force: true }); } catch {} throw e; }
}

/** Replace a file's contents in one step. json: the file holds JSON, so an unparseable one is set aside, never
 *  overwritten or kept as the .bak. mode: the file's permissions (0o600 for keys). */
export function writeFileAtomic(file, text, { bak = false, mode, json = false } = {}) {
  const why = heldWhy(file);
  if (why) throw Object.assign(new Error(why), { code: 'held' });
  const tmp = file + '.tmp';
  // The whole new version goes to file.tmp and is checked there first: a short write (a full disk) or any other
  // failure leaves the file and its .bak as they were, and throws.
  writeWhole(tmp, Buffer.from(text), mode);
  if (fs.existsSync(file)) {
    if (json && (damaged.has(file) || !parsesNow(file))) {
      const aside = `${file}.damaged-${Date.now()}`;
      try { fs.renameSync(file, aside); console.error('[store]', `${file} was unreadable; kept it as ${path.basename(aside)}`); } catch {}
    } else if (bak) {
      // Copied whole to .bak.tmp first, so a failed copy never replaces a good .bak with a part of one.
      try { writeWhole(file + '.bak.tmp', fs.readFileSync(file), mode); fs.renameSync(file + '.bak.tmp', file + '.bak'); }
      catch (e) { try { fs.rmSync(file + '.bak.tmp', { force: true }); } catch {} console.error('[store] no .bak for', file, e.message); }
    }
  }
  fs.renameSync(tmp, file);
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {} // the rename itself, on disk
  damaged.delete(file); warned.delete(file);
  if (json) good.set(file, stamp(file));
}

/** Save a value as JSON (space: indent; newline: end with one). Keeps a .bak of the previous version unless bak: false
 *  (or its store in stores.js says so). Stamps the store's schema version; refuses (throws, code 'newer') a file a
 *  newer release saved. */
export function writeJson(file, value, { bak, mode, space, newline = false } = {}) {
  const entry = storeOf(file);
  bak ??= entry?.bak ?? true;
  if (entry) {
    const known = entry.version || 0, why = refused(file, entry);
    if (why) { loud(file, `refused a save to ${file}: ${why}`); throw Object.assign(new Error(why), { code: 'newer', ...(unmigrated.get(file) === why ? { unmigrated: true } : {}) }); }
    if (known > 0 && value && typeof value === 'object' && !Array.isArray(value)) value = { [V]: known, ...unstamp(value) };
  }
  writeFileAtomic(file, JSON.stringify(value, null, space) + (newline ? '\n' : ''), { bak, mode, json: true });
  if (entry) versions.set(file, { at: stamp(file), v: versionOf(value) });
}

/** What a tap or a tool is told when a save threw, as { status, error }: 409 when it was refused on purpose (a file a
 *  newer release saved, one that couldn't be brought up to date, one held during a restore), 500 when the disk failed.
 *  Whoever saves keeps nothing of the change in memory either, so what shows is what's on disk. */
export function unsaved(e) {
  const why = e?.message || String(e);
  if (e?.code === 'newer' && !e.unmigrated) return { status: 409, error: `It wasn't saved: this device's data is from a newer version of Opie, so update the device. (${why})` };
  if (e?.code === 'newer' || e?.code === 'held') return { status: 409, error: `It wasn't saved: ${why}` };
  return { status: 500, error: `It wasn't saved: ${why}` };
}
