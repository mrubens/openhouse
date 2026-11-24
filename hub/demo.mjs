#!/usr/bin/env node
// The demo household (docs/iphone-app.md, "The demo household"): a hub with the sample household in it, and a phone of
// Sam's whose cloud link goes in App Store review notes, so someone with no tablet can use the iPhone app for real.
//
//   node hub/demo.mjs --data <the hub's data folder>
//
// Run it from a checkout on the hub's own machine (it talks to the bridge on 127.0.0.1), once the hub is linked to its
// cloud account (the settings page, Link to the cloud). The first run fills in the household, turns on Reach from away
// and joins Sam's phone; later runs only put the coming two weeks' dinners in, so run it daily (cron or launchd) and
// the week never looks empty. The link is written to <data>/demo-link.txt; --new-phone joins a new phone for it (to
// end the old link, remove the old phone on the settings page).
//   PORT, SCREENS_PORT  the bridge's (8787) and the home network's (8788) ports, as hub/start.sh has them
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const DATA = opt('--data') || process.env.OPENHOUSE_DATA;
if (!DATA) { console.error('Usage: node hub/demo.mjs --data <the hub\'s data folder> [--new-phone]'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { pair, client } = await import(path.join(HERE, '../chat/src/screen-client.js'));

const TOKEN = fs.readFileSync(path.join(DATA, '.bridge-token'), 'utf8').trim();
const BRIDGE = `http://127.0.0.1:${process.env.PORT || 8787}`, LAN = `http://127.0.0.1:${process.env.SCREENS_PORT || 8788}`;
const STATE = path.join(DATA, 'demo.json'), LINK = path.join(DATA, 'demo-link.txt');
const H = { 'x-openhouse-token': TOKEN, 'content-type': 'application/json' };
const call = async (m, p, b) => {
  const r = await fetch(BRIDGE + p, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${j.error || ''}`);
  return j;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } })();
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

// A day this week at a time, local: the weekly events start from the last week so they're already going.
const on = (wd, h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() - 7 + ((wd - d.getDay() + 7) % 7)); return d; };
const span = (wd, h, m, mins) => { const s = on(wd, h, m); return { start: s.toISOString(), end: new Date(+s + mins * 60e3).toISOString() }; };

if (!state.household) {
  await call('POST', '/household', { family: [{ name: 'Sam' }, { name: 'Alex' }, { name: 'Maya', note: '9' }, { name: 'Leo', note: '6' }], location: 'Springfield' });
  const events = [
    ['Swim practice', 'Maya', 1, 16, 30, 60], ['Soccer', 'Leo', 2, 17, 0, 60], ['Piano lesson', 'Maya', 3, 15, 45, 45],
    ['Book club', 'Sam', 4, 19, 30, 90], ['Pizza night', null, 5, 18, 0, 90], ['Farmers market', 'Alex', 6, 9, 0, 120],
    ['Grandma visits', null, 0, 12, 0, 240],
  ];
  for (const [title, who, wd, h, m, mins] of events) await call('POST', '/house/event', { add: { title, ...(who ? { who } : {}), ...span(wd, h, m, mins), repeat: 'weekly' } });
  for (const [who, task] of [['Maya', 'Feed the cat'], ['Leo', 'Unload dishwasher'], ['Maya', 'Practice piano'], ['Leo', 'Tidy bedroom'], ['Sam', 'Recycling out'], ['Alex', 'Water plants']])
    await call('POST', '/house/chore', { add: { who, task } });
  await call('POST', '/house/list', { list: 'groceries', add: ['Milk', 'Eggs', 'Apples', 'Tortillas', 'Coffee', 'Spinach', 'Bananas'] });
  state.household = new Date().toISOString(); save();
  console.log('[demo] the sample household is in');
}

// Dinners for the coming two weeks (each run puts them in again, so it stays current).
const DINNERS = ['Tacos', 'Spaghetti and meatballs', 'Chicken stir-fry', 'Leftovers', 'Homemade pizza', 'Grilled salmon', 'Pancakes for dinner'];
for (let i = 0; i < 14; i++) {
  const d = new Date(); d.setDate(d.getDate() + i);
  await call('POST', '/house/meal', { date: d.toLocaleDateString('sv'), text: DINNERS[(d.getDay() + 6) % 7] });
}

// Reach from away, and Sam's phone: its cloud link is what the app takes, pasted, with no home Wi-Fi.
if (!state.link || args.includes('--new-phone')) {
  const r = await call('GET', '/relay');
  if (!r.linked) { console.error('[demo] the hub isn\'t linked to a cloud account yet: link it on its settings page, then run this again.'); process.exit(1); }
  await call('POST', '/relay', { on: true });
  let up = false;
  for (let i = 0; i < 60 && !(up = (await call('GET', '/relay')).connected); i++) await wait(500);
  if (!up) { console.error('[demo] the relay didn\'t connect in 30 s:', (await call('GET', '/relay')).error || 'no answer'); process.exit(1); }
  const p = await call('POST', '/screens/pair', { kind: 'phone', person: 'Sam', grownup: true });
  const me = await pair({ base: LAN, pair: p.pair, key: p.key, name: 'Demo iPhone' });
  if (me.refused || !me.id) throw new Error('the hub refused the demo phone');
  const c = client({ base: LAN, id: me.id, key: me.key });
  const relay = (await c.json('GET', '/relay/me')).json;
  if (!relay?.page) throw new Error('no cloud page for the phone: ' + JSON.stringify(relay));
  const about = Buffer.from(JSON.stringify({ person: me.person, scopes: me.scopes, kind: 'phone' })).toString('base64url');
  state.link = `${relay.page}#${me.id}.${me.key}.${relay.relay}.${relay.token}.${about}`;
  state.phone = me.id; save();
  fs.writeFileSync(LINK, state.link + '\n', { mode: 0o600 });
  console.log(`[demo] Sam's phone joined (${me.id})`);
}
console.log(`[demo] the link for the app (in ${LINK}):\n${state.link}`);
