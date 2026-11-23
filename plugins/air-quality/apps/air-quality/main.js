// Air quality: the air outside by the US Air Quality Index, and a line on Today only on a bad day ("Air quality:
// unhealthy for sensitive groups this afternoon"). Where home is comes from the tablet's weather; the forecast from
// Open-Meteo (air.js). Runs in the background. The voice can ask (app.json "air").
import { weather, store, today, web, onAction } from '/kit/openhouse.js';
import { h, sheet, field, dayKey, hm, put, whenShown } from './ui.js';
import { placeUrl, airUrl, read, band, BANDS, pollenWord } from './air.js';

const $app = document.getElementById('app');
let settings = { above: 100 }; // the line shows when the day's worst is over this (store "settings")
let where = null;               // {name, lat, lon} (store "where", found once from the weather's place)
let air = null, at = 0, problem = null;

async function locate() {
  const w = await weather();
  if (!w?.place) { problem = 'The weather doesn’t know where home is yet: tell Opie your town or ZIP code.'; return false; }
  if (where?.name === w.place) return true;
  try {
    const g = (await web.json(placeUrl(w.place)))?.results?.[0];
    if (!g) { problem = `Couldn’t find ${w.place} on the map.`; return false; }
    where = { name: w.place, lat: Math.round(g.latitude * 100) / 100, lon: Math.round(g.longitude * 100) / 100 };
    await store.set('where', where);
    return true;
  } catch { problem = 'Couldn’t reach the air quality forecast.'; return false; }
}
async function refresh() {
  if (!(await locate())) { draw(); return; }
  try { air = read(await web.json(airUrl(where.lat, where.lon)), dayKey()); at = Date.now(); problem = null; }
  catch { problem = 'Couldn’t reach the air quality forecast.'; }
  line(); draw();
}

// ---- Today, only on a bad day ----
let lineFor = null;
function line() {
  const p = air?.peak, now = new Date();
  const bad = p && p.aqi > settings.above && new Date(p.at).getHours() >= now.getHours() - 1;
  const text = bad ? `Air quality: ${band(p.aqi).toLowerCase()} ${new Date(p.at).getHours() < 12 ? 'this morning' : new Date(p.at).getHours() < 17 ? 'this afternoon' : 'this evening'} (${p.aqi})` : '';
  if (text === lineFor) return;
  lineFor = text;
  if (text) today.show(text, new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0)); else today.clear();
}

function draw() {
  const top = h('div', { class: 'top' }, h('h1', { class: 'title' }, 'Air quality'), h('button', { class: 'btn soft', tap: openSettings }, 'When to show it'));
  if (!air) { put($app, top, h('div', { class: 'empty' }, h('p', { class: 'soft' }, problem || 'Looking at the air…'))); return; }
  const scale = h('div', { class: 'scale' }, BANDS.map(([topv, name], i) => h('div', { class: 'band' + (band(air.now ?? 0) === name ? ' on' : '') },
    h('span', { class: 'n' }, `${i ? BANDS[i - 1][0] + 1 : 0}${topv === Infinity ? '+' : '–' + topv}`), h('span', {}, name))));
  put($app, top, h('div', { class: 'body' },
    h('div', {}, h('div', { class: 'label' }, `Now, in ${where?.name || 'town'}`), h('div', { class: 'big' }, String(air.now ?? '—')), h('div', { class: 'lead' }, air.now != null ? band(air.now) : '')),
    h('p', { class: 'soft' },
      air.peak ? `Worst today ${air.peak.aqi} (${band(air.peak.aqi).toLowerCase()}) around ${hm(air.peak.at)}.` : '',
      air.tomorrow ? ` Tomorrow up to ${air.tomorrow.aqi}, ${band(air.tomorrow.aqi).toLowerCase()}.` : ''),
    scale,
    h('p', { class: 'soft' }, air.pollen ? 'Pollen today: ' + Object.entries(air.pollen).map(([k, v]) => `${k} ${pollenWord(v)}`).join(', ') + '.'
      : 'Pollen: there’s no free pollen forecast for the US that the tablet can use, so it isn’t shown here.')),
  h('div', { class: 'foot' }, `Forecast from Open-Meteo (Copernicus CAMS)${at ? `, ${hm(at)}` : ''}. Today shows a line when the worst of the day is over ${settings.above}.`));
}

function openSettings() {
  const pick = h('select', { class: 'field' }, [[50, 'Moderate or worse (over 50)'], [100, 'Unhealthy for sensitive groups or worse (over 100)'], [150, 'Unhealthy or worse (over 150)']]
    .map(([v, t]) => h('option', { value: v, selected: v === settings.above }, t)));
  sheet('When to show it on Today', [field('A line on Today when the air is', pick)], [
    { text: 'Cancel', soft: true, tap: (c) => c() },
    { text: 'Save', tap: async (c) => { settings = { above: Number(pick.value) }; await store.set('settings', settings); c(); lineFor = null; line(); draw(); } }]);
}

function answer() {
  if (!air) return problem || 'I don’t have the air quality yet.';
  return `The air quality index is ${air.now}, ${band(air.now).toLowerCase()}.` + (air.peak && air.peak.aqi > air.now ? ` It gets up to ${air.peak.aqi} around ${hm(air.peak.at)}.` : '')
    + (air.tomorrow ? ` Tomorrow up to ${air.tomorrow.aqi}.` : '');
}

(async () => {
  settings = (await store.get('settings')) || settings;
  where = await store.get('where');
  draw();
  whenShown(() => onAction(async (name) => { if (name === 'air') { if (!air || Date.now() - at > 30 * 60e3) await refresh(); return answer(); } return null; }));
  await refresh();
  setInterval(refresh, 30 * 60e3);
})();
