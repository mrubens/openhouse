// The air: the US Air Quality Index from Open-Meteo's air-quality forecast (CAMS, no key), and pollen where it has
// any (only Europe, today). No page or kit here.

const POLLEN = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'];
export const placeUrl = (name) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`;
export const airUrl = (lat, lon) => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
  `&current=us_aqi&hourly=us_aqi,${POLLEN.join(',')}&forecast_days=2&timezone=auto`;

/** The EPA's bands for the US AQI. */
export const BANDS = [
  [50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive groups'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous'],
];
export const band = (aqi) => BANDS.find(([top]) => aqi <= top)[1];

/** {now, peak: {aqi, at}, tomorrow: peak, pollen: {grass: level...} | null} from the forecast's JSON, for a day (YYYY-MM-DD). */
export function read(j, day) {
  const t = j?.hourly?.time || [], a = j?.hourly?.us_aqi || [];
  const peakOn = (d) => t.reduce((best, x, i) => (x.startsWith(d) && a[i] != null && (!best || a[i] > best.aqi) ? { aqi: a[i], at: x } : best), null);
  const tomorrow = (() => { const [y, m, dd] = day.split('-').map(Number); const n = new Date(y, m - 1, dd + 1); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; })();
  let pollen = null;
  for (const k of POLLEN) {
    const v = (j?.hourly?.[k] || []).filter((x, i) => x != null && t[i]?.startsWith(day));
    if (v.length) (pollen ||= {})[k.replace('_pollen', '')] = Math.max(...v);
  }
  return { now: j?.current?.us_aqi ?? null, peak: peakOn(day), tomorrow: peakOn(tomorrow), pollen };
}
/** Grains per cubic meter, in words (the European scale Open-Meteo's pollen uses). */
export const pollenWord = (v) => (v < 10 ? 'low' : v < 50 ? 'moderate' : v < 200 ? 'high' : 'very high');
