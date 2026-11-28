// The household's settings for the house: night hours, the resting screen, the usual reminder, how apps' notes show
// on the calendar.
import { SHOWS, NIGHT, hhmm, str } from './util.js';

/** The resting screen (when nobody has touched the screen for a while), the same on every screen of the household:
 *  after: minutes before it starts (0: never by day; night hours still go dark), every: seconds each photo stays,
 *  order: 'order' | 'shuffle', fit: 'fit' (the whole photo) | 'fill' (the screen, cropped), show: what's over the photo
 *  {time, weather, next, captions}, calendar: the Calendar instead of the photos. */
export const RESTING = { after: 8, every: 15, order: 'order', fit: 'fit', show: { time: true, weather: true, next: true, captions: true }, calendar: false };
export const REST_AFTER = [1, 2, 5, 8, 10, 15, 30, 0];
const SHOWN = Object.keys(RESTING.show);

export default function (house) {
  const { data, save } = house;
  function settings(b) {
    if (b.night === false || b.night === null) data.settings.night = false;
    else if (b.night) data.settings.night = { from: hhmm(b.night.from, NIGHT.from), to: hhmm(b.night.to, NIGHT.to) };
    if (b.resting && typeof b.resting === 'object') { const r = restingFrom(b.resting); if (r.error) return r; data.settings.resting = r; }
    if (b.remind !== undefined) { const m = house.remindMin(b.remind); if (m === undefined || m < 0) delete data.settings.remind; else data.settings.remind = m; }
    if (b.remindAloud !== undefined) data.settings.remindAloud = !!b.remindAloud;
    // An app's things on the calendar: {app, show: 'week' | 'today' | 'off'}; fromAppsOrder: the apps' ids, first first.
    if (b.fromApp && typeof b.fromApp === 'object') {
      const app = str(b.fromApp.app, 80);
      if (app && SHOWS.includes(b.fromApp.show)) data.settings.fromApps = { ...(data.settings.fromApps || {}), [app]: b.fromApp.show };
    }
    if (Array.isArray(b.fromAppsOrder)) data.settings.fromAppsOrder = [...new Set(b.fromAppsOrder.map((x) => str(x, 80)).filter(Boolean))].slice(0, 60);
    save(); return { ok: true };
  }
  /** The resting screen as it is now, every key there (RESTING's where unchanged). */
  function resting() {
    const r = data.settings.resting || {};
    return { ...RESTING, ...r, show: { ...RESTING.show, ...(r.show || {}) } };
  }
  /** [part] over the resting screen as it is: only the keys given change. */
  function restingFrom(part) {
    const r = resting();
    if (part.after !== undefined) { const m = Number(part.after); if (!REST_AFTER.includes(m)) return { error: `after: one of ${REST_AFTER.join(', ')} minutes (0: never)` }; r.after = m; }
    if (part.every !== undefined) { const s = Math.round(Number(part.every)); if (!(s >= 5 && s <= 120)) return { error: 'every: 5 to 120 seconds' }; r.every = s; }
    if (part.order !== undefined) { if (!['order', 'shuffle'].includes(part.order)) return { error: "order: 'order' or 'shuffle'" }; r.order = part.order; }
    if (part.fit !== undefined) { if (!['fit', 'fill'].includes(part.fit)) return { error: "fit: 'fit' or 'fill'" }; r.fit = part.fit; }
    if (part.show && typeof part.show === 'object') for (const k of SHOWN) if (part.show[k] !== undefined) r.show[k] = !!part.show[k];
    if (part.calendar !== undefined) r.calendar = !!part.calendar;
    return r;
  }
  function putAway(key) {
    const k = str(key, 220);
    if (!k) return { error: 'Which reminder (its key)?' };
    data.reminded = [...data.reminded.filter((x) => x !== k), k].slice(-200);
    save(); return { ok: true };
  }
  return { settings, putAway, resting };
}
