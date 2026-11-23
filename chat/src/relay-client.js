// A paired device's way to the tablet through the cloud's relay, when it isn't on the home Wi-Fi (docs/networking.md,
// openhouse-cloud/lambda/relay.ts, bridge/relay.js). One WebSocket, many requests at once; each request is the same sealed
// bytes a device POSTs to /s on the Wi-Fi, and each answer comes back as a Response with the same sealed body, so
// screen-client.js reads it the same way. The relay never has a key.
import { b64 } from './seal.js';

const CHUNK = 16 * 1024;
export class Refused extends Error {}

/** cfg: {url, relay, token} from the tablet's GET /relay/me. */
export function relayTransport({ url, relay, token }, { WS = globalThis.WebSocket, pingMs = 4 * 60e3 } = {}) {
  let ready = null, n = 0, ping = null;
  const pending = new Map();
  function connect() {
    if (ready) return ready;
    const p = new Promise((resolve, reject) => {
      const s = new WS(url);
      s.onopen = () => s.send(JSON.stringify({ t: 'hello', role: 'device', relay, token }));
      s.onmessage = (e) => {
        let m; try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.t === 'ok') { resolve(s); ping = setInterval(() => { try { s.send('{"t":"ping"}'); } catch {} }, pingMs); ping.unref?.(); }
        else if (m.t === 'no') reject(new Refused(m.why || 'refused'));
        else if (m.t === 'res') pending.get(m.rid)?.(m);
      };
      s.onerror = () => {};
      s.onclose = () => {
        clearInterval(ping); if (ready === p) ready = null;
        reject(new TypeError('relay closed'));
        for (const f of pending.values()) f({ closed: true });
        pending.clear();
      };
    });
    ready = p;
    p.catch(() => { if (ready === p) ready = null; });
    return p;
  }

  /** fields: {k, id?, p?}; bytes: the sealed request. Resolves to a Response (its body the sealed reply). */
  async function request(fields, bytes, { signal } = {}) {
    const s = await connect();
    const rid = (++n).toString(36) + Math.random().toString(36).slice(2, 8);
    let ctl, gotHead = false, headOk, headNo;
    const head = new Promise((a, b) => { headOk = a; headNo = b; });
    const body = new ReadableStream({ start(c) { ctl = c; } });
    // The cloud's relay may pass a reply's messages on out of order: each has its place (i), and they're taken in
    // that order (a tablet from before this sends no i: as they come).
    const early = new Map(); let next = 0;
    const take = (m) => {
      if (m.s !== undefined && !gotHead) { gotHead = true; headOk(m.s); }
      if (m.d) ctl.enqueue(b64.dec(m.d));
      if (m.e) { pending.delete(rid); if (!gotHead) { gotHead = true; headOk(200); } try { ctl.close(); } catch {} }
    };
    pending.set(rid, (m) => {
      if (m.closed) { if (!gotHead) headNo(new TypeError('relay closed')); else try { ctl.error(new Error('cut off')); } catch {} return; }
      if (!Number.isInteger(m.i)) return take(m);
      early.set(m.i, m);
      while (early.has(next)) { const x = early.get(next); early.delete(next); next++; take(x); }
    });
    signal?.addEventListener('abort', () => {
      if (!pending.delete(rid)) return;
      try { s.send(JSON.stringify({ t: 'cancel', rid })); } catch {}
      const e = signal.reason || new DOMException('aborted', 'AbortError');
      if (!gotHead) headNo(e); else try { ctl.error(e); } catch {}
    }, { once: true });
    const b = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes || ''));
    // In parts, only something small: the relay takes four parts (64 KB). Nothing this page sends is bigger; a photo
    // from a phone goes through the photo page's relay box (the tablet's share.html).
    if (b.length > 64 * 1024) { pending.delete(rid); throw new RangeError('too big to send through the relay'); }
    let i = 0, part_n = 0;
    do {
      const part = b.subarray(i, i + CHUNK); i += CHUNK;
      s.send(JSON.stringify({ t: 'req', rid, ...fields, i: part_n++, d: b64.enc(part), ...(i < b.length ? { more: 1 } : {}) }));
    } while (i < b.length);
    const status = await head;
    return new Response([204, 304].includes(status) ? null : body, { status });
  }
  return { request, close: () => ready?.then((s) => s.close()).catch(() => {}) };
}
