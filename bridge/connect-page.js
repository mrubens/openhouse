// The page someone opens on their computer to add OpenHouse to Claude (docs/workshop-mcp.md), served on the home
// network by the screens listener (screens.js) only while the tablet's "Connect Claude or ChatGPT" screen is open:
// the same window as the pairing code. It serves this page and the two downloads, nothing else.
//
// GET /                    the page: download, the code, three steps; Claude Code and Codex one-liners
// GET /openhouse.mcpb      the Claude Desktop extension (scripts/build-mcpb.sh, built into the runtime)
// GET /openhouse-mcp.mjs   the same thing as one script, for Claude Code and Codex
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

export function page({ code, host }) {
  // host: the tablet's name (openhouse.local:8788) when it answers to one, so a new address from the router later
  // doesn't matter; the script turns it into the address when it pairs. Each line fetches the script into a folder it
  // makes, pairs right away (the person taps Allow on the tablet while it waits), then adds it for every folder.
  const base = `http://${host}`, script = '~/.openhouse/openhouse-mcp.mjs';
  const fetchPair = `curl -fsSL --create-dirs ${base}/openhouse-mcp.mjs -o ${script} && node ${script} pair "${host} ${code}"`;
  const line = (cli) => `${fetchPair} && ${cli === 'claude' ? `{ claude mcp remove -s user openhouse >/dev/null 2>&1; claude mcp add -s user openhouse -- node ${script}; }` : `codex mcp add openhouse -- node ${script}`}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Add OpenHouse to Claude</title>
<style>
@font-face { font-family: 'Inter'; src: url('/kit/fonts/Inter.ttf') format('truetype'); font-weight: 100 900; font-display: swap; }
:root { --bg: #f5f2ea; --ink: #24282a; --soft: #6b6f70; --line: rgba(36, 40, 42, .12); --tint: #ebe7dd; --accent: #b5562f; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.5 'Inter', -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 640px; margin: 0 auto; padding: 64px 24px 80px; }
h1 { font-size: 34px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 8px; }
h2 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
p { margin: 0; color: var(--soft); }
.btn { display: inline-flex; align-items: center; gap: 10px; margin: 28px 0 8px; height: 56px; padding: 0 28px; border-radius: 28px; background: var(--ink); color: var(--bg); text-decoration: none; font-weight: 600; }
.btn svg { width: 20px; height: 20px; }
.small { font-size: 14px; color: var(--soft); }
.code { margin: 40px 0 8px; padding: 28px; border-radius: 20px; background: var(--tint); text-align: center; }
.code b { display: block; font: 600 44px/1.1 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: .06em; }
ol { margin: 36px 0 0; padding: 0; list-style: none; counter-reset: s; }
ol li { counter-increment: s; display: grid; grid-template-columns: 36px 1fr; gap: 6px 14px; padding: 16px 0; border-top: 1px solid var(--line); }
ol li::before { content: counter(s); width: 28px; height: 28px; border-radius: 14px; background: var(--tint); display: grid; place-items: center; font-size: 14px; font-weight: 600; }
ol li span { color: var(--ink); }
section { margin-top: 64px; padding-top: 28px; border-top: 1px solid var(--line); }
.cmd { margin-top: 16px; }
.cmd label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.row { display: flex; gap: 8px; }
.row code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; padding: 12px 14px; border-radius: 12px; background: var(--tint); font: 13px/1.5 ui-monospace, 'SF Mono', Menlo, monospace; }
.row button { flex: none; border: 0; border-radius: 12px; padding: 0 16px; background: var(--tint); color: var(--ink); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
</style></head><body><main>
<h1>Add OpenHouse to Claude</h1>
<p>Then ask Claude for new tabs and apps on your family's tablet.</p>
<a class="btn" id="get" href="/openhouse.mcpb" download="openhouse.mcpb"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 17h12"/></svg>Download OpenHouse for Claude</a>
<div class="small">For the Claude app on a Mac or Windows computer.</div>
<div class="code"><p>Your code</p><b>${esc(code)}</b></div>
<ol>
<li><span>Open the file you downloaded. Claude asks to install OpenHouse: choose Install.</span></li>
<li><span>In Claude, say “Connect to my OpenHouse” and give it the code.</span></li>
<li><span>Tap Allow on the tablet.</span></li>
</ol>
<section>
<h2>Claude Code or Codex</h2>
<p>Paste one line into Terminal on this computer (it needs Node.js). It pairs right away: tap Allow on the tablet when it asks. Then start a new Claude Code or Codex session, and OpenHouse is there in every folder.</p>
<div class="cmd"><label>Claude Code</label><div class="row"><code>${esc(line('claude'))}</code><button type="button">Copy</button></div></div>
<div class="cmd"><label>Codex</label><div class="row"><code>${esc(line('codex'))}</code><button type="button">Copy</button></div></div>
</section>
<p class="small" style="margin-top:48px">This page is on your tablet, only while its Connect Claude or ChatGPT screen is open.</p>
</main><script>
// One download per visit: a second click (Safari asking to allow downloads makes the first look like nothing happened)
// would save "openhouse (1).mcpb" next to the first.
const get = document.getElementById('get');
get.addEventListener('click', (e) => {
  if (get.dataset.done) { e.preventDefault(); return; }
  get.dataset.done = '1';
  setTimeout(() => { get.lastChild.textContent = 'Downloaded: open it from Downloads'; get.style.opacity = '.75'; }, 300);
});
for (const b of document.querySelectorAll('.row button')) b.onclick = () => {
  const t = b.previousElementSibling.textContent, done = () => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1600); };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).then(done);
  const a = document.createElement('textarea'); a.value = t; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); done();
};
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
