// The tablet's side of the cloud service (cloud/ in the repo): linking to a family account and the device
// credential, plus the cloud as a backup destination (backup.js) and, only if the family asks, a copy of their
// recovery code kept with OpenHouse. Everything here is off until someone links the tablet (Settings → Account).
//
//   GET  /cloud/status[?check=1]     linked?, the family, a link code being shown (check: ask the service first)
//   POST /cloud/config {api}         the service's address (a self-hosted one, or the emulator's local server)
//   POST /cloud/link/start {name}    a code to show; the bridge waits for someone to enter it on the web
//   POST /cloud/link/cancel          POST /cloud/unlink
//   GET  /cloud/health-bits          the bridge's part of the shell's check-in (agent, model, last error type)
//   POST /cloud/link/token {token, api?, name}  link with a setup token (the setup QR carried it; no code to type)
//   POST /cloud/report {shellLog, note, version}  Send a report (Settings → Advanced, after a yes there): the shell's
//                                    log, the tails of the runtime's logs and the waiting app fixes, gzipped, to the service
//   (mail.js uses mailApi/mailFetch: the household's address and its waiting mail, docs/tablet-email.md)
//   POST /cloud/google/refresh {refresh_token}  the shell only: a two-way Google calendar's access token (calendar-sync.js)
// Voice (openhouse-cloud/docs/cloud-beta.md): OpenAI's live voice through OpenHouse cloud, off until someone turns it on (Parent
// menu → Better voice). Without it the tablet works by touch and typing; there's no on-device fallback voice.
//   GET  /cloud/voice[?check=1]      on?, the vendor, this month's use and allowance (check: ask the service)
//   POST /cloud/voice {on}           turn it on or off here and for the family
//   POST /cloud/voice/name {voice}   which of OpenAI's voices it speaks with (Settings → Voice, no PIN; from the next session)
//   POST /cloud/live/start {sdp, name, instructions, tools} -> {sessionId, sdp}   POST /cloud/live/usage {sessionId, seconds, backend}
//
// The credential lives in display/.cloud/device.json (0600), never in a backup.
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import path from 'node:path';
import zlib from 'node:zlib';
import { request } from './backup-format.js';

// The service a tablet links to unless someone sets another (Settings → Account → Address). Filled in after the
// first deploy (openhouse-cloud/scripts/deploy.sh prints it); empty means Settings asks for an address.
export const DEFAULT_API = 'https://cloud.openhouse.computer';
const DAY = 86400e3;

export function cloudRoutes({ DISPLAY, json, body, agentName = () => 'off', backupBits = () => ({}), fixesFile = null, now = Date.now, tick = 15 * 60e3, defaultApi = process.env.OPENHOUSE_CLOUD_URL || DEFAULT_API }) {
  const DIR = path.join(DISPLAY, '.cloud');
  const f = (n) => path.join(DIR, n);
  const read = (n) => readJson(f(n), null, { bak: false }); // (keys: no .bak copies lying around)
  const write = (n, v) => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeJson(f(n), v, { bak: false, mode: 0o600, space: 2 }); };
  const state = () => read('state.json') || {};
  const setState = (p) => write('state.json', { ...state(), ...p });
  const api = () => read('config.json')?.api || defaultApi;
  const device = () => read('device.json');
  const iso = () => new Date(now()).toISOString();
  let linking = null;

  async function call(method, p, b) {
    const d = device();
    if (!d) throw Object.assign(new Error('This tablet is not linked to a family account.'), { code: 'unlinked' });
    const r = await request(d.api + p, { method, headers: { authorization: `Device ${d.credential}` }, body: b === undefined ? null : JSON.stringify(b) });
    if (r.status === 401) {
      // Unlinked from the web (or the service forgot this tablet): stop using the credential. The key stays.
      fs.rmSync(f('device.json'), { force: true });
      setState({ unlinkedAt: iso(), unlinkedWhy: r.json?.error || 'unknown' });
      throw Object.assign(new Error('This tablet was unlinked from the family account.'), { code: 'unlinked' });
    }
    if (r.status >= 300) throw Object.assign(new Error(r.json?.error || `the service answered ${r.status}`), { code: `http${r.status}` });
    return r.json;
  }

  /** Send a report: what someone at the tablet agreed to send (the shell asked): the shell's own log, the last part of
   *  each of the runtime's logs (start, bridge, vite…), and the app fixes waiting. Never the chats or the household's
   *  files themselves, though the logs can mention what was said. Under the service's size limit once gzipped. */
  async function sendReport(b) {
    const tail = (file, n) => { try { const st = fs.statSync(file), fd = fs.openSync(file, 'r'); const len = Math.min(st.size, n), buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); return buf.toString('utf8'); } catch { return null; } };
    const parts = [`OpenHouse report ${iso()}  version ${String(b.version || '?').slice(0, 40)}`, `note: ${String(b.note || '').slice(0, 500)}`,
      `status: ${JSON.stringify(status())}`, '', '== shell (logcat) ==', String(b.shellLog || '').slice(-600_000)];
    let logs = []; try { logs = fs.readdirSync(DISPLAY).filter((n) => /\.log(\.1)?$/.test(n)).sort(); } catch {}
    for (const n of logs) { const t = tail(path.join(DISPLAY, n), 200_000); if (t != null) parts.push('', `== ${n} ==`, t); }
    if (fixesFile) { const t = tail(fixesFile, 100_000); if (t) parts.push('', '== heartbeat-fixes.json ==', t); }
    let text = parts.join('\n'), gz = zlib.gzipSync(text);
    while (gz.length > 340_000 && text.length > 10_000) { text = text.slice(0, 20_000) + '\n…(cut)…\n' + text.slice(-Math.floor(text.length / 2)); gz = zlib.gzipSync(text); }
    const r = await call('POST', '/v1/report', { gz: gz.toString('base64'), note: String(b.note || '').slice(0, 500), version: String(b.version || '').slice(0, 40) });
    return { ok: true, id: r.id };
  }

  // --- linking -------------------------------------------------------------------------------------------------
  /** A setup token from the family's account page (in the setup QR, or from the computer's extension). */
  async function linkToken(token, apiAddr, name) {
    const base = (apiAddr || api()).replace(/\/+$/, '');
    if (!okApi(base)) throw new Error('https only');
    if (!/^lhs_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('That isn\'t a setup code.');
    const r = await request(base + '/v1/link/redeem', { method: 'POST', body: JSON.stringify({ token, name }) });
    if (r.status !== 200 || r.json?.status !== 'linked') throw Object.assign(new Error(r.json?.error || `the service answered ${r.status}`), { code: `http${r.status}` });
    if (base !== defaultApi) write('config.json', { api: base });
    write('device.json', { api: base, deviceId: r.json.deviceId, credential: r.json.credential, family: r.json.family?.name || '', name: r.json.name, linkedAt: iso(), rotatedAt: iso(), via: 'setup' });
    setState({ unlinkedAt: null, unlinkedWhy: null });
    return status();
  }

  async function linkStart(name) {
    const base = api();
    if (!base) throw new Error('No cloud address is set.');
    const r = await request(base + '/v1/link/start', { method: 'POST', body: JSON.stringify({ name }) });
    if (r.status !== 200) throw new Error(r.json?.error || `the service answered ${r.status}`);
    const l = { api: base, display: r.json.display, url: r.json.url, poll: r.json.pollToken, until: now() + r.json.expiresIn * 1000 };
    linking = l;
    (async () => {
      while (linking === l && now() < l.until) {
        await new Promise((ok) => setTimeout(ok, 3000));
        if (linking !== l) return;
        try {
          const p = await request(l.api + '/v1/link/poll', { method: 'POST', body: JSON.stringify({ pollToken: l.poll }) });
          if (p.status === 404) break;
          if (p.json?.status === 'linked') {
            write('device.json', { api: l.api, deviceId: p.json.deviceId, credential: p.json.credential, family: p.json.family?.name || '', name: p.json.name, linkedAt: iso(), rotatedAt: iso() });
            setState({ unlinkedAt: null, unlinkedWhy: null });
            linking = null;
            return;
          }
        } catch {}
      }
      if (linking === l) linking = null;
    })();
    return { display: l.display, url: l.url, expiresAt: new Date(l.until).toISOString() };
  }

  /** The family's name as the service has it now; a 401 here (unlinked from the web) drops the link (call). */
  async function refresh() {
    const r = await call('GET', '/v1/device');
    const d = device();
    if (d && r.family?.name !== undefined && r.family.name !== d.family) write('device.json', { ...d, family: r.family.name });
    setState({ checkedAt: iso(), iphoneApp: /^https:\/\//.test(r.iphoneApp || '') ? r.iphoneApp : null }); // (Settings' iPhone app row)
  }
  async function rotateIfDue() {
    const d = device();
    if (!d || now() - Date.parse(d.rotatedAt || d.linkedAt) < 30 * DAY) return;
    const r = await call('POST', '/v1/device/rotate');
    write('device.json', { ...d, credential: r.credential, rotatedAt: iso() });
    await call('GET', '/v1/device'); // the new one in use: the old one stops working
  }
  async function upkeep() {
    if (!device()) return;
    await rotateIfDue().catch(() => {});
    const s = state();
    if (!s.checkedAt || now() - Date.parse(s.checkedAt) > 6 * 3600e3) await refresh().catch(() => {});
  }
  const timer = tick ? setInterval(() => upkeep().catch(() => {}), tick) : null;
  timer?.unref?.();

  // --- the cloud as a backup destination ------------------------------------------------------------------------
  const destination = {
    id: 'cloud', label: 'The cloud',
    async ready() { const d = device(); return d ? { ok: true, name: d.family } : { ok: false, why: 'Link the tablet to an account first (Settings → Account).' }; },
    async put(file, meta) {
      const s = await call('POST', '/v1/backups/start', { size: meta.size, kind: meta.kind, keyId: meta.keyId });
      const up = await request(s.upload.url, { method: 'PUT', headers: s.upload.headers, file, timeout: 120e3 });
      if (up.status !== 200) throw Object.assign(new Error(`the upload was refused (${up.status})`), { code: 'upload' });
      await call('POST', '/v1/backups/finish', { backupId: s.backupId }); // the service keeps the newest few itself
    },
    async list() { return (await call('GET', '/v1/backups')).backups; }, // the whole family's, so a new tablet can restore an old one's
    async get(item, toFile) {
      const dl = await call('POST', '/v1/backups/download', { backupId: item.id, deviceId: item.deviceId });
      const r = await request(dl.url, { saveTo: toFile, timeout: 120e3 });
      if (r.status !== 200) throw new Error(`the download failed (${r.status})`);
    },
  };

  // A copy of the family's recovery code kept with OpenHouse: only when they turn it on (backup.js asks first), and the
  // Settings says plainly that with it on, OpenHouse could open their backups.
  const escrow = {
    available: () => !!device(),
    put: (keyId, code) => call('POST', '/v1/escrow', { keyId, code }),
    remove: (keyId) => call('POST', '/v1/escrow/remove', { keyId }),
    get: async (keyId) => (await call('GET', `/v1/escrow?keyId=${encodeURIComponent(keyId)}`)).code || null,
  };

  // --- voice ---------------------------------------------------------------------------------------------------
  // The family's choice is kept here (voice.json) and with the service, which refuses a live session for a family
  // that hasn't turned it on; turned off on the account page, it's off here at the next check.
  let lastVoiceStatus = null;
  const liveOn = () => !!device() && !!read('voice.json')?.on && read('voice.json')?.provider === 'openai-live'; // (an older "on" was for Deepgram, which is gone)
  const voice = { used: () => (liveOn() ? 'live' : 'off') };
  async function voiceStatus(check) {
    const mine = read('voice.json') || {};
    let svc = lastVoiceStatus;
    if (check && device()) { try { svc = lastVoiceStatus = await call('GET', '/v1/voice'); } catch {} }
    if (svc && svc.on === false && mine.on) { write('voice.json', { ...mine, on: false, offAt: iso(), offWhy: 'family' }); mine.on = false; } // turned off from the web
    const over = svc?.used && svc?.limits && svc.used.cents >= svc.limits.cents ? 'month' : null;
    return { linked: !!device(), on: liveOn(), provider: 'openai-live', vendor: svc?.vendor || mine.vendor || null, available: svc ? !!svc.available : null,
      over, used: svc?.used || null, limits: svc?.limits || null, using: voice.used(), voiceName: mine.voiceName || 'marin' };
  }
  async function voiceSet(on) {
    if (on && !device()) throw new Error('Link the tablet to an account first (Settings → Account).');
    if (device()) { try { lastVoiceStatus = await call('POST', '/v1/voice/setting', { on }); } catch (e) { if (on) throw e; } }
    write('voice.json', { ...(read('voice.json') || {}), on, provider: 'openai-live', vendor: lastVoiceStatus?.vendor || null, at: iso() }); // (keeps the chosen voice)
    return voiceStatus(false);
  }

  function status() {
    const d = device(), s = state();
    return {
      api: api(), linked: !!d, family: d?.family || null, name: d?.name || null, linkedAt: d?.linkedAt || null,
      unlinked: !d && s.unlinkedAt ? { at: s.unlinkedAt, why: s.unlinkedWhy } : null,
      linking: linking ? { display: linking.display, url: linking.url, expiresAt: new Date(linking.until).toISOString() } : null,
      iphoneApp: d ? s.iphoneApp || null : null,
    };
  }

  const reply = async (res, fn) => {
    try { json(res, 200, await fn()); } catch (e) { json(res, e.code === 'unlinked' ? 409 : 400, { error: e.message, code: e.code || null }); }
  };

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/cloud/')) return false;
    if (req.method === 'GET' && p === '/cloud/status') {
      // ?check=1 (Settings opening): ask the service first, so an unlink from the web or a new family name shows.
      if (url.searchParams.get('check') && device()) await refresh().catch(() => {});
      json(res, 200, status()); return true;
    }
    if (req.method === 'GET' && p === '/cloud/health-bits') {
      let agent = agentName(); if (!/^[a-z0-9-]{1,20}$/.test(agent)) agent = null;
      const b = backupBits();
      const err = lastError && lastError.at > (b.lastErrorAt || 0) ? lastError.type : b.lastErrorType || null;
      json(res, 200, { agent, model: agent === 'cloud' ? 'gpt-6-luna' : null, lastErrorType: err, backups: b.on ? 'on' : 'off', voice: voice.used() });
      return true;
    }
    if (req.method === 'GET' && p === '/cloud/voice') { json(res, 200, await voiceStatus(!!url.searchParams.get('check'))); return true; }
    if (req.method !== 'POST') { json(res, 404, { error: 'not found' }); return true; }
    const b = await body(req);
    switch (p) {
      // The shell, for a two-way Google calendar (CalendarAccounts.kt): a fresh access token for its sealed refresh
      // token. The cloud adds OpenHouse's client secret and keeps nothing; neither token is kept or logged here.
      case '/cloud/google/refresh': {
        const t = String(b.refresh_token || '');
        if (!t || t.length > 2048) { json(res, 400, { error: 'refresh_token' }); return true; }
        try { const r = await call('POST', '/v1/google/refresh', { refresh_token: t }); json(res, 200, { access_token: r.access_token, expires_in: r.expires_in }); }
        catch (e) { json(res, e.code === 'unlinked' ? 409 : 400, { error: e.message === 'invalid_grant' ? 'invalid_grant' : e.code === 'unlinked' ? 'unlinked' : 'unavailable' }); }
        return true;
      }
      case '/cloud/config': {
        const a = String(b.api || '').replace(/\/+$/, '');
        if (a && !okApi(a)) { json(res, 400, { error: 'https only' }); return true; }
        write('config.json', { api: a });
        json(res, 200, { ok: true, api: api() }); return true;
      }
      case '/cloud/link/start': await reply(res, () => linkStart(String(b.name || 'Kitchen tablet').slice(0, 40))); return true;
      case '/cloud/link/cancel': linking = null; json(res, 200, { ok: true }); return true;
      case '/cloud/report': await reply(res, () => sendReport(b)); return true;
      case '/cloud/link/token': await reply(res, () => linkToken(String(b.token || ''), String(b.api || ''), String(b.name || 'Kitchen tablet').slice(0, 40))); return true;
      case '/cloud/voice': await reply(res, () => voiceSet(!!b.on)); return true;
      case '/cloud/voice/name': await reply(res, async () => { const v = String(b.voice || '').toLowerCase(); if (!/^[a-z]{2,20}$/.test(v)) throw new Error('voice'); write('voice.json', { ...(read('voice.json') || {}), voiceName: v }); return voiceStatus(false); }); return true;
      // OpenAI's live voice (the trial): the shell's WebRTC offer to the service, which starts the session with OpenAI
      // (the key stays there) and answers with OpenAI's SDP; and, when the session ends, what it cost (OpenAI's count).
      // (One line per start, its outcome only, for when a device says it couldn't connect: no words, no addresses.)
      case '/cloud/live/start': await reply(res, () => { if (!liveOn()) throw Object.assign(new Error('off'), { code: 'off' }); const s = req.liveSetup || b; return call('POST', '/v1/voice/live/start', { sdp: String(b.sdp || ''), name: String(b.name || ''), instructions: s.instructions || '', tools: Array.isArray(s.tools) ? s.tools : [], idleTimeoutS: Number(b.idleTimeoutS) || undefined, voice: read('voice.json')?.voiceName || undefined }).then((r) => { console.log(`[cloud] live start ok${req.headers['x-openhouse-screen'] ? ' (from a paired device)' : ''}`); return r; }, (e) => { console.log(`[cloud] live start failed: ${e.code || ''} ${String(e.message || '').slice(0, 80)}${req.headers['x-openhouse-screen'] ? ' (from a paired device)' : ''}`); throw e; }); }); return true;
      // An app's small question (the kit's decide(); apps.js lets only the family's own apps and those that declare
      // "decide" reach this): {input, questions} -> {answers}.
      case '/cloud/decide': await reply(res, () => decide(b.input, Array.isArray(b.questions) ? b.questions : [])); return true;
      case '/cloud/live/usage': {
        // backend: what the session's text model used (live-session.cjs), as numbers and its model's name, nothing said.
        const k = b.backend && typeof b.backend === 'object' ? b.backend : {};
        const backend = { model: String(k.model || '').slice(0, 60), ...Object.fromEntries(['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'ttl_12h_tokens', 'searches'].map((f) => [f, Math.max(0, Math.round(Number(k[f]) || 0))])) };
        await reply(res, () => call('POST', '/v1/voice/live/usage', { sessionId: String(b.sessionId || ''), seconds: Number(b.seconds) || 0, backend })); return true;
      }
      case '/cloud/unlink':
        await reply(res, async () => {
          try { await call('POST', '/v1/device/unlink'); } catch (e) { if (e.code !== 'unlinked') throw e; }
          fs.rmSync(f('device.json'), { force: true });
          fs.rmSync(f('voice.json'), { force: true }); // better voice needs the family account
          return { ok: true };
        });
        return true;
    }
    json(res, 404, { error: 'not found' }); return true; // the body is read: nothing after this may read it again
  }
  /** The cloud assistant's next step (agents/cloud.js): the model's output for the conversation so far. */
  const ai = (q) => call('POST', '/v1/ai/respond', q);
  /** OpenAI Decisions through the service: {answers}. Only once the family chose OpenAI (the service checks). */
  const decide = (input, questions) => call('POST', '/v1/decide', { input: String(input || ''), questions });
  /** The tablet's assistant (typed turns, flyers, the heartbeat's notes) is the cloud's text model: linked, OpenAI chosen (server.js agentName). */
  const brainOn = () => liveOn();
  /** The relay (relay.js): where to dial out to, and the credential it says hello with. */
  const relayAddress = () => call('GET', '/v1/relay');
  /** A box a device left in the cloud's storage for this tablet (relay.js, k 'b': a photo, too big to go in relay
   *  parts): its sealed bytes, from the short-lived address our own service gives this tablet; then it's removed. */
  async function relayBox(key) {
    const { url } = await call('GET', `/v1/relay/box?key=${encodeURIComponent(key)}`);
    const u = new URL(String(url || ''));
    if (u.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) throw new Error('not an https address');
    const r = await fetch(u, { signal: AbortSignal.timeout(20e3) });
    if (!r.ok) throw new Error(`the box answered ${r.status}`);
    const box = Buffer.from(await r.arrayBuffer());
    if (box.length > 8e6) throw new Error('too big');
    call('POST', '/v1/relay/box/done', { key }).catch(() => {});
    return box;
  }
  /** A big reply for one of this tablet's devices (relay.js, a request that said bx): left, already sealed for that
   *  device, in the cloud's storage; the relay carries only its key. */
  async function leaveBox(bytes) {
    const d = device();
    if (!d) throw new Error('not linked');
    const r = await fetch(d.api + '/v1/relay/box/out', { method: 'POST', headers: { authorization: `Device ${d.credential}`, 'content-type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(30e3) });
    if (!r.ok) throw new Error(`the service answered ${r.status}`);
    const { key } = await r.json();
    if (!/^box\/[A-Za-z0-9_-]{22}\/o[A-Za-z0-9_-]{31}$/.test(String(key))) throw new Error('not a box');
    return key;
  }
  /** Email to the tablet (mail.js): the service's mail endpoints, and one waiting message's sealed bytes (from the
   *  short-lived address our own service gives this tablet). */
  const mailApi = (method, p, b) => call(method, p, b);
  async function mailFetch(key) {
    const { url } = await call('GET', `/v1/mail?key=${encodeURIComponent(key)}`);
    const u = new URL(String(url || ''));
    if (u.protocol !== 'https:' && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) throw new Error('not an https address');
    const r = await fetch(u, { signal: AbortSignal.timeout(60e3) });
    if (!r.ok) throw new Error(`the mail answered ${r.status}`);
    const sealed = Buffer.from(await r.arrayBuffer());
    if (sealed.length > 26e6) throw new Error('too big');
    return sealed;
  }
  const credential = () => device()?.credential || null;
  /** The service's own address (a phone page it serves, /l, works from anywhere). */
  const apiBase = () => device()?.api || null;
  /** A note for an iPhone (screens.js notify): sealed already; the service hands it to APNs. {ok} or {gone}. */
  const apns = async (b) => { try { return await call('POST', '/v1/push/apns', b); } catch (e) { if (e.code === 'http410') return { gone: true }; throw e; } };
  // Address suggestions for the Map (the cloud asks Amazon Location; a linked tablet only): [{id, text}], and a picked one's place.
  const placesSuggest = async (q, near) => (await call('GET', `/v1/places/suggest?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lon=${near.lon}` : ''}`)).suggestions || [];
  const placeOf = async (id) => (await call('GET', `/v1/places/place?id=${encodeURIComponent(id)}`)).place || null;
  return { placesSuggest, placeOf, handle, status, destination, escrow, voice, ai, decide, apns, brainOn, liveOn, refresh, upkeep, relayAddress, relayBox, leaveBox, mailApi, mailFetch, credential, apiBase, stop: () => timer && clearInterval(timer) };
}

const okApi = (a) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(a) || /^http:\/\/(10\.0\.2\.2|127\.0\.0\.1|localhost)(:\d+)?$/.test(a);

// The last thing that went wrong in the bridge, as a type only (never its text): what a health check-in may carry.
let lastError = null;
/** Anything in the bridge can note a failure by type ("bridge.route", "chat.failed"). */
export function noteError(type) { lastError = { type: String(type).replace(/[^a-z0-9_.-]/g, '').slice(0, 40), at: Date.now() }; }
