// Device recipes: how to use a device openhouse has no driver for, written by the agent as data.
// A recipe is checked against the shape below and then only ever *read*: each action is a short
// list of HTTP or UDP requests to the device's own address, with the action's declared parameters
// filled into marked places. Nothing in it is run as code, and it can't reach any other host.
//
// {
//   "id": "wled-kitchen", "name": "Kitchen light strip", "maker": "WLED", "kind": "light",
//   "sources": ["https://kno.wled.ge/interfaces/json-api/"],
//   "find": [{ "bonjour": "_wled._tcp" }, { "http": { "port": 80, "path": "/json/info", "contains": "WLED" } }, { "address": "10.0.0.50" }],
//   "identity": { "name": { "http": { "port": 80, "path": "/json/info" }, "json": "name" } },
//   "actions": {
//     "turn_off": { "says": "Turn the strip off", "request": { "http": { "method": "POST", "port": 80, "path": "/json/state", "json": { "on": false } } } },
//     "set_brightness": { "says": "Brightness 0-255", "params": { "level": { "type": "integer", "min": 0, "max": 255, "required": true } },
//       "request": { "http": { "method": "POST", "port": 80, "path": "/json/state", "json": { "on": true, "bri": "{level}" } } } },
//     "status": { "says": "On or off, and how bright", "request": { "http": { "port": 80, "path": "/json/state" } }, "read": { "on": "on", "brightness": "bri" } }
//   }
// }
//
// A Bluetooth recipe ("over": "bluetooth") is the same, for a BLE device: it's found by its advertised service, name or
// maker, and each action is a few GATT reads, writes or notifications on the device's own services (the shell does the
// radio work: bluetooth.js, Bluetooth.kt). For example:
// {
//   "id": "desk-lamp", "name": "Desk lamp", "kind": "light", "over": "bluetooth",
//   "find": [{ "ble_name": "LEDBLE" }, { "ble_service": "ffd5" }],
//   "actions": {
//     "turn_off": { "says": "Turn it off", "request": { "ble": { "op": "write", "service": "ffd5", "characteristic": "ffd9", "hex": "cc2433" } } },
//     "set_brightness": { "says": "Brightness 0-255", "params": { "level": { "type": "integer", "min": 0, "max": 255, "required": true } },
//       "request": { "ble": { "op": "write", "service": "ffd5", "characteristic": "ffd9", "hex": "56{level:u8}{level:u8}{level:u8}00f0aa" } } },
//     "status": { "says": "Its battery", "request": { "ble": { "op": "read", "service": "180f", "characteristic": "2a19" } }, "read": { "battery": "u8" } }
//   }
// }
import { request, udp, sleep, xml, isLocal } from './net.js';
import { uuid as bleUuid, isUuid, BLOCKED, READ as BLE_READ, FORMATS, encode, decode as decodeBle } from './bluetooth.js';

export const KINDS = ['tv', 'streamer', 'speaker', 'headphones', 'light', 'plug', 'switch', 'printer', 'console', 'camera', 'thermostat', 'lock', 'blinds',
  'fan', 'appliance', 'sensor', 'tag', 'watch', 'input', 'toy', 'hub', 'router', 'computer', 'phone', 'tablet', 'display', 'other'];
/** Words that make an action ask first, whatever the recipe says: it turns on, opens, unlocks, buys. */
const RISKY = new Set(['on', 'open', 'opens', 'unlock', 'unlocks', 'unlatch', 'disarm', 'arm', 'start', 'starts', 'launch', 'buy', 'order',
  'purchase', 'pay', 'wake', 'boot', 'heat', 'ignite', 'raise', 'lift', 'enable', 'garage', 'door', 'gate']);
export const riskyWords = (...texts) => texts.some((t) => String(t || '').toLowerCase().split(/[^a-z]+/).some((w) => RISKY.has(w)));

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/, ACTION = /^[a-z][a-z0-9_]{1,30}$/, PARAM = /^[a-z][a-z0-9_]{0,20}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HEADER = /^[A-Za-z0-9-]{1,40}$/;
const BUILTINS = ['address'];
const HEX_TEMPLATE = /^(?:[0-9a-fA-F]{2}|\{[a-z][a-z0-9_]*(?::(?:u8|i8|u16le|u16be|i16le|i16be|u32le|u32be))?\})+$/;

/** Check a recipe. Returns a list of problems (empty: it's fine). */
export function validate(r) {
  const errs = [];
  const err = (where, msg) => errs.push(`${where}: ${msg}`);
  const only = (o, keys, where) => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) if (!keys.includes(k)) err(where, `unknown field "${k}" (allowed: ${keys.join(', ')})`); };
  const str = (v, max, where, req = true) => { if (v == null) { if (req) err(where, 'missing'); return; } if (typeof v !== 'string' || !v.trim() || v.length > max) err(where, `a string of at most ${max} characters`); };
  const port = (v, where) => { if (!Number.isInteger(v) || v < 1 || v > 65535) err(where, 'a port number, 1-65535'); };
  const path = (v, where) => { str(v, 300, where); if (typeof v === 'string' && (!v.startsWith('/') || /^\/\/|[\s#]|\.\.\//.test(v))) err(where, 'a path starting with "/" (no host, spaces, # or ../)'); };
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['the recipe must be a JSON object'];
  only(r, ['id', 'name', 'maker', 'kind', 'over', 'sources', 'find', 'identity', 'actions', 'notes'], 'recipe');
  if (r.over != null && !['wifi', 'bluetooth'].includes(r.over)) err('over', '"wifi" (the default) or "bluetooth"');
  const ble = r.over === 'bluetooth';
  if (ble && r.identity != null) err('identity', 'not for a Bluetooth recipe (its name comes from the device)');
  if (typeof r.id !== 'string' || !ID.test(r.id)) err('id', 'lowercase letters, digits and dashes, 2-40 long');
  str(r.name, 60, 'name'); str(r.maker, 40, 'maker', false);
  if (!KINDS.includes(r.kind)) err('kind', `one of ${KINDS.join(', ')}`);
  if (r.sources != null && (!Array.isArray(r.sources) || r.sources.length > 5 || r.sources.some((s) => typeof s !== 'string' || !/^https:\/\/\S{4,300}$/.test(s)))) err('sources', 'up to 5 https links to the documentation you used');
  if (r.notes != null && (!Array.isArray(r.notes) || r.notes.length > 5 || r.notes.some((s) => typeof s !== 'string' || s.length > 200))) err('notes', 'up to 5 short strings');

  if (!Array.isArray(r.find) || !r.find.length || r.find.length > 6) err('find', '1-6 ways to recognise the device');
  else r.find.forEach((f, i) => {
    const w = `find[${i}]`;
    const keys = Object.keys(f || {}).filter((k) => k !== 'contains');
    const kinds = ble ? ['ble_service', 'ble_name', 'maker_id', 'mac'] : ['bonjour', 'ssdp', 'http', 'address', 'mac'];
    if (keys.length !== 1 || !kinds.includes(keys[0])) return err(w, `exactly one of ${kinds.join(', ')}${ble ? '' : ' (plus optional contains)'}`);
    if (f.ble_service != null && !isUuid(f.ble_service)) err(`${w}.ble_service`, 'a service UUID, like "180f" or a full one');
    if (f.ble_name != null) str(f.ble_name, 40, `${w}.ble_name`);
    if (f.maker_id != null && !(Number.isInteger(f.maker_id) && f.maker_id >= 0 && f.maker_id <= 65535)) err(`${w}.maker_id`, 'a Bluetooth company identifier, 0-65535');
    if (f.contains != null) str(f.contains, 80, `${w}.contains`);
    if (f.bonjour != null && !/^_[a-z0-9-]{1,30}\._(tcp|udp)$/.test(f.bonjour)) err(`${w}.bonjour`, 'a service type like "_wled._tcp"');
    if (f.ssdp != null) str(f.ssdp, 120, `${w}.ssdp`);
    if (f.address != null && !isLocal(f.address)) err(`${w}.address`, 'an address on the home network');
    if (f.mac != null && !/^([0-9a-f]{2}:){2,5}[0-9a-f]{2}$/i.test(f.mac)) err(`${w}.mac`, 'a MAC address or its first bytes, like "d8:31:34"');
    if (f.http != null) { only(f.http, ['port', 'path', 'https', 'contains'], `${w}.http`); port(f.http.port, `${w}.http.port`); path(f.http.path, `${w}.http.path`); str(f.http.contains, 80, `${w}.http.contains`); }
  });

  const read = (v, where) => {
    only(v, ['http', 'json', 'xml'], where);
    if (!v?.http) return err(where, 'needs http {port, path}');
    only(v.http, ['port', 'path', 'https'], `${where}.http`); port(v.http.port, `${where}.http.port`); path(v.http.path, `${where}.http.path`);
    if ((v.json == null) === (v.xml == null)) err(where, 'exactly one of json (a dotted path) or xml (an element name)');
    if (v.json != null && (typeof v.json !== 'string' || !/^[\w.-]{1,80}$/.test(v.json))) err(`${where}.json`, 'a dotted path like "device.name" or "items.0.id"');
    if (v.xml != null && (typeof v.xml !== 'string' || !/^[\w-]{1,40}$/.test(v.xml))) err(`${where}.xml`, 'an element name');
  };
  if (r.identity != null) { only(r.identity, ['name', 'model', 'mac'], 'identity'); for (const [k, v] of Object.entries(r.identity)) read(v, `identity.${k}`); }

  const actions = r.actions && typeof r.actions === 'object' && !Array.isArray(r.actions) ? Object.entries(r.actions) : null;
  if (!actions || !actions.length || actions.length > 30) err('actions', '1-30 named actions');
  for (const [name, a] of actions || []) {
    const w = `actions.${name}`;
    if (!ACTION.test(name)) err(w, 'action names are lowercase words joined by _, like "turn_off"');
    only(a, ['says', 'risky', 'params', 'request', 'steps', 'read', 'expect'], w);
    str(a?.says, 120, `${w}.says`);
    if (a?.risky != null && typeof a.risky !== 'boolean') err(`${w}.risky`, 'true or false');
    const params = a?.params || {};
    if (typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 8) err(`${w}.params`, 'up to 8 named parameters');
    for (const [p, s] of Object.entries(params)) {
      const pw = `${w}.params.${p}`;
      if (!PARAM.test(p) || BUILTINS.includes(p)) err(pw, 'a lowercase name (not "address")');
      only(s, ['type', 'enum', 'min', 'max', 'maxLength', 'required', 'says'], pw);
      if (!['string', 'integer', 'number', 'boolean'].includes(s?.type)) err(`${pw}.type`, 'string, integer, number or boolean');
      if (s?.enum != null && (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 40 || s.enum.some((e) => !['string', 'number'].includes(typeof e) || String(e).length > 40))) err(`${pw}.enum`, 'up to 40 short values');
      for (const k of ['min', 'max']) if (s?.[k] != null && typeof s[k] !== 'number') err(`${pw}.${k}`, 'a number');
      if (s?.type === 'string' && s.enum == null && !(Number.isInteger(s.maxLength) && s.maxLength >= 1 && s.maxLength <= 200)) err(`${pw}.maxLength`, 'strings need a maxLength (1-200) or an enum');
    }
    const steps = a?.steps ?? (a?.request ? [a.request] : null);
    if ((a?.steps != null) === (a?.request != null)) err(w, 'exactly one of request or steps');
    else if (!Array.isArray(steps) || !steps.length || steps.length > 6) err(`${w}.steps`, '1-6 requests');
    else steps.forEach((s, i) => {
      const sw = a.steps ? `${w}.steps[${i}]` : `${w}.request`;
      const kinds = Object.keys(s || {});
      const allowed = ble ? ['ble', 'wait'] : ['http', 'udp', 'wait'];
      if (kinds.length !== 1 || !allowed.includes(kinds[0])) return err(sw, `exactly one of ${allowed.join(', ')}`);
      const placeholders = [];
      const scan = (v) => { if (typeof v === 'string') for (const m of v.matchAll(/\{([^{}]*)\}/g)) placeholders.push(m[1]); else if (v && typeof v === 'object') Object.values(v).forEach(scan); };
      if (s.wait != null) { if (!Number.isInteger(s.wait) || s.wait < 1 || s.wait > 5000) err(`${sw}.wait`, 'milliseconds, 1-5000'); return; }
      if (s.http) {
        const h = s.http;
        only(h, ['method', 'port', 'path', 'https', 'headers', 'json', 'body', 'form'], `${sw}.http`);
        if (h.method != null && !METHODS.includes(h.method)) err(`${sw}.http.method`, METHODS.join(', '));
        port(h.port, `${sw}.http.port`); path(h.path, `${sw}.http.path`);
        if ([h.json, h.body, h.form].filter((x) => x != null).length > 1) err(`${sw}.http`, 'at most one of json, body, form');
        if (h.body != null) str(h.body, 4000, `${sw}.http.body`);
        if (h.form != null && (typeof h.form !== 'object' || Array.isArray(h.form) || Object.values(h.form).some((x) => typeof x !== 'string'))) err(`${sw}.http.form`, 'an object of strings');
        if (h.json != null && JSON.stringify(h.json).length > 4000) err(`${sw}.http.json`, 'at most 4000 characters');
        if (h.headers != null) {
          if (typeof h.headers !== 'object' || Array.isArray(h.headers)) err(`${sw}.http.headers`, 'an object');
          else for (const [k, v] of Object.entries(h.headers)) {
            if (!HEADER.test(k) || /^(host|content-length|connection|transfer-encoding)$/i.test(k)) err(`${sw}.http.headers`, `"${k}" can't be set`);
            if (typeof v !== 'string' || v.length > 300 || /[\r\n]/.test(v)) err(`${sw}.http.headers.${k}`, 'a one-line string');
          }
        }
        scan([h.path, h.headers, h.json, h.body, h.form]);
      }
      if (s.ble) {
        const b = s.ble;
        only(b, ['op', 'service', 'characteristic', 'hex', 'text', 'response', 'ms'], `${sw}.ble`);
        if (!['read', 'write', 'listen'].includes(b.op)) err(`${sw}.ble.op`, 'read, write or listen');
        if (!isUuid(b.service)) err(`${sw}.ble.service`, 'a service UUID, like "180f" or a full one');
        if (!isUuid(b.characteristic)) err(`${sw}.ble.characteristic`, 'a characteristic UUID');
        if (b.op !== 'read' && isUuid(b.service) && BLOCKED.has(bleUuid(b.service))) err(`${sw}.ble.service`, 'never written to: firmware updates, the link\'s security and keyboards are off limits');
        if (b.op === 'write') {
          if ((b.hex == null) === (b.text == null)) err(`${sw}.ble`, 'a write has exactly one of hex or text');
          if (b.hex != null && (typeof b.hex !== 'string' || b.hex.length > 1200 || !HEX_TEMPLATE.test(b.hex))) err(`${sw}.ble.hex`, 'hex bytes, with {param} or {param:u8|i8|u16le|u16be|i16le|i16be|u32le|u32be} for a number');
          if (b.text != null) str(b.text, 500, `${sw}.ble.text`);
          if (b.response != null && typeof b.response !== 'boolean') err(`${sw}.ble.response`, 'true (wait for the device to say it took it, the default) or false');
        } else if (b.hex != null || b.text != null || b.response != null) err(`${sw}.ble`, 'only a write has hex, text or response');
        if (b.ms != null && (b.op !== 'listen' || !Number.isInteger(b.ms) || b.ms < 100 || b.ms > 5000)) err(`${sw}.ble.ms`, 'for listen: how long, 100-5000 ms');
        scan([b.hex, b.text].map((x) => typeof x === 'string' ? x.replace(/\{([a-z][a-z0-9_]*):[a-z0-9]+\}/g, '{$1}') : x));
      }
      if (s.udp) {
        only(s.udp, ['port', 'text', 'hex'], `${sw}.udp`); port(s.udp.port, `${sw}.udp.port`);
        if ((s.udp.text == null) === (s.udp.hex == null)) err(`${sw}.udp`, 'exactly one of text or hex');
        if (s.udp.text != null) str(s.udp.text, 1000, `${sw}.udp.text`);
        if (s.udp.hex != null && !/^([0-9a-f]{2}){1,600}$/i.test(s.udp.hex)) err(`${sw}.udp.hex`, 'hex bytes, no spaces');
        scan(s.udp.text);
      }
      for (const p of placeholders) if (!BUILTINS.includes(p) && !(p in params)) err(sw, `"{${p}}" isn't one of this action's params (${Object.keys(params).join(', ') || 'none'}) or {address}`);
    });
    if (a?.read != null) {
      if (typeof a.read !== 'object' || Array.isArray(a.read) || Object.keys(a.read).length > 12) err(`${w}.read`, 'up to 12 named fields');
      else for (const [k, v] of Object.entries(a.read)) {
        const ok = ble ? typeof v === 'string' && BLE_READ.test(v)
          : (typeof v === 'string' && /^[\w.-]{1,80}$/.test(v)) || (v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.xml === 'string' && /^[\w-]{1,40}$/.test(v.xml));
        if (!PARAM.test(k) || !ok) err(`${w}.read.${k}`, ble ? 'how to read the bytes: u8, i8, u16le, u16be, i16le, i16be, u32le, u32be, utf8 or hex, with @offset and /scale (e.g. "i16le@2/100")' : 'a dotted JSON path, or {"xml": "element"}');
      }
    }
    if (ble && a?.expect != null) err(`${w}.expect`, 'not for a Bluetooth recipe');
    if (a?.expect != null) { only(a.expect, ['status', 'contains'], `${w}.expect`); if (a.expect.status != null && !Number.isInteger(a.expect.status)) err(`${w}.expect.status`, 'an HTTP status'); if (a.expect.contains != null) str(a.expect.contains, 80, `${w}.expect.contains`); }
  }
  return errs;
}

/** Whether an action asks first: its own flag, or words that turn on / open / unlock / buy. */
export const isRisky = (name, a) => a.risky === true || riskyWords(name, a.says);

/** Check given values against an action's params. Returns { values } or { error }. */
export function checkParams(specs = {}, given = {}) {
  const values = {};
  for (const k of Object.keys(given || {})) if (!(k in specs)) return { error: `unknown parameter "${k}" (this action takes: ${Object.keys(specs).join(', ') || 'none'})` };
  for (const [k, s] of Object.entries(specs)) {
    let v = given?.[k];
    if (v == null || v === '') { if (s.required) return { error: `"${k}" is needed` }; continue; }
    if (s.type === 'integer' || s.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) return { error: `"${k}" must be ${s.type === 'integer' ? 'a whole number' : 'a number'}` };
      if (s.min != null && v < s.min) return { error: `"${k}" must be at least ${s.min}` };
      if (s.max != null && v > s.max) return { error: `"${k}" must be at most ${s.max}` };
    } else if (s.type === 'boolean') {
      if (typeof v === 'string') v = v === 'true' ? true : v === 'false' ? false : v;
      if (typeof v !== 'boolean') return { error: `"${k}" must be true or false` };
    } else {
      v = String(v);
      if (s.maxLength && v.length > s.maxLength) return { error: `"${k}" is too long (at most ${s.maxLength})` };
    }
    if (s.enum && !s.enum.map(String).includes(String(v))) return { error: `"${k}" must be one of ${s.enum.join(', ')}` };
    values[k] = v;
  }
  return { values };
}

// --- filling and running -------------------------------------------------------------------------
const fill = (s, vals, enc = (x) => x) => s.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k) => (k in vals ? enc(String(vals[k])) : ''));
function fillJson(v, vals) {
  if (typeof v === 'string') { const m = v.match(/^\{([a-z][a-z0-9_]*)\}$/); return m ? (m[1] in vals ? vals[m[1]] : null) : fill(v, vals); }
  if (Array.isArray(v)) return v.map((x) => fillJson(x, vals));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillJson(x, vals)]));
  return v;
}
export function pick(obj, dotted) {
  let v = obj;
  for (const k of dotted.split('.')) { if (v == null) return null; v = v[/^\d+$/.test(k) && Array.isArray(v) ? Number(k) : k]; }
  return v ?? null;
}
function readFrom(text, spec) {
  if (spec && typeof spec === 'object') return xml(text, spec.xml);
  try { return pick(JSON.parse(text), spec); } catch { return null; }
}

async function httpStep(address, h, vals) {
  const url = `${h.https ? 'https' : 'http'}://${address}:${h.port}${fill(h.path, vals, encodeURIComponent)}`;
  const headers = Object.fromEntries(Object.entries(h.headers || {}).map(([k, v]) => [k, fill(v, vals).replace(/[\r\n]/g, '')]));
  let body;
  if (h.json != null) { body = JSON.stringify(fillJson(h.json, vals)); headers['content-type'] ||= 'application/json'; }
  else if (h.form != null) { body = new URLSearchParams(Object.fromEntries(Object.entries(h.form).map(([k, v]) => [k, fill(v, vals)]))).toString(); headers['content-type'] ||= 'application/x-www-form-urlencoded'; }
  else if (h.body != null) body = fill(h.body, vals);
  return request(url, { method: h.method || (body ? 'POST' : 'GET'), headers, body, ms: 5000 });
}

/** Read the identity fields a recipe declares. */
export async function identify(recipe, address) {
  const out = {};
  for (const [k, v] of Object.entries(recipe.identity || {})) {
    try { const r = await httpStep(address, v.http, {}); const x = readFrom(r.text, v.json ?? { xml: v.xml }); if (x != null) out[k] = String(x).slice(0, 80); } catch {}
  }
  return out;
}

/** Whether a device matches one of the recipe's find rules. */
export async function matches(recipe, d) {
  const bt = d.bt || d.evidence?.bt;
  if ((recipe.over === 'bluetooth') !== (d.transport === 'bluetooth')) return false;
  for (const f of recipe.find) {
    if (bt && f.ble_service && (bt.services || []).map(bleUuid).includes(bleUuid(f.ble_service))) return true;
    if (bt && f.ble_name && String(d.name || '').toLowerCase().includes(f.ble_name.toLowerCase())) return true;
    if (bt && f.maker_id != null && (bt.makers || []).includes(f.maker_id)) return true;
    const has = (s) => !f.contains || String(s || '').toLowerCase().includes(f.contains.toLowerCase());
    if (f.address && d.address === f.address) return true;
    if (f.mac && d.mac && d.mac.toLowerCase().startsWith(f.mac.toLowerCase())) return true;
    if (f.bonjour && d.mdns.some((s) => s.type === f.bonjour && has(s.instance))) return true;
    if (f.ssdp && d.ssdp.some((s) => s.sts.includes(f.ssdp) && has(s.server))) return true;
    if (f.http && d.ports.includes(f.http.port)) {
      try { const r = await httpStep(d.address, f.http, {}); if (r.status < 400 && r.text.toLowerCase().includes(f.http.contains.toLowerCase())) return true; } catch {}
    }
  }
  return false;
}

/** Run one action. Returns what the device said (the `read` fields, or its answer, shortened). */
export async function run(recipe, name, address, given, io = {}) {
  const a = recipe.actions[name];
  if (!a) throw new Error(`No action "${name}".`);
  const p = checkParams(a.params, given);
  if (p.error) throw new Error(p.error);
  if (recipe.over === 'bluetooth') return runBle(a, address, p.values, io.bt);
  const vals = { ...p.values, address };
  let last = null;
  for (const s of a.steps || [a.request]) {
    if (s.wait) { await sleep(s.wait); continue; }
    if (s.udp) {
      const pkt = s.udp.hex ? Buffer.from(s.udp.hex, 'hex') : Buffer.from(fill(s.udp.text, vals));
      const replies = await udp(pkt, [address], s.udp.port, { listen: 800 });
      last = { status: replies.length ? 200 : 0, text: replies.map((r) => r.data.toString('utf8')).join('\n') };
      continue;
    }
    last = await httpStep(address, s.http, vals);
    if (last.status >= 400) throw new Error(`The device answered ${last.status}: ${last.text.slice(0, 200)}`);
  }
  if (a.expect?.status != null && last?.status !== a.expect.status) throw new Error(`The device answered ${last?.status}, expected ${a.expect.status}.`);
  if (a.expect?.contains && !String(last?.text || '').includes(a.expect.contains)) throw new Error(`The device's answer didn't say "${a.expect.contains}": ${String(last?.text || '').slice(0, 200)}`);
  if (a.read && last) return Object.fromEntries(Object.entries(a.read).map(([k, spec]) => [k, readFrom(last.text, spec)]));
  const t = String(last?.text || '').trim();
  return t ? t.slice(0, 1500) : 'Done.';
}

// --- Bluetooth ----------------------------------------------------------------------------------
/** A hex template with its parameters filled in: numbers in their declared format, true/false as 01/00, strings as hex. */
export function fillHex(t, vals) {
  return t.replace(/\{([a-z][a-z0-9_]*)(?::([a-z0-9]+))?\}/g, (_, k, fmt) => {
    const v = vals[k];
    if (v == null) throw new Error(`"${k}" is needed`);
    if (typeof v === 'boolean') return v ? '01' : '00';
    if (typeof v === 'number') return encode(v, fmt && FORMATS[fmt] ? fmt : 'u8');
    if (!/^([0-9a-f]{2})*$/i.test(String(v))) throw new Error(`"${k}" has to be hex bytes here`);
    return String(v);
  });
}

async function runBle(a, mac, vals, bt) {
  if (!bt) throw new Error('Bluetooth needs the device.');
  const steps = (a.steps || [a.request]).map((s) => {
    if (s.wait) return { wait: s.wait };
    const b = s.ble, where = { service: bleUuid(b.service), characteristic: bleUuid(b.characteristic) };
    if (b.op === 'read') return { read: where };
    if (b.op === 'listen') return { listen: { ...where, ms: b.ms || 1000 } };
    const hex = b.hex != null ? fillHex(b.hex, vals) : Buffer.from(fill(b.text, vals)).toString('hex');
    return { write: { ...where, hex, response: b.response !== false } };
  });
  const results = await bt.gatt(mac, steps);
  const last = [...results].reverse().find((r) => r.read != null || r.listen?.length);
  const bytes = last ? (last.read ?? last.listen[0]) : null;
  if (a.read) return Object.fromEntries(Object.entries(a.read).map(([k, spec]) => [k, decodeBle(bytes, spec)]));
  return bytes ? `The device answered ${bytes.slice(0, 200)}` : 'Done.';
}
