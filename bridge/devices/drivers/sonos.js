// Sonos speakers: UPnP (SOAP over HTTP, port 1400). No pairing: any device on the network may
// control them. Commands go to the speaker found; in a group, the group's first speaker leads.
import { request, xml, xmlEscape, unxml } from '../net.js';

const SVC = {
  av: ['/MediaRenderer/AVTransport/Control', 'urn:schemas-upnp-org:service:AVTransport:1'],
  rc: ['/MediaRenderer/RenderingControl/Control', 'urn:schemas-upnp-org:service:RenderingControl:1'],
  zone: ['/ZoneGroupTopology/Control', 'urn:schemas-upnp-org:service:ZoneGroupTopology:1'],
};

async function soap(d, svc, action, args = {}) {
  const [path, urn] = SVC[svc];
  const inner = Object.entries({ InstanceID: 0, ...args }).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${urn}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const r = await request(`http://${d.address}:1400${path}`, {
    method: 'POST', body, ms: 4000,
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${urn}#${action}"` },
  });
  if (r.status >= 300) {
    const code = xml(r.text, 'errorCode');
    // 701: transition not available (e.g. Play with nothing queued)
    throw new Error(code === '701' ? 'The speaker has nothing to play right now (start something in the Sonos app first).' : `The speaker answered ${r.status}${code ? ` (UPnP error ${code})` : ''}.`);
  }
  return r.text;
}
const getVolume = async (d) => Number(xml(await soap(d, 'rc', 'GetVolume', { Channel: 'Master' }), 'CurrentVolume'));

export default {
  id: 'sonos', label: 'Sonos',
  match: (d) => d.ports.includes(1400) || d.mdns.some((s) => s.type === '_sonos._tcp') || d.ssdp.some((s) => /Sonos/i.test(s.server)),
  async identify(d) {
    const t = (await request(`http://${d.address}:1400/xml/device_description.xml`, { ms: 3000 })).text;
    return {
      name: xml(t, 'roomName') || xml(t, 'friendlyName'), maker: 'Sonos', model: xml(t, 'modelName') || xml(t, 'displayName'),
      kind: 'speaker', mac: xml(t, 'MACAddress'), serial: xml(t, 'serialNum'), room: xml(t, 'roomName'),
      os: `Sonos ${xml(t, 'softwareVersion') || ''}`.trim(),
    };
  },
  actions: {
    status: {
      says: 'What is playing and how loud',
      async run(d) {
        const [ti, pi, vol, mute] = await Promise.all([soap(d, 'av', 'GetTransportInfo'), soap(d, 'av', 'GetPositionInfo'), getVolume(d), soap(d, 'rc', 'GetMute', { Channel: 'Master' })]);
        const meta = unxml(xml(pi, 'TrackMetaData') || '');
        const title = xml(meta, 'title'), artist = xml(meta, 'creator'), stream = xml(meta, 'streamContent');
        const state = { PLAYING: 'playing', PAUSED_PLAYBACK: 'paused', STOPPED: 'stopped', TRANSITIONING: 'starting' }[xml(ti, 'CurrentTransportState')] || xml(ti, 'CurrentTransportState');
        return { state, title: stream || title || null, artist: artist || null, volume: vol, muted: xml(mute, 'CurrentMute') === '1' };
      },
    },
    play: { says: 'Play (resume)', async run(d) { await soap(d, 'av', 'Play', { Speed: 1 }); return 'Playing.'; } },
    pause: { says: 'Pause', async run(d) { try { await soap(d, 'av', 'Pause'); } catch { await soap(d, 'av', 'Stop'); } return 'Paused.'; } },
    stop: { says: 'Stop', async run(d) { await soap(d, 'av', 'Stop'); return 'Stopped.'; } },
    next: { says: 'Next track', async run(d) { await soap(d, 'av', 'Next'); return 'Next track.'; } },
    previous: { says: 'Previous track', async run(d) { await soap(d, 'av', 'Previous'); return 'Previous track.'; } },
    set_volume: {
      says: 'Set the volume, 0 to 100',
      params: { level: { type: 'integer', min: 0, max: 100, required: true } },
      async run(d, p) { await soap(d, 'rc', 'SetVolume', { Channel: 'Master', DesiredVolume: p.level }); return `Volume ${p.level}.`; },
    },
    volume_up: { says: 'A bit louder', params: { by: { type: 'integer', min: 1, max: 30 } }, async run(d, p) { const v = Math.min(100, (await getVolume(d)) + (p.by || 5)); await soap(d, 'rc', 'SetVolume', { Channel: 'Master', DesiredVolume: v }); return `Volume ${v}.`; } },
    volume_down: { says: 'A bit quieter', params: { by: { type: 'integer', min: 1, max: 30 } }, async run(d, p) { const v = Math.max(0, (await getVolume(d)) - (p.by || 5)); await soap(d, 'rc', 'SetVolume', { Channel: 'Master', DesiredVolume: v }); return `Volume ${v}.`; } },
    mute: { says: 'Mute', async run(d) { await soap(d, 'rc', 'SetMute', { Channel: 'Master', DesiredMute: 1 }); return 'Muted.'; } },
    unmute: { says: 'Unmute', async run(d) { await soap(d, 'rc', 'SetMute', { Channel: 'Master', DesiredMute: 0 }); return 'Unmuted.'; } },
  },
};
