// The tablet's own builder, end to end (bridge/rails.js, docs/building-on-the-tablet.md): each request in prompts.mjs
// goes to the dev bridge's POST /request as the tablet's assistant sends it, and the bridge's builder makes it with the
// cloud's text model on rails. The cloud is a stand-in here, on this machine: its /v1/ai/respond forwards to OpenAI
// with the key from the environment (never the production service, which would bill a household's allowance).
// Then the same checks as luna-build.mjs: what it changed loads in headless Chrome without errors.
//
//   run.sh <scratch> SCRIPT=rails-e2e.mjs [MODEL=gpt-6-luna] [ONLY=...]   (run.sh sets BRIDGE, APP_DIR, DISPLAY, OUT...)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { PROMPTS } from './prompts.mjs';
import { pages } from './pages.mjs';

const { BRIDGE, APP_DIR, OUT, DISPLAY } = process.env;
const MODEL = process.env.MODEL || 'gpt-6-luna';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const CAP = Number(process.env.CAP_CENTS || 1000);
const PRICE = { 'gpt-6-luna': { in: 10, cached: 1, out: 50 }, 'gpt-6.1-terra': { in: 100, cached: 5, out: 500 } };
if (!process.env.OPENAI_API_KEY || !APP_DIR || !OUT || !DISPLAY) { console.error('OPENAI_API_KEY, APP_DIR, DISPLAY and OUT are needed (run.sh)'); process.exit(1); }
const git = (...a) => execFileSync('git', ['-C', APP_DIR, '-c', 'user.name=eval', '-c', 'user.email=eval@local', ...a], { encoding: 'utf8' }).trim();
fs.mkdirSync(OUT, { recursive: true });

// ---- the stand-in cloud: /v1/ai/respond as the service answers it (lambda/app.ts aiRespond), the usage counted here
let usage = { input: 0, cached: 0, output: 0, calls: 0 }, decisions = [];
// TYPED=1: each request is typed to the tablet's assistant (POST /chat), which decides whether it's a build.
const TYPED = process.env.TYPED === '1';
const cloud = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const b = (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; } })();
  if (req.method === 'POST' && req.url === '/v1/decide') { // the typed assistant's first question (OpenAI Decisions, as the service asks it)
    const r = await fetch('https://api.openai.com/v1/decisions', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-luna', input: b.input, questions: b.questions }), signal: AbortSignal.timeout(20e3) }).catch(() => null);
    const j = await r?.json().catch(() => ({})) || {};
    usage.decideIn = (usage.decideIn || 0) + (j.usage?.input_tokens || 0); decisions.push(j.answers?.[0] || null);
    res.writeHead(r?.ok ? 200 : 502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ answers: j.answers || [] })); return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/ai/respond') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not here"}'); return; }
  // A reviewer's call (rails.js secondLook, role review) on REVIEW_MODEL, else the builder's model.
  const model = b.role === 'review' && process.env.REVIEW_MODEL ? process.env.REVIEW_MODEL : MODEL;
  if (b.role === 'review') usage.reviews = (usage.reviews || 0) + 1;
  const body = { model, instructions: b.instructions, input: b.input, tools: b.tools, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 16000, ...(model.includes('terra') ? { reasoning: { effort: 'none' } } : {}) };
  const t0 = Date.now();
  for (let tries = 0; ; tries++) {
    const r = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300e3) }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok && (r.status === 429 || r.status >= 500 || r.status === 0) && tries < 4) { await new Promise((s) => setTimeout(s, 5000 * (tries + 1))); continue; }
    if (!r.ok) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: j.error?.message || `openai ${r.status}` })); return; }
    const u = j.usage || {};
    usage.slowestMs = Math.max(usage.slowestMs || 0, Date.now() - t0); // (the service's HTTP API stops a call at 30 s)
    if (model !== MODEL) { usage.rIn = (usage.rIn || 0) + (u.input_tokens || 0); usage.rCached = (usage.rCached || 0) + (u.input_tokens_details?.cached_tokens || 0); usage.rOut = (usage.rOut || 0) + (u.output_tokens || 0); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output: j.output || [], usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cached_tokens: u.input_tokens_details?.cached_tokens || 0 } })); return; }
    usage.input += u.input_tokens || 0; usage.cached += u.input_tokens_details?.cached_tokens || 0; usage.output += u.output_tokens || 0; usage.calls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: j.output || [], usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cached_tokens: u.input_tokens_details?.cached_tokens || 0 } }));
    return;
  }
});
await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
fs.mkdirSync(path.join(DISPLAY, '.cloud'), { recursive: true });
fs.writeFileSync(path.join(DISPLAY, '.cloud', 'device.json'), JSON.stringify({ api: `http://127.0.0.1:${cloud.address().port}`, credential: 'eval' }));

const view = await pages({ BRIDGE, APP_DIR, LIBS: process.env.LIBS, PLAYWRIGHT: process.env.PLAYWRIGHT });

// LOOK=1: a stand-in for the shell's device server (Device control on), whose look is a picture of the screen. While
// the builder works, the shell shows the app being made (it opens it as it's written), so the picture is that app.
const LOOK = process.env.LOOK === '1', DEVICE_CONFIG = path.join(APP_DIR, '../device-mcp.json');
let device = null, cards = [], looks = 0;
fs.rmSync(DEVICE_CONFIG, { force: true });
if (LOOK) {
  const newest = () => { let best = null; for (const d of fs.readdirSync(path.join(APP_DIR, 'apps'))) { if (d === 'home') continue; const m = Math.max(...fs.readdirSync(path.join(APP_DIR, 'apps', d)).map((f) => fs.statSync(path.join(APP_DIR, 'apps', d, f)).mtimeMs)); if (!best || m > best.m) best = { d, m }; } return best?.d; };
  device = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: b.id ?? 1, result })); };
    // The approval card (shell-call.js toShell /approve): kept for the report, and a parent's yes.
    if (req.url.endsWith('/approve')) { cards.push({ title: b.title, detail: b.detail, pin: b.pin, rights: b.rights }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"yes":true}'); return; }
    if (b.method !== 'tools/call' || b.params?.name !== 'look') return reply({});
    const app = newest(); looks++;
    if (!app) return reply({ content: [{ type: 'text', text: 'The home screen.' }] });
    const l = await view.load(app, null, { picture: true });
    reply({ content: [{ type: 'image', mimeType: 'image/jpeg', data: l.png?.toString('base64') || '' }, { type: 'text', text: `On the screen: ${l.text}${l.errs.length ? `\nThe page threw: ${l.errs.join(' | ')}` : ''}` }] });
  });
  await new Promise((r) => device.listen(0, '127.0.0.1', r));
  fs.writeFileSync(DEVICE_CONFIG, JSON.stringify({ mcpServers: { device: { url: `http://127.0.0.1:${device.address().port}/mcp`, headers: { Authorization: 'Bearer eval' } } } }));
}
const cents = (u) => { const p = PRICE[MODEL], q = PRICE[process.env.REVIEW_MODEL || MODEL];
  return ((u.input - u.cached) * p.in + u.cached * p.cached + u.output * p.out + ((u.rIn || 0) - (u.rCached || 0)) * q.in + (u.rCached || 0) * q.cached + (u.rOut || 0) * q.out) / 1e6; };
let spent = (() => { try { return fs.readFileSync(path.join(OUT, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + JSON.parse(l).cents, 0); } catch { return 0; } })();

/** Until the builder is idle again after working: { ok (it kept a change), text (its last words, from /state) }. */
async function untilDone(base, ms = 8 * 60e3) {
  const t0 = Date.now(); let seen = false, st = null;
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 1500));
    st = await (await fetch(`${BRIDGE}/state`)).json().catch(() => null);
    if (st?.state === 'working') seen = true;
    else if (seen || Date.now() - t0 > 20e3) break;
  }
  // Its last words to the family: the bridge's log of the builder's done (run.sh keeps it next to APP_DIR).
  let said = ''; try { said = (fs.readFileSync(path.join(APP_DIR, '../bridge.log'), 'utf8').match(/^\[done\] .*$/gm) || []).pop()?.slice(7) || ''; } catch {}
  const ok = git('rev-parse', 'HEAD') !== base;
  return { ok, text: seen ? said : '' }; // (no build: no words of its own)
}

for (const pr of PROMPTS.filter((p) => (TYPED || !p.event) && (!ONLY || ONLY.has(p.id)))) {
  if (spent > CAP) { console.log(`stopped: ${spent.toFixed(1)}c of the ${CAP}c cap`); break; }
  const base = git('rev-parse', 'HEAD'), t0 = Date.now();
  usage = { input: 0, cached: 0, output: 0, calls: 0 }; cards = []; looks = 0; decisions = [];
  let answer = null;
  if (TYPED) { // the assistant's whole answer (ndjson until done), then the build it started, if it did
    const r = await fetch(`${BRIDGE}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: pr.text, who: pr.who, ...(pr.app ? { app: pr.app } : {}) }) });
    const lines = (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    answer = lines.filter((e) => e.type === 'done').pop()?.text || '';
  } else await fetch(`${BRIDGE}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: pr.text, who: pr.who, ...(pr.app ? { app: pr.app } : {}) }) });
  const done = await untilDone(base);
  const sec = Math.round((Date.now() - t0) / 1000);
  const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const apps = [...new Set(changed.map((f) => f.match(/^apps\/([^/]+)\//)?.[1]).filter((a) => a && a !== 'home'))];
  const dir = path.join(OUT, `${TYPED ? 'typed' : 'rails'}${LOOK ? '+look' : ''}${process.env.REVIEW_MODEL ? '+review' : ''}`, MODEL, pr.id); fs.mkdirSync(dir, { recursive: true });
  const checks = {};
  for (const app of apps) {
    if (!fs.existsSync(path.join(APP_DIR, 'apps', app))) continue;
    const l = await view.load(app, path.join(dir, `${app}.png`));
    checks[app] = { errs: l.errs, text: l.text };
    fs.cpSync(path.join(APP_DIR, 'apps', app), path.join(dir, app), { recursive: true });
  }
  const limited = changed.some((f) => f.startsWith('plugins/')) && /"limited":\s*true/.test(execFileSync('git', ['-C', APP_DIR, 'show', 'HEAD', '--', 'plugins'], { encoding: 'utf8' }));
  const builds = pr.event ? !apps.length : !!done?.ok && apps.length > 0 && Object.values(checks).every((c) => !c.errs.length) && (pr.kind !== 'edit' || apps.includes(pr.app));
  const label = `${TYPED ? 'typed' : 'rails'}${LOOK ? '+look' : ''}${process.env.REVIEW_MODEL ? `+review-${process.env.REVIEW_MODEL.includes('terra') ? 'terra' : 'luna'}` : ''}`;
  const row = { variant: label, answer, route: decisions[0] || null, model: MODEL, id: pr.id, kind: pr.kind, builds, ok: !!done?.ok, text: done?.text || '(no answer)', steps: usage.calls, tokens: { input: usage.input, cached: usage.cached, output: usage.output }, cents: +cents(usage).toFixed(3), sec, slowestCallS: +((usage.slowestMs || 0) / 1000).toFixed(1), reviews: usage.reviews || 0, apps, limited, checks, cards, looks };
  spent += row.cents;
  fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify(row) + '\n');
  console.log(`${label} ${MODEL} ${pr.id}: ${builds ? 'BUILDS' : 'fails'} ${row.ok ? '' : `(${row.text.slice(0, 80)}) `}${TYPED ? `route ${decisions[0]?.choice ?? '-'} ${decisions[0]?.confidence ?? ''} answer "${String(answer || '').slice(0, 70)}" ` : ''}calls ${usage.calls}${LOOK ? ` looks ${looks}` : ''} ${row.cents.toFixed(2)}c ${sec}s apps ${apps.join(',') || '-'}${limited ? ' limited' : ''}${Object.values(checks).some((c) => c.errs.length) ? ' errs: ' + Object.values(checks).flatMap((c) => c.errs).slice(0, 2).join(' | ') : ''}  [total ${spent.toFixed(1)}c]`);
  // Back to the start for the next request (the bridge's own commit included).
  git('reset', '-q', '--hard', base); git('clean', '-qfd');
}
await view.close(); cloud.close(); device?.close(); fs.rmSync(DEVICE_CONFIG, { force: true });
console.log(`spent ${spent.toFixed(1)} cents`);
