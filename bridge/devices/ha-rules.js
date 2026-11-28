// What may be asked of a household's Home Assistant (drivers/homeassistant.js), checked where its token is kept: the
// keeper (hub/keeper.mjs) uses this file, and the tablet's shell has the same rules (HomeAssistant.kt). The bridge
// never has the token, so whatever it asks for goes through here first.
//
// Lights, switches, scenes and media players can be used; thermostats (climate) only read. Locks, garage doors and
// other covers, alarms, cameras and everything else aren't reachable at all: their calls are refused and their
// states are taken out of every answer. A scene is turned on only when everything it sets is one of the domains
// that can be used (a scene can unlock a door).
//
// Home Assistant's REST API (developers.home-assistant.io, "REST API", checked 2026-11-28): Authorization: Bearer
// <long-lived token>; GET /api/ -> {message}; GET /api/config; GET /api/states; GET /api/states/<entity_id>;
// POST /api/services/<domain>/<service> {entity_id, ...} -> the states it changed.

/** domain -> service -> the data it may carry beside entity_id. */
export const CONTROL = {
  light: { turn_on: ['brightness_pct'], turn_off: [] },
  switch: { turn_on: [], turn_off: [] },
  scene: { turn_on: [] },
  media_player: { turn_on: [], turn_off: [], media_play: [], media_pause: [], media_next_track: [], media_previous_track: [],
    volume_set: ['volume_level'], volume_up: [], volume_down: [], volume_mute: ['is_volume_muted'] },
};
/** What can be read: the above, and thermostats. */
export const SEEN = [...Object.keys(CONTROL), 'climate'];
const ENTITY = /^([a-z0-9_]{1,60})\.[a-z0-9_]{1,200}$/;
export const domainOf = (e) => ENTITY.exec(String(e ?? ''))?.[1] || null;
export const seen = (e) => SEEN.includes(domainOf(e));
const VALUE = {
  brightness_pct: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  volume_level: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  is_volume_muted: (v) => typeof v === 'boolean',
};

/** null when the call is one of these, else why not. */
export function refuse({ method, path, body } = {}) {
  const p = String(path ?? '');
  if (method === 'GET') {
    if (p === '/api/' || p === '/api/config' || p === '/api/states') return null;
    const m = /^\/api\/states\/([a-z0-9_.]{3,262})$/.exec(p);
    return m && seen(m[1]) ? null : 'not a call this route makes';
  }
  if (method !== 'POST') return 'not a call this route makes';
  const m = /^\/api\/services\/([a-z0-9_]{1,60})\/([a-z0-9_]{1,60})$/.exec(p);
  const keys = m && Object.hasOwn(CONTROL, m[1]) && Object.hasOwn(CONTROL[m[1]], m[2]) ? CONTROL[m[1]][m[2]] : null;
  if (!keys) return 'not a call this route makes';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'not a call this route makes';
  if (typeof body.entity_id !== 'string' || domainOf(body.entity_id) !== m[1]) return 'not a call this route makes';
  for (const [k, v] of Object.entries(body)) if (k !== 'entity_id' && !(keys.includes(k) && VALUE[k](v))) return 'not a call this route makes';
  return null;
}

/** A scene whose list of what it sets is known and only names what can be used. */
export const sceneOk = (state) => {
  const l = state?.attributes?.entity_id;
  return Array.isArray(l) && l.length > 0 && l.every((e) => Object.hasOwn(CONTROL, domainOf(e) || '') && domainOf(e) !== 'scene');
};

/** What Home Assistant answered, with nothing in it of what can't be reached: states only of SEEN, the config only
 *  its name and version. */
export function shown(path, j) {
  const states = (l) => (Array.isArray(l) ? l.filter((s) => seen(s?.entity_id)) : []);
  if (path === '/api/states') return states(j);
  if (path === '/api/config') return { location_name: typeof j?.location_name === 'string' ? j.location_name : null, version: typeof j?.version === 'string' ? j.version : null };
  if (path.startsWith('/api/services/')) return states(Array.isArray(j) ? j : j?.changed_states);
  if (path.startsWith('/api/states/')) return seen(j?.entity_id) ? j : null;
  return path === '/api/' ? { message: typeof j?.message === 'string' ? j.message : '' } : null;
}

/** An address someone typed: http(s), no path, no user, no query. null when it isn't one. */
export function cleanUrl(raw) {
  let s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return null;
  const bare = !/^[a-z]+:\/\//i.test(s); // (just its address: Home Assistant's own port)
  if (bare) s = `http://${s}`;
  let u; try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '') || !u.hostname) return null;
  if (bare && !u.port) u.port = '8123';
  return `${u.protocol}//${u.host}`;
}
/** A long-lived access token as Home Assistant makes them (a JWT): one line of letters, digits, - _ and dots. */
export const cleanToken = (raw) => { const t = String(raw ?? '').trim(); return /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(t) && t.length <= 2000 ? t : null; };

/** Does Home Assistant at that address take that token? null when it does, else why not, in the household's words. */
export async function check(kept, { fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn(`${kept.url}/api/`, { redirect: 'manual', headers: { authorization: `Bearer ${kept.token}` }, signal: AbortSignal.timeout(10e3) });
    if (r.status === 200) return null;
    return r.status === 401 || r.status === 403 ? "Home Assistant didn't accept that token. Make a new one and copy all of it."
      : `That address answered, but not as Home Assistant does (${r.status}). Check the address.`;
  } catch { return "Couldn't reach Home Assistant at that address. Check it, and that it's on this Wi-Fi."; }
}

/**
 * One call with the token, for a host: [status, answer]. {url, token} is what the host keeps; fetchFn for tests.
 * Never follows a redirect (only the address that was typed), and the token is never in what comes back.
 */
export async function forward(kept, b, { fetchFn = fetch } = {}) {
  if (!kept?.url || !kept?.token) return [409, { error: 'no_homeassistant' }];
  const call = { method: String(b?.method || 'GET').toUpperCase(), path: String(b?.path || ''), body: b?.body };
  if (refuse(call)) return [403, { error: 'not a call this route makes' }];
  const go = async (method, path, body) => {
    const r = await fetchFn(kept.url + path, { method, redirect: 'manual', headers: { authorization: `Bearer ${kept.token}`, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15e3) });
    // (an answer that has the token in it, however it got there, has it taken out before anything reads it)
    let j = null; try { j = JSON.parse((await r.text()).split(kept.token).join('')); } catch {}
    return [r.status, j];
  };
  try {
    if (call.method === 'POST' && domainOf(call.body.entity_id) === 'scene') {
      const [s, st] = await go('GET', `/api/states/${call.body.entity_id}`);
      if (s !== 200) return [s === 401 ? 401 : 404, { error: s === 401 ? 'ha_refused' : 'not found' }];
      if (!sceneOk(st)) return [403, { error: 'scene_reaches_too_far' }];
    }
    const [s, j] = await go(call.method, call.path, call.body);
    if (s === 401 || s === 403) return [401, { error: 'ha_refused' }];
    if (s >= 300) return [s, { error: `home assistant answered ${s}` }];
    return [200, { answer: shown(call.path, j) }];
  } catch { return [502, { error: 'home assistant unreachable' }]; }
}
