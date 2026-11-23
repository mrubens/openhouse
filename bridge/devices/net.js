// Small network helpers the drivers share: HTTP with a timeout, XML fields, a minimal WebSocket
// client (TLS with the device's own certificate, which a TV's is), Wake-on-LAN and UDP.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';

/** Only devices on the home network: drivers and recipes never reach anywhere else. */
export function isLocal(ip) {
  return /^(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168|169\.254)\.\d+\.\d+$/.test(String(ip || ''));
}

// ---- a device's own certificate, trusted for its address alone ----
// TVs and printers sign their own secure sockets, so no authority vouches for them. The first one seen at an address
// and port is kept (index.js saves them with the devices); after that only the same certificate is accepted there,
// so another machine on the Wi-Fi can't pose as the TV. Pairing a device again forgets its certificate.
export const pins = { get: () => null, set: () => {} };
const fingerprint = (sock) => sock.getPeerCertificate?.()?.fingerprint256 || null;
/** Check a connected TLS socket against the kept certificate; keep it the first time. Throws when it changed. */
export function checkPin(host, port, sock) {
  const fp = fingerprint(sock), where = `${host}:${port}`;
  if (!fp) throw new Error(`${where} showed no certificate`);
  const kept = pins.get(where);
  if (!kept) { pins.set(where, fp); return; }
  if (kept !== fp) throw new Error(`The device at ${host} answered with a different certificate than before. If it was reset or updated, pair it again; otherwise something else may be posing as it.`);
}

/**
 * One HTTP(S) request to a device. `insecure` accepts the device's self-signed certificate (TVs,
 * printers). Returns { status, headers, text }.
 */
export async function request(url, { method = 'GET', headers = {}, body, ms = 4000, insecure = true } = {}) {
  const u = new URL(url);
  if (!isLocal(u.hostname)) throw new Error(`not on the home network: ${u.hostname}`);
  // node:http, not fetch: embedded web servers send headers fetch's strict parser rejects
  // (a Canon printer's IPP answers fail with "bad response").
  const mod = u.protocol === 'https:' ? https : http;
  if (body != null && typeof body === 'string') body = Buffer.from(body);
  const h = { ...headers, ...(body ? { 'content-length': body.length } : {}) };
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers: h, rejectUnauthorized: !insecure, insecureHTTPParser: true, timeout: ms, agent: false }, (res) => {
      if (u.protocol === 'https:' && insecure) { try { checkPin(u.hostname, u.port || 443, res.socket); } catch (e) { req.destroy(); return reject(e); } }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 4_000_000) req.destroy(new Error('answer too large')); else chunks.push(c); });
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), buf }); });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

export const unxml = (s) => s == null ? null : String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
export const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The text of the first <name> element (any namespace prefix). */
export function xml(text, name) {
  const m = String(text).match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'));
  return m ? unxml(m[1].trim()) : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wake-on-LAN magic packet, to the subnet broadcast and the device's last address. */
export async function wake(mac, address) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('no MAC address to wake it with');
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))]);
  const targets = ['255.255.255.255', address && address.replace(/\.\d+$/, '.255'), address].filter(Boolean);
  await udp(pkt, targets, [9, 7], { broadcast: true, times: 3 });
}

/** Send a UDP packet (to several targets/ports, a few times). With `listen`, collect replies for that long. */
export function udp(pkt, targets, ports, { broadcast = false, times = 1, listen = 0, bindPort = 0, first = false } = {}) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const replies = [];
    let done = false;
    const finish = () => { if (done) return; done = true; try { s.close(); } catch {} resolve(replies); };
    s.on('error', () => {});
    s.on('message', (m, r) => { replies.push({ data: m, address: r.address, port: r.port }); if (first) finish(); });
    s.bind(bindPort, async () => {
      if (broadcast) try { s.setBroadcast(true); } catch {}
      for (let i = 0; i < times && !done; i++) {
        for (const t of targets) for (const p of [].concat(ports)) s.send(pkt, p, t, () => {});
        await sleep(120);
      }
      setTimeout(finish, listen || 50);
    });
  });
}

/**
 * A minimal WebSocket client (RFC 6455, text frames). Enough for TV remotes.
 * Returns { send(obj), next(predicate, ms), close() }; messages are parsed as JSON when they can be.
 */
export function websocket(url, { ms = 8000 } = {}) {
  const u = new URL(url);
  if (!isLocal(u.hostname)) return Promise.reject(new Error(`not on the home network: ${u.hostname}`));
  const secure = u.protocol === 'wss:';
  const port = Number(u.port || (secure ? 443 : 80));
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = secure ? tls.connect({ host: u.hostname, port, rejectUnauthorized: false, servername: undefined }) : net.connect({ host: u.hostname, port });
    const fail = (e) => { sock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new Error('timed out connecting')), ms);
    let buf = Buffer.alloc(0), open = false;
    const queue = [], waiters = [];
    const deliver = (msg) => {
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.t); w.resolve(msg); } else queue.push(msg);
    };
    const frame = (op, payload) => {
      const len = payload.length, mask = crypto.randomBytes(4);
      const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 255]) : null;
      if (!head) throw new Error('message too long');
      const body = Buffer.from(payload); for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      sock.write(Buffer.concat([head, mask, body]));
    };
    let partial = [];
    sock.on(secure ? 'secureConnect' : 'connect', () => {
      if (secure) { try { checkPin(u.hostname, port, sock); } catch (e) { clearTimeout(timer); return fail(e); } }
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('error', (e) => { if (!open) { clearTimeout(timer); reject(e); } });
    sock.on('close', () => { for (const w of waiters.splice(0)) { clearTimeout(w.t); w.reject(new Error('connection closed')); } });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) { clearTimeout(timer); return fail(new Error(head.split('\r\n')[0])); }
        open = true; clearTimeout(timer);
        resolve(api);
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f, fin = buf[0] & 0x80;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 0x9) { frame(0xA, payload); continue; } // ping
        if (op === 0x8) { sock.end(); continue; }
        if (op === 0x1 || op === 0x0) {
          partial.push(payload);
          if (!fin) continue;
          const text = Buffer.concat(partial).toString('utf8'); partial = [];
          let msg; try { msg = JSON.parse(text); } catch { msg = text; }
          deliver(msg);
        }
      }
    });
    const api = {
      send: (obj) => frame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))),
      next: (pred = () => true, wait = 5000) => {
        const i = queue.findIndex(pred);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => { const w = { pred, resolve: res, reject: rej, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('no answer')); }, wait) }; waiters.push(w); });
      },
      close: () => { try { frame(0x8, Buffer.alloc(0)); } catch {} sock.end(); setTimeout(() => sock.destroy(), 300); },
    };
  });
}
