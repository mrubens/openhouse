// Samsung TVs (Tizen, 2016 and later): the TV's own remote-control WebSocket.
//   http://<tv>:8001/api/v2/   who it is (no pairing needed)
//   wss://<tv>:8002/api/v2/channels/samsung.remote.control?name=..&token=..   keys and apps
// The first connection makes the TV ask "Allow openhouse?" on its own screen; once someone
// picks Allow, the TV hands over a token we keep, and it doesn't ask again.
import { request, websocket, wake, sleep } from '../net.js';

const NAME = Buffer.from('openhouse').toString('base64');
const KEYS = { home: 'KEY_HOME', back: 'KEY_RETURN', ok: 'KEY_ENTER', select: 'KEY_ENTER', up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT',
  play: 'KEY_PLAY', pause: 'KEY_PAUSE', stop: 'KEY_STOP', rewind: 'KEY_REWIND', fast_forward: 'KEY_FF', source: 'KEY_SOURCE', menu: 'KEY_MENU',
  info: 'KEY_INFO', channel_up: 'KEY_CHUP', channel_down: 'KEY_CHDOWN', guide: 'KEY_GUIDE' };

async function info(d) {
  const r = await request(`http://${d.address}:8001/api/v2/`, { ms: 3000 });
  return JSON.parse(r.text);
}

/** A connected remote. Pairs on first use (waits up to 30 s for someone to pick Allow on the TV). */
async function remote(d, ctx) {
  const tok = ctx.pairing.token ? `&token=${encodeURIComponent(ctx.pairing.token)}` : '';
  const ws = await websocket(`wss://${d.address}:8002/api/v2/channels/samsung.remote.control?name=${NAME}${tok}`, { ms: 6000 });
  if (!ctx.pairing.token) ctx.say?.('Look at the TV: it is asking whether to allow openhouse. Choose Allow.');
  let first;
  try { first = await ws.next((m) => m?.event === 'ms.channel.connect' || m?.event === 'ms.channel.unauthorized' || m?.event === 'ms.channel.timeOut', ctx.pairing.token ? 6000 : 30000); }
  catch { ws.close(); throw new Error('The TV did not answer. If it asked to allow openhouse, nobody chose Allow in time.'); }
  if (first.event !== 'ms.channel.connect') {
    ws.close();
    if (ctx.pairing.token) { delete ctx.pairing.token; ctx.save(); }
    throw new Error('The TV said no to openhouse (Deny, or the request timed out). It can be allowed again in the TV\'s Settings > General > External Device Manager > Device Connection Manager.');
  }
  if (first.data?.token && first.data.token !== ctx.pairing.token) { ctx.pairing.token = first.data.token; ctx.pairing.pairedAt = new Date().toISOString(); ctx.save(); }
  return ws;
}

const press = (ws, key, cmd = 'Click') => ws.send({ method: 'ms.remote.control', params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } });

async function withRemote(d, ctx, f) {
  const ws = await remote(d, ctx);
  try { return await f(ws); } finally { await sleep(250); ws.close(); }
}

// Samsung's own ids for the streaming apps (the same on every TV). Newer TVs (2022 on, the Frame) don't answer the
// remote's "which apps are installed", so these are looked up one by one on the TV's web API instead, and opened there.
const APP_IDS = { YouTube: '111299001912', Netflix: '3201907018807', 'Prime Video': '3201910019365', 'Disney+': '3201901017640',
  Hulu: '3201601007625', Max: '3202301029760', 'Apple TV': '3201807016597', Spotify: '3201606009684', Peacock: '3202006020991',
  'YouTube TV': '3201707014489', Tubi: '3201504001965', 'Samsung TV Plus': '3201710015037', 'Pluto TV': '3201808016802',
  'Paramount+': '3201710014981', Plex: '3201512006963', Twitch: '3202203026841', Sling: '3201804016312', Crunchyroll: '3201906018693' };

/** The apps installed on the TV, {id, name}: its own list when it gives one, else the known apps it has. */
async function installed(ws, d) {
  try {
    ws.send({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
    const m = await ws.next((x) => x?.event === 'ed.installedApp.get', 3000);
    const list = (m.data?.data || []).map((a) => ({ id: a.appId, name: a.name }));
    if (list.length) return list;
  } catch {}
  const found = await Promise.all(Object.entries(APP_IDS).map(async ([name, id]) => {
    try { const r = await request(`http://${d.address}:8001/api/v2/applications/${id}`, { ms: 3000 }); const j = JSON.parse(r.text); return j?.id ? { id, name: j.name || name, short: name } : null; } catch { return null; }
  }));
  return found.filter(Boolean);
}
/** Open an app: on the TV's web API (what newer TVs answer), else through the remote. */
async function openApp(d, ws, id) {
  try { const r = await request(`http://${d.address}:8001/api/v2/applications/${id}`, { method: 'POST', ms: 4000 }); if (r.status >= 200 && r.status < 300) return; } catch {}
  ws.send({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: { appId: id, action_type: 'DEEP_LINK' } } });
}

export default {
  id: 'samsung-tv', label: 'Samsung TV',
  match: (d) => d.ports.includes(8001) || d.ssdp.some((s) => /Samsung/i.test(s.server) && /MediaRenderer|dial|RemoteControlReceiver/i.test(s.sts.join(' '))),
  async identify(d) {
    const j = await info(d), v = j.device || {};
    return {
      name: v.name || j.name, maker: 'Samsung', model: v.modelName, kind: 'tv', mac: v.wifiMac, os: v.OS === 'Tizen' ? 'Tizen' : v.OS,
      notes: [v.FrameTVSupport === 'true' && 'A Frame TV: a short press of power shows art; turning it off holds power down.',
        v.TokenAuthSupport === 'true' && 'Needs a yes on the TV the first time (Allow openhouse).'].filter(Boolean),
      frame: v.FrameTVSupport === 'true',
    };
  },
  needsPairing: (d, ctx) => !ctx.pairing.token,
  actions: {
    status: {
      says: 'Whether it is on, and its name',
      async run(d) {
        try { const v = (await info(d)).device || {}; return { power: v.PowerState || 'on' }; }
        catch { return { power: 'off (not answering)' }; }
      },
    },
    pair: {
      says: 'Connect to the TV the first time (someone picks Allow on the TV)',
      async run(d, p, ctx) { await withRemote(d, ctx, async () => {}); return ctx.pairing.token ? 'Paired: the TV allows openhouse.' : 'Connected.'; },
    },
    power_off: {
      says: 'Turn the TV off',
      async run(d, p, ctx) {
        return withRemote(d, ctx, async (ws) => {
          if (d.frame) { press(ws, 'KEY_POWER', 'Press'); await sleep(3200); press(ws, 'KEY_POWER', 'Release'); } // a short press is art mode
          else press(ws, 'KEY_POWER');
          return 'Turned the TV off.';
        });
      },
    },
    art_mode: {
      says: 'Frame TVs: switch between the picture and art (a short press of power)', risky: true,
      async run(d, p, ctx) { return withRemote(d, ctx, async (ws) => { press(ws, 'KEY_POWER'); return 'Pressed power once (art mode / TV).'; }); },
    },
    power_on: {
      says: 'Turn the TV on', risky: true,
      async run(d, p, ctx) {
        const st = await info(d).then((j) => j.device?.PowerState).catch(() => null);
        if (st === 'on') return 'The TV is already on.';
        if (st === 'standby') return withRemote(d, ctx, async (ws) => { press(ws, 'KEY_POWER'); return 'Turned the TV on.'; });
        await wake(d.mac, d.address);
        for (let i = 0; i < 10; i++) { await sleep(1000); if (await info(d).then(() => true).catch(() => false)) return 'Turned the TV on.'; }
        return 'Sent the wake signal; the TV has not answered yet (it may need "Power on with mobile" turned on in its settings).';
      },
    },
    volume_up: { says: 'Volume up', params: { steps: { type: 'integer', min: 1, max: 15 } }, async run(d, p, ctx) { return withRemote(d, ctx, async (ws) => { for (let i = 0; i < (p.steps || 1); i++) { press(ws, 'KEY_VOLUP'); await sleep(150); } return 'Volume up.'; }); } },
    volume_down: { says: 'Volume down', params: { steps: { type: 'integer', min: 1, max: 15 } }, async run(d, p, ctx) { return withRemote(d, ctx, async (ws) => { for (let i = 0; i < (p.steps || 1); i++) { press(ws, 'KEY_VOLDOWN'); await sleep(150); } return 'Volume down.'; }); } },
    mute: { says: 'Mute or unmute', async run(d, p, ctx) { return withRemote(d, ctx, async (ws) => { press(ws, 'KEY_MUTE'); return 'Toggled mute.'; }); } },
    press: {
      says: `Press a remote button: ${Object.keys(KEYS).join(', ')}`,
      params: { button: { type: 'string', enum: Object.keys(KEYS), required: true }, times: { type: 'integer', min: 1, max: 10 } },
      async run(d, p, ctx) { return withRemote(d, ctx, async (ws) => { for (let i = 0; i < (p.times || 1); i++) { press(ws, KEYS[p.button]); await sleep(200); } return `Pressed ${p.button}.`; }); },
    },
    apps: { says: 'The apps installed on the TV', async run(d, p, ctx) { return withRemote(d, ctx, async (ws) => (await installed(ws, d)).map((a) => a.short || a.name)); } },
    launch: {
      says: 'Open an app on the TV by name (Netflix, YouTube…)', risky: true,
      params: { app: { type: 'string', maxLength: 60, required: true } },
      async run(d, p, ctx) {
        return withRemote(d, ctx, async (ws) => {
          const list = await installed(ws, d), q = p.app.toLowerCase(), names = (x) => [x.name, x.short].filter(Boolean).map((n) => n.toLowerCase());
          const a = list.find((x) => names(x).includes(q)) || list.find((x) => names(x).some((n) => n.includes(q) || q.includes(n)));
          if (!a) throw new Error(`No app called "${p.app}". Installed: ${list.map((x) => x.short || x.name).join(', ')}`);
          await openApp(d, ws, a.id);
          await sleep(500);
          return `Opened ${a.name}.`;
        });
      },
    },
  },
};
