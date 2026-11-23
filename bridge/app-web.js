// An app reading something on the web through the bridge (kit web.get / web.json): for a site whose own server doesn't
// let a page on another origin read it (no CORS), like a school's lunch menu API. Only the hosts the app's "reaches"
// names (what the install card showed, for an app from a plugin: plugins.js reachesOf), only https GETs, never the home
// network (each redirect checked again), no cookies, and the body capped. "*.example.com" is any name under
// example.com (not example.com itself).
//
// POST /apps/fetch {url}  ->  {status, type, text}   (an app's own key; server.js)
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';
import { privateIp } from './read-page.js';

/** Whether host[:port] is one of reaches ("api.example.com", "*.example.com", "api.example.com:8443"). */
export function reachMatches(host, reaches) {
  const h = String(host || '').toLowerCase();
  return (reaches || []).some((r) => {
    const p = String(r || '').toLowerCase();
    if (!p) return false;
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

/**
 * A GET to url that connects to exactly the address already checked (address, family), never looking the name up
 * again: a name that answers once with a public address and then with one on the home network (DNS rebinding) gets
 * nowhere. The certificate is still checked against the name. Resolves to what fetch would (status, headers.get,
 * arrayBuffer).
 */
export function pinnedFetch(url, { signal, headers = {}, address, family, max = 3e6 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ host: u.hostname, servername: net.isIP(u.hostname) ? undefined : u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers, signal, agent: false,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) }, (res) => {
      const parts = []; let n = 0;
      res.on('data', (d) => { n += d.length; if (n > max + 1) res.destroy(); else parts.push(d); });
      res.on('error', reject);
      res.on('close', () => resolve({ status: res.statusCode, headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
        arrayBuffer: async () => Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const PER_MINUTE = 30;
const recent = new Map(); // app -> [times]

/** {status, type, text} or {error, status?}. reaches: the app's granted hosts. binary: any type, as base64 (a transit
 *  feed's protobuf, a zip), up to 20 MB, with the same hosts and address checks. */
export async function appFetch(app, link, reaches, { fetch = pinnedFetch, timeoutMs = 15000, max = 3e6, binary = false, lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  if (binary) { max = 20e6; timeoutMs = Math.max(timeoutMs, 45000); }
  if (!reaches?.length) return { error: "This app doesn't reach the internet." };
  const t0 = Date.now(), times = (recent.get(app) || []).filter((t) => t > t0 - 60e3);
  if (times.length >= PER_MINUTE) return { error: 'Too many at once: try again in a minute.', status: 429 };
  recent.set(app, [...times, t0]);
  let url; try { url = new URL(String(link || '').trim()); } catch { return { error: "That isn't a web address." }; }
  for (let hops = 0; hops < 5; hops++) {
    if (url.protocol !== 'https:') return { error: 'Only https.' };
    if (url.username || url.password) return { error: 'No sign-ins in the address.' };
    if (!reachMatches(url.host, reaches)) return { error: `This app doesn't reach ${url.host}.`, status: 403 };
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) || /^(localhost|.*\.local|.*\.lan|.*\.home|.*\.internal)$/i.test(host)) return { error: 'Not the home network.', status: 403 };
    let found = []; try { found = await lookup(host); } catch { return { error: "That site couldn't be found." }; }
    if (!found.length || found.some((a) => privateIp(a.address))) return { error: 'Not the home network.', status: 403 };
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    // (connecting to the address just checked: pinnedFetch)
    try { r = await fetch(url, { signal: ac.signal, redirect: 'manual', credentials: 'omit', headers: { 'user-agent': 'OpenHouse', accept: binary ? '*/*' : 'application/json,text/*;q=0.8' }, address: found[0].address, family: found[0].family || (net.isIPv6(found[0].address) ? 6 : 4), max }); }
    catch (e) { clearTimeout(timer); return { error: e.name === 'AbortError' ? 'That took too long.' : "That didn't open." }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { clearTimeout(timer); url = new URL(r.headers.get('location'), url); continue; }
    try {
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!binary && type && !/^(application\/([\w.+-]*json|xml)|text\/[\w.+-]+)$/.test(type)) return { error: `Not text (${type}).` };
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) return { error: 'Too big.' };
      return binary ? { status: r.status, type, base64: buf.toString('base64') } : { status: r.status, type, text: buf.toString('utf8') };
    } catch (e) { return { error: e.name === 'AbortError' ? 'That took too long.' : "That didn't open." }; }
    finally { clearTimeout(timer); }
  }
  return { error: 'It kept sending us elsewhere.' };
}
