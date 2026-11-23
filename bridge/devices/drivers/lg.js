// LG TVs (webOS, 2014 and later): the TV's own "second screen" WebSocket (SSAP).
//   wss://<tv>:3001/   newer firmware (a self-signed certificate), or ws://<tv>:3000/ on older sets
// The first connection makes the TV ask whether to allow the remote; once someone picks Allow it hands over a
// client key we keep, and it doesn't ask again. Turning it on is Wake-on-LAN (the TV's "Turn on via Wi-Fi" /
// "Mobile TV on" setting). The registration manifest is LG's own remote app's, as every open-source client sends it
// (from aiowebostv's handshake.py, Apache-2.0).
import { websocket, wake, sleep, request } from '../net.js';

const SIGNATURE = 'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR' +
  '+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4' +
  'RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM' +
  '2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==';
export const MANIFEST = {
  appVersion: '1.1', manifestVersion: 1,
  permissions: ['LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO', 'CONTROL_DISPLAY',
    'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER',
    'CONTROL_TV_SCREEN', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS',
    'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE', 'READ_COUNTRY_INFO', 'CONTROL_INPUT_TEXT',
    'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_SETTINGS'],
  signatures: [{ signature: SIGNATURE, signatureVersion: 1 }],
  signed: {
    appId: 'com.lge.test', created: '20140509', localizedAppNames: { '': 'LG Remote App' }, localizedVendorNames: { '': 'LG Electronics' },
    permissions: ['TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS',
      'SEARCH', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER', 'READ_CURRENT_CHANNEL', 'READ_RUNNING_APPS', 'READ_UPDATE_INFO',
      'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME'],
    serial: '2f930e2d2cfe083771f68e4fe7bb07', vendorId: 'com.lge',
  },
};

/** Where the TV listens: the secure port first (newer firmware closes the plain one). Tests point it elsewhere. */
export const ports = { secure: 3001, plain: 3000 };

async function open(d) {
  const ev = d.ports || [];
  const tries = [];
  if (!ev.length || ev.includes(ports.secure)) tries.push(`wss://${d.address}:${ports.secure}/`);
  if (!ev.length || ev.includes(ports.plain)) tries.push(`ws://${d.address}:${ports.plain}/`);
  let last;
  for (const u of tries) { try { return await websocket(u, { ms: 5000 }); } catch (e) { last = e; } }
  throw last || new Error('The TV is not answering.');
}

/** A registered connection. Pairs on first use (waits up to 30 s for someone to pick Allow on the TV). */
export async function connect(d, ctx) {
  const ws = await open(d);
  const key = ctx.pairing.clientKey;
  ws.send({ type: 'register', id: 'register_0', payload: { forcePairing: false, pairingType: 'PROMPT', manifest: MANIFEST, ...(key ? { 'client-key': key } : {}) } });
  let m;
  try {
    m = await ws.next((x) => x?.id === 'register_0' && (x.type === 'registered' || x.type === 'error' || x.payload?.pairingType === 'PROMPT'), 6000);
    if (m.type === 'response') { // the TV is asking on its own screen
      ctx.say?.('Look at the TV: it is asking whether to allow a remote. Choose Allow.');
      m = await ws.next((x) => x?.id === 'register_0' && (x.type === 'registered' || x.type === 'error'), 30000);
    }
  } catch { ws.close(); throw new Error('The TV did not answer. If it asked to allow a remote, nobody chose Allow in time.'); }
  if (m.type !== 'registered') {
    ws.close();
    if (key) { delete ctx.pairing.clientKey; ctx.save(); }
    throw new Error('The TV said no to the remote (or the request timed out). Try again and choose Allow on the TV.');
  }
  const k = m.payload?.['client-key'];
  if (k && k !== key) { ctx.pairing.clientKey = k; ctx.pairing.pairedAt = new Date().toISOString(); ctx.save(); }
  let n = 0;
  /** One SSAP request; resolves with its payload, or throws the TV's error. */
  ws.call = async (uri, payload) => {
    const id = `r${++n}`;
    ws.send({ type: 'request', id, uri, ...(payload ? { payload } : {}) });
    const r = await ws.next((x) => x?.id === id, 6000);
    if (r.type === 'error' || r.payload?.returnValue === false) throw new Error(`The TV refused ${uri.replace('ssap://', '')}: ${r.error || r.payload?.errorText || 'no reason given'}`);
    return r.payload || {};
  };
  return ws;
}

async function withTv(d, ctx, f) {
  const ws = await connect(d, ctx);
  try { return await f(ws); } finally { await sleep(150); ws.close(); }
}
const simple = (says, uri, done, extra = {}) => ({ says, ...extra, async run(d, p, ctx) { return withTv(d, ctx, async (ws) => { await ws.call(uri); return done; }); } });
const lgish = (d) => d.ssdp?.some((s) => /webos/i.test(s.server) || s.sts?.some((t) => /lge-com:service:webos-second-screen/i.test(t)) || /^LG/i.test(s.desc?.manufacturer || ''));

export default {
  id: 'lg-webos', label: 'LG TV',
  match: (d) => lgish(d) || (d.ports.includes(3001) && d.ports.includes(3000)),
  async identify(d) {
    const desc = d.ssdp?.find((s) => s.desc?.friendlyName)?.desc || {};
    return {
      name: desc.friendlyName || 'LG TV', maker: 'LG', model: [desc.modelName, desc.modelNumber].filter(Boolean).join(' ') || null,
      kind: 'tv', mac: desc.mac || d.mac || null, os: 'webOS', notes: ['Needs a yes on the TV the first time (Allow the remote).'],
    };
  },
  needsPairing: (d, ctx) => !ctx.pairing.clientKey,
  actions: {
    status: {
      says: 'Whether it is on, and the app open',
      async run(d, p, ctx) {
        try {
          return await withTv(d, ctx, async (ws) => {
            const pw = await ws.call('ssap://com.webos.service.tvpower/power/getPowerState').catch(() => ({}));
            const app = await ws.call('ssap://com.webos.applicationManager/getForegroundAppInfo').catch(() => ({}));
            return { power: pw.state ? String(pw.state).toLowerCase() : 'on', app: app.appId || null };
          });
        } catch { return { power: 'off (not answering)' }; }
      },
    },
    pair: { says: 'Connect to the TV the first time (someone picks Allow on the TV)', async run(d, p, ctx) { await withTv(d, ctx, async () => {}); return 'Paired: the TV allows the remote.'; } },
    power_off: simple('Turn the TV off', 'ssap://system/turnOff', 'Turned the TV off.'),
    power_on: {
      says: 'Turn the TV on', risky: true,
      async run(d) {
        if (!d.mac) throw new Error('The TV\'s network address (MAC) is unknown, so it can\'t be woken. Scan again while it is on.');
        await wake(d.mac, d.address);
        for (let i = 0; i < 10; i++) { await sleep(1000); if (await request(`http://${d.address}:${ports.plain}/`, { ms: 800 }).then(() => true).catch(() => false)) return 'Turned the TV on.'; }
        return 'Sent the wake signal; the TV has not answered yet (it may need "Turn on via Wi-Fi" in its settings).';
      },
    },
    volume_up: { says: 'Volume up', params: { steps: { type: 'integer', min: 1, max: 15 } }, async run(d, p, ctx) { return withTv(d, ctx, async (ws) => { for (let i = 0; i < (p.steps || 1); i++) await ws.call('ssap://audio/volumeUp'); return 'Volume up.'; }); } },
    volume_down: { says: 'Volume down', params: { steps: { type: 'integer', min: 1, max: 15 } }, async run(d, p, ctx) { return withTv(d, ctx, async (ws) => { for (let i = 0; i < (p.steps || 1); i++) await ws.call('ssap://audio/volumeDown'); return 'Volume down.'; }); } },
    mute: {
      says: 'Mute or unmute',
      async run(d, p, ctx) { return withTv(d, ctx, async (ws) => { const s = await ws.call('ssap://audio/getStatus').catch(() => ({})); await ws.call('ssap://audio/setMute', { mute: !s.mute }); return s.mute ? 'Unmuted.' : 'Muted.'; }); },
    },
    play: simple('Play', 'ssap://media.controls/play', 'Playing.'),
    pause: simple('Pause', 'ssap://media.controls/pause', 'Paused.'),
    apps: { says: 'The apps installed on the TV', async run(d, p, ctx) { return withTv(d, ctx, async (ws) => ((await ws.call('ssap://com.webos.applicationManager/listLaunchPoints')).launchPoints || []).map((a) => a.title)); } },
    launch: {
      says: 'Open an app on the TV by name (Netflix, YouTube…)', risky: true,
      params: { app: { type: 'string', maxLength: 60, required: true } },
      async run(d, p, ctx) {
        return withTv(d, ctx, async (ws) => {
          const list = (await ws.call('ssap://com.webos.applicationManager/listLaunchPoints')).launchPoints || [], q = p.app.toLowerCase();
          const a = list.find((x) => x.title?.toLowerCase() === q) || list.find((x) => x.title?.toLowerCase().includes(q));
          if (!a) throw new Error(`No app called "${p.app}". Installed: ${list.map((x) => x.title).join(', ')}`);
          await ws.call('ssap://system.launcher/launch', { id: a.id });
          return `Opened ${a.title}.`;
        });
      },
    },
    open_page: {
      says: 'Open a web page in the TV\'s browser (e.g. the household\'s screen page)', risky: true,
      params: { url: { type: 'string', maxLength: 300, required: true } },
      async run(d, p, ctx) {
        if (!/^https?:\/\//.test(p.url)) throw new Error('Only http or https pages.');
        return withTv(d, ctx, async (ws) => { await ws.call('ssap://system.launcher/open', { target: p.url }); return 'Opened it in the TV\'s browser.'; });
      },
    },
    show_message: {
      says: 'Show a short message in the corner of the TV', params: { text: { type: 'string', maxLength: 120, required: true } },
      async run(d, p, ctx) { return withTv(d, ctx, async (ws) => { await ws.call('ssap://system.notifications/createToast', { message: p.text }); return 'Shown on the TV.'; }); },
    },
  },
};
