// The heartbeat (docs/heartbeat.md): the tablet checks in on things and quietly takes care of them.
//
// Every 5 minutes, plain checks with no AI (an app that crashed, a calendar that stopped
// syncing, nothing planned for dinner, storage, and the checks apps declare: heartbeat-checks.js) write down what's
// worth a look. A note whose finding went away comes down (code, no AI). Then, when there's something new:
//  - with a judge (our cloud's Decisions and text model, or later the household's own key): the decision model says
//    whether it's worth a note, which of notice, tidy or fix, and who it's for, as soon as a check fires (rate-limited);
//    a cheap text model writes the note with the household's tools; a broken app waits for whoever builds
//    (heartbeat-fixes.js). No agent turn (heartbeat-judge.js).
//  - and once an hour in waking hours, the hourly review (heartbeat-review.js): the text model on OpenAI's Flex tier
//    looks at today and tomorrow and does at most one small thing, usually nothing.
//  - with no judge (the tablet isn't linked, or OpenAI isn't chosen): the checks and the tidying only.
//
// GET  /heartbeat               { level, path, findings, log, today, asleep, last, fixes, checkProblems }
// POST /heartbeat/level {level} off | notice | tidy | fix
// POST /heartbeat/settings {every?, prompt?}   how often the review runs (minutes: 30, 60, 120, 240) and its prompt
//                               ("" or null: ours, REVIEW_RULES). The same as the heartbeat_settings tool (Opie), and
//                               the tablet's Advanced, Check-ins.
// POST /heartbeat/run           the checks and a check-in now
// POST /heartbeat/sleep {until?} Sleep now: no check-in until morning (or until someone talks to the assistant)
//
// file: heartbeat.json next to the chats.
import fs from 'node:fs';
import { readJson, writeJson, unsaved } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';
import { questions, judgeInput, verdicts, writeNote, decideCost, WORTH } from './heartbeat-judge.js';
import { REVIEW_RULES, snapshot, runReview } from './heartbeat-review.js';
import { forModel, fromModel } from './tool-args.js';
import { dayKey } from './dates.js';

export const LEVELS = ['off', 'notice', 'tidy', 'fix'];
export const DEFAULT_LEVEL = 'tidy';
export const EVERY = [30, 60, 120, 240]; // minutes between reviews, as the household may choose
const SETTINGS_TOOL = { name: 'heartbeat_settings', description: 'The device\'s check-ins in the background (the heartbeat): how often it looks at the day (every: 30, 60, 120 or 240 minutes), what it looks for (prompt: its instructions in full; reset_prompt: back to ours), and whether it may act (level: off, notice, tidy, fix). With nothing passed it just says how they are now. Change one only when they ask.',
  inputSchema: { type: 'object', properties: { every: { type: 'number', enum: EVERY }, prompt: { type: 'string' }, reset_prompt: { type: 'boolean' }, level: { type: 'string', enum: ['off', 'notice', 'tidy', 'fix'] } } } };
// A day, the judge's path: the same notes; text-model runs; judgments (and an hour's); US$ (gpt-6-luna: a judgment is
// about $0.0002 and a note about $0.002, so a day at every cap is about $0.03).
export const JUDGE_CAPS = { notes: 3, runs: 12, judgments: 48, perHour: 6, cost: 0.05 };
export const CAPS = JUDGE_CAPS;
// The hourly review (heartbeat-review.js): at most one an hour in waking hours, 16 a day, and a few cents a day at most.
export const REVIEW_CAPS = { perDay: 16, cost: 0.05 };
const MAX_JUDGED = 8; // findings in one judgment
const RANK = { off: 0, notice: 1, tidy: 2, fix: 3 };
const HOUR = 3600e3, DAY = 24 * HOUR;
// What a background turn may call, by level (home-screen.js refuses the rest; box.js refuses the device and home tools).
// It writes the things on Home (things.js), not notes: a line with its own end, gone once it no longer matters.
export const TOOLS = {
  notice: ['show_thing', 'family_things', 'about_household'],
  tidy: ['take_down_thing'],
  fix: ['start_editing', 'check_build', 'list_changes'],
};
// The judge's path never edits: its text model gets the things tools and the household's read tools only (a fix waits for whoever builds).
const NOTE_TOOLS = new Set([...TOOLS.notice, ...TOOLS.tidy]);
const THING_TOOLS = new Set(['show_thing', 'take_down_thing']);
export const toolsFor = (level) => new Set(LEVELS.slice(1, RANK[level] + 1).flatMap((l) => TOOLS[l]));

const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const wday = (d) => d.toLocaleDateString('en-US', { weekday: 'short' });

/** Is it night (the household's hours, which may run past midnight)? */
export function isNight(night, d) {
  if (!night?.from || !night?.to) return false;
  const m = d.getHours() * 60 + d.getMinutes(), f = mins(night.from), t = mins(night.to);
  return f <= t ? m >= f && m < t : m >= f || m < t;
}

// ---- the plain checks: each takes what the bridge already knows and returns findings ----
// A finding: { key, kind, text, level } — level is the least the switch must be at for the check-in to act on it.


/** Apps whose page reported errors in the last hour. errors: [{ app, at, text }]. */
export function crashes(errors, now, names = {}) {
  const by = new Map();
  for (const e of errors || []) if (e.at > now - HOUR) by.set(e.app, [...(by.get(e.app) || []), e.text]);
  return [...by].map(([app, texts]) => ({ key: `crash:${app}`, kind: 'crash', level: 'notice', app,
    text: `The ${names[app] || app} app (apps/${app}) threw errors: ${[...new Set(texts)].slice(-3).join(' | ').slice(0, 500)}` }));
}

/** Calendars that couldn't be read, or none read for two hours. cal: { at, errors }, labels: how many calendars. */
export function syncTrouble(cal, calendars, now) {
  if (!calendars) return [];
  const out = Object.entries(cal?.errors || {}).map(([label, err]) => ({ key: `sync:${label}`, kind: 'sync', level: 'notice', text: `${label} couldn't be read: ${err}` }));
  if (!out.length && cal?.at && now - cal.at > 2 * HOUR) out.push({ key: 'sync:stale', kind: 'sync', level: 'notice', text: `No calendar has synced since ${clock(new Date(cal.at))}` });
  return out;
}

/** Dinner isn't nudged about any more: Today's Dinner card shows it's not planned, with picks (the user: the calendar should
 *  be "helpful, not pushy"; "why does it say nothing planned for dinner"). Kept as a no-op so callers stay the same. */
export function dinner() {
  return [];
}

/** The morning (night's end until 10): what's on today, for a short prep note, if anything is. */
export function morning(events, night, d) {
  const end = night?.to ? mins(night.to) : 390, m = d.getHours() * 60 + d.getMinutes();
  if (m < end || m >= 600) return [];
  const today = dayKey(d), on = (events || []).filter((e) => dayKey(new Date(e.start)) === today && !e.allDay);
  if (!on.length) return [];
  return [{ key: `morning:${today}`, kind: 'morning', level: 'tidy', text: `Morning: today has ${on.map((e) => `${e.who ? e.who + ' ' : ''}${e.title} at ${clock(new Date(e.start))}`).join('; ')}` }];
}

export function storage(free) {
  return free != null && free < 1e9 ? [{ key: 'storage', kind: 'storage', level: 'notice', text: `Only ${(free / 1e9).toFixed(1)} GB of storage is left on the device` }] : [];
}

// ---- the heartbeat itself ----

/**
 * deps: DIR (the chats folder), HERE (the bridge), homeScreen (home-screen.js), house (house.js),
 * board (board.js), appErrors() -> [{app, at, text}], edits (the edit lock: begin, end,
 * holder), busy() (a conversation is going), now(), freeBytes(), log(chats.jsonl line), every (ms; 0: no timer),
 * judge ({ ready(), name, decide, ai }: the decision and text models, or null), fixes (heartbeat-fixes.js),
 * extraChecks (heartbeat-checks.js's run(d)), changesOf(app) (recent changes, for a fix's log), review (the hourly
 * review, heartbeat-review.js: judge.ai with tier "flex").
 */
export function heartbeat({ DIR, HERE, homeScreen, house, board, appErrors = () => [], edits = null, busy = () => false,
  now = () => Date.now(), freeBytes = null, logTurn = null, every = 5 * 60e3, json = null, body = null, onChange = () => {},
  judge = null, fixes = null, things = null, extraChecks = null, checkProblems = () => ({}), changesOf = () => [], review = true, approvePrompt = null }) {
  const FILE = registered('heartbeat', path.join(DIR, '../heartbeat.json'));
  const read = () => readJson(FILE, {});
  const st = { level: DEFAULT_LEVEL, handled: {}, log: [], day: null, sleepUntil: 0, lastCheckIn: 0, lastReview: 0, last: null, findings: [], notesFor: {}, judgedAt: [], ...read() };
  st.notesFor ||= {}; st.judgedAt ||= [];
  // Its own log of what it did (which findings it handled, its notes): kept in memory when a save is refused or fails,
  // since what it did happened (dropping it would do it again); a run someone asked for is told it wasn't saved.
  let saveFailed = null; // store.js unsaved's { status, error }, until a save goes through
  const save = () => {
    try { writeJson(FILE, st); saveFailed = null; } catch (e) { console.error('[heartbeat]', e.message); saveFailed = unsaved(e); }
    onChange();
  };
  const CHATS = path.join(HERE, 'chats.jsonl');
  const free = freeBytes || (() => { try { const s = fs.statfsSync(DIR); return s.bavail * s.bsize; } catch { return null; } });
  logTurn ||= (line) => { try { fs.appendFileSync(CHATS, JSON.stringify(line) + '\n'); } catch {} };

  /** Today's notes, check-ins and spending, from the log and chats.jsonl (so a restart doesn't reset the caps). */
  function today() {
    const d = dayKey(new Date(now()));
    if (st.day?.date !== d) st.day = { date: d, notes: 0, runs: 0, judgments: 0, reviews: 0, reviewCost: 0 };
    st.day.judgments ||= 0; st.day.reviews ||= 0; st.day.reviewCost ||= 0;
    let cost = 0;
    try {
      for (const l of fs.readFileSync(CHATS, 'utf8').split('\n')) {
        if (!l.includes('"heartbeat"')) continue;
        try { const x = JSON.parse(l); if (x.background === 'heartbeat' && dayKey(new Date(x.at)) === d) cost += x.usage?.cost || 0; } catch {}
      }
    } catch {}
    return { ...st.day, cost: Math.round(cost * 1e4) / 1e4 };
  }

  function nightHours() { try { return house.view().night; } catch { return null; } }
  function asleep() {
    const d = new Date(now());
    if (st.sleepUntil > now()) return 'sleep';
    return isNight(nightHours(), d) ? 'night' : null;
  }

  /** The plain checks: what's worth a look now. A finding that went away is forgotten, so if it comes back it's new. */
  function check() {
    const t = now(), d = new Date(t);
    let hv = {}; try { hv = house.view(); } catch {}
    const events = hv.events || [];
    let names = {};
    let hh = {}; try { hh = board.householdView(); } catch {}
    try { const appsDir = path.join(process.env.OPENHOUSE_APP_DIR || '', 'apps'); for (const a of fs.readdirSync(appsDir)) { try { names[a] = JSON.parse(fs.readFileSync(path.join(appsDir, a, 'app.json'), 'utf8')).name || a; } catch {} } } catch {}
    const all = [
      ...crashes(appErrors(), t, names),
      ...syncTrouble(hh.calendar, (hh.calendars || []).length, t),
      ...dinner(hv, d),
      ...morning(events, hv.night, d),
      ...storage(free()),
      ...(() => { try { return extraChecks ? extraChecks(d) : []; } catch (e) { console.error('[heartbeat] app checks', e); return []; } })(),
    ];
    const keys = new Set(all.map((f) => f.key));
    for (const k of Object.keys(st.handled)) if (!keys.has(k)) delete st.handled[k];
    st.findings = all;
    st.lastCheck = t;
    return all;
  }

  /** Which way it judges now: the decision model, or nothing (checks and tidying only). */
  function pathNow() {
    try { if (judge?.ready?.()) return 'judge'; } catch {}
    return null;
  }

  /** The notes and the things on Home, for a model. */
  const onToday = (hv) => [homeScreen.describe(), things ? things.describe(hv) : ''].filter(Boolean).join('\n\n');
  /** A background run's tools: the household's read tools (the home screen's) and the things on Home, by level. */
  const bgTools = (allow) => [...homeScreen.tools().filter((t) => allow.has(t.name) && !THING_TOOLS.has(t.name)), ...(things ? things.tools.filter((t) => allow.has(t.name)) : [])]
    .map((t) => ({ type: 'function', name: t.name, description: String(t.description || ''), parameters: forModel(t.inputSchema || { type: 'object', properties: {} }) }));
  /** A model's arguments with what a strict call filled in taken out (tool-args.js). */
  const argsOf = (name, args) => fromModel([...homeScreen.tools(), ...(things?.tools || [])].find((t) => t.name === name)?.inputSchema, args || {});
  /** show_thing / take_down_thing for a background run: the day's cap, tied to the finding (it comes down once that's sorted). */
  function thingCall(name, args, ctx, key, put) {
    if (!things) return { text: 'Not here.', isError: true };
    if (!ctx.allow.has(name)) return { text: `Not at this level: ${name}.`, isError: true };
    if (name === 'show_thing' && ctx.notesLeft <= 0) return { text: 'No more things on Home today: that\'s enough for one day.', isError: true };
    let hv = {}; try { hv = house.view(); } catch {}
    const r = things.call(name, args, { by: 'heartbeat', key, house: hv });
    const text = (r?.content || []).map((c) => c.text || '').join('\n');
    const m = !r.isError && name === 'show_thing' && text.match(/^(Put up|Changed) (\S+): (.*) \(until/);
    if (m) { if (m[1] === 'Put up') ctx.notesLeft--; put.push({ id: m[2], title: m[3] }); }
    return { text, isError: !!r.isError };
  }

  /**
   * Tidying with no AI: a note it put up about a finding that went away (the clash was sorted, the app works again)
   * comes down. Only at Tidy up or more, and only its own notes (the home screen refuses the rest in the background).
   */
  async function tidyUp() {
    if (RANK[st.level] < RANK.tidy) return [];
    const keys = new Set(st.findings.map((f) => f.key)), down = [];
    for (const [key, id] of Object.entries(st.notesFor)) {
      if (keys.has(key)) continue;
      delete st.notesFor[key];
      if (asleep() === 'sleep') continue;
      const r = await homeScreen.call('take_down_note', { id }, { by: 'assistant', who: null, quiet: true, allow: new Set(['take_down_note']) }).catch(() => null); // (notes from before the things)
      if (r && !r.isError) down.push({ id, key });
    }
    let settled = 0; try { settled = asleep() === 'sleep' || !things ? 0 : things.settle(keys); } catch (e) { console.error('[heartbeat] settle', e.message); }
    for (let i = 0; i < settled; i++) down.push({ thing: true });
    if (down.length) {
      st.log = [{ at: now(), level: st.level, path: 'code', saw: down.map((x) => x.key || 'thing'), did: `Took down ${down.length === 1 ? (down[0].thing ? 'a thing on Home' : 'a note') : `${down.length} ${down.every((x) => x.thing) ? 'things on Home' : 'notes'}`} about something that's sorted`, notes: [], ok: true, cost: 0 }, ...st.log].slice(0, 50);
      save();
    }
    return down;
  }

  /** Findings the check-in hasn't been shown, that the level lets it act on. */
  const fresh = () => st.findings.filter((f) => !st.handled[f.key] && RANK[f.level] <= RANK[st.level]);

  /** Why the check-in wouldn't run now (null: it would). */
  function hold({ force = false, via = pathNow() } = {}) {
    if (st.level === 'off') return 'off';
    const a = asleep(); if (a) return a;
    if (busy() || edits?.holder?.()) return 'in use';
    if (!via) return fresh().length ? 'no judge' : 'quiet';
    const t = today();
    if (t.judgments >= JUDGE_CAPS.judgments || t.cost >= JUDGE_CAPS.cost) return 'cap';
    st.judgedAt = st.judgedAt.filter((x) => x > now() - HOUR);
    if (!force && st.judgedAt.length >= JUDGE_CAPS.perHour) return 'rate';
    if (!fresh().length) return 'quiet';
    return null;
  }

  /**
   * The judge's path: one judgment of what's new (the decision model), then for each finding worth it, one note by the
   * text model with the household's tools, or a fix waiting for whoever builds. {fallback: why} when the judge
   * couldn't answer.
   */
  async function judgeNow({ force = false } = {}) {
    const why = hold({ force, via: 'judge' });
    if (why) { st.last = { at: now(), skipped: why }; save(); return { skipped: why }; }
    const list = fresh().slice(0, MAX_JUDGED), lv = st.level, t0 = now(), d = new Date(t0);
    const when = d.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
    let household = '', people = [];
    try { household = board.household(); } catch {}
    try { people = (board.householdView?.().family || house.view().family || []).map((p) => p.name || p).filter((p) => typeof p === 'string' && p).slice(0, 12); } catch {}
    let hv0 = {}; try { hv0 = house.view(); } catch {}
    const input = judgeInput({ findings: list, when, household, notes: onToday(hv0) }), qs = questions(list, people);
    st.judgedAt.push(t0); st.day.judgments++;
    let answers, cost = decideCost(input, qs);
    try { ({ answers } = await judge.decide(input, qs)); }
    catch (e) {
      const code = e?.code || e?.message || 'failed';
      st.last = { at: t0, skipped: 'judge', why: code }; save();
      console.log(`[heartbeat] the judge couldn't answer (${code})`);
      return { fallback: code };
    }
    const vs = verdicts(list, answers), done = [], notes = [];
    let fixed = null, runs = 0;
    const allow = new Set([...toolsFor(lv)].filter((t) => NOTE_TOOLS.has(t)));
    const ctx = { by: 'assistant', who: null, quiet: true, allow, notesLeft: Math.max(0, JUDGE_CAPS.notes - st.day.notes) };
    const tools = bgTools(allow);
    let rules = ''; try { rules = fs.readFileSync(path.join(HERE, 'NOTES.md'), 'utf8') + (board.prefs?.() || ''); } catch {}
    for (const [i, f] of list.entries()) {
      const v = vs[i];
      if (v.worth < WORTH) { done.push({ key: f.key, did: 'not worth it', v }); continue; }
      let queued = false;
      if (v.act === 'fix' && f.kind === 'crash' && lv === 'fix' && fixes) {
        const errs = appErrors().filter((e) => e.app === f.app);
        // (a fix that couldn't be saved isn't waiting: the app is shown as broken on Home instead, below)
        let r = null;
        try { r = fixes.add({ app: f.app, name: f.text.match(/^The (.*?) app/)?.[1] || f.app, errors: [...new Set(errs.map((e) => e.text))].slice(-5), log: errs.slice(-20).map((e) => ({ at: e.at, text: String(e.text).slice(0, 300) })), changes: (() => { try { return changesOf(f.app); } catch { return []; } })() }); }
        catch (e) { if (!e?.unsaved) throw e; }
        if (r) {
          fixed = r.fix; queued = true;
          if (!r.fresh) { done.push({ key: f.key, did: `already waiting (${r.fix.id})`, v }); continue; }
        }
      }
      // A broken app: one line on Home, in code, no text model ("Drawing has a problem: ask Opie to fix
      // it"), while its fix waits (things.js shows the fix) or, with none queued, while it's failing.
      if (f.kind === 'crash' && things) {
        const name = f.text.match(/^The (.*?) app/)?.[1] || f.app;
        if (!queued) { try { things.put({ kind: 'broken', text: name, app: f.app, key: f.key }); } catch (e) { console.error('[heartbeat] Home', e.message); } }
        done.push({ key: f.key, did: queued ? `queued ${fixed.id}` : `${name} has a problem, on Home`, v });
        continue;
      }
      if (ctx.notesLeft <= 0 && v.act !== 'tidy') { done.push({ key: f.key, did: queued ? `queued ${fixed.id}` : 'no notes left today', v }); continue; }
      if (st.day.runs + runs >= JUDGE_CAPS.runs) { done.push({ key: f.key, did: queued ? `queued ${fixed.id}` : 'no runs left today', v }); continue; }
      runs++;
      const put = [];
      const callTool = async (name, args) => {
        args = argsOf(name, args);
        if (THING_TOOLS.has(name)) return thingCall(name, args, ctx, f.key, put);
        const r = await homeScreen.call(name, args, ctx);
        const text = (r?.content || []).map((c) => c.text || '').join('\n').slice(0, 8000);
        const m = !r?.isError && name === 'put_note' && text.match(/Put up (\S+) "(.*)"/);
        if (m) put.push({ id: m[1], title: m[2] });
        return { text, isError: !!r?.isError };
      };
      const w = await writeNote({ ai: judge.ai, finding: f, verdict: v, level: lv === 'fix' ? 'tidy' : lv, fixQueued: queued, rules, tools, callTool, when });
      cost += w.cost;
      if (put.length && put[put.length - 1].note) st.notesFor[f.key] = put[put.length - 1].id;
      notes.push(...put);
      const said = String(w.said || '').replace(/^DID:\s*/i, '');
      done.push({ key: f.key, did: !w.ok ? `couldn't write (${w.error})` : put.length ? said || 'put a thing on Home' : /^NOTHING\b/i.test(said) || !said ? (queued ? `queued ${fixed.id}` : 'nothing') : said, v });
    }
    st.day.runs += runs;
    st.day.notes = Math.max(st.day.notes, JUDGE_CAPS.notes - ctx.notesLeft);
    for (const f of list) st.handled[f.key] = t0;
    const acted = done.filter((x) => !['not worth it', 'nothing'].includes(x.did));
    const did = fixed ? `A fix for ${fixed.name} is waiting for whoever builds${notes.length ? ', and a note says so' : ''}` : acted.length ? acted.map((x) => x.did).join('; ').slice(0, 200) : null;
    const entry = { at: t0, level: lv, path: 'judge', via: judge.name || 'cloud', saw: list.map((f) => f.text.slice(0, 200)),
      judged: done.map((x) => ({ key: x.key, worth: Math.round(x.v.worth * 100) / 100, act: x.v.act, for: x.v.for, did: x.did })),
      did, notes, ...(fixed ? { fix: fixed.id } : {}), ok: true, cost: Math.round(cost * 1e6) / 1e6 };
    st.log = [entry, ...st.log].slice(0, 50);
    st.last = { at: t0, ran: true };
    save();
    logTurn({ at: new Date(t0).toISOString(), id: 'heartbeat', background: 'heartbeat', path: 'judge', ok: true, ms: now() - t0, agent: judge.name || 'cloud', model: 'gpt-6-luna', usage: { cost: entry.cost }, text: list.map((f) => f.kind).join(', '), runs });
    console.log(`[heartbeat] ${lv} (judge): saw ${list.map((f) => f.kind).join(', ')}; ${did || 'did nothing'}`);
    return entry;
  }

  /**
   * The hourly review: once an hour in waking hours, when nobody's using the tablet, the text model on the Flex tier looks
   * at today and tomorrow and the findings nobody has looked at, and does at most one small thing. A failed call (Flex
   * busy: 429; the service down) skips that hour; nothing is retried on the standard tier.
   */
  async function reviewNow({ force = false } = {}) {
    if (!review || !judge?.ai) return { skipped: 'no review' };
    try { if (!judge.ready?.()) return { skipped: 'no judge' }; } catch { return { skipped: 'no judge' }; }
    if (st.level === 'off') return { skipped: 'off' };
    const a = asleep(); if (a) return { skipped: a };
    if (busy() || edits?.holder?.()) return { skipped: 'in use' };
    const t = today();
    if (!force && now() - st.lastReview < (st.every || 60) * 60e3 - 60e3) return { skipped: 'hour' };
    if (t.reviews >= REVIEW_CAPS.perDay || t.reviewCost >= REVIEW_CAPS.cost) return { skipped: 'cap' };
    const lv = st.level, t0 = now(), list = fresh();
    st.lastReview = t0; st.day.reviews++;
    let hv = {}, household = '';
    try { hv = house.view(); } catch {}
    try { household = board.household(); } catch {}
    const input = snapshot({ hv: { ...hv, things: things ? things.all(hv) : undefined }, notes: homeScreen.describe(), findings: list, household, now: new Date(t0) });
    const allow = new Set([...toolsFor(lv)].filter((x) => NOTE_TOOLS.has(x)));
    const ctx = { by: 'assistant', who: null, quiet: true, allow, notesLeft: Math.max(0, JUDGE_CAPS.notes - st.day.notes) };
    const crashed = list.filter((f) => f.kind === 'crash' && f.app);
    const tools = [...bgTools(allow),
      ...(lv === 'fix' && fixes && crashed.length ? [{ type: 'function', name: 'queue_fix', description: `Queue a fix for one of the household's apps the checks found broken (${crashed.map((f) => f.app).join(', ')}): whoever builds the household's apps fixes it, and someone says yes on the device.`, parameters: { type: 'object', required: ['app'], properties: { app: { type: 'string', enum: crashed.map((f) => f.app) } } } }] : [])];
    const put = []; let fixed = null;
    const callTool = async (name, args) => {
      args = argsOf(name, args);
      if (name === 'queue_fix') {
        const f = crashed.find((x) => x.app === args.app); if (!f) return { text: 'No broken app by that name.', isError: true };
        const errs = appErrors().filter((e) => e.app === f.app);
        let r;
        try { r = fixes.add({ app: f.app, name: f.text.match(/^The (.*?) app/)?.[1] || f.app, errors: [...new Set(errs.map((e) => e.text))].slice(-5), log: errs.slice(-20).map((e) => ({ at: e.at, text: String(e.text).slice(0, 300) })), changes: (() => { try { return changesOf(f.app); } catch { return []; } })() }); }
        catch (e) { if (!e?.unsaved) throw e; return { text: unsaved(e).error, isError: true }; }
        fixed = r.fix; return { text: r.fresh ? `Queued ${r.fix.id}: it waits for whoever builds.` : `Already waiting (${r.fix.id}).`, isError: false };
      }
      if (THING_TOOLS.has(name)) return thingCall(name, args, ctx, list.length === 1 ? list[0].key : null, put);
      const r = await homeScreen.call(name, args, ctx);
      const text = (r?.content || []).map((c) => c.text || '').join('\n').slice(0, 8000);
      return { text, isError: !!r?.isError };
    };
    let rules = ''; try { rules = fs.readFileSync(path.join(HERE, 'NOTES.md'), 'utf8') + (board.prefs?.() || ''); } catch {}
    const r = await runReview({ ai: judge.ai, instructions: (st.prompt || REVIEW_RULES) + (rules ? `\n\n---\n\n${rules}` : ''), input, tools, callTool, tier: 'flex' });
    st.day.reviewCost += r.cost;
    st.day.notes = Math.max(st.day.notes, JUDGE_CAPS.notes - ctx.notesLeft);
    if (r.ok) for (const f of list) st.handled[f.key] ??= t0;
    const said = String(r.said || '').replace(/^DID:\s*/i, '');
    const did = !r.ok ? null : fixed ? `A fix for ${fixed.name} is waiting for whoever builds` : r.wrote ? said || 'put a thing on Home' : null;
    const entry = { at: t0, level: lv, path: 'review', saw: list.map((f) => f.text.slice(0, 200)), did, notes: put, ...(fixed ? { fix: fixed.id } : {}),
      ok: r.ok, ...(r.ok ? {} : { skipped: r.error === 'flex_unavailable' || /429/.test(String(r.error)) ? 'flex busy' : String(r.error).slice(0, 60) }),
      tier: r.tier, tokens: r.tokens, cost: Math.round(r.cost * 1e6) / 1e6 };
    st.log = [entry, ...st.log].slice(0, 50);
    save();
    logTurn({ at: new Date(t0).toISOString(), id: 'heartbeat', background: 'heartbeat', path: 'review', ok: r.ok, ms: now() - t0, agent: judge.name || 'cloud', model: 'gpt-6-luna', tier: r.tier,
      usage: { cost: entry.cost, input_tokens: r.tokens.input, cached_tokens: r.tokens.cached, output_tokens: r.tokens.output }, text: list.map((f) => f.kind).join(', ') || 'review' });
    console.log(`[heartbeat] ${lv} (review, ${r.tier}): ${r.ok ? did || 'nothing' : `skipped (${r.error})`}; $${entry.cost.toFixed(5)}`);
    return entry;
  }

  /** One beat: the checks, the decision model for anything new, then the hourly review if it's due. */
  let beating = null;
  function beat(opts) {
    return (beating ??= (async () => {
      try {
        check();
        await tidyUp();
        const via = pathNow();
        if (via === 'judge') {
          const r = await judgeNow(opts);
          const rv = await reviewNow(opts).catch((e) => { console.error('[heartbeat] review', e); return { skipped: 'error' }; });
          const out = r.fallback ? { skipped: 'no judge', why: r.fallback } : r;
          return rv.path === 'review' ? { ...out, review: rv } : out;
        }
        const why = hold({ ...opts, via: null }) || 'no judge'; st.last = { at: now(), skipped: why }; save(); return { skipped: why };
      } finally { beating = null; }
    })());
  }
  if (every) setInterval(() => { beat().catch((e) => console.error('[heartbeat]', e)); }, every).unref?.();

  const view = () => { const via = pathNow(); return { level: st.level, levels: LEVELS, every: st.every || 60, prompt: st.prompt || REVIEW_RULES, ownPrompt: !!st.prompt, path: via, findings: st.findings.map(({ key, kind, text }) => ({ key, kind, text, seen: !!st.handled[key] })), log: st.log.slice(0, 20), today: today(), caps: { ...JUDGE_CAPS, reviewsPerDay: REVIEW_CAPS.perDay, reviewCost: REVIEW_CAPS.cost }, asleep: asleep(), last: st.last,
    fixes: fixes ? fixes.open().map(({ id, app, name, status, at }) => ({ id, app, name, status, at })) : [], checkProblems: (() => { try { return checkProblems(); } catch { return {}; } })() }; };

  /** How often and what for: {every, prompt} (prompt "" or null: ours), level, sleepUntil. { error, status }, or null. */
  function setSettings(b) {
    const was = { every: st.every, prompt: st.prompt, level: st.level, sleepUntil: st.sleepUntil };
    const back = (error, status = 400) => { Object.assign(st, was); return { error, status }; };
    if (b.every != null) { if (!EVERY.includes(Number(b.every))) return back(`every: ${EVERY.join(', ')} minutes`); st.every = Number(b.every); }
    if (b.prompt !== undefined) { const t = String(b.prompt ?? '').trim().slice(0, 6000); st.prompt = t && t !== REVIEW_RULES.trim() ? t : null; }
    if (b.level != null) { if (!LEVELS.includes(b.level)) return back(`level: ${LEVELS.join(', ')}`); st.level = b.level; }
    if (b.sleepUntil != null) st.sleepUntil = b.sleepUntil;
    // Saved before it counts: a heartbeat.json a newer release saved (store.js never writes over it) keeps what was.
    try { writeJson(FILE, st); } catch (e) { console.error('[heartbeat]', e.message); const u = unsaved(e); return back(u.error, u.status); }
    onChange(); return null;
  }
  const said = () => `Check-ins: ${st.level === 'off' ? 'off' : `every ${st.every || 60} minutes, level ${st.level}`}; prompt: ${st.prompt ? 'their own' : 'ours'}.\n\nThe prompt now:\n${st.prompt || REVIEW_RULES}`;
  homeScreen?.addTools?.([SETTINGS_TOOL], async (name, a) => {
    // A new prompt is the instructions for every run nobody is at: from Opie, a person says yes on the device first
    // (approvePrompt: its card shows the new prompt, a person's tap, the PIN when Change settings asks for it).
    const next = !a?.reset_prompt && a?.prompt != null ? String(a.prompt).trim().slice(0, 6000) : '';
    if (next && next !== (st.prompt || REVIEW_RULES).trim() && approvePrompt && !(await approvePrompt(next).catch(() => false)))
      return { content: [{ type: 'text', text: "Not changed: someone has to say yes on the device to new check-in instructions, and nobody did. They can also change them in Settings, Opie, Check-ins." }], isError: true };
    const e = setSettings({ ...(a?.every != null ? { every: a.every } : {}), ...(a?.reset_prompt ? { prompt: '' } : a?.prompt != null ? { prompt: a.prompt } : {}), ...(a?.level ? { level: a.level } : {}) });
    return { content: [{ type: 'text', text: e ? e.error : said() }], isError: !!e };
  });

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/heartbeat' && !p.startsWith('/heartbeat/')) return false;
    if (req.method === 'GET' && p === '/heartbeat') { json(res, 200, view()); return true; }
    if (req.method !== 'POST') return false;
    const b = await body(req);
    if (p === '/heartbeat/level') {
      if (!LEVELS.includes(b.level)) { json(res, 400, { error: `level: ${LEVELS.join(', ')}` }); return true; }
      const e = setSettings({ level: b.level }); json(res, e ? e.status : 200, e ? { error: e.error } : view()); return true;
    }
    if (p === '/heartbeat/settings') { const e = setSettings({ every: b.every, prompt: b.prompt, level: b.level }); json(res, e ? e.status : 200, e ? { error: e.error } : view()); return true; }
    if (p === '/heartbeat/run') { const r = await beat({ force: true }); json(res, saveFailed ? saveFailed.status : 200, { ...view(), result: r, ...(saveFailed ? { error: saveFailed.error } : {}) }); return true; }
    if (p === '/heartbeat/sleep') {
      const until = Number(b.until) || (() => { const n = nightHours(), d = new Date(now()), m = n?.to ? mins(n.to) : 390; d.setHours(Math.floor(m / 60), m % 60, 0, 0); if (+d <= now()) d.setDate(d.getDate() + 1); return +d; })();
      const e = setSettings({ sleepUntil: until }); json(res, e ? e.status : 200, e ? { error: e.error } : view()); return true;
    }
    return false;
  }
  return Object.assign(handle, { check, judgeNow, reviewNow, tidyUp, pathNow, beat, hold, view, awake: () => { if (st.sleepUntil) { st.sleepUntil = 0; save(); } }, state: st });
}
