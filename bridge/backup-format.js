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

// What a backup holds, relative to the display folder (the ones that exist): the family's apps with their git
// history, chats (and the home screen's look, door.json), the household, photos, app data, the house's devices, the
// chosen model. Not voice/: the wake model, which the display downloads (it held taught voices once; none are kept now). Never: sign-ins for Claude or ChatGPT (in the runtime and the agent's app, outside this
// folder), the runtime, the bridge and its secret, .cloud/ (the credential) or .backup/ (the key).
export const INCLUDE = ['webapp', 'chats', 'household.json', 'house.json', 'photos', 'appdata', 'devices.json', 'agent-model.json',
  'preferences.md', 'heartbeat.json', 'flyers', 'mail.json']; // what the assistant learned, the heartbeat's notes, scanned flyers, email's approved senders (not the messages, mail/)
// .l2s.*: proot's stand-ins for hard links (git makes them); inside the runtime the real files read normally.
const EXCLUDE = ['node_modules', '.vite', '*.tmp', '.l2s.*'];
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
/** The family's things from the display folder into a .tar.gz; the entries it holds. */
export async function pack(DISPLAY, tgz) {
  const entries = INCLUDE.filter((e) => fs.existsSync(path.join(DISPLAY, e)));
  if (!entries.length) throw new Error('nothing to back up');
  await run('tar', ['-czf', tgz, ...EXCLUDE.map((x) => `--exclude=${x}`), '-C', DISPLAY, ...entries]); // links stay links: never followed
  return entries;
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
