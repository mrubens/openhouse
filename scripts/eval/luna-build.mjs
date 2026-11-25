// Can OpenAI's cheap models build small OpenHouse apps with the workshop's tools? (docs/luna-build-eval.md)
//
// Runs each request in prompts.mjs against a local dev bridge (scripts/eval/run.sh starts one in a scratch folder),
// with the workshop's own tools over its MCP endpoint, in the cloud assistant's loop shape (bridge/agents/cloud.js):
// the Responses API, function calls, their outputs back in. check_build is the bridge's, plus the errors a headless
// Chrome load of the page threw (on the tablet a tab reports its own errors; a desktop check needs a browser).
//
//   OPENAI_API_KEY   from the environment only (run.sh loads it); never printed or written
//   BRIDGE           the dev bridge, http://127.0.0.1:5741
//   APP_DIR          its APP_DIR (a git repo): reset to the start after each run
//   PLAYWRIGHT       path to playwright-core's index.mjs (uses the installed Chrome)
//   OUT              folder for results.jsonl and each run's files and screenshot (outside the repo)
//   MODELS           gpt-6-luna,gpt-6.1-terra   ONLY  ids from prompts.mjs   VARIANT  plain | engine   CAP_CENTS 1000
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROMPTS } from './prompts.mjs';
import { pages } from './pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:5741';
const APP_DIR = process.env.APP_DIR;
const OUT = process.env.OUT;
const MODELS = (process.env.MODELS || 'gpt-6-luna,gpt-6.1-terra').split(',');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const VARIANT = process.env.VARIANT || 'plain';
const CAP = Number(process.env.CAP_CENTS || 1000);
const MAX_STEPS = Number(process.env.MAX_STEPS || 30);
// LOOK=1: the model also has look_at_tablet, the app it's working on as the family would see it (a tablet-size and a
// phone-size picture, the page's text and what it threw), instead of the tablet's screen (no device here).
const LOOK = process.env.LOOK === '1';
const LABEL = `${VARIANT}${LOOK ? '+look' : ''}`;
// List price, cents per million tokens.
const PRICE = { 'gpt-6-luna': { in: 10, cached: 1, out: 50 }, 'gpt-6.1-terra': { in: 100, cached: 5, out: 500 } };
if (!process.env.OPENAI_API_KEY || !APP_DIR || !OUT) { console.error('OPENAI_API_KEY, APP_DIR and OUT are needed (run.sh)'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', APP_DIR, '-c', 'user.name=eval', '-c', 'user.email=eval@local', ...a], { encoding: 'utf8' }).trim();

// ---- the bridge's workshop, over MCP
let rpcId = 0;
async function mcp(method, params = {}) {
  const r = await fetch(`${BRIDGE}/workshop/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const callTool = async (name, args) => { const r = await mcp('tools/call', { name, arguments: args }); return { text: (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError }; };
// The workshop's tools for making apps, as the task gives them: look_at_tablet only with LOOK (answered here), plus
// calendar_event (one request is the household's data, not code: the right tool is part of the test).
const KEEP = ['get_guide', 'start_editing', 'list_files', 'read_file', 'write_file', 'edit_file', 'check_build', ...(LOOK ? ['look_at_tablet'] : []), 'done_editing', 'calendar_event'];
const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eval', version: '0' } });
const all = (await mcp('tools/list')).tools;
const TOOLS = KEEP.map((n) => all.find((t) => t.name === n)).filter(Boolean).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }));
const ENGINE = VARIANT === 'engine' ? fs.readFileSync(path.join(HERE, '../../bridge/templates/game/game.js'), 'utf8') : ''; // the tablet's own game engine
const INSTRUCTIONS = `${init.instructions.split('\n').filter((l) => !l.startsWith('If you have the OpenHouse skills') && !l.startsWith('This OpenHouse')).join('\n')}
There is no one to ask while you work: make what was asked, check it, finish with done_editing, and stop. Don't ask whether to put a new app in the sidebar.${LOOK ? ' look_at_tablet shows the app you are changing, on the tablet and on a phone: look at it before done_editing and fix what looks wrong.' : ' look_at_tablet isn\'t available here.'}${VARIANT === 'engine' ? `

For a game: use the game engine, apps/<id>/game.js. Copy it into the new app's folder exactly as below with write_file, then write only index.html and main.js on top of it (main.js imports from './game.js'). Don't change game.js.
---- apps/<id>/game.js
${ENGINE}` : ''}`;

// ---- the apps' pages, and a headless Chrome load of one (pages.mjs)
const { load, close } = await pages({ BRIDGE, APP_DIR, LIBS: process.env.LIBS, PLAYWRIGHT: process.env.PLAYWRIGHT });

// ---- the model
// cents, all runs so far (results.jsonl keeps them across invocations, so the cap is the whole eval's)
let spent = (() => { try { return fs.readFileSync(path.join(OUT, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + JSON.parse(l).cents, 0); } catch { return 0; } })();
async function respond(model, input) {
  const body = { model, instructions: INSTRUCTIONS, input, tools: TOOLS, store: false, include: ['reasoning.encrypted_content'], ...(model.includes('terra') ? { reasoning: { effort: 'none' } } : {}) };
  for (let tries = 0; ; tries++) {
    // (a dropped connection is tried again too, as a 5xx is)
    const r = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300e3) }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    if ((r.status === 429 || r.status >= 500 || r.status === 0) && tries < 4) { await new Promise((s) => setTimeout(s, 5000 * (tries + 1))); continue; }
    throw new Error(`${r.status} ${j.error?.message || ''}`.trim());
  }
}
const cents = (model, u) => { const p = PRICE[model]; return ((u.input - u.cached) * p.in + u.cached * p.cached + u.output * p.out) / 1e6; };

async function run(model, pr) {
  const base = git('rev-parse', 'HEAD');
  const t0 = Date.now(), u = { input: 0, cached: 0, output: 0 }, calls = [], input = [{ role: 'user', content: `${pr.who}: ${pr.text}` }];
  let steps = 0, done = false, stop = null, last = '', looking = null; // looking: the app it last wrote or checked
  while (steps < MAX_STEPS) {
    if (spent + cents(model, u) > CAP) { stop = 'cap'; break; }
    let r;
    try { r = await respond(model, input); } catch (e) { stop = `api: ${e.message}`; break; }
    steps++;
    const us = r.usage || {};
    u.input += us.input_tokens || 0; u.cached += us.input_tokens_details?.cached_tokens || 0; u.output += us.output_tokens || 0;
    const out = r.output || [];
    input.push(...out);
    const fns = out.filter((o) => o.type === 'function_call');
    if (!fns.length) { last = out.filter((o) => o.type === 'message').flatMap((o) => o.content || []).map((c) => c.text || '').join(' ').slice(0, 300); break; }
    for (const c of fns) {
      let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch {}
      const touched = String(args.path || '').match(/^\/?apps\/([a-z0-9-]+)\//)?.[1] || (c.name === 'check_build' ? String(args.app || '') : null);
      if (touched && touched !== 'home') looking = touched;
      let pics = null;
      let res = c.name === 'look_at_tablet' && LOOK ? null : await callTool(c.name, args).catch((e) => ({ text: e.message, isError: true }));
      if (!res) { // look_at_tablet: the app it's changing, as the family would see it
        if (!looking || !fs.existsSync(path.join(APP_DIR, 'apps', looking, 'index.html'))) res = { text: 'Nothing you are changing is on the screen yet (write the app first).', isError: false };
        else {
          const tab = await load(looking, null, { picture: true }), ph = await load(looking, null, { picture: true, viewport: { width: 390, height: 844 } });
          const errs = [...new Set([...tab.errs, ...ph.errs])];
          res = { text: `apps/${looking} on the tablet (1536x864, first picture) and on a phone (390x844, second).\nText on the tablet: ${tab.text}${errs.length ? `\nIt threw:\n${errs.join('\n')}` : '\nNo errors.'}`, isError: false };
          pics = [tab.png, ph.png].filter(Boolean);
        }
      }
      if (c.name === 'check_build' && args.app && fs.existsSync(path.join(APP_DIR, 'apps', String(args.app), 'index.html'))) {
        const l = await load(String(args.app));
        if (l.errs.length) res = { text: `${res.isError ? res.text + '\n' : ''}Opened on the screen, it threw:\n${l.errs.join('\n')}`, isError: true };
      }
      if (c.name === 'done_editing') done = true;
      if (process.env.VERBOSE) console.error(`  ${model} ${pr.id} step ${steps}: ${c.name} ${args.path || args.app || args.topic || ''}${res.isError ? ' ERR ' + res.text.slice(0, 120).replace(/\n/g, ' ') : ''}`);
      calls.push({ name: c.name, path: args.path || args.app || args.topic || '', error: res.isError ? res.text.slice(0, 200) : undefined, bytes: args.content?.length, sig: c.arguments });
      input.push({ type: 'function_call_output', call_id: c.call_id, output: pics ? [{ type: 'input_text', text: res.text }, ...pics.map((b) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${b.toString('base64')}` }))] : res.text });
    }
    // Looping: the very same call (name and arguments) four times running.
    const sig = calls.slice(-4).map((c) => `${c.name}|${c.sig}|${c.error || ''}`);
    if (sig.length === 4 && new Set(sig).size === 1) { stop = 'loop'; break; }
  }
  if (steps >= MAX_STEPS && !stop) stop = 'steps';
  if (!done) await callTool('done_editing', { summary: 'eval: closed by the harness' }).catch(() => {});
  const ms = Date.now() - t0;
  // What it changed, and whether that loads clean.
  const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean).map((l) => l.slice(3));
  const files = [...new Set([...changed, ...dirty])];
  const apps = [...new Set(files.map((f) => f.match(/^apps\/([^/]+)\//)?.[1]).filter((a) => a && a !== 'home'))];
  const dir = path.join(OUT, LABEL, model, pr.id); fs.mkdirSync(dir, { recursive: true });
  const checks = {};
  for (const app of apps) {
    const cb = fs.existsSync(path.join(APP_DIR, 'apps', app, 'index.html')) ? await callTool('check_build', { app }) : { isError: true, text: 'no index.html' };
    const l = await load(app, path.join(dir, `${app}.png`));
    checks[app] = { build: cb.isError ? cb.text.slice(0, 300) : 'ok', errs: l.errs, text: l.text };
    fs.cpSync(path.join(APP_DIR, 'apps', app), path.join(dir, app), { recursive: true });
  }
  let event = null;
  if (pr.event) { const h = await (await fetch(`${BRIDGE}/house`)).json(); event = (h.events || []).filter((e) => /grandma/i.test(e.title || '')).map((e) => ({ title: e.title, start: e.start, countdown: e.countdown, repeat: e.repeat })); }
  const clean = apps.length > 0 && Object.values(checks).every((c) => c.build === 'ok' && !c.errs.length);
  const builds = pr.event ? (event?.length > 0 && (apps.length === 0 || clean)) : clean && (pr.kind !== 'edit' || apps.includes(pr.app));
  for (const c of calls) delete c.sig;
  const row = { variant: LABEL, model, id: pr.id, kind: pr.kind, builds, done, stop, steps, calls: calls.length, tokens: u, cents: +cents(model, u).toFixed(3), sec: Math.round(ms / 1000), apps, checks, event, last, trace: calls };
  spent += row.cents;
  fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify(row) + '\n');
  if (pr.event) { for (const e of (await (await fetch(`${BRIDGE}/house`)).json()).events || []) if (/grandma/i.test(e.title || '')) await fetch(`${BRIDGE}/house/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remove: e.id }) }).catch(() => {}); }
  git('reset', '-q', '--hard', base); git('clean', '-qfd');
  console.log(`${LABEL} ${model} ${pr.id}: ${builds ? 'BUILDS' : 'fails'}${stop ? ` (${stop})` : ''} steps ${steps} ${row.cents.toFixed(2)}c ${row.sec}s apps ${apps.join(',') || '-'}${Object.values(checks).some((c) => c.errs.length) ? ' errs: ' + Object.values(checks).flatMap((c) => c.errs).slice(0, 2).join(' | ') : ''}  [total ${spent.toFixed(1)}c]`);
  return row;
}

// CHECK=chores,lists: only load those apps and print what they threw (the harness's own baseline: the built-in apps load clean).
if (process.env.CHECK) { for (const a of process.env.CHECK.split(',')) console.log(a, JSON.stringify((await load(a)).errs)); await close(); process.exit(0); }
const prompts = PROMPTS.filter((p) => !ONLY || ONLY.has(p.id)).filter((p) => VARIANT !== 'engine' || p.kind === 'game');
outer: for (const pr of prompts) for (const model of MODELS) {
  if (spent > CAP) { console.log(`stopped: spent ${spent.toFixed(1)}c of the ${CAP}c cap`); break outer; }
  await run(model, pr);
}
await close();
console.log(`spent ${spent.toFixed(1)} cents`);
