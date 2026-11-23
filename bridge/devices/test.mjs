// Checks for the parts that must hold without a network: DNS parsing, recipe checking, and a
// recipe run against a small fake device on this machine.   node bridge/devices/test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import * as D from './dns.js';
import * as R from './recipe.js';
import { getAttributes, parse as ippParse } from './drivers/ipp.js';

let n = 0;
const ok = (name, f) => Promise.resolve().then(f).then(() => { n++; console.log('ok', name); }, (e) => { console.error('FAIL', name, '\n', e); process.exitCode = 1; });

// --- DNS ---
await ok('dns: a query parses back', () => {
  const q = D.query([{ name: '_sonos._tcp.local', type: D.T.PTR }]);
  const p = D.parse(q);
  assert.deepEqual(p.questions, ['_sonos._tcp.local']);
  assert.equal(p.isResponse, false);
});
await ok('dns: answers with compression, TXT, SRV, A', () => {
  // a hand-built response: PTR _x._tcp.local -> "Den._x._tcp.local", SRV, TXT, A
  const name = (s) => Buffer.concat([...s.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const rr = (n, type, data) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(120, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([n, h, data]); };
  const head = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0]);
  const ptrName = name('_x._tcp.local');
  // instance name "Den" + pointer to offset 12 (where _x._tcp.local starts)
  const inst = Buffer.concat([Buffer.from([3]), Buffer.from('Den'), Buffer.from([0xc0, 12])]);
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x1f, 0x90]), name('den.local')]);
  const txt = Buffer.concat([Buffer.from([7]), Buffer.from('md=Lamp'), Buffer.from([4]), Buffer.from('flag')]);
  const pkt = Buffer.concat([head, rr(ptrName, D.T.PTR, inst), rr(inst, D.T.SRV, srv), rr(inst, D.T.TXT, txt), rr(name('den.local'), D.T.A, Buffer.from([10, 0, 0, 9]))]);
  const p = D.parse(pkt);
  assert.equal(p.answers[0].data, 'Den._x._tcp.local');
  assert.equal(p.answers[1].data.port, 8080);
  assert.deepEqual(p.answers[2].data, { md: 'Lamp', flag: true });
  assert.equal(p.answers[3].data, '10.0.0.9');
});

// --- IPP ---
await ok('ipp: request encodes, response decodes with additional values', () => {
  const b = getAttributes('ipp://10.0.0.5:631/ipp/print', ['marker-levels']);
  assert.equal(b.readUInt16BE(2), 0x0b);
  const attr = (tag, nm, v) => { const nb = Buffer.from(nm); const h = Buffer.alloc(3); h[0] = tag; h.writeUInt16BE(nb.length, 1); const l = Buffer.alloc(2); l.writeUInt16BE(v.length); return Buffer.concat([h, nb, l, v]); };
  const int = (x) => { const v = Buffer.alloc(4); v.writeInt32BE(x); return v; };
  const res = Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 0x04]), attr(0x21, 'marker-levels', int(80)), attr(0x21, '', int(-1)), attr(0x23, 'printer-state', int(3)), Buffer.from([3])]);
  assert.deepEqual(ippParse(res).attrs, { 'marker-levels': [80, -1], 'printer-state': [3] });
});

// --- recipes ---
const wled = {
  id: 'wled-kitchen', name: 'Kitchen light strip', maker: 'WLED', kind: 'light',
  sources: ['https://kno.wled.ge/interfaces/json-api/'],
  find: [{ address: '10.0.0.50' }, { bonjour: '_wled._tcp' }],
  actions: {
    turn_off: { says: 'Turn the strip off', request: { http: { method: 'POST', port: 80, path: '/json/state', json: { on: false } } } },
    turn_on: { says: 'Turn the strip on', request: { http: { method: 'POST', port: 80, path: '/json/state', json: { on: true } } } },
    set_brightness: { says: 'Brightness 0-255', params: { level: { type: 'integer', min: 0, max: 255, required: true } },
      request: { http: { method: 'POST', port: 80, path: '/json/state', json: { bri: '{level}' } } } },
    status: { says: 'On or off', request: { http: { port: 80, path: '/json/state' } }, read: { on: 'on', brightness: 'bri' } },
  },
};
await ok('recipe: a good one passes', () => assert.deepEqual(R.validate(wled), []));
await ok('recipe: risky words make it ask, whatever it says', () => {
  assert.equal(R.isRisky('turn_on', wled.actions.turn_on), true);
  assert.equal(R.isRisky('turn_off', wled.actions.turn_off), false);
  assert.equal(R.isRisky('front', { says: 'Unlock the front door', risky: false }), true);
});
const bad = (patch, want) => {
  const r = structuredClone(wled); patch(r);
  const errs = R.validate(r);
  assert.ok(errs.some((e) => e.includes(want)), `expected "${want}" in ${JSON.stringify(errs)}`);
};
await ok('recipe: no other hosts', () => {
  bad((r) => { r.actions.turn_off.request.http.host = 'evil.example'; }, 'unknown field "host"');
  bad((r) => { r.actions.turn_off.request.http.path = '//evil.example/x'; }, 'path');
  bad((r) => { r.actions.turn_off.request.http.path = 'http://evil.example/'; }, 'path');
  bad((r) => { r.find = [{ address: '8.8.8.8' }]; }, 'home network');
});
await ok('recipe: no code, no unknown fields or placeholders', () => {
  bad((r) => { r.actions.turn_off.run = 'require("child_process")'; }, 'unknown field "run"');
  bad((r) => { r.actions.turn_off.request.http.path = '/x/{cmd}'; }, '"{cmd}" isn\'t one of');
  bad((r) => { r.actions.set_brightness.params.level.type = 'function'; }, 'string, integer');
  bad((r) => { r.actions.turn_off.request.http.headers = { 'X-A': 'b\r\nHost: evil' }; }, 'one-line');
  bad((r) => { r.actions.turn_off.request.http.headers = { Host: 'evil' }; }, "can't be set");
  bad((r) => { r.actions.set_brightness.params.name = { type: 'string' }; }, 'maxLength');
  bad((r) => { r.kind = 'rocket'; }, 'kind');
});
await ok('recipe: parameters are checked before anything is sent', () => {
  assert.match(R.checkParams(wled.actions.set_brightness.params, { level: 999 }).error, /at most 255/);
  assert.match(R.checkParams(wled.actions.set_brightness.params, {}).error, /needed/);
  assert.match(R.checkParams(wled.actions.set_brightness.params, { level: 9, x: 1 }).error, /unknown parameter/);
  assert.deepEqual(R.checkParams(wled.actions.set_brightness.params, { level: '42' }).values, { level: 42 });
});

// A fake WLED on this machine's own home-network address (recipes only reach private addresses).
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))?.address;
if (lan) {
  const state = { on: true, bri: 128 };
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: b, type: req.headers['content-type'] });
      if (req.url === '/json/state' && req.method === 'POST') Object.assign(state, JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state));
    });
  });
  await new Promise((r) => srv.listen(0, lan, r));
  const port = srv.address().port;
  const r = structuredClone(wled);
  for (const a of Object.values(r.actions)) a.request.http.port = port;
  await ok('recipe: runs against a device, keeping parameter types', async () => {
    assert.deepEqual(R.validate(r), []);
    await R.run(r, 'set_brightness', lan, { level: 42 });
    assert.equal(seen.at(-1).body, '{"bri":42}');
    assert.equal(seen.at(-1).type, 'application/json');
    assert.deepEqual(await R.run(r, 'status', lan, {}), { on: true, brightness: 42 });
    await R.run(r, 'turn_off', lan, {});
    assert.equal(state.on, false);
  });
  await ok('recipe: will not run against a public address', () => assert.rejects(R.run(r, 'status', '8.8.8.8', {}), /home network/));
  srv.close();
} else console.log('skip: no home-network address for the fake device');
console.log(`${n} passed`);
