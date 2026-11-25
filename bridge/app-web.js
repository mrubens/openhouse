// An app reading something on the web through the bridge (kit web.get / web.json): for a site whose own server doesn't
// let a page on another origin read it (no CORS), like a school's lunch menu API. Only the hosts the app's "reaches"
// names (what the install card showed, for an app from a plugin: plugins.js reachesOf), only https GETs, never the home
// network (each redirect checked again), no cookies, and the body capped. "*.example.com" is any name under
// example.com (not example.com itself).
//
// publicGet is the one way the bridge reads a web address someone else chose (an app, a recipe link, read_page): every
// hop's name is looked up once, refused if any address it gives is on the home network, and connected to at exactly
// that address (pinnedFetch).
//
// POST /apps/fetch {url}  ->  {status, type, text}   (an app's own key; server.js)
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const v4Private = (ip) => {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
};
/** An IPv6 address's eight 16-bit groups (a trailing dotted IPv4 and a %zone allowed), or null when it isn't one. */
function v6Groups(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const tail = s.match(/^(.*:)(\d+\.[\d.]+)$/);
  if (tail) {
    if (!net.isIPv4(tail[2])) return null;
    const [a, b, c, d] = tail[2].split('.').map(Number);
    s = tail[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h ? h.split(':') : []);
  const head = part(halves[0]), rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Whether an address isn't a public one: the home network, this device, link-local, multicast, reserved; in IPv6 also
 * every form that carries an IPv4 address (mapped, translated, compatible, NAT64, 6to4, Teredo) judged by that IPv4,
 * and anything outside global unicast. Anything it can't read counts as not public.
 */
export function privateIp(ip) {
  ip = String(ip || '');
  if (net.isIPv4(ip)) return v4Private(ip);
  const g = v6Groups(ip);
  if (!g) return true;
  const zeros = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4Private(v4Of(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return v4Private(v4Of(g[6], g[7])); // ::ffff:0:a.b.c.d
  if (zeros(6)) return true; // ::, ::1 and ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).some(Boolean) || v4Private(v4Of(g[6], g[7])); // NAT64 64:ff9b::/96 (64:ff9b:1::/48 is local use)
  if (g[0] === 0x2002) return v4Private(v4Of(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return v4Private(v4Of(g[2], g[3])) || v4Private(v4Of(g[6] ^ 0xffff, g[7] ^ 0xffff)); // Teredo: its server and its client
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return (g[0] & 0xe000) !== 0x2000; // only global unicast (2000::/3) is public: not ULA (fc00::/7), link-local (fe80::/10), multicast
}

/** Names that are only ever on the home network. */
export const localName = (host) => /^(localhost|.*\.localhost|.*\.local|.*\.lan|.*\.home|.*\.home\.arpa|.*\.internal|.*\.intranet|.*\.corp)$/i.test(String(host).replace(/\.$/, ''));

/** Whether host[:port] is one of reaches ("api.example.com", "*.example.com", "api.example.com:8443"). */
export function reachMatches(host, reaches) {
  const h = String(host || '').toLowerCase();
  return (reaches || []).some((r) => {
    const p = String(r || '').toLowerCase();
    if (!p) return false;
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
/**
 * A GET to url that connects to exactly the address already checked (address, family), never looking the name up
 * again: a name that answers once with a public address and then with one on the home network (DNS rebinding) gets
 * nowhere. The certificate is still checked against the name. Resolves to what fetch would (status, headers.get,
 * arrayBuffer), the body cut at max + 1 bytes; a body that stops short of its end is an error.
 */
export function pinnedFetch(url, { signal, headers = {}, address, family, max = 3e6 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), tls = u.protocol === 'https:', host = u.hostname.replace(/^\[|\]$/g, '');
    const req = (tls ? https : http).request({ host, ...(tls ? { servername: net.isIP(host) ? undefined : host } : {}), port: u.port || (tls ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers, signal, agent: false,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) }, (res) => {
      const parts = []; let n = 0, cut = false;
      res.on('data', (d) => {
        if (cut) return;
        n += d.length;
        if (n > max + 1) { parts.push(d.subarray(0, d.length - (n - max - 1))); cut = true; res.destroy(); } else parts.push(d);
      });
      res.on('error', (e) => { if (!cut) reject(e); });
      res.on('close', () => {
        if (!res.complete && !cut) return reject(signal?.aborted ? aborted() : new Error('cut short'));
        resolve({ status: res.statusCode, headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
          arrayBuffer: async () => Buffer.concat(parts) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const lookupAll = (h) => dns.lookup(h, { all: true });
/**
 * A GET of a web address someone else chose, never reaching the home network. Each hop (every redirect too) must be
 * https (or http, with http: true), carry no sign-in, pass allow(url) (null, or the answer to give instead), and have
 * a name whose every address is public; it is then connected to at the address checked (pinnedFetch). ipLiterals:
 * false refuses an address given as a bare IP.
 * {url, status, type, buf} (buf cut at max + 1 bytes) or {error, status?}, error one of 'address', 'protocol',
 * 'signin', 'home', 'notfound', 'timeout', 'failed', 'redirects' (each caller says it in its own words), or allow's.
 */
export async function publicGet(link, { allow = () => null, http: plain = false, ipLiterals = true, headers = {}, timeoutMs = 12000, max = 3e6, fetch = pinnedFetch, lookup = lookupAll } = {}) {
  let url; try { url = new URL(String(link || '').trim()); } catch { return { error: 'address' }; }
  for (let hops = 0; hops < 5; hops++) {
    if (!(url.protocol === 'https:' || (plain && url.protocol === 'http:'))) return { error: 'protocol' };
    if (url.username || url.password) return { error: 'signin' };
    const refused = allow(url);
    if (refused) return refused;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (localName(host) || (net.isIP(host) && (!ipLiterals || privateIp(host)))) return { error: 'home', status: 403 };
    let found;
    if (net.isIP(host)) found = [{ address: host, family: net.isIP(host) }];
    else { try { found = await lookup(host); } catch { return { error: 'notfound' }; } }
    if (!found?.length || found.some((a) => privateIp(a.address))) return { error: 'home', status: 403 };
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ac.signal, redirect: 'manual', credentials: 'omit', headers, address: found[0].address, family: found[0].family || (net.isIPv6(found[0].address) ? 6 : 4), max });
      const where = r.status >= 300 && r.status < 400 && r.headers.get('location');
      if (where) { try { url = new URL(where, url); } catch { return { error: 'failed' }; } continue; } // (checked again above)
      const buf = Buffer.from(await r.arrayBuffer());
      return { url, status: r.status, type: (r.headers.get('content-type') || '').split(';')[0].trim(), buf };
    } catch (e) { return { error: e.name === 'AbortError' || ac.signal.aborted ? 'timeout' : 'failed' }; }
    finally { clearTimeout(timer); }
  }
  return { error: 'redirects' };
}

const PER_MINUTE = 30;
const recent = new Map(); // app -> [times]
const SAY = { address: "That isn't a web address.", protocol: 'Only https.', signin: 'No sign-ins in the address.', home: 'Not the home network.',
  notfound: "That site couldn't be found.", timeout: 'That took too long.', failed: "That didn't open.", redirects: 'It kept sending us elsewhere.' };

/** {status, type, text} or {error, status?}. reaches: the app's granted hosts. binary: any type, as base64 (a transit
 *  feed's protobuf, a zip), up to 20 MB, with the same hosts and address checks. */
export async function appFetch(app, link, reaches, { fetch = pinnedFetch, timeoutMs = 15000, max = 3e6, binary = false, lookup = lookupAll } = {}) {
  if (binary) { max = 20e6; timeoutMs = Math.max(timeoutMs, 45000); }
  if (!reaches?.length) return { error: "This app doesn't reach the internet." };
  const t0 = Date.now(), times = (recent.get(app) || []).filter((t) => t > t0 - 60e3);
  if (times.length >= PER_MINUTE) return { error: 'Too many at once: try again in a minute.', status: 429 };
  recent.set(app, [...times, t0]);
  const r = await publicGet(link, { fetch, lookup, timeoutMs, max, ipLiterals: false, headers: { 'user-agent': 'OpenHouse', accept: binary ? '*/*' : 'application/json,text/*;q=0.8' },
    allow: (u) => (reachMatches(u.host, reaches) ? null : { error: `This app doesn't reach ${u.host}.`, status: 403 }) });
  if (r.error) return SAY[r.error] ? { error: SAY[r.error], ...(r.status ? { status: r.status } : {}) } : r;
  if (!binary && r.type && !/^(application\/([\w.+-]*json|xml)|text\/[\w.+-]+)$/.test(r.type)) return { error: `Not text (${r.type}).` };
  if (r.buf.length > max) return { error: 'Too big.' };
  return binary ? { status: r.status, type: r.type, base64: r.buf.toString('base64') } : { status: r.status, type: r.type, text: r.buf.toString('utf8') };
}
