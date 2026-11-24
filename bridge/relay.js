// Reaching the tablet from away from home (docs/networking.md): one WebSocket the bridge dials out to the cloud's
// relay (openhouse-cloud/lambda/relay.ts), so paired computers, screens and phone list pages reach the tablet when they aren't
// on the home Wi-Fi. Off until someone turns it on (Settings → Account → Use it away from home), and only
// while the tablet is linked to a family account. Nothing is opened on the way: what arrives is the same sealed
// request a device sends on the Wi-Fi, handed to the same code (screens.js for screens and computers, the shell's
// phone page for a list), and the sealed reply goes back.
//
// The display's own (loopback, its secret):
//   GET  /relay                     {on, linked, connected, since, error, connector}   connector: the web connector's
//                                   address for claude.ai and ChatGPT (docs/web-chat-building.md), while connected
//   POST /relay {on}                turn it on or off
//   POST /relay/handoff {base, minutes}   a phone list page (the shell's Handoff at base, http://<lan ip>:<port>) may be
//                                   reached through the relay for that long: {url, relay, token, page} (page: the
//                                   same page served by the service, for the QR code), or {off: true}
//                                   {base, minutes, token, page: 'p'}: the household's lasting photo page (PhotoShare.kt)
//                                   keeps its own token (sent again every few hours), and its page is the service's /p
//   POST /relay/handoff/end {token}   that page's token off the relay's list at once (a new link, or turned off)
// A paired device (screens.js lets screens and computers ask only this):
//   GET  /relay/me                  {url, relay, token}: where to go and its token, or {off: true}
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CHUNK = 16 * 1024; // bytes per message: under the relay's 32 KB once in base64 and JSON
export const okRelayUrl = (u) => /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(u) || /^ws:\/\/(10\.0\.2\.2|127\.0\.0\.1|localhost)(:\d+)?(\/[\w./-]*)?$/.test(u);
const okHandoff = (b) => /^http:\/\/(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))(\.\d{1,3}){1,3}:\d{2,5}$/.test(b);

export function relayRoutes({ DISPLAY, json, body, screens, cloud, onMail = () => {}, WS = globalThis.WebSocket, now = Date.now, backoff = [2e3, 5e3, 15e3, 60e3, 300e3], pingMs = 4 * 60e3, maxAgeMs = 110 * 60e3 }) {
  const FILE = path.join(DISPLAY, '.cloud', 'relay.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
  const save = (v) => { fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 }); fs.writeFileSync(FILE + '.new', JSON.stringify(v), { mode: 0o600 }); fs.renameSync(FILE + '.new', FILE); };

  let sock = null, url = null, relayId = null, connected = false, since = null, error = null;
  let tries = 0, retryTimer = null, pingTimer = null, ageTimer = null, sentTokens = '';
  let sentPairs = new Set(); // computer pairings the relay knows are showing (a web connector may pair with the code)
  const handoffs = new Map(); // token hash -> {base, until}
  const open = new Map(); // from:rid -> {parts, done, cancel: Set}

  const on = () => !!read().on;
  const want = () => on() && !!cloud.credential();
  const send = (m) => { if (sock && sock.readyState === 1) { sock.send(JSON.stringify(m)); return true; } return false; };
  // Replies go out paced: every message is its own run of the cloud's relay function, and a burst of them (a photo,
  // in 16 KB parts) can outrun how many may run at once, which drops the rest unseen. Four at once, then one each 80 ms (the account runs ten at a time in all).
  const paced = [], BURST = 4, GAP = 80; let tokensLeft = BURST, refill = null;
  function sendPaced(m) { paced.push(m); pump(); }
  function pump() {
    while (paced.length && tokensLeft > 0) { tokensLeft--; send(paced.shift()); }
    if (!refill && (paced.length || tokensLeft < BURST)) refill = setInterval(() => { tokensLeft = Math.min(BURST, tokensLeft + 1); pump(); if (!paced.length && tokensLeft >= BURST) { clearInterval(refill); refill = null; } }, GAP);
  }

  function tokens(force = false) {
    const t = now();
    for (const [h, x] of handoffs) if (x.until < t) handoffs.delete(h);
    const hashes = [...screens.relayTokens().map((x) => sha(x.token)), ...handoffs.keys()].sort();
    const s = JSON.stringify(hashes);
    if (!connected || (!force && s === sentTokens)) return;
    if (send({ t: 'tokens', hashes })) sentTokens = s;
  }
  function pairings() {
    if (!connected) return;
    const nowPairs = new Set(screens.computerPairs?.() || []);
    for (const p of nowPairs) if (!sentPairs.has(p)) send({ t: 'pairing', pair: p, on: true });
    for (const p of sentPairs) if (!nowPairs.has(p)) send({ t: 'pairing', pair: p, on: false });
    sentPairs = nowPairs;
  }

  function clearTimers() { clearInterval(pingTimer); clearTimeout(ageTimer); pingTimer = ageTimer = null; }
  function later(ms) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { retryTimer = null; start(); }, ms); retryTimer.unref?.(); }

  async function start() {
    if (sock || !want()) return;
    try {
      url = process.env.OPENHOUSE_RELAY_URL || (await cloud.relayAddress())?.url;
      if (!okRelayUrl(String(url || ''))) throw new Error('no relay at this service');
    } catch (e) { error = e.code === 'http404' ? 'no relay at this service' : e.message; return later(backoff[Math.min(tries++, backoff.length - 1)]); }
    if (sock || !want()) return;
    const s = new WS(url);
    sock = s;
    s.onopen = () => { if (sock === s) send({ t: 'hello', role: 'tablet', credential: cloud.credential() }); };
    s.onmessage = (e) => { if (sock === s) { try { onMessage(JSON.parse(String(e.data))); } catch (err) { console.error('[relay]', err.message); } } };
    s.onerror = () => {};
    s.onclose = () => {
      if (sock !== s) return;
      sock = null; connected = false; sentTokens = ''; sentPairs = new Set(); clearTimers();
      for (const x of open.values()) for (const c of x.cancel) c();
      open.clear();
      if (want()) later(backoff[Math.min(tries, backoff.length - 1)]);
      tries++;
    };
  }
  function stop() {
    clearTimeout(retryTimer); retryTimer = null; clearTimers();
    const s = sock; sock = null; connected = false; sentTokens = ''; sentPairs = new Set();
    try { s?.close(); } catch {}
  }

  function onMessage(m) {
    if (m.t === 'ok') {
      connected = true; since = now(); error = null; tries = 0; relayId = m.relay;
      tokens(true); pairings();
      pingTimer = setInterval(() => send({ t: 'ping' }), pingMs); pingTimer.unref?.();
      ageTimer = setTimeout(() => { try { sock?.close(); } catch {} }, maxAgeMs); ageTimer.unref?.(); // the relay's 2 hours: a fresh socket first
      return;
    }
    if (m.t === 'no') { error = m.why === 'unlinked' ? 'the family account doesn\'t know this tablet' : String(m.why || 'refused'); tries = Math.max(tries, backoff.length - 1); return; }
    if (m.t === 'mail') return onMail(); // mail waiting in the cloud for this tablet (mail.js fetches it)
    if (m.t === 'req') return request(m);
    if (m.t === 'cancel' || m.t === 'gone') { const k = `${m.to || m.from}:${m.rid}`; const x = open.get(k); if (x) { open.delete(k); for (const c of x.cancel) c(); } }
  }

  // What may come in parts through the relay (each part is a run of the cloud's relay function, and they're limited).
  const RELAY_MAX = 64 * 1024;
  /** A box key of this tablet's own: box/<its relay id>/<random>. */
  const boxKey = (key) => !!relayId && /^[A-Za-z0-9_-]{22}$/.test(relayId) && new RegExp(`^box/${relayId}/[A-Za-z0-9_-]{32}$`).test(key);

  /** A device's request (in parts, if small; else in the cloud's storage): once whole, to the screen's or the phone page's own code. */
  function request(m) {
    if (m.k === 'p') { // a computer's pairing step, from someone with the code (the web connector)
      const r = screens.pairRelayed?.(String(m.pair || ''), m.p === 'wait' ? 'wait' : 'hello', Buffer.from(String(m.d || ''), 'base64url')) || { status: 404, json: {} };
      const sink = reply(m, r.status);
      sink.data(Buffer.from(JSON.stringify(r.json))); sink.end();
      return;
    }
    const k = `${m.from}:${m.rid}`;
    // Something big (a photo) isn't sent in parts: the device leaves it, sealed, in the cloud's storage, and the message
    // says only where (k 'b', its kind in m). The key has to be one of this tablet's own, and it's fetched through our
    // own cloud with this tablet's credential (cloud.relayBox): never from an address a message names.
    if (m.k === 'b') {
      if (open.has(k)) return;
      const key = Buffer.from(String(m.d || ''), 'base64url').toString();
      const x = { cancel: new Set() }; open.set(k, x);
      const sink = reply(m, null, () => open.delete(k));
      sink.closed = (fn) => x.cancel.add(fn);
      if (!['s', 'h'].includes(m.m) || !boxKey(key)) return sink.status(400).end();
      cloud.relayBox(key).then((box) => deliver({ ...m, k: m.m }, box, sink))
        .catch(() => sink.status(502).end());
      return;
    }
    let x = open.get(k);
    if (!x) {
      x = { parts: [], size: 0, cancel: new Set(), started: false, n: 0, last: null }; open.set(k, x);
      // A part that never comes (lost on the way through the relay): say so, rather than leave the device waiting.
      x.timer = setTimeout(() => { if (!x.started && open.get(k) === x) { open.delete(k); reply(m, 408).end(); } }, 10e3); x.timer.unref?.();
    }
    if (x.started) return;
    // The cloud's relay runs each message on its own, so the parts of a request can arrive out of order: each says
    // where it goes (i), and the request is whole once its last part and every one before it are in. (A device from
    // before this sends no i: its parts are taken as they come.)
    const at = Number.isInteger(m.i) && m.i >= 0 && m.i < 8 ? m.i : x.n;
    x.n++;
    if (m.d) { const b = Buffer.from(m.d, 'base64url'); x.size += b.length; x.parts[at] = b; } else x.parts[at] ||= Buffer.alloc(0);
    if (!m.more) x.last = at;
    const whole = x.last !== null && Array.from({ length: x.last + 1 }, (_, i) => x.parts[i]).every(Boolean);
    // In parts, only something small (64 KB): bigger goes by the cloud's storage (k 'b' above).
    if (x.size > RELAY_MAX) { clearTimeout(x.timer); open.delete(k); return reply(m, 413).end(); }
    if (!whole) return;
    x.started = true; clearTimeout(x.timer);
    const box = Buffer.concat(x.parts); x.parts = [];
    const sink = reply(m, null, () => open.delete(k));
    sink.closed = (fn) => x.cancel.add(fn);
    deliver(m, box, sink);
  }

  /** A whole request (from parts, or from a box): to the screen's own code, or the phone page's (a hand-off). */
  function deliver(m, box, sink) {
    if (m.k === 's') {
      const mine = screens.relayTokens().find((s) => s.id === m.id && sha(s.token) === m.th);
      if (!mine) return sink.status(401).end();
      return screens.relayed(m.id, box, sink);
    }
    if (m.k === 'h') {
      const h = handoffs.get(m.th);
      if (!h || h.until < now() || !['i', 's'].includes(m.p)) return sink.status(404).end();
      const r = http.request(`${h.base}/${m.p}`, { method: m.p === 's' ? 'POST' : 'GET', headers: m.p === 's' ? { 'content-type': 'application/octet-stream', 'content-length': box.length } : {}, timeout: 10e3 }, (res) => {
        sink.status(res.statusCode || 502);
        res.on('data', (d) => sink.data(d)); res.on('end', () => sink.end()); res.on('error', () => sink.end());
      });
      r.on('error', () => sink.status(502).end()); r.on('timeout', () => r.destroy());
      sink.closed(() => r.destroy());
      return r.end(m.p === 's' ? box : undefined);
    }
    sink.status(400).end();
  }

  /** The reply to one request: its status, its bytes in parts, its end (once). A big one (over 64 KB) for a device that
   *  said it takes boxes (bx: an app's files, a photo) goes in one box in the cloud's storage instead, sealed as it is:
   *  one relay message, not a run of the relay's function for every 16 KB. */
  function reply(m, status, done = () => {}) {
    let head = false, ended = false, n = 0;
    // i: each message's place in the reply, since the cloud's relay may deliver them out of order.
    const base = () => ({ t: 'res', to: m.from, rid: m.rid, i: n++ });
    const send = sendPaced;
    const parts = (code, bytes) => { send({ ...base(), s: code }); for (let i = 0; i < bytes.length; i += CHUNK) send({ ...base(), d: Buffer.from(bytes.subarray(i, i + CHUNK)).toString('base64url') }); send({ ...base(), e: 1 }); };
    if (m.bx === 1 && cloud.leaveBox) {
      let code = 200; const held = [];
      const sink = {
        status(c) { if (!head) { head = true; code = c; } return sink; },
        data(b) { if (!ended) held.push(Buffer.from(b)); },
        end() {
          if (ended) return; ended = true;
          const all = Buffer.concat(held);
          if (all.length <= RELAY_MAX) { parts(code, all); return done(); }
          cloud.leaveBox(all).then((key) => send({ ...base(), s: code, b: key, e: 1 }), () => parts(code, all)).finally(done);
        },
      };
      if (status) sink.status(status);
      return sink;
    }
    // As few messages as it can: the status, the bytes and the end go together while they fit in one (a small reply is
    // one message, not three); what comes in a burst waits a moment to go with the rest. Every message is a run of the
    // cloud's relay function and they go out paced, so each one saved is time saved for every reply behind it.
    let code = null, buf = [], size = 0, timer = null;
    const flush = (last) => {
      clearTimeout(timer); timer = null;
      let all = Buffer.concat(buf); buf = []; size = 0;
      do {
        const part = all.subarray(0, CHUNK); all = all.subarray(CHUNK);
        const msg = { ...base() };
        if (!head) { head = true; msg.s = code ?? 200; }
        if (part.length) msg.d = Buffer.from(part).toString('base64url');
        if (last && !all.length) msg.e = 1;
        if (msg.s !== undefined || msg.d || msg.e) send(msg);
      } while (all.length);
    };
    const sink = {
      status(c) { if (!head && code === null) code = c; return sink; },
      data(b) {
        if (ended) return;
        buf.push(Buffer.from(b)); size += b.length;
        if (size >= CHUNK) flush(false); else if (!timer) timer = setTimeout(() => flush(false), 20);
      },
      end() { if (ended) return; ended = true; flush(true); done(); },
    };
    if (status) sink.status(status);
    return sink;
  }

  /** Who is paired changed (screens.js): the relay's list follows at once. */
  const changed = () => { tokens(); pairings(); };
  // (The relay keeps a pairing for 10 minutes: one that lasts longer, an invite's week, is told again every 5.)
  let pairsAt = 0;
  const sweep = setInterval(() => {
    tokens();
    if (now() - pairsAt > 5 * 60e3) { pairsAt = now(); sentPairs = new Set(); }
    pairings();
    if (want() && !sock && !retryTimer) start(); if (!want() && sock) stop();
  }, 30e3); sweep.unref?.();
  if (want()) start();

  async function handle(req, res, url2) {
    const p = url2.pathname;
    if (p !== '/relay' && !p.startsWith('/relay/')) return false;
    const screen = req.headers['x-openhouse-screen'];
    if (req.method === 'GET' && p === '/relay/me') {
      const mine = screen && screens.relayTokens().find((s) => s.id === screen);
      if (!mine) { json(res, 404, { error: 'not a paired device' }); return true; }
      const api = cloud.apiBase?.(); // where a phone's installable page is (openhouse-cloud/lambda/app.ts, GET /h/)
      json(res, 200, on() && relayId && url ? { url, relay: relayId, token: mine.token, ...(api ? { page: `${api.replace(/\/+$/, '')}/h/` } : {}) } : { off: true });
      return true;
    }
    if (screen) { json(res, 403, { error: 'not for screens' }); return true; }
    if (req.method === 'GET' && p === '/relay') {
      // connector: the address claude.ai and ChatGPT add as a connector (the service's web connector,
      // openhouse-cloud/lambda/connector.ts), there while the relay is up: it reaches this tablet only through it.
      const api = cloud.apiBase?.();
      json(res, 200, { on: on(), linked: !!cloud.credential(), connected, since: since && connected ? new Date(since).toISOString() : null, error, connector: on() && connected && api ? `${api.replace(/\/+$/, '')}/mcp` : null });
      return true;
    }
    if (req.method !== 'POST') return false;
    const b = await body(req);
    if (p === '/relay') {
      save({ ...read(), on: !!b.on, at: new Date(now()).toISOString() });
      if (b.on) { tries = 0; start(); } else stop();
      json(res, 200, { on: !!b.on });
      return true;
    }
    if (p === '/relay/handoff/end') {
      const had = handoffs.delete(sha(String(b.token || '')));
      if (had) tokens();
      json(res, 200, { ok: true, ended: had });
      return true;
    }
    if (p === '/relay/handoff') {
      const base = String(b.base || '').replace(/\/+$/, '');
      if (!okHandoff(base)) { json(res, 400, { error: 'base' }); return true; }
      if (!on() || !relayId || !url) { json(res, 200, { off: true }); return true; }
      const token = /^[A-Za-z0-9_-]{22,64}$/.test(String(b.token || '')) ? String(b.token) : crypto.randomBytes(16).toString('base64url');
      handoffs.set(sha(token), { base, until: now() + Math.min(Math.max(Number(b.minutes) || 180, 1), 24 * 60) * 60e3 });
      tokens();
      const api = cloud.apiBase?.();
      // page: the same list page served by the service, so a phone can open it anywhere (openhouse-cloud/lambda/app.ts, GET /l)
      json(res, 200, { url, relay: relayId, token, ...(api ? { page: `${api.replace(/\/+$/, '')}/${b.page === 'p' ? 'p' : 'l'}` } : {}) });
      return true;
    }
    json(res, 404, { error: 'not found' });
    return true;
  }
  handle.changed = changed;
  handle.stop = () => { clearInterval(sweep); stop(); };
  handle.status = () => ({ on: on(), connected });
  /** For an invite's link (POST /setup/invite): the cloud's phone page and this tablet's relay id, while reaching
   *  home from away is on and connected; else null (the link works on the home Wi-Fi only). */
  handle.inviteVia = () => { const api = cloud.apiBase?.(); return on() && connected && relayId && api ? { page: `${api.replace(/\/+$/, '')}/h/`, relay: relayId } : null; };
  return handle;
}
