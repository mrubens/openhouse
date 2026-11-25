// Finding the family's Opie on the home Wi-Fi: the tablet advertises _openhouse._tcp over mDNS (Bonjour) while a
// computer may pair (the shell's Screens.kt, Android's NsdManager). One question, asked from an ordinary port so
// responders answer straight back (no need to share port 5353 with the computer's own mDNS service), on every
// IPv4 network this computer is on. No dependencies.
import dgram from 'node:dgram';
import os from 'node:os';

export const SERVICE = '_openhouse._tcp.local';

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map((l) => { const b = Buffer.from(l); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...parts, Buffer.from([0])]);
}
/** A PTR question for the service, asking for a unicast answer (QU). */
export function query(name = SERVICE) {
  const head = Buffer.alloc(12); head.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4); tail.writeUInt16BE(12, 0); tail.writeUInt16BE(0x8001, 2); // PTR, IN + QU
  return Buffer.concat([head, encodeName(name), tail]);
}

function readName(buf, at) {
  const labels = []; let jumped = false, end = at, guard = 0;
  while (guard++ < 128) {
    const len = buf[at];
    if (len === undefined) throw new Error('short');
    if (len === 0) { if (!jumped) end = at + 1; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = at + 2; at = ((len & 0x3f) << 8) | buf[at + 1]; jumped = true; continue; }
    labels.push(buf.toString('utf8', at + 1, at + 1 + len)); at += 1 + len;
  }
  return { name: labels.join('.'), end };
}

/** Records in one answer: [{name, type, ttl, data}] (PTR -> name, SRV -> {port, target}, A -> address). */
export function parse(buf) {
  const qd = buf.readUInt16BE(4), n = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let at = 12;
  for (let i = 0; i < qd; i++) at = readName(buf, at).end + 4;
  const out = [];
  for (let i = 0; i < n; i++) {
    const { name, end } = readName(buf, at); at = end;
    const type = buf.readUInt16BE(at), len = buf.readUInt16BE(at + 8), start = at + 10;
    let data = null;
    if (type === 12) data = readName(buf, start).name;
    else if (type === 33) data = { port: buf.readUInt16BE(start + 4), target: readName(buf, start + 6).name };
    else if (type === 1 && len === 4) data = [...buf.subarray(start, start + 4)].join('.');
    out.push({ name, type, data });
    at = start + len;
  }
  return out;
}

/** The Opie tablets answering on this computer's networks: [{name, address, port}] (no duplicates). */
export async function findTablets({ timeoutMs = 2500, service = SERVICE } = {}) {
  const nets = Object.values(os.networkInterfaces()).flat().filter((x) => x && x.family === 'IPv4' && !x.internal);
  const found = new Map();
  const sockets = [];
  const add = (buf, rinfo) => {
    let recs; try { recs = parse(buf); } catch { return; }
    const ptrs = recs.filter((r) => r.type === 12 && r.name.toLowerCase() === service.toLowerCase()).map((r) => r.data);
    for (const inst of ptrs.length ? ptrs : recs.filter((r) => r.type === 33).map((r) => r.name)) {
      const srv = recs.find((r) => r.type === 33 && r.name === inst)?.data;
      if (!srv) continue;
      const a = recs.find((r) => r.type === 1 && r.name === srv.target)?.data || rinfo.address;
      const label = inst.slice(0, inst.length - service.length - 1) || inst;
      found.set(`${a}:${srv.port}`, { name: label, address: a, port: srv.port });
    }
  };
  await Promise.all((nets.length ? nets : [{ address: '0.0.0.0' }]).map((n) => new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sockets.push(s);
    s.on('message', add);
    s.on('error', () => resolve());
    s.bind(0, n.address === '0.0.0.0' ? undefined : n.address, () => {
      try { s.setMulticastInterface?.(n.address); } catch {}
      const q = query(service);
      s.send(q, 5353, '224.0.0.251', () => resolve());
      setTimeout(() => s.send(q, 5353, '224.0.0.251', () => {}), 600); // once more: Wi-Fi drops multicast now and then
    });
  })));
  await new Promise((r) => setTimeout(r, timeoutMs));
  for (const s of sockets) try { s.close(); } catch {}
  return [...found.values()];
}
