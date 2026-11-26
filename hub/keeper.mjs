// The hub's keeper (docs/hub.md): what the tablet's shell keeps out of the bridge's reach, for a hub. The household's
// calendar links, iCloud shared albums' links, their own OpenAI key and the PIN's hash, sealed, in a folder of its own
// outside the bridge's data folder (which the assistant's tools and backups reach). Like the shell's DeviceServer, it
// reads the calendars and albums itself and hands the bridge only what they say, and it adds the OpenAI key to the
// bridge's calls at a fixed OpenAI address: nothing it keeps is ever answered back.
//
// Run by hub/start.sh, from the code (never the data folder's copy), on 127.0.0.1 with a token start.sh makes:
//   OPENHOUSE_KEEPER_DIR   its folder (0700): default <data folder>-keeper, beside the data folder, never inside it
//   KEEPER_PORT            its port on loopback (start.sh picks one); OPENHOUSE_KEEPER_TOKEN its bearer token
//   BRIDGE_URL, OPENHOUSE_TOKEN_FILE   the bridge, to hand it what the calendars and albums say (as the shell does)
//   OPENHOUSE_KEEPER_STORE  'keychain' (a Mac's default: the seal key in the login Keychain) or 'file' (Linux: the seal
//                           key in its own 0600 file in the keeper's folder)
//
// Its routes (POST, JSON), the bridge's only (bridge/hub-shell.js):
//   /calendar {url, who, name, only}  read once, then kept -> {added}   /calendar/list -> {calendars: [{id, who, name, problem}]}
//   /calendar/remove {id}             /album {url} -> {added}           /album/list -> {albums: [{id, problem}]}   /album/remove {id}
//   /openai {kind, body}              the bridge's call with the key added -> OpenAI's status and answer
//   /ownkey {key} -> {added}          /ownkey/remove                    /status -> {openai, pin, calendars, albums}
//   /pin/set {pin, only_if_none}      /pin/check {pin} -> {ok}          /pin/clear (the console's owner code only: hub.js)
//   /sync                             read the calendars and albums now
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicGet } from '../bridge/app-web.js';

const DATA = path.resolve(process.env.OPENHOUSE_DATA || '/data');
const DIR = path.resolve(process.env.OPENHOUSE_KEEPER_DIR || `${DATA.replace(/\/+$/, '')}-keeper`);
const PORT = Number(process.env.KEEPER_PORT || 0);
const TOKEN = process.env.OPENHOUSE_KEEPER_TOKEN || '';
const BRIDGE = process.env.BRIDGE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
const STORE = process.env.OPENHOUSE_KEEPER_STORE || (process.platform === 'darwin' ? 'keychain' : 'file');
const log = (...a) => console.log('[keeper]', ...a); // never a link, a host, a key or a PIN

if (!TOKEN || TOKEN.length < 32) { log('no OPENHOUSE_KEEPER_TOKEN: not starting'); process.exit(1); }
if (DIR === DATA || DIR.startsWith(DATA + path.sep)) { log('its folder must not be inside the data folder'); process.exit(1); }
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DIR, 0o700); } catch {}

// --- the seal --------------------------------------------------------------------------------------------------
// One 256-bit key seals everything (AES-256-GCM). On a Mac it's in the login Keychain (one item per keeper folder),
// written through `security -i` so it never shows in a process list; on Linux in its own 0600 file here.
const SERVICE = 'computer.openhouse.keeper', ACCOUNT = crypto.createHash('sha256').update(DIR).digest('hex').slice(0, 16);
function sealKey() {
  if (STORE === 'keychain') {
    const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8' });
    if (r.status === 0 && /^[0-9a-f]{64}$/.test(r.stdout.trim())) return Buffer.from(r.stdout.trim(), 'hex');
    if (fs.existsSync(path.join(DIR, 'secrets.sealed'))) throw new Error('the Keychain has no seal key for what is kept here');
    const k = crypto.randomBytes(32);
    const w = spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "Opie hub keeper" -w ${k.toString('hex')}\n`, encoding: 'utf8' });
    if (w.status !== 0) throw new Error('could not keep a seal key in the Keychain');
    return k;
  }
  const f = path.join(DIR, 'seal.key');
  try { const k = fs.readFileSync(f); if (k.length === 32) return k; } catch {}
  if (fs.existsSync(path.join(DIR, 'secrets.sealed'))) throw new Error('seal.key is missing');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k, { mode: 0o600, flag: 'wx' });
  return k;
}
const KEY = sealKey();
const FILE = path.join(DIR, 'secrets.sealed');
let kept = (() => {
  try {
    const b = fs.readFileSync(FILE), d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch (e) { if (e.code !== 'ENOENT') log('what was kept could not be opened:', e.code || e.message); return {}; }
})();
kept.calendars ||= []; kept.albums ||= [];
function save() {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(kept)), c.final()]);
  fs.writeFileSync(FILE + '.new', Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
  fs.renameSync(FILE + '.new', FILE);
}
const id = (n) => crypto.randomBytes(n).toString('hex');

// --- calendar links (the shell's CalendarLinks.kt) -----------------------------------------------------------
const cleanCal = (raw) => {
  const u = String(raw || '').trim().replace(/^(webcals?|https?):\/\//i, 'https://');
  return u.length <= 2000 && /^https:\/\/[^\s/]+\S*$/i.test(u) ? u : null;
};
const SAID = { protocol: 'only https and webcal addresses can be read', signin: 'it has a sign-in in its address', home: "it points into a home network, which isn't read",
  notfound: "there's no site by that name, or the Wi-Fi is down", timeout: "it didn't answer", failed: "it didn't answer", redirects: 'it sent us round in circles', address: "that isn't an address" };
/** A calendar's text, or throws what to say (never with the link in it). */
async function readCal(url) {
  const r = await publicGet(url, { timeoutMs: 20000, max: 8e6, ipLiterals: false, headers: { 'user-agent': 'OpenHouse', accept: 'text/calendar,text/*;q=0.8' } });
  if (r.error) throw new Error(SAID[r.error] || "it didn't answer");
  if (r.status >= 400) throw new Error(r.status === 401 || r.status === 403 ? 'it asked for a sign-in' : r.status === 404 ? "there's nothing at that address any more" : `it answered ${r.status}`);
  const t = r.buf.toString('utf8');
  if (!/^[﻿\s]*BEGIN:VCALENDAR/i.test(t)) throw new Error(/<html/i.test(t) ? "that's a web page, not the calendar itself (look for its iCal or .ics address)" : "what's there isn't a calendar");
  return t;
}
const calProblems = new Map(), lastIcs = new Map();
let calRunning = false;
async function syncCalendars() {
  if (calRunning) return; calRunning = true;
  try {
    const feeds = [];
    for (const l of kept.calendars) {
      const f = { id: l.id, who: l.who || '', name: l.name || '', only: l.only || '', tone: l.tone || '' };
      try { f.ics = await readCal(l.url); lastIcs.set(l.id, f.ics); calProblems.delete(l.id); }
      catch (e) { calProblems.set(l.id, e.message); f.error = e.message[0].toUpperCase() + e.message.slice(1); }
      feeds.push(f);
    }
    const ok = await toBridge('/calendar/feeds', { feeds });
    log(`${feeds.length} calendar(s) ${ok ? 'sent' : 'not sent (the bridge is not up)'}`);
    if (!ok) setTimeout(syncCalendars, 60e3).unref();
  } finally { calRunning = false; }
}

// --- iCloud shared albums (the shell's AlbumLink.kt and PhotoAlbums.kt) ------------------------------------
const LINK = /^https?:\/\/(www\.)?icloud\.com\/sharedalbum\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?#([A-Za-z0-9]{10,40})$/i;
const SHARE = /^https?:\/\/(www\.|photos\.)?icloud\.com\/shared\/album\/([A-Za-z0-9_-]{15,40})\/?(\?.*)?$/i;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const tokenOf = (raw) => String(raw || '').replace(/\s/g, '').match(LINK)?.[2] || null;
const shareKey = (raw) => String(raw || '').replace(/\s/g, '').match(SHARE)?.[2] || null;
const cleanAlbum = (raw) => { const t = tokenOf(raw); if (t) return `https://www.icloud.com/sharedalbum/#${t}`; const k = shareKey(raw); return k ? `https://photos.icloud.com/shared/album/${k}` : null; };
const CK = '/database/1/com.apple.photos.cloud/production/';
const resolveUrl = (key) => `https://ckdatabasews.icloud.com${CK}public/records/resolve?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=${key}`;
const queryUrl = (part, key, token) => `${part.replace(/:443\/?$/, '').replace(/\/+$/, '')}${CK}shared/records/query?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=${key}&publicAccessAuthToken=${encodeURIComponent(token)}`;
const okPartition = (p) => /^https:\/\/p[0-9]{1,3}-ckdatabasews\.icloud\.com(:443)?\/?$/i.test(String(p || ''));
const keepField = (n) => /^res(JPEG(Thumb|Med|Large|Full)|Vid(Small|Med|Full)|Original)(Res|Width|Height|FileType)$|^(itemType|addedDate|assetDate|captionEnc|masterRef|duration)$/.test(n);
const okHost = (h) => /^p[0-9]{1,3}-sharedstreams\.icloud\.com$/i.test(String(h || ''));
const movedTo = (body) => String(body).match(/"X-Apple-MMe-Host"\s*:\s*"([a-z0-9-]+\.icloud\.com)"/i)?.[1] || null;
function hostOf(token) {
  const digits = token.startsWith('A') ? token.slice(1, 2) : token.slice(1, 3);
  let n = 0;
  for (const ch of digits) { const v = B62.indexOf(ch); if (v < 0) return 'p01-sharedstreams.icloud.com'; n = n * 62 + v; }
  return `p${String(Math.max(1, n)).padStart(2, '0')}-sharedstreams.icloud.com`;
}
/** A POST to Apple (only its own hosts: the addresses above), its status and text, at most 20 MB. */
async function apple(url, body, origin = 'https://www.icloud.com') {
  const r = await fetch(url, { method: 'POST', redirect: 'manual', body, headers: { 'content-type': 'text/plain;charset=UTF-8', origin, 'user-agent': 'openhouse-photos/0.1' }, signal: AbortSignal.timeout(30e3) });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20e6) throw new Error('Too big');
  const text = buf.toString('utf8');
  return [r.status, r.status === 330 && !movedTo(text) && r.headers.get('x-apple-mme-host') ? JSON.stringify({ 'X-Apple-MMe-Host': r.headers.get('x-apple-mme-host') }) : text];
}
class Said extends Error {}
async function webstream(token) {
  let host = hostOf(token), r = await apple(`https://${host}/${token}/sharedstreams/webstream`, '{"streamCtag":null}');
  if (r[0] === 330) { host = movedTo(r[1]); if (!okHost(host)) throw new Said("Couldn't read the album"); r = await apple(`https://${host}/${token}/sharedstreams/webstream`, '{"streamCtag":null}'); }
  if (r[0] === 200) return [host, r[1]];
  throw new Said(r[0] === 404 ? "The album isn't shared any more (its public website is off)" : "Couldn't read the album");
}
async function resolve(key) {
  const r = await apple(resolveUrl(key), JSON.stringify({ shortGUIDs: [{ value: key }] }), 'https://photos.icloud.com');
  let res = null; try { res = r[0] === 200 ? JSON.parse(r[1]).results[0] : null; } catch {}
  const access = res?.anonymousPublicAccess;
  if (!res || res.serverErrorCode || !access) throw new Said("The album isn't shared any more, or its link has run out");
  return [res, access];
}
async function checkAlbum(url) {
  try {
    const key = shareKey(url);
    if (key) await resolve(key);
    else { const s = (await webstream(tokenOf(url)))[1]; if (!Array.isArray(JSON.parse(s).photos)) throw new Said('not an album'); }
    return null;
  } catch (e) {
    return e instanceof Said || e instanceof SyntaxError ? "Couldn't read that album: iCloud has no shared album at that link. In the album's sharing settings, check that Public Website is on, then copy the link again."
      : "Couldn't read that album: iCloud didn't answer. Check the hub's internet and try again.";
  }
}
/** One album: true when photos are still to come. */
async function syncAlbum(l) {
  const key = shareKey(l.url);
  try {
    if (key) {
      const [res, access] = await resolve(key);
      if (!okPartition(access.databasePartition)) throw new Said("Couldn't read the album");
      const records = []; let rank = 0;
      for (let page = 0; page < 30; page++) {
        const q = await apple(queryUrl(access.databasePartition, key, access.token), JSON.stringify({ query: { recordType: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted', filterBy: [
          { fieldName: 'startRank', comparator: 'EQUALS', fieldValue: { value: rank, type: 'INT64' } }, { fieldName: 'direction', comparator: 'EQUALS', fieldValue: { value: 'ASCENDING', type: 'STRING' } }] }, zoneID: res.zoneID, resultsLimit: 200 }), 'https://photos.icloud.com');
        if (q[0] !== 200) throw new Said("Couldn't read the album");
        const list = JSON.parse(q[1]).records; if (!Array.isArray(list)) throw new Said("Couldn't read the album");
        let assets = 0;
        for (const rec of list) {
          if (rec.recordType !== 'CPLAsset' && rec.recordType !== 'CPLMaster') continue;
          if (rec.recordType === 'CPLAsset') assets++;
          if (!rec.fields) continue;
          records.push({ recordType: rec.recordType, recordName: rec.recordName, fields: Object.fromEntries(Object.entries(rec.fields).filter(([k]) => keepField(k))) });
        }
        if (!assets) break;
        rank += assets;
      }
      const fields = res.share?.fields;
      const said = await toBridge('/house/album/stream', { source: l.id, ck: { title: fields?.['cloudkit.title']?.value || '', expires: fields?.expiryDate?.value || 0, records } });
      albumProblems.delete(l.id);
      return said ? (said.left || 0) > (said.want?.length || 0) : true;
    }
    const token = tokenOf(l.url);
    const [host, stream] = await webstream(token);
    const said = await toBridge('/house/album/stream', { source: l.id, stream });
    albumProblems.delete(l.id);
    if (!said) return true;
    const want = Array.isArray(said.want) ? said.want : [];
    for (let i = 0; i < want.length; i += 20) {
      const r = await apple(`https://${host}/${token}/sharedstreams/webasseturls`, JSON.stringify({ photoGuids: want.slice(i, i + 20) })).catch(() => null);
      if (!r || r[0] !== 200) break;
      await toBridge('/house/album/assets', { source: l.id, assets: r[1] });
    }
    return (said.left || 0) > want.length;
  } catch (e) {
    const why = e instanceof Said ? e.message : "Couldn't reach iCloud";
    albumProblems.set(l.id, why);
    await toBridge('/house/album/stream', { source: l.id, error: why });
    return false;
  }
}
const albumProblems = new Map();
let albumRunning = false, albumTimer = null;
async function syncAlbums() {
  if (albumRunning) return; albumRunning = true;
  let more = false;
  try { for (const l of kept.albums) more = (await syncAlbum(l)) || more; }
  finally { albumRunning = false; clearTimeout(albumTimer); albumTimer = setTimeout(syncAlbums, more ? 90e3 : 30 * 60e3); albumTimer.unref?.(); }
}

// --- the household's own OpenAI key (the shell's OwnKey.kt) ------------------------------------------------
const OPENAI = 'https://api.openai.com';
const CALLS = { live: '/v1/live/sessions', responses: '/v1/responses', decisions: '/v1/decisions' };
const cleanKey = (raw) => (/^sk-[A-Za-z0-9_-]{20,300}$/.test(String(raw || '').trim()) ? String(raw).trim() : null);
async function checkKey(key) {
  try {
    const r = await fetch(`${OPENAI}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15e3) });
    return r.status === 200 ? null : r.status === 401 ? "OpenAI didn't accept that key. Check you copied all of it, or make a new one."
      : r.status === 403 ? "That key can't be used from here. On OpenAI's site, give it access to all models, or make a new one."
      : r.status === 429 ? 'OpenAI says that account is out of credit or over its limit. Add credit on OpenAI\'s site, then try again.'
      : `OpenAI didn't answer properly (${r.status}). Try again in a minute.`;
  } catch { return "The hub couldn't reach OpenAI. Check its internet and try again."; }
}
async function forward(kind, body) {
  const to = CALLS[kind];
  if (!to) return [404, { error: 'not a call this route makes' }];
  if (!kept.openai) return [409, { error: 'no_key' }];
  try {
    const r = await fetch(OPENAI + to, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${kept.openai}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(120e3) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { error: 'not json' }; }
    return [r.status, j];
  } catch { return [502, { error: 'openai unreachable' }]; }
}

// --- the PIN (the shell's ParentPin.kt): only its scrypt hash, and a few tries at a time ----------------------
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32, { N: 16384 }).toString('hex');
const validPin = (p) => /^\d{4,8}$/.test(String(p || ''));
let tries = [];
function pinCheck(pin) {
  const now = Date.now(); tries = tries.filter((t) => now - t < 5 * 60e3);
  if (tries.length >= 5) return { ok: false, error: 'Too many tries. Wait a few minutes.' };
  if (!kept.pin) return { ok: false, error: 'No PIN is set.' };
  const ok = validPin(pin) && crypto.timingSafeEqual(Buffer.from(hashPin(pin, Buffer.from(kept.pin.salt, 'hex')), 'hex'), Buffer.from(kept.pin.hash, 'hex'));
  if (!ok) tries.push(now); else tries = [];
  return { ok };
}

// --- to the bridge, as the shell does (its secret) ---------------------------------------------------------
const bridgeToken = () => { try { return fs.readFileSync(process.env.OPENHOUSE_TOKEN_FILE || path.join(DATA, '.bridge-token'), 'utf8').trim(); } catch { return ''; } };
async function toBridge(p, b) {
  try {
    const r = await fetch(BRIDGE + p, { method: 'POST', headers: { 'x-openhouse-token': bridgeToken(), 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(60e3) });
    if (!r.ok) return null;
    try { return await r.json(); } catch { return {}; }
  } catch { return null; }
}

// --- the routes ----------------------------------------------------------------------------------------------
const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function route(p, b) {
  switch (p) {
    case '/status': return [200, { openai: !!kept.openai, pin: !!kept.pin, calendars: kept.calendars.length, albums: kept.albums.length }];
    case '/calendar': {
      const url = cleanCal(b.url);
      if (!url) return [400, { error: "That isn't a calendar link (an https:// or webcal:// address ending in .ics, usually)." }];
      try { await readCal(url); } catch (e) { return [400, { error: `Couldn't read that calendar: ${e.message}.` }]; }
      const was = kept.calendars.find((c) => c.url === url);
      kept.calendars = [...kept.calendars.filter((c) => c.url !== url), { id: was?.id || id(4), who: String(b.who || '').trim().slice(0, 40), url, name: String(b.name || '').trim().slice(0, 60), only: String(b.only || '').trim().slice(0, 200), tone: was?.tone || '' }];
      save(); syncCalendars();
      return [200, { added: true }];
    }
    case '/calendar/list': return [200, { calendars: kept.calendars.map((c) => ({ id: c.id, who: c.who, name: c.name, problem: calProblems.get(c.id) || null })) }];
    case '/calendar/remove': kept.calendars = kept.calendars.filter((c) => c.id !== String(b.id)); save(); syncCalendars(); return [200, { ok: true }];
    case '/album': {
      const url = cleanAlbum(b.url);
      if (!url) return [400, { error: "That isn't an iCloud shared album link (https://www.icloud.com/sharedalbum/#... or https://photos.icloud.com/shared/album/...). In the album's sharing settings, turn on its public link (Public Website) and copy it." }];
      const why = await checkAlbum(url);
      if (why) return [400, { error: why }];
      if (!kept.albums.some((a) => a.url === url)) { kept.albums.push({ id: id(5), url }); save(); }
      syncAlbums();
      return [200, { added: true }];
    }
    case '/album/list': return [200, { albums: kept.albums.map((a) => ({ id: a.id, problem: albumProblems.get(a.id) || null })) }];
    case '/album/remove': {
      const gone = kept.albums.find((a) => a.id === String(b.id));
      kept.albums = kept.albums.filter((a) => a.id !== String(b.id)); save();
      if (gone) await toBridge('/house/album/stream', { source: gone.id, gone: true });
      return [200, { ok: true }];
    }
    case '/openai': { const [s, j] = await forward(String(b.kind || ''), b.body); return [s, j]; }
    case '/ownkey': {
      const key = cleanKey(b.key);
      if (!key) return [400, { added: false, error: "That isn't an OpenAI key. A key starts with sk- and is one long line: copy all of it." }];
      const why = await checkKey(key);
      if (why) return [400, { added: false, error: why }];
      kept.openai = key; save();
      return [200, { added: true }];
    }
    case '/ownkey/remove': delete kept.openai; save(); return [200, { ok: true }];
    case '/pin/set': {
      if (b.only_if_none && kept.pin) return [409, { error: 'A PIN is already set.' }];
      if (!validPin(b.pin)) return [400, { error: '4 to 8 digits.' }];
      const salt = crypto.randomBytes(16);
      kept.pin = { salt: salt.toString('hex'), hash: hashPin(b.pin, salt) }; save();
      return [200, { ok: true }];
    }
    case '/pin/check': return [200, pinCheck(b.pin)];
    case '/pin/clear': delete kept.pin; save(); return [200, { ok: true }];
    case '/sync': syncCalendars(); syncAlbums(); return [200, { ok: true }];
    default: return [404, { error: 'not here' }];
  }
}

const server = http.createServer((req, res) => {
  const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (req.method !== 'POST' || !same(req.headers.authorization, `Bearer ${TOKEN}`)) return send(403, { error: 'no' });
  let n = 0; const parts = [];
  req.on('data', (d) => { n += d.length; if (n > 2e6) req.destroy(); else parts.push(d); });
  req.on('end', async () => {
    let b = {}; try { b = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { return send(400, { error: 'json' }); }
    try { const [s, j] = await route(new URL(req.url, 'http://x').pathname, b && typeof b === 'object' ? b : {}); send(s, j); }
    catch (e) { log('error:', e.code || e.constructor.name); send(500, { error: 'the keeper failed' }); }
  });
});
server.listen(PORT, '127.0.0.1', () => {
  log(`keeping ${kept.calendars.length} calendar(s), ${kept.albums.length} album(s)${kept.openai ? ', an OpenAI key' : ''}${kept.pin ? ', a PIN' : ''} (${STORE})`);
  setTimeout(syncCalendars, 20e3).unref(); setInterval(syncCalendars, 15 * 60e3).unref();
  albumTimer = setTimeout(syncAlbums, 40e3); albumTimer.unref?.();
});
