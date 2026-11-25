// The household's settings for the house: night hours, the usual reminder, how apps' notes show on the calendar.
import { SHOWS, NIGHT, hhmm, str } from './util.js';

export default function (house) {
  const { data, save } = house;
  function settings(b) {
    if (b.night === false || b.night === null) data.settings.night = false;
    else if (b.night) data.settings.night = { from: hhmm(b.night.from, NIGHT.from), to: hhmm(b.night.to, NIGHT.to) };
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
  function putAway(key) {
    const k = str(key, 220);
    if (!k) return { error: 'Which reminder (its key)?' };
    data.reminded = [...data.reminded.filter((x) => x !== k), k].slice(-200);
    save(); return { ok: true };
  }
  return { settings, putAway };
}
