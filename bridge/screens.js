// Screens: other devices on the home network that show and use the same home screen (docs/brain-screens.md).
//
// Off until someone adds a screen from Settings. Then a second listener answers on the home network
// (SCREENS_PORT, 8788). Without a key it only serves the screen page's files and pairing. Everything else is one
// sealed route, /s: plain http, so each request and reply is sealed with ChaCha20-Poly1305, with a key that's the
// screen's own.
//
// Pairing (Settings shows a QR code: http://<brain>:8788/screen/#<pairing>.<one-time key>):
//   POST /pair/hello {pair, box}   box: {name} sealed with the one-time key, label "hello:<pair>"
//   GET  /pair/wait?pair=          long poll; once the brain answered: {box}, sealed the same way, label "welcome:<pair>":
//                                  {id, key, scopes, name}, or {refused: true}. One answer, then the pairing is gone.
// A screen's requests:
//   POST /s  (x-screen: <id>)      body: nonce|ciphertext|tag of {n, m, p, b} (counter, method, path, JSON body),
//                                  label "req:<id>". Reply: frames, each [u32 length][sealed], label "res:<id>:<n>:<i>";
//                                  frame 0 is {status, type}, then data, then an empty end frame (type byte 0, 1, 2).
// The loopback listener (the display's secret, so the shell's Settings) runs it:
//   GET  /screens                  {lan, port, screens: [{id, name, scopes, added, seen}], asking: [{pair, name, via}]}
//   POST /screens/lan {on}         the home-network listener on or off (screens stay paired)
//   POST /screens/pair             a new pairing, 10 min: {pair, key, port}; turns the listener on
//   POST /screens/pair {kind: "computer"}   a computer's pairing (someone's own AI app, workshop.js): {pair, code,
//                                  port, extension}. A person types the code, so it's short (12 characters, 60 bits); the pairing
//                                  id and one-time key come from it through scrypt (pairingFromCode), so a recorded
//                                  hello can't be guessed back to the code while the pairing lasts. With {address} (the
//                                  tablet's own, from the shell): while it lasts, the listener serves the page to add
//                                  Opie to Claude (connect-page.js, without the code) and the bridge answers
//                                  openhouse.local. extension: the https copy of the Claude app's download, for the
//                                  tablet's screen to name (null when there's none).
//   POST /screens/pair/end {pair}  the Connect screen closed: its page and name go now
//   POST /screens/answer {pair, yes}   a screen that asked to join: let it in, or not
//   POST /screens/revoke {id}      that screen's key stops working now, and its open requests end
// Away from home (relay.js, docs/networking.md): the same sealed requests can arrive through the cloud's relay
// instead of the home network (handle.relayed), from a device holding its relay token (handle.relayTokens: derived
// from its key, handed over sealed by GET /relay/me). `away` is when one last came that way.
//
// Apps for screens (docs/phones-and-tv.md): an app whose app.json says "screens": ["tv"] is what a paired TV shows.
//   GET /screens/apps  (sealed, door scope)  [{id, name, at}]: the apps for this screen's kind, the household's own first;
//                                  at is /screen-app/<id>/<token>/, the token the screen's own (from its key).
//                                  A phone's: [{id, name, icon, shared, v}], every app that runs on phones.
//   GET /screens/app-files?app=  (sealed, door scope, a phone)  {v, files}: that app's files, for its frame on the phone.
//   GET /screen-app/<id>/<token>/<file>   that app's files, on the home network: the screen loads them into a sandboxed
//                                  frame, and everything the app reads goes through the screen's sealed requests
//                                  (marked with the app, {a}: read only, and only what that app may see).
//
// A screen gets scopes, an allowlist of routes; nothing else reaches the bridge from the network.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { guarded } from './guarded.js';
import { readJson, writeJson } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { newCode, pairingFromCode } from './pair-code.js';
import { responder, page as connectPage, downloads, extensionCopy, HOSTNAME } from './connect-page.js';
import * as push from './web-push.js';
import { homePath } from './home-screen.js';
import { kitFile } from './kit-version.js';

export { newCode, pairingFromCode };

/** What each scope lets a screen do. Never: undo, restore, deleting apps, the builder, the agents' MCP, devices, the household, voices, calendars, screens. */
const RULES = [
  ['door', 'GET', /^\/(home|home\/wait|home\/sketch|weather|board|house|house\/wait|apps|state)$/],
  ['door', 'GET', /^\/house\/photo\/[^/]{1,120}$/],
  ['door', 'GET', /^\/screens\/apps$/], // the apps for this kind of screen (a TV's layout, a phone's tabs)
  ['door', 'GET', /^\/screens\/app-files$/], // one app's files, for a phone's frame (appFiles)
  ['arrange', 'POST', /^\/home\/(arrange|place|remove|putback|keep|touch|timer|sketch)$/],
  ['arrange', 'POST', /^\/house\/(list|chore|remind|thing)$/], // the widgets' own taps: a grocery ticked, a chore done, a reminder or a thing on Home put away
  ['ask', 'POST', /^\/chat(\/stop|\/warm)?$/],
  ['ask', 'GET', /^\/chats\/[\w-]{1,40}$/],
  ['ask', 'POST', /^\/house\/recipe-link$/], // a recipe's link shared from a phone (the Recipes app)
  ['ask', 'POST', /^\/phone\/album$/], // an iCloud album's link from a grown-up's phone, no PIN (server.js: only a phone with 'ask')
  // 'workshop': a computer someone paired, whose own AI app (Claude, ChatGPT) changes the apps and the home screen
  // with the assistant's tools (workshop.js). Only computers get it, and they get nothing else.
  ['door', 'GET', /^\/relay\/me$/], ['workshop', 'GET', /^\/relay\/me$/], // the relay's address and this device's token (relay.js)
  ['workshop', 'POST', /^\/workshop\/mcp$/],
  // 'notify': a phone that may be sent a note for its person (Web Push, web-push.js): its push address, and the key it checks.
  ['notify', 'GET', /^\/phone\/push$/], ['notify', 'POST', /^\/phone\/push$/],
  // 'ask' on a phone: its own share address for the iPhone's Send to Opie shortcut (the share key, docs/phones.md), and
  // sending to Opie from the page itself (Android's share sheet). The shortcut's own requests reach only /phone/share.
  ['ask', 'GET', /^\/phone\/share-key$/], ['ask', 'POST', /^\/phone\/share$/],
  ['notify', 'GET', /^\/phone\/messages$/], // what Opie was asked to tell this phone's person lately (message_family, live-tools.js)
  // 'setup': the phone or computer someone set the tablet up from (the setup's own code, scanned or typed): adds
  // calendars and albums (server.js, straight to the shell) and invites the rest of the family (handle.invite).
  ['setup', 'POST', /^\/setup\/(calendar|album|invite)$/],
  // 'voice': talking to Opie from this device (chat/src/live-voice.js, docs/hub.md): the same live voice the tablet has,
  // its session started through the cloud (server.js /live/start) and its tools run here. A browser gives a page the
  // microphone only on https or localhost, so on the Wi-Fi's plain http address the page doesn't offer it.
  ['voice', 'GET', /^\/live\/setup$/],
  ['voice', 'POST', /^\/live\/(start|tool|said|usage)$/],
  // 'admin': the hub's own settings (docs/hub.md), what the tablet's Settings do behind its PIN: devices, the account,
  // live voice, backups, reaching it from away, updates. Only a hub hands it out: to the device that typed the code the
  // hub printed when it started (someone with the hub's console), and to devices that one adds as admins.
  ['admin', 'GET', /^\/(screens|cloud\/status|cloud\/voice|backup\/status|backup\/list|backup\/recovery-code|relay|hub)$/],
  ['admin', 'POST', /^\/screens\/(pair|pair\/end|answer|revoke)$/],
  ['admin', 'POST', /^\/cloud\/(link\/start|link\/confirm|link\/cancel|unlink|voice|voice\/name)$/],
  ['admin', 'POST', /^\/backup\/(dest|now|restore|escrow|recovery-code\/confirmed)$/],
  ['admin', 'POST', /^\/(relay|hub\/update|webmcp)$/], ['admin', 'GET', /^\/webmcp$/], // the connector at the household's own address (web-mcp.js)
];
// door: see the home screen and the house (read only). The name is from before and stays: paired screens hold it.
export const SCOPES = ['door', 'arrange', 'ask', 'voice', 'workshop', 'notify', 'setup', 'admin'];
export const COMPUTER_SCOPES = ['workshop'];

export const DEFAULT_SCOPES = ['door', 'arrange', 'ask', 'voice'];
/** A TV only shows (photos, Today, the week): it's across the room, often in a room for guests. docs/phones-and-tv.md */
export const TV_SCOPES = ['door'];
/** A phone is someone's: someone's sees, ticks, asks and gets notes; a kid's sees, ticks and gets notes. */
export const PHONE_SCOPES = { grownup: ['door', 'arrange', 'ask', 'notify', 'voice'], kid: ['door', 'arrange', 'notify'] };
/** A hub's settings device (docs/hub.md): a screen that may also change the hub's settings. */
export const ADMIN_SCOPES = [...DEFAULT_SCOPES, 'admin'];
export function allowed(scopes, method, pathname) {
  return RULES.some(([s, m, re]) => scopes.includes(s) && m === method && re.test(pathname));
}

const b64 = (b) => Buffer.from(b).toString('base64url');
export function seal(key, aad, plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
}
export function open(key, aad, box) {
  try {
    if (box.length < 28) return null;
    const d = crypto.createDecipheriv('chacha20-poly1305', key, box.subarray(0, 12), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad)); d.setAuthTag(box.subarray(box.length - 16));
    return Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]);
  } catch { return null; }
}

/** A paired device's token for the relay: from its own key, so there is nothing new to keep or hand out on the Wi-Fi. */
export const relayToken = (key) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(key, 'base64url'), Buffer.alloc(0), 'openhouse relay', 16)).toString('base64url');
/** A phone's share key (docs/phones.md, "Send to Opie"): its iPhone shortcut seals with this, through the cloud, and it
 *  may only send something to Opie (POST /phone/share). From the phone's own key, so removing the phone ends it too. */
export const shareKey = (key) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(key, 'base64url'), Buffer.alloc(0), 'openhouse share', 32));
/** A phone's note key (docs/iphone-app.md): notes for the iPhone app go through the cloud and APNs sealed with this, and
 *  only the phone's notification extension opens them. From the phone's own key, like the share key. */
export const noteKey = (key) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(key, 'base64url'), Buffer.alloc(0), 'openhouse note', 32));

const TYPES = { '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const PAGE_HEADERS = {
  'cache-control': 'no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; img-src 'self' blob: data: https:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self' wss: ws://10.0.2.2:* ws://localhost:*; frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; form-action 'none'; frame-ancestors 'none'",
};
// A screen app's files: it runs in a sandboxed frame (no origin of its own), so it can't reach the screen's key, and
// it can't fetch anything itself: what it reads comes from the page around it (the kit asks it), sealed.
// ('self' means nothing to a page with no origin, so the address it came from is named instead.)
const appHeaders = (host) => ({
  'cache-control': 'no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*',
  'content-security-policy': `default-src 'none'; script-src ${host}; style-src ${host} 'unsafe-inline'; img-src ${host} blob: data:; media-src blob:; font-src ${host} data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`,
});
const APP_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** Which apps a kind of screen shows (app.json "screens"). */
export const SCREEN_KINDS = ['tv', 'phone'];

// One app's files for a phone (docs/phones.md, "Every app"): the phone's page runs the app in a sandboxed frame with no
// origin of its own, which can't load anything from the tablet itself, so its files come in one sealed reply (kept on
// the phone by v, so a tab opens at once the next time). The kit files it names come along.
const TEXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.csv', '.webmanifest', '.xml']);
const KIND = { ...TYPES, '.mjs': 'text/javascript', '.htm': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.otf': 'font/otf', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream' };
const FILE_MAX = 3e6, ALL_MAX = 8e6;
/** The app's files ([{rel, f}]), and the kit's that they name ([{rel: 'kit/…', f}]): never a dot name, app.json, or past 4 deep. */
export function appFileList(APP_DIR, id, kitDir) {
  const root = path.join(APP_DIR, 'apps', id), out = [];
  const walk = (d, rel, depth) => {
    let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (depth < 4) walk(f, r, depth + 1); }
      else if (e.isFile() && r !== 'app.json') out.push({ rel: r, f });
    }
  };
  walk(root, '', 0);
  const kit = new Set(['openhouse.js']);
  for (const x of out) if (TEXT.has(path.extname(x.rel)) && fs.statSync(x.f).size < FILE_MAX) for (const m of fs.readFileSync(x.f, 'utf8').matchAll(/\/kit\/((?:v\d{1,3}\/)?[\w-]+(?:\.[\w-]+)+)/g)) kit.add(m[1]);
  // (/kit/openhouse.js is the kit version its app.json names, kit-version.js)
  let v = null; try { v = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).kit; } catch {}
  for (const k of [...kit].sort()) { const n = kitFile(k, Number.isInteger(v) ? v : null), f = n && path.join(kitDir, n); if (kitDir && f && fs.existsSync(f) && fs.statSync(f).isFile()) out.push({ rel: 'kit/' + k, f }); }
  return out;
}
/** Does it import an installed library (three, phaser: what the tablet's dev server finds by name)? A phone's frame
 *  runs only the app's own files and the kit, so such an app stays on the tablet for now. */
export function usesPackages(list) {
  const BARE = /\b(?:import\s*(?:[\w$*{}\s,]+?\s*from\s*)?|export\s*(?:\*|\{[^}]*\})\s*from\s*|import\s*\(\s*)['"](?![./]|https?:)[^'"\n]+['"]/;
  return list.some((x) => /\.m?js$/.test(x.rel) && !x.rel.startsWith('kit/') && (() => { try { return BARE.test(fs.readFileSync(x.f, 'utf8')); } catch { return false; } })());
}
/** When an app's files (or the kit's it uses) last changed, as a short hash: the phone keeps its copy by this. */
export function appVersion(list) {
  const h = crypto.createHash('sha256');
  for (const x of list) { try { const st = fs.statSync(x.f); h.update(`${x.rel}|${st.size}|${Math.round(st.mtimeMs)}\n`); } catch {} }
  return h.digest('base64url').slice(0, 16);
}
/** {v, files: {rel: {t, s} | {t, b}}}: text as is, anything else base64; files over 3 MB, or past 8 MB in all, are left out. */
export function appFiles(APP_DIR, id, kitDir) {
  const list = appFileList(APP_DIR, id, kitDir), files = {};
  let total = 0;
  for (const x of list) {
    let buf; try { buf = fs.readFileSync(x.f); } catch { continue; }
    if (buf.length > FILE_MAX || total + buf.length > ALL_MAX) continue;
    total += buf.length;
    const ext = path.extname(x.rel).toLowerCase(), t = KIND[ext] || 'application/octet-stream';
    files[x.rel] = TEXT.has(ext) ? { t, s: buf.toString('utf8') } : { t, b: buf.toString('base64') };
  }
  return { v: appVersion(list), files };
}
// The page a phone's app frame starts as (chat/phone-frame.html): it may be framed only by the phone's page, and it and
// the app in it reach nothing (connect-src 'none'): every call goes to the page around it, which seals it.
/** The hosts a frame may reach, from its address (?r=a.example.org,*.b.example.org): the app's own "reaches", as on the
 *  tablet, which the phone's page names when it makes the frame. (A frame that sets its own address to name others
 *  gets nothing: the page sends an app's files only once to each frame, and makes a new frame when one goes elsewhere.) */
export const frameReaches = (r) => [...new Set(String(r || '').toLowerCase().split(',').filter((h) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$/.test(h) && h.length <= 120))].slice(0, 14).map((h) => `https://${h}`).join(' ');
export const frameHeaders = (host, reaches = '') => ({
  'cache-control': 'max-age=3600', // (the same for every app, and a new frame for each: kept an hour, not asked for each time) 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': `default-src 'none'; script-src ${host} blob: 'unsafe-eval'; style-src ${host} blob: 'unsafe-inline'; img-src ${host} blob: data:${reaches ? ' ' + reaches : ''}; media-src blob: data:${reaches ? ' ' + reaches : ''}; font-src ${host} blob: data:; worker-src blob:; connect-src ${reaches || "'none'"}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri https://app.invalid; frame-ancestors ${host}`,
});

/**
 * dispatch(req, res, url): the bridge's own routes, after its secret is checked (server.js). A screen's opened
 * request is handed to it as if it came from the display, once its scopes allow it.
 */
// How long a connection on the home network may take (screensRoutes startLan): its headers, its body, and with nothing
// either way; checked every tick.
export const LAN_TIMES = { headers: 20e3, request: 60e3, idle: 180e3, tick: 5e3 };
export function screensRoutes({ HERE, LAN_MS = LAN_TIMES, KIT = path.join(HERE, 'kit'), json, body, dispatch, onChange = () => {}, kit = () => false, screenApps = () => [], APP_DIR = null, apns = null, PUBLIC = path.join(HERE, 'public'), PORT = Number(process.env.SCREENS_PORT || 8788), HOST = process.env.SCREENS_HOST || '0.0.0.0', FILE = path.join(HERE, 'screens.json'), lanTls = null, TLS_FILES = process.env.HUB_TLS_CERT && process.env.HUB_TLS_KEY ? { cert: process.env.HUB_TLS_CERT, key: process.env.HUB_TLS_KEY } : null }) {
  // (no .bak: a phone taken off must not come back from an older copy)
  const state = readJson(registered('screens', FILE), null, { bak: false }) || { lan: false, screens: [] };
  state.screens ||= [];
  state.invites ||= []; // [{pair, key, person, grownup, until}]: links sent to the family from the setup phone, a week each
  const write = () => writeJson(FILE, state, { bak: false, mode: 0o600 });
  const changed = () => { try { onChange(); } catch {} }; // who is paired changed (the relay's list of tokens)
  // Counters: a request's n must be new: above `floor` (the highest before the last restart), not seen, and within a
  // minute of the highest (they can arrive out of order).
  const seen = new Map(); // id -> Set of recent n
  for (const s of state.screens) { s.floor = s.high || 0; s.shareFloor = s.shareHigh || 0; }
  // Talking to Opie came after typing (2026-11-20): a phone or screen that may ask gets 'voice' too, as new ones do.
  if (state.screens.some((s) => (s.scopes || []).includes('ask') && !s.scopes.includes('voice') && (s.kind === 'phone' || !s.kind || s.kind === 'screen'))) {
    for (const s of state.screens) if ((s.scopes || []).includes('ask') && !s.scopes.includes('voice') && (s.kind === 'phone' || !s.kind || s.kind === 'screen')) s.scopes.push('voice');
    try { write(); } catch {}
  }

  const pairs = new Map(); // pair id -> { key, until, name, asked, answer, waiters, misses }
  // A link sent to someone in the family joins them as soon as they open it (the phone that sent it was the tablet's own
  // setup device): no Allow on the tablet. Kept across restarts, a week each.
  for (const v of state.invites) if (v.until > Date.now()) pairs.set(v.pair, { key: Buffer.from(v.key, 'base64url'), kind: 'phone', person: v.person, grownup: !!v.grownup, pre: true, until: v.until, name: null, asked: false, answer: null, waiters: new Set(), misses: 0 });
  const live = new Map(); // screen id -> Set of open requests (to end on revoke)
  const misses = new Map(); // address -> { n, since }: requests that didn't open
  const blocked = (ip) => { const m = misses.get(ip); return !!m && m.n >= 30 && Date.now() - m.since < 10 * 60e3; };
  const miss = (ip) => { const m = misses.get(ip); if (!m || Date.now() - m.since > 10 * 60e3) misses.set(ip, { n: 1, since: Date.now() }); else m.n++; };
  const sweep = () => {
    for (const [id, p] of pairs) if (p.until < Date.now()) { pairs.delete(id); for (const w of p.waiters) w(); }
    if (connect && connect.until < Date.now()) closeConnect();
    if (setupNamed && ![...pairs.values()].some((x) => x.setup)) { setupNamed = false; if (!connect) named.stop(); }
    const n = state.invites.length; state.invites = state.invites.filter((v) => v.until > Date.now() && pairs.has(v.pair)); if (state.invites.length !== n) write();
  };
  let setupNamed = false; // openhouse.local answers while the setup's code lasts (a computer types the address)
  // The Connect screen's page (connect-page.js): open with one computer pairing, for as long as it lasts.
  let connect = null; // { pair, address, until, away } (never the code: the page mustn't have it)
  const named = responder();
  const httpsCopy = extensionCopy(HERE); httpsCopy(); // the download's https copy (connect-page.js): asked once now, so the first Connect screen has it
  const closeConnect = (pair) => { if (!connect || (pair && connect.pair !== pair)) return; connect = null; named.stop(); };
  setInterval(() => { if (connect && connect.until < Date.now()) closeConnect(); }, 15e3).unref();

  let lan = null;
  // A hub may answer on https (docs/hub.md: its own certificate, e.g. from Tailscale or mkcert), so a phone's browser lets
  // the page use the microphone for live voice. The tablet doesn't: plain http, sealed requests.
  const TLS = (() => { try { return TLS_FILES ? { cert: fs.readFileSync(TLS_FILES.cert), key: fs.readFileSync(TLS_FILES.key) } : null; } catch (e) { console.log('[screens] no https:', e.message); return null; } })();
  // The tablet: plain http, and on the same port https with its own name's certificate once it has one (lan-tls.js):
  // a connection that starts with a TLS handshake goes to the https server, any other to the http one.
  let plainLan = null, secureLan = null, secureFor = null;
  function secureContext() {
    const t = lanTls?.tls();
    if (!t) return null;
    if (secureFor !== t.cert) { // (a new certificate: renewed, or a new name)
      if (secureLan) secureLan.setSecureContext({ key: t.key, cert: t.cert });
      else secureLan = https.createServer({ key: t.key, cert: t.cert, minVersion: 'TLSv1.2' }, timed(guarded('screens', onLan)));
      secureFor = t.cert;
    }
    return secureLan;
  }
  // The inner servers never listen themselves, so their own timeouts never run: each connection is timed here. A
  // request's headers (and, on https, the handshake) must be in within LAN_MS.headers of the connection or of the last
  // answer, its body within LAN_MS.request of its headers, and a connection with nothing either way for LAN_MS.idle
  // is closed (a long poll answers within 25 s).
  const conns = new Map(); // raw socket -> {due: a time it must be past by, or 0; read, wrote, at: its last bytes}
  let lanTick = null;
  function lanConnection(sock) {
    const c = { due: Date.now() + LAN_MS.headers, read: 0, wrote: 0, at: Date.now() };
    conns.set(sock, c);
    sock.once('close', () => conns.delete(sock));
    sock.once('error', () => sock.destroy());
    sock.once('data', (first) => {
      sock.pause(); sock.unshift(first);
      ((first[0] === 0x16 && secureContext()) || plainLan).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  }
  function sweepLan() {
    const t = Date.now();
    for (const [sock, c] of conns) {
      if (sock.bytesRead !== c.read || sock.bytesWritten !== c.wrote) { c.read = sock.bytesRead; c.wrote = sock.bytesWritten; c.at = t; }
      if ((c.due && t > c.due) || t - c.at > LAN_MS.idle) sock.destroy();
    }
  }
  /** A request on one of those connections: its body is timed, then nothing until it's answered, then the next one's headers. */
  const timed = (handler) => (req, res) => {
    const c = conns.get(req.socket) || conns.get(req.socket?._parent); // (on https, the TLS socket over the raw one)
    if (c) {
      c.due = req.complete ? 0 : Date.now() + LAN_MS.request;
      req.once('end', () => { if (!res.writableFinished) c.due = 0; });
      res.once('finish', () => { c.due = Date.now() + LAN_MS.headers; });
    }
    return handler(req, res);
  };
  function startLan() {
    if (lan) return;
    if (TLS) { lan = https.createServer({ ...TLS, headersTimeout: LAN_MS.headers, requestTimeout: LAN_MS.request }, guarded('screens', onLan)); lan.timeout = LAN_MS.idle; }
    else {
      plainLan = http.createServer(timed(guarded('screens', onLan)));
      lan = net.createServer(lanConnection);
      lanTick = setInterval(sweepLan, LAN_MS.tick); lanTick.unref?.();
    }
    lan.on('error', (e) => { console.log('[screens] listener:', e.code || e.message); lan = null; });
    lan.listen(PORT, HOST, () => console.log(`[screens] on the home network, ${TLS ? 'https' : 'http and https'} :${PORT}`));
  }
  function stopLan() {
    if (!lan) return;
    for (const set of live.values()) for (const r of set) r.end();
    lan.close(); lan.closeAllConnections?.(); lan = null;
    for (const sock of conns.keys()) sock.destroy(); // (every connection it took, whichever server it went to)
    conns.clear(); clearInterval(lanTick); lanTick = null;
    plainLan = null; secureLan = null; secureFor = null;
    console.log('[screens] off the home network');
  }
  /** Where a phone or screen on the Wi-Fi goes for this tablet: its https name while that works (lan-tls.js), else null. */
  const lanBase = () => (TLS ? null : lanTls?.base() || null);
  if (state.lan) startLan();

  /** A screen's token for an app's files: from its key, so it's the screen's own and ends with it. */
  const appToken = (s, id) => crypto.createHmac('sha256', Buffer.from(s.key, 'base64url')).update('screen-app:' + id).digest('base64url').slice(0, 22);
  const sameStr = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const appsFor = (s) => (SCREEN_KINDS.includes(s?.kind) ? screenApps(s.kind) : []);

  const pub = (s) => ({ id: s.id, name: s.name, kind: s.kind || 'screen', scopes: s.scopes, added: s.added, seen: s.seen || null, away: s.away || null,
    ...(s.person ? { person: s.person, push: !!(s.push || s.apns) } : {}) });

  /** Yes or no to a device that asked: a yes makes it its own key and scopes, sealed to it with the pairing's key. */
  function answer(pairId, x, yes) {
    let welcome = { refused: true };
    if (yes) {
      const computer = x.kind === 'computer';
      const s = { id: (computer ? 'c-' : 's-') + crypto.randomBytes(4).toString('hex'), name: x.typedName || x.name, kind: x.kind, key: b64(crypto.randomBytes(32)), scopes: [...(computer ? COMPUTER_SCOPES : x.kind === 'tv' ? TV_SCOPES : x.kind === 'phone' ? PHONE_SCOPES[x.grownup ? 'grownup' : 'kid'] : x.admin ? ADMIN_SCOPES : DEFAULT_SCOPES), ...(x.setup ? ['setup'] : [])], added: Date.now(), seen: null, high: 0, floor: 0,
        ...(x.kind === 'phone' ? { person: x.person } : {}) };
      state.screens.push(s); write(); changed();
      welcome = { id: s.id, key: s.key, scopes: s.scopes, name: s.name, kind: s.kind, ...(s.person ? { person: s.person } : {}) };
      // A computer may have paired through the cloud (the setup page's prompt, from a chat's sandbox or away from home):
      // where to find the tablet afterwards, on the Wi-Fi and through the relay (its token comes from the key).
      if (computer) {
        if (connect?.pair === pairId && connect.address) welcome.base = `http://${connect.address}:${PORT}`;
        const r = handle.relayAt?.();
        if (r?.url && r.relay) welcome.relay = { url: r.url, relay: r.relay };
      }
    }
    x.answer = seal(x.key, `welcome:${pairId}`, Buffer.from(JSON.stringify(welcome)));
    if (state.invites.some((v) => v.pair === pairId)) { state.invites = state.invites.filter((v) => v.pair !== pairId); write(); } // an invite is used once
    closeConnect(pairId); // the code is used: its page goes too
    for (const w of x.waiters) w(); x.waiters.clear();
  }

  /** The loopback routes (Settings). */
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/screens' && !p.startsWith('/screens/')) return false;
    sweep();
    if (req.method === 'GET' && p === '/screens') {
      json(res, 200, { lan: !!state.lan, listening: !!lan, port: PORT, base: lanBase(), https: lanTls?.status() || null, screens: state.screens.map(pub), invites: state.invites.map((v) => v.person),
        asking: [...pairs].filter(([, x]) => x.asked && !x.answer).map(([pair, x]) => ({ pair, name: x.name, kind: x.kind, via: x.via, ...(x.person ? { person: x.person } : {}) })) });
      return true;
    }
    if (req.method !== 'POST') return false;
    const b = await body(req);
    // The tablet's address on the Wi-Fi, from the shell (as the router gives it): for its https name (lan-tls.js).
    if (p === '/screens/address') { const ok = !!lanTls?.address(b.address); json(res, ok ? 200 : 400, { ok, https: lanTls?.status() || null, base: lanBase() }); return true; }
    if (p === '/screens/lan') { state.lan = !!b.on; write(); state.lan ? startLan() : stopLan(); json(res, 200, { ok: true, lan: state.lan }); return true; }
    if (p === '/screens/pair') {
      const computer = b.kind === 'computer', tv = b.kind === 'tv', phone = b.kind === 'phone' || b.setup === true, setup = b.setup === true;
      const person = phone ? String(b.person || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : null;
      if (phone && !person) { json(res, 400, { error: 'whose phone?' }); return true; }
      let pair, key, code = null;
      if (tv) { // the TV shows a code and someone types it here (Settings): typing it is the yes
        const from = pairingFromCode(b.code);
        if (!from) { json(res, 400, { error: "That isn't the TV's code. It's 12 letters and numbers." }); return true; }
        ({ pair, key } = from);
      }
      else if (computer) {
        do { code = newCode(); ({ pair, key } = pairingFromCode(code)); } while (pairs.has(pair));
        const address = /^\d{1,3}(\.\d{1,3}){3}$/.test(String(b.address || '')) ? String(b.address) : null;
        closeConnect();
        connect = { pair, address, until: Date.now() + 10 * 60e3, away: handle.awayForConnect?.() || null };
        if (address) named.start(address);
      }
      else if (setup) { // the setup's own: a phone scans it, or a computer types its code at openhouse.local:8788/phone
        for (const [id, x] of pairs) if (x.setup) pairs.delete(id); // one at a time
        do { code = newCode(); ({ pair, key } = pairingFromCode(code)); } while (pairs.has(pair));
        const address = /^\d{1,3}(\.\d{1,3}){3}$/.test(String(b.address || '')) ? String(b.address) : null;
        if (address) { named.start(address); setupNamed = true; }
      }
      else if (b.code === true) { // a hub's settings page (docs/hub.md): a code to type on the device, besides its link
        do { code = newCode(); ({ pair, key } = pairingFromCode(code)); } while (pairs.has(pair));
      }
      else { pair = b64(crypto.randomBytes(6)); key = crypto.randomBytes(32); }
      pairs.set(pair, { key, kind: computer ? 'computer' : tv ? 'tv' : phone ? 'phone' : 'screen', admin: !computer && !tv && !phone && b.admin === true, person, grownup: phone && (b.grownup === true || setup), setup, pre: setup || phone, typed: tv, typedName: tv ? String(b.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || null : null, until: Date.now() + 10 * 60e3, name: null, asked: false, answer: null, waiters: new Set(), misses: 0 });
      if (!state.lan) { state.lan = true; write(); }
      startLan();
      if (computer) changed(); // the relay hears of the code (relay.js), for the web connector
      if (setup) pairs.get(pair).until = Date.now() + 30 * 60e3;
      json(res, 200, computer ? { pair, code, port: PORT, minutes: 10, host: connect.address ? HOSTNAME : null, away: connect.away, extension: httpsCopy()?.url || null } : tv ? { pair, port: PORT, minutes: 10 }
        : setup ? { pair, key: b64(key), code, port: PORT, minutes: 30, host: setupNamed ? HOSTNAME : null, base: lanBase() } : { pair, key: b64(key), port: PORT, minutes: 10, base: lanBase(), ...(code ? { code } : {}) });
      return true;
    }
    if (p === '/screens/pair/end') { closeConnect(String(b.pair || '')); json(res, 200, { ok: true }); return true; }
    if (p === '/screens/answer') {
      const x = pairs.get(String(b.pair || ''));
      if (!x || !x.asked || x.answer) { json(res, 404, { error: 'no such screen asking' }); return true; }
      answer(String(b.pair), x, b.yes === true);
      json(res, 200, { ok: true });
      return true;
    }
    if (p === '/screens/revoke') {
      const id = String(b.id || ''), before = state.screens.length;
      state.screens = state.screens.filter((s) => s.id !== id);
      if (state.screens.length !== before) { write(); changed(); }
      for (const r of live.get(id) || []) r.end();
      live.delete(id); seen.delete(id);
      json(res, 200, { ok: state.screens.length !== before });
      return true;
    }
    json(res, 404, { error: 'not found' });
    return true;
  }

  function plain(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  const raw = (req, max) => new Promise((resolve) => {
    const parts = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { req.destroy(); resolve(null); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', () => resolve(null));
  });

  /** A device's hello with its pairing's one-time key: from the home network, or (a computer's) through the relay. */
  function hello(b, ip, { relayable = null } = {}) {
    const x = pairs.get(String(b.pair || ''));
    const opened = x && !x.asked && (!relayable || relayable(x)) && open(x.key, `hello:${b.pair}`, Buffer.from(String(b.box || ''), 'base64url'));
    if (!opened) {
      miss(ip);
      if (x && ++x.misses >= 5) { pairs.delete(String(b.pair)); changed(); } // guessing at a pairing: it ends
      return { status: 400, json: { error: 'no' } };
    }
    let name = 'A screen';
    try { name = String(JSON.parse(opened.toString()).name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || name; } catch {}
    // The name is the caller's own; how it came isn't: on the Wi-Fi, or through the cloud (the web connector). Either
    // way it had the code, which only the tablet's own screen shows.
    x.name = name; x.asked = true; x.via = ip.startsWith('relay:') ? 'cloud' : 'wifi';
    console.log('[screens] a screen asks to join');
    if (x.typed || x.pre) answer(String(b.pair), x, true); // a TV whose code someone typed on the tablet; the setup's own code, an invite from it, or a phone's code the tablet showed for someone (whoever scans it is standing at the tablet)
    return { status: 200, json: { ok: true } };
  }

  /** The home-network listener. */
  async function onLan(req, res) {
    const ip = req.socket.remoteAddress || '?';
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (connect && connect.until < Date.now()) closeConnect();
      if (connect && req.method === 'GET' && (p === '/' || p === '/openhouse.mcpb' || p === '/openhouse-mcp.mjs')) return connectRoute(req, res, p);
      if (req.method === 'GET' && (p === '/' || p === '/screen')) { res.writeHead(302, { location: '/screen/' }); return res.end(); }
      if (req.method === 'GET' && p === '/phone') { res.writeHead(302, { location: '/phone/' }); return res.end(); }
      if (req.method === 'GET' && p === '/hub') { res.writeHead(302, { location: '/hub/' }); return res.end(); } // the hub's settings (docs/hub.md)
      if (req.method === 'GET' && p === '/tv') { res.writeHead(302, { location: '/screen/?tv' }); return res.end(); } // short, to type with a TV's remote
      if (req.method === 'GET' && p.startsWith('/kit/')) return kit(req, res, url); // the look: fonts and colors
      const sa = req.method === 'GET' && p.match(/^\/screen-app\/([a-z0-9][a-z0-9-]{0,60})\/([\w-]{22})\/(.*)$/);
      if (sa) return screenAppFile(req, res, ip, sa[1], sa[2], sa[3]);
      const file = req.method === 'GET' && p.match(/^\/(screen|app|phone|hub)\/(.*)$/);
      if (file && file[1] === 'phone' && /^frame\.(html|js)$/.test(file[2])) { // an app frame's starting page (frameHeaders)
        const f = path.join(PUBLIC, 'phone', file[2]);
        if (!fs.existsSync(f)) return plain(res, 404, { error: 'not found' });
        const host = /^[a-z0-9.-]{1,80}(:\d{2,5})?$/i.test(String(req.headers.host || '')) ? req.headers.host : `127.0.0.1:${PORT}`;
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)], ...frameHeaders(`${req.socket.encrypted ? 'https' : 'http'}://${host}`, frameReaches(url.searchParams.get('r'))) });
        return res.end(fs.readFileSync(f));
      }
      if (file) {
        const root = path.join(PUBLIC, file[1]);
        const f = path.join(root, path.normalize(file[2] || 'index.html').replace(/^(\.\.[/\\])+/, ''));
        if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return plain(res, 404, { error: 'not found' });
        // A phone's page frames only its apps' starting page (here): an app can't send its frame anywhere else.
        const csp = file[1] === 'phone' ? { 'content-security-policy': PAGE_HEADERS['content-security-policy'].replace(/frame-src [^;]*/, "frame-src 'self'") } : {};
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...PAGE_HEADERS, ...csp });
        return res.end(fs.readFileSync(f));
      }
      if (blocked(ip)) return plain(res, 429, { error: 'wait' });
      sweep();
      if (req.method === 'POST' && p === '/pair/hello') {
        const r = hello(JSON.parse((await raw(req, 4096))?.toString() || '{}'), ip);
        return plain(res, r.status, r.json);
      }
      if (req.method === 'GET' && p === '/pair/about') return plain(res, 200, { hub: process.env.OPENHOUSE_HUB === '1' }); // where a device says yes (docs/hub.md)
      if (req.method === 'GET' && p === '/pair/ready') { // a TV showing its code: has the tablet taken it yet?
        const x = pairs.get(String(url.searchParams.get('pair') || ''));
        return plain(res, 200, { ready: !!(x && x.typed && !x.asked) });
      }
      if (req.method === 'GET' && p === '/pair/wait') {
        const pair = String(url.searchParams.get('pair') || ''), x = pairs.get(pair);
        if (!x || !x.asked) { if (pair !== '-') miss(ip); return plain(res, 404, { error: 'ended' }); } // ('-': a paired device asking whether it's home, screen-client.js)
        const reply = () => { if (x.answer) { pairs.delete(pair); plain(res, 200, { box: b64(x.answer) }); } else if (!pairs.has(pair)) plain(res, 404, { error: 'ended' }); else plain(res, 200, { waiting: true }); };
        if (x.answer) return reply();
        const t = setTimeout(() => { x.waiters.delete(done); reply(); }, 25e3);
        const done = () => { clearTimeout(t); reply(); };
        x.waiters.add(done);
        req.on('close', () => { clearTimeout(t); x.waiters.delete(done); });
        return;
      }
      if (req.method === 'POST' && p === '/s') return await sealed(req, res, ip);
      plain(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[screens]', e.message);
      if (!res.headersSent) plain(res, 500, { error: 'failed' });
    }
  }

  /** A screen app's file, for a screen that holds its token. */
  function screenAppFile(req, res, ip, id, token, rel) {
    if (blocked(ip)) return plain(res, 429, { error: 'wait' });
    const s = state.screens.find((x) => sameStr(token, appToken(x, id)));
    if (!s || s.kind !== 'tv' || !APP_DIR || !appsFor(s).some((a) => a.id === id)) { miss(ip); return plain(res, 404, { error: 'not found' }); }
    const root = path.join(APP_DIR, 'apps', id);
    const f = path.join(root, path.normalize(rel || 'index.html').replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || path.basename(f) === 'app.json') return plain(res, 404, { error: 'not found' });
    const host = /^[a-z0-9.-]{1,80}(:\d{2,5})?$/i.test(String(req.headers.host || '')) ? req.headers.host : `127.0.0.1:${PORT}`;
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...appHeaders(`${req.socket.encrypted ? 'https' : 'http'}://${host}`) });
    return res.end(fs.readFileSync(f));
  }

  /** The Connect screen's page and its downloads (only while it's open). */
  function connectRoute(req, res, p) {
    const host = /^[a-z0-9.-]{1,80}(:\d{2,5})?$/i.test(String(req.headers.host || '')) ? req.headers.host : `${connect.address || '127.0.0.1'}:${PORT}`;
    const head = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
    if (p === '/') {
      res.writeHead(200, { ...head, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self'; form-action 'none'; frame-ancestors 'none'" });
      // Never the code: this is plain http on the Wi-Fi (connect-page.js).
      return res.end(connectPage({ host: connect.address && named.on ? `${HOSTNAME}:${PORT}` : host, away: !!handle.awayOn?.(), extension: httpsCopy() }));
    }
    const d = downloads(HERE), f = p === '/openhouse.mcpb' ? d.mcpb : d.script;
    if (!f) return plain(res, 404, { error: 'not built' });
    res.writeHead(200, { ...head, 'content-type': p === '/openhouse.mcpb' ? 'application/octet-stream' : 'text/javascript; charset=utf-8',
      ...(p === '/openhouse.mcpb' ? { 'content-disposition': 'attachment; filename="openhouse.mcpb"' } : {}) });
    fs.createReadStream(f).pipe(res);
  }

  async function sealed(req, res, ip) {
    const id = String(req.headers['x-screen'] || '');
    const s = state.screens.find((x) => x.id === id);
    if (!s) { miss(ip); return plain(res, 401, { error: 'unknown screen' }); }
    let key = Buffer.from(s.key, 'base64url');
    const box = await raw(req, 8e6);
    let opened = box && open(key, `req:${id}`, box), share = false;
    // Sealed with the phone's share key instead (its shortcut, through the cloud): one thing only, sending to Opie.
    if (!opened && box && s.kind === 'phone') { const k = shareKey(s.key); opened = open(k, `share:${id}`, box); if (opened) { key = k; share = true; } }
    let msg = null;
    try { msg = opened && JSON.parse(opened.toString()); } catch {}
    if (!msg || !Number.isSafeInteger(msg.n) || typeof msg.p !== 'string' || !['GET', 'POST'].includes(msg.m)) { miss(ip); return plain(res, 400, { error: 'no' }); }
    if (!share && box.length > 2e6) { miss(ip); return plain(res, 413, { error: 'too big' }); }
    const recent = seen.get((share ? 'share:' : '') + id) || new Set();
    // Screens count in microseconds of their own clock: a minute's window for requests that arrive out of order. A share
    // counts with the cloud's clock instead (milliseconds x 1000): its own counter, within five minutes of the tablet's.
    const WINDOW = 60e6, [HIGH, FLOOR] = share ? ['shareHigh', 'shareFloor'] : ['high', 'floor'];
    if (share && Math.abs(msg.n / 1000 - Date.now()) > 5 * 60e3) return plain(res, 409, { error: 'clock' });
    if (msg.n <= (s[FLOOR] || 0) || recent.has(msg.n) || msg.n <= (s[HIGH] || 0) - WINDOW) return plain(res, 409, { error: 'replay', high: s[HIGH] });
    recent.add(msg.n); seen.set((share ? 'share:' : '') + id, recent);
    for (const x of recent) if (x <= Math.max(s[HIGH] || 0, msg.n) - WINDOW) recent.delete(x);
    if (msg.n > (s[HIGH] || 0)) s[HIGH] = msg.n;
    s.seen = Date.now();
    if (ip.startsWith('relay:')) s.away = s.seen; // came through the relay: from away from home
    write(); // the counter, so a restart can't take an old request again

    // The reply: sealed frames. Frame 0 is the head, then the body as it comes, then an empty end frame.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    let i = 0;
    const frame = (type, data) => {
      if (res.destroyed || res.writableEnded) return;
      const box = seal(key, `res:${id}:${msg.n}:${i++}`, Buffer.concat([Buffer.from([type]), Buffer.from(data)]));
      const len = Buffer.alloc(4); len.writeUInt32BE(box.length);
      res.write(Buffer.concat([len, box]));
    };
    if (typeof msg.p === 'string') msg.p = homePath(msg.p); // /door/... is /home/... (home-screen.js)
    let url;
    try { url = new URL(msg.p, 'http://x'); } catch { url = null; }
    // From a screen app (msg.a): read only, and the app has to be one this screen shows.
    const fromApp = msg.a === undefined ? null : String(msg.a);
    // (On a phone an app may change things too, when the phone may ('arrange'); what it may reach is the app's own
    // rights, checked by dispatch as on the tablet, not the phone's routes.)
    const sc = s.scopes || [];
    const appOk = fromApp === null || (APP_ID.test(fromApp) && appsFor(s).some((a) => a.id === fromApp) && !share
      && (msg.m === 'GET' ? sc.includes('door') : s.kind === 'phone' && sc.includes('arrange')));
    if (!url || !appOk || (share ? !(msg.m === 'POST' && url.pathname === '/phone/share' && sc.includes('ask')) : fromApp === null && !allowed(sc, msg.m, url.pathname))) {
      frame(0, JSON.stringify({ status: 403, type: 'application/json' })); frame(1, '{"error":"not for screens"}'); frame(2, ''); return res.end();
    }

    // The request, as the display's own: a body that's already read, and a 'close' when the screen goes away.
    const inner = new Readable({ read() {}, autoDestroy: false, emitClose: false });
    Object.assign(inner, { method: msg.m, url: msg.p, headers: { host: '127.0.0.1', 'content-type': 'application/json', 'x-openhouse-screen': id, ...(fromApp ? { 'x-openhouse-screen-app': fromApp } : {}), ...(share ? { 'x-openhouse-share-at': String(Math.floor(msg.n / 1000)) } : {}) } });
    if (msg.m === 'POST') inner.push(Buffer.from(JSON.stringify(msg.b ?? {})));
    inner.push(null);
    let head = false;
    const out = new Writable({
      write(chunk, enc, cb) { if (!head) sendHead(); if (chunk.length) frame(1, chunk); cb(); },
      final(cb) { if (!head) sendHead(); frame(2, ''); if (!res.destroyed) res.end(); cb(); },
    });
    out.statusCode = 200; out.headers = {};
    out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
    out.getHeader = (k) => out.headers[k.toLowerCase()];
    out.writeHead = (code, h) => { out.statusCode = code; for (const [k, v] of Object.entries(h || {})) out.setHeader(k, v); return out; };
    Object.defineProperty(out, 'headersSent', { get: () => head });
    const sendHead = () => { head = true; frame(0, JSON.stringify({ status: out.statusCode, type: out.headers['content-type'] || 'application/octet-stream' })); };

    const entry = { end: () => { out.destroy(); inner.emit('close'); res.destroy(); } };
    const set = live.get(id) || new Set(); set.add(entry); live.set(id, set);
    res.on('close', () => { set.delete(entry); if (!out.writableFinished) out.destroy(); inner.emit('close'); });
    try {
      await dispatch(inner, out, url); // it always answers (a 404 at worst)
    } catch (e) {
      if (!head) { out.writeHead(500, { 'content-type': 'application/json' }); out.end(JSON.stringify({ error: e.message })); } else res.destroy();
    }
  }

  // ---- phones: notes for their person, by Web Push from the tablet itself (web-push.js) ----
  const PUSH_FILE = registered('push', path.join(path.dirname(FILE), 'push.json'));
  let vapid = null;
  const vapidKeys = () => (vapid ||= push.keys(PUSH_FILE));
  /** GET/POST /phone/push, from a paired phone (its id comes with the opened request): the key, or its push address.
   *  The iPhone app posts {apns: {token, env}} instead (its APNs device token; null to stop), and gets notes by APNs. */
  handle.phone = async (req, res, url) => {
    if (url.pathname !== '/phone/push' && url.pathname !== '/phone/messages') return false;
    const s = state.screens.find((x) => x.id === req.headers['x-openhouse-screen']);
    if (!s || !(s.scopes || []).includes('notify')) { json(res, 403, { error: 'only a paired phone' }); return true; }
    if (url.pathname === '/phone/messages') { json(res, 200, { messages: messagesFor(s.person) }); return true; }
    if (req.method === 'GET') { json(res, 200, { key: vapidKeys().publicKey, on: !!(s.push || s.apns) }); return true; }
    const b = await body(req);
    if (b.apns === null) { delete s.apns; write(); json(res, 200, { ok: true, on: !!s.push }); return true; }
    if (b.apns !== undefined) {
      const t = String(b.apns?.token || ''), env = b.apns?.env === 'sandbox' ? 'sandbox' : b.apns?.env === 'production' ? 'production' : null;
      if (!/^[0-9a-f]{64,200}$/.test(t) || !env) { json(res, 400, { error: 'not an APNs device token' }); return true; }
      s.apns = { token: t, env }; write();
      json(res, 200, { ok: true, on: !!apns }); return true;
    }
    if (b.subscription === null) { delete s.push; write(); json(res, 200, { ok: true, on: false }); return true; }
    const sub = b.subscription, k = sub?.keys || {};
    if (!push.okEndpoint(sub?.endpoint) || typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 120 || k.auth.length > 40) { json(res, 400, { error: 'not a push subscription' }); return true; }
    s.push = { endpoint: String(sub.endpoint).slice(0, 1000), keys: { p256dh: k.p256dh, auth: k.auth } }; write();
    json(res, 200, { ok: true, on: true });
    return true;
  };
  /** A note for someone reaches their phones (each that allowed notifications). Quiet when nobody has one. */
  handle.notify = async (person, msg, { send = push.send } = {}) => {
    const who = String(person || '').toLowerCase();
    const to = state.screens.filter((s) => (s.push || s.apns) && String(s.person || '').toLowerCase() === who);
    const note = { title: String(msg.title || '').slice(0, 80), body: String(msg.body || '').slice(0, 240), tag: msg.tag || undefined, ...(msg.open ? { open: msg.open } : {}) };
    let sent = 0;
    for (const s of to) {
      try {
        if (s.apns && apns) {
          // The iPhone app: through the cloud to APNs, sealed for the phone; the cloud and Apple see only that a note went.
          const box = seal(noteKey(s.key), `note:${s.id}`, Buffer.from(JSON.stringify(note)));
          const tag = note.tag && crypto.createHash('sha256').update(`${s.id}:${note.tag}`).digest('base64url').slice(0, 32);
          const r = await apns({ token: s.apns.token, env: s.apns.env, box: box.toString('base64url'), ...(tag ? { tag } : {}) });
          if (r?.ok) sent++;
          else if (r?.gone) { delete s.apns; write(); }
        }
        if (s.push) {
          const r = await send(s.push, note, { keys: vapidKeys() });
          if (r.ok) sent++;
          else if (r.gone) { delete s.push; write(); }
        }
      } catch (e) { console.log('[screens] push:', e.message); }
    }
    return sent;
  };

  /** Who of the family can be reached on a phone: {person: {phones, on}} (on: phones that allowed notifications). */
  handle.phones = () => {
    const out = {};
    for (const s of state.screens) if (s.kind === 'phone' && s.person) { const o = (out[s.person] ||= { phones: 0, on: 0 }); o.phones++; if (s.push || s.apns) o.on++; }
    return out;
  };
  // What Opie was asked to tell someone ("tell Alex dinner's ready"): pushed to their phones, and kept here for a day
  // (in memory only) so their phone page shows it too. One message to several people is one entry.
  let messages = [];
  const messagesFor = (person) => {
    const who = String(person || '').toLowerCase(), t = Date.now();
    messages = messages.filter((m) => t - m.at < 24 * 3600e3);
    return who ? messages.filter((m) => m.to.some((p) => p.toLowerCase() === who)).slice(-5).map(({ id, title, text, at, open }) => ({ id, title, text, at, ...(open ? { open } : {}) })) : [];
  };
  /** A message for some of the family: each one's phones get it; answers how many phones each one's reached on. */
  // open: what tapping it opens on the phone ('opie:<conversation id>': that conversation, to answer Opie).
  handle.message = async (people, { title, text, open }, opts) => {
    const m = { id: 'm-' + crypto.randomBytes(4).toString('hex'), to: people.map(String), title: String(title || '').slice(0, 80), text: String(text || '').slice(0, 240), at: Date.now(), ...(/^opie:[\w-]{1,40}$/.test(String(open || '')) ? { open: String(open) } : {}) };
    messages = [...messages, m].slice(-50);
    const sent = {};
    for (const p of m.to) sent[p] = await handle.notify(p, { title: m.title, body: m.text, tag: m.id, ...(m.open ? { open: m.open } : {}) }, opts);
    return sent;
  };

  /** Every paired device's relay token (relay.js lists their hashes with the relay). */
  /** A phone's share key (shareKey above), by its id; null for anything else. */
  handle.shareKeyOf = (id) => { const s = state.screens.find((x) => x.id === id && x.kind === 'phone'); return s ? shareKey(s.key) : null; };
  handle.relayTokens = () => state.screens.map((s) => ({ id: s.id, token: relayToken(s.key) }));
  /**
   * A sealed request that came through the relay: handled exactly as one from the home network. sink gets the
   * status, then the sealed reply's bytes as they come, then end(); sink.closed(fn) is how a cancel reaches it.
   */
  handle.relayed = (id, box, sink) => {
    const req = new Readable({ read() {} });
    req.headers = { 'x-screen': id };
    req.push(box); req.push(null);
    const res = new Writable({ write(c, e, cb) { if (!res.headersSent) res.writeHead(200); sink.data(c); cb(); } });
    let sent = false;
    Object.defineProperty(res, 'headersSent', { get: () => sent });
    res.writeHead = (code) => { if (!sent) { sent = true; sink.status(code); } return res; };
    const end = res.end.bind(res);
    res.end = (chunk) => { if (!sent) res.writeHead(200); if (chunk) sink.data(Buffer.from(chunk)); end(); sink.end(); return res; };
    res.on('error', () => {}); res.on('close', () => { if (!res.writableFinished) sink.end(); });
    sink.closed?.(() => res.destroy());
    return sealed(req, res, `relay:${id}`).catch(() => { if (!res.destroyed) res.destroy(); });
  };
  /** A pairing someone may finish through the relay: a computer's (its code showing, or asked and waiting for its
   *  answer to be collected: the web connector for claude.ai and ChatGPT, openhouse-cloud/lambda/connector.ts), or an
   *  invite for someone in the family (its link opens the cloud's phone page, from anywhere, within its week). */
  const relayable = (pair, x) => x.kind === 'computer' || (x.kind === 'phone' && x.pre && state.invites.some((v) => v.pair === pair));
  /** The pairings the relay may let someone reach (relay.js tells the relay). */
  handle.computerPairs = () => { sweep(); return [...pairs].filter(([pair, x]) => relayable(pair, x) || (x.kind === 'phone' && x.answer && x.relayed)).map(([pair]) => pair); };
  /** A pairing step through the relay: 'hello' (body {pair, box}), or 'wait', which answers at once ({waiting: true}
   *  until someone answers on the tablet, then the sealed welcome, once). An invite is answered at its hello. */
  handle.pairRelayed = (pair, step, body) => {
    sweep();
    const x = pairs.get(pair);
    if (!x || !(relayable(pair, x) || x.relayed)) return { status: 404, json: { error: 'ended' } };
    if (step === 'hello') {
      let b = {}; try { b = JSON.parse(body.toString()); } catch {}
      if (x.kind === 'phone') x.relayed = true; // (its welcome is collected through the relay too, after the invite is used)
      return hello({ ...b, pair }, `relay:${pair}`, { relayable: (y) => y === x });
    }
    if (!x.asked) return { status: 404, json: { error: 'ended' } };
    if (x.answer) { pairs.delete(pair); changed(); return { status: 200, json: { box: b64(x.answer) } }; }
    return { status: 200, json: { waiting: true } };
  };
  handle.stop = () => { closeConnect(); stopLan(); };
  /** A hub's first settings device (docs/hub.md): a code to type at /hub/, printed where only someone with the hub's console
   *  sees it. Typing it joins with no Allow (there's no screen on the hub to say it), as an admin. One at a time. */
  handle.ownerCode = (minutes = 24 * 60) => {
    for (const [id, x] of pairs) if (x.owner) pairs.delete(id);
    let code, pair, key;
    do { code = newCode(); ({ pair, key } = pairingFromCode(code)); } while (pairs.has(pair));
    pairs.set(pair, { key, kind: 'screen', admin: true, owner: true, pre: true, until: Date.now() + minutes * 60e3, name: null, asked: false, answer: null, waiters: new Set(), misses: 0 });
    if (!state.lan) { state.lan = true; write(); }
    startLan();
    return { code, port: PORT, https: !!TLS };
  };
  /** Does the hub have a settings device yet? */
  handle.hasAdmin = () => state.screens.some((s) => (s.scopes || []).includes('admin'));
  /** An invite for someone in the family (from the setup phone, POST /setup/invite): a link that joins their phone
   *  as theirs when they open it, within a week. {pair, key}: the phone page makes the link (its own address). */
  handle.invite = (person, grownup) => {
    person = String(person || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    if (!person) return { error: 'whose?' };
    const pair = b64(crypto.randomBytes(6)), key = crypto.randomBytes(32), until = Date.now() + 7 * 86400e3;
    pairs.set(pair, { key, kind: 'phone', person, grownup: !!grownup, pre: true, until, name: null, asked: false, answer: null, waiters: new Set(), misses: 0 });
    state.invites.push({ pair, key: b64(key), person, grownup: !!grownup, until });
    if (!state.lan) state.lan = true;
    write(); startLan();
    return { pair, key: b64(key), port: PORT };
  };
  /** A paired device's name and kind, by its id (the x-openhouse-screen header a sealed request carries), else null. */
  /** GET /screens/apps, from a paired screen: the apps it shows, with its token for their files (a TV), or each one's
   *  version, name and icon (a phone: GET /screens/app-files has the files). */
  handle.apps = async (req, res, url) => {
    if (!/^\/screens\/(apps|app-files)$/.test(url.pathname) || req.method !== 'GET') return false;
    const s = state.screens.find((x) => x.id === req.headers['x-openhouse-screen']);
    if (!s) { json(res, 403, { error: 'only a paired screen' }); return true; }
    if (url.pathname === '/screens/app-files') {
      const id = String(url.searchParams.get('app') || '');
      if (s.kind !== 'phone' || !APP_ID.test(id) || !appsFor(s).some((a) => a.id === id) || usesPackages(appFileList(APP_DIR, id, KIT))) { json(res, 404, { error: 'not on this phone' }); return true; }
      json(res, 200, appFiles(APP_DIR, id, KIT));
      return true;
    }
    if (s.kind === 'phone') {
      const out = [];
      for (const a of appsFor(s)) { const files = appFileList(APP_DIR, a.id, KIT); if (!usesPackages(files)) out.push({ id: a.id, name: a.name, icon: a.icon || null, tabIcon: a.tabIcon || null, shared: !!a.shared, reaches: a.reaches || [], v: appVersion(files) }); }
      json(res, 200, out); return true;
    }
    // v: when its files last changed, so a TV showing it loads it again after an edit.
    const v = (id) => { let t = 0; const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (depth < 3) walk(f, depth + 1); } else t = Math.max(t, fs.statSync(f).mtimeMs); } };
      try { walk(path.join(APP_DIR, 'apps', id), 0); } catch {} return Math.round(t); };
    json(res, 200, appsFor(s).map((a) => ({ id: a.id, name: a.name, at: `/screen-app/${a.id}/${appToken(s, a.id)}/`, v: v(a.id) })));
    return true;
  };
  handle.who = (id) => { const s = state.screens.find((x) => x.id === id); return s ? { id: s.id, name: s.name, kind: s.kind || 'screen', scopes: [...(s.scopes || [])], ...(s.person ? { person: s.person } : {}) } : null; };
  return handle;
}
