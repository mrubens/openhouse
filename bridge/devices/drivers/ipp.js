// Printers that speak IPP (nearly every network printer since ~2010; AirPrint is IPP).
// Read-only here: whether it's ready, why not, and how much ink or toner is left.
import { request } from '../net.js';

const TAG = { op: 0x01, end: 0x03, int: 0x21, bool: 0x22, enum: 0x23, text: 0x41, name: 0x42, keyword: 0x44, uri: 0x45, charset: 0x47, lang: 0x48 };

function attr(tag, name, value) {
  const n = Buffer.from(name), v = Buffer.from(value);
  const b = Buffer.alloc(5 + n.length + v.length);
  b[0] = tag; b.writeUInt16BE(n.length, 1); n.copy(b, 3); b.writeUInt16BE(v.length, 3 + n.length); v.copy(b, 5 + n.length);
  return b;
}

/** Get-Printer-Attributes request body. */
export function getAttributes(uri, names) {
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 1, TAG.op]),
    attr(TAG.charset, 'attributes-charset', 'utf-8'), attr(TAG.lang, 'attributes-natural-language', 'en'), attr(TAG.uri, 'printer-uri', uri),
    ...names.map((n, i) => attr(TAG.keyword, i ? '' : 'requested-attributes', n)),
    Buffer.from([TAG.end]),
  ]);
}

/** Parse an IPP response into { status, attrs: { name: [values] } } (printer group only). */
export function parse(buf) {
  const status = buf.readUInt16BE(2), attrs = {};
  let off = 8, last = null;
  while (off < buf.length) {
    const tag = buf[off++];
    if (tag === TAG.end) break;
    if (tag < 0x10) continue; // a group delimiter
    const nl = buf.readUInt16BE(off); off += 2;
    const name = buf.toString('utf8', off, off + nl); off += nl;
    const vl = buf.readUInt16BE(off); off += 2;
    const raw = buf.subarray(off, off + vl); off += vl;
    const value = tag === TAG.int || tag === TAG.enum ? raw.readInt32BE(0) : tag === TAG.bool ? !!raw[0] : raw.toString('utf8');
    if (name) { last = name; (attrs[name] ||= []).push(value); } else if (last) attrs[last].push(value);
  }
  return { status, attrs };
}

const WANT = ['printer-state', 'printer-state-reasons', 'printer-state-message', 'printer-make-and-model', 'printer-info', 'printer-location',
  'marker-names', 'marker-levels', 'marker-colors', 'marker-types', 'printer-uuid'];

async function ask(d) {
  const path = '/' + String(d.mdnsTxt?.rp || 'ipp/print').replace(/^\//, '');
  const uri = `ipp://${d.address}:631${path}`;
  const r = await request(`http://${d.address}:631${path}`, { method: 'POST', body: getAttributes(uri, WANT), headers: { 'content-type': 'application/ipp' }, ms: 5000 });
  if (r.status !== 200) throw new Error(`The printer answered ${r.status}.`);
  return parse(r.buf).attrs;
}
const STATE = { 3: 'ready', 4: 'printing', 5: 'stopped' };
const nice = (k) => k.replace(/-(report|warning|error)$/, '').replace(/-/g, ' ');

export default {
  id: 'ipp', label: 'Printer',
  match: (d) => d.ports.includes(631) || d.mdns.some((s) => /^_ipps?\._tcp$/.test(s.type)),
  async identify(d) {
    const a = await ask(d);
    const mm = a['printer-make-and-model']?.[0] || d.mdnsTxt?.ty;
    return { name: a['printer-info']?.[0] || mm, model: mm, maker: mm?.split(' ')[0], kind: 'printer', room: a['printer-location']?.[0] || null };
  },
  actions: {
    status: {
      says: 'Whether it is ready, any problem, and ink or toner left',
      async run(d) {
        const a = await ask(d);
        const reasons = (a['printer-state-reasons'] || []).filter((r) => r !== 'none').map(nice);
        const ink = (a['marker-names'] || []).map((n, i) => ({ name: n, percent: a['marker-levels']?.[i] ?? null }))
          .filter((m) => m.percent !== null && m.percent >= 0);
        return { state: STATE[a['printer-state']?.[0]] || 'unknown', problems: reasons, message: a['printer-state-message']?.[0] || null, ink };
      },
    },
  },
};
