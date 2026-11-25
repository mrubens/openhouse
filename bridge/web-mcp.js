// The tablet's own connector for Claude, ChatGPT or any AI, with no OpenHouse cloud (docs/web-chat-building.md,
// "Your own address"): the same OAuth sign-in and MCP as the cloud's connector (openhouse-cloud/lambda/connector.ts), served by
// the bridge itself on a listener of its own (WEB_MCP_PORT, 8789) that a household's networking makes public over
// https: a Tailscale Funnel, a Cloudflare Tunnel, or their own address and reverse proxy pointing at the tablet.
// Off until someone turns it on with that address (Settings' Connect screen). Nothing else is on that
// listener: no screens, no pairing routes, no files.
//
// Signing in is pairing, as with the cloud: the page asks for the code the tablet shows for "A computer, to change
// the apps", the tablet asks someone to Allow, and the connector becomes a paired computer (Screens lists it,
// removing it ends it at once). Here the key never leaves the tablet: MCP calls go straight to the workshop as that
// computer. Tokens are kept only as hashes.
//
// The display's own (loopback, its secret):
//   GET  /webmcp            {on, url, port, listening}
//   POST /webmcp {on, url}  on with the household's https address (e.g. https://kitchen.tail1234.ts.net), or off
// The public listener:
//   GET  /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server
//   POST /oauth/register  GET /oauth/authorize  POST /oauth/pair {sid, code}  POST /oauth/wait {sid}  POST /oauth/token
//   POST /mcp             MCP (JSON answers), Bearer token
import http from 'node:http';
import fs from 'node:fs';
import { guarded } from './guarded.js';
import { readJson, writeJson } from './store.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { pairingFromCode } from './pair-code.js';
import { seal, open } from './screens.js';

/** Where Claude and ChatGPT send people back after signing in (as connector.ts), and localhost for tests. */
export const REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com'];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;
const ACCESS_SECS = 24 * 3600;
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const okUrl = (u) => /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(String(u || ''));

export function webMcpRoutes({ HERE, screens, workshop, json, body, PORT = Number(process.env.WEB_MCP_PORT || 8789), HOST = process.env.WEB_MCP_HOST || '0.0.0.0', FILE = path.join(HERE, 'web-mcp.json'), now = Date.now, fetchFn = fetch }) {
  const st = readJson(FILE, null, { bak: false }) || {}; // (no .bak: a grant taken back must not come back)
  st.clients ||= {}; st.grants ||= {};
  const save = () => writeJson(FILE, st, { bak: false, mode: 0o600 });
  const secs = () => Math.floor(now() / 1000);
  const base = () => String(st.url || '').replace(/\/+$/, '');
  const hosts = () => [...REDIRECT_HOSTS, ...(Array.isArray(st.hosts) ? st.hosts : [])];
  const sessions = new Map(); // sid -> {client, name, redirect, challenge, state, pair?, key?, until}
  const tries = new Map(); // address -> {n, since}: code tries a minute

  function who(redirect) {
    if (LOCAL.test(redirect)) return 'A test app on this computer';
    let u; try { u = new URL(redirect); } catch { return null; }
    if (u.protocol !== 'https:' || !hosts().some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return null;
    return /claude/.test(u.hostname) ? 'Claude' : /chatgpt|openai/.test(u.hostname) ? 'ChatGPT' : u.hostname;
  }
  async function client(id) {
    if (/^https:\/\//.test(id)) { // a client-ID metadata document (CIMD), at an address we know
      let u; try { u = new URL(id); } catch { return null; }
      if (!hosts().some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return null;
      try {
        const r = await fetchFn(id, { signal: AbortSignal.timeout(5e3), headers: { accept: 'application/json' } });
        const d = await r.json();
        if (!r.ok || d.client_id !== id || !Array.isArray(d.redirect_uris)) return null;
        return { id, redirects: d.redirect_uris.filter((x) => typeof x === 'string' && who(x)) };
      } catch { return null; }
    }
    const c = st.clients[id];
    return c ? { id, redirects: c.redirects, secretHash: c.secretHash } : null;
  }

  function grantOf(token, kind) {
    const m = /^ohl([ar])_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/.exec(String(token || ''));
    if (!m || m[1] !== kind) return null;
    const g = st.grants[m[2]];
    if (!g || !(kind === 'a' ? g.access : g.refresh).some((x) => x.h === sha(m[3]) && x.until > secs())) return null;
    return { id: m[2], g, part: m[3] };
  }
  function issue(id, usedRefresh = null) {
    const g = st.grants[id], a = rnd(16), r = rnd(16);
    g.access = [...g.access.filter((x) => x.until > secs()).slice(-1), { h: sha(a), until: secs() + ACCESS_SECS }];
    g.refresh = [...(usedRefresh ? [{ h: sha(usedRefresh), until: secs() + 60 }] : []), { h: sha(r), until: secs() + 365 * 86400 }];
    g.used = new Date(now()).toISOString();
    save();
    return { access_token: `ohla_${id}.${a}`, token_type: 'Bearer', expires_in: ACCESS_SECS, refresh_token: `ohlr_${id}.${r}`, scope: 'workshop' };
  }

  const out = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'www-authenticate', ...headers });
    res.end(obj === null ? '' : JSON.stringify(obj));
  };
  const page = (res, name, sid) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to OpenHouse</title><style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--soft:#6b6a66;--line:#e4e2dc;--bad:#a33a2b;--ok:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1e;--ink:#eceae4;--soft:#9b9993;--line:#33322f;--bad:#e0806f;--ok:#8fc79a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:560px;margin:0 auto;padding:48px 16px}
h1{font-size:22px;font-weight:600;margin:0 0 4px}p{margin:6px 0;color:var(--soft)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
input{font:inherit;font-size:22px;letter-spacing:.15em;text-transform:uppercase;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
button{font:inherit;margin-top:10px;padding:10px 16px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:var(--bg)}.msg{min-height:1.5em;margin-top:8px}.bad{color:var(--bad)}.good{color:var(--ok)}
</style></head><body><main><h1>Connect ${esc(name)} to your OpenHouse</h1>
<p>${esc(name)} will be able to use what your household keeps on the tablet (lists, the calendar, chores, notes, timers, the TV), and make and change its apps and home screen. Every change can be undone.</p>
<div class="card" id="ask"><p><b>On the tablet:</b> the gear, then Screens and computers, then <b>A computer, to change the apps</b>. It shows a code.</p>
<form id="f"><input id="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" required><button>Connect</button><div class="msg" id="m"></div></form></div>
<div class="card" id="allow" hidden><p><b>Now tap Allow on the tablet.</b></p><div class="msg" id="w"></div></div></main><script>
const sid=${JSON.stringify(sid)},$=(s)=>document.querySelector(s);
async function api(p,b){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});let j={};try{j=await r.json()}catch{}if(!r.ok)throw new Error(j.error||('Something went wrong ('+r.status+')'));return j}
$('#f').onsubmit=async(e)=>{e.preventDefault();const m=$('#m');m.className='msg';m.textContent='Asking the tablet…';
try{await api('/oauth/pair',{sid,code:$('#code').value});$('#ask').hidden=true;$('#allow').hidden=false;wait()}catch(x){m.className='msg bad';m.textContent=x.message}};
async function wait(){for(;;){let j;try{j=await api('/oauth/wait',{sid})}catch(x){$('#w').className='msg bad';$('#w').textContent=x.message;return}
if(j.redirect){$('#w').className='msg good';$('#w').textContent='Connected. Going back…';location.href=j.redirect;return}await new Promise(r=>setTimeout(r,1000))}}
</script></body></html>`);
  };

  const raw = (req, max) => new Promise((resolve) => {
    const parts = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { req.destroy(); resolve(null); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8'))); req.on('error', () => resolve(null));
  });

  async function onPublic(req, res) {
    const url = new URL(req.url, 'http://x'), p = url.pathname.replace(/\/+$/, '') || '/';
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
    try {
      if (!st.on || !okUrl(st.url)) return out(res, 404, { error: 'off' });
      const B = base(), resource = `${B}/mcp`;
      if (req.method === 'OPTIONS') return out(res, 204, null, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id' });
      if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp'))
        return out(res, 200, { resource, authorization_servers: [B], bearer_methods_supported: ['header'], scopes_supported: ['workshop'], resource_name: 'OpenHouse' });
      if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration'))
        return out(res, 200, { issuer: B, authorization_endpoint: `${B}/oauth/authorize`, token_endpoint: `${B}/oauth/token`, registration_endpoint: `${B}/oauth/register`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['workshop'],
          client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
      const text = req.method === 'POST' ? await raw(req, 3e6) : '';
      if (text === null) return out(res, 413, { error: 'too big' });
      const jsonBody = () => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

      if (req.method === 'POST' && p === '/oauth/register') {
        const b = jsonBody(), redirects = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((x) => typeof x === 'string' && x.length < 500) : [];
        if (!redirects.length || redirects.length > 10 || !redirects.every((r) => who(r))) return out(res, 400, { error: 'invalid_redirect_uri', error_description: `OpenHouse connects to ${hosts().join(', ')}.` });
        if (Object.keys(st.clients).length > 200) for (const k of Object.keys(st.clients).slice(0, 50)) delete st.clients[k]; // the oldest go
        const id = `oc_${rnd(18)}`, secret = String(b.token_endpoint_auth_method || 'none') === 'none' ? null : rnd(32);
        st.clients[id] = { redirects, ...(secret ? { secretHash: sha(secret) } : {}), at: new Date(now()).toISOString() }; save();
        return out(res, 201, { client_id: id, client_id_issued_at: secs(), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), redirect_uris: redirects,
          token_endpoint_auth_method: secret ? 'client_secret_post' : 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
      }
      if (req.method === 'GET' && p === '/oauth/authorize') {
        const q = url.searchParams, redirect = q.get('redirect_uri') || '', c = await client(q.get('client_id') || '');
        if (!c || !c.redirects.includes(redirect)) return out(res, 400, { error: 'Add OpenHouse as a connector in Claude or ChatGPT and start again there.' });
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.get('code_challenge') || '')) {
          res.writeHead(302, { location: `${redirect}${redirect.includes('?') ? '&' : '?'}${new URLSearchParams({ error: 'invalid_request', ...(q.get('state') ? { state: q.get('state') } : {}), iss: B })}` }); return res.end();
        }
        const sid = rnd(24);
        for (const [k, s] of sessions) if (s.until < now()) sessions.delete(k);
        sessions.set(sid, { client: c.id, name: who(redirect), redirect, challenge: q.get('code_challenge'), state: q.get('state') || '', until: now() + 15 * 60e3 });
        return page(res, who(redirect), sid);
      }
      if (req.method === 'POST' && (p === '/oauth/pair' || p === '/oauth/wait')) {
        const b = jsonBody(), s = sessions.get(String(b.sid || ''));
        if (!s || s.until < now()) return out(res, 404, { error: 'This page has run out. Start again from Claude or ChatGPT.' });
        if (p === '/oauth/pair') {
          const t = tries.get(ip); if (!t || now() - t.since > 60e3) tries.set(ip, { n: 1, since: now() }); else if (++t.n > 10) return out(res, 429, { error: 'Too many tries. Wait a minute.' });
          const pc = pairingFromCode(b.code);
          if (!pc) return out(res, 400, { error: "That isn't the tablet's code: 12 letters and numbers, like K7QM-2XD9-HPA4." });
          const box = seal(pc.key, `hello:${pc.pair}`, Buffer.from(JSON.stringify({ name: s.name })));
          const r = screens.pairRelayed(pc.pair, 'hello', Buffer.from(JSON.stringify({ box: box.toString('base64url') })));
          if (r.status !== 200) return out(res, 400, { error: 'The tablet isn\'t showing that code. Check it, or open "A computer, to change the apps" again (a code lasts 10 minutes).' });
          s.pair = pc.pair; s.key = pc.key;
          return out(res, 200, { asked: true });
        }
        if (!s.pair) return out(res, 400, { error: 'Type the code first.' });
        const r = screens.pairRelayed(s.pair, 'wait');
        if (r.status === 404) { sessions.delete(String(b.sid)); return out(res, 410, { error: 'The tablet ended the pairing. Start again there.' }); }
        if (r.json.waiting) return out(res, 200, { waiting: true });
        sessions.delete(String(b.sid));
        const w = r.json.box && open(s.key, `welcome:${s.pair}`, Buffer.from(String(r.json.box), 'base64url'));
        const welcome = w ? JSON.parse(w.toString()) : null;
        if (!welcome || welcome.refused) return out(res, 403, { error: 'The tablet said no.' });
        const id = rnd(12), code = rnd(32);
        st.grants[id] = { deviceId: welcome.id, name: welcome.name, client: s.client, at: new Date(now()).toISOString(), access: [], refresh: [], code: { h: sha(code), redirect: s.redirect, challenge: s.challenge, until: secs() + 300 } };
        save();
        return out(res, 200, { redirect: `${s.redirect}${s.redirect.includes('?') ? '&' : '?'}${new URLSearchParams({ code, ...(s.state ? { state: s.state } : {}), iss: B })}` });
      }
      if (req.method === 'POST' && p === '/oauth/token') {
        let b; try { b = String(req.headers['content-type'] || '').includes('json') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)); } catch { return out(res, 400, { error: 'invalid_request' }); }
        let clientId = b.client_id || '', secret = b.client_secret || '';
        const basic = /^Basic (.+)$/i.exec(String(req.headers.authorization || ''));
        if (basic) { const [u, s] = Buffer.from(basic[1], 'base64').toString().split(':'); clientId = decodeURIComponent(u || ''); secret = decodeURIComponent(s || ''); }
        const c = await client(clientId);
        if (!c || (c.secretHash && sha(secret) !== c.secretHash)) return out(res, 401, { error: 'invalid_client' });
        if (b.grant_type === 'authorization_code') {
          const id = Object.keys(st.grants).find((k) => st.grants[k].code?.h === sha(String(b.code || '')));
          const g = id && st.grants[id];
          if (!g) return out(res, 400, { error: 'invalid_grant' });
          const k = g.code; delete g.code; save(); // once
          if (k.until < secs() || g.client !== c.id || (b.redirect_uri && b.redirect_uri !== k.redirect) || sha(String(b.code_verifier || '')) !== k.challenge) return out(res, 400, { error: 'invalid_grant' });
          return out(res, 200, issue(id));
        }
        if (b.grant_type === 'refresh_token') {
          const g = grantOf(b.refresh_token, 'r');
          if (!g || g.g.client !== c.id) return out(res, 400, { error: 'invalid_grant' });
          return out(res, 200, issue(g.id, g.part));
        }
        return out(res, 400, { error: 'unsupported_grant_type' });
      }
      if (p === '/mcp') {
        const refuse = () => out(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${B}/.well-known/oauth-protected-resource", error="invalid_token"` });
        if (req.method !== 'POST') return out(res, 405, { error: 'POST' }, { allow: 'POST' });
        const m = /^Bearer (\S+)$/i.exec(String(req.headers.authorization || ''));
        const g = m && grantOf(m[1], 'a');
        if (!g) return refuse();
        const w = screens.who(g.g.deviceId);
        if (!w) { delete st.grants[g.id]; save(); return refuse(); } // removed in Screens: ended at once
        let msg; try { msg = JSON.parse(text); } catch { return out(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
        if (!msg || Array.isArray(msg)) return out(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one message at a time' } });
        // MCP 2026-07-28 over HTTP: the header's version must be the request's, and a refused request is a 400 (a
        // method it doesn't know a 404), so a client can tell this revision from one that wants initialize.
        const v = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'], h = req.headers['mcp-protocol-version'];
        if (v != null && h && h !== v) return out(res, 400, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32020, message: 'MCP-Protocol-Version is not the request\'s protocolVersion' } });
        const r = await workshop.rpc(msg, w);
        if (!r) return out(res, 202, null);
        const code = v != null && r.error?.code;
        return out(res, code === -32601 ? 404 : [-32602, -32020, -32021, -32022].includes(code) ? 400 : 200, r);
      }
      out(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[web-mcp]', e.message);
      if (!res.headersSent) out(res, 500, { error: 'failed' });
    }
  }

  let server = null;
  function start() {
    if (server || !st.on || !okUrl(st.url)) return;
    server = http.createServer(guarded('web-mcp', onPublic));
    server.on('error', (e) => { console.log('[web-mcp] listener:', e.code || e.message); server = null; });
    server.listen(PORT, HOST, () => console.log(`[web-mcp] the tablet's own connector on :${PORT}, as ${base()}`));
  }
  function stop() { if (!server) return; server.close(); server.closeAllConnections?.(); server = null; }
  start();

  async function handle(req, res, url) {
    if (url.pathname !== '/webmcp') return false;
    if (req.headers['x-openhouse-screen']) { json(res, 403, { error: 'not for screens' }); return true; }
    if (req.method === 'POST') {
      const b = await body(req);
      if (b.on && !okUrl(b.url)) { json(res, 400, { error: 'An https address, like https://kitchen.tail1234.ts.net' }); return true; }
      st.on = !!b.on; if (b.url) st.url = String(b.url).replace(/\/+$/, ''); save();
      stop(); start();
    }
    json(res, 200, { on: !!st.on, url: st.url || null, port: PORT, listening: !!server, connector: st.on && st.url ? `${base()}/mcp` : null });
    return true;
  }
  handle.stop = stop;
  handle.status = () => ({ on: !!st.on, connector: st.on && okUrl(st.url) ? `${base()}/mcp` : null });
  return handle;
}
