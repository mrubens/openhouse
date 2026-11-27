// The things on Home (docs/heartbeat.md, "Things"): a short strip where the countdown was, on Home and the resting
// screen, one line each, at most three, most urgent first, and each gone once it no longer matters:
//  - a reminder that's due ("Swim in 15 minutes"): until ten minutes after it starts, or put away (house.js reminders);
//  - a suggestion from the heartbeat or the hourly review ("Leave by 4:50 for Ducks at MSU", "Nothing planned for
//    dinner"): until its moment passes, or the check that found it stops finding it (dinner got planned);
//  - a countdown to a one-off event ("Trip to Chicago in 4 days"): until it starts (never a daily or weekly event);
//  - a broken app ("Drawing has a problem: ask Opie to fix it"): while its fix waits, or while it's failing.
//  - an app's own line ("Lunch: Popcorn Chicken · Tacos tomorrow", kit today.show): one per app, until it says.
//  - an app made on the tablet nobody kept or turned down yet ("Reading Streak is ready to try", build-waits.js):
//    first, until it's answered or put back after a day; a tap ("build") shows its card again.
// A tap does what the line is about: opens its tab ("open": Meals for dinner, Calendar for an event, Map to leave by),
// or asks Opie ("ask": "Help us plan dinner tonight"); a reminder or countdown opens Calendar. Its x takes it down, as
// Opie does when asked ("got it", "take that down"). The heartbeat writes these, not notes.
//
// file: things.json next to the chats: { items: [{id, kind, text, until, key?, app?, open?, ask?, by, at}], gone: {id: at} }
import fs from 'node:fs';
import { readJson, writeJson, unsaved } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const SHOWN = 3;
const EVERY = new Set(['daily', 'weekdays', 'weekly', 'biweekly']); // (monthly and yearly can count down: a birthday)
const plain = (t) => String(t || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '').replace(/\s+/g, ' ').trim();
const hm = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
/** "today", "tomorrow", "in 6 days", "in 3 weeks" (as home.jsx untilText). */
export function untilText(start, now) {
  const a = new Date(now); a.setHours(0, 0, 0, 0); const b = new Date(start); b.setHours(0, 0, 0, 0);
  const d = Math.round((b - a) / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : d < 21 ? `in ${d} days` : d < 70 ? `in ${Math.round(d / 7)} weeks` : `in ${Math.round(d / 30)} months`;
}
const STOP = new Set(['the', 'one', 'that', 'this', 'about', 'thing', 'take', 'down', 'got', 'for', 'and', 'line']);
const tabId = (t) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(t || '').trim().toLowerCase()) ? String(t).trim().toLowerCase() : null);
const askText = (t) => plain(t).slice(0, 160) || null;
const brokenText = (name) => `${name} has a problem: ask Opie to fix it`;

export function thingStore({ DIR, now = () => Date.now(), onChange = () => {} }) {
  const FILE = registered('things', path.join(DIR, '../things.json'));
  let st = { items: [], gone: {} };
  st = { ...st, ...readJson(FILE, {}) };
  // A change is saved before it counts: one that doesn't save (things.json saved by a newer release, which store.js never
  // writes over; a full disk) is taken back in memory, and the throw (marked unsaved) reaches the tap, the app or the tool.
  const save = (before) => {
    try { writeJson(FILE, st); }
    catch (e) { if (before) st = before; console.error('[things]', e.message); throw Object.assign(e, { unsaved: true }); }
    onChange();
  };
  const copy = () => structuredClone(st);
  let fixesOf = () => [], waitsOf = () => [], putAway = () => {};

  /** The stored ones still current (the past ones go). */
  function live() {
    const t = now(), before = st.items.length;
    st.items = st.items.filter((x) => x.until > t);
    for (const [id, at] of Object.entries(st.gone)) if (at < t - 30 * DAY) delete st.gone[id];
    if (st.items.length !== before) { try { save(); } catch {} } // (the past ones go from memory anyway: they'd go at a restart too)
    return st.items;
  }

  /** A suggestion (or a broken app) put up. The same key, or the same words, replaces the one there. */
  function put({ text, until, minutes, key = null, kind = 'suggestion', app = null, open = null, ask = null, by = 'heartbeat' }) {
    const t = now(), words = plain(text).slice(0, 90);
    if (!words) return null;
    let end = Number(until) || Date.parse(until) || (Number(minutes) ? t + Number(minutes) * MIN : t + 3 * HOUR);
    end = Math.min(Math.max(end, t + 10 * MIN), t + (kind === 'broken' ? 3 * DAY : DAY));
    const same = (x) => (key && x.key === key) || x.text.toLowerCase() === words.toLowerCase() || (app && x.app === app && x.kind === kind);
    const prev = live().find(same), before = copy();
    const item = { id: prev?.id || `t-${t.toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind, text: words, until: end, ...(key ? { key } : {}), ...(app ? { app } : {}), ...(tabId(open) ? { open: tabId(open) } : {}), ...(askText(ask) ? { ask: askText(ask) } : {}), by, at: t };
    st.items = [item, ...st.items.filter((x) => x !== prev)].slice(0, 20);
    delete st.gone[item.id];
    save(before);
    return { item, fresh: !prev };
  }

  /**
   * An app's own line (kit today.show, POST /today/line): one per app, kind "app", at most 80 characters, up until
   * `until` (10 minutes to a day from now; 3 hours if not given). It replaces only that app's earlier line, and a tap
   * opens the app's tab. Gone with takeApp, Opie's take_down_thing, or its x.
   */
  function putApp(app, { text, until, sleep }) {
    const t = now(), words = plain(text).slice(0, 80);
    if (!tabId(app)) return null;
    if (!words) { takeApp(app); return null; }
    let end = Number(until) || Date.parse(until) || t + 3 * HOUR;
    end = Math.min(Math.max(end, t + 10 * MIN), t + DAY);
    const was = live().find((x) => x.kind === 'app' && x.app === app);
    const quiet = sleep === false; // kept off the sleep screen (kit today.show(text, until, { sleep: false }))
    if (was && was.text === words && was.until === end && !!was.sleepOff === quiet) return { item: was, fresh: false };
    const before = copy();
    const item = { id: was?.id || `t-${t.toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: 'app', text: words, until: end, app, open: tabId(app), by: `app:${app}`, at: t, ...(quiet ? { sleepOff: true } : {}) };
    st.items = [item, ...st.items.filter((x) => x !== was)].slice(0, 20);
    if (was && st.gone[item.id] && was.text !== words) delete st.gone[item.id]; // (new words come back after an x; the same ones stay down)
    save(before);
    return { item, fresh: !was };
  }
  /** The app's own line taken down (kit today.clear). */
  function takeApp(app) {
    const kept = copy(), before = st.items.length;
    st.items = st.items.filter((x) => !(x.kind === 'app' && x.app === app));
    if (st.items.length !== before) save(kept);
    return before !== st.items.length;
  }

  /** Taken down (Opie when asked, a tap): a stored one goes; a countdown, reminder or broken app is hidden from here. */
  function take(id) {
    const s = String(id || ''), before = copy();
    const was = st.items.find((x) => x.id === s);
    if (was?.kind === 'app') st.gone[s] = now(); // kept, hidden: the app putting the same words up again doesn't bring it back
    else if (was) st.items = st.items.filter((x) => x !== was);
    else if (s.startsWith('rem-')) { try { putAway(s.slice(4)); } catch {} st.gone[s] = now(); } // (put away on every screen, as "Got it")
    else if (/^(cd|rem|fix|t|build)-/.test(s)) st.gone[s] = now(); // (a waiting build stays waiting: only its line is hidden)
    else return false;
    save(before);
    return true;
  }
  /** The ones a finding put up, whose finding went away (the clash got sorted, dinner got planned): no AI. */
  function settle(keys) {
    const kept = copy(), before = st.items.length;
    st.items = st.items.filter((x) => !x.key || x.by !== 'heartbeat' || keys.has(x.key));
    if (st.items.length !== before) { save(kept); return before - st.items.length; }
    return 0;
  }

  /** Everything current, most urgent first. house: house.js view() (events with countdown, reminders due). */
  function all(house = {}) {
    const t = now(), out = [];
    const rem = new Set();
    for (const r of house.reminders || []) {
      const m = Math.ceil((Date.parse(r.start) - t) / MIN);
      rem.add(r.key);
      out.push({ id: `rem-${r.key}`, kind: 'reminder', text: `${plain(r.title)} ${m <= 0 ? 'now' : m === 1 ? 'in a minute' : m < 60 ? `in ${m} minutes` : 'at ' + hm(r.start)}`, when: Date.parse(r.start), who: r.who || null, key: r.key, open: 'calendar' });
    }
    for (const x of live()) out.push({ id: x.id, kind: x.kind, text: x.kind === 'broken' ? brokenText(x.text) : x.text, when: x.kind === 'broken' ? t + DAY : x.until, until: x.until, ...(x.app ? { app: x.app } : {}), ...(x.open ? { open: x.open } : {}), ...(x.ask ? { ask: x.ask } : {}) });
    let fixes = []; try { fixes = fixesOf() || []; } catch {}
    for (const f of fixes) if (!out.some((x) => x.app === f.app && x.kind === 'broken')) out.push({ id: `fix-${f.id}`, kind: 'broken', text: brokenText(f.name || f.app), when: t + DAY, app: f.app });
    // An app made here, waiting to be kept (build-waits.js): first, so it isn't missed; a tap opens it to try again.
    let waits = []; try { waits = waitsOf() || []; } catch {}
    for (const w of waits) out.push({ id: `build-${w.id}`, kind: 'waiting', text: `${plain(w.name)} is ready to try`, when: t - DAY, app: w.app, build: w.id });
    const seen = new Set();
    for (const e of [...(house.events || [])].filter((x) => x.countdown && Date.parse(x.start) > t && !(x.local && EVERY.has(x.repeat))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
      const k = `${e.uid || e.id}|${e.start}`, series = String(e.id || e.uid || e.title);
      if (rem.has(k) || seen.has(series)) continue; seen.add(series);
      out.push({ id: `cd-${k}`, kind: 'countdown', text: `${plain(e.title)} ${untilText(e.start, t)}`, when: Date.parse(e.start), title: plain(e.title), start: e.start, open: 'calendar' });
    }
    return out.filter((x) => !st.gone[x.id]).sort((a, b) => a.when - b.when);
  }
  /** What the strip shows. */
  const strip = (house) => all(house).slice(0, SHOWN).map(({ when, key, ...x }) => x);
  /** For a model: each one with its id, newest moment last. */
  const describe = (house) => { const l = all(house); return l.length ? `The things on Home (one line each; the first ${SHOWN} show):\n${l.map((x) => `- ${x.id} [${x.kind}] ${x.text}${x.until ? ` (until ${hm(x.until)})` : ''}`).join('\n')}` : 'The things on Home: none.'; };

  // ---- tools ----
  // The heartbeat's and the hourly review's: put one up, take one of its own down. Opie's: take any down.
  const SHOW = { name: 'show_thing', description: 'Put one short line on Home, where everyone sees it: a reminder or a suggestion for the next few hours ("Leave by 4:50 for Ducks at MSU", "Nothing planned for dinner: tacos or pasta?", "Pack Leo\'s swim bag tonight"). At most about 8 words, plain, people\'s names not pronouns, no emoji. "until": the local time its moment passes (the time to leave, the end of dinner time, tonight); it comes down then by itself, or as soon as what it\'s about is sorted. A tap on it should do something: give "open", the tab it\'s about, or "ask", what Opie is asked when it\'s tapped (a dinner line: open "meals", or ask "Help us plan dinner tonight").',
    inputSchema: { type: 'object', required: ['text', 'until'], properties: { text: { type: 'string' }, until: { type: 'string', description: 'Local date and time, as 2026-11-20T16:50' },
      open: { type: 'string', description: 'A tab on the screen to open when it\'s tapped, by id: calendar, meals, lists, chores, map, weather, recipes, photos' },
      ask: { type: 'string', description: 'Or, when it\'s tapped, what Opie is asked, in the household\'s words ("Help us plan dinner tonight", "How long to MSU right now?")' } } } };
  const TAKE = { name: 'take_down_thing', description: 'Take a line off Home: when someone says they\'ve got it, it\'s done, or to take it down ("got it", "take that down", "we know"). Pass its id from the things on Home, or words from it.',
    inputSchema: { type: 'object', required: ['thing'], properties: { thing: { type: 'string' } } } };
  const tools = [SHOW, TAKE];
  /** ctx: { by: 'heartbeat' | 'assistant', key? (the finding), house? } */
  function call(name, a = {}, ctx = {}) {
    const ok = (t) => ({ content: [{ type: 'text', text: t }] }), err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (name === 'show_thing') {
      if (ctx.by !== 'heartbeat') return err('Only the background check-ins put things on Home.');
      let r; try { r = put({ text: a.text, until: a.until, open: a.open, ask: a.ask, key: ctx.key || null }); } catch (e) { return err(unsaved(e).error); }
      return r ? ok(`${r.fresh ? 'Put up' : 'Changed'} ${r.item.id}: ${r.item.text} (until ${hm(r.item.until)})`) : err('Say what it is.');
    }
    if (name === 'take_down_thing') {
      const w = String(a.thing || '').trim(), list = all(ctx.house || {});
      let x = list.find((y) => y.id === w);
      if (!x) { const t = w.toLowerCase().split(/\W+/).filter((s) => s.length > 2 && !STOP.has(s)); x = t.length ? list.map((y) => [y, t.filter((s) => y.text.toLowerCase().includes(s)).length]).filter(([, n]) => n >= Math.ceil(t.length * 0.5)).sort((p, q) => q[1] - p[1])[0]?.[0] : null; }
      if (!x && list.length === 1 && /^(it|that|this|the one)?$/i.test(w)) x = list[0];
      if (!x) return err(list.length ? `Which one? ${list.map((y) => `${y.id}: ${y.text}`).join('; ')}` : 'Nothing is on Home.');
      if (ctx.by === 'heartbeat' && !st.items.some((y) => y.id === x.id && y.by === 'heartbeat')) return err('Only your own.');
      try { take(x.id); } catch (e) { return err(unsaved(e).error); }
      return ok(`Took down: ${x.text}`);
    }
    return err(`unknown tool ${name}`);
  }
  return { put, putApp, takeApp, take, settle, all, strip, describe, tools, call, setFixes: (fn) => { fixesOf = fn; }, setWaits: (fn) => { waitsOf = fn; }, setPutAway: (fn) => { putAway = fn; }, items: () => live() };
}
