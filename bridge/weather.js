// The weather for the family's place (household location: a ZIP code or a town), from Open-Meteo: free, no
// account or key. Looked up at most every 10 minutes and cached; the home screen's weather card reads it.
//   GET /weather  { place, temp, code, condition, isDay, high, low, feels, humidity, wind, sunrise, sunset,
//                   hours: [{time, temp, code, isDay, rain}] (24), days: [{date, high, low, code, condition, rain}] (7), at,
//                   sense: [{text, until}] }  (°F, mph; sense: weather-sense.js, the lines tying it to the household's plans)

const CONDITIONS = [
  [[0], 'Clear'], [[1], 'Mostly clear'], [[2], 'Partly cloudy'], [[3], 'Cloudy'], [[45, 48], 'Fog'],
  [[51, 53, 55, 56, 57], 'Drizzle'], [[61, 63, 66, 80, 81], 'Rain'], [[65, 67, 82], 'Heavy rain'],
  [[71, 73, 75, 77, 85, 86], 'Snow'], [[95, 96, 99], 'Thunderstorms'],
];
const conditionOf = (code) => CONDITIONS.find(([codes]) => codes.includes(code))?.[1] || 'Cloudy';

export function weatherRoutes({ json, household }) {
  let cache = null, where = null; // { for: location, lat, lon, place }
  let sense = () => [];

  async function locate(location) {
    if (where?.for === location) return where;
    const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`)).json();
    const g = r.results?.[0];
    if (!g) throw new Error(`couldn't find ${location}`);
    return (where = { for: location, lat: g.latitude, lon: g.longitude, place: g.name });
  }

  async function current() {
    const location = String(household()?.location || '').trim();
    if (!location) return { error: 'no location' };
    if (cache?.for === location && Date.now() - cache.at < 10 * 60e3) return cache;
    const w = await locate(location);
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}` +
      `&current=temperature_2m,weather_code,is_day,apparent_temperature,relative_humidity_2m,wind_speed_10m` +
      `&hourly=temperature_2m,weather_code,is_day,precipitation_probability,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
    const f = await (await fetch(u)).json();
    const code = f.current?.weather_code ?? 3;
    // the next 24 hours, from the current hour
    const nowIso = (f.current?.time || '').slice(0, 13);
    const start = Math.max(0, (f.hourly?.time || []).findIndex((t) => t.slice(0, 13) === nowIso));
    const hours = (f.hourly?.time || []).slice(start, start + 24).map((t, i) => ({ time: t, temp: Math.round(f.hourly.temperature_2m[start + i]),
      code: f.hourly.weather_code[start + i], isDay: f.hourly.is_day[start + i] === 1, rain: f.hourly.precipitation_probability?.[start + i] ?? null }));
    // the next 48 hours, with words and wind, for weather-sense.js (not served)
    const ahead = (f.hourly?.time || []).slice(start, start + 48).map((t, i) => ({ time: t, temp: Math.round(f.hourly.temperature_2m[start + i]),
      condition: conditionOf(f.hourly.weather_code[start + i]), rain: f.hourly.precipitation_probability?.[start + i] ?? null, wind: Math.round(f.hourly.wind_speed_10m?.[start + i] ?? 0) }));
    const days = (f.daily?.time || []).map((t, i) => ({ date: t, high: Math.round(f.daily.temperature_2m_max[i]), low: Math.round(f.daily.temperature_2m_min[i]),
      code: f.daily.weather_code[i], condition: conditionOf(f.daily.weather_code[i]), rain: f.daily.precipitation_probability_max?.[i] ?? null }));
    cache = { for: location, place: w.place, temp: Math.round(f.current?.temperature_2m), code, condition: conditionOf(code),
      isDay: f.current?.is_day === 1, high: Math.round(f.daily?.temperature_2m_max?.[0]), low: Math.round(f.daily?.temperature_2m_min?.[0]),
      feels: Math.round(f.current?.apparent_temperature), humidity: f.current?.relative_humidity_2m, wind: Math.round(f.current?.wind_speed_10m),
      sunrise: f.daily?.sunrise?.[0] || null, sunset: f.daily?.sunset?.[0] || null, hours, days, ahead, at: Date.now() };
    return cache;
  }

  return Object.assign(async function handle(req, res, url) {
    if (req.method !== 'GET' || url.pathname !== '/weather') return false;
    const served = (w) => { if (w.error) return w; const { ahead, ...rest } = w; return { ...rest, sense: sense() }; };
    try { json(res, 200, served(await current())); } catch (e) { json(res, 200, cache ? served(cache) : { error: String(e.message || e) }); }
    return true;
  }, { current, useSense: (f) => { sense = f; } }); // (the voice's weather tool: live-tools.js)
}
