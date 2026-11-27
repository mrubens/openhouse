// The bridge's host (docs/host.md): whatever the bridge runs on, which keeps what the bridge must not (the household's
// links, its own OpenAI key, the PIN), asks people "Is this OK?", and does what only the device can (Bluetooth, apps,
// the camera). The bridge talks to every host the same way: POST a path with JSON, get { ok, status, body } back, and
// ask what it can do with host.can(). It never asks which host it's on, except here, once, at start-up.
//
//   the tablet's shell   DeviceServer.kt (the reference): its address and token in DEVICE_MCP_CONFIG
//   the keeper           hub/keeper.mjs, for any spare computer with no screen of its own (OPENHOUSE_HOST=keeper,
//                        hub/start.sh): OPENHOUSE_KEEPER and its token, or one started here (a laptop trying it)
//   none                 a laptop's dev bridge (the shell's, with no DEVICE_MCP_CONFIG): every call answers null
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** What a host may say it can do (POST /host -> { kind, can: [...] }). A host leaves out what it can't. */
export const CAPS = {
  screen: 'a screen of its own, where people answer its cards, Allow a new device and go through the setup',
  cards: "its cards wait at /cards (and /cards/answer) for the bridge to show on settings devices and grown-ups' phones",
  approve: 'POST /approve: an "Is this OK?" card, answered by a person (never by Opie: DeviceServer.personOnly)',
  calendar: 'POST /calendar, /album: a link kept sealed after a yes (its own, unless the setup sent it: trusted)',
  'calendar-accounts': 'POST /calendar/accounts, /calendar/request, /setup/icloud: two-way calendars signed in there',
  openai: 'POST /openai, /ownkey: the household\'s own OpenAI key, kept there and added to the bridge\'s calls',
  pin: 'POST /setup/pin: the PIN, chosen during the setup, kept there (only its hash), and checked there',
  'google-signin': 'POST /setup/google: it starts Google\'s sign-in from the setup (else the bridge does, back to its own address)',
  drive: 'a USB drive it owns, for backups (else they go to a folder)',
  storage: 'POST /storage/status, /storage/set, /storage/sign, /storage/remove: the household\'s own storage bucket (S3), its key kept there; it signs one request at a time for backups',
  updates: 'it updates the bridge (the app\'s releases); else the bridge updates itself (hub/update.sh)',
  'mail-convert': 'POST /mail/pdf, /mail/heic: mail attachments made readable',
  stills: 'POST /media/still: a video\'s still',
  speaker: 'POST /say and a speaker of its own (what Opie says unasked)',
  apps: 'the device tools (its MCP server: screen, tap, open_app...), /front and /halt',
  bluetooth: 'POST /bt', camera: 'POST /camera', media: 'POST /media', multicast: 'POST /multicast', share: 'POST /share',
  brightness: 'POST /screen: brightness and sleep',
  alarms: 'POST /alarms: it rings the alarm clocks (from the home view) and stops or snoozes the one ringing',
  'mic-check': 'POST /mic-check: the microphone check on its screen (Settings → Voice), and how the last one went',
  'pin-choices': 'POST /pin-choices: what asks for the PIN there, and changing one (always after the PIN, typed there); /approve takes `for` for which choice a card is',
};
// What a tablet's shell can do when it doesn't answer /host (one older than the host interface).
export const TABLET_CAPS = ['screen', 'approve', 'calendar', 'calendar-accounts', 'openai', 'pin', 'google-signin', 'drive', 'updates',
  'mail-convert', 'stills', 'speaker', 'apps', 'bluetooth', 'camera', 'media', 'multicast', 'share', 'brightness'];

const answer = async (url, auth, p, b, ms) => {
  try {
    const r = await fetch(url + p, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}), signal: AbortSignal.timeout(ms) });
    let body = null; try { body = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, body };
  } catch { return { ok: false, status: 0, body: null }; }
};

/** The tablet's shell: its address and token from the agents' MCP config, read at every call (it changes each boot). */
export const shellCfg = (file = process.env.DEVICE_MCP_CONFIG) => {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.device; return { base: d.url.replace(/\/mcp$/, ''), auth: d.headers.Authorization, mcp: d.url }; } catch { return null; }
};
export function shellHost({ file = () => process.env.DEVICE_MCP_CONFIG } = {}) {
  let caps = null;
  const h = {
    get kind() { return shellCfg(file()) ? 'tablet' : 'none'; }, // (none: a laptop's dev bridge, where every call answers null)
    there: () => !!shellCfg(file()),
    async call(p, b, { ms = 3000 } = {}) { const s = shellCfg(file()); return s ? answer(s.base, s.auth, p, b, ms) : null; },
    can: (c) => !!shellCfg(file()) && (caps || TABLET_CAPS).includes(c),
    mcp: () => { const s = shellCfg(file()); return s ? { url: s.mcp, auth: s.auth } : null; },
    async ready() { const r = await h.call('/host', {}, { ms: 2000 }); if (r?.ok && Array.isArray(r.body?.can)) caps = r.body.can.map(String); return h; },
  };
  return h;
}

/** The keeper (hub/keeper.mjs), at its loopback address with its token. */
export function keeperHost({ url, token, child = null }) {
  let caps = [];
  const h = {
    kind: 'keeper', child,
    there: () => !!(url && token),
    async call(p, b, { ms = 130e3 } = {}) {
      if (!url || !token) return { ok: false, status: 0, body: { error: "The keeper isn't running." } };
      const r = await answer(url, `Bearer ${token}`, p, b, ms);
      return r.status === 0 ? { ...r, body: { error: "The keeper didn't answer." } } : r;
    },
    can: (c) => caps.includes(c),
    mcp: () => null,
    async ready() {
      for (let i = 0; i < 50; i++) { // (it may still be starting, next to the bridge)
        const r = await h.call('/host', {}, { ms: 2000 });
        if (r.ok && Array.isArray(r.body?.can)) { caps = r.body.can.map(String); return h; }
        await new Promise((ok) => setTimeout(ok, 200));
      }
      console.log('[host] the keeper isn\'t answering: calendars, albums, an own OpenAI key, the PIN and the cards are off');
      return h;
    },
  };
  return h;
}

/** A keeper of its own, for a computer trying the keeper with no hub/start.sh (a laptop): its folder beside DISPLAY,
 *  its seal key in a file there. */
function startKeeper({ DISPLAY, PORT }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const keeperPort = 20000 + crypto.randomInt(20000);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [process.env.OPENHOUSE_KEEPER_SCRIPT || path.join(here, '..', 'hub', 'keeper.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, OPENHOUSE_KEEPER_TOKEN: token, KEEPER_PORT: String(keeperPort), OPENHOUSE_DATA: DISPLAY, OPENHOUSE_KEEPER_DIR: process.env.OPENHOUSE_KEEPER_DIR || `${path.resolve(DISPLAY)}-keeper`,
      OPENHOUSE_KEEPER_STORE: process.env.OPENHOUSE_KEEPER_STORE || 'file', BRIDGE_URL: `http://127.0.0.1:${PORT}`, OPENHOUSE_KEEPER_PARENT: String(process.pid) },
  });
  process.on('exit', () => { try { child.kill(); } catch {} });
  return keeperHost({ url: `http://127.0.0.1:${keeperPort}`, token, child });
}

// --- the one host, picked at start-up -----------------------------------------------------------------------------
let current = shellHost();
/** Pick the host (the only place the bridge asks which one it's on), and learn what it can do. */
export async function pickHost({ env = process.env, DISPLAY = env.DISPLAY_DIR || '.', PORT = env.PORT || 8787 } = {}) {
  const keeper = env.OPENHOUSE_HOST === 'keeper';
  current = !keeper ? shellHost() : env.OPENHOUSE_KEEPER ? keeperHost({ url: env.OPENHOUSE_KEEPER, token: env.OPENHOUSE_KEEPER_TOKEN }) : startKeeper({ DISPLAY, PORT });
  await current.ready();
  return current;
}
export const useHost = (h) => { current = h; return h; }; // (tests)

/** The host, as every part of the bridge reaches it. */
export const host = {
  get kind() { return current.kind; },
  there: () => current.there(),
  can: (c) => current.can(c),
  mcp: () => current.mcp(),
  /** POST b to the host's path p: null when there's no host (a laptop), else { ok, status, body }: status 0 when it
   *  didn't answer in ms, body null when what it sent isn't JSON. Never rejects. */
  call: (p, b, { ms } = {}) => current.call(p, b ?? {}, ms ? { ms } : {}),
  /** The host's answer as it sent it when it said OK, else null. */
  json: async (p, b, ms) => { const r = await current.call(p, b ?? {}, ms ? { ms } : {}); return r?.ok ? r.body : null; },
};
