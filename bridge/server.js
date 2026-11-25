// The bridge: the display's local server. The shell's native board, its app windows and a paired computer's AI
// (workshop.js) talk to it; it keeps the conversations (chat.js), the family's home screen, household, voices and devices,
// and owns undo. It listens on this device only, and every
// request carries the display's secret (auth.js).
//
// POST /apps/delete {id, who}  take an app or game off the display ("undo" brings it back)
// POST /undo                   take back the latest change (a git revert, so later changes stay)
// POST /restore                hard reset of the apps to last-good (for recovery by hand)
//
// Edits go through one lock (edits.js): one change at a time, committed with the words of whoever
// asked; "undo" is a git revert of that change. Progress: events.js (/events, /state).
import http from 'node:http';
import fs from 'node:fs';
import { calendarLinkTools, shellCall } from './calendar-links.js';
import { toShell } from './shell-call.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(HERE, '../webapp'));
const PORT = Number(process.env.PORT || 8787);
import { chatRoutes } from './chat.js';
import { devicesRoutes } from './devices/index.js';
import { editLock } from './edits.js';
import { authorized, loopbackHost } from './auth.js';
import { eventStream } from './events.js';
import { isTab, homePath } from './home-screen.js';
import { builderRoutes } from './builder.js';
import { screensRoutes } from './screens.js';
import { appsRoutes, onScreen, appAllowed, houseFor } from './apps.js';
import { appFetch, reachMatches } from './app-web.js';
import { pluginsRoutes } from './plugins.js';
import { workshopRoutes, reopenChanges } from './workshop.js';
import { webMcpRoutes } from './web-mcp.js';
import { heartbeat } from './heartbeat.js';
import { appChecks, dataReader } from './heartbeat-checks.js';
import { fixQueue } from './heartbeat-fixes.js';
import { snapshot } from './heartbeat-review.js';
import { laterRoutes } from './later.js';
import { unsaved } from './store.js';
import { cloudRoutes, noteError } from './cloud.js';
import { lanTls } from './lan-tls.js';
import { relayRoutes } from './relay.js';
import { mailRoutes } from './mail.js';
import { phoneBuzz } from './phone-buzz.js';
import { phoneShareRoutes } from './phone-share.js';
import { Readable, Writable } from 'node:stream';
import { backupRoutes } from './backup.js';
import { driveDestination } from './drive.js';
import { folderDestination } from './folder-backup.js';
import { hubRoutes, isHub } from './hub.js';
import { weatherSense } from './weather-sense.js';
import { guarded } from './guarded.js';

// Once it's serving, a stray error from one request or timer is logged, and the bridge keeps serving the family. It
// doesn't hide a stuck bridge: the shell's watchdog asks /state every 10 s and restarts one that stops answering
// (Runtime.kt). Before it's listening, any such error ends the process: one that stayed alive without serving would
// look stopped to the shell, which would start another beside it (its voice worker and timers still running).
let listening = false;
function stray(what) {
  return (e) => {
    console.error(`[bridge] ${what}${listening ? '' : ' before listening; exiting'}:`, e?.stack || e);
    if (!listening) process.exit(1);
  };
}
process.on('unhandledRejection', stray('unhandled rejection'));
process.on('uncaughtException', stray('uncaught exception'));

// Who answers: there's no coding agent on the tablet (making and changing apps is someone's own Claude or ChatGPT on
// a computer, through the workshop: workshop.js). Talking is OpenAI's live voice (the shell, through the cloud), and
// typed turns, getting to know the family, flyers and the heartbeat's notes go to the cloud's text model with the
// household's tools (agents/cloud.js), once the tablet is linked and the family chose OpenAI (Settings →
// Live voice). Safe mode (Settings): nothing. AGENT picks a stand-in instead (tests, a laptop): fake, fake-chat, off.
const agents = {};
let cloudRef = null; // (cloud.js, once it exists below)
function agentName() {
  if (fs.existsSync(path.join(HERE, '../safe-mode'))) return 'off'; // safe mode (Settings): no agent
  if (process.env.AGENT) return process.env.AGENT;
  return cloudRef?.brainOn?.() ? 'cloud' : 'none';
}
async function currentAgent() {
  const n = agentName();
  if (n === 'none') return (agents.none ??= (await import('./agents/none.js')));
  return (agents[n] ??= await import(`./agents/${n}.js`));
}

function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

const events = eventStream();
const { emit, setState } = events;
// Changes stay: no Keep/Undo step. "Undo that" (or POST /undo) reverts the latest change, then the one
// before, newest first. Kept on disk, so "undo" still works after a restart.
const edits = editLock({ APP_DIR, UNDO_FILE: path.join(HERE, 'undo.json'), onLanded: (text) => { events.state = { ...events.state, lastChange: text }; } });
const git = edits.git;
// Boot order for the edit lock: a change a computer had open when the bridge stopped (an update installed mid-change)
// takes the lock back first, before the file watcher, the builder or the plugins' start-up step (plugins.start, below)
// can take it. Each of those checkpoints what nobody holds, which would commit the open change's files as
// "checkpoint": no longer undoable and left out of list_changes. The plugins' step then finds the lock busy and runs
// again once the change is done (plugins.js start). The workshop itself (workshopRoutes, below) adopts these.
const reopened = reopenChanges({ HERE, edits });
edits.watch();
const builder = builderRoutes({ HERE, APP_DIR, agentName, currentAgent, edits, events, json });

const devices = devicesRoutes({ HERE, json, body }); // first: it sets HOME_MCP_* for the agents
const chat = chatRoutes({ HERE, APP_DIR, agentName, currentAgent, json, body, building: () => events.state,
  // The assistant edits the apps itself during a conversation, under the same lock: a turn that edits holds it
  // until it ends, then its change is committed with what was asked (or put back if the turn failed or was
  // stopped), and the screens are told to reload their apps.
  edits: {
    begin: edits.begin, claim: edits.claim, startEditing: edits.startEditing, holder: edits.holder,
    tryAcquire: edits.tryAcquire, finish: edits.finish, busyText: edits.busyText, // the home screen's look (home-screen.js /home/look)
    end: (t, ok) => { const sha = edits.end(t, ok); if (sha) { emit({ type: 'state', ...events.state }); emit({ type: 'apps' }); } return !!sha; },
  },
  // The family's changes, newest first, and taking back one of them (not just the latest): git revert, so
  // later changes stay. Itself a change, so it can be undone too.
  listChanges: edits.listChanges,
  // "Undo that" from Opie (undo_change "latest"): the same as POST /undo, the latest change taken back.
  undoLatest: (turn) => {
    const r = edits.undoLatest(turn);
    if (r.ok) { builder.forgetSession(); emit({ type: 'apps' }); setState({ lastChange: r.latest }); }
    return r;
  },
  undoChange: (id, turn) => {
    const r = edits.undoChange(id, turn);
    if (r.ok) { emit({ type: 'state', ...events.state }); emit({ type: 'apps' }); }
    return r;
  },
  checkBuild: builder.checkBuild });
process.env.OPENHOUSE_APP_DIR = APP_DIR;
const apps = appsRoutes({ HERE, APP_DIR, json });
// Plugins (plugins.js, docs/plugins.md): apps and a look another family made, added as one change after someone's
// yes on the tablet's card. An app from a plugin gets only what its plugin was granted (rightsOf, below).
const shellApprove = async (title, detail, pin, extra = {}) => { // extra: { yes, rights: [{kind, text}], more, danger } (docs/ux.md) // true, false, or null when there's no shell to ask (a laptop)
  const r = await toShell('/approve', { ...extra, title, detail, pin }, { ms: 100e3 });
  return r && r.ok && r.body?.yes === true;
};
// A calendar link (add_calendar, from the workshop or a typed chat): straight to the shell, never kept here (calendar-links.js).
const calendar = calendarLinkTools({ config: () => process.env.DEVICE_MCP_CONFIG });
chat.homeScreen.addTools(calendar.tools, calendar.call);
// Every app is a plugin (ours from defaults/, the household's own, or from a link): on start-up the one-time move,
// then this release's built-ins. A commit's changed apps keep their manifests right (edits.js snapshot).
const DEFAULTS = (() => { const d = process.env.DEFAULTS_DIR || path.join(HERE, '../defaults'); return fs.existsSync(path.join(d, 'apps')) ? path.join(d, 'apps') : d; })();
// "Both" on an update (a shared app the household changed): the cloud's text model puts the two versions together.
const plugins = pluginsRoutes({ APP_DIR, edits, homeScreen: chat.homeScreen, json, body, approve: shellApprove,
  ai: async (q) => { if (!cloudRef?.brainOn?.()) throw new Error("OpenHouse's cloud assistant isn't set up"); return cloudRef.ai(q); },
  DATA: path.resolve(process.env.CHAT_DIR || path.join(HERE, '../chats'), '../appdata'), DEFAULTS, SEEDED: path.join(HERE, '../.defaults-seeded'),
  onChange: () => { emit({ type: 'state', ...events.state }); emit({ type: 'apps' }); },
  household: () => { try { return JSON.parse(fs.readFileSync(path.join(HERE, '../household.json'), 'utf8')); } catch { return {}; } } });
chat.homeScreen.addTools(plugins.tools, plugins.call);
// An app's card on Home (its widget.html): a plugin's app only with "today-card" granted; the household turns each on (home-screen.js today_card).
apps.setRightsOf(plugins.rightsOf); apps.setFrozenOf(plugins.frozenOf);
chat.homeScreen.setCardApps(() => apps.list().filter((a) => a.today).map((a) => ({ id: a.id, name: a.meta?.name || a.id })));
plugins.start();
chat.live.setExtra?.({ tools: plugins.voiceTools, call: plugins.callVoice });
chat.live.setTv?.(devices);
// What apps put on the calendar (day-notes.js): Opie knows the next week's notes (and the events, with the others), and an app taken off takes them with it.
// Is an app with notes on the calendar still there: the apps listed once a couple of seconds, not once per app per read
// (each listing reads every app's folder; with a few apps' notes, GET /house took seconds and the watchdog restarted the bridge).
let appIds = { at: 0, ids: new Set() };
chat.notes.setAlive((app) => { if (Date.now() - appIds.at > 2000) appIds = { at: Date.now(), ids: new Set(apps.list().map((a) => a.id)) }; return appIds.ids.has(app); });
chat.live.setDayNotes?.(() => chat.notes.describe());
// Opie putting the screen on a tab or one of the household's apps (live-tools.js show_on_screen): OpenHouse to the front
// (from another Android app), an app open full screen closed, then the tab, or the app full screen (home-screen.js showApp).
chat.live.setScreen?.({
  places: () => {
    const all = apps.list().filter((a) => a.web);
    return [{ id: 'today', name: 'Home', tab: true }, ...all.map((a) => ({ id: a.id, name: a.meta?.name || a.id, tab: isTab(a.id) })), { id: 'apps', name: 'Apps (every app, and the Android apps added)', tab: true }];
  },
  show: async (id) => {
    const d = chat.deviceServer();
    if (d) await fetch(d.url.replace(/\/mcp$/, '/front'), { method: 'POST', headers: { authorization: d.auth, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3e3) }).catch(() => {});
    emit({ type: 'home' });
    if (id === 'today' || id === 'apps') chat.homeScreen.showTab(id); else chat.homeScreen.showApp(id);
    await new Promise((r) => setTimeout(r, 1200)); // (it's on screen before look_at_screen reads it)
  },
}); // "Opie, turn off the TV" without the agent (docs/phones-and-tv.md)
// The heartbeat (heartbeat.js, docs/heartbeat.md): plain checks every 5 minutes (and the ones apps declare), judged by
// the cloud's decision model when the family chose OpenAI, else only the checks and tidying. A broken
// app waits for whoever builds (heartbeat-fixes.js: the workshop's pending_fixes), behind the PIN card, one undo.
const HB_DIR = path.resolve(process.env.CHAT_DIR || path.join(HERE, '../chats'));
const fixes = fixQueue({ DIR: HB_DIR });
chat.homeScreen.addTools(fixes.tools, fixes.call);
chat.things.setFixes(() => fixes.open()); // a broken app waiting for its fix shows on Home (things.js)
const checksFromApps = appChecks({ APP_DIR, readData: dataReader(path.resolve(HB_DIR, '../appdata')), houseView: () => chat.house.view(),
  houseKeysOf: (app) => { const r = plugins.rightsOf(app); return r ? new Set(Object.keys(houseFor(chat.house.view(), r))) : null; },
  fixedChecks: (app) => plugins.checksOf(app) });
const hb = heartbeat({ judge: { name: 'cloud', ready: () => !!cloudRef?.liveOn?.(), decide: (i, q) => cloudRef.decide(i, q), ai: (q) => cloudRef.ai(q) },
  fixes, things: chat.things, extraChecks: checksFromApps.run, checkProblems: checksFromApps.problems,
  changesOf: (app) => { const all = edits.listChanges(); const mine = all.filter((c) => c.change.includes(app)); return (mine.length ? mine : all).slice(0, 5); },
  HERE, DIR: HB_DIR, homeScreen: chat.homeScreen, house: chat.house, board: chat.board,
  appErrors: builder.errors, busy: chat.busy, json, body,
  edits: { begin: edits.begin, claim: edits.claim, holder: edits.holder, end: (t, ok) => { const sha = edits.end(t, ok); if (sha) { emit({ type: 'state', ...events.state }); emit({ type: 'apps' }); } return !!sha; } },
  every: process.env.HEARTBEAT === 'off' ? 0 : 5 * 60e3 });
chat.hooks.onTurn = hb.awake;
// Follow-ups for later (later.js): "remind Maya at 4, out loud", "check at 5 whether the package came and tell me".
// Said with the kit's say (never at night or after Sleep now) and a line on Home; a "do" one runs the cloud's text
// model with the voice's tools, as the heartbeat's review does.
const later = laterRoutes({ DIR: HB_DIR, say: (t) => chat.voice.say(t), things: chat.things, night: () => chat.house.night(),
  asleep: () => (hb.state.sleepUntil || 0) > Date.now(), talk: chat.live.talk, live: chat.live,
  ai: (q) => { if (!cloudRef?.liveOn?.()) throw new Error('no cloud'); return cloudRef.ai({ ...q, webSearch: true }); }, // (the vendor's own search, as the voice has)
  picture: () => snapshot({ hv: chat.house.view(), notes: chat.homeScreen.describe(), household: chat.board.household(), findings: null }),
  every: process.env.HEARTBEAT === 'off' ? 0 : 20e3 });
chat.homeScreen.addTools(later.tools, later.call);
// Each day's conversations in a few lines (days.js), hourly on the Flex tier, when the family chose OpenAI and there's new talk.
if (process.env.HEARTBEAT !== 'off') setInterval(() => { if (cloudRef?.liveOn?.()) chat.summarizeDays((q) => cloudRef.ai(q)).catch((e) => console.error('[days]', e.message)); }, 60 * 60e3).unref?.();
// Weather sense (weather-sense.js): a line or two tying the forecast to the next days' plans, for /weather. Flex tier,
// after 6 AM, after noon and when the forecast or plans change; never at night. What it cost goes in chats.jsonl.
const sense = weatherSense({ DIR: HB_DIR, weather: () => chat.weather.current(), events: () => chat.house.view().events || [],
  people: () => { const h = chat.board.householdView(); return [h.location && `Home: ${h.location}`, ...(h.family || []).map((p) => `- ${p.name}${p.note ? `: ${p.note}` : ''}`)].filter(Boolean).join('\n'); },
  ai: (q) => cloudRef.ai(q), ready: () => !!cloudRef?.liveOn?.(), night: () => chat.house.night(), every: process.env.HEARTBEAT === 'off' ? 0 : 15 * 60e3 });
chat.weather.useSense(sense.lines);
sense.onRun((x) => {
  try { fs.appendFileSync(path.join(HERE, 'chats.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: 'weather-sense', background: 'weather', ok: x.ran, agent: 'cloud', model: 'gpt-6-luna', tier: x.tier, usage: { cost: Math.round((x.cost || 0) * 1e6) / 1e6, input_tokens: x.tokens?.input_tokens, output_tokens: x.tokens?.output_tokens }, text: x.ran ? `${x.why}: ${x.lines.map((l) => l.text).join(' / ') || 'nothing'}` : `skipped (${x.error})` }) + '\n'); } catch {}
  console.log(`[sense] ${x.ran ? `${x.why}: ${x.lines.length} line(s)` : `skipped (${x.error})`}; $${(x.cost || 0).toFixed(5)}`);
});
// The cloud service (cloud.js) and backups (backup.js) to the cloud and/or a USB drive (drive.js): off until someone
//  turns them on in Settings. Display secret only: paired screens and apps never reach them.
const DISPLAY = process.env.CLOUD_DISPLAY || path.join(HERE, '..');
let backups = null;
const cloud = cloudRoutes({ DISPLAY, json, body, agentName, backupBits: () => backups?.bits() || {}, fixesFile: path.join(HB_DIR, '../heartbeat-fixes.json') });
cloudRef = cloud;
chat.live.useAi((q) => cloud.ai(q)); // setup: what's heard fills in the step (live-tools.js setupHeard)
chat.live.useDecide((i, q) => cloud.decide(i, q));
import('./calendar.js').then((m) => m.useCalendarDecide((i, q) => cloud.decide(i, q)));
import('./maps.js').then((m) => m.useMapCloud({ suggest: (q, near) => cloud.placesSuggest(q, near), place: (id) => cloud.placeOf(id) })); // the Map's address suggestions // which events of a calendar kept only in part (calendar.js) // judgments about what was said, from the whole conversation (live-tools.js judge)
// The tablet's assistant for typed turns and the rest: the cloud's text model with the household's tools (chat.js textTools).
import('./agents/cloud.js').then((m) => m.useCloud({ ai: cloud.ai, decide: cloud.decide, tools: chat.textTools, callTool: chat.callText, instructions: chat.textInstructions }));
// A hub (docs/hub.md) has no shell to own a USB drive: its backups go to a folder instead (a mounted drive, a share, a volume).
const localDest = isHub() ? folderDestination({ dir: process.env.OPENHOUSE_BACKUP_DIR || path.join(DISPLAY, 'backups') }) : driveDestination({ DISPLAY });
backups = backupRoutes({ DISPLAY, json, body, destinations: [cloud.destination, localDest], escrow: cloud.escrow, busy: () => !!edits.holder() });
// The tablet's own https name at home (lan-tls.js): its address comes from the shell (POST /screens/address); a hub's
// from LAN_ADDRESS, as only the machine knows which of its addresses the Wi-Fi sees.
const lanTlsState = lanTls({ DIR: path.join(DISPLAY, '.lan-tls'), cloud, PORT: Number(process.env.SCREENS_PORT || 8788) });
if (process.env.LAN_ADDRESS) lanTlsState.address(process.env.LAN_ADDRESS);
// Other screens on the home network (off until someone adds one): their requests come to route() below.
let relay = null;
const screens = screensRoutes({ HERE, json, body, APP_DIR, apns: (b) => cloud.apns(b), lanTls: lanTlsState, kit: (req, res, url) => apps.kit(req, res, url), onChange: () => relay?.changed(),
  // A TV's layout is an app (app.json "screens": ["tv"]): the household's own first, then ours (openhouse-tv).
  // A TV's layout is an app (app.json "screens": ["tv"]): the household's own first, then ours (openhouse-tv). A phone
  // shows every app that runs on phones (apps.js onScreen), each in a frame of its own (docs/phones.md, "Every app").
  screenApps: (kind) => apps.list().filter((a) => a.web && onScreen(a.meta, kind))
    .map((a) => ({ id: a.id, name: String(a.meta.name || a.id), ours: plugins.ownerOf?.(a.id)?.e?.kind === 'builtin', icon: a.icon, tabIcon: typeof a.meta.tabIcon === 'string' ? a.meta.tabIcon.slice(0, 40) : null, shared: !!a.shared, reaches: plugins.reachesOf(a.id) }))
    .sort((x, y) => Number(x.ours) - Number(y.ours)),
  dispatch: (req, res, url) => {
    // What a screen's app asks for (through the screen's page around it): only what that app may do, as on the tablet.
    // A phone may not make the tablet speak or run its timers for an app (it isn't in the room).
    const app = req.headers['x-openhouse-screen-app'];
    if (!app) return route(req, res, url);
    if (!appAllowed(req.method, url.pathname, plugins.rightsOf(app)) || /^\/(voice\/say|home\/handsfree|home\/timer)$/.test(url.pathname)) return json(res, 403, { error: 'not for this app' });
    return appCall(req, res, url, app);
  } });
// Away from home (relay.js, docs/networking.md): the same sealed requests through the cloud's relay. Off until someone
//  turns it on, and only for a linked tablet.
// Email to the tablet (mail.js, docs/tablet-email.md): the household's address through the cloud, on by default once
//  linked, and/or its own mailbox (the shell's IMAP). Display only, like the cloud's settings.
const mail = mailRoutes({ DISPLAY, json, body, house: chat.house, cloud, shell: isHub() ? null : (p, b) => shellCall(p, b, { timeoutMs: 60e3 }).then((r) => (r.error ? null : r)), every: process.env.MAIL === 'off' ? 0 : 5 * 60e3 });
relay = relayRoutes({ DISPLAY, json, body, screens, cloud, onMail: () => mail.nudge() });
chat.live.setWhoOf?.((id) => screens.who(id)); // Opie on someone's phone knows who it's talking with (live-tools.js)
chat.live.setPhones?.({ phones: () => screens.phones(), message: (people, m) => screens.message(people, m) }); // message_family: a message to someone's phones (live-tools.js)
// A note for someone: their phone gets it (Web Push from the tablet itself; only phones that allowed notifications).
chat.homeScreen.onNoteFor = (n) => { screens.notify(n.for, { title: n.title, body: String(n.content || '').replace(/```[\s\S]*?```/g, '').replace(/[#*_>`]/g, '').trim().split('\n')[0], tag: n.id }).catch(() => {}); };
// Send to Opie (docs/phones.md): something shared from someone's phone is a typed turn as from them (phone-share.js).
/** A typed turn run here, as a screen's POST /chat would: {ok, text, id}. */
function chatTurn(text, who, id) {
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    Object.assign(req, { method: 'POST', url: '/chat', headers: { host: '127.0.0.1', 'content-type': 'application/json' } });
    req.push(Buffer.from(JSON.stringify({ text, who, ...(id ? { id } : {}) }))); req.push(null);
    let out = '';
    const res = new Writable({ write(c, e, cb) { out += c; cb(); } });
    res.writeHead = () => res; res.setHeader = () => {};
    res.on('finish', () => {
      let done = null, cid = id; for (const l of out.split('\n')) { try { const ev = JSON.parse(l); if (ev.type === 'start') cid = ev.id; if (ev.type === 'done') done = ev; if (ev.error) done = { ok: false, text: ev.error }; } catch {} }
      resolve({ ok: done?.ok !== false, text: String(done?.text || '').trim(), id: cid });
    });
    chat(req, res, new URL('http://127.0.0.1/chat')).catch(() => resolve({ ok: false, text: 'Opie couldn’t answer that just now.' }));
  });
}
const phoneShare = phoneShareRoutes({ screens, json, body, turn: chatTurn, shareKey: (id) => screens.shareKeyOf(id), message: (people, m) => screens.message(people, m), phones: () => screens.phones(), addPhoto: (bytes, name, text) => chat.house.addPhoto(bytes, name, text),
  describe: async (bytes, type) => (await import('./agents/cloud.js')).answer({ prompt: 'Someone in this household shared this picture with their home assistant. Say plainly what it is and everything in it they might want done: events with their dates, times and places; a recipe; things to buy; anything else. Plain text.', images: [{ type, bytes }] }) });
chat.homeScreen.addTools(phoneShare.tools, phoneShare.call); // keep_shared_photo: a photo shared from a phone, into Photos
// A reminder for someone's event buzzes their phones once when it comes due, never at night (phone-buzz.js).
const buzz = phoneBuzz({ reminders: (t) => chat.house.reminders(t), night: () => chat.house.night(), notify: (p, m) => screens.notify(p, m) });
setInterval(() => { buzz.tick().catch(() => {}); }, 30e3).unref();

// Someone's own AI app on a computer (Claude, ChatGPT), paired like a screen, changes the apps with the assistant's
// tools (workshop.js, docs/workshop-mcp.md).
const workshop = workshopRoutes({ HERE, APP_DIR, homeScreen: chat.homeScreen, edits, reopened, plugins, fixes, approve: shellApprove, events, checkBuild: builder.checkBuild, deviceServer: chat.deviceServer, whoOf: (id) => screens.who(id), live: chat.live, devices, json, body }); // live, devices: the household's tools for a connected agent
// The tablet's own connector for Claude or ChatGPT, with no OpenHouse cloud: behind the household's own https address
// (a Tailscale Funnel, a tunnel), off until someone turns it on (web-mcp.js, docs/web-chat-building.md).
const webMcp = webMcpRoutes({ HERE, screens, workshop, json, body });
// The hub (hub.js, docs/hub.md): no tablet, its settings in a browser. Off on a tablet.
const hub = isHub() ? hubRoutes({ DISPLAY, screens, json }) : null;
hub?.start();

/**
 * Who may talk to the bridge: the display's own code (no Origin header), its own pages, and the dev server's.
 * Any other web page (a site open in a browser on the tablet) is refused, so it can't start the agent, undo or
 * delete. The bridge only listens on this device, so nothing else on the Wi-Fi reaches it at all.
 */
function allowedOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  if (o === `http://${req.headers.host}`) return true;
  // (a shared app's own origin, http://<id>.localhost:5173: only its own key works from there, apps.js caller)
  const m = /^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2|[a-z0-9][a-z0-9-]{0,60}\.localhost):(\d+)$/.exec(o);
  const vite = ['5173', String(process.env.VITE_PORT || '')];
  return !!m && (m[1].endsWith('.localhost') ? vite : [...vite, '8787', String(PORT)]).includes(m[2]); // (other ports: a hub sharing a computer)
}

http.createServer(guarded('bridge', async (req, res) => {
  req.url = homePath(req.url); // /door/... is /home/... (home-screen.js)
  const url = new URL(req.url, 'http://x');
  if (!allowedOrigin(req)) { res.writeHead(403); return res.end(); }
  if (req.method === 'OPTIONS') { // only the pages allowedOrigin lets in get here
    res.writeHead(204, { 'access-control-allow-origin': req.headers.origin || 'null', 'access-control-allow-headers': 'content-type, x-openhouse-token, x-openhouse-app, x-openhouse-key', 'access-control-allow-methods': 'GET, POST', vary: 'origin' });
    return res.end();
  }
  if (apps.kit(req, res, url)) return; // the apps' kit: plain code and fonts
  // A video in Photos for a <video src> (it can't send a key): only with the address /house/photo/<name>?play=1 gave
  // a caller allowed to see that photo, for a few hours, on this device (house.js serveVideo).
  if (req.method === 'GET' && loopbackHost(req) && url.pathname.startsWith('/house/video/') && chat.house.serveVideo(req, res, url)) return;
  // The home screen's own page and its code (also served to other screens with no key): GET only, nothing secret in them.
  if (req.method === 'GET' && loopbackHost(req) && /^\/(screen|app)\//.test(url.pathname)) return route(req, res, url);
  // A family app, with its own key: only what APP_RULES allow (apps.js).
  const app = apps.caller(req);
  if (app) {
    if (!loopbackHost(req) || !appAllowed(req.method, url.pathname, plugins.rightsOf(app))) { res.writeHead(403, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end('{"error":"not for apps"}'); }
    return appCall(req, res, url, app);
  }
  if (!authorized(req, url)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); } // auth.js
  if (await screens(req, res, url)) return; // Settings' screens (loopback only: screens never reach these)
  if (/^\/(cloud|backup)\//.test(url.pathname)) { try { await (url.pathname.startsWith('/cloud/') ? cloud : backups).handle(req, res, url); } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); } return; }
  if (/^\/mail(\/|$)/.test(url.pathname)) { try { await mail.handle(req, res, url); } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); } return; }
  await route(req, res, url);
})).on('error', (e) => { console.error('[bridge] listener:', e.code || e.message); process.exit(1); }) // (can't listen: the shell starts it again)
  .listen(PORT, process.env.BRIDGE_HOST || '127.0.0.1', () => { listening = true; console.log(`bridge on :${PORT}, app ${APP_DIR}, agent ${agentName()}`); });

/** A response whose JSON passes through fn first (the house's data, cut to what a plugin's app may see). */
function onlyThe(res, fn) {
  let head = [200, {}];
  return Object.assign(Object.create(res), {
    writeHead: (code, h) => { head = [code, h || {}]; return res; },
    end: (b) => {
      let out = b;
      try { if (head[0] === 200 && b) out = JSON.stringify(fn(JSON.parse(String(b)))); } catch { out = '{}'; }
      res.writeHead(head[0], head[1]); res.end(out);
    },
    on: res.on.bind(res), once: res.once.bind(res),
  });
}

/**
 * A call from one of the apps (its rights already checked, apps.js appAllowed): from its page on the tablet (its key),
 * or from its frame on someone's phone (screens.js, the phone's page marks each call with the frame's app).
 */
async function appCall(req, res, url, app) {
  const rights = plugins.rightsOf(app); // null: the family's own app
  if (url.pathname.startsWith('/appdata/')) { try { await apps.handle(req, res, url, app); } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); } return; }
  // The web through the bridge, only the hosts the app reaches (app-web.js); its own one line on Home (things.js).
  // A website it chooses at setup (a shared app whose card said so): the tablet's card with the PIN, then the plugin's manifest.
  if (url.pathname === '/apps/reach') { const b = await body(req); const r = await plugins.askReach(app, b.host, b.key || null); return json(res, 200, r); }
  if (url.pathname === '/apps/reach/forget') { const b = await body(req); return json(res, 200, plugins.forgetReach(app, b.host)); }
  // Its own page's errors only: the app is the caller, never one the body names (they reach the builder's checks).
  if (url.pathname === '/apperror') { const b = await body(req); return builder.appError(app, b.text) ? json(res, 200, { ok: true }) : json(res, 400, { error: 'text needed' }); }
  if (url.pathname === '/apps/fetch') { const b = await body(req); const r = await appFetch(app, b.url, plugins.reachesOf(app), { binary: b.binary === true }); return json(res, r.error ? r.status || 502 : 200, r); }
  if (url.pathname === '/calendar/days') { const b = await body(req), reaches = plugins.reachesOf(app); const n = chat.notes.put(app, apps.list().find((a) => a.id === app)?.meta?.name || app, b.days, { imageOk: (u) => reachMatches(u.host, reaches) }); return json(res, 200, { ok: true, days: n }); } // a note's photos only from hosts the app reaches
  if (url.pathname === '/calendar/events') { const b = await body(req); const n = chat.notes.putEvents(app, apps.list().find((a) => a.id === app)?.meta?.name || app, b.events); return json(res, 200, { ok: true, events: n }); }
  // The home's speakers and TVs (devices/index.js forApp): the app's own ids, the same asks as Opie, rate-limited.
  if (url.pathname.startsWith('/apps/devices')) {
    const b = await body(req), who = { id: app, name: apps.list().find((a) => a.id === app)?.meta?.name || app };
    const r = url.pathname === '/apps/devices' ? await devices.forApp.list(who, { state: b.state === true })
      : url.pathname === '/apps/devices/get' ? await devices.forApp.get(who, b.id)
      : await devices.forApp.do(who, b.id, b.action, b.args);
    return json(res, r.limited ? 429 : 200, r);
  }
  if (url.pathname === '/today/line') {
    const b = await body(req);
    let r;
    try {
      if (b.off || !String(b.text || '').trim()) { chat.things.takeApp(app); return json(res, 200, { ok: true }); }
      r = chat.things.putApp(app, { text: b.text, until: b.until, sleep: b.sleep });
    } catch (e) { if (!e?.unsaved) throw e; const u = unsaved(e); return json(res, u.status, { error: u.error }); } // (not saved: not shown either)
    return r ? json(res, 200, { ok: true, text: r.item.text, until: r.item.until }) : json(res, 400, { error: 'Say what it is.' });
  }
  if (rights && /^\/house(\/wait)?$/.test(url.pathname)) return route(req, onlyThe(res, (v) => (v?.same === true ? { v: v.v, same: true } : houseFor(v, rights))), url); // (nothing changed: only that)
  return route(req, res, url);
}

/** Every route, once the caller is known: the display (its secret), or a paired screen whose scopes allow it (screens.js). */
async function route(req, res, url) {
  try {
    // The setup phone or computer (screens.js scope 'setup'): a calendar or an album straight to the shell (trusted:
    // added with no card on the tablet unless its lock is on), and invites for the family.
    if (req.method === 'POST' && /^\/setup\/(calendar|album|invite)$/.test(url.pathname)) {
      const b = await body(req);
      if (url.pathname === '/setup/invite') {
        const r = screens.invite(b.person, b.grownup !== false);
        if (!r.error) { const via = relay?.inviteVia?.(); if (via) { Object.assign(r, via); relay.changed(); } } // a link that works from anywhere
        json(res, r.error ? 400 : 200, r); return true;
      }
      const r = await calendar.toShell(url.pathname === '/setup/calendar' ? '/calendar' : '/album', { url: String(b.link || '').trim(), who: String(b.who || '').trim().slice(0, 40), from: 'setup', trusted: true });
      json(res, r.error ? 400 : 200, r); return true;
    }
    // An iCloud shared album's link from a grown-up's own phone (the Photos app there): theirs to add, as the setup
    // phone's are, so no card or PIN on the tablet (unless its lock is on). A kid's phone, a shared screen or a TV can't.
    if (req.method === 'POST' && url.pathname === '/phone/album') {
      const who = screens.who(String(req.headers['x-openhouse-screen'] || ''));
      if (!(who?.kind === 'phone' && who.person && who.scopes.includes('ask'))) { json(res, 403, { error: 'Only a grown-up\'s own phone can add an album here.' }); return true; }
      const b = await body(req);
      const r = await calendar.toShell('/album', { url: String(b.link || '').trim(), from: who.person, trusted: true });
      json(res, r.error ? 400 : 200, r); return true;
    }
    // Live voice from another device (screens.js 'voice', chat/src/live-voice.js): its session starts through the cloud
    // as the tablet's does (/cloud/live/start), and its time is counted the same way.
    // A device sends only its offer; the session's instructions and tools are the household's, made here (live-tools.js setupFor).
    if (req.method === 'POST' && /^\/live\/(start|usage)$/.test(url.pathname)) {
      if (url.pathname === '/live/start') req.liveSetup = await chat.live.setupFor(req);
      await cloud.handle(req, res, new URL('/cloud' + url.pathname, 'http://x')); return true;
    }
    // A hub's settings device (screens.js 'admin'): what the tablet's Settings reach on its loopback.
    if (hub) {
      if (await hub(req, res, url)) return true;
      if (/^\/screens(\/|$)/.test(url.pathname) && await screens(req, res, url)) return true;
      if (/^\/(cloud|backup)\//.test(url.pathname)) { await (url.pathname.startsWith('/cloud/') ? cloud : backups).handle(req, res, url); return true; }
    }
    if (events.handle(req, res, url, json)) return true;
    if (await apps.handle(req, res, url)) return true;
    if (await devices(req, res, url)) return true;
    if (await chat(req, res, url)) return true;
    if (await workshop(req, res, url)) return true;
    if (await webMcp(req, res, url)) return true;
    if (await relay(req, res, url)) return true;
    if (await phoneShare(req, res, url)) return true;
    if (await screens.phone(req, res, url)) return true;
    if (await screens.apps(req, res, url)) return true; // a TV's layout (an app for screens) // a paired phone's push address (docs/phones-and-tv.md)
    if (await plugins.handle(req, res, url)) return true;
    if (await hb(req, res, url)) return true;
    if (req.method !== 'POST') { json(res, 404, { error: 'not found' }); return true; }

    const b = await body(req);
    if (await builder.handle(req, res, url, b) !== false) return true;
    switch (url.pathname) {
      case '/apps/delete': { // someone deleted it (or the agent did): a change like any other, so "undo" works
        const id = String(b.id || '');
        const dir = path.join(APP_DIR, 'apps', id);
        if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id) || id === 'home' || !fs.existsSync(dir)) return json(res, 404, { error: 'no such app' });
        let name = id; try { name = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8')).name || id; } catch {}
        const owner = { id: 'delete', kind: 'delete', who: b.who ? String(b.who).slice(0, 40) : null, text: `Delete ${name}` };
        if (!edits.tryAcquire(owner, { checkpoint: true })) return json(res, 409, { error: 'busy', text: edits.busyText() });
        try { fs.rmSync(dir, { recursive: true, force: true }); edits.finish(owner, true); }
        catch (e) { edits.finish(owner, false); throw e; }
        emit({ type: 'state', ...events.state });
        emit({ type: 'apps' });
        return json(res, 200, { ok: true, deleted: name });
      }
      case '/undo': { // the latest change, reverted (a new commit: the changes after it stay)
        const r = edits.undoLatest();
        if (!r.ok) return json(res, 409, { error: r.error });
        builder.forgetSession();
        emit({ type: 'undone', text: r.undid });
        emit({ type: 'apps' });
        setState({ lastChange: r.latest });
        return json(res, 200, { ok: true, undid: r.undid });
      }
      case '/restore': { // the watchdog, when the screen won't load: the one place that resets
        builder.abort();
        git('reset', '--hard', 'last-good');
        git('clean', '-fd');
        builder.forgetSession();
        emit({ type: 'log', kind: 'error', text: 'Screen failed to load; restored last good version.' });
        setState({ state: 'idle', request: null, base: null });
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    noteError('bridge.route');
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
  return true;
}
