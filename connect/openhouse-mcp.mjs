#!/usr/bin/env node
// Opie for Claude Code and Claude Desktop: a local MCP server (stdio) that pairs this computer with the family's
// tablet and then carries each MCP message to it, sealed with this computer's own key. The tools themselves run on
// the tablet (bridge/workshop.js); this only pairs and forwards. docs/workshop-mcp.md.
//
// Claude Desktop: the Opie extension (scripts/build-mcpb.sh bundles this file with what it imports). Claude Code:
//   claude mcp add openhouse -- npx openhouse-mcp          (or: node /path/to/openhouse/connect/openhouse-mcp.mjs)
//   openhouse-mcp pair K7QM-2XD9-HPA4      pair from a terminal instead ("192.168.1.23:8788 K7QM-2XD9-HPA4" if it
//                                          isn't found on the Wi-Fi by itself)
//   openhouse-mcp pair K7QM-2XD9-HPA4 --name "Claude on Sam's laptop"   from anywhere, through the cloud (the setup
//                                          page's prompt: a chat's sandbox, or away from home), else on the Wi-Fi
//   openhouse-mcp tools                    the tablet's tools, for an AI that can run commands but not add MCP servers
//   openhouse-mcp call get_guide '{"topic":"apps"}'   one of them
//   openhouse-mcp status | forget
//
// The pairing is kept in ~/.config/openhouse/pairing.json (OPENHOUSE_PAIRING to put it elsewhere), readable only by you.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import { pair as pairScreen, client as sealedClient, relayTokenOf, Removed } from '../chat/src/screen-client.js';
import { relayTransport } from '../chat/src/relay-client.js';
import { CP, b64 } from '../chat/src/seal.js';
import { pairingFromCode, cleanCode } from '../bridge/pair-code.js';
import { findTablets } from './mdns.mjs';

const FILE = process.env.OPENHOUSE_PAIRING || path.join(os.homedir(), '.config', 'openhouse', 'pairing.json');
const PORT = 8788;
// The cloud's relay (docs/networking.md): a code can be used from anywhere through it while the tablet has "Use it
// away from home" on. OPENHOUSE_RELAY_URL: another one (a local cloud, for trying it).
const RELAY = process.env.OPENHOUSE_RELAY_URL || 'wss://relay.openhouse.computer';

const load = () => { try { const p = JSON.parse(fs.readFileSync(FILE, 'utf8')); return (p.base || p.relay || p.tailnet) && p.id && p.key ? p : null; } catch { return null; } };
function save(p) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(p, null, 1), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}
const forget = () => { try { fs.rmSync(FILE); } catch {} };

function computerName() {
  if (process.env.OPENHOUSE_NAME) return process.env.OPENHOUSE_NAME.slice(0, 40);
  try { if (process.platform === 'darwin') return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim().slice(0, 40); } catch {}
  return os.hostname().replace(/\.local$/, '').replace(/[-_]+/g, ' ').slice(0, 40) || 'A computer';
}

/** What the person typed: "K7QM-2XD9-HPA4", or with the tablet's address ("192.168.1.23:8788 K7QM-2XD9-HPA4"), or its
 *  Tailscale address ("opie.tail1234.ts.net K7QM-2XD9-HPA4": https, through the household's own tailnet). */
export function parseInvite(text) {
  const s = String(text || '').trim();
  const ts = s.match(/(?:https:\/\/)?((?:[a-z0-9-]+\.)+ts\.net)(?::(\d{2,5}))?\/?/i);
  if (ts) {
    const code = (s.replace(ts[0], ' ').match(/[0-9A-Za-z]{4}[\s-]?[0-9A-Za-z]{4}[\s-]?[0-9A-Za-z]{4}/) || [])[0];
    return { base: `https://${ts[1].toLowerCase()}${ts[2] ? ':' + ts[2] : ''}`, code: cleanCode(code) };
  }
  const host = s.match(/(?:https?:\/\/)?((?:\d{1,3}\.){3}\d{1,3}|localhost|[a-z0-9-]+\.local)(?::(\d{2,5}))?/i);
  const rest = host ? s.replace(host[0], ' ') : s;
  const code = (rest.match(/[0-9A-Za-z]{4}[\s-]?[0-9A-Za-z]{4}[\s-]?[0-9A-Za-z]{4}/) || [])[0];
  return { base: host ? `http://${host[1]}:${host[2] || PORT}` : null, code: cleanCode(code) };
}

/** The pairing's two steps through the cloud's relay (as the web connector does them, openhouse-cloud connector.ts):
 *  hello, then wait for Allow. Resolves to the welcome; rejects at once when no tablet is showing the code there. */
async function relayPair({ pair, key, name, onAsked, signal }) {
  const te = new TextEncoder(), td = new TextDecoder(), k = b64.dec(key);
  const rt = relayTransport({ url: RELAY, pair });
  const step = async (p, body) => { const r = await rt.request({ p }, te.encode(JSON.stringify(body)), { signal }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };
  try {
    const box = CP.seal(k, crypto.getRandomValues(new Uint8Array(12)), te.encode(`hello:${pair}`), te.encode(JSON.stringify({ name })));
    let r = await step('hello', { box: b64.enc(box) });
    if (!r.ok) throw new Error('ended');
    onAsked?.();
    for (;;) {
      r = await step('wait', {});
      if (!r.ok) throw new Error('ended');
      if (r.j.waiting) { await new Promise((a) => setTimeout(a, 1500)); continue; }
      const opened = CP.open(k, te.encode(`welcome:${pair}`), b64.dec(r.j.box));
      if (!opened) throw new Error('ended');
      return JSON.parse(td.decode(opened));
    }
  } finally { rt.close(); }
}

/** The tablet's address over the household's Tailscale, as its welcome says (bridge/tailscale.js). */
const okTailnet = (t) => typeof t === 'string' && /^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(t);

const WHERE = 'On the tablet: the gear, then Screens and computers, then "A computer, to change the apps".';
let pending = null; // a pairing waiting for Allow on the tablet

/** Pair with the tablet's code (and its address, if it isn't found on the Wi-Fi). Resolves to a sentence for the person. */
async function doPair(code, address, { waitMs = 100e3, onAsked: told = () => {} } = {}) { // under Codex's 120 s for a tool call
  if (pending) return finishPending(waitMs);
  const inv = parseInvite(`${address || ''} ${code || ''}`);
  if (!inv.code) return { ok: false, text: `That doesn't look like the tablet's code: 12 letters and numbers, like K7QM-2XD9-HPA4. ${WHERE}` };
  const p = pairingFromCode(inv.code);
  // Where to ask: the address they gave, else every Opie answering on this Wi-Fi (only the one showing this code knows it).
  // A name (opie.local, answered only while the Connect screen shows) becomes the tablet's address now, so the
  // pairing keeps working after the screen closes.
  let named = null;
  if (inv.base && !/^http:\/\/[\d.]+:/.test(inv.base) && !inv.base.startsWith('https://')) {
    const u = new URL(inv.base);
    try { named = `http://${(await dns.promises.lookup(u.hostname, { family: 4 })).address}:${u.port || PORT}`; } catch {}
  }
  let bases = named ? [named] : inv.base && (!/[a-z]/i.test(new URL(inv.base).hostname) || inv.base.startsWith('https://')) ? [inv.base] : [];
  const name = computerName();
  // No address: through the cloud first (it works from anywhere, a chat's sandbox too), then the Wi-Fi.
  if (!inv.base && globalThis.WebSocket) {
    let asked = false;
    const stop = new AbortController();
    const promise = relayPair({ pair: p.pair, key: b64.enc(p.key), name, signal: stop.signal, onAsked: () => { asked = true; told(); } })
      .then(async (w) => {
        if (w.refused) return { ok: false, text: 'The tablet said no.' };
        if (!w.base && !w.relay && !okTailnet(w.tailnet)) return { ok: false, text: 'This Opie needs an update before it can be paired this way. Pair on its Wi-Fi instead.' };
        const relay = w.relay ? { url: RELAY, relay: w.relay.relay, token: await relayTokenOf(w.key) } : undefined;
        save({ base: w.base || null, ...(relay ? { relay } : {}), ...(okTailnet(w.tailnet) ? { tailnet: w.tailnet } : {}), id: w.id, key: w.key, name: w.name, paired: Date.now() });
        return { ok: true, text: `Paired: "${w.name}" can change this Opie now. Call get_guide before changing anything.` };
      })
      .catch((error) => ({ ok: false, asked, error }));
    const first = await Promise.race([promise, new Promise((r) => setTimeout(() => r(null), 10e3))]);
    const notThere = first && !first.ok && !first.asked && first.error; // no tablet showing the code there: the Wi-Fi next
    if (!first && !asked) stop.abort(); // no answer from the cloud at all: the Wi-Fi
    else if (!notThere) { pending = { promise: promise.then((r) => (r.error ? { ok: false, text: 'The pairing ended on the tablet. Start again there.' } : r)), name }; return finishPending(waitMs); }
  }
  if (!bases.length) bases = (await findTablets()).map((t) => `http://${t.address}:${t.port}`);
  if (!bases.length) return { ok: false, needAddress: true, text: 'I couldn\'t find the Opie through the cloud or on this Wi-Fi. Through the cloud, the tablet needs "Use it away from home" on (its Cloud settings). Is "A computer, to change the apps" open on the tablet? Its name and code only work while that screen shows. If it is, ask for the address shown under the name (like 192.168.1.23:8788) and pair again with both. This computer has to be on the same Wi-Fi as the tablet.' };
  for (const base of bases) {
    let asked = false;
    const promise = pairScreen({ base, pair: p.pair, key: b64.enc(p.key), name, onAsked: () => { asked = true; told(); } })
      .then((w) => {
        if (w.refused) return { ok: false, text: 'The tablet said no.' };
        save({ base, ...(okTailnet(w.tailnet) && w.tailnet !== base ? { tailnet: w.tailnet } : {}), id: w.id, key: w.key, name: w.name, paired: Date.now() });
        return { ok: true, text: `Paired: "${w.name}" can change this Opie now. Call get_guide before changing anything.` };
      })
      .catch((e) => ({ ok: false, asked, error: e }));
    // The tablet answers the hello at once: wait for that much, then (if it knew the code) for Allow.
    const first = await Promise.race([promise, new Promise((r) => setTimeout(() => r(null), 4000))]);
    if (first && !first.ok && !first.asked && first.error) continue; // not this tablet (or not reachable): the next one
    pending = { promise: promise.then((r) => (r.error ? { ok: false, text: 'The pairing ended on the tablet. Start again there.' } : r)), name };
    return finishPending(waitMs);
  }
  return { ok: false, text: inv.base ? `The Opie at ${inv.base} didn't take that code: it may have run out (10 minutes) or been mistyped. ${WHERE}` : `No Opie on this Wi-Fi is showing that code: it may have run out (10 minutes) or been mistyped. ${WHERE}` };
}
async function finishPending(waitMs) {
  const { promise, name } = pending;
  const r = await Promise.race([promise, new Promise((res) => setTimeout(() => res(null), waitMs).unref())]);
  if (!r) return { ok: false, waiting: true, text: `The tablet is asking whether to let "${name}" in: tap Allow there, then ask me to pair again.` };
  pending = null;
  if (r.ok) connect();
  return r;
}

// ---- the sealed link to the tablet ----
let link = null; // { pairing, c }
// Away from home (docs/networking.md): once the tablet says so, requests that can't reach the home network go through
// the cloud's relay, sealed the same way. The relay's address and this computer's token come from the tablet and are
// kept with the pairing (OPENHOUSE_RELAY_URL: another address for the same relay, for trying it out).
function connect() {
  const p = load();
  const relay = p?.relay ? { ...p.relay, ...(process.env.OPENHOUSE_RELAY_URL ? { url: process.env.OPENHOUSE_RELAY_URL } : {}) } : null;
  // And over the household's own Tailscale (bridge/tailscale.js), when the tablet has it on: tried after the Wi-Fi, before the relay.
  const keep = (k) => (v) => { const now = load(); if (now?.id === p.id) save({ ...now, [k]: v || undefined }); };
  link = p ? { pairing: p, c: sealedClient({ base: p.base || '', onlyRelay: !p.base, id: p.id, key: p.key, relay, onRelay: keep('relay'), tailnet: okTailnet(p.tailnet) ? p.tailnet : null, onTailnet: keep('tailnet') }) } : null;
  return link;
}
connect();

/** One MCP message to the tablet: its JSON-RPC reply. Throws Removed when the tablet removed this computer. */
async function toTablet(msg, { timeoutMs = 175e3 } = {}) {
  if (!link) throw new Error('not paired');
  const r = await link.c.json('POST', '/workshop/mcp', msg, { signal: AbortSignal.timeout(timeoutMs) });
  if (r.status !== 200 || !r.json) throw new Error(r.json?.error || `the tablet answered ${r.status}`);
  return r.json;
}

// ---- the MCP server Claude talks to (stdio, one JSON message per line) ----
const PAIR_TOOL = { name: 'pair_with_tablet', description: `Pair this computer with the family's Opie tablet, once. Ask the person for the code their tablet shows (${WHERE.replace('On the tablet: ', '')}). It finds the tablet on the Wi-Fi by itself; pass address too only if it couldn't. Then someone taps Allow on the tablet.`,
  inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string', description: 'The 12-character code, like K7QM-2XD9-HPA4' }, address: { type: 'string', description: 'Only if asked for: the address shown above the code, like 192.168.1.23:8788' } } } };
// Clients that list tools once, at start (Codex, today), never see the tablet's tools appear after pairing: until
// they start again, they reach them through this one.
const USE_TOOL = { name: 'use_tablet_tool', description: 'Only if the Opie\'s own tools (get_guide, set_home, write_file...) aren\'t in your tool list after pairing: call one of them by name. pair_with_tablet\'s answer lists them.',
  inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, arguments: { type: 'object' } } } };
/** The tablet's tools in a line each, for clients that can't see them yet. */
async function toolLines() {
  try { const r = await toTablet({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { timeoutMs: 8e3 }); return (r.result?.tools || []).map((t) => `- ${t.name}: ${String(t.description || '').split(/(?<=\.)\s/)[0]} Arguments: ${JSON.stringify(t.inputSchema?.properties || {})}`).join('\n'); } catch { return ''; }
}
const FORGET_TOOL = { name: 'forget_tablet', description: 'Unpair this computer from the Opie (only when asked). The tablet can remove it too (Screens, in its Tablet settings).', inputSchema: { type: 'object', properties: {} } };
const LOCAL_INSTRUCTIONS = `Opie is a family's kitchen tablet whose apps and home screen these tools change. This computer isn't paired with it yet (or can't reach it). To pair, ask the person for the code the tablet shows (${WHERE.replace('On the tablet: ', 'on the tablet: ')}) and call pair_with_tablet with it. Once paired, call get_guide before changing anything.`;

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
const unreachable = (e) => e instanceof Removed
  ? 'The tablet removed this computer. Ask for a new code and pair again. ' + WHERE + ''
  : /brain said 503/.test(e.message) && link?.c.where() === 'away'
    ? 'The Opie isn\'t connected to the internet right now (this computer is away from its Wi-Fi, so it goes through Opie\'s relay). Is the tablet on?'
    : `Can't reach the Opie${link?.pairing.base ? ` at ${link.pairing.base}` : ''} right now (${e.cause?.code || (e.name === 'TimeoutError' ? 'no answer' : e.message)}). Is it on, and this computer on the same Wi-Fi? ${link?.pairing.relay ? '' : 'To reach it from anywhere, turn on "Use it away from home" on the tablet (its Cloud settings), then use this once on the Wi-Fi. '}If its address changed, pair again.`;
let serving = false;
function lost(e) { if (e instanceof Removed) { forget(); link = null; if (serving) out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); } }

// MCP 2026-07-28 (stateless, a _meta on every request; skills need it) as well as the initialize kind: a request
// with the _meta is answered in that revision, and passed on to the tablet as it is (bridge/workshop.js serves both).
const MODERN = ['2026-07-28'];
const VERSION = 'io.modelcontextprotocol/protocolVersion';
// The answers made here are about this computer's pairing, which changes: never cached.
const HINTS = { 'server/discover': 1, 'tools/list': 1, 'resources/list': 1, 'resources/read': 1, 'prompts/list': 1, 'resources/templates/list': 1, 'skills/list': 1, 'skills/get': 1 };

async function handle(msg) {
  const p = msg.params || {};
  const modern = p._meta?.[VERSION] != null;
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...(HINTS[msg.method] ? { ttlMs: 0, cacheScope: 'private' } : {}), ...result } : result });
  const fail = (code, message, data) => out({ jsonrpc: '2.0', id: msg.id, error: { code, message, ...(data ? { data } : {}) } });
  if (msg.id == null) return; // notifications
  if (modern && !MODERN.includes(p._meta[VERSION])) return fail(-32022, 'Unsupported protocol version', { supported: [...MODERN, '2025-11-25', '2025-06-18'], requested: p._meta[VERSION] });
  switch (msg.method) {
    case 'server/discover': {
      // The tablet's own answer when it's reached (its skills, if it has them); this computer's otherwise.
      let r = null;
      if (link && modern) try { r = (await toTablet(msg, { timeoutMs: 5e3 })).result || null; } catch (e) { lost(e); }
      if (!r && link) try { const i = (await toTablet({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openhouse-mcp', version: '0.1' } } }, { timeoutMs: 5e3 })).result; if (i) r = { instructions: i.instructions }; } catch (e) { lost(e); } // a tablet from before 2026-07-28
      return reply({ supportedVersions: MODERN, ...(r || {}), capabilities: { ...(r?.capabilities || {}), tools: { listChanged: true }, resources: {} }, instructions: r?.instructions || LOCAL_INSTRUCTIONS, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'openhouse', version: '0.1' } }, ttlMs: 0, cacheScope: 'private' });
    }
    case 'skills/list': case 'skills/get': {
      // The tablet's guide as skills (bridge/workshop-guide.js). None before pairing, or from a tablet without them.
      const none = () => msg.method === 'skills/list' ? reply({ skills: [] }) : fail(-32602, 'no such skill');
      if (!link) return none();
      try { const r = await toTablet(msg, { timeoutMs: 15e3 }); return r.error ? (r.error.code === -32601 ? none() : fail(r.error.code, r.error.message)) : reply(r.result); }
      catch (e) { lost(e); return msg.method === 'skills/list' ? reply({ skills: [] }) : fail(-32603, unreachable(e)); }
    }
    case 'initialize': {
      let instructions = LOCAL_INSTRUCTIONS;
      if (link) try { instructions = (await toTablet({ jsonrpc: '2.0', id: 1, method: 'initialize', params: p }, { timeoutMs: 5e3 })).result?.instructions || instructions; } catch (e) { lost(e); }
      return reply({ protocolVersion: p.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: 'openhouse', version: '0.1' }, instructions });
    }
    case 'ping': return reply({});
    case 'tools/list': {
      if (!link) return reply({ tools: [PAIR_TOOL, USE_TOOL] });
      try { const r = await toTablet(msg, { timeoutMs: 8e3 }); return reply({ tools: [...(r.result?.tools || []), FORGET_TOOL, PAIR_TOOL] }); }
      catch (e) { lost(e); return reply({ tools: [PAIR_TOOL, FORGET_TOOL] }); }
    }
    case 'tools/call': {
      if (p.name === PAIR_TOOL.name) {
        const r = await doPair(p.arguments?.code, p.arguments?.address);
        if (!r.ok) return reply(text(r.text, !r.waiting));
        out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        const lines = await toolLines();
        return reply(text(r.text + (lines ? `\n\nThe Opie's tools. If they aren't in your tool list yet, call them through use_tablet_tool {name, arguments}:\n${lines}` : '')));
      }
      if (p.name === USE_TOOL.name) {
        if (!link) return reply(text('Not paired with an Opie yet: ask for the tablet\'s code and use pair_with_tablet.', true));
        msg.params = { name: String(p.arguments?.name || ''), arguments: p.arguments?.arguments || {} };
      }
      if (p.name === FORGET_TOOL.name) { forget(); link = null; out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); return reply(text('Unpaired. (The tablet still lists this computer until someone removes it in Settings > Screens.)')); }
      if (!link) return reply(text('Not paired with an Opie yet: ask for the tablet\'s code and use pair_with_tablet.', true));
      try { const r = await toTablet(msg); return r.error ? fail(r.error.code, r.error.message) : reply(r.result); }
      catch (e) { lost(e); return reply(text(unreachable(e), true)); }
    }
    case 'resources/list': case 'resources/read': {
      if (!link) return msg.method === 'resources/list' ? reply({ resources: [] }) : fail(-32602, 'not paired');
      try { const r = await toTablet(msg, { timeoutMs: 15e3 }); return r.error ? fail(r.error.code, r.error.message) : reply(r.result); }
      catch (e) { lost(e); return msg.method === 'resources/list' ? reply({ resources: [] }) : fail(-32603, unreachable(e)); }
    }
    case 'prompts/list': return reply({ prompts: [] });
  }
  fail(-32601, 'method not found');
}

function serve() {
  serving = true;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (l) => { if (!l.trim()) return; let m; try { m = JSON.parse(l); } catch { return; } handle(m).catch((e) => m.id != null && out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } })); });
  rl.on('close', () => process.exit(0));
}

const [cmd, ...rest] = process.argv.slice(2);
/** A tool's answer, for a terminal: its text, and any picture saved to a file (its path printed). */
function printResult(r) {
  for (const c of r?.content || []) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image' && c.data) {
      const f = path.join(path.dirname(FILE), `look-${Date.now()}.${/jpe?g/.test(c.mimeType || '') ? 'jpg' : 'png'}`);
      fs.writeFileSync(f, Buffer.from(c.data, 'base64')); console.log(`(picture: ${f})`);
    }
  }
}
if (cmd === 'pair') { // from a terminal (the setup page's prompt): pair now, so the AI has the tools from then on
  const at = rest.indexOf('--name');
  if (at >= 0) { process.env.OPENHOUSE_NAME = String(rest[at + 1] || '').trim() || ''; rest.splice(at, 2); }
  console.log('Looking for your Opie…');
  const r = await doPair(rest.join(' '), rest.join(' '), { waitMs: 10 * 60e3, onAsked: () => console.log('Now tap Allow on the tablet.') });
  const me = process.argv[1];
  console.log(r.ok ? `Paired. Add it as an MCP server (command: node ${me}), or use it from here: node ${me} tools, then node ${me} call get_guide '{}'.` : r.text);
  process.exit(r.ok ? 0 : 1);
}
else if (cmd === 'tools' || cmd === 'call') { // for an AI that can run commands but not add an MCP server (a chat's sandbox)
  if (!link) { console.log('Not paired. Pair first: node ' + process.argv[1] + ' pair <the code on the tablet>'); process.exit(1); }
  try {
    if (cmd === 'tools') {
      const r = await toTablet({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { timeoutMs: 20e3 });
      for (const t of r.result?.tools || []) console.log(`${t.name}: ${t.description || ''}\n  arguments: ${JSON.stringify(t.inputSchema?.properties || {})}${t.inputSchema?.required?.length ? ` (required: ${t.inputSchema.required.join(', ')})` : ''}\n`);
    } else {
      let args = {}; try { args = rest[1] ? JSON.parse(rest[1]) : {}; } catch { console.log('The arguments are JSON, like \'{"topic":"apps"}\'.'); process.exit(1); }
      const r = await toTablet({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: String(rest[0] || ''), arguments: args } });
      if (r.error) { console.log(r.error.message); process.exit(1); }
      printResult(r.result);
      process.exit(r.result?.isError ? 1 : 0);
    }
  } catch (e) { lost(e); console.log(unreachable(e)); process.exit(1); }
  process.exit(0);
}
else if (cmd === 'status') { const p = load(); console.log(p ? `Paired with ${p.base || 'the Opie, through the cloud'} as "${p.name}".` : 'Not paired.'); }
else if (cmd === 'forget') { forget(); console.log('Unpaired.'); }
else serve();
