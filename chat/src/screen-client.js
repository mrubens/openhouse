// A screen's side of bridge/screens.js: pairing with the brain, then every request sealed with this screen's own key.
// Used by the screen page (screen.jsx) and by bridge/test/screens.test.mjs.
import { CP, b64 } from './seal.js';
import { relayTransport, Refused } from './relay-client.js';

const te = new TextEncoder(), td = new TextDecoder();
const nonce = () => crypto.getRandomValues(new Uint8Array(12));

/** Join with the one-time key from the QR code. Resolves to {id, key, scopes, name} or {refused: true}. */
export async function pair({ base = '', pair, key, name, onAsked, signal, fetch: f = fetch }) {
  const k = b64.dec(key);
  const box = CP.seal(k, nonce(), te.encode(`hello:${pair}`), te.encode(JSON.stringify({ name })));
  let r = await f(base + '/pair/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pair, box: b64.enc(box) }), signal });
  if (!r.ok) throw new Error('ended');
  onAsked?.();
  for (;;) {
    r = await f(base + '/pair/wait?pair=' + encodeURIComponent(pair), { signal });
    if (!r.ok) throw new Error('ended');
    const j = await r.json();
    if (j.waiting) continue;
    const opened = CP.open(k, te.encode(`welcome:${pair}`), b64.dec(j.box));
    if (!opened) throw new Error('ended');
    return JSON.parse(td.decode(opened));
  }
}

/** The token a device says hello to the relay with: from its key, as the tablet makes it (bridge/screens.js relayToken). */
export async function relayTokenOf(key) {
  const k = await crypto.subtle.importKey('raw', b64.dec(key), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode('openhouse relay') }, k, 128);
  return b64.enc(new Uint8Array(bits));
}

/** pair(), from anywhere: an invite's link, opened away from home, joins through the cloud's relay (url: its address).
 *  Resolves to the welcome, with relay ({url, relay, token}) for reaching the tablet afterwards. */
export async function relayPair({ url, relay, pair, key, name, onAsked, signal, WS = globalThis.WebSocket }) {
  const rt = relayTransport({ url, pair }, { WS });
  try {
    const k = b64.dec(key);
    const box = CP.seal(k, nonce(), te.encode(`hello:${pair}`), te.encode(JSON.stringify({ name })));
    const step = async (p, body) => { const r = await rt.request({ p }, te.encode(JSON.stringify(body)), { signal }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };
    let r = await step('hello', { box: b64.enc(box) });
    if (!r.ok) throw new Error('ended');
    onAsked?.();
    for (;;) {
      r = await step('wait', {});
      if (!r.ok) throw new Error('ended');
      if (r.j.waiting) { await new Promise((a) => setTimeout(a, 1500)); continue; }
      const opened = CP.open(k, te.encode(`welcome:${pair}`), b64.dec(r.j.box));
      if (!opened) throw new Error('ended');
      const w = JSON.parse(td.decode(opened));
      return w.refused ? w : { ...w, relay: { url, relay, token: await relayTokenOf(w.key) } };
    }
  } catch (e) { throw e instanceof Refused ? new Error('ended') : e; } finally { rt.close(); }
}

export class Removed extends Error {}

/**
 * Requests to the brain as this screen. Counters only go up (microseconds of this device's clock, or one more than
 * the last), so the brain can refuse a request sent twice.
 *
 * Away from home (docs/networking.md): with `relay` ({url, relay, token}, from GET /relay/me), a request that can't
 * reach the home network goes through the cloud's relay instead, sealed the same way. onRelay(cfg or null) is told
 * what the tablet says about the relay now and then (keep it with the pairing).
 *
 * Or over the household's own Tailscale (bridge/tailscale.js): with `tailnet` (the tablet's tailnet address,
 * https://<machine>.<tailnet>.ts.net, from the same GET /relay/me or a computer's welcome), a request that can't reach
 * the home network goes there next, before the relay: the same sealed bytes to the same /s. onTailnet(address or
 * null) is told when the tablet says it changed (keep it with the pairing too).
 */
export function client({ base = '', id, key, fetch: f = fetch, relay = null, onRelay = null, tailnet = null, onTailnet = null, WS = globalThis.WebSocket, probeMs = 3000, onlyRelay = false, api = null }) {
  const K = b64.dec(key);
  let last = 0;
  const next = () => (last = Math.max(Date.now() * 1000, last + 1));
  let rt = null, away = 0, checked = 0, asked = 0, tnAway = 0, tnChecked = 0;
  const viaRelay = () => (rt ??= relayTransport(relay, { WS, api }));
  /** On the home network? A quick answer from it (any status) says yes; asked at most every 30 s. */
  async function home() {
    if (!relay && !tailnet) return true;
    if (onlyRelay) return false; // a page served by the cloud: the tablet is only ever through the relay
    if (Date.now() < away) return false;
    if (Date.now() - checked < 30e3) return true;
    try { await f(base + '/pair/wait?pair=-', { signal: AbortSignal.timeout(probeMs) }); checked = Date.now(); return true; }
    catch { away = Date.now() + 60e3; return false; }
  }
  /** The tablet over the tailnet: a quick answer from it says this device's Tailscale is on; asked at most every 30 s. */
  async function overTailnet() {
    if (!tailnet || Date.now() < tnAway) return false;
    if (Date.now() - tnChecked < 30e3) return true;
    try { await f(tailnet + '/pair/wait?pair=-', { signal: AbortSignal.timeout(probeMs) }); tnChecked = Date.now(); return true; }
    catch { tnAway = Date.now() + 60e3; return false; }
  }
  async function post(box, signal, big) {
    if (onlyRelay && !relay && !tailnet) throw new TypeError('no relay'); // (a page served by the cloud has no home network to try)
    const send = (at) => f(at + '/s', { method: 'POST', headers: { 'x-screen': id, 'content-type': 'application/octet-stream' }, body: box, signal });
    if (await home()) {
      try { return await send(base); }
      catch (e) { if ((!relay && !tailnet) || signal?.aborted) throw e; away = Date.now() + 60e3; }
    }
    if (await overTailnet()) {
      try { return await send(tailnet); }
      catch (e) { if (!relay || signal?.aborted) throw e; tnAway = Date.now() + 60e3; }
    }
    if (!relay) throw new TypeError("can't reach the tablet");
    try { return await viaRelay().request({ k: 's', id }, box, { signal, big }); }
    catch (e) { if (e instanceof Refused) { relay = null; rt = null; onRelay?.(null); } throw e; }
  }
  /** Ask the tablet for the relay's address and this device's token (on the home network, every few hours). */
  function refreshRelay() {
    if ((!onRelay && !onTailnet) || Date.now() - asked < (relay || tailnet ? 6 : 1) * 3600e3) return;
    asked = Date.now();
    json('GET', '/relay/me').then((r) => {
      if (r.status !== 200 || !r.json) return;
      const tn = typeof r.json.tailnet === 'string' && /^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(r.json.tailnet) ? r.json.tailnet : null;
      if (onTailnet && tn !== tailnet) { tailnet = tn; tnAway = 0; tnChecked = 0; onTailnet(tn); }
      if (!onRelay) return;
      const cfg = r.json.off ? null : { url: r.json.url, relay: r.json.relay, token: r.json.token, ...(r.json.page ? { page: r.json.page } : {}) };
      if (JSON.stringify(cfg) !== JSON.stringify(relay)) { relay = cfg; rt = null; onRelay(cfg); }
    }).catch(() => { asked = 0; });
  }

  /** One request. onData(bytes) gets the body as it comes (a streamed answer); else it's returned whole. */
  /** app: the screen app asking (a TV's layout): the tablet answers only what that app may read. */
  /** big: an answer that may be large (an app's files, a photo): away, it may come in one box (relay-client.js). */
  async function request(m, p, b, { signal, onData, app, big } = {}, again = true) {
    const n = next();
    const box = CP.seal(K, nonce(), te.encode(`req:${id}`), te.encode(JSON.stringify({ n, m, p, ...(b !== undefined ? { b } : {}), ...(app ? { a: app } : {}) })));
    const r = await post(box, signal, big);
    // Removed: asked once more a moment later first, so a hub or tablet coming back up mid-request doesn't drop a pairing.
    if (r.status === 401) { if (again !== 'gone?') { await new Promise((ok) => setTimeout(ok, 2000)); return request(m, p, b, { signal, onData, app, big }, 'gone?'); } throw new Removed('removed'); }
    if (r.status === 409 && again) { const j = await r.json().catch(() => ({})); last = Math.max(last, Number(j.high) || 0); return request(m, p, b, { signal, onData, app, big }, false); }
    if (!r.ok) throw new Error(`brain said ${r.status}`);
    const reader = r.body.getReader();
    let buf = new Uint8Array(0), i = 0, head = null, ended = false;
    const parts = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (value) { const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb; }
      while (buf.length >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
        if (buf.length < 4 + len) break;
        const opened = CP.open(K, te.encode(`res:${id}:${n}:${i++}`), buf.subarray(4, 4 + len));
        buf = buf.slice(4 + len);
        if (!opened) throw new Error('reply did not open');
        const type = opened[0], data = opened.subarray(1);
        if (type === 0) head = JSON.parse(td.decode(data));
        else if (type === 1) { if (onData) onData(data); else parts.push(data); }
        else if (type === 2) ended = true;
      }
      if (done) break;
    }
    if (!head || !ended) throw new Error('reply cut off');
    if (Date.now() >= away && p !== '/relay/me') refreshRelay(); // answered from home: a moment to ask about the relay
    let size = 0; for (const x of parts) size += x.length;
    const body = new Uint8Array(size); let at = 0; for (const x of parts) { body.set(x, at); at += x.length; }
    return { status: head.status, type: head.type, body };
  }
  const json = async (m, p, b, opts) => {
    const r = await request(m, p, b, opts);
    let j = null; try { j = JSON.parse(td.decode(r.body)); } catch {}
    return { status: r.status, json: j };
  };
  /** A streamed answer (application/x-ndjson): onLine(object) for each line. */
  const lines = async (m, p, b, onLine, opts = {}) => {
    let rest = '';
    const r = await request(m, p, b, { ...opts, onData: (d) => {
      rest += td.decode(d, { stream: true });
      let k; while ((k = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, k); rest = rest.slice(k + 1); if (l.trim()) try { onLine(JSON.parse(l)); } catch {} }
    } });
    if (rest.trim()) try { onLine(JSON.parse(rest)); } catch {}
    return r.status;
  };
  /** 'home', 'away' (through the relay) or null (not known yet). */
  const where = () => (relay && Date.now() < away ? 'away' : checked || !relay ? 'home' : null);
  return { request, json, lines, where };
}
