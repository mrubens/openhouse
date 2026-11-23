// Just enough DNS to do mDNS / DNS-SD: build a question, parse any answer packet.
// No dependencies. Record types we keep: A, AAAA, PTR, SRV, TXT.

export const T = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };

/** A query packet. unicast=true sets the QU bit (answers may come straight back to us). */
export function query(questions, { unicast = false } = {}) {
  const parts = [Buffer.from([0, 0, 0, 0, 0, questions.length, 0, 0, 0, 0, 0, 0])];
  for (const { name, type } of questions) {
    for (const label of name.replace(/\.$/, '').split('.')) {
      const b = Buffer.from(label, 'utf8');
      parts.push(Buffer.from([b.length]), b);
    }
    parts.push(Buffer.from([0, (type >> 8) & 255, type & 255, unicast ? 0x80 : 0, 1]));
  }
  return Buffer.concat(parts);
}

function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (guard++ < 128) {
    if (off >= buf.length) throw new Error('name past end');
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.'), end };
}

/** Parse a DNS message. Returns { answers: [{name, type, ttl, data}] } (answers + authority + additional). */
export function parse(buf) {
  if (buf.length < 12) throw new Error('short packet');
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  const isResponse = !!(buf[2] & 0x80);
  let off = 12;
  const questions = [];
  for (let i = 0; i < qd; i++) {
    const n = readName(buf, off); off = n.end + 4;
    questions.push(n.name);
  }
  const answers = [];
  for (let i = 0; i < an + ns + ar; i++) {
    const n = readName(buf, off); off = n.end;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off), ttl = buf.readUInt32BE(off + 4), rdlen = buf.readUInt16BE(off + 8);
    const rd = off + 10;
    off = rd + rdlen;
    if (off > buf.length) break;
    let data = null;
    try {
      if (type === T.A && rdlen === 4) data = [...buf.subarray(rd, rd + 4)].join('.');
      else if (type === T.AAAA && rdlen === 16) data = buf.subarray(rd, rd + 16).toString('hex').match(/.{4}/g).map((h) => h.replace(/^0+(?=.)/, '')).join(':');
      else if (type === T.PTR) data = readName(buf, rd).name;
      else if (type === T.SRV) data = { priority: buf.readUInt16BE(rd), weight: buf.readUInt16BE(rd + 2), port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name };
      else if (type === T.TXT) {
        data = {};
        for (let p = rd; p < rd + rdlen;) {
          const l = buf[p];
          const s = buf.toString('utf8', p + 1, p + 1 + l);
          p += 1 + l;
          if (!s) continue;
          const eq = s.indexOf('=');
          if (eq < 0) data[s.toLowerCase()] = true; else data[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
        }
      }
    } catch { data = null; }
    if (data !== null) answers.push({ name: n.name, type, ttl, data });
  }
  return { isResponse, questions, answers };
}
