// A call to the shell's device server (DeviceServer.kt's home paths: its "Is this OK?" card, /say, /calendar, ...), with
// its address and token from the agents' MCP config. The one copy: the house, the devices, the plugins' and the
// calendar links' callers each read its answer their own way.
import fs from 'node:fs';

/** The shell's address and token, or null when there's no shell here (a laptop). */
export const shellCfg = (file = process.env.DEVICE_MCP_CONFIG) => {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.device; return { base: d.url.replace(/\/mcp$/, ''), auth: d.headers.Authorization }; } catch { return null; }
};

/** POST b to the shell's path p. Resolves null when there's no shell here, else { ok, status, body }: status 0 when it
 *  didn't answer (in ms), body null when what it sent isn't JSON. Never rejects. */
export async function toShell(p, b, { ms = 3000, file } = {}) {
  const s = shellCfg(file);
  if (!s) return null;
  try {
    const r = await fetch(s.base + p, { method: 'POST', headers: { authorization: s.auth, 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(ms) });
    let body = null; try { body = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, body };
  } catch { return { ok: false, status: 0, body: null }; }
}

/** The shell's answer as it sent it when it said OK, else null (no shell, no answer, an error status). */
export const shellJson = async (p, b, ms) => { const r = await toShell(p, b, { ms }); return r?.ok ? r.body : null; };
