// Roku players and TVs: External Control Protocol, plain HTTP on port 8060.
// https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
// Works when the Roku's "Control by mobile apps" setting allows it (the default).
import { request, xml } from '../net.js';

const base = (d) => `http://${d.address}:8060`;
const get = async (d, path) => (await request(base(d) + path, { ms: 3000 })).text;
async function key(d, k) {
  const r = await request(`${base(d)}/keypress/${encodeURIComponent(k)}`, { method: 'POST', ms: 3000 });
  if (r.status === 403) throw new Error('The Roku refused: its "Control by mobile apps" setting is off or limited (Settings > System > Advanced system settings).');
  if (r.status >= 300) throw new Error(`The Roku answered ${r.status} to ${k}.`);
}
async function apps(d) {
  return [...(await get(d, '/query/apps')).matchAll(/<app id="([^"]+)"[^>]*>([^<]+)<\/app>/g)].map((m) => ({ id: m[1], name: m[2].replace(/&amp;/g, '&') }));
}
const KEYS = { home: 'Home', back: 'Back', select: 'Select', ok: 'Select', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  play_pause: 'Play', rewind: 'Rev', fast_forward: 'Fwd', replay: 'InstantReplay', info: 'Info', search: 'Search' };

export default {
  id: 'roku', label: 'Roku',
  match: (d) => d.ssdp.some((s) => /roku/i.test(s.server) || s.sts.includes('roku:ecp')) || d.ports.includes(8060),
  async identify(d) {
    const t = await get(d, '/query/device-info');
    const tv = xml(t, 'is-tv') === 'true';
    return {
      name: xml(t, 'user-device-name') || xml(t, 'friendly-device-name'), maker: 'Roku',
      model: [xml(t, 'friendly-model-name') || xml(t, 'model-name'), xml(t, 'model-number')].filter(Boolean).join(' '),
      kind: tv ? 'tv' : 'streamer', mac: xml(t, 'wifi-mac') || xml(t, 'ethernet-mac'), serial: xml(t, 'serial-number'),
      room: xml(t, 'user-device-location'), os: `Roku OS ${xml(t, 'software-version') || ''}`.trim(),
      notes: tv ? [] : ['A Roku player: it can only turn the TV on or off if the TV allows HDMI-CEC.'],
    };
  },
  actions: {
    status: {
      says: 'What it is showing (the app open, and whether something is playing)',
      async run(d) {
        const [info, active, player] = await Promise.all([get(d, '/query/device-info'), get(d, '/query/active-app'), get(d, '/query/media-player').catch(() => '')]);
        const app = active.match(/<app[^>]*>([^<]+)<\/app>/)?.[1] || 'nothing';
        const scr = active.match(/<screensaver[^>]*>([^<]+)<\/screensaver>/)?.[1];
        const state = player.match(/<player [^>]*state="([^"]+)"/)?.[1];
        return { power: xml(info, 'power-mode'), app, screensaver: scr || null, playing: state || null };
      },
    },
    apps: { says: 'The apps (channels) installed', async run(d) { return (await apps(d)).map((a) => a.name); } },
    launch: {
      says: 'Open an app (channel) by name, e.g. Netflix or YouTube', risky: true,
      params: { app: { type: 'string', maxLength: 60, required: true } },
      async run(d, p) {
        const list = await apps(d), q = p.app.toLowerCase();
        const a = list.find((x) => x.name.toLowerCase() === q) || list.find((x) => x.name.toLowerCase().startsWith(q)) || list.find((x) => x.name.toLowerCase().includes(q));
        if (!a) throw new Error(`No app called "${p.app}". Installed: ${list.map((x) => x.name).join(', ')}`);
        await request(`${base(d)}/launch/${a.id}`, { method: 'POST', ms: 5000 });
        return `Opened ${a.name}.`;
      },
    },
    press: {
      says: `Press a remote button: ${Object.keys(KEYS).join(', ')}`,
      params: { button: { type: 'string', enum: Object.keys(KEYS), required: true }, times: { type: 'integer', min: 1, max: 10 } },
      async run(d, p) { for (let i = 0; i < (p.times || 1); i++) await key(d, KEYS[p.button]); return `Pressed ${p.button}${p.times > 1 ? ` ${p.times} times` : ''}.`; },
    },
    type: {
      says: 'Type text into a search or sign-in box on the screen',
      params: { text: { type: 'string', maxLength: 80, required: true } },
      async run(d, p) { for (const ch of p.text) await key(d, 'Lit_' + encodeURIComponent(ch)); return `Typed "${p.text}".`; },
    },
    power_off: { says: 'Turn it (and, by HDMI-CEC, the TV) off', async run(d) { await key(d, 'PowerOff'); return 'Sent power off.'; } },
    power_on: { says: 'Turn it on', risky: true, async run(d) { await key(d, 'PowerOn'); return 'Sent power on.'; } },
    volume_up: { says: 'Volume up (TVs, or through HDMI-CEC)', params: { steps: { type: 'integer', min: 1, max: 10 } }, async run(d, p) { for (let i = 0; i < (p.steps || 1); i++) await key(d, 'VolumeUp'); return 'Volume up.'; } },
    volume_down: { says: 'Volume down', params: { steps: { type: 'integer', min: 1, max: 10 } }, async run(d, p) { for (let i = 0; i < (p.steps || 1); i++) await key(d, 'VolumeDown'); return 'Volume down.'; } },
    mute: { says: 'Mute or unmute', async run(d) { await key(d, 'VolumeMute'); return 'Toggled mute.'; } },
  },
};
