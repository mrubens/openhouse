// The hub (docs/hub.md): the bridge on a small computer in a closet (a Raspberry Pi, a NUC, Docker on a NAS) with no
// screen of its own; the household's phones, laptops and TV are its screens. On when the host has no screen (host.js
// 'cards': the keeper, which hub/start.sh starts).
// What the tablet's shell does around the bridge, a hub does here or in the browser:
//   - its settings: a paired device with the 'admin' scope (screens.js), at /hub/ (chat/src/hub.jsx);
//   - the first such device: a code printed at start-up while there's none (and on `hub/owner-code.sh`), so only someone
//     with the hub's console can take it;
//   - updates: a git checkout pulls and restarts (hub/update.sh); a Docker image is replaced by pulling a newer one.
//
//   GET  /hub                  {hub, version, install, update, https}     (admin devices, and the hub's console)
//   POST /hub/update {back?}   a git checkout: pull, build, restart (back: the version before the last update); Docker: how to update instead
//   POST /hub/owner-code       a new code for a settings device (the hub's console only: its secret)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';


export function hubRoutes({ DISPLAY, screens, json, body = async () => ({}), CODE = process.env.OPENHOUSE_CODE_DIR || path.resolve(DISPLAY, '..'), log = console.log, exit = () => process.exit(0) }) {
  const install = fs.existsSync('/.dockerenv') || process.env.OPENHOUSE_INSTALL === 'docker' ? 'docker' : fs.existsSync(path.join(CODE, '.git')) ? 'git' : 'files';
  const version = (() => { try { return fs.readFileSync(path.join(CODE, 'VERSION'), 'utf8').trim(); } catch {} try { return JSON.parse(fs.readFileSync(path.join(CODE, 'hub', 'package.json'), 'utf8')).version; } catch { return 'dev'; } })();
  let updating = null;
  /** Is there a version to go back to (hub/update.sh keeps the one before the last update)? */
  const previous = () => { try { const g = String(fs.readFileSync(path.join(CODE, '.git'), 'utf8')).match(/^gitdir: (.+)$/m)?.[1]?.trim(); return fs.existsSync(path.join(g ? path.resolve(CODE, g) : path.join(CODE, '.git'), 'opie-previous')); } catch { return fs.existsSync(path.join(CODE, '.git', 'opie-previous')); } };

  function ownerCode() {
    const { code, port, https } = screens.ownerCode();
    const file = path.join(DISPLAY, 'hub-setup.txt');
    const text = `Opie hub: open ${https ? 'https' : 'http'}://<this machine's address>:${port}/hub/ on a phone or computer and type ${code}\n(it works once, for 24 hours)\n`;
    try { fs.writeFileSync(file, text, { mode: 0o600 }); } catch {}
    log(`\n[hub] ----------------------------------------------------------------\n[hub] Set it up: open ${https ? 'https' : 'http'}://<this machine>:${port}/hub/ and type  ${code}\n[hub] ----------------------------------------------------------------\n`);
    return { code, port };
  }

  /** At start-up: no settings device yet, so a code for one. */
  function start() { if (!screens.hasAdmin()) ownerCode(); else fs.rmSync(path.join(DISPLAY, 'hub-setup.txt'), { force: true }); }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/hub' && !p.startsWith('/hub/')) return false;
    if (req.method === 'GET' && p === '/hub') {
      json(res, 200, { hub: true, version, install, updating, https: !!process.env.HUB_TLS_CERT, back: install === 'git' && previous(),
        update: install === 'git' ? { how: 'git' } : install === 'docker' ? { how: 'image', command: 'docker compose pull && docker compose up -d' } : { how: 'files' } });
      return true;
    }
    if (req.method === 'POST' && p === '/hub/owner-code') { // (not among a settings device's routes: screens.js RULES)
      json(res, 200, ownerCode()); return true;
    }
    if (req.method === 'POST' && p === '/hub/update') {
      const back = (await body(req).catch(() => ({})))?.back === true; // Go back: the version before the last update
      if (install !== 'git') { json(res, 200, { ok: false, how: install === 'docker' ? 'image' : 'files', command: install === 'docker' ? 'docker compose pull && docker compose up -d' : null }); return true; }
      if (updating) { json(res, 409, { error: 'already updating' }); return true; }
      updating = { at: new Date().toISOString() };
      const out = fs.openSync(path.join(DISPLAY, 'update.log'), 'a');
      const child = spawn('bash', [path.join(CODE, 'hub', 'update.sh'), ...(back ? ['--back'] : [])], { cwd: CODE, stdio: ['ignore', out, out] });
      child.on('exit', (code) => {
        if (code === 0) { log('[hub] updated: restarting'); setTimeout(exit, 300); } // hub/start.sh (systemd, Docker) starts it again on the new code
        else { log(`[hub] update failed (${code}): see update.log`); updating = { ...updating, failed: true }; }
      });
      json(res, 200, { ok: true, how: 'git' });
      return true;
    }
    return false;
  }
  handle.start = start;
  handle.install = install;
  return handle;
}
