// The one backup format, whatever it's kept on (the cloud, a USB drive, later a home computer's shared folder):
// the family's things packed with tar and encrypted here, on the tablet, with a key made from a recovery code only
// the family holds (and OpenHouse, only if they asked it to keep a copy).
//
// File (.backup): "DBK1\n" + a JSON header line {v, keyId, iv, createdAt, entries} + "\n" + ciphertext + the
// 16-byte AES-256-GCM tag. The header is the GCM additional data, so it can't be changed either. keyId is a hash of
// the key: it tells a restore which code fits without saying anything about the key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { backedUp, leftOutOfBackups } from './stores.js';

// What a backup holds, relative to the display folder (the ones that exist): every store stores.js declares as the
// household's (backup: true), so a new store can't be left out by forgetting a list here. The family's apps with their
// git history, chats (and the home screen's look), the household, photos, app data, the house's devices, what the
// assistant learned, reminders, the calendars chosen and their outbox, the things on Home, what apps put on the
// calendar... Never: what is read again by itself (the calendars' cache, the heartbeat's waiting fixes, the voice
// model), and keys, pairings and credentials (.cloud/, .backup/, the bridge's own folder), nor sign-ins for Claude or
// ChatGPT (in the runtime and the agent's app, outside this folder).
export const INCLUDE = backedUp();
// .l2s.*: proot's stand-ins for hard links (git makes them); inside the runtime the real files read normally.
// The store's spare copies (store.js): a .bak of each file (the file itself is what's kept), a save half made (.tmp),
// one set aside as unreadable (.damaged-<time>).
// And inside a backed-up folder, the caches stores.js leaves out (chats/maps.json...).
const EXCLUDE = ['node_modules', '.vite', '*.tmp', '.l2s.*', '*.json.bak', '*.md.bak', '*.damaged-*', ...leftOutOfBackups()];
const MAGIC = 'DBK1';

// Recovery codes: 128 random bits in Crockford base32 (no I, L, O, U), 26 characters in groups of four.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newRecoveryCode(rand = crypto.randomBytes) { return formatCode(encode32(rand(16))); }
function encode32(buf) {
  let bits = 0, v = 0, out = '';
  for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(v << (5 - bits)) & 31];
  return out;
}
const formatCode = (s) => s.match(/.{1,4}/g).join('-');
/** A typed code back to its 16 bytes, forgiving case, dashes, spaces and O/I/L; null if it can't be one. */
export function parseRecoveryCode(text) {
  const s = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 26 || [...s].some((c) => !B32.includes(c))) return null;
  let bits = 0, v = 0; const out = [];
  for (const c of s) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out.slice(0, 16));
}
/** The code as it's shown: the canonical spelling of whatever was typed. */
export const normalCode = (text) => { const b = parseRecoveryCode(text); return b ? formatCode(encode32(b)) : null; };
export function keyFromCode(code) {
  const bytes = parseRecoveryCode(code);
  if (!bytes) return null;
  const key = Buffer.from(crypto.hkdfSync('sha256', bytes, 'openhouse-backup', 'v1', 32));
  return { key, keyId: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) };
}

export async function encryptFile(src, dst, { key, keyId }, extra = {}) {
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(MAGIC + '\n' + JSON.stringify({ v: 1, keyId, iv: iv.toString('base64'), createdAt: new Date().toISOString(), ...extra }) + '\n');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(header);
  const out = fs.createWriteStream(dst, { mode: 0o600 });
  out.write(header);
  await pipeline(fs.createReadStream(src), c, out, { end: false }).catch((e) => { out.destroy(); throw e; });
  await new Promise((ok, no) => out.end(c.getAuthTag(), (e) => (e ? no(e) : ok())));
}
export function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0);
    const a = buf.indexOf(10), b = buf.indexOf(10, a + 1);
    if (buf.subarray(0, a).toString() !== MAGIC || b < 0 || b >= n) throw new Error('not a backup');
    return { raw: buf.subarray(0, b + 1), header: JSON.parse(buf.subarray(a + 1, b).toString()) };
  } finally { fs.closeSync(fd); }
}
/** Decrypt to dst; throws (and leaves nothing) unless every byte checks out against the tag. */
export async function decryptFile(src, dst, key) {
  const { raw, header } = readHeader(src);
  const size = fs.statSync(src).size;
  if (size < raw.length + 16) throw new Error('not a backup');
  const tag = Buffer.alloc(16); const fd = fs.openSync(src, 'r'); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64')); d.setAAD(raw); d.setAuthTag(tag);
  try { await pipeline(fs.createReadStream(src, { start: raw.length, end: size - 17 }), d, fs.createWriteStream(dst, { mode: 0o600 })); }
  catch (e) { fs.rmSync(dst, { force: true }); throw new Error(/auth/i.test(e.message) ? "the backup doesn't open with this key, or it was damaged" : e.message); }
  return header;
}

export function run(cmd, args, opts = {}) {
  return new Promise((ok, no) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
    let err = ''; p.stderr.on('data', (d) => (err += d));
    p.on('error', no); p.on('close', (c) => (c === 0 ? ok() : no(new Error(`${cmd} failed: ${err.slice(-300)}`))));
  });
}
/** Videos in Photos (house.js VIDEO): a backup holds the newest of them up to VIDEO_BUDGET bytes in all, so a few
 *  long clips can't make every backup (and the cloud's copy) many times bigger. The rest stay on the tablet only, and
 *  a restore on it keeps them (keptVideos). */
export const VIDEO = /\.(mp4|mov|m4v)$/i;
export const VIDEO_BUDGET = 1e9;
/** The photos folder's videos a backup leaves out (their names), the newest kept first. */
export function videosLeftOut(DISPLAY, budget = VIDEO_BUDGET) {
  const dir = path.join(DISPLAY, 'photos');
  let list; try { list = fs.readdirSync(dir).filter((n) => VIDEO.test(n) && !n.startsWith('.')); } catch { return []; }
  const st = list.map((n) => { try { const s = fs.statSync(path.join(dir, n)); return { n, size: s.size, at: s.mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.at - a.at);
  let used = 0; const out = [];
  for (const v of st) { if (used + v.size > budget) out.push(v.n); else used += v.size; }
  return out;
}
/** The family's things from the display folder into a .tar.gz; the entries it holds. */
export async function pack(DISPLAY, tgz, { videoBudget = VIDEO_BUDGET } = {}) {
  const entries = INCLUDE.filter((e) => fs.existsSync(path.join(DISPLAY, e)));
  if (!entries.length) throw new Error('nothing to back up');
  // (names in photos/ are only letters, digits, - _ and ., so none reads as a tar pattern)
  const out = videosLeftOut(DISPLAY, videoBudget).flatMap((n) => [`--exclude=photos/${n}`, `--exclude=photos/.stills/${n}.jpg`]);
  await run('tar', ['-czf', tgz, ...EXCLUDE.map((x) => `--exclude=${x}`), '--exclude=photos/.incoming', ...out, '-C', DISPLAY, ...entries]); // links stay links: never followed
  return entries;
}
/** After a restore put [restored] photos in place: the videos (and their stills) that were on this tablet and aren't in
 *  it (left out of the backup for size, or newer than it) come back from [aside], so a restore never loses a video. */
export function keptVideos(aside, restored) {
  let names; try { names = fs.readdirSync(aside).filter((n) => VIDEO.test(n) && !n.startsWith('.')); } catch { return 0; }
  let n = 0;
  for (const v of names) {
    if (fs.existsSync(path.join(restored, v))) continue;
    try { fs.renameSync(path.join(aside, v), path.join(restored, v)); n++; } catch { continue; }
    const still = path.join(aside, '.stills', v + '.jpg');
    if (fs.existsSync(still)) { try { fs.mkdirSync(path.join(restored, '.stills'), { recursive: true }); fs.renameSync(still, path.join(restored, '.stills', v + '.jpg')); } catch {} }
  }
  return n;
}

/** Plain HTTP(S) to the service, the shell or a presigned URL, without fetch's limits on streaming bodies. */
export function request(url, { method = 'GET', headers = {}, body = null, file = null, saveTo = null, timeout = 30e3 } = {}) {
  return new Promise((ok, no) => {
    const u = new URL(url);
    const h = { ...headers };
    if (body != null) { h['content-type'] ??= 'application/json'; h['content-length'] = Buffer.byteLength(body); }
    if (file) h['content-length'] = fs.statSync(file).size;
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: h, timeout }, async (res) => {
      if (saveTo && res.statusCode === 200) {
        try { await pipeline(res, fs.createWriteStream(saveTo, { mode: 0o600 })); ok({ status: 200 }); } catch (e) { no(e); }
        return;
      }
      let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', no);
    if (file) fs.createReadStream(file).on('error', no).pipe(req); else req.end(body ?? undefined);
  });
}
