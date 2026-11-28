// Home Assistant (devices/drivers/homeassistant.js, devices/ha-rules.js), against a small made-up Home Assistant, with
// the keeper as the host that keeps the token: the token never reaches the bridge or anything it says or saves; locks,
// garage doors, alarms and cameras are never reached, nor a scene that sets one; only what the household picked can be
// used.   cd bridge && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keeperHost, useHost } from '../host.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = ['eyJhbGciOiJIUzI1NiJ9', crypto.randomBytes(24).toString('base64url'), crypto.randomBytes(24).toString('base64url')].join('.');
const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes: { friendly_name: entity_id, ...attributes } });
const STATES = [
  st('light.kitchen', 'on', { friendly_name: 'Kitchen light', brightness: 255 }), st('light.porch', 'off', { friendly_name: 'Porch light' }),
  st('switch.kettle', 'off', { friendly_name: 'Kettle' }), st('media_player.living_room', 'playing', { friendly_name: 'Living room', volume_level: 0.3 }),
  st('climate.hall', 'heat', { friendly_name: 'Hall', current_temperature: 20, temperature: 21 }),
  st('scene.evening', 'scening', { friendly_name: 'Evening', entity_id: ['light.kitchen', 'light.porch'] }),
  st('scene.leaving', 'scening', { friendly_name: 'Leaving', entity_id: ['light.kitchen', 'lock.front_door'] }),
  st('lock.front_door', 'locked', { friendly_name: 'Front door' }), st('cover.garage_door', 'closed', { friendly_name: 'Garage door' }),
  st('alarm_control_panel.home', 'armed_away', { friendly_name: 'Alarm' }), st('camera.porch', 'idle', { friendly_name: 'Porch camera' }),
];
const SHUT = /^(lock|cover|alarm_control_panel|camera)\./;
let ha, haUrl, seen = [], child, host, root, port, keeperToken, devices;

before(async () => {
  // The made-up Home Assistant: the REST API's shape; it answers 401 to anything without the token, and (badly) puts the
  // header it was sent into the kitchen light's attributes.
  ha = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: b });
      const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Invalid authentication' });
      const echo = (s) => (s.entity_id === 'light.kitchen' ? { ...s, attributes: { ...s.attributes, sent: req.headers.authorization } } : s);
      if (req.url === '/api/') return send(200, { message: 'API running.' });
      if (req.url === '/api/config') return send(200, { location_name: 'Springfield', latitude: 39.8, longitude: -89.6, version: '2026.11.0' });
      if (req.url === '/api/states') return send(200, STATES.map(echo));
      const one = req.url.match(/^\/api\/states\/(.+)$/);
      if (one) { const s = STATES.find((x) => x.entity_id === one[1]); return s ? send(200, echo(s)) : send(404, { message: 'Entity not found.' }); }
      const sv = req.url.match(/^\/api\/services\/([a-z_]+)\/([a-z_]+)$/);
      if (sv && req.method === 'POST') { const s = STATES.find((x) => x.entity_id === JSON.parse(b || '{}').entity_id); return send(200, s ? [echo(s)] : []); }
      send(404, { message: 'Not found' });
    });
  });
  await new Promise((ok) => ha.listen(0, '127.0.0.1', ok));
  haUrl = `http://127.0.0.1:${ha.address().port}`;

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ha-'));
  keeperToken = crypto.randomBytes(32).toString('base64url'); port = 20000 + crypto.randomInt(20000);
  child = spawn(process.execPath, [path.join(HERE, '..', '..', 'hub', 'keeper.mjs')], { stdio: 'ignore',
    env: { ...process.env, OPENHOUSE_KEEPER_TOKEN: keeperToken, KEEPER_PORT: String(port), OPENHOUSE_DATA: path.join(root, 'data'), OPENHOUSE_KEEPER_DIR: path.join(root, 'keeper'), OPENHOUSE_KEEPER_STORE: 'file', BRIDGE_URL: 'http://127.0.0.1:9' } });
  host = useHost(await keeperHost({ url: `http://127.0.0.1:${port}`, token: keeperToken }).ready());
  process.env.DEVICES_FILE = path.join(root, 'data', 'devices.json');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const { devicesRoutes } = await import('../devices/index.js');
  devices = devicesRoutes({ HERE: path.join(root, 'data', 'bridge'), json: () => {}, body: async () => ({}) });
});
after(async () => {
  if (child) { const gone = new Promise((ok) => child.once('exit', ok)); child.kill(); await gone; }
  await new Promise((ok) => ha.close(ok));
  fs.rmSync(root, { recursive: true, force: true });
});

/** The keeper's card, answered as a person would on a settings device. */
async function answer(yes) {
  for (let i = 0; i < 100; i++) {
    const c = (await host.call('/cards')).body.cards;
    if (c.length) return host.call('/cards/answer', { id: c[0].id, yes, who: 'phone' });
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error('no card came');
}

test('the token is kept only after a yes, and never comes back', async () => {
  const no = host.call('/homeassistant/set', { url: haUrl, token: TOKEN });
  await answer(false);
  assert.equal((await no).body.ok, false);
  assert.equal((await host.call('/homeassistant/status')).body.set, false);
  assert.equal((await host.call('/homeassistant/set', { url: haUrl, token: 'x'.repeat(20) + '.' + 'y'.repeat(20) + '.' + 'z'.repeat(20) })).status, 400); // (Home Assistant didn't take it)
  const yes = host.call('/homeassistant/set', { url: haUrl, token: TOKEN });
  await answer(true);
  assert.equal((await yes).body.ok, true);
  const status = await host.call('/homeassistant/status');
  assert.deepEqual(status.body, { set: true, url: haUrl });
  assert.ok(!JSON.stringify(await host.call('/status')).includes(TOKEN));
  assert.ok(!fs.readFileSync(path.join(root, 'keeper', 'secrets.sealed')).includes(TOKEN), 'sealed');
  // An answer from Home Assistant with the token in it: taken out before the bridge sees it.
  const states = await host.call('/homeassistant', { method: 'GET', path: '/api/states' });
  assert.equal(states.ok, true);
  assert.ok(!JSON.stringify(states.body).includes(TOKEN));
  assert.equal(await devices.homeAssistantCheck().then((c) => c.set), true);
});

test('locks, garage doors, alarms, cameras, thermostat changes and a scene that sets a lock are never reached', async () => {
  seen = [];
  const call = (method, p, body) => host.call('/homeassistant', { method, path: p, body });
  const listed = (await call('GET', '/api/states')).body.answer.map((s) => s.entity_id);
  assert.ok(listed.includes('light.kitchen') && listed.includes('climate.hall'));
  assert.ok(!listed.some((e) => SHUT.test(e)), 'not even listed');
  assert.equal((await call('GET', '/api/config')).body.answer.latitude, undefined, 'only its name and version');
  for (const [m, p, b] of [
    ['POST', '/api/services/lock/unlock', { entity_id: 'lock.front_door' }], ['POST', '/api/services/cover/open_cover', { entity_id: 'cover.garage_door' }],
    ['POST', '/api/services/alarm_control_panel/alarm_disarm', { entity_id: 'alarm_control_panel.home' }], ['GET', '/api/states/lock.front_door'],
    ['GET', '/api/camera_proxy/camera.porch'], ['POST', '/api/services/climate/set_temperature', { entity_id: 'climate.hall', temperature: 30 }],
    ['POST', '/api/services/light/turn_on', { entity_id: 'lock.front_door' }], ['POST', '/api/services/light/turn_on', { entity_id: 'light.kitchen', code: '1234' }],
    ['POST', '/api/services/homeassistant/turn_on', { entity_id: 'light.kitchen' }], ['POST', '/api/template', { template: '{{ states.lock }}' }],
    ['POST', '/api/states/light.kitchen', { state: 'off' }], ['DELETE', '/api/states/light.kitchen'],
  ]) assert.equal((await call(m, p, b)).status, 403, `${m} ${p}`);
  assert.equal((await call('POST', '/api/services/scene/turn_on', { entity_id: 'scene.leaving' })).status, 403);
  assert.ok(!seen.some((s) => s.method === 'POST'), 'nothing was changed');
  assert.ok(!seen.some((s) => /lock|cover|alarm|camera|climate\/|template/.test(s.path)), 'Home Assistant never heard those asked for');
  assert.equal((await call('POST', '/api/services/scene/turn_on', { entity_id: 'scene.evening' })).ok, true, 'a scene of lights alone is fine');
});

test('only what the household picked can be used; Opie asks before picking more', async () => {
  seen = [];
  assert.equal((await devices.homeAssistant({ do: 'off', thing: 'Kitchen light' })).ok, false, 'not picked: nothing to reach');
  assert.equal((await devices.devices({ do: 'act', device: 'light.kitchen', action: 'power_off' })).ok, false);
  assert.ok(!seen.some((s) => s.method === 'POST'));
  const things = await devices.homeAssistant({ do: 'things' });
  assert.ok(things.ok && things.text.includes('<data>') && !/front door|garage|leaving/i.test(things.text), 'what could be picked, as data, without what is shut out');
  // Opie asking to use one: a card a person answers; a no leaves it as it was.
  const asked = devices.homeAssistant({ do: 'use', thing: 'Porch light' });
  await answer(false);
  assert.equal((await asked).ok, false);
  assert.equal((await devices.homeAssistant({ do: 'on', thing: 'Porch light' })).ok, false);
  // A person's own tap (the device's Devices sheet) picks the kitchen light.
  const r = await devices.homeAssistant({ do: 'use', thing: 'light.kitchen' }, { who: 'board' });
  assert.equal(r.ok, true);
  const off = await devices.homeAssistant({ do: 'off', thing: 'Kitchen light' });
  assert.equal(off.ok, true, off.text);
  assert.deepEqual(seen.filter((s) => s.method === 'POST').map((s) => [s.path, JSON.parse(s.body)]), [['/api/services/light/turn_off', { entity_id: 'light.kitchen' }]]);
  assert.equal((await devices.homeAssistant({ do: 'on', thing: 'Porch light' })).ok, false, 'still only the picked one');
  // Its state comes back as data, without the token Home Assistant echoed.
  const status = await devices.homeAssistant({ do: 'status', thing: 'Kitchen light' });
  assert.ok(status.ok && status.text.includes('<data>'));
  const saved = fs.readFileSync(process.env.DEVICES_FILE, 'utf8');
  assert.ok(saved.includes('light.kitchen'), 'the pick is kept');
  for (const t of [saved, things.text, off.text, status.text, (await devices.homeAssistant({ do: 'list' })).text]) assert.ok(!t.includes(TOKEN) && !t.includes(TOKEN.split('.')[1]));
  // Taking it back: unreachable again.
  assert.equal((await devices.homeAssistant({ do: 'stop_using', thing: 'Kitchen light' })).ok, true);
  assert.equal((await devices.homeAssistant({ do: 'on', thing: 'Kitchen light' })).ok, false);
});

test("a hub's settings page: the token goes on to the keeper and never comes back; only a settings device reaches it", async () => {
  const { settingsRoutes } = await import('../headless.js');
  const { allowed, ADMIN_SCOPES, DEFAULT_SCOPES, PHONE_SCOPES, TV_SCOPES } = await import('../screens.js');
  for (const s of [DEFAULT_SCOPES, PHONE_SCOPES.grownup, PHONE_SCOPES.kid, TV_SCOPES]) assert.equal(allowed(s, 'POST', '/hub/homeassistant/connect'), false);
  assert.equal(allowed(ADMIN_SCOPES, 'POST', '/hub/homeassistant/connect'), true);
  const said = [], secret = TOKEN.split('.').slice(1);
  const r = settingsRoutes({ call: host.call, json: (res, s, j) => { res.s = s; said.push(JSON.stringify(j)); }, body: async (req) => req.b,
    ha: devices.homeAssistantSettings, haChanged: devices.homeAssistantCheck });
  const ask = async (method, p, b) => { const res = {}; await r.handle({ method, b }, res, new URL(p, 'http://x'), 's-1'); return res.s; };
  await host.call('/homeassistant/remove');
  const connecting = ask('POST', '/hub/homeassistant/connect', { url: haUrl, token: TOKEN });
  await answer(true);
  assert.equal(await connecting, 200);
  assert.equal((await host.call('/homeassistant/status')).body.set, true);
  assert.equal(await ask('GET', '/hub/homeassistant'), 200);
  assert.equal(await ask('GET', '/hub/homeassistant/things'), 200);
  assert.equal(await ask('POST', '/hub/homeassistant/use', { entity: 'light.porch', use: true }), 200);
  assert.ok(said.some((j) => j.includes('light.porch')));
  for (const j of said) assert.ok(!secret.some((x) => j.includes(x)), 'never in an answer to the page');
  assert.ok(!secret.some((x) => fs.readFileSync(process.env.DEVICES_FILE, 'utf8').includes(x)), 'never in what the bridge keeps');
});
