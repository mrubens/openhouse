// The builder: an agent making or changing an app when it was asked outright (POST /request), with its progress
// streamed to the screens, under the same lock as every other change (edits.js). On a tablet the agent is the cloud's
// text model on rails (agents/cloud.js run, rails.js: docs/building-on-the-tablet.md); with that off, /request only
// says a computer makes apps (workshop.js). A stand-in agent (AGENT=fake) runs here too, which is how the edit lock is
// tested. check_build and the apps' errors (/apperror) are for everyone.
//
// POST /request {text, who?, app?, crash?, context?}  start a run; app = the app open on screen
// POST /cancel                 stop the run and put back what it changed
// POST /apperror {app, text}   an app's page threw (the shell's web view, or the kit); its next check sees it. From an
//                              app's own key, app is always the caller (server.js appCall), whatever the body says
import { requestApp, showingTab } from './home-screen.js';
import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from './dates.js';

export function builderRoutes({ HERE, APP_DIR, agentName, currentAgent, edits, events, json }) {
  const { emit, setState } = events;
  const git = edits.git;
  let abort = null;
  let sessionId = null; // only used when SESSION=reuse; dropped on undo/restore

  // Plain-language progress for the family, independent of which agent runs.
  function friendly(tool, file) {
    const f = file || '';
    if (tool?.startsWith('mcp__home__')) {
      const t = tool.slice(11);
      return t === 'scan' ? 'Looking around the network' : t === 'device_action' ? `Talking to ${globalThis.openhouseDeviceName?.(f) || f || 'a device'}` : t === 'save_recipe' ? 'Learning a new device' : 'Checking the devices';
    }
    if (tool?.startsWith('mcp__device__')) {
      const t = tool.slice(12);
      if (t === 'open_app') return `Opening ${f || 'an app'}`;
      if (t === 'type') return f ? `Typing “${f.slice(0, 40)}”` : 'Typing';
      if (t === 'key') return f === 'home' ? 'Coming back to the display' : 'Going back';
      if (t === 'tap') return 'Tapping';
      if (t === 'scroll') return 'Scrolling';
      if (t === 'install_app') return `Adding ${f || 'an app'}`;
      return 'Looking at the screen';
    }
    const app = f.match(/^apps\/([\w-]+)\//)?.[1]?.replace(/[-_]/g, ' ');
    if (app) {
      if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') return `Looking at the ${app} app`;
      if (/app\.json$/.test(f)) return `Naming the ${app} app`;
      return tool === 'Write' ? `Building the ${app} app` : `Updating the ${app} app`;
    }
    const widget = f.match(/widgets\/([\w-]+)\.js$/)?.[1]?.replace(/[-_]/g, ' ');
    if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
      if (/layout\.js$/.test(f)) return 'Looking at the layout';
      if (/\.css$/.test(f)) return 'Looking at the styles';
      if (widget) return `Looking at the ${widget} widget`;
      if (/MEMORY\.md$/.test(f)) return 'Checking earlier requests';
      return null; // reading around: nothing worth showing (its own words say what it's doing)
    }
    if (widget) return tool === 'Write' ? `Building the ${widget} widget` : `Updating the ${widget} widget`;
    if (/layout\.js$/.test(f)) return 'Placing it on the screen';
    if (/theme\.css$/.test(f)) return 'Restyling the screen';
    if (/\.css$/.test(f)) return 'Adjusting the styles';
    if (/data\.js$/.test(f)) return 'Updating the family info';
    return tool === 'Write' ? `Creating ${f}` : `Editing ${f}`;
  }

  // What the family sees: at most two sentences, no markdown. MEMORY.md keeps the full text.
  function shortSummary(text) {
    const plain = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    const sentences = plain.match(/[^.!?]+[.!?]+(\s|$)/g) || [plain];
    return sentences.slice(0, 2).join('').trim();
  }

  function existedAtBase(base, file) {
    try { git('cat-file', '-e', `${base}:${file}`); return true; } catch { return false; }
  }

  // The bridge, not the agent, keeps the request log: saves the agent two turns.
  function appendMemory(text, who, summary) {
    const day = dayKey(); // (the household's day: toISOString's is tomorrow by evening)
    const line = `- ${day}${who ? ' (' + who + ')' : ''}: "${text}" → ${summary.replace(/\s+/g, ' ').trim()}\n`;
    fs.appendFileSync(path.join(APP_DIR, 'MEMORY.md'), line);
  }

  function logRun(r) {
    try { fs.appendFileSync(path.join(HERE, 'runs.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n'); } catch {}
  }

  // Agent rules come with the bridge (not part of the apps folder the agent edits). Falls back to the
  // repo's CLAUDE.md for older setups.
  function systemPrompt() {
    for (const f of [path.join(HERE, 'AGENT.md'), path.join(APP_DIR, 'CLAUDE.md')]) {
      try { return fs.readFileSync(f, 'utf8'); } catch {}
    }
    return '';
  }

  function listApps() {
    try {
      return fs.readdirSync(path.join(APP_DIR, 'apps'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'apps', d.name, 'app.json'), 'utf8')); } catch {}
        return { id: d.name, ...meta };
      });
    } catch { return []; }
  }
  const appOf = (file) => file?.match(/^apps\/([\w-]+)\//)?.[1] || null;

  // Errors an app's page threw, reported by the shell's web view or the kit (POST /apperror).
  const appErrors = new Map(); // app id -> [{ at, text }]
  /** Errors [app]'s page reported since [since], after giving an open page a moment to load. */
  async function pageErrors(app, since, waitMs = 3000) {
    await new Promise((r) => setTimeout(r, waitMs));
    return [...new Set((appErrors.get(app) || []).filter((e) => e.at >= since).map((e) => e.text))];
  }

  let run = null; // the builder's lock owner while it works
  async function startRun(text, who, ctx = {}) {
    if (events.state.state === 'working') throw new Error('busy');
    abort = new AbortController();
    const owner = run = { id: 'build', kind: 'build', who, text, abort };
    const startedAt = Date.now();
    emit({ type: 'ack', text, who });
    setState({ state: 'working', request: text, who, base: null, startedAt });
    let ok = false;
    try {
      // One change at a time: a conversation changing the apps right now finishes first.
      if (edits.holder() && edits.holder() !== owner) emit({ type: 'log', kind: 'info', text: edits.busyText(), friendly: 'Waiting for the change before this one' });
      if (!(await edits.acquire(owner, { signal: owner.abort.signal, checkpoint: true }))) return; // cancelled while waiting
      events.state.base = owner.base;
      ok = await runBuild(owner, text, who, ctx, startedAt);
    } finally {
      // A run that failed, was cancelled or threw puts back what it changed; one that worked is committed already.
      if (!ok) edits.discard(owner);
      edits.release(owner);
      if (run === owner) { run = null; abort = null; }
    }
  }

  /** Returns true when its change is kept (committed, or nothing to keep). */
  async function runBuild(owner, text, who, ctx, startedAt) {
    const base = owner.base;
    let firstEditMs = null;
    const phases = {};
    let agentModel = null;
    const mark = (name, extra) => {
      if (phases[name] !== undefined) return;
      phases[name] = Date.now() - startedAt;
      emit({ type: 'phase', name, ms: phases[name], ...extra });
    };
    const edited = new Set();
    const editTools = new Map();
    const editNames = new Map();

    const apps = listApps();
    const openApp = ctx.app && apps.find((a) => a.id === ctx.app);
    const prompt =
      (who ? `${who} asks: ` : '') + text +
      `\n\n(Today is ${new Date().toString()}.)` +
      (apps.length ? `\n(Apps and games: ${apps.filter((a) => a.id !== 'home').map((a) => `${a.id} "${a.name || a.id}"`).join(', ')}.)` : '') +
      (openApp ? `\n(They are looking at apps/${openApp.id}/ right now. "it"/"this" probably means that app.)` : '') +
      (openApp && ctx.crash ? `\n(That app just crashed with: ${String(ctx.crash).slice(0, 500)}. Fix the cause too.)` : '') +
      (ctx.context ? `\n\nContext from the family's conversation with the display's assistant:\n${String(ctx.context).slice(0, 20000)}` : '');

    let runSession = null, lastEditAt = 0;
    const touchedApps = new Set();
    const onEvent = (e) => {
        if (e.kind === 'phase' && e.sessionId) runSession = e.sessionId;
        if (e.kind === 'phase' && e.name === 'thinking') return emit({ type: 'phase', name: 'thinking' }); // repeats; not timed
        if (e.kind === 'writing') {
          mark('firstWrite');
          return emit({ type: 'writing', text: e.detail, friendly: friendly(e.name, e.detail), lines: e.lines, tail: e.tail });
        }
        if (e.kind === 'phase') { if (e.model) agentModel = e.model; if (e.sessionId) sessionId = e.sessionId; return mark(e.name, { model: e.model }); }
        if (e.kind === 'delta') mark('firstText');
        if (e.kind === 'tool') mark('firstTool');
        if (e.kind === 'delta') return emit({ type: 'delta', text: e.text });
        if (e.kind === 'text') return emit({ type: 'log', kind: 'text', text: e.text });
        if (e.kind === 'intent') return emit({ type: 'intent', text: e.text }); // what it says it's doing
        if (e.kind === 'tool') {
          if (e.name === 'Edit' || e.name === 'Write') { editTools.set(e.id, e.detail); editNames.set(e.id, e.name); }
          return emit({ type: 'log', kind: 'tool', name: e.name, text: `${e.name} ${e.detail}`.trim(), friendly: friendly(e.name, e.detail) });
        }
        if (e.kind === 'tool-done' && editTools.has(e.id) && e.ok) {
          const file = editTools.get(e.id);
          edited.add(file);
          if (firstEditMs === null) { firstEditMs = Date.now() - startedAt; mark('firstEdit'); }
          if (file !== 'MEMORY.md' && existedAtBase(base, file)) mark('firstVisible');
          lastEditAt = Date.now();
          const app = appOf(file);
          if (app) touchedApps.add(app);
          emit({ type: 'edit', text: file, app, inTab: !!app && showingTab() === app, friendly: friendly(editNames.get(e.id), file), ms: Date.now() - startedAt });
        }
    };
    const agent = await currentAgent();
    let result = await agent.run({
      prompt, cwd: APP_DIR, systemPrompt: systemPrompt(), signal: owner.abort.signal,
      resume: process.env.SESSION === 'reuse' ? sessionId : null, onEvent, owner,
    });

    // An app's page must load without errors. Feed what it threw back to the same agent session (up to 3 tries).
    let fixRounds = 0;
    while (result.ok && !result.checked && touchedApps.size && events.state.state === 'working' && fixRounds < 3) { // (checked: the agent did this itself, before a parent's yes: rails.js)
      emit({ type: 'phase', name: 'checking' });
      const failed = [];
      for (const app of touchedApps) {
        if (!fs.existsSync(path.join(APP_DIR, 'apps', app))) continue;
        const errs = await pageErrors(app, lastEditAt, 4000);
        if (errs.length) failed.push(`apps/${app} (errors in the page):\n${errs.join('\n').slice(0, 3000)}`);
      }
      if (!failed.length) break;
      fixRounds++;
      emit({ type: 'log', kind: 'tool', text: 'Fixing an error', friendly: `Fixing an error${fixRounds > 1 ? ` (try ${fixRounds})` : ''}` });
      result = await agent.run({
        prompt: `The app's page threw errors. Fix these errors with Edit, then reply in one or two plain sentences about the app (not about the fix):\n\n${failed.join('\n\n')}`,
        cwd: APP_DIR, systemPrompt: systemPrompt(), signal: owner.abort.signal, resume: runSession, onEvent, owner,
      });
    }
    phases.buildFixes = fixRounds;
    const ms = Date.now() - startedAt;
    logRun({ text, who, ok: result.ok, ms, phases, edits: [...edited], agent: agentName(),
      model: result.model || agentModel || process.env.AGENT_MODEL || 'default', ...(result.usage ? { usage: result.usage } : {}), resumed: !!(process.env.SESSION === 'reuse' && phases.resumed), variant: process.env.VARIANT || '' });

    if (events.state.state !== 'working' || owner.abort.signal.aborted) return false; // cancelled: put back
    if (!result.ok) {
      edits.discard(owner);
      const text = result.text;
      emit({ type: 'done', spoken: !!ctx.spoken, ok: false, text, ms, firstEditMs });
      setState({ state: 'idle', request: null, base: null });
      return false;
    }
    if (!edits.dirty()) {
      emit({ type: 'done', spoken: !!ctx.spoken, ok: true, changed: false, text: shortSummary(result.text), full: result.text, ms, firstEditMs });
      setState({ state: 'idle', request: null, base: null });
      return true;
    }
    appendMemory(text, who, result.text);
    edits.commit(owner);
    emit({ type: 'done', spoken: !!ctx.spoken, ok: true, changed: true, text: shortSummary(result.text), full: result.text, files: [...edited], ms, firstEditMs, visibleMs: phases.firstVisible, apps: [...touchedApps] });
    if (touchedApps.size) emit({ type: 'apps' });
    setState({ state: 'idle', request: null, base: null });
    return true;
  }

  /** check_build: errors the app's page threw after its latest edit (reported while it's open on a screen). */
  async function checkBuild(app) {
    const dir = path.join(APP_DIR, 'apps', app);
    if (!fs.existsSync(dir)) return { ok: false, errors: `No app ${app}.` };
    if (!fs.existsSync(path.join(dir, 'index.html'))) return { ok: false, errors: `apps/${app}/index.html is missing.` };
    const since = Math.max(...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs)) - 50;
    const errs = await pageErrors(app, since);
    return errs.length ? { ok: false, errors: errs.join('\n').slice(0, 3000) } : { ok: true, note: 'No errors reported (only reported while the app is open).' };
  }

  /** An app's page threw: kept for its next check (the last 20). False when there's no app or no text. */
  function appError(app, text) {
    const id = String(app || ''); text = String(text || '').slice(0, 1000);
    if (!id || !text) return false;
    const list = appErrors.get(id) || [];
    list.push({ at: Date.now(), text }); appErrors.set(id, list.slice(-20));
    return true;
  }

  /** Whether a request can be built here: a stand-in agent (AGENT=fake), or the cloud's model on rails (agents/cloud.js). */
  async function buildsHere() {
    const n = agentName();
    if (n === 'none' || n === 'off') return false;
    return n !== 'cloud' || (await import('./agents/cloud.js')).buildsHere();
  }
  /** Start making or changing an app from the bridge itself (the typed assistant's route, the voice's make_app): { ok } or { busy }. */
  async function request(text, who = null, ctx = {}) {
    text = String(text || '').trim();
    if (!text || !(await buildsHere())) return { ok: false };
    if (events.state.state === 'working') return { ok: false, busy: true };
    startRun(text, who, { app: requestApp(ctx.app), ...ctx }).catch((e) => {
      console.error(e);
      emit({ type: 'done', ok: false, text: e.message });
      setState({ state: 'idle', request: null, base: null });
    });
    return { ok: true };
  }

  async function handle(req, res, url, b) {
    switch (url.pathname) {
      case '/request': {
        const text = String(b.text || '').trim();
        if (!text) return json(res, 400, { error: 'empty' });
        if (!(await buildsHere())) { // no coding agent here: say where apps are made
          const { NEEDS_COMPUTER } = await import('./agents/cloud.js');
          emit({ type: 'done', spoken: !!b.spoken, ok: false, text: NEEDS_COMPUTER, ms: 0 });
          return json(res, 202, { ok: true });
        }
        if (events.state.state === 'working') return json(res, 409, { error: 'busy' });
        startRun(text, b.who ? String(b.who) : null, { app: requestApp(b.app), crash: b.crash ? String(b.crash) : null, context: b.context ? String(b.context) : null, spoken: !!b.spoken }).catch((e) => {
          console.error(e);
          emit({ type: 'done', ok: false, text: e.message });
          setState({ state: 'idle', request: null, base: null });
        });
        return json(res, 202, { ok: true });
      }
      case '/apperror': { // the display (the shell's web view) names the app; an app's own key reports only its own (server.js appCall)
        const ok = appError(b.app, b.text);
        return ok ? json(res, 200, { ok: true }) : json(res, 400, { error: 'app and text needed' });
      }
      case '/cancel': {
        if (events.state.state !== 'working') return json(res, 409, { error: 'not running' });
        abort?.abort();
        if (run) edits.discard(run); // now, so it's back at once (again when the agent has stopped)
        emit({ type: 'done', ok: false, text: 'Cancelled' });
        setState({ state: 'idle', request: null, base: null });
        return json(res, 200, { ok: true });
      }
    }
    return false;
  }
  return { handle, request, checkBuild, appError, errors: () => [...appErrors].flatMap(([app, l]) => l.map((e) => ({ app, ...e }))), abort: () => abort?.abort(), forgetSession: () => { sessionId = null; } };
}
