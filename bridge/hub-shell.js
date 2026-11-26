// What stands in for the tablet's shell on a hub (docs/hub.md), behind shell-call.js toShell: the keeper
// (hub/keeper.mjs, its own process and folder) keeps the links, the OpenAI key and the PIN; the settings devices
// answer the "Is this OK?" cards; the hub's bridge drives its own setup (the tablet's Setup.kt does it there).
//
//   GET  /hub/asks                      the cards waiting for a yes (a settings device)
//   POST /hub/asks/answer {id, yes, later?, pin?}   a person's answer; a card that needs the PIN needs it here too
//   GET  /hub/keeper                    what's kept (only how many, and whether): {openai, pin, calendars, albums}
//   POST /hub/pin {pin, old?}           set or change the PIN (the old one first, once there is one)
//   POST /hub/unlock {pin}              this settings device may change settings for 10 minutes (once a PIN is set)
//   POST /hub/calendar/remove {id}, /hub/album/remove {id}, /hub/openai/remove (the household's own key out)
//   GET  /hub/calendars                 the calendars and albums kept, without their links, and the signed-in accounts
//   POST /hub/google {refresh} | {token}   what Google's sign-in sent back: a calendar account, or photos to pick
//   GET  /hub/google-photos             how picking from Google Photos is going   POST /hub/calendar/account/remove {id}
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A call to the keeper: { ok, status, body } as toShell answers, or status 0 when it isn't there. */
export function keeperClient({ url = process.env.OPENHOUSE_KEEPER, token = process.env.OPENHOUSE_KEEPER_TOKEN } = {}) {
  const call = async (p, b = {}, ms = 130e3) => {
    if (!url || !token) return { ok: false, status: 0, body: { error: "The hub's keeper isn't running." } };
    try {
      const r = await fetch(url + p, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(ms) });
      let body = null; try { body = await r.json(); } catch {}
      return { ok: r.ok, status: r.status, body };
    } catch { return { ok: false, status: 0, body: { error: "The hub's keeper didn't answer." } }; }
  };
  call.there = () => !!(url && token);
  return call;
}

/** The cards: each waits for a settings device's answer, as the tablet's ApprovalCard waits for a tap. */
export function hubAsks({ hasPin, pinOk, now = Date.now, log = (...a) => console.log('[asks]', ...a) }) {
  const waiting = new Map(); // id -> { card, done, until, timer }
  function ask(b = {}) {
    const id = crypto.randomBytes(6).toString('hex');
    const waitMs = Math.max(10e3, Math.min(600e3, Number(b.waitMs) || 90e3));
    const t = (v, n) => String(v ?? '').slice(0, n);
    const card = { id, title: t(b.title, 200), detail: t(b.detail, 800), more: b.more ? t(b.more, 2000) : null, yes: t(b.yes, 20).trim() || 'Allow', no: t(b.no, 24).trim() || null,
      rights: Array.isArray(b.rights) ? b.rights.slice(0, 12).map((r) => ({ kind: t(r?.kind, 20), text: t(r?.text, 300) })) : [], danger: !!b.danger, later: !!b.later,
      pin: !!b.grownup || !!b.pin }; // (the card says whether the PIN is asked: only once one is set, below)
    return new Promise((resolve) => {
      const done = (a) => { const w = waiting.get(id); if (!w) return; clearTimeout(w.timer); waiting.delete(id); resolve(a); };
      waiting.set(id, { card, done, until: now() + waitMs, timer: setTimeout(() => done({ yes: false, answered: false }), waitMs) });
      log(`a card is waiting (${waitMs / 1000} s)`);
    });
  }
  const list = () => [...waiting.values()].map((w) => ({ ...w.card, pin: w.card.pin && hasPin(), until: w.until }));
  async function answer(b = {}) {
    const w = waiting.get(String(b.id || ''));
    if (!w) return { error: 'That question is no longer waiting.' };
    if (b.yes === true && w.card.pin && hasPin() && !(await pinOk(String(b.pin || '')))) return { error: 'That PIN isn\'t right.', pin: true };
    w.done(b.yes === true ? { yes: true, answered: true } : b.later === true ? { yes: false, answered: false } : { yes: false, answered: true });
    return { ok: true };
  }
  return { ask, list, answer, count: () => waiting.size };
}

/** The hub's setup, driven here: the steps the settings device shows (chat/src/setup-flow.jsx), and where it is. */
export const HUB_STEPS = ['people', 'place', 'calendar', 'photos', 'ai', 'pin', 'voice'];
export function hubSetup({ DISPLAY, household = () => ({}) }) {
  const FILE = path.join(DISPLAY, 'hub-setup.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
  const write = (v) => { try { fs.writeFileSync(FILE, JSON.stringify(v)); } catch {} };
  /** Where the setup is: a step, or null once it's done (or the household was there before this hub had a setup). */
  function step() {
    let s = read();
    if (!s) { s = (household().family || []).length ? { done: true } : { step: 'people' }; write(s); }
    return s.done ? null : HUB_STEPS.includes(s.step) ? s.step : 'people';
  }
  /** Its Next: a step, or anything past the last ('android' on the tablet) ends it. */
  function go(s) { if (HUB_STEPS.includes(s)) write({ step: s }); else if (/^[a-z]{1,20}$/.test(String(s || ''))) write({ done: true }); }
  return { step, go };
}

/**
 * The shell's paths, answered on a hub. Every other path is null (no shell here), as on a laptop.
 * keeper: keeperClient(); asks: hubAsks(); setup: hubSetup(); cloud: cloud.js routes (setOwn, voiceOn, status).
 */
export function hubShell({ keeper, asks, setup, cloud }) {
  const ok = (body, status = 200) => ({ ok: status < 300, status, body });
  const host = (u) => { try { return new URL(String(u).replace(/^webcals?:/i, 'https:')).host; } catch { return ''; } };
  return async (p, b) => {
    switch (p) {
      case '/approve': return ok(await asks.ask(b));
      case '/calendar': case '/album': {
        // A link from the assistant or a computer: a person says yes on a settings device first (the setup's own are trusted).
        if (!b.trusted) {
          const a = await asks.ask({ title: p === '/calendar' ? `Add ${b.name || (b.who ? `${b.who}'s calendar` : 'this calendar')}?` : 'Add this iCloud shared album?',
            detail: [host(b.url), b.from ? `Sent by ${b.from}.` : ''].filter(Boolean).join('\n'), yes: 'Add', pin: p === '/album', waitMs: 95e3 });
          if (!a.yes) return ok({ added: false });
        }
        return keeper(p, { url: b.url, who: b.who, name: b.name, only: b.only });
      }
      case '/openai': return keeper('/openai', { kind: b.kind, body: b.body });
      case '/ownkey': {
        const r = await keeper('/ownkey', { key: b.key });
        if (r.ok && r.body?.added) await cloud.setOwn(true);
        return r;
      }
      case '/setup/pin': {
        if (setup.step() !== 'pin') return ok({ error: 'The PIN can be chosen here only during the setup, before one is set.' }, 409);
        return keeper('/pin/set', { pin: b.pin, only_if_none: true });
      }
      case '/setup/voice': {
        if (b.do === 'sample') return ok({ ok: true }); // (a hub has no speaker of its own to say it)
        try { const v = await cloud.voiceOn(b.voice); return ok(v.on ? { on: true } : { on: false, notYet: true }); }
        catch (e) { return ok({ error: e.message }, 400); }
      }
      // Two-way calendars: the sign-ins are the keeper's; the bridge's calendar-sync.js asks it for every request.
      case '/calendar/accounts': case '/calendar/request': return keeper(p, b, 60e3);
      case '/setup/icloud': return keeper('/calendar/account/caldav', { user: b.user, pass: b.pass, who: b.who });
      // Google (calendars, or photos to pick): the sign-in opens on the settings device and comes back to the hub's own
      // address there (r), which hands it to the settings page (chat/hub-back.js), which hands it here sealed (/hub/google).
      case '/setup/google': {
        const g = await cloud.googleStart(b.r, b.kind === 'photos' ? undefined : 'cal');
        return ok(g.json.url ? { url: g.json.url } : { error: g.json.error === 'r' ? 'Open this page at the hub\'s http:// address to sign in to Google.' : g.json.error === 'unlinked' ? 'Link the hub to your Opie account first.' : 'Google isn\'t available right now. Try again later.' }, g.json.url ? 200 : 409);
      }
      default: return null;
    }
  };
}

/** The hub's own routes for its settings devices (screens.js 'admin'). unlocked: device id -> until. */
export function hubShellRoutes({ keeper, asks, cloud, json, body, now = Date.now }) {
  const unlocked = new Map();
  let pinSet = false;
  const refresh = async () => { const r = await keeper('/status'); if (r.ok) pinSet = !!r.body?.pin; return r; };
  refresh();
  const pinOk = async (pin) => (await keeper('/pin/check', { pin })).body?.ok === true;
  /** May this settings device change settings now? Always while no PIN is set; else for 10 minutes after the PIN. */
  const open = (id) => !pinSet || (unlocked.get(id) || 0) > now();
  async function handle(req, res, url, deviceId) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/hub/asks') { json(res, 200, { asks: asks.list() }); return true; }
    if (req.method === 'POST' && p === '/hub/asks/answer') { const r = await asks.answer(await body(req)); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'GET' && p === '/hub/keeper') { const r = await refresh(); json(res, r.ok ? 200 : 503, r.ok ? { ...r.body, locked: !open(deviceId) } : { error: r.body?.error || "The hub's keeper isn't running." }); return true; }
    if (req.method === 'POST' && p === '/hub/unlock') {
      const b = await body(req);
      if (!(await pinOk(String(b.pin || '')))) { json(res, 403, { error: 'That PIN isn\'t right.' }); return true; }
      unlocked.set(deviceId, now() + 10 * 60e3); json(res, 200, { ok: true }); return true;
    }
    if (req.method === 'POST' && p === '/hub/pin') {
      const b = await body(req);
      if (pinSet && !(await pinOk(String(b.old || '')))) { json(res, 403, { error: 'The PIN now isn\'t right.' }); return true; }
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
    if (req.method === 'POST' && p === '/hub/openai/remove') { const r = await keeper('/ownkey/remove'); if (r.ok) await cloud.setOwn(false); json(res, r.ok ? 200 : 503, r.ok ? { ok: true } : r.body || {}); return true; }
    if (req.method === 'POST' && /^\/hub\/(calendar|album)\/remove$/.test(p)) { const r = await keeper(p.slice(4), { id: String((await body(req)).id || '') }); json(res, r.ok ? 200 : 400, r.body || {}); return true; }
    return false;
  }
  return { handle, open, pinOk, hasPin: () => pinSet, refresh, lock: (id) => unlocked.delete(id) };
}
