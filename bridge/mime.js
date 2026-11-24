// Reading an email (RFC 5322 / MIME) for mail.js: its headers, its text, and its images and PDFs. Small and
// forgiving on purpose (the bridge has no dependencies): what it can't make sense of is left out, never guessed at.
// A message forwarded as an attachment (message/rfc822) is read into the one around it.

const MAX_DEPTH = 8, MAX_PARTS = 200;

/** Header lines unfolded: [[name lowercased, value]] in order (top first). */
function headerList(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1][1] += ' ' + line.trim();
    else { const i = line.indexOf(':'); if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]); }
  }
  return out;
}

function decoder(charset) {
  try { return new TextDecoder(String(charset || 'utf-8').trim().toLowerCase().replace(/^(us-ascii|ascii)$/, 'utf-8'), { fatal: false }); }
  catch { return new TextDecoder('utf-8'); }
}

function qp(s, header = false) {
  if (header) s = s.replace(/_/g, ' ');
  const bytes = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else { const c = t.charCodeAt(i); if (c < 128) bytes.push(c); else bytes.push(...Buffer.from(t[i])); }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words (=?utf-8?B?...?=) in a header value. */
export function decodeWords(v) {
  return String(v || '').replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)(\s+(?==\?))?/g, '$1').replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, t) => {
    try { return decoder(cs).decode(enc.toUpperCase() === 'B' ? Buffer.from(t, 'base64') : qp(t, true)); } catch { return t; }
  });
}

/** A header's main value and its parameters: 'text/plain; charset="utf-8"' -> {value, params}. */
function params(v) {
  const parts = String(v || '').split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const p = {};
  for (const x of parts.slice(1)) {
    const i = x.indexOf('='); if (i < 0) continue;
    const raw = x.slice(0, i).trim().toLowerCase(), m = /^([^*]+)(\*(\d+))?(\*)?$/.exec(raw); if (!m) continue;
    let val = x.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    if (m[4]) { // extended: charset'lang'%xx (on the first piece), else just %xx
      const e = /^([^']*)'[^']*'(.*)$/.exec(val);
      try { val = decoder(e ? e[1] || 'utf-8' : 'utf-8').decode(Buffer.from(unescape(e ? e[2] : val), 'latin1')); } catch {}
    }
    p[m[1]] = m[2] && m[3] !== '0' ? (p[m[1]] || '') + val : val;
  }
  return { value: parts[0].trim().toLowerCase(), params: p };
}

/** The first address in a From-like header: {address, name}. */
export function address(v) {
  const s = decodeWords(v);
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s) || /([^\s<>",;]+@[^\s<>",;]+)/.exec(s);
  if (!m) return null;
  const name = s.slice(0, m.index).replace(/["']/g, '').trim();
  return { address: m[1].toLowerCase(), name };
}

/** HTML to plain text: enough to read a school newsletter. */
export function htmlText(h) {
  return String(h)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function body(bytes, enc) {
  enc = String(enc || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(bytes.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qp(bytes.toString('latin1'));
  return bytes;
}

/** A raw message -> {headers: [[name, value]], from, subject, date, text, attachments: [{type, name, bytes}]}. */
export function parseMail(raw) {
  const buf = Buffer.from(raw);
  const out = { text: [], html: [], attachments: [] };
  let parts = 0;
  function walk(b, depth) {
    if (depth > MAX_DEPTH || ++parts > MAX_PARTS) return null;
    const s = b.toString('latin1');
    const m = /\r?\n\r?\n/.exec(s);
    const head = m ? s.slice(0, m.index) : s, rest = m ? b.subarray(m.index + m[0].length) : Buffer.alloc(0);
    const hs = headerList(head), h = (n) => hs.find(([k]) => k === n)?.[1];
    const ct = params(h('content-type') || 'text/plain'), cd = params(h('content-disposition') || '');
    if (ct.value.startsWith('multipart/') && ct.params.boundary) {
      const bd = '--' + ct.params.boundary, t = rest.toString('latin1');
      let i = t.indexOf(bd);
      while (i >= 0) {
        const start = t.indexOf('\n', i) + 1; if (start <= 0) break;
        if (t.startsWith(bd + '--', i)) break;
        let next = t.indexOf('\n' + bd, start); if (next < 0) next = t.length;
        const end = next > 0 && t[next - 1] === '\r' ? next - 1 : next;
        walk(rest.subarray(start, end), depth + 1);
        i = next < t.length ? next + 1 : -1;
      }
      return hs;
    }
    if (ct.value === 'message/rfc822') { walk(body(rest, h('content-transfer-encoding')), depth + 1); return hs; }
    const data = body(rest, h('content-transfer-encoding'));
    const name = decodeWords(cd.params.filename || ct.params.name || '');
    const attached = cd.value === 'attachment' || (!!name && !ct.value.startsWith('text/'));
    if (!attached && ct.value === 'text/plain') out.text.push(decoder(ct.params.charset).decode(data));
    else if (!attached && ct.value === 'text/html') out.html.push(decoder(ct.params.charset).decode(data));
    else out.attachments.push({ type: ct.value, name: name.replace(/[\\/]/g, '_').slice(-120), bytes: data });
    return hs;
  }
  const headers = walk(buf, 0) || [];
  const h = (n) => headers.find(([k]) => k === n)?.[1];
  const text = out.text.join('\n\n').trim() || htmlText(out.html.join('\n'));
  return { headers, from: address(h('from')), subject: decodeWords(h('subject') || '').trim(), date: h('date') || null, text, attachments: out.attachments };
}

/** The receiving provider's verdict, from the top-most Authentication-Results (a sender can't put one above it):
 *  true when DMARC passed, or the sender's domain has no DMARC policy and DKIM or SPF passed for the From's domain. */
export function authenticated(headers, fromAddress) {
  const ar = headers.find(([k]) => k === 'authentication-results')?.[1];
  if (!ar || !fromAddress) return false;
  const domain = String(fromAddress).split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const got = (method) => { const m = new RegExp(`(?:^|[;\\s])${method}=(\\w+)([^;]*)`, 'i').exec(ar); return m ? { result: m[1].toLowerCase(), rest: m[2] } : null; };
  const dmarc = got('dmarc');
  if (dmarc?.result === 'pass') return true;
  if (dmarc && !['none', 'bestguesspass'].includes(dmarc.result)) return false; // fail, quarantine, reject, temperror…
  const aligned = (d) => !!d && (d.toLowerCase() === domain || domain.endsWith('.' + d.toLowerCase()) || d.toLowerCase().endsWith('.' + domain));
  const dkim = got('dkim'), spf = got('spf');
  if (dkim?.result === 'pass' && aligned(/header\.(?:d|i)=@?([^\s;]+)/i.exec(dkim.rest)?.[1]?.replace(/^.*@/, ''))) return true;
  if (spf?.result === 'pass' && aligned(/smtp\.mailfrom=(?:[^\s;@]*@)?([^\s;]+)/i.exec(spf.rest)?.[1])) return true;
  return false;
}
