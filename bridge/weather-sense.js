// Weather sense: at most two short lines that tie the forecast to the household's plans ("Rain all day Thursday:
// Thanksgiving at 4:30, leave a little early"), shown on the Weather tab and the Home card (GET /weather's `sense`).
// The cloud's text model writes them on OpenAI's Flex tier, never per view: once after 6 AM, once after noon, and when
// the forecast or the next days' plans change (at most every two hours, a few times a day), never in night hours.
// It gets the forecast and the next three days' events in the household's own clock, and the people; it decides what's
// worth a line, and most of the time that may be nothing. Kept in chats/weather-sense.json.
import fs from 'node:fs';
import path from 'node:path';
import { reviewCost } from './heartbeat-review.js';

export const SENSE_RULES = `You add a line or two under a household's weather forecast on their home screen, where everyone sees it in passing. Below are the forecast, hour by hour and day by day, the household's people, and their plans for the next few days, all in the household's own clock.
Write a line only when the weather meets their plans in a way worth knowing: rain, snow, wind, ice, heat or real cold at the time and place of something they're doing (school drop-off, a game, a drive, a party), or a clear change from today that matters to them. Say what it means for them, with the thing, its time and the person: "Rain all day Thursday: Thanksgiving at 4:30, leave a little early.", "23° at drop-off tomorrow: hats and gloves.", "Dry until about 7: Maya's soccer at 4 is fine."
At most two lines, the most useful first, each under about 90 characters, plain words, no emoji, never "today's forecast is" or a summary of the weather by itself. Nothing notable: no lines. Better none than a filler line.
Each line has "until": the local time its moment passes (the start of the thing, or the end of the weather), as YYYY-MM-DDTHH:MM.
Reply with only JSON: {"lines": [{"text": "...", "until": "2026-11-26T16:30"}]} or {"lines": []}.`;

export const SENSE_CAPS = { perDay: 8, gapMs: 2 * 3600e3, slots: [6, 12] };

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const textOf = (out) => (out || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

/** The next three days' events, in local time ("Thu Nov 26 4:30 PM Thanksgiving at Nana's (Sam & Leo)"). */
function plans(events, now) {
  const end = new Date(now); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 3);
  return (events || []).filter((e) => { const s = new Date(e.start); return s < end && new Date(e.end || e.start) >= now - (e.allDay ? 864e5 : 0); })
    .sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 30)
    .map((e) => { const s = new Date(String(e.start).length <= 10 ? e.start + 'T00:00' : e.start), who = [e.who, ...(e.also || [])].filter(Boolean).join(' & ');
      return `- ${s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${e.allDay ? 'all day' : hm(s)} ${cut(e.title, 60)}${e.place ? ` at ${cut(e.place, 60)}` : ''}${who ? ` (${cut(who, 40)})` : ''}`; });
}

/** The forecast as the model reads it: hours as local clock times, days by name. */
function forecast(w) {
  const name = (s) => new Date(s).toLocaleDateString('en-US', { weekday: 'short' });
  const hours = (w.ahead || w.hours || []).map((h) => { const d = new Date(h.time); return `${name(h.time)} ${d.toLocaleTimeString('en-US', { hour: 'numeric' })} ${h.temp}° ${h.condition || ''}${h.rain >= 10 ? ` ${h.rain}%` : ''}${h.wind >= 15 ? ` wind ${h.wind}` : ''}`; });
  const days = (w.days || []).map((d) => `${new Date(d.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}: ${d.condition}, high ${d.high}°, low ${d.low}°${d.rain != null ? `, ${d.rain}% chance of rain/snow` : ''}`);
  return `Now in ${w.place}: ${w.temp}° (feels ${w.feels}°), ${w.condition}, wind ${w.wind} mph. Sunrise ${hm(new Date(w.sunrise))}, sunset ${hm(new Date(w.sunset))}.\n\nHour by hour:\n${hours.join('\n')}\n\nDay by day:\n${days.join('\n')}`;
}

/** What would make the lines worth writing again: each of the next three days' kind of weather, rain and temperatures
 *  in broad steps, and the plans (their times and titles). */
export function fingerprint(w, events, now = new Date()) {
  const kind = (c) => (c >= 95 ? 't' : (c >= 71 && c <= 77) || c === 85 || c === 86 ? 's' : c >= 51 ? 'r' : c >= 45 ? 'f' : 'c');
  const days = (w.days || []).slice(0, 3).map((d) => `${kind(d.code)}${Math.round((d.rain || 0) / 30)}${Math.round(d.high / 8)}${Math.round(d.low / 8)}`).join(',');
  return days + '|' + plans(events, now).join('|');
}

export function weatherSense({ DIR, weather, events = () => [], people = () => '', ai, ready = () => true, night = () => false, clock = () => Date.now(), every = 15 * 60e3 }) {
  const FILE = path.join(DIR, 'weather-sense.json');
  let st = { lines: [], at: 0, print: '', runs: {}, failedAt: 0 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const save = () => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(st)); } catch (e) { console.error('[sense]', e.message); } };
  let running = false;

  /** The lines still current, for GET /weather. */
  const lines = () => st.lines.filter((l) => !l.until || new Date(l.until).getTime() > clock()).map(({ text, until }) => ({ text, until }));

  /** Why it should run now, or null: the morning or noon slot not yet done, or the forecast or plans changed. */
  function due(print) {
    const now = new Date(clock()), today = dayKey(now), n = st.runs[today] || 0;
    if (n >= SENSE_CAPS.perDay || clock() - st.failedAt < 30 * 60e3) return null;
    for (const h of SENSE_CAPS.slots) { const at = new Date(now); at.setHours(h, 0, 0, 0); if (+now >= +at && st.at < +at) return h === 6 ? 'morning' : 'noon'; }
    if (print !== st.print && clock() - st.at >= SENSE_CAPS.gapMs) return 'changed';
    return null;
  }

  /** One look: returns {ran, why, lines, cost, tier} or {ran: false, why}. force: run whatever the schedule says. */
  async function tick({ force = false } = {}) {
    if (running || !ready() || night()) return { ran: false, why: 'not now' };
    let w; try { w = await weather(); } catch { return { ran: false, why: 'no weather' }; }
    if (!w || w.error) return { ran: false, why: 'no weather' };
    const now = new Date(clock()), ev = events(), print = fingerprint(w, ev, now), why = force ? 'asked' : due(print);
    if (!why) return { ran: false, why: 'not due' };
    running = true;
    try {
      const input = `It is ${now.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.\n\n` +
        `${forecast(w)}\n\nThe household:\n${cut(people(), 1500) || '- not set up'}\n\nTheir plans, the next three days:\n${plans(ev, now).join('\n') || '- nothing on the calendar'}` +
        (st.lines.length ? `\n\nThe lines shown now (keep, change or drop them):\n${st.lines.map((l) => `- ${l.text}`).join('\n')}` : '');
      let r, tier = 'flex';
      try { r = await ai({ instructions: SENSE_RULES, input: [{ role: 'user', content: input }], tools: [], tier }); }
      catch { tier = 'standard'; r = await ai({ instructions: SENSE_RULES, input: [{ role: 'user', content: input }], tools: [], tier }); } // Flex busy: the 6 AM lines shouldn't wait an hour
      const ran = r.tier || tier, cost = reviewCost(r.usage, ran);
      const raw = textOf(r.output), m = raw.match(/\{[\s\S]*\}/);
      let got = []; try { got = JSON.parse(m ? m[0] : raw).lines || []; } catch {}
      st.lines = got.filter((l) => l && typeof l.text === 'string' && l.text.trim()).slice(0, 2)
        .map((l) => ({ text: cut(l.text, 140), until: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(l.until || '')) ? String(l.until).slice(0, 16) : null }));
      st.at = clock(); st.print = print; st.failedAt = 0;
      const today = dayKey(now); st.runs = { [today]: (st.runs[today] || 0) + 1 };
      save();
      return { ran: true, why, lines: lines(), cost, tier: ran, tokens: r.usage };
    } catch (e) {
      st.failedAt = clock(); save();
      return { ran: false, why: 'failed', error: e.code || e.message || 'failed' };
    } finally { running = false; }
  }

  let timer = null;
  if (every) { timer = setInterval(() => tick().then((x) => x.ran || x.error ? onRun(x) : null).catch(() => {}), every); timer.unref?.(); }
  let onRun = () => {};
  return { lines, tick, onRun: (f) => { onRun = f; }, stop: () => clearInterval(timer) };
}
