// The workshop: the family's apps and home screen, changed from someone's own AI app on a computer (Claude Code,
// Claude Desktop; later claude.ai and ChatGPT through a relay). docs/workshop-mcp.md.
//
// POST /workshop/mcp   MCP (JSON-RPC over HTTP). Reached by a paired computer through the home-network listener (its
//                      sealed requests, scope "workshop": screens.js), or on this device with the display's secret.
//
// The tools are the tablet assistant's own (home-screen.js, chat.js, house.js: the same code), plus what a computer needs
// because it has no turn and no files here: reading and writing files under apps/, a picture of the screen, and
// "done". A computer's change goes through the same lock as the assistant's (edits.js): start_editing opens it with
// what was asked, done_editing commits it as one change, so "undo" on the tablet takes it back like any other. A
// change left open goes in by itself after a quiet while, so a closed laptop never blocks the family's assistant.
import { DEVICE_NAMES } from './device-tools.js';
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { insideApps } from './inside-apps.js';
import { showingTab, isTab } from './home-screen.js';
import { workshopGuide } from './workshop-guide.js';

const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
// The assistant's tools a computer doesn't get: the voice's own, and the ones replaced below.
const SKIP = new Set(['end_conversation', 'progress', 'start_editing', 'check_build', 'list_changes', 'undo_change']);
const MAX_READ = 400e3;

const INSTRUCTIONS = `OpenHouse is a family's kitchen tablet: a home screen of tabs (Home, Calendar, Chores, Lists, Meals, Photos, Apps), each tab past Home one of the family's small web apps, and Apps the rest of their apps and games. These tools change it, from the person's computer, while the family may be watching.
Before changing anything, call get_guide: the home screen as it is now, how to work and how notes should read. Before making or changing an app, also get_guide with topic "apps": how apps are made here (calm, quiet ones that fit a tab), the kit and its CSS.
Tabs and the look: one set_home call. An app: start_editing, read_file/write_file, check_build, look_at_tablet, then done_editing (always). A new app goes in Apps: when it's done, ask in one short line whether to put it in the sidebar, and call set_home only on a yes. Every app is a plugin: one you make or change here becomes the household's own plugin by itself (no manifest to write; changing one of OpenHouse's own, like Calendar, makes the household's version of it, and reset_plugin puts ours back). When they ask to take a change back: undo_latest (undo_plugin for one app's latest); don't mention or offer undo otherwise. A family calendar (Google, iCloud, Outlook): add_calendar with its link; the tablet keeps it sealed and someone says yes there. An iCloud shared album for Photos: add_photo_album with its public link, the same way.
Apps the tablet noticed are broken wait in pending_fixes: fix one with start_editing {fix}; someone says yes on the tablet before it goes in.
If you have the OpenHouse skills (working-here, apps, notes, plugins, design: from the OpenHouse plugin), use them instead of get_guide, and get_guide with topic "home" for the home screen as it is now.`;
// For a client on MCP 2026-07-28 that can load this server's skills (server/discover): the guide is in them, and
// get_guide is for the home screen as it is now.
const SKILL_INSTRUCTIONS = INSTRUCTIONS.split('\n').filter((l) => !l.startsWith('If you have the OpenHouse skills')).map((l, i) => i !== 1 ? l : 'Before changing anything, load this server\'s working-here skill (how to work here) and call get_guide with topic "home" (the home screen as it is now). Before making or changing an app, also load the apps skill: how apps are made here, the kit and its CSS. The notes, plugins and design skills are for those. (No skills here? get_guide, and get_guide with topic "apps", give the same.)').join('\n');
// MCP revisions: the ones that start with initialize, and the stateless one with per-request _meta (skills need it).
const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SKILLS_EXT = 'io.modelcontextprotocol/skills';

/**
 * Changes a computer had open when the bridge stopped take the edit lock again, as theirs. server.js calls this first
 * thing at start-up, before anything else may take the lock: the plugins' start-up step (plugins.js start) and the
 * builder take it with a checkpoint, which would commit the open change's files as "checkpoint" (no longer undoable,
 * left out of list_changes). workshopRoutes picks these up; [{ key, x, turn }].
 */
export function reopenChanges({ HERE, edits, log = (...a) => console.log('[workshop]', ...a) }) {
  const saved = readJson(path.join(HERE, 'workshop-open.json'), null);
  const out = [];
  if (saved && typeof saved === 'object') for (const [key, x] of Object.entries(saved)) {
    const turn = { id: `w${Date.now()}-${key}`, kind: 'chat', who: x.name, text: x.what, conversation: null, started: x.started || Date.now() };
    if (!edits.tryAcquire(turn)) { log(`couldn't reopen ${x.name}'s change "${x.what}": another is being made`); continue; }
    out.push({ key, x, turn });
  }
  return out;
}

export function workshopRoutes({ HERE, APP_DIR, homeScreen, edits, reopened = null, plugins = null, fixes = null, approve = async () => null, events, checkBuild, deviceServer = () => null, whoOf = () => null, live = null, devices = null, json, body, idleMs = 10 * 60e3, log = (...a) => console.log('[workshop]', ...a) }) {
  const { emit, setState } = events; // the tablet's assistant shows the builder's state; a computer's change keeps out of it
  const guided = new Set(); // computers that read how apps are made (get_guide topic apps)
  // Open changes, kept on disk so one survives the bridge restarting (an update installed mid-change): its files are
  // still there, uncommitted, and stay its change.
  const OPEN_FILE = path.join(HERE, 'workshop-open.json');
  const keep = () => {
    const out = {}; for (const [k, c] of open) out[k] = { what: c.what, name: c.name, before: [...c.before], fresh: [...c.fresh], started: c.turn.started, fix: c.fix || null };
    try { writeJson(OPEN_FILE, out); } catch {}
  };
  const open = new Map(); // computer key -> { turn, what, name, before: Set of app ids, shown: Set, fresh: Set, timer }
  const read = (f) => { try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { return ''; } };
  const appsDir = path.join(APP_DIR, 'apps');
  const appIds = () => { try { return fs.readdirSync(appsDir).filter((d) => ID.test(d) && fs.statSync(path.join(appsDir, d)).isDirectory()); } catch { return []; } };
  const appName = (id) => { try { return JSON.parse(fs.readFileSync(path.join(appsDir, id, 'app.json'), 'utf8')).name || id; } catch { return id; } };
  const ok = (t) => ({ content: [{ type: 'text', text: t }] });
  const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

  function homeNow() {
    const st = homeScreen.style();
    const tabs = (st.tabs || ['today', 'calendar', 'weather', 'map', 'chores', 'lists', 'meals', 'recipes', 'photos', 'whiteboard', 'apps'].map((id) => ({ id }))).map((t) => (t.name ? `${t.id} ("${t.name}")` : t.id));
    const apps = appIds().filter((a) => a !== 'home').map((a) => `${a} ("${appName(a)}")`);
    const now = showingTab();
    return `Tabs, in order: ${tabs.join(', ')}${st.tabs ? '' : ' (the usual set)'}. Look: ${st.palette}, ${st.type} type, ${st.density}${st.backdrop === 'photos' ? ', photos behind' : ''}.` +
      `${now ? ` The tablet is showing the ${now} tab.` : ''}\nApps: ${apps.join(', ') || 'none'}.\nApps that aren't tabs are in the Apps tab.\n${homeScreen.describe()}`;
  }

  const { guide, topics, skills, versionLine } = workshopGuide({ read, homeNow });

  const RESOURCES = [
    { uri: 'openhouse://guide/workshop', name: 'Working from a computer', mimeType: 'text/markdown', text: () => read('WORKSHOP.md') },
    { uri: 'openhouse://guide/apps', name: 'How apps are made', mimeType: 'text/markdown', text: () => guide('apps') },
    { uri: 'openhouse://guide/board', name: 'Notes on Home', mimeType: 'text/markdown', text: () => read('NOTES.md') },
    { uri: 'openhouse://kit/quiet.css', name: 'The quiet kit', mimeType: 'text/css', text: () => read('kit/quiet.css') },
    { uri: 'openhouse://kit/openhouse.js', name: 'The kit (family data)', mimeType: 'text/javascript', text: () => read('kit/openhouse.js') },
    { uri: 'openhouse://home', name: 'The home screen now', mimeType: 'text/plain', text: homeNow },
  ];

  const path_ = { type: 'string', description: 'Relative to the apps folder, e.g. "apps/chores/main.js"' };
  const OWN = [
    { name: 'get_guide', description: 'Call first (with the OpenHouse skills, only topic "home"): the home screen as it is now (tabs, look, apps, notes), how to work from a computer, and how notes on Home should read. With topic "apps", before making or changing an app: how apps are made here (calm everyday tools that fit a tab, games, the kit for the family\'s data, icons), how a tab should look and the quiet kit\'s CSS. "notes", "plugins" and "design": those alone; "home": only the home screen as it is now (when this server\'s skills give the rest).',
      inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: topics, description: '"start" (the default), "apps", "notes", "plugins", "design" or "home"' } } } },
    { name: 'start_editing', description: 'Open a change before writing or deleting any file. what: what the person asked, in their words ("A whiteboard that looks like Chores"); the tablet shows it while you work and undo lists it. Waits if the family\'s assistant is changing something right now. Not needed for set_home, notes or the household tools.',
      inputSchema: { type: 'object', required: ['what'], properties: { what: { type: 'string' }, fix: { type: 'string', description: 'A waiting fix\'s id (pending_fixes), when this change fixes it: someone says yes on the tablet before it goes in.' } } } },
    { name: 'list_files', description: 'Without app: every app (id and name) and the kit\'s files. With app: that app\'s files and sizes.', inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'An app id' } } } },
    { name: 'read_file', description: 'Read a file: under apps/ (e.g. "apps/chores/main.js"), or the kit ("kit/openhouse.js", "kit/quiet.css", "kit/openhouse.css").', inputSchema: { type: 'object', required: ['path'], properties: { path: path_ } } },
    { name: 'write_file', description: 'Write a whole file under apps/ (created with its folder if new). Only while your change is open (start_editing). It shows on the tablet at once, so it must load without errors.',
      inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: path_, content: { type: 'string' } } } },
    { name: 'edit_file', description: 'Change part of a file under apps/: old is text that is in the file now, exactly once (with enough around it to be unique), new replaces it. Quicker than write_file for a small change to a big file. Only while your change is open.',
      inputSchema: { type: 'object', required: ['path', 'old', 'new'], properties: { path: path_, old: { type: 'string' }, new: { type: 'string' }, all: { type: 'boolean', description: 'Replace every time old appears' } } } },
    { name: 'delete_file', description: 'Delete a file or a whole app folder ("apps/old-game") under apps/. Only while your change is open. Never apps/home.', inputSchema: { type: 'object', required: ['path'], properties: { path: path_ } } },
    { name: 'check_build', description: 'Errors an app\'s page threw since your last save (it opens the app on the tablet if it isn\'t showing). Fix them and check again.', inputSchema: { type: 'object', required: ['app'], properties: { app: { type: 'string' } } } },
    { name: 'look_at_tablet', description: 'A picture of the tablet\'s screen now, with what is on it as text, to see what you made the way the family will. While your change is open and its app is showing, also the errors it threw since your last save.', inputSchema: { type: 'object', properties: {} } },
    { name: 'done_editing', description: 'Finish your change: everything since start_editing becomes one change on the tablet. summary: one plain sentence of what changed. Always call it when you are done. A new app is in Apps: then ask in one short line whether to put it in the sidebar (set_home only on a yes).',
      inputSchema: { type: 'object', properties: { summary: { type: 'string' } } } },
    { name: 'show_on_tablet', description: 'Put the tablet\'s screen on a tab or app, from wherever it is: "today", "apps", or an app id (one that isn\'t a tab opens full screen).',
      inputSchema: { type: 'object', required: ['tab'], properties: { tab: { type: 'string' } } } },
    { name: 'list_changes', description: 'Recent changes to the apps and home screen, newest first (id, when, what was asked), whoever made them.', inputSchema: { type: 'object', properties: {} } },
    { name: 'undo_change', description: 'Take back one change by its id (from list_changes), keeping the ones after it. Itself a change, so it can be undone too.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { name: 'undo_latest', description: 'Take back the latest change (the same as saying "undo" to the tablet).', inputSchema: { type: 'object', properties: {} } },
    { name: 'export_plugin', description: 'Share one of the household\'s plugins (plugin: its name from list_plugins), or make one plugin of several of their apps (and their look, if they want), to share with other families: the files of a plugin folder (package.json, README.md, apps/<id>/...), returned here for you to write into a folder on this computer. Read the warnings: lines with this family\'s names or town in them, to make general first (ask the person). Put it in a git repo of the person\'s own only if they ask; nothing is published from the tablet. Another tablet adds it with add_plugin and the repo\'s link.',
      inputSchema: { type: 'object', properties: { plugin: { type: 'string', description: 'One plugin on the tablet to share as it is (its name from list_plugins)' }, name: { type: 'string', description: 'The plugin\'s name: lowercase, dashes ("twins-chores")' }, apps: { type: 'array', items: { type: 'string' }, description: 'App ids' }, description: { type: 'string', description: 'One sentence another family reads before taking it' }, look: { type: 'boolean', description: 'Include the home screen\'s look' } } } },
  ];
  // Hints for the chat apps: ChatGPT asks the person before each tool that isn't marked read only, so the ones that
  // only look say so (docs/web-chat-building.md).
  const READ_ONLY = new Set(['get_guide', 'list_files', 'read_file', 'check_build', 'look_at_tablet', 'list_changes', 'look_at_notes', 'about_household', 'family_things', 'pending_fixes', 'list_plugins', 'look_at_plugin', 'weather', 'list_devices', 'device_info', 'scan']);
  const DESTRUCTIVE = new Set(['delete_file', 'remove_plugin', 'reset_plugin', 'take_down_note', 'forget_preference', 'remove_recipe']);
  // openWorldHint: the TV and devices reach things outside the tablet.
  const hint = (t) => ({ ...t, annotations: { readOnlyHint: READ_ONLY.has(t.name), destructiveHint: DESTRUCTIVE.has(t.name), openWorldHint: t.name === 'tv' || t.name === 'device_action' } });
  // The household's own tools, as its voice has them (live-tools.js): the weather, the TV, the apps' voice actions;
  // and kitchen timers and the devices in the house, so an agent can do anything one could say to the tablet.
  // And teaching a device it doesn't know (Wi-Fi or Bluetooth): a recipe is data the tablet checks, and its first use asks there.
  const DEVICE_TOOLS = ['list_devices', 'device_info', 'scan', 'device_action', 'name_device', 'save_recipe', 'remove_recipe'];
  // Not for a computer: driving the tablet's screen and its other apps is for someone at the tablet asking Opie
  // (device-tools.js), and show_on_tablet is this side's show_on_screen.
  const VOICE_ONLY = new Set([...DEVICE_NAMES, 'show_on_screen']);
  const liveExtra = () => { try { const own = new Set(homeScreen.tools().map((t) => t.name)); return (live?.tools() || []).filter((t) => !own.has(t.name) && !VOICE_ONLY.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })); } catch { return []; } };
  let deviceList = [];
  const deviceTools = () => { if (!devices?.mcp) return []; return deviceList; };
  devices?.mcp?.({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).then((r) => { deviceList = (r?.result?.tools || []).filter((t) => DEVICE_TOOLS.includes(t.name)); }).catch(() => {});
  const houseExtra = () => [...liveExtra(), ...deviceTools()];
  const tools = () => [...OWN, ...homeScreen.tools().filter((t) => !SKIP.has(t.name) && !OWN.some((o) => o.name === t.name)), ...houseExtra()].map(hint);

  /** The computer's open change, kept alive by each call. */
  function touch(c) {
    clearTimeout(c.timer);
    c.timer = setTimeout(() => {
      if (c.fix) { // a fix goes in only with a yes, so one left open is put back out, and still waits
        log(`${c.name}'s fix was left open: put back out`);
        for (const [k, v] of open) if (v === c) open.delete(k);
        try { edits.end(c.turn, false); } catch {}
        fixes?.set(c.fix, { status: 'pending' }); homeScreen.computerNote(null); keep(); emit({ type: 'apps' });
        return;
      }
      log(`${c.name}'s change was left open: it goes in as it is`); finish(c, c.what);
    }, idleMs);
    c.timer.unref?.();
  }
  function finish(c, summary) {
    clearTimeout(c.timer);
    for (const [k, v] of open) if (v === c) open.delete(k);
    let sha = null;
    try { sha = edits.end(c.turn, true); } catch (e) { log('commit failed:', e.message); }
    homeScreen.computerNote(null);
    keep();
    emit({ type: 'apps' });
    // A new app that isn't a tab opens now that it's made (one that is a tab already shows in it).
    for (const app of c.fresh) if (!isTab(app) && fs.existsSync(path.join(appsDir, app, 'index.html'))) { show(app); break; } // in Apps, not full screen
    return sha;
  }
  /**
   * Put an app where the family sees it: its tab when it is one (a tab reloads by itself as its files change), else the
   * Apps tab, where it is one of the grid. Never full screen: a computer's change doesn't take the tablet over.
   */
  function show(app) {
    const tab = isTab(app) ? app : 'apps';
    if (showingTab() !== tab) homeScreen.showTab(tab);
  }
  /** An app checked without running it: each script parses, and the files index.html loads exist. */
  function staticCheck(app) {
    const dir = path.join(appsDir, app), out = [];
    if (!fs.existsSync(path.join(dir, 'index.html'))) return [`apps/${app}/index.html is missing.`];
    for (const f of fs.readdirSync(dir).filter((x) => /\.m?js$/.test(x))) {
      const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(path.join(dir, f)), encoding: 'utf8', timeout: 10e3 });
      if (r.status) out.push(`${f}: ${String(r.stderr).split('\n').filter((l) => !/^\s+at /.test(l) && /Error|^\s*\^|:\d+/.test(l)).slice(0, 4).join(' | ').replace(/\[stdin\]/g, f)}`);
    }
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)=["'](\.?\/?[\w.-]+\.(?:js|css|svg))["']/g)) {
      if (ref.startsWith('/')) continue; // the kit and the dev server's own
      if (!fs.existsSync(path.join(dir, ref.replace(/^\.\//, '')))) out.push(`index.html loads ${ref}, which isn't there.`);
    }
    return out;
  }
  /** It wrote into this app: the tablet shows it changing (a new app waits: it opens at the end, unless it's a tab). */
  function shown(c, app) {
    if (!app || app === 'home' || c.shown.has(app)) return;
    c.shown.add(app);
    homeScreen.computerNote(`From ${c.name}: ${c.what}`, [...c.shown]); // its tab pulses (or Apps, for a new one)
    if (!c.before.has(app)) { c.fresh.add(app); keep(); return; }
    show(app);
  }

  async function call(name, a, who) {
    if (live && liveExtra().some((t) => t.name === name)) {
      const r = await live.callTool(name, a);
      if (name === 'timer' && a.action === 'start' && !r.isError) emit({ type: 'home' }); // (a new timer shows on the home screen)
      return r.isError ? err(r.text) : ok(r.text);
    }
    if (devices?.mcp && DEVICE_TOOLS.includes(name)) { const r = await devices.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } }); return r?.result || err('The devices didn\'t answer.'); }
    const key = who.id, c = open.get(key);
    if (c) touch(c);
    const ctx = { by: 'assistant', who: who.name, conversation: null, turn: c?.turn || null, touched: [], workshop: true };
    switch (name) {
      case 'export_plugin': {
        if (!plugins) return err('Plugins aren\'t on this tablet.');
        try { return ok(JSON.stringify(plugins.exportFiles(a), null, 1)); } catch (e) { return err(e.message); }
      }
      case 'get_guide':
        if (a.topic === 'apps') guided.add(key); return ok(guide(a.topic));
      case 'start_editing': {
        const what = String(a.what || '').trim().replace(/\s+/g, ' ').slice(0, 200);
        if (!what) return err('Say what was asked (what).');
        if (c) return ok(`Your change "${c.what}" is still open: keep going, or done_editing first.`);
        const turn = edits.begin({ who: who.name, text: what, conversation: null });
        const r = await edits.startEditing(turn, { timeoutMs: 60e3 });
        if (!r.ok) { edits.end(turn, false); return err(r.error); }
        const fx = a.fix && fixes ? fixes.get(String(a.fix)) : null;
        if (a.fix && (!fx || !['pending', 'working'].includes(fx.status))) { edits.end(turn, false); return err(`No waiting fix ${a.fix} (pending_fixes lists them).`); }
        const n = { turn, what, name: who.name, before: new Set(appIds()), shown: new Set(), fresh: new Set(), timer: null, fix: fx?.id || null };
        if (fx) fixes.set(fx.id, { status: 'working', by: who.name });
        open.set(key, n); touch(n); keep();
        // The tablet says so quietly (a line under its tabs), not by its assistant looking busy: that's for its own work.
        homeScreen.computerNote(`From ${who.name}: ${what}`);
        log(`${who.name} is changing: "${what}"`);
        return ok('Go ahead: the apps are yours to change until done_editing. A new app goes in Apps: write it, check_build, look_at_tablet, done_editing, then ask in one short line whether to put it in the sidebar (set_home only on a yes).' + (guided.has(key) ? '' : ' Load the apps skill (or get_guide with topic "apps") before writing an app: how apps are made here.'));
      }
      case 'list_files': {
        if (!a.app) {
          const apps = appIds().map((id) => `${id} ("${appName(id)}")${isTab(id) ? ', a tab' : ''}`);
          return ok(`Apps (apps/<id>/):\n${apps.join('\n')}\n\nThe kit (read-only): kit/openhouse.js, kit/openhouse.css, kit/quiet.css`);
        }
        const id = String(a.app);
        if (!ID.test(id) || !fs.existsSync(path.join(appsDir, id))) return err(`No app ${id}.`);
        const files = fs.readdirSync(path.join(appsDir, id), { withFileTypes: true }).filter((f) => !f.name.startsWith('.'))
          .map((f) => f.isDirectory() ? `${f.name}/` : `${f.name} (${fs.statSync(path.join(appsDir, id, f.name)).size} bytes)`);
        return ok(`apps/${id}/:\n${files.join('\n')}`);
      }
      case 'read_file': {
        const rel = String(a.path || '').replace(/^\/+/, '');
        const kit = rel.match(/^kit\/(openhouse\.js|openhouse\.css|quiet\.css)$/);
        const file = kit ? path.join(HERE, 'kit', kit[1]) : insideApps(APP_DIR, rel);
        if (!file) return err('Only files under apps/ or the kit (kit/openhouse.js, kit/quiet.css, kit/openhouse.css).');
        if (!fs.existsSync(file)) return err(`No file ${rel}.`);
        if (fs.statSync(file).isDirectory()) return err(`${rel} is a folder: list_files.`);
        const buf = fs.readFileSync(file);
        if (buf.length > MAX_READ) return err(`${rel} is ${buf.length} bytes: too big to read here.`);
        if (buf.includes(0)) return err(`${rel} isn't text.`);
        return ok(buf.toString('utf8'));
      }
      case 'write_file': case 'delete_file': case 'edit_file': {
        if (!c) return err('No change is open (done_editing ends one, and one left quiet for 10 minutes goes in by itself): call start_editing again. Anything written since stays and becomes part of it.');
        const rel = String(a.path || '').replace(/^\/+/, '');
        const file = insideApps(APP_DIR, rel);
        if (!file) return err('Only under apps/ (e.g. "apps/whiteboard/main.js").');
        const app = path.relative(fs.realpathSync(appsDir), file).split(path.sep)[0]; // insideApps resolves links (/var is /private/var on a Mac)
        if (name === 'delete_file' && app === 'home') return err('Never apps/home (tabs and the look: set_home).');
        if (!edits.claim(c.turn)) return err(edits.busyText() || 'Someone else is changing the apps.');
        if (name === 'delete_file') {
          if (!fs.existsSync(file)) return err(`No file ${rel}.`);
          fs.rmSync(file, { recursive: true, force: true });
          return ok(`Deleted ${rel}.`);
        }
        if (name === 'edit_file') {
          if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return err(`No file ${rel}.`);
          if (typeof a.old !== 'string' || !a.old || typeof a.new !== 'string') return err('old: text in the file now; new: what replaces it.');
          const was = fs.readFileSync(file, 'utf8'), n = was.split(a.old).length - 1;
          if (!n) return err(`${rel} doesn't have that text (old must match exactly, spaces and all). read_file to see it as it is.`);
          if (n > 1 && !a.all) return err(`That text is in ${rel} ${n} times: add more around it so it's unique, or all: true.`);
          fs.writeFileSync(file, a.all ? was.split(a.old).join(a.new) : was.replace(a.old, () => a.new));
          shown(c, app);
          return ok(`Changed ${rel}${n > 1 ? ` (${n} places)` : ''}.`);
        }
        if (typeof a.content !== 'string') return err('content: the whole file, as text.');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, a.content);
        shown(c, app);
        return ok(`Wrote ${rel} (${Buffer.byteLength(a.content)} bytes).`);
      }
      case 'check_build': {
        const app = String(a.app || '');
        if (app === 'home') return ok('Nothing to check: the home screen is the display\'s own page.');
        if (!ID.test(app)) return err('Which app (its id)?');
        // Its page reports errors only while it's open: open it (or reload its tab), then give it a moment.
        if (!isTab(app)) { // not running on the tablet (a computer never opens apps full screen): check it as files
          const found = staticCheck(app);
          if (found.length) return err(`Errors:\n${found.join('\n')}`);
          const r = await checkBuild(app);
          if (!r.ok) return err(`Errors:\n${r.errors}`);
          return ok('Its files parse and what index.html loads is there. It\'s in Apps, not running on the tablet now, so errors it throws while running show once someone opens it.');
        }
        if (showingTab() !== app) { show(app); await new Promise((r) => setTimeout(r, 4000)); }
        const r = await checkBuild(app);
        return ok(r.ok ? (r.note ? `No errors. ${r.note}` : 'It builds and runs.') : `Errors:\n${r.errors}`);
      }
      case 'look_at_tablet': {
        const d = deviceServer();
        if (!d) return err('The tablet\'s screen can\'t be seen from here (no device tools: someone turns on "Device control" in Settings).');
        try {
          const r = await fetch(d.url, { method: 'POST', headers: { authorization: d.auth, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'look', arguments: {} } }), signal: AbortSignal.timeout(30e3) });
          const j = await r.json();
          if (j.result?.content) {
            // Like Lamp's look: with the picture (and the screen as text, for a chat that can't see pictures), the
            // errors the app being changed threw since its last save, so one call says how the change went in.
            const app = showingTab();
            let errs = null;
            if (c && app && c.shown.has(app)) { try { const r = await checkBuild(app); errs = r.ok ? `${appName(app)}: no errors since its last save.` : `${appName(app)} threw since its last save:\n${r.errors}`; } catch {} }
            return { content: [...j.result.content, ...(errs ? [{ type: 'text', text: errs }] : [])], isError: !!j.result.isError };
          }
          return err(j.error?.message || 'The tablet didn\'t send a picture.');
        } catch (e) { return err(`The tablet's screen can't be seen right now (${e.cause?.code || e.message}).`); }
      }
      case 'done_editing': {
        if (!c) return ok('Nothing open: nothing to finish.');
        if (c.fix) {
          // A fix the tablet noticed goes in only after a yes on the tablet (null: no shell to ask, a laptop).
          const fx = fixes?.get(c.fix);
          const yes = await approve(`Put in ${who.name}'s fix for ${fx?.name || 'the app'}?`, `${String(a.summary || c.what).slice(0, 300).replace(/\.$/, '')}.`, true, { yes: 'Put it in' });
          if (yes === false) {
            clearTimeout(c.timer); open.delete(key); keep(); homeScreen.computerNote(null);
            try { edits.end(c.turn, false); } catch {}
            fixes?.set(c.fix, { status: 'pending' });
            emit({ type: 'apps' });
            return err('Nobody said yes on the tablet, so the fix was put back out (the app is as it was). It is still waiting: try again when someone is by the tablet.');
          }
        }
        const sha = finish(c, String(a.summary || '').trim().slice(0, 300) || c.what);
        if (c.fix) fixes?.set(c.fix, sha ? { status: 'done', sha } : { status: 'pending' });
        let which = '';
        if (sha && plugins) { try { which = plugins.describe(new Set(edits.git('show', '--name-only', '--format=', sha).split('\n').map((f) => f.match(/^apps\/([^/]+)\//)?.[1]).filter(Boolean))); } catch {} }
        return ok(sha ? `Saved as one change (${sha.slice(0, 7)}): "${c.what}".${which ? ` Plugin: ${which}.` : ''}` : 'Nothing had changed, so there is nothing to save.');
      }
      case 'show_on_tablet': { // the same as Opie's show_on_screen (server.js setScreen): from wherever the tablet is
        if (!live) return err('The tablet\'s screen can\'t be changed from here.');
        const r = await live.callTool('show_on_screen', { what: String(a.tab || '') });
        return r.isError ? err(r.text) : ok(r.text.replace(/ look_at_screen.*$/, ''));
      }
      case 'list_changes': return ok(JSON.stringify(edits.listChanges(), null, 1));
      case 'undo_change': {
        const r = edits.undoChange(String(a.id || ''), c?.turn || null);
        if (!r.ok) return err(r.error);
        emit({ type: 'state', ...events.state }); emit({ type: 'apps' });
        return ok(`Took back: ${r.undid}`);
      }
      case 'undo_latest': {
        const r = edits.undoLatest(c?.turn || null);
        if (!r.ok) return err(r.nothing ? 'Nothing to undo.' : r.error);
        emit({ type: 'apps' }); // not 'undone': that's the assistant's own card
        setState({ lastChange: r.latest });
        return ok(`Took back: ${r.undid}`);
      }
    }
    if (!tools().some((t) => t.name === name)) return err(`unknown tool ${name}`);
    const r = await homeScreen.call(name, a, ctx);
    return r;
  }

  // Changes that were open when the bridge stopped: open again, with what was written since as theirs.
  // (Their lock is taken back by reopenChanges, at start-up before anything else; without it, here.)
  try {
    const again = reopened || reopenChanges({ HERE, edits, log });
    for (const { key, x, turn } of again) {
      const n = { turn, what: x.what, name: x.name, before: new Set(x.before || []), shown: new Set(), fresh: new Set(x.fresh || []), timer: null, fix: x.fix || null };
      open.set(key, n); touch(n);
      homeScreen.computerNote(`From ${x.name}: ${x.what}`);
      log(`${x.name}'s change "${x.what}" is open again`);
    }
    if (again.length || fs.existsSync(OPEN_FILE)) keep();
  } catch {}

  /**
   * One MCP message from a paired computer or connector (who: screens.who), its JSON-RPC reply; null for a notification.
   * Two eras on one endpoint (MCP 2026-07-28, "dual-era"): a request with the per-request _meta is served by that
   * revision (server/discover, results with resultType and caching hints, the skills extension); one without it is
   * the initialize-and-session kind, as before. Either way it's the same workshop, behind the same scope.
   */
  async function rpc(msg, who) {
    if (msg?.id == null) return null; // notifications
    const p = msg.params || {};
    const meta = p._meta && typeof p._meta === 'object' ? p._meta : null;
    const version = meta?.['io.modelcontextprotocol/protocolVersion'];
    const modern = version != null;
    const fail = (code, message, data) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message, ...(data ? { data } : {}) } });
    if (modern) {
      if (!MODERN.includes(version)) return fail(-32022, 'Unsupported protocol version', { supported: [...MODERN, ...LEGACY], requested: version });
      if (!meta['io.modelcontextprotocol/clientCapabilities'] || typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object') return fail(-32602, 'params._meta needs io.modelcontextprotocol/clientCapabilities');
    }
    // Caching hints (2026-07-28): what is the household's is private to this caller; the skills are the bridge's own text.
    const cache = (ttlMs, cacheScope = 'private') => (modern ? { ttlMs, cacheScope } : {});
    const reply = (result, hints = {}) => ({ jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...result, ...hints } : result });
    switch (msg.method) {
      case 'initialize': return reply({ protocolVersion: LEGACY.includes(p.protocolVersion) ? p.protocolVersion : '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'openhouse', version: '0.1' }, instructions: `${INSTRUCTIONS}\n${versionLine()}` });
      case 'server/discover':
        if (!modern) return fail(-32602, 'server/discover needs params._meta (MCP 2026-07-28)');
        return reply({ supportedVersions: MODERN, capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXT]: {} } }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'openhouse', version: '0.1' } }, instructions: `${SKILL_INSTRUCTIONS}\n${versionLine()}` }, cache(0));
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: tools() }, cache(0));
      case 'resources/templates/list': return reply({ resourceTemplates: [] }, cache(0));
      case 'prompts/list': return reply({ prompts: [] }, cache(0));
      case 'resources/list': return reply({ resources: RESOURCES.map(({ text, ...r }) => r) }, cache(0));
      case 'skills/list': return reply({ skills: skills.list() }, cache(300e3, 'public'));
      case 'skills/get': {
        const s = skills.get(String(p.uri || ''));
        return s ? reply({ skill: s }, cache(300e3, 'public')) : fail(-32602, 'no such skill');
      }
      case 'resources/read': {
        const uri = String(p.uri || '');
        const f = skills.read(uri);
        if (f) {
          if (skills.topicOf(uri) === 'apps') guided.add(who.id); // it read how apps are made
          return reply({ contents: [{ uri, mimeType: f.mimeType, text: f.text }] }, cache(300e3, 'public'));
        }
        const r = RESOURCES.find((x) => x.uri === uri);
        if (!r) return fail(-32602, 'no such resource');
        return reply({ contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text() }] }, cache(0));
      }
      case 'tools/call': {
        try { return reply(await call(String(p.name || ''), p.arguments || {}, who)); }
        catch (e) { return reply(err(e.message)); }
      }
    }
    return fail(-32601, 'method not found');
  }

  async function handle(req, res, url) {
    if (url.pathname !== '/workshop/mcp') return false;
    if (req.method !== 'POST') { json(res, 405, { error: 'POST' }); return true; }
    const id = String(req.headers['x-openhouse-screen'] || '');
    const who = (id && whoOf(id)) || { id: 'display', name: 'a computer' };
    const out = await rpc(await body(req), who);
    if (!out) { res.writeHead(202); res.end(); return true; }
    json(res, 200, out);
    return true;
  }
  handle.rpc = rpc; // the tablet's own connector (web-mcp.js) calls it directly
  return handle;
}
