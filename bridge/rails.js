// Making and changing apps on the tablet itself, with the cloud's text model (agents/cloud.js run, through our service:
// cloud.js ai()), on rails (docs/building-on-the-tablet.md). The builder (builder.js) holds the edit lock and commits;
// this is the agent it runs. What keeps a small model on track:
//   - One app per request, named first (start): a new game or tab begins from a tested template (templates/), whose
//     index.html (and a game's engine, game.js) stay as they are; a change is to one app that's there.
//   - Its files only: writes go into that app's folder, flat, text, small; app.json can't change what an app may reach.
//   - Checked before it's done: each script parses, what index.html loads is there, and (on the tablet) what the page
//     threw; with Device control on, it can look at the screen.
//   - A parent's yes on the tablet before it goes in (the approval card, with the PIN). A new app gets none of the
//     family's things and no websites unless the card said so (plugins.js madeHere): it runs like one from a link.
//   - A step budget and a stop when it repeats itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticCheck } from './app-check.js';
import { USES } from './apps.js';
import { rightsList } from './plugins.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FILE = /^[a-z0-9][a-z0-9_-]{0,40}\.(js|css|html|json|svg)$/i;
const MAX_FILE = 200e3, MAX_STEPS = 30, MAX_FILES = 12;
const KINDS = { game: 'game', tab: 'tab' };
// app.json fields that say what an app may do: a change made here leaves them as they were (only a card grants them).
const GUARDED = ['uses', 'reaches', 'background', 'screens', 'tablet', 'actions', 'checks', 'today'];

const RULES = `You make and change the household's apps on their kitchen tablet, one app per request, for the person who asked. Work in small steps with the tools; nobody watches the tools, so say nothing until you're done.
1. Call start first: a new game or tab (kind "game" or "tab", a short id, its name), or kind "change" with the id of the app to change. Make what was asked as it was asked; when it's unclear, the simplest thing that does it.
2. A new app starts from a template that already loads: read its files, then write main.js (and app.css for a tab; draw icon.svg, square, simple shapes). index.html stays as it is, and so does a game's game.js (the engine: read the top of it, and use what it offers rather than writing your own loop, input or collisions).
3. For a change: read the app's files first, then change only what was asked, with edit_file where you can. Keep everything else working as it was.
4. The app's own things (what someone typed, ticked or scored) are saved with the kit's store (store.get / store.set), never only in memory. A tab is calm and quiet like the starting apps, fits its box with nothing cut off and works on a phone; a game can be bold, with big touch targets.
5. check_build after writing, and fix what it finds${'${LOOK}'}. Then done, with one plain sentence for the family about what you made (not how).
Never write outside the app, never use alert/confirm/prompt, never load anything from the internet.`;

/**
 * deps: { ai(q) -> Responses output (cloud.js ai), APP_DIR, guide() (how apps are made: the workshop's "apps" guide), checkBuild(app) (builder.js: what the page threw),
 * look() -> MCP content of the tablet's screen or null (Device control off), approve(title, detail, pin, extra)
 * (server.js shellApprove: true, false, or null with no shell), madeHere(id, {uses}) and limited(id) (plugins.js),
 * show(app) (puts the app on the screen, so its errors are reported), review(q) (optional: a second model's look at the
 * code before it's done, the same call as ai; null for none), log }.
 */
export function rails(deps) {
  const { ai, review = null, APP_DIR, guide = () => '', checkBuild = async () => ({ ok: true }), look = async () => null, approve = async () => null, madeHere = () => false, limited = () => false, show = () => {}, log = (...a) => console.log('[rails]', ...a) } = deps;
  const appsDir = path.join(APP_DIR, 'apps');
  const sessions = new Map(); // a run's conversation, for the builder's "fix what the page threw" round (resume)

  const TOOLS = (canLook) => [
    { name: 'start', description: 'Call first, once: what this request makes. kind "game" or "tab" for a new one (from a template that already loads), or "change" for an app that is there.',
      parameters: { type: 'object', required: ['kind', 'app'], properties: { kind: { type: 'string', enum: ['game', 'tab', 'change'] }, app: { type: 'string', description: 'The app\'s id: lowercase and dashes ("dino-eggs"); for a change, the id of the app that is there' }, name: { type: 'string', description: 'A new app\'s name, as the family will see it ("Dino Eggs")' } } } },
    { name: 'list_files', description: 'Without app: the apps there are (id and name). With app: its files and sizes.', parameters: { type: 'object', properties: { app: { type: 'string' } } } },
    { name: 'read_file', description: 'Read a file: an app\'s ("apps/chores/main.js") or the kit\'s ("kit/openhouse.js", "kit/quiet.css").', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
    { name: 'write_file', description: 'Write a whole file of the app you started ("apps/<id>/main.js"). Flat: no folders.', parameters: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    { name: 'edit_file', description: 'Change part of a file of the app you started: old is text in it now, exactly once; new replaces it.', parameters: { type: 'object', required: ['path', 'old', 'new'], properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } } } },
    { name: 'check_build', description: 'Check the app: its scripts parse, what index.html loads is there, and what the page threw on the tablet.', parameters: { type: 'object', properties: {} } },
    ...(canLook ? [{ name: 'look_at_tablet', description: 'A picture of the tablet\'s screen now, with the app on it: see what you made the way the family will.', parameters: { type: 'object', properties: {} } }] : []),
    { name: 'done', description: 'Finish: one plain sentence for the family about what you made or changed.', parameters: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } } },
  ].map((t) => ({ type: 'function', ...t }));

  const appName = (id) => { try { return JSON.parse(fs.readFileSync(path.join(appsDir, id, 'app.json'), 'utf8')).name || id; } catch { return id; } };
  const appIds = () => { try { return fs.readdirSync(appsDir).filter((d) => ID.test(d) && d !== 'home' && fs.statSync(path.join(appsDir, d)).isDirectory()); } catch { return []; } };
  const metaOf = (text) => { try { const m = JSON.parse(text); return m && typeof m === 'object' && !Array.isArray(m) ? m : null; } catch { return null; } };

  /** One request: the builder's agent interface (builder.js runBuild). Resolves { ok, text, usage, model }. */
  async function run({ prompt, signal, onEvent = () => {}, resume = null, owner = null }) {
    const who = owner?.who || null, asked = owner?.text || '';
    const id = resume && sessions.has(resume) ? resume : `r${Date.now().toString(36)}`;
    const s = sessions.get(id) || { input: [], target: null, kind: null, fresh: false, before: null, steps: 0, usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }, summary: '' };
    sessions.set(id, s);
    while (sessions.size > 4) sessions.delete(sessions.keys().next().value);
    onEvent({ kind: 'phase', name: 'init', sessionId: id, model: 'cloud' });
    s.input.push({ role: 'user', content: String(prompt || '') });
    const canLook = !!(await look.available?.());
    const instructions = RULES.replace('${LOOK}', canLook ? ', and look_at_tablet to see it as the family will' : '') + `\n\n---- How apps are made here\n${guide()}`;
    const tools = TOOLS(canLook);
    let last = [], finished = false, n = 0;
    while (s.steps < MAX_STEPS) {
      if (signal?.aborted) return { ok: false, text: 'Stopped.' };
      let r;
      try { r = await ai({ instructions, input: s.input, tools }); }
      catch (e) { return { ok: false, text: e.code === 'http429' ? "I've used this month's allowance. Someone can see it on the family's account page." : `I couldn't make that right now (${e.message}).`, usage: s.usage }; }
      s.steps++;
      const u = r.usage || {};
      s.usage.input_tokens += u.input_tokens || 0; s.usage.output_tokens += u.output_tokens || 0; s.usage.cached_tokens += u.cached_tokens || u.input_tokens_details?.cached_tokens || 0;
      const out = r.output || [];
      s.input.push(...out);
      const calls = out.filter((o) => o.type === 'function_call');
      if (!calls.length) { s.summary ||= out.filter((o) => o.type === 'message').flatMap((o) => o.content || []).map((c) => c.text || '').join(' ').trim(); break; }
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch {}
        const callId = `${id}-${n++}`;
        const shown = c.name === 'write_file' ? 'Write' : c.name === 'edit_file' ? 'Edit' : c.name === 'read_file' ? 'Read' : c.name;
        onEvent({ kind: 'tool', id: callId, name: shown, detail: String(args.path || args.app || '') });
        let res;
        try { res = await tool(s, c.name, args, { who, asked }); } catch (e) { res = { text: e.message, error: true }; }
        onEvent({ kind: 'tool-done', id: callId, ok: !res.error });
        if (c.name === 'done' && !res.error) finished = true;
        s.input.push({ type: 'function_call_output', call_id: c.call_id, output: res.content || res.text });
        last.push(`${c.name}|${c.arguments}|${res.error ? 'e' : ''}`);
      }
      if (finished) break;
      if (last.length >= 4 && new Set(last.slice(-4)).size === 1) return { ok: false, text: "I got stuck making that. Try asking it a simpler way.", usage: s.usage };
    }
    if (!s.target) return { ok: false, text: s.summary || "I couldn't tell which app to make or change.", usage: s.usage };
    if (!finished && s.steps >= MAX_STEPS) return { ok: false, text: 'That took too many steps. Try asking for something smaller.', usage: s.usage };
    const problems = await staticCheck(appsDir, s.target);
    if (problems.length) return { ok: false, text: `It didn't come out right, so I put everything back. (${problems[0]})`, usage: s.usage };
    // A parent says yes on the tablet before it goes in (null: no shell to ask, a laptop). A new app shows what it may use.
    const meta = metaOf(fs.readFileSync(path.join(appsDir, s.target, 'app.json'), 'utf8')) || {};
    const asks = (Array.isArray(meta.uses) ? meta.uses : []).filter((u) => USES.includes(u));
    const isLimited = s.fresh || limited(s.target);
    const name = String(meta.name || appName(s.target)).slice(0, 40);
    const yes = await approve(s.fresh ? `Put ${name} in Apps?` : `Put in the change to ${name}?`,
      `${who ? `${who} asked` : 'Asked'}: "${String(asked || '').slice(0, 200)}". ${String(s.summary || '').slice(0, 300)}`, true,
      { yes: 'Put it in', ...(isLimited ? { rights: rightsList([{ name, uses: asks, reaches: [] }]) } : {}) });
    if (yes === false) return { ok: false, text: `${name} wasn't put in: nobody said yes on the tablet.`, usage: s.usage };
    if (isLimited) madeHere(s.target, { uses: asks });
    sessions.delete(id);
    return { ok: true, checked: true, text: s.summary || `${name} is ready.`, usage: s.usage, model: 'cloud', app: s.target };
  }

  /** The reviewer's findings for the app this request made or changed: up to 5 lines, [] for none. */
  async function secondLook(s, asked) {
    const dir = path.join(appsDir, s.target), tpl = s.fresh ? path.join(HERE, 'templates', s.kind) : null;
    const files = fs.readdirSync(dir).filter((f) => /\.(js|css|html|json)$/.test(f) && !(tpl && fs.existsSync(path.join(tpl, f)) && f !== 'main.js' && f !== 'app.css' && f !== 'app.json'))
      .map((f) => `---- ${f}\n${fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 60e3)}`).join('\n\n');
    const tools = [{ type: 'function', name: 'report', description: 'Your findings: each a concrete bug, in a line, with where it is. An empty list when there are none.',
      parameters: { type: 'object', required: ['bugs'], properties: { bugs: { type: 'array', items: { type: 'string' } } } } }];
    const instructions = `You check a small web app made for a household's kitchen tablet, before it goes in. Report only bugs that would stop it doing what was asked or break it: state that should be kept but isn't saved with the kit's store or isn't loaded back; something a person can't do on a touch screen (keys only, targets too small to tap); a game that can't be won, lost or restarted, or whose loop stops; wrong date or number logic; errors it will throw; for a change to an app, anything it broke there. Not style or taste. At most 5, the worst first. Call report once.${s.fresh && s.kind === 'game' ? ' The game runs on game.js, a tested engine (not shown): trust it.' : ''}`;
    const r = await review({ instructions, input: [{ role: 'user', content: `What was asked: "${String(asked || '').slice(0, 500)}"\n\nThe app's files:\n${files}` }], tools });
    const u = r.usage || {};
    s.usage.input_tokens += u.input_tokens || 0; s.usage.output_tokens += u.output_tokens || 0; s.usage.cached_tokens += u.cached_tokens || 0;
    const call = (r.output || []).find((o) => o.type === 'function_call' && o.name === 'report');
    let bugs = []; try { bugs = JSON.parse(call?.arguments || '{}').bugs || []; } catch {}
    return bugs.filter((b) => typeof b === 'string' && b.trim()).slice(0, 5).map((b) => b.trim().slice(0, 300));
  }

  /** One tool call, in this request's session [s]. Resolves { text, error?, content? }. */
  async function tool(s, name, a, { asked }) {
    const err = (text) => ({ text, error: true });
    const fileOf = (rel) => {
      const m = String(rel || '').replace(/^\/+/, '').match(/^apps\/([a-z0-9-]+)\/([^/]+)$/);
      if (!m) return null;
      return { app: m[1], name: m[2], file: path.join(appsDir, m[1], m[2]) };
    };
    switch (name) {
      case 'start': {
        if (s.target) return err(`You started ${s.target} already: this request is about that app.`);
        const app = String(a.app || '').toLowerCase();
        if (!ID.test(app) || app === 'home') return err('app: lowercase letters, digits and dashes ("dino-eggs"), and not home.');
        const exists = fs.existsSync(path.join(appsDir, app, 'index.html'));
        if (a.kind === 'change') {
          if (!exists) return err(`There's no app ${app}. These are there: ${appIds().join(', ')}.`);
          s.target = app; s.kind = 'change';
          show(app);
          return { text: `Changing ${app} ("${appName(app)}"). Its files:\n${fs.readdirSync(path.join(appsDir, app)).filter((f) => !f.startsWith('.')).join('\n')}\nRead what you change first.` };
        }
        if (!KINDS[a.kind]) return err('kind: "game", "tab" or "change".');
        if (exists || fs.existsSync(path.join(appsDir, app))) return err(`There's an app ${app} already: pick another id, or kind "change" to change it.`);
        const tpl = path.join(HERE, 'templates', KINDS[a.kind]);
        fs.mkdirSync(path.join(appsDir, app), { recursive: true });
        const nm = String(a.name || app.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())).replace(/\s+/g, ' ').trim().slice(0, 40);
        for (const f of fs.readdirSync(tpl)) fs.writeFileSync(path.join(appsDir, app, f), fs.readFileSync(path.join(tpl, f), 'utf8').replaceAll('NAME', nm.replace(/["\\]/g, '')));
        s.target = app; s.kind = a.kind; s.fresh = true;
        show(app);
        const own = a.kind === 'game' ? 'main.js (and icon.svg)' : 'main.js and app.css (and icon.svg)';
        return { text: `Made apps/${app} from the ${a.kind} template; it loads already. Its files: ${fs.readdirSync(path.join(appsDir, app)).join(', ')}. Read main.js${a.kind === 'game' ? ' and the top of game.js (the engine)' : ', app.css and kit/quiet.css\'s top comment'}, then write ${own}. index.html${a.kind === 'game' ? ' and game.js stay' : ' stays'} as they are.` };
      }
      case 'list_files': {
        if (!a.app) return { text: appIds().map((id) => `${id} ("${appName(id)}")`).join('\n') + '\nThe kit: kit/openhouse.js, kit/quiet.css, kit/openhouse.css' };
        const app = String(a.app);
        if (!ID.test(app) || !fs.existsSync(path.join(appsDir, app))) return err(`No app ${app}.`);
        return { text: fs.readdirSync(path.join(appsDir, app)).filter((f) => !f.startsWith('.')).map((f) => `${f} (${fs.statSync(path.join(appsDir, app, f)).size} bytes)`).join('\n') };
      }
      case 'read_file': {
        const rel = String(a.path || '').replace(/^\/+/, '');
        const kit = rel.match(/^kit\/(openhouse\.js|openhouse\.css|quiet\.css|narrow\.css)$/);
        const f = kit ? { file: path.join(HERE, 'kit', kit[1]) } : fileOf(rel);
        if (!f) return err('Only an app\'s files ("apps/<id>/main.js") or the kit\'s ("kit/openhouse.js").');
        if (!fs.existsSync(f.file) || fs.statSync(f.file).isDirectory()) return err(`No file ${rel}.`);
        const buf = fs.readFileSync(f.file);
        if (buf.length > 400e3 || buf.includes(0)) return err(`${rel} can't be read here.`);
        return { text: buf.toString('utf8') };
      }
      case 'write_file': case 'edit_file': {
        if (!s.target) return err('Call start first.');
        const f = fileOf(a.path);
        if (!f || f.app !== s.target) return err(`Only the app you started: apps/${s.target}/<file>.`);
        if (!FILE.test(f.name)) return err('A file name like main.js, app.css or icon.svg: no folders, only .js .css .html .json .svg.');
        if (s.fresh && (f.name === 'index.html' || (s.kind === 'game' && f.name === 'game.js'))) return err(`${f.name} comes from the template and stays as it is: write main.js${s.kind === 'tab' ? ' and app.css' : ''}.`);
        const was = fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : null;
        let next;
        if (name === 'edit_file') {
          if (was == null) return err(`No file ${a.path}.`);
          if (typeof a.old !== 'string' || !a.old || typeof a.new !== 'string') return err('old: text in the file now; new: what replaces it.');
          const count = was.split(a.old).length - 1;
          if (!count) return err(`${a.path} doesn't have that text (it must match exactly). read_file to see it as it is.`);
          if (count > 1) return err(`That text is in ${a.path} ${count} times: add more around it so it's unique.`);
          next = was.replace(a.old, () => a.new);
        } else {
          if (typeof a.content !== 'string') return err('content: the whole file, as text.');
          if (was == null && fs.readdirSync(path.join(appsDir, s.target)).length >= MAX_FILES) return err('That\'s enough files for one app.');
          next = a.content;
        }
        if (Buffer.byteLength(next) > MAX_FILE) return err('That file is too big: keep an app small.');
        if (f.name === 'app.json') {
          const m = metaOf(next), old = metaOf(was || '{}') || {};
          if (!m) return err('app.json must be a JSON object ({"name": ..., "kit": 1, ...}).');
          // What an app may do isn't the builder's to change: a new app may ask for groups (the card shows them), never websites.
          for (const k of GUARDED) {
            if (s.fresh && k === 'uses') { if (m.uses !== undefined && !(Array.isArray(m.uses) && m.uses.every((u) => USES.includes(u)))) return err(`uses: some of ${USES.join(', ')}; the card asks a parent.`); continue; }
            if (JSON.stringify(m[k]) !== JSON.stringify(old[k])) return err(`app.json's "${k}" stays as it was: what an app may do is the family's to grant, not part of this change.`);
          }
        }
        fs.writeFileSync(f.file, next);
        return { text: `${name === 'edit_file' ? 'Changed' : 'Wrote'} ${a.path}.` };
      }
      case 'check_build': {
        if (!s.target) return err('Call start first.');
        const problems = await staticCheck(appsDir, s.target);
        if (problems.length) return err(`Errors:\n${problems.join('\n')}`);
        const r = await checkBuild(s.target).catch(() => ({ ok: true }));
        return r.ok ? { text: 'It builds and loads without errors.' } : err(`Errors on the tablet:\n${r.errors}`);
      }
      case 'look_at_tablet': {
        const r = await look().catch(() => null);
        if (!r?.content) return err('The screen can\'t be seen right now.');
        // As the function's output: the picture and the screen's text (Responses: input_image / input_text items)
        const content = r.content.map((c) => (c.type === 'image' ? { type: 'input_image', image_url: `data:${c.mimeType || 'image/jpeg'};base64,${c.data}` } : { type: 'input_text', text: String(c.text || '') }));
        return { text: 'look', content };
      }
      case 'done': {
        if (!s.target) return err('Nothing was made: call start first.');
        const problems = await staticCheck(appsDir, s.target);
        if (problems.length) return err(`Not yet: fix these first.\n${problems.join('\n')}`);
        // A second look at the code, once, before it's done: what a picture can't show (state that isn't saved, a game
        // that can't end, input that can't work on a touch screen). Its findings go back to the builder to fix.
        if (review && !s.reviewed) {
          s.reviewed = true;
          const bugs = await secondLook(s, asked).catch(() => []);
          if (bugs.length) return err(`Not yet: a second look at the code found these. Fix the real ones (read the file first), check_build, then done again.\n${bugs.map((b) => `- ${b}`).join('\n')}`);
        }
        s.summary = String(a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        return { text: 'Done.' };
      }
    }
    return err(`No tool ${name}.`);
  }

  return { run };
}
