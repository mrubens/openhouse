// Bus times: when the next buses really come to the household's stop, from their transit agency's own live feed
// (GTFS-realtime), on Home only in the hours they choose ("School bus: 4 at 7:42, then 104 at 7:58"), on a card, and
// from the voice. Any agency: picked from the Mobility Database's catalog (agencies.json) or by pasting its feed's
// address. Its website is one the household approves on the tablet's card when they set it up (kit reach.ask); the
// stops' names come from the agency's timetable (a GTFS zip, from the catalog's copy or the agency's own).
import { store, today, web, reach, onAction } from '/kit/openhouse.js';
import { h, sheet, field, hm, at as atTime, put, whenShown } from './ui.js';
import { arrivals, stopsAndRoutes } from './gtfs.js';

const $app = document.getElementById('app');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIRROR = 'files.mobilitydatabase.org';
let setup = null;   // {agency: {name, place, rt, zip, keyParam, key}, stop: {id, code, name}, routes: [], from, to, days, label}
let routeNames = {}; // route id -> what riders call it (store "routes")
let buses = null, at = 0, problem = null, needsYes = false;

const feedUrl = (a) => (a.key && a.keyParam ? `${a.rt}${a.rt.includes('?') ? '&' : '?'}${encodeURIComponent(a.keyParam)}=${encodeURIComponent(a.key)}` : a.rt);
const zipUrl = (a) => a.zip || null;
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return null; } };
const inWindow = (d = new Date()) => setup && setup.days.includes(d.getDay()) && d >= atTime(setup.from, d) && d < atTime(setup.to, d);
const routeName = (id) => routeNames[id] || id || 'Bus';
const mine = () => (buses || []).filter((b) => !setup.routes?.length || setup.routes.includes(b.route));

async function refresh() {
  setup = (await store.get('setup')) || null; // another copy of this page (its window) may have set it up since
  if (!setup) { line(); return; }
  needsYes = false;
  try { buses = arrivals(await web.bytes(feedUrl(setup.agency)), [setup.stop.id]); at = Date.now(); problem = null; store.set('last', { buses: mine().slice(0, 4), at }); } // (for the card)
  catch (e) { needsYes = /reach/.test(e.message); problem = needsYes ? `The tablet doesn’t let Bus times reach ${hostOf(setup.agency.rt)} (it was taken off and added again, say).` : 'Couldn’t reach your transit agency just now.'; }
  line(); draw();
}

// ---- Today: in the hours chosen, one line; never on the sleep screen (it changes every minute) ----
let lineFor = null;
function line() {
  let text = '';
  if (inWindow()) {
    const next = mine().filter((b) => b.at > Date.now() - 60e3).slice(0, 2);
    text = next.length ? `${setup.label || 'Bus'}: ${next.map((b) => `${routeName(b.route)} at ${hm(b.at)}`).join(', then ')}` : problem ? '' : `${setup.label || 'Bus'}: no buses coming yet`;
  }
  if (text === lineFor) return;
  lineFor = text;
  if (text) today.show(text.slice(0, 80), Math.max(Date.now() + 10 * 60e3, atTime(setup.to).getTime()), { sleep: false }); else today.clear();
}

function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Bus times'), h('button', { class: 'btn soft', tap: openSetup }, setup ? 'Stop and hours' : 'Set up'));
  if (!setup) {
    put($app, top, h('div', { class: 'empty' },
      h('p', { class: 'lead' }, 'When the next bus really comes, on Home, just when you need it.'),
      h('p', { class: 'soft' }, 'Pick your transit agency and your stop, and the hours to watch it (school mornings, say). In those hours Today shows the next buses, live from the agency.'),
      h('button', { class: 'btn', tap: openSetup }, 'Set up')));
    return;
  }
  const list = mine().slice(0, 8);
  put($app, top, h('div', { class: 'body' },
    h('div', {}, h('div', { class: 'label' }, setup.agency.name), h('div', { class: 'lead' }, setup.stop.name + (setup.stop.code ? ` · ${setup.stop.code}` : ''))),
    list.length ? h('div', { class: 'rows' }, list.map((b) => { const m = Math.max(0, Math.round((b.at - Date.now()) / 60e3));
      return h('div', { class: 'line' }, h('span', { class: 'rt' }, routeName(b.route)), h('span', { class: 'grow' }), h('span', { class: 'mins' }, m ? `${m} min` : 'Now'), h('span', { class: 'side' }, hm(b.at))); }))
      : h('p', { class: 'soft' }, problem || (buses ? 'No buses coming to this stop right now.' : 'Asking your agency…')),
    needsYes ? h('button', { class: 'btn', tap: async () => { const r = await reach.ask(hostOf(setup.agency.rt)); if (r.ok) { needsYes = false; refresh(); } } }, 'Ask the tablet again') : null,
    h('p', { class: 'soft' }, `On Home ${setup.days.map((d) => DAYS[d]).join(', ')}, ${hm(atTime(setup.from))} to ${hm(atTime(setup.to))}${setup.routes?.length ? `, ${setup.routes.map(routeName).join(', ')} only` : ''}.`)),
  h('div', { class: 'foot' }, `Live from ${setup.agency.name}${at ? `, ${hm(at)}` : ''}.`));
}

// ---- setup: the agency, its approval, the stop, the hours ----
async function openSetup() {
  const s = setup ? structuredClone(setup) : { agency: null, stop: null, routes: [], from: '07:20', to: '08:05', days: [1, 2, 3, 4, 5], label: 'Bus' };
  let catalog = null, stops = null;
  const step = h('div', { class: 'row' });
  const msg = h('span', { class: 'hint' });
  const say = (t, bad = false) => { msg.textContent = t; msg.classList.toggle('bad', bad); };

  // 1. the agency
  const q = h('input', { class: 'field', placeholder: 'Your transit agency or city' });
  const found = h('div', { class: 'actions' });
  const rt = h('input', { class: 'field', placeholder: 'https://… its GTFS-realtime trip updates', autocapitalize: 'off', spellcheck: 'false' });
  const zip = h('input', { class: 'field', placeholder: 'https://… its GTFS timetable (a .zip), for the stops’ names', autocapitalize: 'off', spellcheck: 'false' });
  const key = h('input', { class: 'field', placeholder: 'Only if your agency gave you one', autocapitalize: 'off', spellcheck: 'false', value: s.agency?.key || '' });
  const keyName = h('input', { class: 'field', placeholder: 'api_key', value: s.agency?.keyParam || '', autocapitalize: 'off', spellcheck: 'false' });
  const search = async () => {
    catalog ||= (await (await fetch('./agencies.json')).json()).agencies;
    const t = q.value.trim().toLowerCase();
    const hits = t.length < 2 ? [] : catalog.filter(([n, p]) => (n + ' ' + p).toLowerCase().includes(t)).slice(0, 8);
    put(found, hits.map((a) => h('button', { class: 'chip' + (s.agency?.rt === a[2] ? ' on' : ''), tap: () => {
      s.agency = { name: a[0], place: a[1], rt: a[2], keyParam: a[3], key: key.value.trim(), zip: a[4] ? `https://${MIRROR}/${a[4]}/latest.zip` : '' };
      rt.value = a[2]; zip.value = s.agency.zip; keyName.value = a[3]; search();
      say(a[3] ? `${a[0]} needs a key of its own: get one from the agency and put it in below.` : '');
    } }, `${a[0]}${a[1] ? ` · ${a[1]}` : ''}`)), t.length >= 2 && !hits.length ? h('span', { class: 'hint' }, 'Not in the catalog: paste its feed’s address below (the agency’s developer page has it).') : null);
  };
  q.addEventListener('input', search);

  // 2. approve, then the stops
  const go = async () => {
    const a = { name: s.agency?.rt === rt.value.trim() ? s.agency.name : (hostOf(rt.value) || 'Your agency'), place: s.agency?.place || '', rt: rt.value.trim(), zip: zip.value.trim(), key: key.value.trim(), keyParam: keyName.value.trim() || (key.value.trim() ? 'api_key' : '') };
    if (!/^https:\/\//.test(a.rt)) { say('Give the live feed’s address (https://…).', true); return; }
    if (a.zip && !/^https:\/\//.test(a.zip)) { say('The timetable’s address starts with https://.', true); return; }
    for (const host of [hostOf(a.rt), hostOf(a.zip)].filter((x) => x && x !== MIRROR)) {
      say(`Asking on the tablet: let Bus times reach ${host}?`);
      const r = await reach.ask(host);
      if (!r.ok) { say(r.error || 'Not this time.', true); return; }
    }
    say('Checking the live feed…');
    try { await web.bytes(feedUrl(a)); } catch (e) { say(`The live feed didn’t answer (${e.message}).`, true); return; }
    if (a.zip) {
      say('Reading the agency’s stops (a minute for a big one)…');
      try { const t = await stopsAndRoutes(await web.bytes(a.zip)); stops = t.stops; routeNames = t.routes; await store.set('routes', routeNames); }
      catch (e) { say(`Couldn’t read its timetable (${e.message}). You can still give the stop’s id.`, true); stops = null; }
    }
    s.agency = a;
    say(stops ? `${stops.length} stops. Find yours:` : 'Give your stop’s id (from the agency’s website or the sign).');
    showStops();
  };
  const stopQ = h('input', { class: 'field', placeholder: 'Stop name, number on the sign, or id' });
  const stopHits = h('div', { class: 'actions' });
  const showStops = () => {
    const t = stopQ.value.trim().toLowerCase();
    const hits = !stops ? (t ? [[stopQ.value.trim(), '', stopQ.value.trim()]] : []) : !t ? [] : stops.filter(([id, code, name]) => code.toLowerCase() === t || id.toLowerCase() === t || name.toLowerCase().includes(t)).slice(0, 8);
    put(stopHits, hits.map(([id, code, name]) => h('button', { class: 'chip' + (s.stop?.id === id ? ' on' : ''), tap: () => { s.stop = { id, code, name }; s.routes = []; showStops(); } }, `${name}${code ? ` · ${code}` : ''}`)));
  };
  stopQ.addEventListener('input', showStops);

  // 3. the hours
  const from = h('input', { class: 'field', type: 'time', value: s.from }), to = h('input', { class: 'field', type: 'time', value: s.to });
  const days = h('div', { class: 'actions' }, DAYS.map((d, i) => { const b = h('button', { class: 'chip' + (s.days.includes(i) ? ' on' : ''), tap: () => { s.days = s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort(); b.classList.toggle('on'); } }, d); return b; }));
  const label = h('input', { class: 'field', value: s.label, placeholder: 'Bus' });

  put(step,
    field('Your transit agency', q), found,
    field('Its live feed (GTFS-realtime)', rt, 'Filled in from the catalog, or paste it from the agency’s developer page.'),
    field('Its timetable (GTFS zip)', zip, 'For the stops’ names. Without it, give your stop’s id.'),
    h('div', { class: 'pair' }, field('API key', key), field('Its name in the address', keyName)),
    h('div', { class: 'actions' }, h('button', { class: 'btn soft', tap: go }, setup ? 'Check the agency again' : 'Use this agency')), msg,
    field('Your stop', stopQ), stopHits,
    h('div', { class: 'pair' }, field('On Home from', from), field('Until', to)), field('Days', days),
    field('Called', label, 'The start of the line on Home: “School bus: 4 at 7:42”.'),
    setup ? h('button', { class: 'btn soft', tap: async () => { await reach.forget(hostOf(setup.agency.rt)); setup = null; await store.set('setup', null); document.querySelector('.scrim')?.remove(); lineFor = null; today.clear(); draw(); } }, 'Stop watching a stop') : null);
  if (s.agency) { rt.value = s.agency.rt; zip.value = s.agency.zip || ''; }
  sheet('Bus times', [step], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Save', tap: async (c) => {
      if (!s.agency || s.agency.rt !== rt.value.trim()) { say('Tap Use this agency first.', true); return; }
      if (!s.stop) { say('Pick your stop.', true); stopQ.focus(); return; }
      setup = { ...s, from: from.value || '07:20', to: to.value || '08:05', label: label.value.trim().slice(0, 20) || 'Bus', days: s.days.length ? s.days : [1, 2, 3, 4, 5] };
      await store.set('setup', setup); c(); lineFor = null; buses = null; refresh();
    } }]);
}

async function answer() {
  if (!setup) return 'Bus times isn’t set up yet: pick your agency and stop in the Bus times app.';
  await refresh();
  if (problem) return problem;
  const next = mine().filter((b) => b.at > Date.now() - 60e3).slice(0, 3);
  if (!next.length) return `No buses coming to ${setup.stop.name} right now.`;
  return next.map((b, i) => { const m = Math.max(0, Math.round((b.at - Date.now()) / 60e3)); return `${i ? 'then ' : 'The '}${routeName(b.route)} ${m ? `in ${m} minute${m === 1 ? '' : 's'}` : 'is here now'}`; }).join(', ') + '.';
}

(async () => {
  setup = await store.get('setup');
  routeNames = (await store.get('routes')) || {};
  draw();
  whenShown(() => onAction((name) => (name === 'next_bus' ? answer() : null)));
  if (setup) refresh();
  // Each minute: the agency only in the hours chosen, or while the page is on the screen; the line either way.
  setInterval(async () => { setup = (await store.get('setup')) || null; if (setup && (inWindow() || !document.hidden)) refresh(); else line(); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && setup) refresh(); });
})();
