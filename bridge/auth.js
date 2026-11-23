// Who may use the bridge. It listens on loopback only, which keeps out the Wi-Fi but not the other apps on the
// tablet (a game a kid installed could start the agent, undo, or listen to /voice/events). So every request needs
// the display's secret, a new one each time the tablet starts (the shell's BridgeToken):
//   - the shell's native code (the board, app windows) sends it as the X-Openhouse-Token header;
//   - the runtime gets it as OPENHOUSE_TOKEN (or reads OPENHOUSE_TOKEN_FILE / ../.bridge-token);
//   - a Mac over `adb forward` fetches it with scripts/bridge-token.sh.
// The agents' MCP endpoints (/door/mcp, /mcp/home) have their own bearer tokens and check them themselves; so does
// /agent/save, where the agent's own app hands in the files it saved (box.js).
// Also: Host must be a loopback address (a DNS-rebinding page sends its own host name).
// BRIDGE_DEV=1 (scripts/start-host.sh, on a Mac) leaves it open.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV = process.env.BRIDGE_DEV === '1';

function load() {
  if (process.env.OPENHOUSE_TOKEN) return process.env.OPENHOUSE_TOKEN;
  for (const f of [process.env.OPENHOUSE_TOKEN_FILE, path.join(HERE, '../.bridge-token')].filter(Boolean)) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
  }
  return null;
}
let token = load();
if (!token && !DEV) console.log('[auth] no OPENHOUSE_TOKEN: refusing every request until the shell starts the bridge');
// The shell makes a new one at each boot; a bridge started by hand in between picks it up from the file.
setInterval(() => { if (!process.env.OPENHOUSE_TOKEN) token = load(); }, 30e3).unref();

const OWN_MCP = new Set(['/door/mcp', '/mcp/home',
  '/agent/save', // not MCP, but the same idea: it takes a running turn's key and nothing else (box.js)
  '/agent/mcp/home', '/agent/mcp/device']); // the device and home tools for the agent's own app, with that key (box.js)

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Host header: this device (any port: adb forward from a Mac arrives as localhost:<its port>). */
export function loopbackHost(req) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(req.headers.host || '')) || (DEV && /^10\.0\.2\.2(:\d+)?$/.test(String(req.headers.host || '')));
}

/** Does this request carry the display's secret (or is it an MCP route with its own token)? */
export function authorized(req, url) {
  if (DEV) return true;
  if (!loopbackHost(req)) return false;
  if (OWN_MCP.has(url.pathname)) return true;
  if (!token) return false;
  return same(req.headers['x-openhouse-token'], token);
}
