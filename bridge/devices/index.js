// The devices in the house: found on the display's own Wi-Fi and over Bluetooth (bluetooth.js, through the shell),
// identified, and used directly over their local APIs. No cloud hub. Scans happen only when asked (a person, or the agent).
//
//   GET  /devices                  what was found last time   {scannedAt, scanning, devices}
//   POST /devices/scan             look again (about 10 s)
//   POST /devices/action           {device, action, params}   risky actions ask the room first
//   POST /devices/recipe           {recipe, device?} saves one; {remove: id} forgets one
//   POST /mcp/home                 the same, as MCP tools for the agent (bearer token)
// All of these answer only to this device itself (loopback).
//
// Saved in display/devices.json: the devices, the recipes the agent wrote, and pairings (TV tokens).
import fs from 'node:fs';
import { readJson, writeJson, unsaved } from '../store.js';
import { registered } from '../stores.js';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as find from './discover.js';
import { pins as netPins } from './net.js';
import { host } from '../host.js';
import { asData } from '../as-data.js';
import * as R from './recipe.js';
import roku from './drivers/roku.js';
import samsung from './drivers/samsung.js';
import sonos from './drivers/sonos.js';
import ipp from './drivers/ipp.js';
import xbox from './drivers/xbox.js';
import lg from './drivers/lg.js';
import bluetooth, { btClient, toDevice, lookInside, uuid as bleUuid } from './bluetooth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVERS = [roku, samsung, lg, sonos, ipp, xbox, bluetooth];
const log = (...a) => console.log('[devices]', ...a);

// --- MAC makers ---------------------------------------------------------------------------------
let oui = null;
export function vendor(mac) {
  if (!mac) return null;
  if (!oui) {
    oui = new Map();
    // The APK's packager unzips .gz assets (and drops the extension), so on the tablet it's oui.txt.
    let text = '';
    try { text = zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'oui.txt.gz'))).toString(); } catch { try { text = fs.readFileSync(path.join(HERE, 'oui.txt'), 'utf8'); } catch {} }
    for (const l of text.split('\n')) { const i = l.indexOf('\t'); if (i > 0) oui.set(l.slice(0, i), l.slice(i + 1)); }
  }
  const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (parseInt(hex[1], 16) & 2) return null; // locally administered (a private, random address)
  return oui.get(hex.slice(0, 6)) || null;
}

// --- what a device probably is, when no driver or recipe knows it -----------------------------
const APPLE = { Mac: 'computer', MacBook: 'computer', iMac: 'computer', AppleTV: 'streamer', AudioAccessory: 'speaker', iPhone: 'phone', iPad: 'tablet' };
function guess(ev, me) {
  const types = new Set(ev.mdns.map((s) => s.type));
  const txt = (t) => ev.mdns.find((s) => s.type === t)?.txt || {};
  const inst = (t) => ev.mdns.find((s) => s.type === t)?.instance;
  const g = { name: null, kind: 'other', maker: null, model: null, notes: [] };
  if (ev.address === me) return { ...g, name: 'This display', kind: 'display', model: txt('_adb-tls-connect._tcp').name || null, self: true };
  const am = txt('_raop._tcp').am || txt('_airplay._tcp').model || txt('_device-info._tcp').model;
  if (am && /^(Mac|MacBook|iMac|AppleTV|AudioAccessory|iPhone|iPad)/.test(am)) {
    const fam = am.match(/^[A-Za-z]+/)[0];
    return { ...g, name: inst('_airplay._tcp') || inst('_companion-link._tcp'), kind: APPLE[fam] || 'other', maker: 'Apple', model: am };
  }
  if (types.has('_googlecast._tcp')) { const t = txt('_googlecast._tcp'); return { ...g, name: t.fn || null, kind: /speaker|nest audio|home mini/i.test(t.md || '') ? 'speaker' : 'tv', maker: 'Google Cast', model: t.md || null, notes: ['Google Cast: control needs the Cast protocol, not built in yet.'] }; }
  if (types.has('_companion-link._tcp')) return { ...g, name: inst('_companion-link._tcp'), kind: 'other', maker: 'Apple' };
  if (types.has('_adb-tls-connect._tcp')) return { ...g, kind: 'tablet', maker: 'Android', model: txt('_adb-tls-connect._tcp').name || null, notes: ['An Android device with wireless debugging on.'] };
  const host = (ev.hostname || '').toLowerCase();
  const cap = (w) => w.replace(/^\w/, (c) => c.toUpperCase());
  if (/dishwasher|washer|dryer|oven|fridge|refrigerator|range|hood/.test(host)) return { ...g, name: cap(ev.hostname.replace(/-\d{6,}$/, '').replace(/-/g, ' ')), kind: 'appliance', maker: cap(host.split('-')[0]) };
  if (/^gemodule/.test(host)) return { ...g, name: 'GE appliance', kind: 'appliance', maker: 'GE Appliances', notes: ['A GE appliance’s Wi-Fi module. It talks to GE’s cloud (SmartHQ); there is no local API openhouse knows.'] };
  if (/^emporia/.test(host)) return { ...g, name: 'Emporia', kind: 'sensor', maker: 'Emporia', notes: ['An Emporia energy device (monitor, plug or charger). It talks to Emporia’s cloud; there is no local API openhouse knows.'] };
  if (/ipad/.test(host)) return { ...g, kind: 'tablet', maker: 'Apple' };
  if (/iphone/.test(host)) return { ...g, kind: 'phone', maker: 'Apple' };
  if (/macbook|imac|mac-?mini/.test(host)) return { ...g, kind: 'computer', maker: 'Apple' };
  if (/galaxy|android|pixel/.test(host)) return { ...g, kind: /tab/.test(host) ? 'tablet' : 'phone', maker: /galaxy/.test(host) ? 'Samsung' : null };
  const winUpnp = ev.ssdp.find((s) => /Microsoft-Windows/i.test(s.server));
  if (winUpnp && !/xbox/i.test(winUpnp.desc?.modelName || '')) return { ...g, name: winUpnp.desc?.friendlyName, kind: 'computer', maker: 'Microsoft' };
  if (/gateway|router|docsis|modem/i.test(host) || /\.1$/.test(ev.address) && ev.ports.some((p) => p === 80 || p === 443)) return { ...g, name: ev.hostname || 'Router', kind: 'router' };
  if (ev.ports.includes(62078)) return { ...g, kind: 'phone', maker: 'Apple', notes: ['An iPhone or iPad (it answers on Apple’s sync port).'] };
  if (ev.ports.includes(554)) return { ...g, kind: 'camera' };
  if (ev.ports.includes(9100) || types.has('_printer._tcp')) return { ...g, kind: 'printer' };
  if (types.has('_hue._tcp')) return { ...g, kind: 'hub', maker: 'Philips Hue', notes: ['A Hue Bridge: needs its link button pressed to pair (not built in yet).'] };
  if (types.has('_shelly._tcp')) return { ...g, kind: 'plug', maker: 'Shelly' };
  if (types.has('_esphomelib._tcp')) return { ...g, kind: 'sensor', maker: 'ESPHome' };
  if (types.has('_wled._tcp')) return { ...g, kind: 'light', maker: 'WLED' };
  const up = ev.ssdp.find((s) => s.desc?.manufacturer);
  if (up) return { ...g, name: up.desc.friendlyName, maker: up.desc.manufacturer, model: up.desc.modelName };
  return g;
}

// --- the store ----------------------------------------------------------------------------------
export function devicesRoutes({ HERE: BRIDGE, json, body }) {
  const FILE = registered('devices', path.resolve(process.env.DEVICES_FILE || path.join(BRIDGE, '../devices.json')));
  const MCP_FILE = path.join(path.dirname(FILE), 'home-mcp.json');
  const PORT = Number(process.env.PORT || 8787);
  let db = { scannedAt: null, devices: [], recipes: {}, pairing: {}, certs: {} };
  db = { ...db, ...readJson(FILE, {}) };
  // A save that's refused or fails throws (marked unsaved: store.js unsaved says what to answer). A change someone asked
  // for (a recipe, a name, a yes) is taken back in memory too (before), so what shows is what's on disk; what a scan or
  // a connection learned is kept in memory all the same (kept).
  const save = (before) => {
    try { writeJson(FILE, db, { space: 1 }); }
    catch (e) { if (before) db = before; log(`devices not saved: ${e.message}`); throw Object.assign(e, { unsaved: true }); }
  };
  const kept = () => { try { save(); } catch {} };
  // Each device's own certificate, kept for its address (net.js checkPin).
  db.certs ||= {};
  Object.assign(netPins, { get: (where) => db.certs[where] || null, set: (where, fp) => { db.certs[where] = fp; kept(); } });

  // The agent's MCP config (Claude Code reads it with --mcp-config; Codex gets the same through -c).
  const token = crypto.randomBytes(18).toString('hex');
  const mcpUrl = `http://127.0.0.1:${PORT}/mcp/home`;
  try { fs.writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { home: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)); } catch {}
  process.env.HOME_MCP_CONFIG = MCP_FILE; process.env.HOME_MCP_URL = mcpUrl; process.env.HOME_MCP_TOKEN = token;

  // The shell: its "Is this OK?" card, its status pill, and the Wi-Fi multicast lock.
  const shell = (p, b, ms = 3000) => host.json(p, b, ms);
  const approve = async (title, detail, extra = {}) => (await shell('/approve', { ...extra, title, detail }, 100_000))?.yes === true;
  const say = (text) => { log(text); shell('/say', { text }); };
  const bt = btClient(shell);
  // Every device action, and what came of it, in the speech log (voice.js), like Opie's taps in other apps.
  const speechLog = (data) => { try { globalThis.openhouseSpeechLog?.('device-action', data); } catch {} };
  let btState = null; // {supported, on}: whether to offer Bluetooth at all (the shell's answer; null on a laptop)
  const checkBt = async () => { btState = await bt.state().catch(() => null); return btState; };
  checkBt(); setTimeout(checkBt, 30_000); // the shell may come up after the bridge

  const pub = (d) => ({ id: d.id, name: d.customName || d.name, kind: d.kind, maker: d.maker, model: d.model, address: d.address, mac: d.mac, vendor: d.vendor,
    room: d.room, os: d.os, driver: d.driver, recipe: d.recipe, actions: actionsOf(d).map((a) => a.name), transport: d.transport || 'wifi',
    ...(d.transport === 'bluetooth' ? { bonded: !!d.evidence?.bt?.bonded } : {}),
    allowed: !!db.pairing[d.id]?.allowed,
    simple: actionsOf(d).filter((a) => !Object.values(a.params).some((p) => p.required)).map((a) => a.name), present: d.present, self: !!d.self,
    paired: d.driver === 'samsung-tv' ? !!db.pairing[d.id]?.token : d.driver === 'lg-webos' ? !!db.pairing[d.id]?.clientKey : undefined, notes: d.notes, lastSeen: d.lastSeen });

  function actionsOf(d) {
    const drv = DRIVERS.find((x) => x.id === d.driver);
    const own = drv ? Object.entries(drv.actionsFor ? drv.actionsFor(d) : drv.actions).map(([name, a]) => ({ name, says: a.says, params: a.params || {}, risky: !!a.risky, boardOk: !!a.boardOk, run: (dev, p, ctx) => a.run(dev, p, ctx) })) : [];
    // A recipe adds to a Bluetooth device's standard actions (a lamp's own commands beside its battery); a Wi-Fi driver needs none.
    const rec = (!drv || drv.id === 'bluetooth') ? db.recipes[d.recipe] : null;
    const taught = rec ? Object.entries(rec.actions).filter(([name]) => !own.some((a) => a.name === name))
      .map(([name, a]) => ({ name, says: a.says, params: a.params || {}, risky: R.isRisky(name, a), recipe: true, run: (dev, p) => R.run(rec, name, dev.address, p, { bt }) })) : [];
    return [...own, ...taught];
  }
  const ctxFor = (d) => ({ pairing: (db.pairing[d.id] ||= {}), save, say, bt });
  const asDriverInput = (d) => ({ ...d, ...d.evidence, mdnsTxt: Object.assign({}, ...(d.evidence?.mdns || []).filter((s) => /^_ipps?\._tcp$/.test(s.type)).map((s) => s.txt)) });

  // --- scanning ---
  let scanning = null;
  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const t0 = Date.now();
      const lan = process.env.DEVICES_NO_WIFI ? null : find.localNet(); // (tests: Bluetooth alone)
      // Bluetooth looks at the same time (about 8 s), through the shell; a laptop or a tablet without it just finds none.
      const blue = (btState?.supported !== false ? bt.scan(8000) : Promise.resolve([])).catch((e) => { log('bluetooth scan:', e.message); return []; });
      if (!lan) {
        const btFound = await btDevices(await blue);
        if (!btFound.length) throw new Error('This display is not on a Wi-Fi network.');
        return merge(btFound, new Date().toISOString(), { ms: { total: Date.now() - t0 }, bluetooth: btFound.length });
      }
      await shell('/multicast', { ms: 20000 }); // Android drops multicast when the screen sleeps unless an app holds this
      const [mdns, ssdp, swept] = await Promise.all([find.mdns({ log }), find.ssdp({ log }), find.sweep(lan)]);
      const evidence = new Map();
      const ev = (ip) => { if (!evidence.has(ip)) evidence.set(ip, { address: ip, mdns: [], ssdp: [], ports: [], mac: null, hostname: null }); return evidence.get(ip); };
      for (const s of mdns) if (/^\d+\.\d+\.\d+\.\d+$/.test(s.address || '')) ev(s.address).mdns.push(s);
      for (const s of ssdp) ev(s.address).ssdp.push(s);
      for (const ip of swept) ev(ip);
      const hosts = [...evidence.keys()];
      const gw = lan.address.replace(/\.\d+$/, '.1');
      const [ports, arp, names] = await Promise.all([find.probe(hosts), find.neighbors(), find.names(hosts, gw)]);
      for (const [ip, e] of evidence) { e.ports = ports[ip] || []; e.mac = arp.table[ip] || null; e.hostname = names[ip] || null; }
      for (const s of ssdp) { const m = s.desc?.mac; if (m) ev(s.address).mac ||= m.toLowerCase(); }
      const timings = { discover: Date.now() - t0 };

      const now = new Date().toISOString();
      const found = await Promise.all([...evidence.values()].map((e) => identify(e, lan.address).catch((err) => { log('identify', e.address, err.message); return null; })));
      const btFound = await btDevices(await blue);
      const fresh = [...found.filter(Boolean), ...btFound];
      timings.total = Date.now() - t0;
      return merge(fresh, now, { ms: timings, arp: arp.source, hosts: hosts.length, mdnsServices: mdns.length, upnp: ssdp.length, bluetooth: btFound.length });
    })().finally(() => { scanning = null; });
    return scanning;
  }
  /** Bluetooth devices from the shell's scan: with a recipe that knows them, if one does. */
  async function btDevices(raw) {
    const out = [];
    for (const b of raw) {
      const d = toDevice(b);
      if (!d) continue;
      const prev = db.devices.find((x) => x.id === d.id);
      if (prev?.evidence?.bt?.gatt) d.evidence.bt.gatt = prev.evidence.bt.gatt; // what it was found to have inside
      for (const r of Object.values(db.recipes)) if (r.over === 'bluetooth' && await R.matches(r, d).catch(() => false)) { Object.assign(d, { recipe: r.id, kind: r.kind, maker: r.maker || d.maker }); break; }
      d.actions = actionsOf(d).map((a) => a.name);
      out.push(d);
    }
    return out;
  }
  function merge(fresh, now, lastScan) {
      const t0 = Date.now();
      // Keep what was known: a name someone gave it, its first sighting; mark the ones gone.
      const old = new Map(db.devices.map((d) => [d.id, d]));
      const byAddr = new Map(db.devices.map((d) => [d.address, d]));
      const next = fresh.map((d) => {
        const prev = old.get(d.id) || (byAddr.get(d.address)?.id.startsWith('ip-') ? byAddr.get(d.address) : null);
        if (prev && prev.id !== d.id && db.pairing[prev.id]) { db.pairing[d.id] = db.pairing[prev.id]; delete db.pairing[prev.id]; }
        return { ...d, customName: prev?.customName, recipe: d.recipe || prev?.recipe || null, firstSeen: prev?.firstSeen || now, lastSeen: now, present: true };
      });
      const seen = new Set(next.map((d) => d.id));
      // Gone ones stay listed as not seen, except Bluetooth ones that were never paired (a passer-by's headphones).
      for (const d of db.devices) if (!seen.has(d.id) && !(d.id.startsWith('ip-') && next.some((n) => n.address === d.address)) && !(d.transport === 'bluetooth' && !d.evidence?.bt?.bonded)) next.push({ ...d, present: false });
      next.sort((a, b) => (b.present - a.present) || rank(a) - rank(b) || a.address.localeCompare(b.address, undefined, { numeric: true }));
      db.devices = next; db.scannedAt = now;
      db.lastScan = lastScan;
      kept();
      log(`scan: ${fresh.length} devices (${lastScan.bluetooth || 0} Bluetooth) in ${lastScan.ms.total} ms (discovery ${lastScan.ms.discover ?? '-'} ms; arp: ${lastScan.arp || 'not readable'}; merged in ${Date.now() - t0} ms)`);
      return db;
  }
  const RANK = ['tv', 'streamer', 'speaker', 'headphones', 'light', 'plug', 'switch', 'console', 'printer', 'thermostat', 'lock', 'camera', 'blinds', 'fan', 'appliance', 'sensor', 'tag', 'toy', 'watch', 'input', 'hub', 'computer', 'phone', 'tablet', 'display', 'router', 'other'];
  const rank = (d) => (d.actions?.length ? 0 : 100) + RANK.indexOf(d.kind);

  async function identify(e, me) {
    const base = { address: e.address, evidence: { mdns: e.mdns, ssdp: e.ssdp, ports: e.ports }, hostname: e.hostname, mac: e.mac };
    const input = asDriverInput(base);
    let rec = { ...base, driver: null, recipe: null };
    const drv = DRIVERS.find((x) => { try { return x.match(input); } catch { return false; } });
    if (drv && e.address !== me) {
      const tmpId = idOf(e);
      try { Object.assign(rec, await drv.identify(input, ctxFor({ id: tmpId })), { driver: drv.id }); }
      catch (err) { log(`${drv.id} identify ${e.address}: ${err.message}`); }
    }
    if (!rec.driver) {
      for (const r of Object.values(db.recipes)) {
        if (await R.matches(r, input).catch(() => false)) {
          Object.assign(rec, { name: r.name, kind: r.kind, maker: r.maker || null, recipe: r.id, notes: r.notes || [] }, await R.identify(r, e.address));
          break;
        }
      }
    }
    if (!rec.driver && !rec.recipe) Object.assign(rec, guess(e, me));
    rec.mac = (rec.mac || e.mac || '').toLowerCase() || null;
    rec.vendor = vendor(rec.mac);
    rec.name ||= e.hostname || (rec.vendor ? `${rec.vendor} device` : `Device at ${e.address}`);
    rec.kind ||= 'other';
    rec.notes = rec.notes || [];
    rec.id = idOf({ ...e, mac: rec.mac, serial: rec.serial });
    const tmp = idOf(e); // what the driver saw while identifying; keep anything it paired under that
    if (tmp !== rec.id && db.pairing[tmp]) { db.pairing[rec.id] = { ...db.pairing[tmp], ...db.pairing[rec.id] }; delete db.pairing[tmp]; }
    rec.actions = actionsOf(rec).map((a) => a.name);
    return rec;
  }
  function idOf(e) {
    if (e.mac) return 'mac-' + e.mac.toLowerCase().replace(/[^0-9a-f]/g, '');
    const udn = e.ssdp?.find((s) => s.desc?.udn)?.desc.udn || e.mdns?.find((s) => s.txt?.uuid)?.txt.uuid;
    if (udn) return 'uuid-' + udn.replace(/^uuid:/, '').toLowerCase().replace(/[^0-9a-z-]/g, '').slice(0, 40);
    return 'ip-' + e.address;
  }

  /** A device by id, address or name ("tv", "the frame", "sonos", "living room"). */
  function lookup(q) {
    const s = String(q || '').toLowerCase().replace(/^the /, '').trim();
    if (!s) return null;
    const list = db.devices;
    const exact = list.find((d) => d.id === s || d.address === s || (d.customName || d.name || '').toLowerCase() === s);
    if (exact) return exact;
    const words = s.split(/\s+/);
    const score = (d) => {
      const hay = [d.customName, d.name, d.model, d.maker, d.room, d.kind, d.kind === 'tv' ? 'television' : '', d.kind === 'speaker' ? 'music' : ''].join(' ').toLowerCase();
      return words.filter((w) => hay.includes(w)).length + (d.present ? 0.5 : 0) + (actionsOf(d).length ? 0.25 : 0);
    };
    const best = list.map((d) => [score(d), d]).filter(([n]) => n >= 1).sort((a, b) => b[0] - a[0]);
    return best[0]?.[1] || null;
  }

  // Progress lines ("Talking to the TV") name devices the way the family does.
  globalThis.openhouseDeviceName = (q) => { const d = lookup(q); return d ? d.customName || d.name : null; };

  // --- doing things ---
  const busy = new Map(); // device id -> promise (one action at a time per device)
  async function act(q, action, params = {}, { who = 'agent', app = null } = {}) {
    const d = lookup(q);
    if (!d) return { ok: false, text: `No device matches "${q}". ${db.devices.length ? 'Known: ' + db.devices.filter((x) => x.present).map((x) => x.customName || x.name).join(', ') : 'Nothing found yet: scan first.'}` };
    const list = actionsOf(d);
    const a = list.find((x) => x.name === action);
    if (!a) return { ok: false, text: list.length ? `${d.customName || d.name} can't "${action}". It can: ${list.map((x) => x.name).join(', ')}.` : `openhouse doesn't know how to control ${d.customName || d.name} (${d.model || d.kind}) yet. A recipe can teach it (save_recipe).` };
    if (app && !appMay(d, a)) return { ok: false, text: `Apps can't "${action}" a device: that stays with the people here and Opie.` };
    const p = R.checkParams(a.params, params);
    if (p.error) return { ok: false, text: p.error };
    const label = d.customName || d.name;
    if (app) who = `app:${app.id}`; // (never 'board': an app's call is not a person's tap)
    // The first change to a device asks the people here once, and the answer is kept with it (Lamp's way): reading
    // one (what it is, what's on) never asks. Risky actions (turning on, opening an app) still ask every time.
    // An app (forApp, below) asks for itself: the assistant's yes isn't its yes, and its yes isn't the assistant's.
    const reads = /^(status|apps|info|state|now_playing|volume)$/.test(action);
    const pairing = db.pairing[d.id] ||= {};
    const allowedHere = app ? !!pairing.apps?.[app.id] : pairing.allowed === true;
    const ask = async (title, detail, extra) => {
      if (!app) return approve(title, detail, extra);
      if (asking.has(app.id)) return false; // one card at a time from an app
      asking.add(app.id);
      try { return await approve(title, detail, extra); } finally { asking.delete(app.id); }
    };
    if (!reads && !a.risky && !allowedHere && who !== 'board') { // a person's own tap on the tablet is their yes
      say(`Waiting for a yes: ${label}`);
      const detail = app ? 'Play, pause and the volume. It asks before turning anything on.'
        : d.transport === 'bluetooth' ? 'Sound, volume and its own buttons. It asks before turning anything on.'
        : 'Off, pause and the volume. It asks before turning it on.';
      if (!(await ask(app ? `Let ${app.name} control ${label}?` : `Let the assistant control ${label}?`, detail))) {
        log(`${who}: ${label} ${action} — not allowed`); speechLog({ who, device: label, action, ok: false, text: 'not allowed' });
        return { ok: false, text: `The people here didn't allow controlling ${label} (or didn't answer). Don't try again; tell them it wasn't done.` };
      }
      if (app) (pairing.apps ||= {})[app.id] = new Date().toISOString();
      else { pairing.allowed = true; pairing.allowedAt = new Date().toISOString(); }
      kept(); // (not saved: the yes holds until a restart, then it's asked again)
    }
    if (a.risky && !(a.boardOk && who === 'board')) { // (a person's own tap on Pair is their yes)
      const what = `${a.says.replace(/\.$/, '')}${Object.keys(p.values).length ? ` (${Object.entries(p.values).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}`;
      say(`Waiting for a yes: ${label}`);
      const [title, detail] = d.transport === 'bluetooth' && action === 'pair' ? [`Pair ${label} with the device?`, 'The device may show a code to check.']
        : [`${label}: ${what}?`, [app ? `${app.name} asks.` : '', d.room ? `${d.model || ''} in ${d.room}`.trim() : d.model || ''].filter(Boolean).join(' ')];
      if (!(await ask(title, detail, d.transport === 'bluetooth' && action === 'pair' ? { yes: 'Pair' } : {}))) {
        log(`${who}: ${label} ${action} — not approved`); speechLog({ who, device: label, action, ok: false, text: 'not approved' });
        return { ok: false, text: `The people here said no (or didn't answer) to "${a.says}" on ${label}. Don't try again; tell them it wasn't done.` };
      }
    }
    if (action === 'pair') for (const k of Object.keys(db.certs)) if (k.startsWith(d.address + ':')) delete db.certs[k]; // pairing again: a new certificate is fine
    while (busy.get(d.id)) await busy.get(d.id).catch(() => {});
    const t0 = Date.now();
    const job = (async () => a.run(asDriverInput(d), p.values, ctxFor(d)))();
    busy.set(d.id, job);
    try {
      const result = await job;
      log(`${who}: ${label} ${action} ok in ${Date.now() - t0} ms`);
      if (!reads) speechLog({ who, device: label, action, params: p.values, ok: true, text: (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 240) });
      return { ok: true, device: label, result, text: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (e) {
      log(`${who}: ${label} ${action} failed in ${Date.now() - t0} ms: ${e.message}`);
      speechLog({ who, device: label, action, params: p.values, ok: false, text: e.message.slice(0, 240) });
      const gone = /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timed out|ENETUNREACH/.test(e.message);
      return { ok: false, text: gone ? `${label} isn't answering at ${d.address}. It may be off, or have moved: scan again.` : e.message };
    } finally { busy.delete(d.id); }
  }

  // --- the TV, in a few words (the voice's "tv" tool: docs/phones-and-tv.md) ---
  // What someone says ("turn off the TV", "pause it", "put Netflix on") -> the TV's own action, whichever maker.
  const TV_DO = {
    off: ['power_off'], on: ['power_on'], status: ['status'], mute: ['mute'],
    volume_up: ['volume_up'], volume_down: ['volume_down'],
    pause: ['pause', ['press', { button: 'pause' }], ['press', { button: 'play_pause' }]],
    play: ['play', ['press', { button: 'play' }], ['press', { button: 'play_pause' }]],
    open_app: ['launch'],
  };
  /** The TVs openhouse can control (a driver or recipe with actions), the ones seen at the last scan first. */
  const tvs = () => db.devices.filter((d) => (d.kind === 'tv' || d.kind === 'streamer') && !d.self && actionsOf(d).length).sort((a, b) => (b.present ? 1 : 0) - (a.present ? 1 : 0));
  async function tv({ do: what, app, tv: which, steps } = {}, opts = {}) {
    const list = tvs();
    if (!list.length) return { ok: false, text: db.scannedAt ? "There's no TV openhouse can control. Someone can look for one in Settings > Devices." : 'No devices have been looked for yet (Settings > Devices).' };
    let d = which ? lookup(which) : null;
    if (which && !d) return { ok: false, text: `No TV called "${which}". The TVs: ${list.map((x) => x.customName || x.name).join(', ')}.` };
    if (!d) {
      const here = list.filter((x) => x.present);
      if (here.length > 1) return { ok: false, text: `Which TV? ${here.map((x) => x.customName || x.name).join(' or ')}.` };
      d = here[0] || list[0];
    }
    const ways = TV_DO[what];
    if (!ways) return { ok: false, text: `The TV tool can: ${Object.keys(TV_DO).join(', ')}.` };
    const have = new Map(actionsOf(d).map((a) => [a.name, a]));
    for (const w of ways) {
      const [name, fixed] = Array.isArray(w) ? w : [w, {}];
      const a = have.get(name);
      if (!a) continue;
      if (fixed.button && a.params.button?.enum && !a.params.button.enum.includes(fixed.button)) continue;
      const params = { ...fixed };
      if (name === 'launch') { if (!app) return { ok: false, text: 'Which app?' }; params.app = String(app); }
      if (steps && a.params.steps) params.steps = Math.max(1, Math.min(10, Number(steps) || 1));
      return act(d.id, name, params, opts);
    }
    return { ok: false, text: `${d.customName || d.name} can't ${what.replace('_', ' ')} from here.` };
  }

  function saveRecipe(recipe, deviceQ) {
    const errs = R.validate(recipe);
    if (errs.length) return { ok: false, text: `The recipe isn't valid yet:\n- ${errs.slice(0, 20).join('\n- ')}` };
    if (Object.values(db.recipes).length >= 50 && !db.recipes[recipe.id]) return { ok: false, text: 'There are already 50 recipes.' };
    const before = structuredClone(db);
    db.recipes[recipe.id] = { ...recipe, savedAt: new Date().toISOString() };
    let bound = null;
    if (deviceQ) {
      const d = lookup(deviceQ);
      const only = (text) => { try { save(before); } catch (e) { return { ok: false, text: unsaved(e).error }; } return { ok: false, text }; }; // (the recipe is saved on its own)
      if (!d) return only(`Saved the recipe, but no device matches "${deviceQ}".`);
      if ((recipe.over === 'bluetooth') !== (d.transport === 'bluetooth')) return only(`Saved the recipe, but ${d.name} is a ${d.transport === 'bluetooth' ? 'Bluetooth' : 'Wi-Fi'} device: its recipe needs "over": "${d.transport === 'bluetooth' ? 'bluetooth' : 'wifi'}".`);
      if (d.driver && d.driver !== 'bluetooth') return only(`${d.name} already has a built-in driver (${d.driver}); a recipe isn't needed.`);
      Object.assign(d, { recipe: recipe.id, kind: recipe.kind, maker: recipe.maker || d.maker, name: d.customName ? d.name : recipe.name });
      d.actions = actionsOf(d).map((a) => a.name);
      bound = d;
    }
    try { save(before); } catch (e) { return { ok: false, text: unsaved(e).error }; }
    return { ok: true, text: `Saved recipe "${recipe.id}"${bound ? ` for ${bound.customName || bound.name} (${bound.address}). Try one of its actions now with device_action` : '. It applies to devices that match its find rules at the next scan'}.` };
  }

  function removeRecipe(id) {
    if (!db.recipes[id]) return { ok: false, text: `No recipe "${id}". Recipes: ${Object.keys(db.recipes).join(', ') || 'none'}.` };
    const before = structuredClone(db);
    delete db.recipes[id];
    // its devices go back to what a scan would make of them
    for (const d of db.devices) if (d.recipe === id) {
      if (d.transport === 'bluetooth') { const fresh = toDevice({ ...d.evidence.bt, mac: d.mac, name: d.name, bonded: d.evidence.bt.bonded }); Object.assign(d, { recipe: null, kind: fresh?.kind || 'other' }); d.actions = actionsOf(d).map((a) => a.name); }
      else Object.assign(d, { recipe: null, actions: [], name: d.hostname || `Device at ${d.address}`, kind: 'other' });
    }
    try { save(before); } catch (e) { return { ok: false, text: unsaved(e).error }; }
    return { ok: true, text: `Removed recipe "${id}". Scan again to see its devices as they are.` };
  }

  function rename(q, name) {
    const d = lookup(q);
    if (!d) return { ok: false, text: `No device matches "${q}".` };
    const n = String(name || '').trim().slice(0, 40), before = structuredClone(db);
    d.customName = n || undefined;
    try { save(before); } catch (e) { return { ok: false, text: unsaved(e).error }; }
    return { ok: true, text: n ? `${d.name} is now called "${n}".` : `${d.name} has its own name again.` };
  }

  // --- words for people and for the agent ---
  // A device's name, model and records are its own words (or whoever set it up), read off the network: marked as data.
  const OWN_WORDS = "the devices found, with their names, models and records as the devices give them (or the names the family gave them)";
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 2 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  function summary(kind) {
    if (!db.scannedAt) return 'Nothing found yet: the network has not been scanned. Use scan.';
    const list = db.devices.filter((d) => !kind || d.kind === kind);
    const line = (d) => {
      const acts = actionsOf(d);
      return `- ${d.customName || d.name} [${d.id}] ${d.kind}${d.model ? `, ${d.maker && !d.model.includes(d.maker) ? d.maker + ' ' : ''}${d.model}` : d.maker ? `, ${d.maker}` : ''}` +
        `${d.room ? `, ${d.room}` : ''}, ${d.transport === 'bluetooth' ? `Bluetooth ${d.address}, ${d.evidence?.bt?.bonded ? 'paired' : 'not paired'}` : d.address}${d.present ? '' : ` (not seen at the last scan; last seen ${ago(d.lastSeen)})`}` +
        `${d.self ? ' (this display)' : ''}\n  ${acts.length ? 'can: ' + acts.map((a) => a.name + (a.risky ? '*' : '')).join(', ') : 'no control yet'}` +
        `${d.notes?.length ? `\n  ${d.notes.join(' ')}` : ''}`;
    };
    return `Scanned ${ago(db.scannedAt)}. ${list.length} devices (* = asks the people here first):\n${list.length ? asData(list.map(line).join('\n'), OWN_WORDS, { max: 30000 }) : ''}`;
  }
  async function info(q) {
    const d = lookup(q);
    if (!d) return `No device matches "${q}".`;
    if (d.transport === 'bluetooth') return btInfo(d);
    const acts = actionsOf(d).map((a) => `- ${a.name}${a.risky ? ' (asks first)' : ''}: ${a.says}${Object.keys(a.params).length ? `; params ${JSON.stringify(a.params)}` : ''}`);
    const ev = d.evidence || {};
    return asData([
      `${d.customName || d.name} (${d.id})`, `kind ${d.kind}; maker ${d.maker || '?'}; model ${d.model || '?'}; address ${d.address}; MAC ${d.mac || 'unknown'}${d.vendor ? ` (${d.vendor})` : ''}`,
      d.hostname && `name at the router: ${d.hostname}`, d.driver ? `driver: ${d.driver}` : d.recipe ? `recipe: ${d.recipe}` : 'no driver or recipe',
      `open ports: ${ev.ports?.map((p) => `${p} (${find.PORTS[p] || '?'})`).join(', ') || 'none found'}`,
      ev.mdns?.length && `Bonjour services:\n${ev.mdns.map((s) => `  ${s.type} "${s.instance}" port ${s.port} ${JSON.stringify(s.txt).slice(0, 400)}`).join('\n')}`,
      ev.ssdp?.length && `UPnP:\n${ev.ssdp.map((s) => `  ${s.location} server "${s.server}"${s.desc ? ` ${JSON.stringify({ ...s.desc, services: s.desc.services?.slice(0, 12) })}` : ''}`).join('\n')}`,
      acts.length ? `actions:\n${acts.join('\n')}` : null,
      d.notes?.length && `notes: ${d.notes.join(' ')}`,
    ].filter(Boolean).join('\n'), OWN_WORDS, { max: 30000 });
  }

  /** A Bluetooth device, for writing its recipe: what it advertised and, for a BLE one, the services inside it. */
  async function btInfo(d) {
    const b = d.evidence?.bt || {};
    let tree = b.gatt, why = null;
    if (!tree && ['le', 'dual'].includes(b.type) && d.present) { try { tree = await lookInside(d, ctxFor(d)); } catch (e) { why = e.message; } }
    const acts = actionsOf(d).map((a) => `- ${a.name}${a.risky ? ' (asks first)' : ''}: ${a.says}${Object.keys(a.params).length ? `; params ${JSON.stringify(a.params)}` : ''}`);
    return asData([
      `${d.customName || d.name} (${d.id})`, `Bluetooth ${b.type || '?'}; kind ${d.kind}; maker ${d.maker || '?'}; address ${d.mac}; ${b.bonded ? 'paired' : 'not paired'}${b.connected ? ', connected for audio' : ''}${b.rssi != null ? `; signal ${b.rssi} dBm` : ''}`,
      b.audio && `plays audio (${b.audio})`, b.makers?.length && `maker ids in its advertisement: ${b.makers.join(', ')}`,
      d.recipe ? `recipe: ${d.recipe}` : 'no recipe',
      b.services?.length && `services it advertises: ${b.services.join(', ')}`,
      tree?.length ? `inside (GATT):\n${tree.map((s) => `  service ${s.uuid}${s.blocked ? ' (off limits: never written to)' : ''}\n${(s.characteristics || []).map((c) => `    ${c.uuid} ${c.can.join(' ')}`).join('\n')}`).join('\n')}`
        : why ? `couldn't look inside: ${why}` : ['le', 'dual'].includes(b.type) ? null : 'a classic Bluetooth device: it has no GATT services to write a recipe for',
      acts.length ? `actions:\n${acts.join('\n')}` : null,
    ].filter(Boolean).join('\n'), OWN_WORDS, { max: 30000 });
  }

  // --- Bluetooth, in a few words (the voice's "bluetooth" tool) ---
  const BT_DO = { pair: 'pair', play_here: 'play_here', stop_here: 'stop_here', louder: 'volume_up', quieter: 'volume_down', set_volume: 'set_volume', beep: 'beep', stop_beep: 'stop_beep', status: 'status', forget: 'forget' };
  async function bluetoothDo({ do: what, device, level } = {}, opts = {}) {
    const ble = () => db.devices.filter((x) => x.transport === 'bluetooth' && x.present && !['phone', 'computer'].includes(x.kind));
    if (what === 'list' || what === 'scan') {
      if (what === 'scan' || !db.scannedAt) await scan().catch(() => {});
      const l = ble();
      return { ok: true, text: l.length ? asData(l.map((x) => `${x.customName || x.name} (${x.kind}, ${x.evidence?.bt?.bonded ? 'paired' : 'not paired'}): ${actionsOf(x).map((a) => a.name).join(', ')}`).join('\n'), OWN_WORDS, { max: 8000 }) : 'No Bluetooth devices nearby. A speaker needs to be on and in pairing mode to be found.' };
    }
    const action = BT_DO[what];
    if (!action) return { ok: false, text: `The bluetooth tool can: list, scan, ${Object.keys(BT_DO).join(', ')}.` };
    let d = device ? lookup(device) : null;
    if (device && (!d || d.transport !== 'bluetooth')) return { ok: false, text: `No Bluetooth device called "${device}". Nearby: ${ble().map((x) => x.customName || x.name).join(', ') || 'none (scan first)'}.` };
    if (!d) {
      const fit = ble().filter((x) => actionsOf(x).some((a) => a.name === action));
      if (fit.length !== 1) return { ok: false, text: fit.length ? `Which one? ${fit.map((x) => x.customName || x.name).join(' or ')}.` : `No Bluetooth device here can ${what.replace('_', ' ')}.` };
      d = fit[0];
    }
    return act(d.id, action, action === 'set_volume' ? { level } : {}, opts);
  }

  // --- MCP ---
  const TOOLS = [
    { name: 'list_devices', description: 'The devices on the home network and nearby over Bluetooth, found at the last scan: what each is, its address, and what openhouse can do with it.', inputSchema: { type: 'object', properties: { kind: { type: 'string', description: `Only this kind: ${R.KINDS.join(', ')}` } } } },
    { name: 'scan', description: 'Look for devices on the home network and over Bluetooth again (takes about 10 seconds). Do this when asked what is on the network, or when a device is missing or not answering.', inputSchema: { type: 'object', properties: {} } },
    { name: 'device_action', description: 'Do something with a device: e.g. device "tv" action "power_off", device "sonos" action "set_volume" params {"level": 20}. Use list_devices for the actions each device has. Actions that turn on, open, unlock or buy something ask the people in the room first.',
      inputSchema: { type: 'object', properties: { device: { type: 'string', description: 'Device id, address or name (e.g. "tv", "living room")' }, action: { type: 'string' }, params: { type: 'object', description: 'The action\'s parameters, if any' } }, required: ['device', 'action'] } },
    { name: 'device_info', description: 'Everything known about one device (its Bonjour and UPnP records and open ports; for a Bluetooth one, its GATT services and characteristics, read from it now), and its actions. Read this before writing a recipe for it.', inputSchema: { type: 'object', properties: { device: { type: 'string' } }, required: ['device'] } },
    { name: 'save_recipe', description: 'Teach openhouse to control a device it has no driver for, from the device\'s own local API documentation. A recipe is JSON data (never code): named actions, each a few HTTP or UDP requests to the device (or, with "over": "bluetooth", GATT reads and writes) with typed parameters filled into {placeholders}. Shape:\n' + RECIPE_HELP,
      inputSchema: { type: 'object', properties: { recipe: { type: 'object' }, device: { type: 'string', description: 'The device it is for (binds it now)' } }, required: ['recipe'] } },
    { name: 'remove_recipe', description: 'Forget a recipe (by its id), e.g. one that was wrong or for a device that is gone.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'name_device', description: 'Give a device the name the family uses for it (e.g. "Kitchen speaker"). An empty name restores its own.', inputSchema: { type: 'object', properties: { device: { type: 'string' }, name: { type: 'string' } }, required: ['device', 'name'] } },
  ];
  async function tool(name, a) {
    switch (name) {
      case 'list_devices': return summary(a.kind);
      case 'scan': { const before = new Set(db.devices.filter((d) => d.present).map((d) => d.id)); await scan(); const added = db.devices.filter((d) => d.present && !before.has(d.id)); return (added.length && before.size ? `New: ${asData(added.map((d) => d.name).join(', '), OWN_WORDS, { max: 2000 })}\n` : '') + summary(); }
      case 'device_action': { const r = await act(a.device, a.action, a.params || {}); return { text: r.text, error: !r.ok }; }
      case 'device_info': return await info(a.device);
      case 'save_recipe': { const r = saveRecipe(a.recipe, a.device); return { text: r.text, error: !r.ok }; }
      case 'remove_recipe': { const r = removeRecipe(String(a.id || '')); return { text: r.text, error: !r.ok }; }
      case 'name_device': { const r = rename(a.device, a.name); return { text: r.text, error: !r.ok }; }
    }
    return { text: `Unknown tool ${name}`, error: true };
  }
  async function mcp(msg) {
    const id = msg.id;
    if (id === undefined) return null; // a notification
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize': return ok({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'home', version: '0.1' },
        instructions: 'The devices in the family\'s home (TVs, speakers, printers…), found on the display\'s Wi-Fi and controlled directly. Start with list_devices.' });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        let r;
        try { r = await tool(msg.params?.name, msg.params?.arguments || {}); } catch (e) { r = { text: e.message, error: true }; }
        if (typeof r === 'string') r = { text: r };
        return ok({ content: [{ type: 'text', text: r.text }], isError: !!r.error });
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } };
  }

  const local = (req) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');

  /** Returns true if it handled the request. */
  handle.allow = (id, yes = true) => { const before = yes ? structuredClone(db) : null, pr = (db.pairing[id] ||= {}); if (yes) pr.allowed = true; else { delete pr.allowed; delete pr.apps; } save(before); }; // (throws when it isn't saved: a yes taken back, a no kept in memory) // the tablet's yes (or someone taking it back: the apps' yeses too)

  // --- the household's apps (the kit's devices: apps.js group "devices", docs/plugins.md) ---
  // An app sees a device by an id of its own (never its address, MAC or pairing), and uses the same actions under the
  // same asks as Opie (act, with app): never pairing, forgetting, or where the tablet's sound goes; at most 60
  // changes and 120 reads a minute.
  const salt = () => { if (!db.appSalt) { db.appSalt = crypto.randomBytes(16).toString('hex'); kept(); } return db.appSalt; }; // (kept: an app's saved ids still work after a restart)
  const appId = (d) => 'dev-' + crypto.createHmac('sha256', salt()).update(d.id).digest('hex').slice(0, 16);
  const APP_NEVER = /^(pair|unpair|forget|play_here|stop_here|install|uninstall|reset|factory_reset|settings?|set_setting|update|firmware)$/;
  const appMay = (d, a) => !APP_NEVER.test(a.name) && !(a.boardOk && a.risky);
  const NOT_CONTROLLED = new Set(['phone', 'computer', 'tablet', 'display', 'router']);
  const forApps = () => db.devices.filter((d) => !d.self && !NOT_CONTROLLED.has(d.kind) && actionsOf(d).some((a) => appMay(d, a)));
  const asking = new Set(); // apps with a card on the tablet now
  const counts = new Map(); // app -> {at, changes, reads}
  function spend(app, kind) {
    const now = Date.now(), c = counts.get(app);
    const n = c && now - c.at < 60e3 ? c : { at: now, changes: 0, reads: 0 };
    counts.set(app, n);
    if (n[kind] >= (kind === 'changes' ? 60 : 120)) return false;
    n[kind]++; return true;
  }
  // What a driver says goes to the app as plain values: no addresses (an IP or a MAC in its words is taken out).
  const scrub = (t) => String(t).replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, 'its address').replace(/\b[0-9a-f]{2}([:-][0-9a-f]{2}){5}\b/gi, 'its address');
  function clean(v, depth = 0) {
    if (v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v ?? null;
    if (typeof v === 'string') return scrub(v.slice(0, 300));
    if (depth > 2) return undefined;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(address|ip|mac|host|token|key|client_?key|url|location)$/i.test(k)).slice(0, 30).map(([k, x]) => [k, clean(x, depth + 1)]).filter(([, x]) => x !== undefined));
    return undefined;
  }
  const appView = (d) => ({ id: appId(d), name: d.customName || d.name, kind: d.kind, room: d.room || null, maker: d.maker || null, model: d.model || null, present: !!d.present,
    actions: actionsOf(d).filter((a) => appMay(d, a)).map((a) => ({ name: a.name, says: a.says, params: a.params, asks: !!a.risky })) });
  const byAppId = (id) => forApps().find((d) => appId(d) === String(id || ''));
  async function stateOf(d, app) {
    if (!actionsOf(d).some((a) => a.name === 'status')) return null;
    const r = await act(d.id, 'status', {}, { app });
    return r.ok ? clean(r.result) : null;
  }
  /** app: {id, name}. Each answers JSON for the kit. */
  handle.forApp = {
    async list(app, { state = false } = {}) {
      const list = forApps();
      if (!state) return { devices: list.map(appView) };
      return { devices: await Promise.all(list.map(async (d) => ({ ...appView(d), state: d.present && spend(app.id, 'reads') ? await stateOf(d, app) : null }))) };
    },
    async get(app, id) {
      const d = byAppId(id);
      if (!d) return { ok: false, text: 'No such device.' };
      if (!spend(app.id, 'reads')) return { ok: false, text: 'Too many at once: wait a minute.', limited: true };
      return { ok: true, ...appView(d), state: await stateOf(d, app) };
    },
    async do(app, id, action, args = {}) {
      const d = byAppId(id);
      if (!d) return { ok: false, text: 'No such device.' };
      if (!spend(app.id, 'changes')) return { ok: false, text: 'Too many at once: wait a minute.', limited: true };
      const r = await act(d.id, String(action || ''), args && typeof args === 'object' ? args : {}, { app });
      const out = { ok: r.ok, text: scrub(r.text || '') };
      if (r.ok && action === 'status') out.state = clean(r.result);
      else if (r.ok) { const st = await stateOf(d, app).catch(() => null); if (st) out.state = st; }
      return out;
    },
  };
  handle.tv = tv; handle.tvs = () => tvs().map((d) => d.customName || d.name);
  /** The tablet's volume (the voice's "volume" tool): media and Opie's voice are one volume (LiveVoice.kt). */
  async function volumeDo({ do: what = 'get', level } = {}) {
    try {
      if (what === 'room_on' || what === 'room_off') {
        const r = await bt.volume('room', what === 'room_on' ? 1 : 0);
        if (!r.room) return { ok: false, text: 'This device needs an update for that.' };
        return { ok: true, text: r.room.adjust ? `Adjusting to the room now${r.room.now ? `: ${r.room.now}` : ''}.` : 'No longer adjusting to the room: your voice and the timers follow the volume as set.' };
      }
      const got = await bt.volume('get'), now = got.volume;
      const room = got.room ? (got.room.adjust ? ` It adjusts to the room${got.room.now ? ` (now ${got.room.now})` : ''}.` : ' Adjust to the room is off.') : '';
      const want = what === 'louder' ? now + 15 : what === 'quieter' ? now - 15 : what === 'mute' ? 0 : what === 'set' ? Number(level) : null;
      if (want === null || !Number.isFinite(want)) return { ok: true, text: `The volume is at ${now}%.${room}` };
      const r = await bt.volume('set', Math.max(0, Math.min(100, Math.round(want))));
      return { ok: true, text: `Volume ${r.volume > now ? 'up' : r.volume < now ? 'down' : 'unchanged'}: now ${r.volume}%.` };
    } catch (e) { return { ok: false, text: `Couldn't change the volume: ${e.message}` }; }
  }
  handle.volume = volumeDo;
  /** The tablet's screen (the voice's "tablet_screen" tool): its brightness as Settings' Brightness row sets it, and
   *  Sleep now as the moon button does (the shell's /screen). */
  async function screenDo({ do: what = 'get', level } = {}) {
    const r = await shell('/screen', { do: what, level: String(level || '') }, 5000);
    if (!r) return { ok: false, text: 'The screen\'s settings need the device (the shell isn\'t answering).' };
    if (r.error) return { ok: false, text: r.error };
    if (r.sleeping) return { ok: true, text: 'The screen is going dark now, as at night, until someone touches it (or morning). Say at most "Good night" or "Okay".' };
    return { ok: true, text: what === 'brightness' ? `Brightness now ${r.brightness}.` : `The brightness is ${r.brightness}.` };
  }
  handle.screen = screenDo;
  /** The microphone check (the voice's "mic_check" tool): the shell's /mic-check puts Settings → Opie → Voice's check on the
   *  screen (MicCheck.kt). [wait]: typed or from a phone, where nothing holds the tablet's microphone, so it waits for
   *  how it went; the tablet's own voice can't (its conversation holds the microphone): it ends, and the check listens. */
  async function micCheckDo({ do: what = 'start' } = {}, { wait = false } = {}) {
    const told = (l) => {
      if (!l) return 'No microphone check has been done yet.';
      const mins = Math.round((Date.now() - Number(l.at)) / 60e3);
      return `The last microphone check (${mins < 1 ? 'just now' : `${mins} min ago`}): ${l.verdict}. The device showed: "${l.words}"` +
        (l.verdict === 'heard' ? '' : ' Tell them what to do about it, in a few words.');
    };
    if (what === 'last') { const g = await shell('/mic-check', { do: 'get' }); return g ? { ok: true, text: told(g.last) } : { ok: false, text: 'The microphone check needs the device (the shell isn\'t answering).' }; }
    const r = await shell('/mic-check', { do: 'start' }, 5000);
    if (!r) return { ok: false, text: 'The microphone check needs the device (the shell isn\'t answering).' };
    if (r.error) return { ok: false, text: r.error };
    if (!wait) return { ok: true, text: 'The microphone check is on the device\'s screen; it starts listening once this conversation ends. Say only one short sentence: once you stop, they say "Hey Opie" to the device, and the screen shows what it heard. Then call go_away.' };
    const before = Number(r.last?.at) || 0, t0 = Date.now();
    while (Date.now() - t0 < 20e3) {
      await new Promise((ok) => setTimeout(ok, 700));
      const g = await shell('/mic-check', { do: 'get' });
      if (g && !g.running && Number(g.last?.at) > before) return { ok: true, text: told(g.last) };
    }
    return { ok: true, text: 'The microphone check is on the device\'s screen: someone there says "Hey Opie" to it, and it shows what it heard. Ask again (mic_check last) to hear how it went.' };
  }
  handle.micCheck = micCheckDo; handle.micCheckOn = () => host.can('mic-check');
  /** "Hey Opie" or Tap to talk (the voice's "hey_opie" tool): the shell's /talk, as Settings → Opie → Talk to Opie sets it. */
  async function talkDo({ do: what = 'get' } = {}) {
    const r = await shell('/talk', what === 'on' || what === 'off' ? { heyOpie: what === 'on' } : {}, 5000);
    if (!r) return { ok: false, text: 'That needs the device (the shell isn\'t answering).' };
    if (r.error) return { ok: false, text: r.error };
    return { ok: true, text: r.heyOpie ? 'Saying "Hey Opie" starts a conversation.' : 'Tap to talk: nothing listens until someone taps the device.' };
  }
  handle.talk = talkDo; handle.talkOn = () => host.can('talk');
  /** What asks for the PIN (the voice's "pin_choices" tool): the shell's /pin-choices (PinChoices.kt). Changing one waits
   *  for the PIN on the tablet's own card, which only a person answers. */
  async function pinChoicesDo({ do: what = 'get', choice, ask } = {}) {
    const set = what === 'set';
    const r = await shell('/pin-choices', set ? { do: 'set', what: String(choice || ''), ask: ask === true } : { do: 'get' }, set ? 110e3 : 5000);
    if (!r || !Array.isArray(r.choices)) return { ok: false, text: 'The PIN\'s choices need the device (the shell isn\'t answering).' };
    const now = r.choices.map((c) => `${c.label}: ${c.asks ? 'asks for the PIN' : 'no PIN'}`).join('; ');
    const always = `Always the PIN, whatever the choices: ${(r.always || []).join('; ')}.`;
    if (!r.pin) return { ok: !set, text: `The device has no PIN, so nothing asks for one${set ? ', and the choices can\'t be changed until someone sets one (Settings → Advanced → PIN Lock)' : ''}. Once one is set: ${now}.` };
    if (!set) return { ok: true, text: `Ask for the PIN to: ${now}. ${always}` };
    switch (r.changed) {
      case 'done': return { ok: true, text: `Done. Now: ${now}.` };
      case 'same': return { ok: true, text: `It was already so. Now: ${now}.` };
      case 'not_a_choice': return { ok: false, text: `That isn't one of the choices. ${always} Say so; don't look for another way.` };
      case 'not_confirmed': return { ok: false, text: 'Not changed: nobody typed the PIN on the device. Say so; they can ask again when someone is at the device.' };
      default: return { ok: false, text: 'Not changed: the device couldn\'t ask for the PIN right now (its screen is busy or off). Someone can change it in Settings → Advanced → Ask for the PIN.' };
    }
  }
  handle.pinChoices = pinChoicesDo; handle.pinChoicesOn = () => host.can('pin-choices');
  /** Music and audiobooks in the tablet's media apps (the voice's "music" tool): the shell's /media (Media.kt,
   *  docs/music.md). What the apps say (titles, artists) is theirs: marked as data. */
  // The tablet's own Spotify player (Media.kt, SpotifyEmbed.kt), once someone signed in to Spotify in Opie: the thing's
  // Spotify link, found with the assistant's web search, plays there without Spotify's app coming up.
  let finder = null;
  handle.setFinder = (f) => { finder = f; };
  const SPOTIFY_LINK = /https:\/\/open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:track|album|playlist|artist|show|episode|audiobook)\/[A-Za-z0-9]{10,40}/;
  async function spotifyLink(query, focus) {
    const said = await finder(`Find this on Spotify: ${asData(query, 'what they asked to play', { max: 300 })}${focus ? `\nIt is a ${focus}.` : ''}\nReply with only the open.spotify.com link of the best match (a song, album, playlist, artist, podcast, episode or audiobook), or none.`,
      'You find things on Spotify with web search and reply with one open.spotify.com link and nothing else, or none.');
    const link = String(said || '').match(SPOTIFY_LINK)?.[0];
    if (!link) return null;
    let name = null; // Spotify's own name for it (its oEmbed): what to say back
    try { const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(5000) }); if (r.ok) name = String((await r.json())?.title || '').slice(0, 200) || null; } catch {}
    return { link, name };
  }
  async function spotifyFirst(app, query, focus) {
    if (!finder || !query) return null;
    const st = await shell('/media', { do: 'status' }, 8000);
    if (!st?.spotifyPlayer) return null; // (a shell without the player)
    const a = String(app || '').trim().toLowerCase(), names = (st.apps || []).map((x) => String(x.name).toLowerCase());
    // Spotify named, or no app named and Spotify is the one they last played from (or the only way the tablet has)
    if (a ? a !== 'spotify' : !(st.last ? String(st.last).toLowerCase() === 'spotify' : !names.some((n) => n !== 'spotify'))) return null;
    // Spotify plays only in its player on Home, never its app (the user); not signed in, the tablet puts Spotify's
    // sign-in on the screen itself and plays it once they're in (SpotifyEmbed.play).
    // Signed in, Spotify plays in its player on Home only, never its app (the user): what isn't found is said so.
    const notFound = { error: "Couldn't find that on Spotify. Say so, and ask how else they'd put it." };
    let found = null; try { found = await spotifyLink(query, focus); } catch (e) { console.warn('[music] spotify search:', e.message); return { error: "Couldn't search Spotify just now." }; }
    if (!found) return notFound;
    // Is it what they asked for? A search can come back with something near it (a podcast episode for a song): the
    // model judges Spotify's own name for it against their words, and the app's own search plays it otherwise.
    if (found.name) {
      let same = '';
      try { same = String(await finder(`They asked to play: ${asData(query, 'what they asked to play', { max: 300 })}\nSpotify's link is for: ${asData(found.name, "Spotify's name for it", { max: 200 })}\nIs that what they asked for (yes or no)?`, 'Reply with one word: yes or no.', { webSearch: false })); } catch {}
      if (!/^\s*yes\b/i.test(same)) { console.warn('[music] spotify link not a match'); return notFound; }
    }
    const r = await shell('/media', { do: 'spotify', url: found.link, name: found.name || '' }, 30_000);
    return r ? { ...r, found } : { error: 'The device isn\'t answering.' };
  }
  async function mediaDo({ do: what = 'status', app, query, focus, seconds } = {}) {
    if (what === 'search') { const r = await spotifyFirst(app, query, focus); if (r) return r.done ? { ok: true, text: `${r.done}${r.found?.name ? ' ' + asData(r.found.name, "Spotify's name for it", { max: 200 }) : ''}` } : { ok: false, text: String(r.error || "Spotify's player didn't start.") }; }
    const r = await shell('/media', { do: what, app: String(app || ''), query: String(query || ''), focus: String(focus || ''), seconds: Number(seconds) || 0 }, 20_000);
    if (!r) return { ok: false, text: 'Music needs the device (the shell isn\'t answering).' };
    const apps = (r.apps || []).map((a) => a.name + (a.search ? '' : ' (can\'t be asked for something to play: it opens instead)'));
    if (r.missing) return { ok: false, text: `${r.error} Say so, and offer to add it (install_app); someone then signs in to it once on the device.${apps.length ? ` Media apps on the device: ${apps.join(', ')}.` : ''}` };
    const none = 'No music or audiobook app is on the device yet. One can be added (install_app, or Apps → Add apps), and someone signs in to it once on the device.';
    const said = (n) => n ? asData([n.title, n.artist, n.album].filter(Boolean).join(' · ') || '(no title)', `what ${String(n.app).slice(0, 40)} shows (${n.state})`, { max: 300 }) : '';
    const list = apps.length ? ` Media apps on the device: ${apps.join(', ')}.` : '';
    if (r.error) return { ok: false, text: r.apps && !apps.length ? none : `${r.error}${list}${r.now ? ` ${said(r.now)}` : ''}` };
    if (what === 'status') {
      if (!apps.length && !r.now) return { ok: true, text: none };
      const min = (s) => Math.round(s / 60);
      const where = r.now?.positionS != null ? ` (${min(r.now.positionS)} of ${r.now.lengthS ? min(r.now.lengthS) : '?'} min)` : '';
      const lines = [r.now ? `${r.now.app}: ${r.now.state}${r.now.elsewhere ? ' on another device, not this one' : ''}${where}. ${said(r.now)}` : r.anyPlaying ? 'Something is playing.' : 'Nothing is playing.',
        ...(r.others || []).map((o) => `Also playing in ${o.app}: ${said(o)}`),
        list.trim() + (r.last ? ` Last played from ${r.last}.` : ''),
        r.sees ? '' : 'The device can\'t see what the apps play yet (Settings → Opie → Now playing), so it only sends play, pause and skip.'];
      return { ok: true, text: lines.filter(Boolean).join('\n') };
    }
    return { ok: true, text: `${r.done}${r.now ? ` ${said(r.now)}` : ''}` };
  }
  handle.media = mediaDo;
  /** The voice's "home_devices" tool: what the Linked devices sheet's buttons do (speakers, streamers, printers...),
   *  for any device; risky actions ask the people in the room first, as there (act's who: 'voice'). */
  async function devicesDo({ do: what = 'list', device, action, params, name } = {}) {
    if (what === 'list') { const s = summary(); return { ok: true, text: typeof s === 'string' ? s : JSON.stringify(s) }; }
    if (what === 'name') return rename(device, name || '');
    if (!device || !action) return { ok: false, text: 'Which device, and which of its actions (list says them)?' };
    return act(device, action, params && typeof params === 'object' ? params : {}, { who: 'voice' });
  }
  handle.devices = devicesDo;
  handle.bluetooth = bluetoothDo; handle.bluetoothOn = () => !!btState?.supported; // the voice's tool, offered on a tablet with Bluetooth
  handle.mcp = mcp; // the same tools for the agent in its own app, behind its run's key (box.js)
  return handle;
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!(p === '/devices' || p.startsWith('/devices/') || p === '/mcp/home')) return false;
    if (!local(req)) { json(res, 403, { error: 'only from this display' }); return true; }
    if (p === '/mcp/home') {
      if (req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { error: 'unauthorized' }); return true; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return true; }
      const out = await mcp(await body(req));
      if (!out) { res.writeHead(202); res.end(); return true; }
      json(res, 200, out); return true;
    }
    if (req.method === 'GET' && p === '/devices') { json(res, 200, { scannedAt: db.scannedAt, scanning: !!scanning, lastScan: db.lastScan || null, devices: db.devices.map(pub) }); return true; }
    if (req.method === 'POST' && p === '/devices/scan') {
      try { await scan(); json(res, 200, { scannedAt: db.scannedAt, lastScan: db.lastScan, devices: db.devices.map(pub) }); } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (req.method === 'POST' && p === '/devices/action') {
      const b = await body(req);
      json(res, 200, await act(b.device, String(b.action || ''), b.params || {}, { who: 'board' }));
      return true;
    }
    if (req.method === 'POST' && p === '/devices/recipe') { const b = await body(req); json(res, 200, b.remove ? removeRecipe(String(b.remove)) : saveRecipe(b.recipe, b.device)); return true; }
    json(res, 404, { error: 'not found' });
    return true;
  };
}

const RECIPE_HELP = `{
  "id": "wled-kitchen", "name": "Kitchen light strip", "maker": "WLED", "kind": "light",
  "sources": ["https://kno.wled.ge/interfaces/json-api/"],
  "find": [{"address": "10.0.0.50"}, {"bonjour": "_wled._tcp"}, {"ssdp": "<search target>", "contains": "<in SERVER>"}, {"http": {"port": 80, "path": "/json/info", "contains": "WLED"}}, {"mac": "d8:31:34"}],
  "identity": {"name": {"http": {"port": 80, "path": "/json/info"}, "json": "name"}},
  "actions": {
    "turn_off": {"says": "Turn the strip off", "request": {"http": {"method": "POST", "port": 80, "path": "/json/state", "json": {"on": false}}}},
    "set_brightness": {"says": "Brightness 0-255", "params": {"level": {"type": "integer", "min": 0, "max": 255, "required": true}},
      "request": {"http": {"method": "POST", "port": 80, "path": "/json/state", "json": {"bri": "{level}"}}}},
    "status": {"says": "On or off, and how bright", "request": {"http": {"port": 80, "path": "/json/state"}}, "read": {"on": "on", "brightness": "bri"}}
  }
}
Rules: requests only go to the device's own address (give port and path; https: true for its own certificate). A request is {"http": {method, port, path, https?, headers?, json? | body? | form?}}, {"udp": {port, text? | hex?}} or {"wait": ms}; "steps": [..] for up to 6 in a row. Parameters are typed (string needs maxLength or enum; integer/number with min/max; boolean). "{name}" fills a parameter ("{level}" alone as a JSON value keeps its type); "{address}" is the device's address. "read" picks fields from a JSON answer by dotted path, or {"xml": "element"}. "expect" {status?, contains?} checks the answer. Actions that turn on, open, unlock or buy anything always ask the people in the room first (set "risky": true for any other that should). kind is one of ${R.KINDS.join(', ')}. The answer lists exactly what is wrong; fix that and save again.

A Bluetooth (BLE) device: "over": "bluetooth"; find by {"ble_service": "<uuid>"}, {"ble_name": "<part of its name>"}, {"maker_id": <company id>} or {"mac": "<address>"}; no identity. A step is {"ble": {"op": "write", "service", "characteristic", "hex": "56{level:u8}00" | "text": "...", "response": true|false}}, {"ble": {"op": "read", "service", "characteristic"}}, {"ble": {"op": "listen", "service", "characteristic", "ms": 1000}} (its notifications, armed before the writes, for a device that answers that way) or {"wait": ms}. UUIDs are 16-bit ("ffd9") or full. In hex, {param} is a number as one byte, {param:u16le} (u8 i8 u16le u16be i16le i16be u32le u32be) another size, true/false 01/00, an enum string its own hex. "read" decodes the last read or notification: {"battery": "u8", "temp": "i16le@2/100", "name": "utf8"}. Read device_info first: it lists the services inside the device. Firmware-update, security (Generic Access/Attribute) and keyboard (HID) services are never written to.`;
