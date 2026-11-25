// Follow-ups for later: Opie saying or doing something at a time it was asked to, once or repeating.
//   "Remind Maya at 4 to practice piano, out loud."          kind say: at 4 the tablet says it, and it's a line on Home
//   "In 20 minutes, ask if the oven's off."                    kind say (the session listens a moment after, as always)
//   "Check at 5 whether the package came, and tell me."        kind do: at 5 the text model does it with the household's
//                                                              tools (as the heartbeat's review runs it), then says it
//   "Every weekday at 7:30, tell the kids to get their shoes on."   repeat: an iCal rule the model writes (repeat-rule.js),
//                                                              FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR, said back in plain words
//
// Speaking is the kit's say (voice.js /voice/say: the tablet's voice, or a short live session opened to say it), never
// in the night hours or after Sleep now: then it's only the line on Home. A line stays until it's taken down, or two hours.
// They fire within about 20 seconds of their time. One that's due when the bridge starts (the tablet was off) fires
// once if it's less than an hour late; later than that it's dropped (a repeating one just waits for its next time).
//
// file: later.json next to the chats: { items: [{id, kind, what, at, rule?, start?, fired?, made}] } (at: its next time)
import fs from 'node:fs';
import { readJson, writeJson, unsaved } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';
import { isNight } from './heartbeat.js';
import { runReview } from './heartbeat-review.js';
import { parseRule, nextAfter, ruleWords, fromOld } from './repeat-rule.js';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const LATE = HOUR; // later than this, a missed one is dropped
const MAX = 60; // kept at once
const hm = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const whenText = (t, now) => {
  const d = new Date(t), a = new Date(now); a.setHours(0, 0, 0, 0); const b = new Date(t); b.setHours(0, 0, 0, 0);
  const days = Math.round((b - a) / DAY);
  return `${days === 0 ? 'today' : days === 1 ? 'tomorrow' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${hm(t)}`;
};
const plain = (t) => String(t || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '').replace(/\s+/g, ' ').trim();

/** A local time ("16:00", "4:30 pm", "2026-11-22T07:30") or minutes from now, as ms; null if it isn't one. */
export function parseWhen(when, inMinutes, now) {
  if (Number(inMinutes) > 0) return now + Math.round(Number(inMinutes) * MIN);
  const s = String(when || '').trim().toLowerCase();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})/);
  if (m) return +new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = s.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m || (!m[2] && !m[3])) return null;
  let h = +m[1]; const mi = +(m[2] || 0);
  if (m[3]) { h %= 12; if (m[3].startsWith('p')) h += 12; }
  if (h > 23 || mi > 59) return null;
  const d = new Date(now); d.setHours(h, mi, 0, 0);
  if (+d < now - MIN) d.setDate(d.getDate() + 1); // a time that's past today: tomorrow
  return +d;
}

export const LATER_TOOL = { name: 'later', description: 'Say or do something at a later time, once or repeating: "remind Maya at 4 to practice piano, out loud", ' +
    '"in 20 minutes ask if the oven\'s off", "check at 5 whether the package came and tell me", "every weekday at 7:30 tell the kids to get their shoes on". ' +
    'kind "say": then the tablet says `what` aloud, word for word, and shows it on Home. kind "do": then you do `what` with your tools (look something up, check the calendar, the weather, a device) and say what you found. ' +
    'Give `when` (a local time) or `in_minutes`. Give `repeat` only when they asked for it to repeat. For a reminder before an event on the calendar, use calendar_event\'s remind instead; for a countdown that rings, the timer.',
  inputSchema: { type: 'object', required: ['kind', 'what'], properties: {
    kind: { type: 'string', enum: ['say', 'do'] },
    what: { type: 'string', description: 'For say: the exact words to say then, to whoever it\'s for ("Maya, time to practice piano."; "Is the oven off?"). For do: what to do then, in a sentence ("Check whether the package came and tell them").' },
    when: { type: 'string', description: 'A local time: "16:00" (today, or tomorrow if that\'s past) or "2026-11-24T07:30". For a repeat, its first time.' },
    in_minutes: { type: 'number', description: 'Instead of when: minutes from now' },
    repeat: { type: 'string', description: 'Only when they asked for it to repeat: an iCal repeat rule (RRULE), with `when` its first time. ' +
      'Examples: FREQ=DAILY; FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR (weekdays); FREQ=WEEKLY;BYDAY=MO,WE,FR; FREQ=WEEKLY;INTERVAL=2;BYDAY=TU (every other Tuesday); ' +
      'FREQ=HOURLY;INTERVAL=2;BYHOUR=8,10,12,14,16,18 (every 2 hours from 8 to 6); FREQ=DAILY;BYHOUR=8,15 (8 AM and 3 PM); FREQ=MONTHLY;BYMONTHDAY=1; ' +
      'FREQ=MONTHLY;BYDAY=-1FR (the last Friday); add UNTIL=20270604 (until a date) or COUNT=5 (5 times). The answer says it back in words: check it matches what they meant.' },
  } } };
export const LIST_TOOL = { name: 'later_list', description: 'What is set for later (with later): list them, or cancel one by its id ("never mind the piano reminder", "stop the shoes one").',
  inputSchema: { type: 'object', properties: { cancel: { type: 'string', description: 'An id from the list: cancels it, and all its repeats' } } } };

// A "do" follow-up, run by the text model in the background with the household's tools (heartbeat-review.js runReview).
const DO_RULES = 'Earlier, someone in the household asked you to do something at this time, and now it is that time. Nobody is talking to you right now. ' +
  'Do it with your tools, as they asked. Then reply with what to tell them, on one line: one or two short plain sentences, said aloud on the tablet and shown on its screen, ' +
  'like "The package came at 2:10: it\'s on the porch." Say what you found, or plainly that you couldn\'t find out. No emoji, no lists.';

/**
 * deps: DIR (the chats folder), now(), say(text) (voice.js), things (things.js), night() (house.js night hours),
 * asleep() (Sleep now), talk (live-tools.js recentTalk: what was said, so a reply has context), and for kind do:
 * ai(q) (the cloud's text model; null or throwing when it isn't there), live ({tools(), callTool, instructions()}),
 * picture() (today as the screen knows it). every: ms between looks (0: none, for a test).
 */
export function laterRoutes({ DIR, now = () => Date.now(), say = () => false, things = null, night = () => null, asleep = () => false,
  talk = null, ai = null, live = null, picture = () => '', every = 20e3, onChange = () => {} }) {
  const FILE = registered('later', path.join(DIR, '../later.json'));
  let st = { items: [] };
  st = { ...st, ...readJson(FILE, {}) };
  st.items = (st.items || []).filter((x) => x && x.id && x.at);
  for (const x of st.items) if (x.repeat && !x.rule) { x.rule = fromOld(x.repeat, x.dow); x.start = x.at; x.fired = 0; delete x.repeat; delete x.time; delete x.dow; } // (kept before rules)
  const ruleOf = (x) => (x.rule ? parseRule(x.rule) : null);
  // A change is saved before it counts: one that doesn't save (later.json saved by a newer release, which store.js never
  // writes over; a full disk) is taken back in memory (before), and the throw reaches whoever asked (never "Set" for it).
  const save = (before) => {
    try { writeJson(FILE, st); }
    catch (e) { if (before) st = before; console.error('[later]', e.message); throw e; }
    onChange();
  };
  const quiet = (t) => { try { return !!asleep() || isNight(night(), new Date(t)); } catch { return false; } };
  const repeatWords = (x) => { const r = ruleOf(x); return r && !r.error ? ruleWords(r, x.start) : ''; };
  const describe = (x, t = now()) => `${x.id}: ${x.kind === 'say' ? `say "${x.what}"` : `do: ${x.what}`}, ${x.rule ? `${repeatWords(x)} (next: ${whenText(x.at, t)})` : whenText(x.at, t)}`;

  function add(a) {
    const t = now(), kind = a.kind === 'do' ? 'do' : a.kind === 'say' ? 'say' : null, what = plain(a.what).slice(0, 400);
    if (!kind) return { error: 'kind: say or do.' };
    if (!what) return { error: 'Say what, in what.' };
    let at = parseWhen(a.when, a.in_minutes, t);
    if (at == null) return { error: 'when: a local time like "16:00" or "2026-11-24T07:30", or in_minutes.' };
    if (at < t - MIN) return { error: `That's already past (${whenText(at, t)}).` };
    if (at > t + 366 * DAY) return { error: 'At most a year ahead.' };
    const item = { id: `l-${t.toString(36)}${Math.random().toString(36).slice(2, 4)}`, kind, what, at, made: t };
    if (String(a.repeat || '').trim()) {
      const r = parseRule(a.repeat);
      if (r.error) return { error: `repeat: ${r.error}` };
      const first = nextAfter(r, at, at - 1); // its first time, or the first after it the rule allows ("weekdays at 7:30", asked on a Saturday)
      if (first == null) return { error: 'That repeat never comes (check UNTIL, COUNT and the days).' };
      Object.assign(item, { rule: r.text, start: at, fired: 0, at: first });
    }
    if (st.items.length >= MAX) return { error: `That's ${MAX} set already: cancel some first (later_list).` };
    const before = structuredClone(st);
    st.items.push(item); st.items.sort((p, q) => p.at - q.at);
    try { save(before); } catch (e) { return { error: unsaved(e).error, unsaved: true }; }
    const hush = kind === 'say' && quiet(item.at) ? ' That falls in the night hours, so it will only be on Home, not said aloud.' : '';
    return { item, text: `Set (${describe(item, t)}).${hush}` };
  }
  function cancel(id) {
    const s = String(id || '').trim(), x = st.items.find((y) => y.id === s);
    if (!x) return null;
    const before = structuredClone(st);
    st.items = st.items.filter((y) => y !== x); save(before); // (throws when it isn't saved: still set, then)
    try { things?.take(things.items().find((y) => y.key === `later:${x.id}`)?.id); } catch {}
    return x;
  }

  /** Its time came: said (unless it's quiet) and a line on Home; or done by the text model, then the same with its answer. */
  async function fire(x, t) {
    let words = x.what;
    if (x.kind === 'do') words = await doIt(x, t);
    words = plain(words);
    if (!words) return;
    try { things?.put({ text: words, until: t + 2 * HOUR, key: `later:${x.id}`, kind: 'reminder', by: 'later' }); } catch (e) { console.error('[later] Today', e.message); }
    const hushed = quiet(t);
    if (!hushed) { try { say(words); } catch (e) { console.error('[later] say', e.message); } }
    try { talk?.add('assistant', words); } catch {} // (so "yes, it's off" after it has something to answer)
    console.log(`[later] ${x.id} ${x.kind}${hushed ? ' (quiet: on Home only)' : ''}: ${words.slice(0, 120)}`);
  }
  async function doIt(x, t) {
    const sorry = `I couldn't do what you asked for ${hm(t)}: ${x.what}`;
    if (!ai || !live) return sorry;
    const skip = new Set([LATER_TOOL.name, LIST_TOOL.name, 'go_away']);
    let tools = [], rules = '', today = '';
    try { tools = live.tools().filter((tl) => !skip.has(tl.name)); } catch {}
    try { rules = live.instructions(); } catch {}
    try { today = picture() || ''; } catch {}
    const input = `It is ${new Date(t).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. ` +
      `Earlier (${new Date(x.made).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}) you were asked to do this now${x.rule ? ` (it repeats: ${repeatWords(x)})` : ''}: ${x.what}\n\n---\n\n${today}`;
    const callTool = (name, args) => (skip.has(name) ? { text: 'Not now.', isError: true } : live.callTool(name, args));
    try {
      const r = await runReview({ ai, instructions: DO_RULES + (rules ? `\n\n---\n\n${rules}` : ''), input, tools, callTool, tier: 'standard' });
      console.log(`[later] ${x.id} ran: ${r.ok ? 'ok' : r.error}; $${(r.cost || 0).toFixed(5)}`);
      return r.ok && r.said && !/^NOTHING\b/i.test(r.said) ? r.said : sorry;
    } catch (e) { console.error('[later] do', e.message); return sorry; }
  }

  let ticking = false;
  /** Whatever is due: fired (or dropped when it's over an hour late), and a repeating one moved on to its next time. */
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const t = now(), due = st.items.filter((x) => x.at <= t).map((x) => ({ x, was: x.at }));
      if (!due.length) return;
      for (const { x } of due) {
        const r = ruleOf(x), next = r && !r.error ? nextAfter(r, x.start, t, (x.fired = (x.fired || 0) + 1)) : null;
        if (next != null) x.at = next; else st.items = st.items.filter((y) => y !== x); // (once, or a repeat that's over)
      }
      st.items.sort((p, q) => p.at - q.at); // (moved on before running: a crash mid-way never says it twice)
      try { save(); } catch {} // (not saved: kept moved on in memory all the same, so it isn't said every 20 s)
      for (const { x, was } of due) {
        if (t - was > LATE) { console.log(`[later] ${x.id} dropped: due ${hm(was)}, over an hour ago`); continue; }
        await fire(x, t).catch((e) => console.error('[later] fire', e));
      }
    } finally { ticking = false; }
  }
  if (every) {
    setTimeout(() => { tick().catch((e) => console.error('[later]', e)); }, 5e3).unref?.(); // (soon after a start: one the tablet missed while it was off)
    setInterval(() => { tick().catch((e) => console.error('[later]', e)); }, every).unref?.();
  }

  const tools = [LATER_TOOL, LIST_TOOL];
  async function call(name, a = {}) {
    const ok = (t) => ({ content: [{ type: 'text', text: t }] }), err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
    if (name === LATER_TOOL.name) { const r = add(a || {}); return r.error ? err(r.error) : ok(r.text); }
    if (name === LIST_TOOL.name) {
      if (a?.cancel) { let x; try { x = cancel(a.cancel); } catch (e) { return err(unsaved(e).error); } return x ? ok(`Cancelled: ${x.kind === 'say' ? `"${x.what}"` : x.what}${x.rule ? ` (${repeatWords(x)})` : ''}.`) : err(`No ${a.cancel}. ${list()}`); }
      return ok(list());
    }
    return err(`unknown tool ${name}`);
  }
  const list = () => (st.items.length ? `Set for later:\n${st.items.map((x) => '- ' + describe(x)).join('\n')}` : 'Nothing is set for later.');
  return { tools, call, tick, add, cancel, list, items: () => st.items.slice() };
}
