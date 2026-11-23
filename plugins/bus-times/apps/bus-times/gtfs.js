// Reading a transit agency's open data: GTFS-realtime (protobuf: the trips' next stops and when the buses get there)
// and static GTFS (a zip of CSV files: the stops' names, the routes'). Just what Bus times needs, no libraries.
// No page or kit here, so it runs the same in a test.

// ---- protobuf: the few GTFS-realtime messages Bus times reads ----
function reader(buf) {
  let i = 0;
  const varint = () => { let x = 0, m = 1, b; do { b = buf[i++]; x += (b & 0x7f) * m; m *= 128; } while (b & 0x80 && i < buf.length); return x; };
  return {
    done: () => i >= buf.length,
    /** The next field: {n: its number, w: wire type, v: a number or bytes}. */
    next() {
      const tag = varint(), n = Math.floor(tag / 8), w = tag & 7;
      if (w === 0) return { n, w, v: varint() };
      if (w === 2) { const len = varint(), v = buf.subarray(i, i + len); i += len; return { n, w, v }; }
      if (w === 1) { const v = buf.subarray(i, i + 8); i += 8; return { n, w, v }; }
      if (w === 5) { const v = buf.subarray(i, i + 4); i += 4; return { n, w, v }; }
      throw new Error('not GTFS-realtime');
    },
  };
}
const text = (b) => new TextDecoder().decode(b);
const each = (buf, fn) => { const r = reader(buf); while (!r.done()) fn(r.next()); };

/**
 * A TripUpdates feed's arrivals at the stops asked for: [{stop, route, at (ms)}], soonest first. Arrivals with only a
 * delay (no time) are left out: they'd need the timetable.
 */
export function arrivals(buf, stops, now = Date.now()) {
  const want = new Set(stops.map(String)), out = [];
  each(buf, (f) => {
    if (f.n !== 2 || f.w !== 2) return; // FeedMessage.entity
    each(f.v, (e) => {
      if (e.n !== 3 || e.w !== 2) return; // FeedEntity.trip_update
      let route = '';
      const updates = [];
      each(e.v, (t) => {
        if (t.n === 1 && t.w === 2) each(t.v, (d) => { if (d.n === 5 && d.w === 2) route = text(d.v); }); // TripDescriptor.route_id
        if (t.n === 2 && t.w === 2) { // StopTimeUpdate
          const u = { stop: '', at: 0 };
          each(t.v, (s) => {
            if (s.n === 4 && s.w === 2) u.stop = text(s.v);
            if ((s.n === 2 || s.n === 3) && s.w === 2) each(s.v, (ev) => { if (ev.n === 2 && ev.w === 0 && (!u.at || s.n === 2)) u.at = ev.v * 1000; }); // arrival (else departure) time
          });
          updates.push(u);
        }
      });
      for (const u of updates) if (want.has(u.stop) && u.at && u.at > now - 60e3) out.push({ stop: u.stop, route, at: u.at });
    });
  });
  return out.sort((a, b) => a.at - b.at);
}

// ---- zip: the static GTFS's files ----
/** The names in a zip and a way to read each: { names, read(name) -> Promise<string> }. */
export function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const files = new Map();
  for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nameLen = dv.getUint16(p + 28, true);
    const extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = text(buf.subarray(p + 46, p + 46 + nameLen)).replace(/^.*\//, '');
    files.set(name, { method, size, local });
    p += 46 + nameLen + extra + comment;
  }
  return {
    names: [...files.keys()],
    async read(name) {
      const f = files.get(name); if (!f) return null;
      const at = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
      const raw = buf.subarray(at, at + f.size);
      if (f.method === 0) return text(raw);
      if (f.method !== 8) throw new Error('an unknown zip');
      const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(s).text();
    },
  };
}

/** A CSV file's rows as objects, by its header. */
export function csv(t) {
  const rows = [], row = []; let cell = '', q = false;
  const s = t.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row.splice(0)); else row.length = 0; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row.splice(0)); }
  const head = (rows.shift() || []).map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** From a static GTFS zip: { stops: [[id, code, name]], routes: {id: short name} } (the ones riders use). */
export async function stopsAndRoutes(buf) {
  const z = unzip(buf);
  const st = csv((await z.read('stops.txt')) || '');
  const rt = csv((await z.read('routes.txt')) || '');
  return {
    stops: st.filter((s) => !s.location_type || s.location_type === '0').map((s) => [s.stop_id, s.stop_code || '', s.stop_name || s.stop_id]),
    routes: Object.fromEntries(rt.map((r) => [r.route_id, r.route_short_name || r.route_long_name || r.route_id])),
  };
}
