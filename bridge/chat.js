// Conversations: the family talks to the assistant (typed here; out loud, OpenAI's live voice in the shell). A turn is
// the cloud's text model with the household's tools (agents/cloud.js, textTools below): lists, calendar, chores, meals,
// notes on Home, the home screen's tabs and look, undo. Making or changing an app is a computer's (workshop.js).
//
// POST /chat {id?, text, who?}   one turn; the response streams NDJSON events:
//   {type:'start', id} {type:'status', text} {type:'delta', text} {type:'message', text} {type:'done', ok, text}
//   Closing the connection stops the turn.
// POST /chat/stop {id}           stop that conversation's running turn
// GET  /chats                    [{id, title, updated}] newest first
// GET  /chats/<id>               the whole conversation
// GET  /chat/...                 the conversation page (public/chat; the start of a phone page)
import * as G from './grid.js';
import fs from 'node:fs';
import { readJson, writeJson, writeFileAtomic } from './store.js';
import { registered } from './stores.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { weatherRoutes } from './weather.js';
import { boardRoutes } from './board.js';
import { voiceRoutes } from './voice.js';
import { homeScreenRoutes, requestApp, showingTab, isTab } from './home-screen.js';
import { houseRoutes } from './house.js';
import { mapRoutes } from './maps.js';
import { liveToolRoutes, LIVE_TOOLS, recentTalk } from './live-tools.js';
import { deviceTools } from './device-tools.js';
import { snapshot } from './heartbeat-review.js';
import { dayMemory } from './days.js';
import { thingStore } from './things.js';
import { dayNotes } from './day-notes.js';
import { forModel, fromModel } from './tool-args.js';

// The first conversation: the display introduces itself and learns about the family by talking.
const ONBOARD = (wakeOn) => `(This tablet was just set up and Opie was just turned on. Nobody has said anything yet: you start. Be clear and brief, not gushing.
Go one step per turn: one or two short sentences, at most one question. Whenever they want to stop or skip ("not now", "skip", "can I just look?"), that's fine: say the home screen is theirs and you're here when they need you, then call end_conversation. Never push.
1. Say who you are in one sentence: Opie, who answers questions and keeps the lists, calendar and chores. Say they talk to you by saying ${wakeOn ? '"Hey Opie"' : '"Hey Opie" once it\'s on in Settings'}, or by just typing.
2. Ask who lives here: just names (and, for children, ages; pets count too). Don't assume there are children. Save with update_household as you learn.
3. Ask their town or zip code, for the weather. Save it.
4. Say they're set: everything else (calendars, photos, connecting Claude or ChatGPT to make new apps) is in Settings whenever they want it. Then call end_conversation.
Don't put notes on the home screen during this, and don't use Suggestions lists.)`;

// Last in a spoken turn's request, so it's the freshest thing the model reads (the rules are long, and answers were
// read-aloud paragraphs).
const SPOKEN = '\n\n(Said aloud to you, and your answer is spoken: reply like a person talking, in one or two short sentences, ' +
  'with no lists, headings or written phrasing. At most one question back. Put anything longer on a note, or offer to.)';

export function chatRoutes({ HERE, APP_DIR, agentName, currentAgent, json, body, building = () => null, edits = null, checkBuild = null, listChanges = () => [], undoChange = null, undoLatest = null }) {
  const DIR = path.resolve(process.env.CHAT_DIR || path.join(HERE, '../chats'));
  const WORK = path.join(DIR, 'work'); // the agent's working folder: empty on purpose
  fs.mkdirSync(WORK, { recursive: true });
  const PUBLIC = path.join(HERE, 'public');
  const running = new Map(); // id -> AbortController
  const hooks = {}; // onTurn (heartbeat.js)
  const homeScreen = homeScreenRoutes({ DIR, json, body, edits, APP_DIR });
  // The agents reach the home screen's MCP server with these (agents/*.js read them when they start).
  process.env.HOME_MCP_URL = `http://127.0.0.1:${process.env.PORT || 8787}${homeScreen.url}`;
  process.env.HOME_MCP_TOKEN = homeScreen.token;
  // The shell's device server (its own token, which stays here): the workshop reaches the device tools through it.
  const deviceServer = () => { try { const d = JSON.parse(fs.readFileSync(process.env.DEVICE_MCP_CONFIG, 'utf8')).mcpServers.device; return { url: d.url, auth: d.headers.Authorization }; } catch { return null; } };
  const board = boardRoutes({ HERE, DIR, WORK, currentAgent, agentName, json, body, homeScreen });
  const weather = weatherRoutes({ json, household: () => board.householdView() });
  // The family's lists, chore checkmarks, meals and own events, for the starting apps and the assistant (house.js).
  // The things on Home (things.js): reminders due, the heartbeat's suggestions, countdowns, a broken app; Opie takes one down.
  let house = null;
  const things = thingStore({ DIR, onChange: () => house?.changed() });
  // What apps put on the calendar's days (day-notes.js): a school lunch, a pickup day.
  const notes = dayNotes({ DIR, onChange: () => house?.changed() });
  const appName = (id) => { try { return JSON.parse(fs.readFileSync(path.join(APP_DIR || WORK, 'apps', id, 'app.json'), 'utf8')).name || id; } catch { return id; } };
  house = houseRoutes({ DIR, json, body, board, homeScreen, currentAgent, agentName, WORK, things, notes, appName });
  things.setPutAway((k) => house.putAway(k));
  homeScreen.addTools([things.tools[1]], (name, a) => things.call(name, a, { by: 'assistant', house: house.view() }));
  board.localEvents = house.localEvents; board.houseContext = house.context;
  homeScreen.addTools(house.tools, house.call);
  // The Map: saved places, today's events with a place, what Opie showed (maps.js, docs/maps.md).
  const map = mapRoutes({ DIR, json, body, board, house, homeScreen, hasApp: () => !!APP_DIR && fs.existsSync(path.join(APP_DIR, 'apps/map/index.html')) });
  homeScreen.addTools(map.tools, map.call);
  const voice = voiceRoutes({ HERE, DIR, json, body });
  globalThis.openhouseSpeechLog = (kind, d) => voice.log?.(kind, d); // the home devices' actions (devices/index.js)
  setTimeout(() => familyNames(), 0);
  /** The family's names to speech recognition, so it hears "Nora", not "Laura" (at start, and after each turn: a turn may have added someone). */
  const familyNames = () => { try { voice.setNames(board.householdView().family.map((f) => f.name)); } catch {} };

  // The household and the assistant's own name, as tools: "call yourself Hazel", "Maya turned 10", and the
  // onboarding chat that sets the family up by talking.
  // This family's own preferences (how they like notes, answers, the home screen), on top of NOTES.md's defaults.
  const PREFS = registered('preferences', path.join(DIR, '../preferences.md'));
  const readPrefs = () => { try { return fs.readFileSync(PREFS, 'utf8').split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean); } catch { return []; } };
  // The household's quick tools for OpenAI's live voice (live-tools.js); typed turns get those and a few more (textTools).
  // What it remembers (docs/assistant.md "Memory"): what they asked it to remember or told it that lasts (preferences.md),
  // each day's few lines for a week (days.js), and the last half hour word for word (recentTalk).
  const days = dayMemory({ DIR });
  const talk = recentTalk({ onAdd: days.log });
  const live = liveToolRoutes({ HERE, homeScreen, weather, talk, prefsBlock: () => prefsBlock(), assistantName: () => 'Opie', json, body,
    household: { save: (b) => board.saveHousehold(b), read: () => board.householdView() },
    now: () => snapshot({ hv: house.view(), notes: homeScreen.describe(), household: board.household(), findings: null }) });
  // Opie using the tablet's other apps for someone (device-tools.js, docs/device-control.md): the voice's and typed turns' tools.
  const device = deviceTools({ server: deviceServer, log: (kind, d) => voice.log?.(kind, d),
    describe: async (jpeg, question) => (await import('./agents/cloud.js')).answer({ prompt: question, images: [{ type: 'image/jpeg', bytes: Buffer.from(jpeg, 'base64') }] }) });
  live.setDevice(device);
  // A typed turn's tools (agents/cloud.js): the voice's, plus the household itself, the home screen's tabs and look,
  // taking back a change, adding a calendar or an album, and ending the conversation. Never an app's files.
  const TYPED = ['update_household', 'set_home', 'today_card', 'move_on_home', 'put_back', 'list_changes', 'undo_change', 'end_conversation', 'add_calendar', 'add_photo_album'];
  const fn = (t) => ({ type: 'function', name: t.name, description: String(t.description || ''), parameters: forModel(t.inputSchema || { type: 'object', properties: {} }) });
  const textTools = () => [...live.tools(), ...homeScreen.tools().filter((t) => TYPED.includes(t.name) && !LIVE_TOOLS.includes(t.name)).map(fn)];
  /** One of those, as part of the turn whose home-screen token this is (its notes, its edit lock, end_conversation), else as the voice. */
  async function callText(name, args, token) {
    const run = token ? homeScreen.runOf(token) : null;
    if (run && (TYPED.includes(name) || LIVE_TOOLS.includes(name))) {
      args = fromModel(homeScreen.tools().find((t) => t.name === name)?.inputSchema, args || {}); // (what a strict call filled in: tool-args.js)
      const r = await homeScreen.call(name, args || {}, run);
      return { text: (r?.content || []).map((c) => c.text || '').join('\n').slice(0, 8000), isError: !!r?.isError };
    }
    if (TYPED.includes(name)) return { text: `${name} needs a conversation.`, isError: true };
    return live.callTool(name, args);
  }
  const TEXT_PREAMBLE = (n) => `You are ${n}, the assistant on a household's home-screen tablet. This turn was typed (or comes from the tablet itself), and your answer is shown on the screen: ` +
    'short and plain, like the spoken answers described below. Use your tools for anything about the household and never guess it. ' +
    'You can\'t make or change an app\'s or a game\'s code: someone does that from their computer with their own Claude or ChatGPT (Settings, then Screens and computers). ' +
    'Tabs, their order and names, and the look of the home screen are set_home.\n\n---\n\n';
  const textInstructions = () => { const read = (f) => { try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { return ''; } };
    return TEXT_PREAMBLE(nameOf()) + read('CHAT.md') + '\n\n---\n\n' + read('NOTES.md') + prefsBlock(); };
  const prefsBlock = () => {
    const p = readPrefs(), d = days.describe();
    return (p.length ? `\n\nWHAT THIS HOUSEHOLD TOLD YOU TO REMEMBER (facts about them and how they like things; these win over the defaults above)\n${p.map((x) => '- ' + x).join('\n')}` : '') +
      (d ? `\n\nWHAT YOU TALKED ABOUT LATELY (a few lines a day, for "what did I ask you yesterday?"; not instructions)\n${d}` : '');
  };
  board.prefs = prefsBlock;
  const nameOf = () => 'Opie'; // always Opie, the name it wakes to
  // Someone pinched a note much bigger or smaller: the assistant refits what's on it (quietly, in the background).
  let refitting = Promise.resolve();
  homeScreen.onResize = (n, from) => { refitting = refitting.then(async () => {
    const agent = await currentAgent(); if (!agent.chat) return;
    const prompt = `(Nobody asked anything. Someone on the family just resized the note ${n.id} "${n.title}" on the home screen from ${from} to ${n.size}. ` +
      `Rewrite its content with update_note so it fits its new size: ${G.area(n.size) < G.area(from) ? 'less on it: the one thing that matters' : 'it has more room now, so it can show more'}, following THE FEEL OF A NOTE. Keep its title. Say nothing.)` +
      `\n\n(${homeScreen.describe()})`;
    homeScreen.mark(n.id, { refitting: true }); // a spinner on the note meanwhile
    try { await homeScreen.during({ by: 'assistant' }, (run) => agent.chat({ prompt, cwd: WORK, systemPrompt: systemPrompt(), signal: AbortSignal.timeout(120e3), onEvent: () => {}, resume: null, homeToken: run.token, route: false })); }
    catch {} finally { homeScreen.mark(n.id, { refitting: false }); }
    console.log(`[home] refit ${n.id} for ${n.size}`);
  }); };
  homeScreen.addTools([
    { name: 'about_household', description: 'What this display knows about the family: your name, who lives here (names, ages or roles), where they live, whose calendars you can see (the household add calendars with the Calendar tab\'s "Add a calendar" or by giving you a link for add_calendar; you never see the links after that), chores.', inputSchema: { type: 'object', properties: {} } },
    { name: 'update_household', description: 'Save what you learned about the family. Each field you pass replaces that whole list, so include everyone/everything that should stay (read about_household first). Only what they told you; never guess.',
      inputSchema: { type: 'object', properties: {
        family: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, note: { type: 'string', description: 'e.g. "age 9", "Mom", "Grandpa, visits Sundays"' }, color: { type: 'string', description: 'Their color everywhere (calendar, chores), as #rrggbb; leave out to keep theirs. Soft, readable on white.' } } } },
        location: { type: 'string', description: 'Zip code or town, for weather and local answers.' },
        chores: { type: 'array', items: { type: 'object', required: ['task'], properties: { who: { type: 'string' }, task: { type: 'string' } } } },
        taking_off: { type: 'array', items: { type: 'string' }, description: 'With family: the names of anyone they asked to take off the list (anyone else left out of family is refused)' },
      } } },
    { name: 'remember_preference', description: 'Remember something lasting about this household, so you know it in every conversation from now on: a fact ("Leo is allergic to peanuts", "Nana and Papa are Grandma and Grandpa", "soccer is at Fuller Park", "dinner is around 6") or how they like things ("no cooking times on notes", "shorter answers", anything to always or never do). Save one when they say "remember...", or when something they said is clearly lasting and will matter later; not today\'s plans (those go on the calendar or a list), and nothing sensitive (health beyond allergies, money, passwords, arguments) unless they ask. It belongs to the household, not to whoever said it. One short sentence in their terms; say in a few words that you\'ll remember it.', inputSchema: { type: 'object', required: ['preference'], properties: { preference: { type: 'string' } } } },
    { name: 'forget_preference', description: 'Forget something you were asked to remember, or a preference they no longer want ("forget that", "you can forget about..."): pass words from it.', inputSchema: { type: 'object', required: ['preference'], properties: { preference: { type: 'string' } } } },
    { name: 'start_editing', description: 'Call this once before you change any file in the app folder (an app, a game, the home screen). If someone else\'s change is being made right now, it waits until that one is done, so the two don\'t get mixed up. When it says to wait, tell them you\'ll do it in a moment instead of editing.', inputSchema: { type: 'object', properties: {} } },
    { name: 'check_build', description: 'After editing an app: errors its page threw since the edit (it reports them while it is open). Fix them and check again.',
      inputSchema: { type: 'object', required: ['app'], properties: { app: { type: 'string', description: 'The app id (apps/<id>)' } } } },
    { name: 'progress', description: 'Say how a longer job is going (making or changing an app, anything over a few seconds): one short sentence, spoken aloud and shown on your note. Say what they can see now and what is next, as each part starts; not for every file.',
      inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    { name: 'put_back', description: 'Put back something the family took away: a note they took down (its id, listed with the notes), or an app they took off the Apps tab ("app:<id>")', inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } },
    { name: 'list_changes', description: 'Recent changes to the apps, games and home screen, newest first (id, when, what was asked). For "undo the X change" or "what did we change?".', inputSchema: { type: 'object', properties: {} } },
    { name: 'undo_change', description: 'Take back a change to the apps, games or the home screen\'s tabs and look when they ask: "latest" for the latest one ("undo that", "put it back how it was"), or one change by its id from list_changes, keeping the ones made after it. Itself a change, so it can be taken back too. (A list item, chore, event or note is put right with its own tool.)', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'end_conversation', description: 'Stop listening after this reply: the conversation is over (they said bye, thanks, that\'s all, never mind, or clearly finished). Say your short goodbye as usual; after it you stop listening until someone wakes you again. Don\'t call it when you just asked them something.', inputSchema: { type: 'object', properties: {} } },
  ], async (name, a, ctx) => {
    const ok = (t) => ({ content: [{ type: 'text', text: t }] });
    if (name === 'start_editing') {
      if (!edits || !ctx?.turn) return ok('Go ahead.');
      if (edits.holder?.() && edits.holder() !== ctx.turn) ctx.send?.({ type: 'status', text: 'Waiting for the change before this one' });
      const r = await edits.startEditing(ctx.turn, { signal: ctx.signal });
      return r.ok ? ok('Go ahead: the apps are yours to change until this reply ends.') : { content: [{ type: 'text', text: r.error }], isError: true };
    }
    if (name === 'check_build') {
      if (String(a.app || '') === 'home') return ok('Nothing to check: the home screen is the display\'s own page.');
      if (!checkBuild || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(String(a.app || ''))) return { content: [{ type: 'text', text: 'Which app (its id)?' }], isError: true };
      const r = await checkBuild(String(a.app));
      return ok(r.ok ? (r.note ? `No errors. ${r.note}` : 'It builds and runs.') : `Errors:\n${r.errors}`);
    }
    if (name === 'progress') { const t = String(a.text || '').trim().slice(0, 160); if (t) ctx?.send?.({ type: 'progress', text: t }); return ok('Said.'); }
    if (name === 'put_back') return homeScreen.putBack(String(a.key || '')) ? ok('Back on the home screen.') : { content: [{ type: 'text', text: 'Nothing by that key was taken off.' }], isError: true };
    if (name === 'list_changes') return ok(JSON.stringify(listChanges(), null, 1));
    if (name === 'undo_change') {
      if (!undoChange) return { content: [{ type: 'text', text: 'Not available.' }], isError: true };
      const id = String(a.id || '').trim();
      if (id === 'latest') {
        if (!undoLatest) return { content: [{ type: 'text', text: 'Not available.' }], isError: true };
        const r = undoLatest(ctx?.turn || null);
        return r.ok ? ok(`Took back: ${r.undid}`) : { content: [{ type: 'text', text: r.nothing ? 'Nothing to take back.' : r.error }], isError: true };
      }
      const r = undoChange(id, ctx?.turn || null);
      return r.ok ? ok(`Took back: ${r.undid}`) : { content: [{ type: 'text', text: r.error }], isError: true };
    }
    if (name === 'end_conversation') { if (ctx) ctx.ended = true; return ok('OK: after your reply you stop listening.'); }
    if (name === 'about_household') return ok(JSON.stringify({ ...board.householdView(), you: nameOf() }, null, 2));
    if (name === 'update_household') {
      // family replaces the whole list: someone left out by mistake (a list made from memory) would be gone, so
      // taking anyone off is said in taking_off (household data safety).
      if (Array.isArray(a.family)) {
        const was = (board.householdView()?.family || []).map((f) => String(f?.name || '')).filter(Boolean), low = (s) => String(s || '').trim().toLowerCase();
        const off = new Set((Array.isArray(a.taking_off) ? a.taking_off : []).map(low)), now = new Set(a.family.map((f) => low(f?.name)));
        const dropped = was.filter((n) => !now.has(low(n)) && !off.has(low(n)));
        if (dropped.length) return { content: [{ type: 'text', text: `Not saved: this would take ${dropped.join(', ')} off the family list. Pass everyone who stays (about_household), and put anyone they asked to take off in taking_off.` }], isError: true };
      }
      const { taking_off, ...rest } = a; a = rest;
      let h; try { h = board.saveHousehold(a); } catch (e) { return { content: [{ type: 'text', text: `Not saved: ${e.message}` }], isError: true }; }
      return ok(`Saved. Family: ${(h.family || []).map((f) => f.name + (f.note ? ` (${f.note})` : '')).join(', ') || 'none'}; location: ${h.location || 'not set'}.`); }
    if (name === 'remember_preference') {
      const p = String(a.preference || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!p) return { content: [{ type: 'text', text: 'Nothing to remember.' }], isError: true };
      const all = readPrefs().filter((x) => x.toLowerCase() !== p.toLowerCase()); all.push(p);
      writeFileAtomic(PREFS, all.map((x) => '- ' + x).join('\n') + '\n', { bak: true });
      return ok(`Remembered: ${p}`);
    }
    if (name === 'forget_preference') {
      const w = String(a.preference || '').toLowerCase().split(/\W+/).filter((x) => x.length > 2);
      const all = readPrefs(), keep = all.filter((x) => !w.length || w.filter((t) => x.toLowerCase().includes(t)).length < Math.ceil(w.length * 0.6));
      writeFileAtomic(PREFS, keep.map((x) => '- ' + x).join('\n') + (keep.length ? '\n' : ''), { bak: true });
      return ok(all.length === keep.length ? 'No preference like that was saved.' : `Forgot: ${all.filter((x) => !keep.includes(x)).join('; ')}`);
    }
  });

  const file = (id) => path.join(DIR, `${id}.json`);
  // (no .bak for each conversation: the chats folder goes into backups whole)
  const load = (id) => readJson(file(id), null, { bak: false });
  const save = (c) => { c.updated = Date.now(); writeJson(file(c.id), c, { bak: false }); };
  const validId = (id) => /^[a-z0-9-]{6,40}$/.test(id || '');

  /** What the app builder is doing, so "are you making it?" gets a real answer. */
  function buildLine() {
    const b = building(); if (!b) return '';
    const mins = (t) => Math.max(1, Math.round((Date.now() - t) / 60000));
    if (b.state === 'working') return `\n\n(Making apps: working right now on "${String(b.request || '').slice(0, 200)}", started ${mins(b.startedAt)} min ago. The family sees your face turn green while it works.)`;
    return `\n\n(Making apps: nothing in progress.${b.lastChange ? ` Last finished: "${String(b.lastChange).slice(0, 200)}".` : ''})`;
  }

  /** The home screen as it is: its tabs (and which one is showing), and the notes on Home. */
  function homeLine() {
    const st = homeScreen.style(), tabs = (st.tabs || ['today', 'calendar', 'weather', 'map', 'chores', 'lists', 'meals', 'recipes', 'photos', 'whiteboard', 'apps'].map((id) => ({ id }))).map((t) => t.id);
    const now = showingTab();
    const here = now === 'today' ? ' They are looking at the Home tab.' : now === 'apps' || now === 'board' ? ' They are looking at the Apps tab.' : '';
    return `\n\n(The home screen right now: tabs ${tabs.join(', ')}${st.tabs ? '' : ' (the usual set)'}; look: ${st.palette}, ${st.type} type, ${st.density}${st.backdrop === 'photos' ? ', photos behind' : ''}${st.cards?.length ? `; app cards on Home: ${st.cards.join(', ')}` : ''}.${here} ` +
      `Tabs (add, remove, reorder, rename) and the look ("make it warmer") are one set_home call: no files, no start_editing, no check_build. Apps that aren't tabs are in the Apps tab. An app's own card on Home (a remote, a score): today_card.\n${homeScreen.describe()})`;
  }

  /** The app or game open on the screen while they talk: questions are about it, and changes are to it. */
  function appLine(b) {
    const id = String(b.app || ''); if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id)) return '';
    let name = id; try { name = JSON.parse(fs.readFileSync(path.join(APP_DIR || WORK, 'apps', id, 'app.json'), 'utf8')).name || id; } catch {}
    return `\n\n(They're looking at the app "${name}" (its code is in ${path.join(APP_DIR || WORK, 'apps', id)}; read it when that helps). Answer questions about it or anything else as usual. ` +
      `If they want it changed or fixed, change it yourself.${b.crash ? ` It crashed recently: ${String(b.crash).slice(0, 600)}` : ''})`;
  }

  /** Each day's few lines (days.js), on the Flex tier; what it cost goes in chats.jsonl with the heartbeat's. */
  async function summarizeDays(ai) {
    const done = await days.summarize({ ai });
    for (const d of done) {
      try { fs.appendFileSync(path.join(HERE, 'chats.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: 'days', background: 'days', ok: d.ok, agent: 'cloud', model: 'gpt-6-luna', tier: d.tier, usage: { cost: Math.round(d.cost * 1e6) / 1e6, input_tokens: d.tokens?.input_tokens, output_tokens: d.tokens?.output_tokens }, text: d.day + (d.error ? ` skipped (${d.error})` : '') }) + '\n'); } catch {}
      console.log(`[days] ${d.day}: ${d.ok ? 'summed up' : `skipped (${d.error})`} (${d.tier}); $${d.cost.toFixed(5)}`);
    }
    return done;
  }

  /** The rules for a stand-in agent (AGENT=fake, tests); the cloud's text model uses textInstructions(). */
  function systemPrompt() { return textInstructions(); }

  function list() {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
      const c = load(f.slice(0, -5));
      return c && c.id && Array.isArray(c.turns) && { id: c.id, title: c.title, updated: c.updated, who: c.who }; // other files here (door.json…) aren't conversations
    }).filter(Boolean).sort((a, b) => b.updated - a.updated).slice(0, 50);
  }

  async function turn(req, res) {
    const b = await body(req);
    b.app = requestApp(b.app); // the app open full screen, or the one in the home screen's tab
    const onboard = b.onboard === true; // the display was just set up: the assistant starts the conversation
    const text = onboard ? ONBOARD(voice.wakeOn()) : String(b.text || '').trim();
    if (!text) return json(res, 400, { error: 'empty' });
    const who = b.who ? String(b.who).slice(0, 40) : null;
    const about = b.about ? String(b.about).slice(0, 80) : ''; // e.g. "age 9"
    let c = validId(b.id) ? load(b.id) : null;
    if (!c) c = { id: crypto.randomUUID().slice(0, 13), title: onboard ? 'Getting to know you' : text.slice(0, 60), who, created: Date.now(), turns: [], sessions: {} };
    if (running.has(c.id)) return json(res, 409, { error: 'busy' });
    hooks.onTurn?.(); // someone's talking to it: the tablet is awake (the heartbeat's Sleep now ends)
    if (!onboard) { c.turns.push({ role: 'user', text, who, at: Date.now() }); live.heard(text); live.talk.add('user', text); }
    save(c);

    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    const send = (ev) => { try { res.write(JSON.stringify(ev) + '\n'); } catch {} };
    send({ type: 'start', id: c.id });

    const name = agentName();
    let agent;
    try { agent = await currentAgent(); } catch (e) { console.error('[chat]', e); send({ type: 'done', ok: false, text: `I can't think right now (${e.message}). Someone can fix it: Settings, then "Restart the assistant".` }); return res.end(); }
    if (!agent.chat) { send({ type: 'done', ok: false, text: `${name} can't hold a conversation yet.` }); return res.end(); }
    // What was said before in this conversation (the cloud's model starts fresh each turn): the last few turns.
    // A new conversation starts from what was said lately by voice or typed (live-tools.js recentTalk), so "that event" still means something.
    const history = [...(c.turns.length <= 1 && !onboard ? live.talk.messages(6000) : []),
      ...c.turns.slice(0, -1).slice(-12).map((t) => ({ role: t.role === 'assistant' ? 'assistant' : 'user', text: String(t.text || '').slice(0, 2000) }))];
    const abort = new AbortController();
    running.set(c.id, abort);
    abort.signal.addEventListener('abort', () => { device.stop('Someone pressed Stop.'); }); // what it was doing in an app stops too
    res.on('close', () => { if (!res.writableFinished) abort.abort(); }); // the screen closed the connection (Stop): stop the turn too
    const t0 = Date.now();
    let firstText = 0, warmed = null, held = '', usedModel = null;
    const steps = []; // [ms, what]: where a turn's time goes (chats.jsonl), from the agent's own events
    const spoken = b.spoken === true; // through the microphone: speech recognition, so words may be misheard (see CHAT.md)
    const prompt = (who ? `${who}${about ? ` (${about})` : ''} says: ` : '') + (spoken ? '(spoken) ' : '') + text +
      `\n\n(The household, for context; mention only what helps:\n${board.household()})` +
      homeLine() + buildLine() + appLine(b) + (spoken ? SPOKEN : '');
    let result, notes, run;
    // This turn may change the apps: it holds the edit lock from its first edit until it ends (edits.js).
    const editTurn = edits?.begin({ who, text: onboard ? 'Getting to know you' : text, conversation: c.id });
    // Whatever it edits the apps with (a file tool, a shell command), the display hears which app changed and
    // shows it, so the family watches it change.
    const shown = new Set(); let watcher = null;
    // A new app (not there when the turn began) isn't opened on its own while it's made: if it becomes a tab, the home
    // screen shows that tab (chat/src/home.jsx); if not, it opens at the end. Others open as before, or reload in their tab.
    let before = new Set(); try { before = new Set(fs.readdirSync(path.join(APP_DIR || WORK, 'apps'))); } catch {}
    const fresh = new Set();
    const showApp = (app) => {
      if (!before.has(app)) { fresh.add(app); return; }
      // One of the tabs: the home screen shows that tab and it reloads there; never the same app full screen over it.
      if (isTab(app)) { if (showingTab() !== app) homeScreen.showTab(app); send({ type: 'edit', app, inTab: true }); return; }
      send({ type: 'edit', app, inTab: false });
    };
    try {
      watcher = fs.watch(path.join(APP_DIR || WORK, 'apps'), { recursive: true }, (_, f) => {
        const app = String(f || '').split(/[\\/]/)[0];
        if (app && app !== 'home' && editTurn) { try { edits.claim(editTurn); } catch {} } // a shell command's edit is this turn's change too (only the watcher sees it)
        if (app && app !== 'home' && !shown.has(app) && /^[a-z0-9][a-z0-9-]*$/.test(app)) { shown.add(app); showApp(app); }
      });
    } catch {}
    try { // whatever goes wrong, the conversation is free again afterwards (else it answers "busy" forever)
    ({ result, notes, ctx: run } = await homeScreen.during({ by: 'chat', who, conversation: c.id, send, turn: editTurn, signal: abort.signal, app: /^[a-z0-9][a-z0-9-]{0,60}$/.test(String(b.app || '')) ? String(b.app) : null, crash: b.crash ? String(b.crash).slice(0, 2000) : null }, (run1) => agent.chat({
      prompt, cwd: WORK, systemPrompt: systemPrompt(), signal: abort.signal, resume: c.sessions?.[name] || null, homeToken: run1.token, history, route: !onboard,
      onEvent: (e) => {
        if (e.kind === 'step') { if (steps.length < 80) steps.push([Date.now() - t0, String(e.text).slice(0, 80)]); return; }
        if (e.kind === 'warm') { warmed = e.warm; return; }
        if (e.kind === 'model') { usedModel = e.id; return; } // the model this turn ran on (chats.jsonl: compare models)
        if (e.kind === 'home-token') return run1.attach(e.token); // a warm agent, started with its own token
        if ((e.kind === 'delta' || e.kind === 'message') && !firstText) firstText = Date.now() - t0;
        if (e.kind === 'session') { c.sessions = { ...c.sessions, [name]: e.id }; save(c); }
        else if (e.kind === 'edit') { // the app it's changing, so the display can show it changing
          if (editTurn) edits.claim(editTurn); // it's editing: the lock is its (if nobody else has it)
          const app = (e.paths || []).map((f) => String(f).match(/(?:^|\/)apps\/([a-z0-9][a-z0-9-]*)\//)?.[1]).find(Boolean);
          if (app) showApp(app); // inTab: it's in the home screen's tab, where they watch it
        }
        else if (e.kind === 'status' && !e.text) {}
        else if (e.kind === 'delta' && spoken && held != null) { // hold back what might be "[quiet]", so it's never shown or said
          held += e.text || '';
          if (!'[quiet]'.startsWith(held.trimStart().toLowerCase().slice(0, 7))) { send({ type: 'delta', text: held }); held = null; }
        }
        else if (e.kind === 'reset') { if (spoken) held = ''; send({ type: e.kind, text: e.text }); }
        else send({ type: e.kind, text: e.text });
      },
    })));
    } catch (e) {
      result = { ok: false, text: `Something went wrong (${e?.message || e}).` }; notes = []; run = null;
    } finally { running.delete(c.id); try { watcher?.close(); } catch {} }
    // What it changed in the apps: committed with what was asked, so "undo" takes it back. A turn that failed,
    // threw or was stopped puts its half-done change back instead.
    if (editTurn) { try { edits.end(editTurn, !!result.ok); } catch (e) { console.error('[edits]', e); } }
    // An answer that came back as UI in the reply instead of on a note still goes on the home screen.
    if (result.ok && !notes.length && /```spec/.test(result.text)) {
      const r = await homeScreen.during({ by: 'chat', who, conversation: c.id }, async (d) => d.put({ title: text.slice(0, 50), content: result.text.replace(/^BUILD:.*$/m, ''), size: 'large', paper: 'card', minutes: 30 }, { makeRoom: true }));
      notes.push(...r.notes);
    }
    if (notes.length) send({ type: 'notes', notes });
    if (result.sessionId) c.sessions = { ...c.sessions, [name]: result.sessionId };
    let out = result.text;
    // It decided this wasn't said to it (people talking to each other, the TV): say nothing, keep nothing.
    const quiet = result.ok && spoken && /^\W*\[quiet\]\W*$/i.test(out || '');
    if (quiet) { out = ''; if (c.turns.at(-1)?.role === 'user') c.turns.pop(); }
    if (result.ok && !quiet) c.turns.push({ role: 'assistant', text: out, at: Date.now(), ms: Date.now() - t0, ...(notes.length ? { notes } : {}) });
    if (result.ok && !quiet && !onboard) live.talk.add('assistant', out);
    else if (c.turns.at(-1)?.role === 'user' && !c.sessions?.[name]) c.turns.pop(); // nothing happened: don't keep it
    save(c);
    try { fs.appendFileSync(path.join(HERE, 'chats.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: c.id, ok: result.ok, ms: Date.now() - t0, firstTextMs: firstText, warm: warmed, agent: name, model: usedModel || result.model || name, ...(result.usage ? { usage: result.usage } : {}), text: text.slice(0, 200), chars: out.length, ...(steps.length ? { steps } : {}) }) + '\n'); } catch {}
    familyNames();
    for (const app of fresh) if (!isTab(app) && fs.existsSync(path.join(APP_DIR || WORK, 'apps', app, 'index.html'))) send({ type: 'edit', app, inTab: false }); // made, not a tab: show it now
    send({ type: 'done', ok: result.ok, text: out, ms: Date.now() - t0, ...(run?.ended ? { end: true } : {}), ...(quiet ? { quiet: true } : {}) });
    res.end();
  }

  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

  /** Returns true if it handled the request. */
  return Object.assign(async function handle(req, res, url) {
    const p = url.pathname;
    if (await voice(req, res, url)) return true;
    if (await weather(req, res, url)) return true;
    if ((p === '/map' || p.startsWith('/map/')) && await map(req, res, url)) return true;
    if ((p.startsWith('/live/') || p === '/setup/step') && await live(req, res, url)) return true;
    if ((p === '/house' || p.startsWith('/house/')) && await house(req, res, url)) return true;
    if (p.startsWith('/home') && await homeScreen(req, res, url)) return true;
    // pages: /chat/ (the conversation page, the start of a phone page) and /app/ (its bundle)
    if (req.method === 'GET' && (p === '/chat' || p === '/app' || p === '/screen')) { res.writeHead(301, { location: p + '/' }); res.end(); return true; }
    const page = req.method === 'GET' && p.match(/^\/(chat|app|screen)(\/.*)$/);
    if (page) {
      const [, dir, rest = '/'] = page;
      const rel = rest === '/' || rest === '' ? 'index.html' : rest.slice(1);
      const root = path.join(PUBLIC, dir);
      const f = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { json(res, 404, { error: 'not found' }); return true; }
      res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(f));
      return true;
    }
    if (await board(req, res, url)) return true;
    if (req.method === 'GET' && p === '/chats') { json(res, 200, list()); return true; }
    // What it remembers, for Settings: {remembered: [sentences], days: [{day, text}]}; POST /memory/forget {text} drops one
    // remembered sentence (exactly as listed), or {day} that day's lines.
    if (req.method === 'GET' && p === '/memory') { json(res, 200, { remembered: readPrefs(), days: Object.entries(days.all()).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, d]) => ({ day, text: d.text })) }); return true; }
    if (req.method === 'POST' && p === '/memory/forget') {
      const b = await body(req);
      if (b.day) { const ok = days.forget(String(b.day)); json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' }); return true; }
      const t = String(b.text || '').trim(), all = readPrefs(), keep = all.filter((x) => x !== t);
      if (keep.length === all.length) { json(res, 404, { error: 'not found' }); return true; }
      writeFileAtomic(PREFS, keep.map((x) => '- ' + x).join('\n') + (keep.length ? '\n' : ''), { bak: true });
      json(res, 200, { ok: true }); return true;
    }
    if (req.method === 'GET' && p.startsWith('/chats/')) {
      const c = validId(p.slice(7)) && load(p.slice(7));
      json(res, c ? 200 : 404, c ? { ...c, running: running.has(c.id) } : { error: 'not found' });
      return true;
    }
    if (req.method === 'POST' && p === '/chat') { await turn(req, res); return true; }
    if (req.method === 'POST' && p === '/chat/warm') { json(res, 200, { ok: true }); return true; } // (nothing to warm now; older shells still ask)
    if (req.method === 'POST' && p === '/chat/stop') {
      const b = await body(req);
      running.get(String(b.id || ''))?.abort();
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  }, { homeScreen, deviceServer, house, things, notes, board, hooks, live, voice, textTools, callText, textInstructions, busy: () => running.size > 0, work: WORK, summarizeDays, weather }); // homeScreen, deviceServer: for the workshop (workshop.js); the rest for the heartbeat (heartbeat.js)
}
