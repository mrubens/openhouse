// Home Assistant: what a household's Home Assistant already controls, through its own REST API (port 8123) with a
// long-lived access token. The token is never here: the host keeps it (the tablet's shell, HomeAssistant.kt; a hub's
// keeper) and adds it to each call, which it checks first against devices/ha-rules.js. The bridge asks the host
// (POST /homeassistant {method, path, body}) and gets back only what those rules let through.
//
// Two drivers: the Home Assistant itself, as the scan finds it (its port, or its Bonjour record), and each thing the
// household picked for Opie to use (index.js keeps the picks), a device of its own: a light, a switch, a scene, a
// media player, or a thermostat (read only). Names and states come from Home Assistant: they are data (as-data.js).
import { host } from '../../host.js';
import { request } from '../net.js';
import { domainOf, sceneOk, SEEN } from '../ha-rules.js';

/** One call through the host. Throws what to say when it can't. */
export async function call(method, path, body) {
  const r = await host.call('/homeassistant', { method, path, ...(body ? { body } : {}) }, { ms: 20000 });
  if (!r) throw new Error('Home Assistant is reached through the device, which isn\'t answering.');
  if (r.status === 409) throw Object.assign(new Error('Home Assistant isn\'t connected yet: someone connects it on the device (Settings, Devices, Home Assistant).'), { code: 'not_connected' });
  if (r.status === 401) throw new Error('Home Assistant stopped accepting the token. Someone connects it again on the device with a new one.');
  if (r.status === 403) throw new Error(r.body?.error === 'scene_reaches_too_far' ? 'That scene also changes things Opie may not use (a lock, a door or an alarm), so Opie leaves it alone.' : 'Opie may not do that with Home Assistant.');
  if (r.status === 404) throw new Error('Home Assistant doesn\'t have that any more.');
  if (!r.ok) throw new Error(r.status === 502 || r.status === 0 ? 'Home Assistant isn\'t answering.' : `Home Assistant answered ${r.status}.`);
  return r.body?.answer;
}
/** Whether the host has a Home Assistant to reach, and its address (never the token). */
export async function connection() {
  if (!host.can('homeassistant')) return { can: false, set: false, url: null };
  const s = await host.json('/homeassistant/status', {}, 4000);
  return { can: true, set: s?.set === true, url: typeof s?.url === 'string' ? s.url : null };
}

/** A device's kind, for a thing in Home Assistant. */
export function kindOf(st) {
  const d = domainOf(st?.entity_id);
  if (d === 'media_player') return st?.attributes?.device_class === 'tv' ? 'tv' : 'speaker';
  return { light: 'light', switch: 'switch', scene: 'scene', climate: 'thermostat' }[d] || null;
}
/** The things the household could pick: what the host lets through, less the scenes that reach further. */
export async function things() {
  const all = await call('GET', '/api/states');
  return (Array.isArray(all) ? all : []).filter((s) => SEEN.includes(domainOf(s?.entity_id)) && (domainOf(s.entity_id) !== 'scene' || sceneOk(s)))
    .map((s) => ({ entity: s.entity_id, name: String(s.attributes?.friendly_name || s.entity_id).slice(0, 80), kind: kindOf(s), state: String(s.state ?? '').slice(0, 40) }));
}

// --- the Home Assistant itself ----------------------------------------------------------------------------------
const txtOf = (d) => d.mdns?.find((s) => s.type === '_home-assistant._tcp')?.txt || {};
export default {
  id: 'homeassistant', label: 'Home Assistant',
  match: (d) => d.ports.includes(8123) || d.mdns?.some((s) => s.type === '_home-assistant._tcp'),
  async identify(d) {
    const t = txtOf(d);
    let name = t.location_name || null;
    if (!name) { try { const r = await request(`http://${d.address}:8123/manifest.json`, { ms: 3000 }); name = JSON.parse(r.text)?.name || null; } catch {} }
    return { name: name || 'Home Assistant', maker: 'Home Assistant', model: t.version ? `Home Assistant ${t.version}` : 'Home Assistant', kind: 'hub',
      notes: ['Home Assistant: once someone connects it on the device and picks what Opie may use, those lights, switches, scenes and media players are devices here.'] };
  },
  actions: {
    status: {
      says: 'Whether it is connected, and how many of its things Opie may use',
      async run(d, p, ctx) { const c = await connection(); return { connected: c.set, using: ctx.haPicked?.() ?? 0 }; },
    },
  },
};

// --- each thing the household picked -------------------------------------------------------------------------
const svc = (d, service, data = {}) => call('POST', `/api/services/${domainOf(d.entity)}/${service}`, { entity_id: d.entity, ...data });
const state = (d) => call('GET', `/api/states/${d.entity}`);
const onOff = (s) => (s?.state === 'on' ? 'on' : s?.state === 'off' ? 'off' : String(s?.state ?? 'unknown'));
const after = (d, word) => `${word}: ${d.name}.`;
const level = { level: { type: 'integer', min: 0, max: 100, required: true } };

const ACTIONS = {
  light: {
    status: { says: 'On or off, and how bright', async run(d) { const s = await state(d); const b = s?.attributes?.brightness; return { power: onOff(s), ...(typeof b === 'number' ? { brightness: Math.round(b / 2.55) } : {}) }; } },
    power_on: { says: 'Turn it on', async run(d) { await svc(d, 'turn_on'); return after(d, 'Turned on'); } },
    power_off: { says: 'Turn it off', async run(d) { await svc(d, 'turn_off'); return after(d, 'Turned off'); } },
    set_brightness: { says: 'How bright, 0-100', params: level, async run(d, p) { await svc(d, p.level ? 'turn_on' : 'turn_off', p.level ? { brightness_pct: p.level } : {}); return `${d.name}: brightness ${p.level}.`; } },
  },
  switch: {
    status: { says: 'On or off', async run(d) { return { power: onOff(await state(d)) }; } },
    power_on: { says: 'Turn it on', risky: true, async run(d) { await svc(d, 'turn_on'); return after(d, 'Turned on'); } },
    power_off: { says: 'Turn it off', async run(d) { await svc(d, 'turn_off'); return after(d, 'Turned off'); } },
  },
  scene: {
    activate: { says: 'Set the scene', async run(d) { await svc(d, 'turn_on'); return after(d, 'Set'); } },
  },
  media_player: {
    status: {
      says: 'What it is doing, what is playing, and the volume',
      async run(d) {
        const s = await state(d), a = s?.attributes || {};
        return { state: String(s?.state ?? 'unknown'), title: a.media_title || null, artist: a.media_artist || null,
          volume: typeof a.volume_level === 'number' ? Math.round(a.volume_level * 100) : null, muted: !!a.is_volume_muted };
      },
    },
    power_on: { says: 'Turn it on', risky: true, async run(d) { await svc(d, 'turn_on'); return after(d, 'Turned on'); } },
    power_off: { says: 'Turn it off', async run(d) { await svc(d, 'turn_off'); return after(d, 'Turned off'); } },
    play: { says: 'Play', async run(d) { await svc(d, 'media_play'); return after(d, 'Playing'); } },
    pause: { says: 'Pause', async run(d) { await svc(d, 'media_pause'); return after(d, 'Paused'); } },
    next: { says: 'Next track', async run(d) { await svc(d, 'media_next_track'); return after(d, 'Skipped'); } },
    previous: { says: 'Previous track', async run(d) { await svc(d, 'media_previous_track'); return after(d, 'Back one'); } },
    volume_up: { says: 'Volume up', async run(d) { await svc(d, 'volume_up'); return after(d, 'Volume up'); } },
    volume_down: { says: 'Volume down', async run(d) { await svc(d, 'volume_down'); return after(d, 'Volume down'); } },
    set_volume: { says: 'Volume 0-100', params: level, async run(d, p) { await svc(d, 'volume_set', { volume_level: p.level / 100 }); return `${d.name}: volume ${p.level}.`; } },
    mute: { says: 'Mute or unmute', async run(d) { const s = await state(d); await svc(d, 'volume_mute', { is_volume_muted: !s?.attributes?.is_volume_muted }); return after(d, s?.attributes?.is_volume_muted ? 'Unmuted' : 'Muted'); } },
  },
  climate: {
    status: {
      says: 'Its mode, the temperature, and what it is set to (read only: Opie doesn\'t change it)',
      async run(d) {
        const s = await state(d), a = s?.attributes || {};
        return { state: String(s?.state ?? 'unknown'), current_temperature: a.current_temperature ?? null, target: a.temperature ?? null, humidity: a.current_humidity ?? null };
      },
    },
  },
};

export const entities = {
  id: 'homeassistant-entity', label: 'Home Assistant',
  match: () => false, // (not found by a scan: made from the household's picks, index.js)
  async identify() { return {}; },
  actionsFor: (d) => ACTIONS[domainOf(d.entity)] || {},
};
