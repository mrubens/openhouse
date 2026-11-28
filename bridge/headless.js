// What a host with no screen of its own (host.js: the keeper, on a hub) needs from the bridge, which a tablet's shell
// does on its screen: its cards shown on the settings devices and adults' phones ('cards'), its setup's steps
// driven here (the tablet's Setup.kt does it there), and its settings behind the PIN on those devices. Turned on by
// the host's capabilities (server.js), never by which host it is. Everything kept is the host's (host.call).
//
//   GET  /hub/asks                      the host's cards waiting for a yes (a settings device, an adult's phone)
//   POST /hub/asks/answer {id, yes, later?, pin?}   a person's answer; a card that needs the PIN needs it here too
//   GET  /hub/keeper                    what's kept (only how many, and whether): {openai, pin, calendars, albums}
//   POST /hub/pin {pin, old?}           set or change the PIN (the old one first, once there is one)
//   POST /hub/unlock {pin}              this settings device may change settings for 10 minutes (once a PIN is set)
//   POST /hub/calendar/remove {id}, /hub/album/remove {id}, /hub/openai/remove (the household's own key out)
//   GET  /hub/calendars                 the calendars and albums kept, without their links, and the signed-in accounts
//   POST /hub/google {refresh} | {token}   what Google's sign-in sent back: a calendar account, or photos to pick
//   GET  /hub/google-photos             how picking from Google Photos is going   POST /hub/calendar/account/remove {id}
//   POST /hub/homeassistant {url, token}  connect Home Assistant: the keeper checks the token, then waits for a yes on a
//                                       card with the PIN; it answers once that's answered (what Opie may use is picked
//                                       with /devices/homeassistant, devices/index.js)
import fs from 'node:fs';
import path from 'node:path';

/** The setup, driven here: the steps the settings device shows (chat/src/setup-flow.jsx), and where it is. */
export const SETUP_STEPS = ['people', 'place', 'calendar', 'photos', 'pin'];
export function setupSteps({ DISPLAY, household = () => ({}), hasPin = async () => true }) {
  const FILE = path.join(DISPLAY, 'hub-setup.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
  const write = (v) => { try { fs.writeFileSync(FILE, JSON.stringify(v)); } catch {} };
  /** Where the setup is: a step, or null once it's done (or the household was there before this hub had a setup). */
  function step() {
    let s = read();
    if (!s) { s = (household().family || []).length ? { done: true } : { step: 'people' }; write(s); }
    return s.done ? null : SETUP_STEPS.includes(s.step) ? s.step : 'people';
  }
  /** Its Next: a step, or anything past the last ('android' on the tablet) ends it, once a PIN is set (as a tablet's
   *  setup doesn't go past its PIN without one). */
  async function go(s) {
    if (SETUP_STEPS.includes(s)) write({ step: s });
    else if (/^[a-z]{1,20}$/.test(String(s || '')) && await hasPin()) write({ done: true });
  }
  return { step, go };
}

/** The routes for its settings devices (screens.js 'admin'). call: host.call. unlocked: device id -> until. */
export function settingsRoutes({ call, cloud, json, body, now = Date.now }) {
  const keeper = (p, b = {}, ms) => call(p, b, ms ? { ms } : {}).then((r) => r || { ok: false, status: 0, body: {} });
  const unlocked = new Map();
  let pinSet = false;
  const refresh = async () => { const r = await keeper('/status'); if (r.ok) pinSet = !!r.body?.pin; return r; };
  refresh();
  /** The keeper's answer for this device's try: {ok, error?} (it counts wrong tries per device, and makes them wait). */
  const pinCheck = async (pin, who) => (await keeper('/pin/check', { pin, who: String(who || '') })).body || {};
  const pinOk = async (pin, who) => (await pinCheck(pin, who)).ok === true;
  /** May this settings device change settings now? Always while no PIN is set; else for 10 minutes after the PIN. */
  const open = (id) => !pinSet || (unlocked.get(id) || 0) > now();
  async function handle(req, res, url, deviceId) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/hub/asks') { const r = await keeper('/cards', {}, 5000); json(res, 200, { asks: r.body?.cards || [] }); return true; }
    if (req.method === 'POST' && p === '/hub/asks/answer') {
      const b = await body(req);
      const r = await keeper('/cards/answer', { id: String(b.id || ''), yes: b.yes === true, later: b.later === true, pin: String(b.pin || '').slice(0, 8), who: deviceId }, 10e3);
      json(res, r.ok ? 200 : 400, r.body || {}); return true;
    }
    if (req.method === 'GET' && p === '/hub/keeper') { const r = await refresh(); json(res, r.ok ? 200 : 503, r.ok ? { ...r.body, locked: !open(deviceId) } : { error: r.body?.error || "The hub's keeper isn't running." }); return true; }
    if (req.method === 'POST' && p === '/hub/unlock') {
      const b = await body(req);
      const c = await pinCheck(String(b.pin || ''), deviceId);
      if (c.ok !== true) { json(res, 403, { error: c.wait ? c.error : 'That PIN isn\'t right.' }); return true; }
      unlocked.set(deviceId, now() + 10 * 60e3); json(res, 200, { ok: true }); return true;
    }
    if (req.method === 'POST' && p === '/hub/pin') {
      const b = await body(req);
      const c = pinSet ? await pinCheck(String(b.old || ''), deviceId) : { ok: true };
      if (c.ok !== true) { json(res, 403, { error: c.wait ? c.error : 'The PIN now isn\'t right.' }); return true; }
      const r = await keeper('/pin/set', { pin: String(b.pin || '') });
      await refresh();
      json(res, r.ok ? 200 : r.status || 503, r.body || {}); return true;
    }
    if (req.method === 'GET' && p === '/hub/calendars') {
      const [c, a, s] = await Promise.all([keeper('/calendar/list'), keeper('/album/list'), keeper('/calendar/accounts')]);
      json(res, 200, { calendars: c.body?.calendars || [], albums: a.body?.albums || [], accounts: s.body?.accounts || [] }); return true;
    }
    // What Google's sign-in sent back to this settings device (#gc=… a calendar's refresh token, #g=… a photos token).
    if (req.method === 'POST' && p === '/hub/google') {
      const b = await body(req);
      const r = b.refresh ? await keeper('/calendar/account/google', { refresh: String(b.refresh) }) : await keeper('/photos/google', { token: String(b.token || '') });
      json(res, r.ok ? 200 : 400, r.body || {}); return true;
    }
    if (req.method === 'GET' && p === '/hub/google-photos') { const r = await keeper('/photos/google/status'); json(res, 200, r.body || {}); return true; }
    if (req.method === 'POST' && p === '/hub/calendar/account/remove') { const r = await keeper('/calendar/account/remove', { id: String((await body(req)).id || '') }); json(res, r.ok ? 200 : 400, r.body || {}); return true; }
    if (req.method === 'POST' && p === '/hub/homeassistant') {
      const b = await body(req);
      const r = await keeper('/homeassistant/set', { url: String(b.url || '').slice(0, 300), token: String(b.token || '').slice(0, 2000), from: 'the settings page' }, 100e3);
      json(res, r.ok ? 200 : r.status || 503, r.body || {}); return true;
    }
    if (req.method === 'POST' && p === '/hub/openai/remove') { const r = await keeper('/ownkey/remove'); json(res, r.ok ? 200 : 503, r.ok ? { ok: true } : r.body || {}); return true; }
    if (req.method === 'POST' && /^\/hub\/(calendar|album)\/remove$/.test(p)) { const r = await keeper(p.slice(4), { id: String((await body(req)).id || '') }); json(res, r.ok ? 200 : 400, r.body || {}); return true; }
    return false;
  }
  return { handle, open, pinOk, hasPin: () => pinSet, refresh, keeper, lock: (id) => unlocked.delete(id) };
}
