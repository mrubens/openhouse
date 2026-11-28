// The hub's keeper (docs/hub.md): what the tablet's shell keeps out of the bridge's reach, for a hub. The household's
// calendar links, iCloud shared albums' links, their own OpenAI key, their own storage bucket's key and the PIN's hash, sealed, in a folder of its own
// outside the bridge's data folder (which the assistant's tools and backups reach). Like the shell's DeviceServer, it
// reads the calendars and albums itself and hands the bridge only what they say, and it adds the OpenAI key to the
// bridge's calls at a fixed OpenAI address: nothing it keeps is ever answered back.
//
// Run by hub/start.sh, from the code (never the data folder's copy), on 127.0.0.1 with a token start.sh makes:
//   OPENHOUSE_KEEPER_DIR   its folder (0700): default <data folder>-keeper, beside the data folder, never inside it
//   KEEPER_PORT            its port on loopback (start.sh picks one); OPENHOUSE_KEEPER_TOKEN its bearer token (or
//                          OPENHOUSE_KEEPER_TOKEN_FILE: on a Linux hub it runs as its own user, hub/install.sh)
//   BRIDGE_URL, OPENHOUSE_TOKEN_FILE   the bridge, to hand it what the calendars and albums say (as the shell does)
//   OPENHOUSE_KEEPER_STORE  'keychain' (a Mac's default: the seal key in the login Keychain) or 'file' (Linux: the seal
//                           key in its own 0600 file in the keeper's folder)
//
// It is one of the bridge's hosts (bridge/host.js, docs/host.md): the same requests as the tablet's shell
// (DeviceServer.kt), with the same answers, for what it can do, and /host says what that is.
//   /host -> {kind, can}              what it can do (host.js CAPS)
//   /approve {title, detail, more, yes, no, rights, danger, later, pin, grownup, waitMs} -> {yes, answered}
//                                     an "Is this OK?" card: it waits here until a person answers it on a settings device
//                                     or a grown-up's phone (the bridge shows /cards there), or its time is up
//   /cards -> {cards}                 the cards waiting   /cards/answer {id, yes, later?, pin?, who} a person's answer (the PIN
//                                     is checked here, for a card that needs it once one is set)
//   /calendar {url, who, name, only, from, trusted}  read once, then kept after a yes (trusted: the setup's own, no card)
//                                     -> {added}   /calendar/list -> {calendars: [{id, who, name, problem}]}
//   /calendar/remove {id}             /album {url, from, trusted} -> {added} (its card needs the PIN)           /album/list -> {albums: [{id, problem}]}   /album/remove {id}
//   /openai {kind, body}              the bridge's call with the key added -> OpenAI's status and answer
//   /ownkey {key} -> {added}          /ownkey/remove (both tell the bridge whether there is one: /cloud/own)                    /status -> {openai, pin, calendars, albums}
//   /setup/pin {pin}                  the PIN chosen in the setup, only while none is set
//   /pin/set {pin, only_if_none}      /pin/check {pin, who} -> {ok, error?, wait?} (who: the device, for its tries)
//   /pin/clear                        only after the console made forget-pin in this folder (hub/owner-code.sh)
//   /sync                             read the calendars and albums now
//   Two-way calendars (the shell's CalendarAccounts.kt; the bridge's calendar-sync.js does the syncing):
//   /calendar/accounts -> {accounts: [{id, provider, name, who, server?}]} (no secrets)
//   /calendar/request {account, method, url, headers, body}  a request to that account's own service, signed in here
//   /calendar/account/caldav (or /setup/icloud) {user, pass, who}   iCloud: kept once its calendars are found (the sign-in checked)
//   /calendar/account/google {refresh}           Google: a refresh token from the cloud's sign-in   /calendar/account/remove {id}
//   The household's own storage bucket for backups (the shell's OwnStorage.kt, hub/s3.mjs): kept here with its secret
//   /storage/status -> {set, endpoint, region, bucket, prefix}   (never the key or the secret)
//   /storage/set {endpoint, region, bucket, prefix, keyId, secret} -> {ok} once the Check (write, read, delete) works
//   /storage/sign {method, name} or {method: 'GET', list: true, token?} -> {url}: one presigned request, for minutes
//   /storage/remove
//   Google Photos (the shell's GooglePhotos.kt): /photos/google {token} picks with Google's Picker and copies what was
//   picked into the household's photos; /photos/google/status -> {state, pickerUri?, done?, total?, error?}
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicGet } from '../bridge/app-web.js';
import * as s3 from './s3.mjs';

const DATA = path.resolve(process.env.OPENHOUSE_DATA || '/data');
const DIR = path.resolve(process.env.OPENHOUSE_KEEPER_DIR || `${DATA.replace(/\/+$/, '')}-keeper`);
const PORT = Number(process.env.KEEPER_PORT || 0);
// (a token file: a keeper run as a user of its own, hub/install.sh, with a token the bridge reads from the same file)
const TOKEN = process.env.OPENHOUSE_KEEPER_TOKEN || (() => { try { return fs.readFileSync(process.env.OPENHOUSE_KEEPER_TOKEN_FILE, 'utf8').trim(); } catch { return ''; } })();
const BRIDGE = process.env.BRIDGE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
const STORE = process.env.OPENHOUSE_KEEPER_STORE || (process.platform === 'darwin' ? 'keychain' : 'file');
const log = (...a) => console.log('[keeper]', ...a); // never a link, a host, a key or a PIN

if (!TOKEN || TOKEN.length < 32) { log('no OPENHOUSE_KEEPER_TOKEN: not starting'); process.exit(1); }
if (DIR === DATA || DIR.startsWith(DATA + path.sep)) { log('its folder must not be inside the data folder'); process.exit(1); }
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DIR, 0o700); } catch {}
// On Linux, hub/install.sh runs the keeper as a user of its own, so code run as the bridge's user can't read the seal key.
try { if (STORE === 'file' && fs.statSync(DATA).uid === process.getuid?.()) log("running as the bridge's user: code run as that user could open what's kept here (hub/install.sh gives the keeper a user of its own)"); } catch {}

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
kept.calendars ||= []; kept.albums ||= []; kept.accounts ||= [];
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
// Wrong tries are counted per device (`who`, the settings device or phone the bridge says it came from), kept sealed so
// a restart doesn't wipe them. After FREE wrong ones in a row a device waits, a minute and then twice as long each
// time, up to a day. All devices together get ALL_FREE before everyone waits the same way: the bridge names the
// device, so that's the bound on a bridge that makes up new names, and one device alone takes days to reach it.
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32, { N: 16384 }).toString('hex');
const validPin = (p) => /^\d{4,8}$/.test(String(p || ''));
const FREE = 5, ALL_FREE = 20, DAY = 24 * 3600e3;
const waitFor = (n, free) => (n < free ? 0 : Math.min(60e3 * 2 ** (n - free), DAY));
function pinCheck(pin, who) {
  const now = Date.now(), w = String(who || '').slice(0, 80) || 'unknown';
  const t = (kept.pinTries ||= { all: { n: 0, until: 0 }, by: {} });
  const mine = t.by[w] || { n: 0, until: 0 };
  const until = Math.max(mine.until, t.all.until);
  if (until > now) { const m = Math.ceil((until - now) / 60e3); return { ok: false, wait: until - now, error: `Too many tries. Try again in ${m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.ceil(m / 60)} hours`}.` }; }
  if (!kept.pin) return { ok: false, error: 'No PIN is set.' };
  const ok = validPin(pin) && crypto.timingSafeEqual(Buffer.from(hashPin(pin, Buffer.from(kept.pin.salt, 'hex')), 'hex'), Buffer.from(kept.pin.hash, 'hex'));
  if (ok) {
    if (t.by[w] || t.all.n) { delete t.by[w]; t.all = { n: 0, until: 0 }; save(); }
    return { ok };
  }
  mine.n++; mine.until = now + waitFor(mine.n, FREE); mine.at = now; t.by[w] = mine;
  t.all.n++; t.all.until = now + waitFor(t.all.n, ALL_FREE);
  // (a bounded list: devices not seen for a day and not waiting go, and never more than 200)
  const names = Object.keys(t.by).filter((k) => k === w || t.by[k].until > now || now - (t.by[k].at || 0) < DAY);
  t.by = Object.fromEntries(names.slice(-200).map((k) => [k, t.by[k]]));
  save();
  return { ok };
}

// A lost PIN is forgotten only from the hub's console: a file named forget-pin in the keeper's own folder, which
// only the keeper's user (or root) can make on a Linux hub (hub/install.sh), never with the bridge's token alone.
const FORGET = path.join(DIR, 'forget-pin');
function forgetPin() {
  let st; try { st = fs.statSync(FORGET); } catch { return false; }
  fs.rmSync(FORGET, { force: true });
  if (Date.now() - st.mtimeMs > 3600e3) return false; // (one left from long ago)
  delete kept.pin; delete kept.pinTries; save();
  log('the PIN is forgotten (from the console)');
  return true;
}

// --- to the bridge, as the shell does (its secret) ---------------------------------------------------------
const bridgeToken = () => { if (process.env.OPENHOUSE_TOKEN) return process.env.OPENHOUSE_TOKEN; try { return fs.readFileSync(process.env.OPENHOUSE_TOKEN_FILE || path.join(DATA, '.bridge-token'), 'utf8').trim(); } catch { return ''; } };
async function toBridge(p, b, { full = false, body: raw = null, type = 'application/json' } = {}) {
  try {
    const r = await fetch(BRIDGE + p, { method: 'POST', headers: { 'x-openhouse-token': bridgeToken(), 'content-type': type }, body: raw ?? JSON.stringify(b), signal: AbortSignal.timeout(90e3) });
    let j = {}; try { j = await r.json(); } catch {}
    return full ? { status: r.status, json: j } : r.ok ? j : null;
  } catch { return full ? { status: 0, json: {} } : null; }
}

// --- two-way calendars (the shell's CalendarAccounts.kt) ----------------------------------------------------
const GOOGLE_API = 'https://www.googleapis.com/calendar/v3/', ICLOUD = 'https://caldav.icloud.com/';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'REPORT']), PASS = new Set(['content-type', 'if-match', 'if-none-match', 'depth']);
const tokens = new Map(); // account -> [access token, until]: memory only
const publicAccount = (a) => ({ id: a.id, provider: a.provider, name: a.name, who: a.who, ...(a.provider === 'caldav' ? { server: a.server } : {}) });
/** Only this account's own service: Google's Calendar API, or its CalDAV server (iCloud's are all *.icloud.com). */
function allowedFor(a, u) {
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (a.provider === 'google') return u.host === 'www.googleapis.com' && u.pathname.startsWith('/calendar/v3/');
  let home; try { home = new URL(a.server).host; } catch { return false; }
  return u.host === home || (home.endsWith('icloud.com') && u.host.endsWith('.icloud.com'));
}
async function access(a, fresh) {
  const t = tokens.get(a.id);
  if (!fresh && t && t[1] > Date.now()) return t[0];
  const r = await toBridge('/cloud/google/refresh', { refresh_token: a.secret }, { full: true });
  if (r.status === 200 && String(r.json.access_token || '').length > 10) { tokens.set(a.id, [r.json.access_token, Date.now() + ((Number(r.json.expires_in) || 3600) - 120) * 1000]); return r.json.access_token; }
  if (r.json.error === 'invalid_grant') { tokens.delete(a.id); throw new Said('signin'); }
  throw new Said(r.json.error === 'unlinked' ? "The hub isn't linked to Opie cloud" : "Google isn't reachable right now");
}
async function calRequest(b) {
  const a = kept.accounts.find((x) => x.id === String(b.account || ''));
  if (!a) return { error: 'no such account' };
  let u; try { u = new URL(String(b.url || '')); } catch { return { error: 'bad address' }; }
  const method = String(b.method || '').toUpperCase();
  if (!METHODS.has(method) || !allowedFor(a, u)) return { error: 'not for this account' };
  const hs = {};
  for (const [k, v] of Object.entries(b.headers || {})) if (PASS.has(k.toLowerCase())) hs[k.toLowerCase()] = String(v).slice(0, 300);
  const body = b.body == null || b.body === '' ? undefined : String(b.body);
  const send = async (fresh) => {
    const auth = a.provider === 'google' ? `Bearer ${await access(a, fresh)}` : `Basic ${Buffer.from(`${a.user}:${a.secret}`).toString('base64')}`;
    const r = await fetch(u, { method, headers: { ...hs, authorization: auth, 'user-agent': 'openhouse-calendar/0.2' }, body, redirect: 'manual', signal: AbortSignal.timeout(30e3) });
    const text = await r.text();
    if (text.length > 6e6) throw new Error('too big');
    return { status: r.status, body: text, headers: { ...(r.headers.get('etag') ? { etag: r.headers.get('etag') } : {}), ...(r.headers.get('location') ? { location: r.headers.get('location') } : {}) } };
  };
  try {
    let r = await send(false);
    if (r.status === 401 && a.provider === 'google') r = await send(true); // expired early
    return r;
  } catch (e) { return e instanceof Said ? (e.message === 'signin' ? { status: 401, body: '' } : { error: e.message }) : { error: "Couldn't reach it" }; }
}
/** Kept, then its calendars found through the bridge (which checks the sign-in); dropped again if that didn't work. */
async function addAccount(acct) {
  kept.accounts = [...kept.accounts.filter((x) => x.id !== acct.id), acct]; save();
  const r = await toBridge('/calendar/sync/discover', { account: acct.id }, { full: true });
  if (r.status === 200) return null;
  kept.accounts = kept.accounts.filter((x) => x.id !== acct.id); save(); tokens.delete(acct.id);
  return r.json.signin ? (acct.provider === 'caldav' ? "That didn't sign in. Check the Apple ID, and use an app-specific password (not the Apple ID's own)." : "Google didn't let it sign in. Try again.")
    : r.json.error || "Couldn't reach the calendars. Try again in a moment.";
}

// --- Google Photos (the shell's GooglePhotos.kt): one picking at a time, its token in memory only ----------------
const PICKER = 'https://photospicker.googleapis.com/v1';
let picking = { state: 'none' }, pickRun = 0;
async function pick(token) {
  const me = ++pickRun;
  const call = async (method, url, body) => {
    const r = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(60e3) });
    if (r.status === 401 || r.status === 403) throw new Said('Google said no. Sign in again.');
    if (!r.ok) throw new Said(`Google said ${r.status}. Try again.`);
    return r.status === 204 ? {} : r.json();
  };
  let session = null;
  try {
    const s = await call('POST', `${PICKER}/sessions`, '{}');
    session = s.id;
    picking = { state: 'picking', pickerUri: s.pickerUri };
    const every = Math.max(2, Math.min(30, parseFloat(String(s.pollingConfig?.pollInterval || '5s')) || 5)) * 1000, until = Date.now() + 25 * 60e3;
    for (;;) {
      if (pickRun !== me) return;
      if (Date.now() > until) throw new Said('That took too long. Start again.');
      await new Promise((ok) => setTimeout(ok, every));
      if ((await call('GET', `${PICKER}/sessions/${session}`)).mediaItemsSet) break;
    }
    const items = []; let page = null;
    do {
      const j = await call('GET', `${PICKER}/mediaItems?sessionId=${session}&pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      for (const m of j.mediaItems || []) if (m.type === 'PHOTO' && /^https:\/\//.test(m.mediaFile?.baseUrl || '')) items.push(m.mediaFile.baseUrl);
      page = j.nextPageToken || null;
    } while (page && items.length < 300);
    const todo = items.slice(0, 300); let done = 0;
    picking = { state: 'copying', done, total: todo.length };
    for (const u of todo) {
      if (pickRun !== me) return;
      try {
        const r = await fetch(`${u}=w2400-h2400`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60e3) });
        const buf = Buffer.from(await r.arrayBuffer());
        if (r.ok && /^image\//.test(r.headers.get('content-type') || '') && buf.length < 25e6 && await toBridge(`/house/photo?name=google-${id(4)}.jpg`, null, { body: buf, type: 'image/jpeg' })) done++;
      } catch {}
      picking = { state: 'copying', done, total: todo.length };
    }
    picking = { state: 'done', done, total: todo.length };
    log(`google photos: copied ${done} of ${todo.length}`);
  } catch (e) {
    picking = { state: 'error', error: e instanceof Said ? e.message : "Google didn't answer. Try again." };
  } finally {
    if (session) fetch(`${PICKER}/sessions/${session}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  }
}

// --- the cards (the shell's ApprovalCard) -------------------------------------------------------------------
// Each waits for a person's answer on a settings device or a grown-up's phone (the bridge lists /cards there); one
// that needs the PIN takes a yes only with it, checked here.
const CAN = ['cards', 'approve', 'calendar', 'calendar-accounts', 'openai', 'pin', 'storage'];
const waiting = new Map(); // id -> { card, done, until, timer }
function ask(b = {}) {
  const cid = crypto.randomBytes(6).toString('hex');
  const waitMs = Math.max(10e3, Math.min(600e3, Number(b.waitMs) || 90e3));
  const t = (v, n) => String(v ?? '').slice(0, n);
  const card = { id: cid, title: t(b.title, 200), detail: t(b.detail, 800), more: b.more ? t(b.more, 2000) : null, yes: t(b.yes, 20).trim() || 'Allow', no: t(b.no, 24).trim() || null,
    rights: Array.isArray(b.rights) ? b.rights.slice(0, 12).map((r) => ({ kind: t(r?.kind, 20), text: t(r?.text, 300) })) : [], danger: !!b.danger, later: !!b.later,
    pin: !!b.grownup || !!b.pin };
  return new Promise((resolve) => {
    const done = (a) => { const w = waiting.get(cid); if (!w) return; clearTimeout(w.timer); waiting.delete(cid); resolve(a); };
    waiting.set(cid, { card, done, until: Date.now() + waitMs, timer: setTimeout(() => done({ yes: false, answered: false }), waitMs) });
    log(`a card is waiting (${waitMs / 1000} s)`);
  });
}
const cards = () => [...waiting.values()].map((w) => ({ ...w.card, pin: w.card.pin && !!kept.pin, until: w.until }));
function answerCard(b = {}) {
  const w = waiting.get(String(b.id || ''));
  if (!w) return [400, { error: 'That question is no longer waiting.' }];
  if (b.yes === true && w.card.pin && kept.pin) {
    const c = pinCheck(b.pin, b.who);
    if (!c.ok) return [403, { error: c.error || 'That PIN isn\'t right.', pin: true }];
  }
  w.done(b.yes === true ? { yes: true, answered: true } : b.later === true ? { yes: false, answered: false } : { yes: false, answered: true });
  return [200, { ok: true }];
}
const linkHost = (u) => { try { return new URL(String(u).replace(/^webcals?:/i, 'https:')).host; } catch { return ''; } };
/** A link from the assistant or a computer is kept only after a person's yes (the setup's own: trusted). */
async function yesFor(p, b) {
  if (b.trusted === true) return true;
  const a = await ask({ title: p === '/calendar' ? `Add ${b.name || (b.who ? `${b.who}'s calendar` : 'this calendar')}?` : 'Add this iCloud shared album?',
    detail: [linkHost(b.url), b.from ? `Sent by ${String(b.from).slice(0, 40)}.` : ''].filter(Boolean).join('\n'), yes: 'Add', pin: p === '/album', waitMs: 95e3 });
  return a.yes;
}

// --- the routes ----------------------------------------------------------------------------------------------
const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
async function route(p, b) {
  switch (p) {
    case '/host': return [200, { kind: 'keeper', can: CAN }];
    case '/approve': return [200, await ask(b)];
    case '/cards': return [200, { cards: cards() }];
    case '/cards/answer': return answerCard(b);
    case '/status': return [200, { openai: !!kept.openai, pin: !!kept.pin, calendars: kept.calendars.length, albums: kept.albums.length, storage: !!kept.storage }];
    case '/storage/status': return [200, s3.shown(kept.storage)];
    case '/storage/set': {
      const c = s3.cleanStorage(b);
      if (c.error) return [400, { error: c.error }];
      const why = await s3.check(c.cfg);
      if (why) return [400, { error: why }];
      kept.storage = c.cfg; save();
      return [200, { ok: true, ...s3.shown(c.cfg) }];
    }
    case '/storage/sign': {
      if (!kept.storage) return [409, { error: 'no_storage' }];
      const r = s3.sign(kept.storage, b);
      return r.error ? [400, r] : [200, r];
    }
    case '/storage/remove': delete kept.storage; save(); return [200, { ok: true }];
    case '/calendar': {
      const url = cleanCal(b.url);
      if (!url) return [400, { error: "That isn't a calendar link (an https:// or webcal:// address ending in .ics, usually)." }];
      try { await readCal(url); } catch (e) { return [400, { error: `Couldn't read that calendar: ${e.message}.` }]; }
      if (!(await yesFor('/calendar', { ...b, url }))) return [200, { added: false }];
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
      if (!(await yesFor('/album', { ...b, url }))) return [200, { added: false }];
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
      await toBridge('/cloud/own', { on: true }); // (as the shell tells it: only whether there is one)
      return [200, { added: true }];
    }
    case '/ownkey/remove': delete kept.openai; save(); await toBridge('/cloud/own', { on: false }); return [200, { ok: true }];
    case '/setup/pin': b = { pin: b.pin, only_if_none: true }; // (falls through: the setup's PIN, only while none is set)
    case '/pin/set': {
      if (b.only_if_none && kept.pin) return [409, { error: 'A PIN is already set.' }];
      if (!validPin(b.pin)) return [400, { error: '4 to 8 digits.' }];
      const salt = crypto.randomBytes(16);
      kept.pin = { salt: salt.toString('hex'), hash: hashPin(b.pin, salt) }; save();
      return [200, { ok: true }];
    }
    case '/pin/check': return [200, pinCheck(b.pin, b.who)];
    case '/pin/clear': return forgetPin() ? [200, { ok: true }] : [403, { error: 'Only from the hub itself: hub/owner-code.sh --forget-pin there.' }];
    case '/sync': syncCalendars(); syncAlbums(); return [200, { ok: true }];
    case '/calendar/accounts': return [200, { accounts: kept.accounts.map(publicAccount) }];
    case '/calendar/request': return [200, await calRequest(b)];
    case '/calendar/account/caldav': case '/setup/icloud': {
      const user = String(b.user || '').trim().slice(0, 200), pass = String(b.pass || '').replace(/ /g, '').trim().slice(0, 100), who = String(b.who || '').trim().slice(0, 40);
      if (user.length < 3 || pass.length < 8) return [400, { error: 'Both are needed: the Apple ID and an app-specific password.' }];
      const why = await addAccount({ id: id(4), provider: 'caldav', name: who ? `${who}'s iCloud` : 'iCloud', who, server: ICLOUD, user, secret: pass });
      return why ? [400, { error: why }] : [200, { ok: true }];
    }
    case '/calendar/account/google': {
      const t = String(b.refresh || '');
      if (t.length < 20 || t.length > 2048) return [400, { error: 'That sign-in didn\'t come through. Try again.' }];
      const acct = { id: id(4), provider: 'google', name: 'Google', who: '', server: '', user: '', secret: t };
      kept.accounts.push(acct); save();
      // Its name: the account's own address (its primary calendar's id), so two Google accounts can be told apart.
      try { const r = await calRequest({ account: acct.id, method: 'GET', url: GOOGLE_API + 'calendars/primary' }); const n = JSON.parse(r.body || '{}').id; if (n) acct.name = String(n).slice(0, 80); } catch {}
      const why = await addAccount(acct);
      return why ? [400, { error: why }] : [200, { ok: true }];
    }
    case '/calendar/account/remove': {
      kept.accounts = kept.accounts.filter((x) => x.id !== String(b.id)); save(); tokens.delete(String(b.id));
      await toBridge('/calendar/sync/forget', { account: String(b.id) });
      return [200, { ok: true }];
    }
    case '/photos/google': {
      const t = String(b.token || '');
      if (t.length < 20 || t.length > 4096) return [400, { error: 'That sign-in didn\'t come through. Try again.' }];
      picking = { state: 'starting' }; pick(t);
      for (let i = 0; i < 40 && picking.state === 'starting'; i++) await new Promise((ok) => setTimeout(ok, 250)); // the picker's address, if it comes quickly
      return [200, picking];
    }
    case '/photos/google/status': return [200, picking];
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
// Started by a bridge itself (host.js, a laptop trying the keeper): it goes when that bridge goes, however it went.
const PARENT = Number(process.env.OPENHOUSE_KEEPER_PARENT || 0);
if (PARENT) setInterval(() => { try { process.kill(PARENT, 0); } catch { process.exit(0); } }, 1000).unref();
server.listen(PORT, '127.0.0.1', () => {
  log(`keeping ${kept.calendars.length} calendar(s), ${kept.albums.length} album(s)${kept.openai ? ', an OpenAI key' : ''}${kept.pin ? ', a PIN' : ''}${kept.storage ? ', a storage key' : ''} (${STORE})`);
  setTimeout(syncCalendars, 20e3).unref(); setInterval(syncCalendars, 15 * 60e3).unref();
  albumTimer = setTimeout(syncAlbums, 40e3); albumTimer.unref?.();
});
