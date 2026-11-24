// The page someone opens on their computer to add OpenHouse to Claude (docs/workshop-mcp.md), served on the home
// network by the screens listener (screens.js) only while the tablet's "Connect Claude or ChatGPT" screen is open:
// the same window as the pairing code. It serves this page and the two downloads, nothing else.
//
// GET /                    the page: a prompt to paste into any assistant (setupPrompt: the cloud's connector and
//                          its docs), and the Claude Desktop download with the code and three steps
// GET /openhouse.mcpb      the Claude Desktop extension (scripts/build-mcpb.sh, built into the runtime)
// GET /openhouse-mcp.mjs   the same thing as one script
//
// While it's open the bridge also answers "openhouse.local" over mDNS with the tablet's own address, so the
// computer can open http://openhouse.local:8788 (Android apps can't listen on port 80, so the port stays).
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';

export const HOSTNAME = process.env.CONNECT_HOSTNAME || 'openhouse.local'; // another name and port: tests
const MDNS_PORT = Number(process.env.CONNECT_MDNS_PORT || 5353);
const MDNS = '224.0.0.251';
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// ---- the name: a tiny mDNS responder for one A record ----
function nameBytes(name) {
  return Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
}
/** The A record for name -> address (ttl 0 says goodbye). id: the question's, for a reply to one port (legacy unicast). */
export function answer(name, address, { ttl = 120, id = 0 } = {}) {
  const head = Buffer.alloc(12); head.writeUInt16BE(id, 0); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(1, 6); // response, authoritative, one answer
  const rr = Buffer.alloc(10); rr.writeUInt16BE(1, 0); rr.writeUInt16BE(0x8001, 2); rr.writeUInt32BE(ttl, 4); rr.writeUInt16BE(4, 8); // A, IN + cache flush
  return Buffer.concat([head, nameBytes(name), rr, Buffer.from(address.split('.').map(Number))]);
}
/** The names an mDNS question asks for, with their type and whether it wants a unicast answer. */
export function questions(buf) {
  if (buf.length < 12 || buf.readUInt16BE(2) & 0x8000) return []; // a response, not a question
  const out = []; let at = 12;
  for (let q = buf.readUInt16BE(4); q > 0; q--) {
    const labels = [];
    for (let guard = 0; guard < 64; guard++) {
      const len = buf[at];
      if (len === undefined) return out;
      if (len === 0) { at++; break; }
      if ((len & 0xc0) === 0xc0) return out; // a pointer in a question: not one of ours
      labels.push(buf.toString('utf8', at + 1, at + 1 + len)); at += 1 + len;
    }
    if (at + 4 > buf.length) return out;
    out.push({ name: labels.join('.').toLowerCase(), type: buf.readUInt16BE(at), unicast: !!(buf.readUInt16BE(at + 2) & 0x8000) });
    at += 4;
  }
  return out;
}

export function responder({ name = HOSTNAME, port = MDNS_PORT, log = (...a) => console.log('[connect]', ...a) } = {}) {
  let sock = null, address = null;
  const say = (buf, to = MDNS, toPort = port) => { try { sock?.send(buf, toPort, to); } catch {} };
  return {
    start(addr) {
      if (!IPV4.test(addr || '')) return;
      address = addr;
      if (sock) { say(answer(name, address)); return; }
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (e) => { log(`no ${name} (${e.code || e.message})`); try { sock.close(); } catch {} sock = null; });
      sock.on('message', (buf, from) => {
        if (!address) return;
        const id = buf.length >= 2 ? buf.readUInt16BE(0) : 0;
        for (const q of questions(buf)) {
          if (q.name !== name || (q.type !== 1 && q.type !== 255)) continue;
          if (from.port !== 5353) say(answer(name, address, { id }), from.address, from.port); // a plain resolver's question: straight back
          else if (q.unicast) say(answer(name, address), from.address, from.port);
          else say(answer(name, address));
        }
      });
      sock.bind(port, () => {
        try { sock.addMembership(MDNS); sock.setMulticastTTL(255); } catch (e) { log('mDNS membership:', e.message); }
        say(answer(name, address)); setTimeout(() => address && say(answer(name, address)), 1000); // announce, twice
        log(`answering ${name} with ${address}`);
      });
    },
    stop() {
      if (!sock) return;
      if (address) say(answer(name, address, { ttl: 0 })); // goodbye: caches forget it now
      const s = sock; sock = null; address = null;
      setTimeout(() => { try { s.close(); } catch {} }, 200);
    },
    get on() { return !!sock; },
  };
}

// ---- the page ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The cloud's MCP connector (openhouse-cloud lambda/connector.ts) and the guide it serves, as a public page. A client
// that adds the connector signs in by typing the tablet's code on the cloud's page; someone taps Allow on the tablet.
export const CONNECTOR = process.env.CONNECT_MCP_URL || 'https://cloud.openhouse.computer/mcp';
export const DOCS = process.env.CONNECT_DOCS_URL || 'https://cloud.openhouse.computer/docs';

/** The prompt to paste into any assistant: add the connector, sign in with the code, read the guide, work out the
 *  rest. No local address in it, so it works from anywhere. */
export function setupPrompt(code) {
  return `Add the OpenHouse MCP server at ${CONNECTOR} (when it asks me to sign in, I'll type the code ${code} from our tablet, then tap Allow there), then read the OpenHouse docs at ${DOCS} and work out how you can best use OpenHouse to help us.`;
}

export function page({ code, host, relay = null }) {
  // relay: whether the tablet has "Use it away from home" on and connected; the cloud's connector reaches it only then.
  const prompt = setupPrompt(code);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your AI assistant</title>
<style>
@font-face { font-family: 'Inter'; src: url('/kit/fonts/Inter.ttf') format('truetype'); font-weight: 100 900; font-display: swap; }
:root { --bg: #f5f2ea; --ink: #24282a; --soft: #6b6f70; --line: rgba(36, 40, 42, .12); --tint: #ebe7dd; --accent: #b5562f; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.5 'Inter', -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 680px; margin: 0 auto; padding: 64px 24px 80px; }
h1 { font-size: 34px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 8px; }
h2 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
p { margin: 0; color: var(--soft); }
.prompt { margin: 28px 0 0; max-height: 260px; overflow: auto; padding: 18px 20px; border-radius: 16px; background: var(--tint); white-space: pre-wrap; font: 14px/1.55 ui-monospace, 'SF Mono', Menlo, monospace; color: var(--ink); }
.btn { display: inline-flex; align-items: center; gap: 10px; margin: 20px 0 8px; height: 56px; padding: 0 28px; border: 0; border-radius: 28px; background: var(--ink); color: var(--bg); text-decoration: none; font: inherit; font-weight: 600; cursor: pointer; }
.btn.soft { background: var(--tint); color: var(--ink); height: 48px; margin-top: 16px; }
.btn svg { width: 20px; height: 20px; }
.small { font-size: 15px; color: var(--soft); margin-top: 8px; }
.small b { color: var(--ink); font-weight: 600; }
.code { margin: 20px 0 0; font-size: 17px; color: var(--soft); }
.code b { color: var(--ink); font: 600 22px/1.2 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: .06em; margin-left: 8px; }
ol { margin: 16px 0 0; padding: 0; list-style: none; counter-reset: s; }
ol li { counter-increment: s; display: grid; grid-template-columns: 36px 1fr; gap: 6px 14px; padding: 14px 0; border-top: 1px solid var(--line); }
ol li::before { content: counter(s); width: 28px; height: 28px; border-radius: 14px; background: var(--tint); display: grid; place-items: center; font-size: 14px; font-weight: 600; }
ol li span { color: var(--ink); }
section { margin-top: 56px; padding-top: 28px; border-top: 1px solid var(--line); }
</style></head><body><main>
<h1>Connect your AI assistant</h1>
<p>Paste this into Claude, ChatGPT, Codex or another assistant. It adds OpenHouse, and asks you for the code and to tap Allow here.</p>
<div class="prompt" id="prompt">${esc(prompt)}</div>
<button class="btn" type="button" id="copy">Copy prompt</button>
<div class="small">${relay ? 'The code works for 10 minutes.' : 'First turn on <b>Use it away from home</b> in the tablet’s Cloud settings: the assistant reaches the tablet through it. Without it, use the Claude app below, on this Wi-Fi.'} In claude.ai and ChatGPT you add the connector yourself, in Settings; the assistant tells you how.</div>
<section>
<h2>The Claude app</h2>
<p>For the Claude app on a Mac or Windows computer.</p>
<a class="btn soft" id="get" href="/openhouse.mcpb" download="openhouse.mcpb"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 17h12"/></svg>Download OpenHouse for Claude</a>
<div class="code">Your code<b>${esc(code)}</b></div>
<ol>
<li><span>Open the file you downloaded. Claude asks to install OpenHouse: choose Install.</span></li>
<li><span>In Claude, say “Connect to my OpenHouse” and give it the code.</span></li>
<li><span>Tap Allow on the tablet.</span></li>
</ol>
</section>
<p class="small" style="margin-top:48px">This page is on your tablet, only while its Connect screen is open.</p>
</main><script>
// One download per visit: a second click (Safari asking to allow downloads makes the first look like nothing happened)
// would save "openhouse (1).mcpb" next to the first.
const get = document.getElementById('get');
get.addEventListener('click', (e) => {
  if (get.dataset.done) { e.preventDefault(); return; }
  get.dataset.done = '1';
  setTimeout(() => { get.lastChild.textContent = 'Downloaded: open it from Downloads'; }, 300);
});
function copy(b, t, label) {
  const done = () => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = label), 1600); };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).then(done);
  const a = document.createElement('textarea'); a.value = t; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); done();
}
const c = document.getElementById('copy');
c.onclick = () => copy(c, document.getElementById('prompt').textContent, 'Copy prompt');
</script></body></html>`;
}

/** Where the built downloads are: in the runtime, public/connect/; on a laptop, the repo's dist/. */
export function downloads(HERE) {
  const pick = (...c) => c.find((f) => fs.existsSync(f)) || null;
  return {
    mcpb: pick(path.join(HERE, 'public/connect/openhouse.mcpb'), path.join(HERE, '../dist/openhouse.mcpb')),
    script: pick(path.join(HERE, 'public/connect/openhouse-mcp.mjs'), path.join(HERE, '../connect/dist/openhouse-mcp.mjs')),
  };
}
