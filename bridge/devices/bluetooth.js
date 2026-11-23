// Bluetooth devices (docs/bluetooth.md): found, paired and used through the shell (Bluetooth.kt, the device server's
// POST /bt), since the bridge runs in a runtime with no radio of its own. This side turns what the shell found into
// devices, and knows the standard profiles: a speaker or headphones as where the tablet's sound goes (A2DP, with the
// tablet's media volume), the battery (0x180F), a tag's beep (Immediate Alert, 0x1802) and a thermometer's reading
// (Environmental Sensing, 0x181A). Anything else is taught with a recipe ("over": "bluetooth": recipe.js).
//
// The shell keeps the limits nothing here can change: no writes to firmware-update, security or keyboard services,
// pairing only when asked, every write logged.

/** "180f", "0x180F" or a full UUID -> the full lowercase UUID. */
export function uuid(u) {
  const s = String(u || '').trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}-0000-1000-8000-00805f9b34fb`;
  return s;
}
export const isUuid = (u) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid(u));

/** Services nothing writes to (the shell refuses them too): firmware updates, the link's own security, keyboards. */
export const BLOCKED = new Set(['fe59', '00001530-1212-efde-1523-785feabcd123', '1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0',
  'f000ffc0-0451-4000-b000-000000000000', 'fef5', '1800', '1801', '1812'].map(uuid));

export const STD = { battery: uuid('180f'), batteryLevel: uuid('2a19'), info: uuid('180a'), maker: uuid('2a29'), model: uuid('2a24'),
  alert: uuid('1802'), alertLevel: uuid('2a06'), env: uuid('181a'), temperature: uuid('2a6e'), humidity: uuid('2a6f'), audioSink: uuid('110b') };

// Bluetooth SIG company identifiers seen in advertisements.
const MAKERS = { 76: 'Apple', 6: 'Microsoft', 117: 'Samsung', 224: 'Google', 135: 'Garmin', 158: 'Bose', 301: 'Sony', 87: 'Harman', 1177: 'Ruuvi' };

/** Little-endian / big-endian numbers in hex bytes, as recipes declare them. */
export const FORMATS = { u8: [1, false, false], i8: [1, true, false], u16le: [2, false, false], u16be: [2, false, true], i16le: [2, true, false], i16be: [2, true, true], u32le: [4, false, false], u32be: [4, false, true] };
export function encode(n, fmt = 'u8') {
  const [size, signed, be] = FORMATS[fmt];
  let v = Math.round(Number(n));
  const lim = 2 ** (8 * size);
  if (signed ? v < -lim / 2 || v >= lim / 2 : v < 0 || v >= lim) throw new Error(`${n} doesn't fit in ${fmt}`);
  if (v < 0) v += lim;
  const bytes = []; for (let i = 0; i < size; i++) { bytes.push(v % 256); v = Math.floor(v / 256); }
  if (be) bytes.reverse();
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** A read spec: "u8", "u16le@2", "i16le@0/100" (a scale), "utf8", "hex". */
export const READ = /^(u8|i8|u16le|u16be|i16le|i16be|u32le|u32be|utf8|hex)(@\d{1,3})?(\/\d{1,7})?$/;
export function decode(hex, spec) {
  const m = String(spec).match(READ);
  if (!m || hex == null) return null;
  const buf = Buffer.from(hex, 'hex');
  const at = m[2] ? Number(m[2].slice(1)) : 0;
  if (m[1] === 'utf8') return buf.subarray(at).toString('utf8').replace(/\0+$/, '');
  if (m[1] === 'hex') return buf.subarray(at).toString('hex');
  const [size, signed, be] = FORMATS[m[1]];
  if (buf.length < at + size) return null;
  let v = 0;
  for (let i = 0; i < size; i++) v += buf[at + (be ? size - 1 - i : i)] * 2 ** (8 * i);
  if (signed && v >= 2 ** (8 * size - 1)) v -= 2 ** (8 * size);
  return m[3] ? v / Number(m[3].slice(1)) : v;
}

/** The shell's /bt, as a few functions. call(path, body, ms) -> JSON or null (the shell isn't there: a laptop). */
export function btClient(call) {
  const bt = async (op, b = {}, ms = 30000) => {
    const r = await call('/bt', { op, ...b }, ms);
    if (!r) throw new Error('Bluetooth needs the tablet (the shell isn\'t answering).');
    if (r.error) throw new Error(r.error);
    return r;
  };
  return {
    state: () => call('/bt', { op: 'state' }, 3000),
    scan: (ms = 8000) => bt('scan', { ms }, ms + 15000).then((r) => r.devices || []),
    pair: (mac) => bt('pair', { mac }, 90000),
    unpair: (mac) => bt('unpair', { mac }),
    services: (mac) => bt('services', { mac }, 40000).then((r) => r.services || []),
    gatt: (mac, steps) => bt('gatt', { mac, steps }, 60000).then((r) => r.results || []),
    audio: (mac, what = 'status') => call('/bt', { op: 'audio', mac, do: what }, 20000).then((r) => { if (!r) throw new Error('Bluetooth needs the tablet.'); return r; }),
    volume: (what, level) => bt('volume', { do: what, level }),
  };
}

/** What the shell found -> a device, or null for one not worth listing (no name, not paired: a phone's or tag's rotating address). */
export function toDevice(b) {
  const mac = String(b.mac || '').toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
  if (!b.name && !b.bonded) return null;
  const services = (b.services || []).map(uuid);
  const has = (s) => services.includes(s);
  const kind = b.audio === 'headphones' ? 'headphones' : b.audio ? 'speaker' : has(STD.audioSink) ? 'speaker'
    : b.major === 'phone' ? 'phone' : b.major === 'computer' ? 'computer' : b.major === 'input' ? 'input' : b.major === 'wearable' ? 'watch'
    : b.major === 'toy' ? 'toy' : b.major === 'health' || has(STD.env) ? 'sensor' : has(STD.alert) ? 'tag' : 'other';
  const maker = (b.makers || []).map((id) => MAKERS[id]).find(Boolean) || null;
  return {
    id: 'bt-' + mac.replace(/:/g, ''), transport: 'bluetooth', address: mac, mac, name: b.name || `Bluetooth device ${mac.slice(-5)}`,
    kind, maker, model: null, driver: 'bluetooth', hostname: null,
    evidence: { bt: { type: b.type, major: b.major || null, audio: b.audio || null, bonded: !!b.bonded, connected: !!b.connected, rssi: b.rssi ?? null, services, makers: b.makers || [] }, mdns: [], ssdp: [], ports: [] },
    notes: [],
  };
}

const audioOf = (d) => !!(d.evidence?.bt?.audio || d.evidence?.bt?.services?.includes(STD.audioSink)) || d.kind === 'speaker' || d.kind === 'headphones';
const gattOf = (d) => new Set([...(d.evidence?.bt?.services || []), ...(d.evidence?.bt?.gatt || []).map((s) => s.uuid)].map(uuid));
const isLe = (d) => ['le', 'dual'].includes(d.evidence?.bt?.type);

/** The standard actions a Bluetooth device has, from what it is and what it said it can do. */
export function actionsFor(d) {
  if (d.transport !== 'bluetooth' || ['phone', 'computer'].includes(d.kind)) return {};
  const bonded = !!d.evidence?.bt?.bonded;
  const svc = gattOf(d);
  const out = {
    status: { says: 'Paired or not, connected, battery and readings', async run(dev, _p, ctx) { return status(dev, ctx); } },
  };
  if (!bonded) out.pair = {
    says: 'Pair it with the tablet', risky: true, boardOk: true,
    async run(dev, _p, ctx) {
      const r = await ctx.bt.pair(dev.mac);
      if (!r.paired) throw new Error(r.why || 'It didn\'t pair.');
      Object.assign(dev.evidence.bt, { bonded: true, services: [...new Set([...(dev.evidence.bt.services || []), ...(r.services || []).map(uuid)])] });
      ctx.pairing.allowed = true; ctx.pairing.allowedAt = new Date().toISOString(); // the yes to pairing is the yes to using it
      if (isLe(dev) && !audioOf(dev)) { try { dev.evidence.bt.gatt = await ctx.bt.services(dev.mac); } catch {} }
      ctx.save();
      return `Paired with ${dev.customName || dev.name}.`;
    },
  };
  else out.forget = {
    says: 'Unpair it from the tablet', risky: true,
    async run(dev, _p, ctx) { const r = await ctx.bt.unpair(dev.mac); if (!r.unpaired) throw new Error(r.why || 'It wasn\'t forgotten.'); dev.evidence.bt.bonded = false; ctx.save(); return `Unpaired ${dev.customName || dev.name}.`; },
  };
  if (audioOf(d) && bonded) Object.assign(out, {
    play_here: { says: 'Send the tablet\'s sound (music, timers, Opie\'s answers) to it', async run(dev, _p, ctx) {
      const r = await ctx.bt.audio(dev.mac, 'connect');
      if (r.error && !r.connected) throw new Error(r.error);
      return `The tablet's sound goes to ${dev.customName || dev.name} now.`;
    } },
    stop_here: { says: 'Send the sound back to the tablet\'s own speaker', async run(dev, _p, ctx) {
      const r = await ctx.bt.audio(dev.mac, 'disconnect');
      if (r.error && r.connected) throw new Error(r.error);
      return 'The sound is back on the tablet.';
    } },
    set_volume: { says: 'Set its volume, 0 to 100', params: { level: { type: 'integer', min: 0, max: 100, required: true } }, async run(dev, p, ctx) { return volume(dev, ctx, 'set', p.level); } },
    volume_up: { says: 'A bit louder', async run(dev, _p, ctx) { return volume(dev, ctx, 'up'); } },
    volume_down: { says: 'A bit quieter', async run(dev, _p, ctx) { return volume(dev, ctx, 'down'); } },
  });
  if (svc.has(STD.alert)) Object.assign(out, {
    beep: { says: 'Make it beep, to find it', async run(dev, _p, ctx) { await ctx.bt.gatt(dev.mac, [{ write: { service: STD.alert, characteristic: STD.alertLevel, hex: '02', response: false } }]); return `${dev.customName || dev.name} is beeping.`; } },
    stop_beep: { says: 'Stop it beeping', async run(dev, _p, ctx) { await ctx.bt.gatt(dev.mac, [{ write: { service: STD.alert, characteristic: STD.alertLevel, hex: '00', response: false } }]); return 'Stopped.'; } },
  });
  return out;
}

async function volume(dev, ctx, what, level) {
  const st = await ctx.bt.audio(dev.mac, 'status');
  if (!st.routed) throw new Error(`The tablet's sound isn't going to ${dev.customName || dev.name} right now${st.connected ? '' : ' (it isn\'t connected: play_here first, or turn it on)'}.`);
  const r = await ctx.bt.volume(what, level);
  return `Volume ${r.volume}.`;
}

/** What a Bluetooth device is doing: paired, connected, where the sound goes, and its standard readings. */
async function status(dev, ctx) {
  const bt = dev.evidence?.bt || {};
  const out = { bluetooth: true, paired: !!bt.bonded };
  if (audioOf(dev)) {
    try { const a = await ctx.bt.audio(dev.mac, 'status'); Object.assign(out, { paired: a.paired, connected: a.connected, sound_here: a.routed, volume: a.routed ? a.volume : null }); bt.bonded = a.paired; } catch (e) { out.note = e.message; }
  }
  const svc = gattOf(dev);
  const steps = [];
  const reads = [];
  if (svc.has(STD.battery)) { steps.push({ read: { service: STD.battery, characteristic: STD.batteryLevel } }); reads.push(['battery', 'u8']); }
  if (svc.has(STD.env)) {
    const chars = (bt.gatt || []).find((s) => uuid(s.uuid) === STD.env)?.characteristics?.map((c) => uuid(c.uuid)) || [STD.temperature, STD.humidity];
    if (chars.includes(STD.temperature)) { steps.push({ read: { service: STD.env, characteristic: STD.temperature } }); reads.push(['temperature_c', 'i16le/100']); }
    if (chars.includes(STD.humidity)) { steps.push({ read: { service: STD.env, characteristic: STD.humidity } }); reads.push(['humidity', 'u16le/100']); }
  }
  if (steps.length && isLe(dev) && !audioOf(dev)) {
    try { const res = await ctx.bt.gatt(dev.mac, steps); reads.forEach(([k, spec], i) => { out[k] = decode(res[i]?.read, spec); }); }
    catch (e) { out.note = e.message; }
  }
  return out;
}

/** Look inside a BLE device (for a recipe): its services and characteristics, kept with it. */
export async function lookInside(dev, ctx) {
  if (!isLe(dev)) return null;
  const tree = await ctx.bt.services(dev.mac);
  dev.evidence.bt.gatt = tree;
  ctx.save();
  return tree;
}

export default {
  id: 'bluetooth', label: 'Bluetooth',
  match: (d) => d.transport === 'bluetooth',
  actionsFor,
  actions: {},
};
