// Finding what's on the home network, from inside the display's runtime. Every part is
// best-effort and time-boxed; nothing here changes anything on another device.
//   mdns()      DNS-SD: what services each device advertises (TXT records say a lot)
//   ssdp()      UPnP M-SEARCH, then each device's description XML
//   sweep()     TCP connects across the subnet: a refused connection still proves a host is there
//   probe()     a few well-known ports on each host found
//   neighbors() the ARP table, where readable (not for Android apps since Android 10)
//   names()     reverse DNS at the router, for hosts that say nothing else
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import dns from 'node:dns';
import { execFile } from 'node:child_process';
import * as D from './dns.js';
import { request } from './net.js';

const MDNS = '224.0.0.251', SSDP = '239.255.255.250';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The service types worth asking about even if a device doesn't list them. */
export const SERVICE_TYPES = [
  '_googlecast._tcp', '_airplay._tcp', '_raop._tcp', '_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp',
  '_uscan._tcp', '_sonos._tcp', '_hue._tcp', '_esphomelib._tcp', '_shelly._tcp', '_http._tcp', '_spotify-connect._tcp',
  '_companion-link._tcp', '_homekit._tcp', '_hap._tcp', '_matter._tcp', '_matterc._udp', '_roku._tcp', '_rsp._tcp',
  '_amzn-wplay._tcp', '_androidtvremote2._tcp', '_nvstream._tcp', '_xbox._tcp', '_wled._tcp', '_elg._tcp',
  '_smb._tcp', '_device-info._tcp', '_workstation._tcp', '_ssh._tcp', '_sleep-proxy._udp', '_adb-tls-connect._tcp',
];

/** This display's IPv4 address on the home network and its subnet. */
export function localNet() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|dummy|rmnet|tun|docker|veth|utun|bridge|awdl|llw)/.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address)) continue;
      // Android hides the netmask from apps (it reads 0.0.0.0 or /32); assume a home /24 then.
      let bits = a.cidr ? Number(a.cidr.split('/')[1]) : 24;
      if (!(bits >= 16 && bits <= 30)) bits = 24;
      return { iface: name, address: a.address, bits: Math.max(bits, 22) }; // never sweep more than 1024 hosts
    }
  }
  return null;
}

function hostsOf({ address, bits }) {
  const ip = address.split('.').reduce((n, o) => n * 256 + Number(o), 0);
  const size = 2 ** (32 - bits), base = ip - (ip % size), out = [];
  for (let i = 1; i < size - 1; i++) {
    const n = base + i;
    if (n !== ip) out.push([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.'));
  }
  return out;
}

// --- mDNS / DNS-SD ---------------------------------------------------------------------------
/**
 * Browse DNS-SD. Questions go out from an ephemeral port ("legacy unicast": responders answer
 * straight back to it, so no multicast receive is needed) and also from 5353, where we listen to
 * the multicast answers as well. New service types and instances found along the way get their
 * own follow-up questions.
 * Returns [{ type, instance, name, host, port, txt, address }].
 */
export async function mdns({ ms = 3500, types = SERVICE_TYPES, log = () => {} } = {}) {
  const records = new Map(); // key -> { name, type, data, from }
  const addRecords = (buf, from) => {
    let p;
    try { p = D.parse(buf); } catch { return; }
    if (!p.isResponse) return;
    for (const a of p.answers) {
      const key = `${a.name.toLowerCase()}|${a.type}|${JSON.stringify(a.data)}`;
      if (!records.has(key)) records.set(key, { ...a, from });
    }
    pump();
  };
  const sockets = [];
  const open = (port) => new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => { log(`mdns ${port}: ${e.message}`); try { s.close(); } catch {} resolve(null); });
    s.on('message', (m, r) => addRecords(m, r.address));
    s.bind(port, () => {
      if (port === 5353) try { s.addMembership(MDNS); s.setMulticastTTL(255); } catch (e) { log(`mdns join: ${e.message}`); }
      sockets.push(s); resolve(s);
    });
  });
  const uni = await open(0);
  const multi = await open(5353);
  if (!uni && !multi) return [];
  const asked = new Set();
  const ask = (name, type) => {
    const k = `${name}|${type}`;
    if (asked.has(k)) return;
    asked.add(k);
    const pkt = D.query([{ name, type }]);
    for (const s of [uni, multi]) if (s) s.send(pkt, 5353, MDNS, () => {});
  };
  const known = new Set(types.map((t) => t + '.local'));
  // Anything new: list a newly seen service type; resolve a newly seen instance.
  function pump() {
    for (const r of records.values()) {
      if (r.type !== D.T.PTR) continue;
      if (r.name === '_services._dns-sd._udp.local') { if (!known.has(r.data)) { known.add(r.data); ask(r.data, D.T.PTR); } continue; }
      const inst = r.data;
      if (!has(inst, D.T.SRV)) ask(inst, D.T.SRV);
      if (!has(inst, D.T.TXT)) ask(inst, D.T.TXT);
    }
    for (const r of records.values()) if (r.type === D.T.SRV && !has(r.data.target, D.T.A)) ask(r.data.target, D.T.A);
  }
  const has = (name, type) => { const n = name.toLowerCase(); for (const r of records.values()) if (r.type === type && r.name.toLowerCase() === n) return true; return false; };
  // Ask twice (UDP drops), a little apart; questions for things found arrive as they come.
  for (let round = 0; round < 2; round++) {
    asked.clear();
    ask('_services._dns-sd._udp.local', D.T.PTR);
    for (const t of known) ask(t, D.T.PTR);
    await wait(round ? ms - 900 : 900);
  }
  for (const s of sockets) try { s.close(); } catch {}

  const all = [...records.values()];
  const get = (name, type) => all.filter((r) => r.type === type && r.name.toLowerCase() === name.toLowerCase());
  const out = [];
  for (const r of all) {
    if (r.type !== D.T.PTR || r.name.startsWith('_services.') || !r.name.startsWith('_')) continue;
    const srv = get(r.data, D.T.SRV)[0]?.data;
    const txt = Object.assign({}, ...get(r.data, D.T.TXT).map((t) => t.data));
    const host = srv?.target || null;
    const address = (host && get(host, D.T.A)[0]?.data) || get(r.data, D.T.SRV)[0]?.from || r.from;
    const type = r.name.replace(/\.local$/, '');
    out.push({ type, instance: r.data.slice(0, r.data.length - r.name.length - 1), host, port: srv?.port ?? null, txt, address });
  }
  // the same instance can arrive through several answers
  const seen = new Set();
  return out.filter((s) => { const k = s.type + '|' + s.instance + '|' + s.address; if (seen.has(k)) return false; seen.add(k); return true; });
}

// --- SSDP / UPnP -----------------------------------------------------------------------------
/** M-SEARCH, then fetch each device's description. Returns [{ address, location, server, st, usn, desc }]. */
export async function ssdp({ ms = 3000, log = () => {} } = {}) {
  const found = new Map(); // location -> entry
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('error', (e) => log(`ssdp: ${e.message}`));
  s.on('message', (m, r) => {
    const text = m.toString('utf8');
    if (!/^HTTP\/1\.1 200/i.test(text) && !/^NOTIFY/i.test(text)) return;
    const h = {};
    for (const line of text.split(/\r?\n/).slice(1)) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
    const location = h.location;
    if (!location) return;
    const e = found.get(location) || { address: r.address, location, server: h.server || '', sts: new Set(), usn: h.usn || '' };
    if (h.st || h.nt) e.sts.add(h.st || h.nt);
    found.set(location, e);
  });
  await new Promise((res) => s.bind(0, res));
  const search = (st) => Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
  for (let i = 0; i < 2; i++) {
    for (const st of ['ssdp:all', 'upnp:rootdevice', 'roku:ecp', 'urn:dial-multiscreen-org:service:dial:1']) s.send(search(st), 1900, SSDP, () => {});
    await wait(i ? ms - 600 : 600);
  }
  try { s.close(); } catch {}
  const list = [...found.values()].map((e) => ({ ...e, sts: [...e.sts] }));
  await Promise.all(list.map(async (e) => { e.desc = await description(e.location).catch(() => null); }));
  return list;
}

const tag = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</`, 'i'))?.[1]?.trim()
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") || null;

/** The fields of a UPnP description that say what a device is. */
export async function description(location) {
  const r = await request(location, { ms: 2500 });
  if (r.status !== 200) return null;
  const xml = r.text.slice(0, 200_000);
  const services = [...xml.matchAll(/<serviceType>([^<]+)<\/serviceType>/g)].map((m) => m[1]);
  return {
    friendlyName: tag(xml, 'friendlyName'), manufacturer: tag(xml, 'manufacturer'), modelName: tag(xml, 'modelName'),
    modelNumber: tag(xml, 'modelNumber'), modelDescription: tag(xml, 'modelDescription'), deviceType: tag(xml, 'deviceType'),
    serialNumber: tag(xml, 'serialNumber') || tag(xml, 'serialNum'), udn: tag(xml, 'UDN'), mac: tag(xml, 'MACAddress'),
    roomName: tag(xml, 'roomName'), services: [...new Set(services)].slice(0, 30),
  };
}

// --- TCP ---------------------------------------------------------------------------------------
/** 'open', 'closed' (refused: the host is there) or null (nothing answered in time). */
export function tcp(host, port, ms = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(null));
    s.on('connect', () => done('open'));
    s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'closed' : null));
  });
}

async function pool(items, n, f) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

/** Hosts on the subnet that answer at all (open or refused) on a few common ports. */
export async function sweep(net_ = localNet(), { ports = [80, 443, 62078, 8080], ms = 500, concurrency = 96 } = {}) {
  if (!net_) return [];
  const alive = new Set();
  const jobs = hostsOf(net_).flatMap((h) => ports.map((p) => [h, p]));
  await pool(jobs, concurrency, async ([h, p]) => { if (alive.has(h)) return; if (await tcp(h, p, ms)) alive.add(h); });
  return [...alive];
}

/** Ports that say what a device is. Probed on every host found. */
export const PORTS = {
  22: 'ssh', 80: 'http', 443: 'https', 445: 'smb', 554: 'rtsp', 631: 'ipp', 1400: 'sonos', 1883: 'mqtt', 1900: 'upnp',
  3000: 'lg-webos', 3001: 'lg-webos-tls', 5000: 'http-alt', 5357: 'wsd', 6053: 'esphome', 6466: 'androidtv-remote',
  7000: 'airplay', 8001: 'samsung-tv', 8002: 'samsung-tv-tls', 8008: 'cast', 8009: 'cast-tls', 8060: 'roku-ecp',
  8080: 'http-alt', 8123: 'home-assistant', 8443: 'https-alt', 9100: 'jetdirect', 9999: 'kasa', 55443: 'yeelight', 62078: 'apple-lockdown',
};

export async function probe(hosts, { ms = 700, concurrency = 64 } = {}) {
  const res = {};
  const jobs = hosts.flatMap((h) => Object.keys(PORTS).map((p) => [h, Number(p)]));
  await pool(jobs, concurrency, async ([h, p]) => { if ((await tcp(h, p, ms)) === 'open') (res[h] ||= []).push(p); });
  for (const h of Object.keys(res)) res[h].sort((a, b) => a - b);
  return res;
}

// --- ARP / names ----------------------------------------------------------------------------
/** { ip: mac } from the neighbor table, where this process may read it. */
export async function neighbors() {
  const out = {};
  const add = (ip, mac) => { if (mac && !/^(00:00:00:00:00:00|ff:ff:ff:ff:ff:ff)$/i.test(mac)) out[ip] = mac.toLowerCase().replace(/\b(\w)\b/g, '0$1'); };
  try {
    for (const l of fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1)) { const c = l.trim().split(/\s+/); if (c.length >= 4 && c[2] !== '0x0') add(c[0], c[3]); }
    return { table: out, source: 'proc' };
  } catch {}
  const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 3000 }, (e, so) => r(e ? null : so)));
  const ipn = await run('ip', ['neigh']);
  if (ipn) { for (const l of ipn.split('\n')) { const m = l.match(/^(\d+\.\d+\.\d+\.\d+) .*lladdr (\S+)/); if (m) add(m[1], m[2]); } return { table: out, source: 'ip' }; }
  const arp = await run('arp', ['-an']);
  if (arp) { for (const l of arp.split('\n')) { const m = l.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/i); if (m) add(m[1], m[2]); } return { table: out, source: 'arp' }; }
  return { table: out, source: null };
}

/** Reverse DNS at the router (home routers name DHCP clients: "Sams-iPhone"). */
export async function names(hosts, gateway) {
  const r = new dns.promises.Resolver({ timeout: 800, tries: 1 });
  try { r.setServers([gateway]); } catch { return {}; }
  const out = {};
  await pool(hosts, 16, async (h) => {
    try { const n = (await r.reverse(h))[0]; if (n) out[h] = n.replace(/\.(local|lan|home|domain|localdomain|hsd1\.[a-z]{2}\.comcast\.net)\.?$/i, ''); } catch {}
  });
  return out;
}
