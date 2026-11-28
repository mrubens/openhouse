// Away from home with Tailscale (docs/networking.md, "Tailscale, for households without Opie cloud"): the household's
// own tailnet, never ours, and nothing to do with Opie cloud. Off until someone turns it on (Settings → Advanced), and
// it works on a tablet that was never linked.
//
// The tablet runs Tailscale's own static Linux build as a child of the bridge, in userspace networking (no VPN slot):
//   tailscaled --tun=userspace-networking --statedir=<data>/.tailscale
// downloaded from pkgs.tailscale.com only when someone turns it on, and checked against the version and sha256 pinned
// here. Its state (the node's key) is in .tailscale, never in a backup. A computer that has Tailscale of its own (a hub
// on a Mac or Linux box with `tailscale` installed) uses that one instead, through the same calls; turning it off there
// only takes our https address away, never the computer's own sign-in. A hub (OPENHOUSE_HOST=keeper) never runs our
// own: userspace networking passes every port of 127.0.0.1 to the tailnet, and on a computer (a NAS, a box with
// databases and admin pages that trust loopback) that's far more than Opie's port. So a hub needs its own Tailscale,
// and one left from before is signed out and removed at start.
//
// `tailscale serve` gives the home network's port (screens.js, 8788) an https address with Tailscale's own certificate,
// https://<machine>.<tailnet>.ts.net; with HTTPS turned off for the tailnet, http://<100.x address>:8788 instead.
// Either way it's one more carrier for the same sealed requests: pairing, scopes and counters are screens.js's, as on
// the Wi-Fi. Links and QR codes for phones and screens use the address while it's up (screens.js lanBase), and paired
// devices learn it with the relay's (GET /relay/me's `tailnet`, a computer's welcome).
//
// The display's own (loopback, its secret); a hub's settings device too (admin):
//   GET  /tailscale             {on, state, login, address, https, error, own}
//                               state: off | getting (the download) | starting | signin (login: the URL to open) |
//                               approve (the tailnet's admin has to approve this device) | on | error
//   POST /tailscale {on: true, key?}   turn it on (key: an auth key from Tailscale's admin console, instead of signing in)
//   POST /tailscale {on: false}        turn it off: signed out, and its state and download gone
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The build the tablet downloads (pkgs.tailscale.com/stable, the static Linux tarballs), pinned. To move it on: the
 *  new version's .tgz.sha256 for each, from the same page. */
export const TAILSCALE = {
  version: '1.104.7',
  sha256: {
    arm64: 'd6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484',
    amd64: 'e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c',
  },
  url: (v, arch) => `https://pkgs.tailscale.com/stable/tailscale_${v}_${arch}.tgz`,
};
const ARCH = { arm64: 'arm64', x64: 'amd64' };
const HOSTNAME = 'opie'; // the machine's name in the tailnet: https://opie.<tailnet>.ts.net (Tailscale adds -1 if it's taken)
const AUTH_KEY = /^tskey-[A-Za-z0-9_-]{8,200}$/;
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/; // 100.64.0.0/10

/** A tailnet address (100.64.0.0/10), for telling a request that came over the tailnet. */
export const tailnetIp = (ip) => TAILNET_V4.test(String(ip || '').replace(/^::ffff:/, ''));

/** A `tailscale` this computer has of its own (on its PATH, or the Mac app's), else null. */
export function systemCli(env = process.env) {
  if (env.OPENHOUSE_TAILSCALE) return env.OPENHOUSE_TAILSCALE;
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const f of [...dirs.map((d) => path.join(d, 'tailscale')), '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

export function tailscaleRoutes({ DISPLAY, json, body, screens, PORT = Number(process.env.SCREENS_PORT || 8788), env = process.env,
  cli: system = systemCli(env), fetchFn = fetch, spawnFn = spawn, now = Date.now, log = (...a) => console.log('[tailscale]', ...a) }) {
  const STATE = path.join(DISPLAY, '.tailscale'); // tailscaled's own (the node's key), and whether it's on: never in a backup
  const BIN_ROOT = path.join(DISPLAY, '.tailscale-bin'), BIN = path.join(BIN_ROOT, TAILSCALE.version);
  const SETTINGS = path.join(STATE, 'opie.json');
  // (a unix socket's path is at most ~108 bytes: a long data folder's goes in the temp folder instead)
  const SOCK = (() => { const s = path.join(STATE, 'tailscaled.sock'); return s.length < 100 ? s : path.join(os.tmpdir(), `opie-ts-${crypto.createHash('sha256').update(STATE).digest('hex').slice(0, 12)}.sock`); })();
  const hub = env.OPENHOUSE_HOST === 'keeper';
  const own = !system && !hub; // our own tailscaled (the tablet), or this computer's Tailscale (a hub must have it)
  const NEEDS_OWN = 'Install Tailscale on this computer and sign in there first.';
  // What serve gives an address on: 443 with our own node; another port on a computer's own Tailscale, so whatever it
  // already serves at https stays as it is.
  const SERVE_PORT = own ? 443 : PORT;
  const CLI = own ? path.join(BIN, 'tailscale') : system;
  const TARGET = `http://127.0.0.1:${PORT}`;

  const read = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; } catch { return {}; } };
  const save = (v) => { fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); fs.writeFileSync(SETTINGS + '.tmp', JSON.stringify(v), { mode: 0o600 }); fs.renameSync(SETTINGS + '.tmp', SETTINGS); };
  const on = () => !!read().on;

  let state = 'off', error = null, login = null, address = null, https = false, name = null, ip = null;
  let daemon = null, up = null, timer = null, busy = null, deaths = 0, tail = [], keyFile = null, served = null;
  let pendingKey = null, keyError = null; // an auth key someone gave, until `up` has it; what Tailscale said to it
  const changed = () => { try { screens?.tailnetChanged?.(); } catch {} };
  const set = (s, e = null) => { state = s; error = e; };

  /** The CLI, with our node's socket: {code, out}. Never rejects. */
  const cli = (args, ms = 15e3) => new Promise((resolve) => {
    execFile(CLI, [...(own ? [`--socket=${SOCK}`] : []), ...args], { timeout: ms, maxBuffer: 4e6, env: { ...env, TS_NO_LOGS_NO_SUPPORT: 'true' } }, (e, stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
  });
  const status = async () => { const r = await cli(['status', '--json'], 8e3); try { return JSON.parse(r.out); } catch { return null; } };

  /** Tailscale's build for this computer, downloaded once and checked against the pinned sha256. */
  async function binary() {
    if (fs.existsSync(path.join(BIN, 'tailscaled')) && fs.existsSync(path.join(BIN, 'tailscale'))) return;
    const arch = ARCH[process.arch];
    if (process.platform !== 'linux' || !arch) throw Object.assign(new Error('Install Tailscale on this computer first.'), { quiet: true });
    set('getting');
    const tmp = path.join(BIN_ROOT, `.get-${process.pid}`);
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try {
      const url = TAILSCALE.url(TAILSCALE.version, arch);
      log('downloading', url);
      const r = await fetchFn(url, { signal: AbortSignal.timeout(10 * 60e3) });
      if (!r.ok || !r.body) throw new Error(`download: ${r.status}`);
      const tgz = path.join(tmp, 'ts.tgz'), h = crypto.createHash('sha256');
      const src = Readable.fromWeb(r.body);
      src.on('data', (d) => h.update(d));
      await pipeline(src, fs.createWriteStream(tgz, { mode: 0o600 }));
      const got = h.digest('hex');
      if (got !== TAILSCALE.sha256[arch]) throw new Error(`the download isn't the one expected (sha256 ${got.slice(0, 12)}…)`);
      const dir = `tailscale_${TAILSCALE.version}_${arch}`;
      await new Promise((ok, no) => execFile('tar', ['-xzf', tgz, '-C', tmp, '--no-same-owner', `${dir}/tailscaled`, `${dir}/tailscale`], { timeout: 120e3 }, (e) => (e ? no(new Error('unpacking: ' + e.message)) : ok())));
      for (const f of ['tailscaled', 'tailscale']) fs.chmodSync(path.join(tmp, dir, f), 0o755);
      fs.rmSync(BIN, { recursive: true, force: true });
      fs.renameSync(path.join(tmp, dir), BIN);
      for (const e of fs.readdirSync(BIN_ROOT)) if (e !== TAILSCALE.version) fs.rmSync(path.join(BIN_ROOT, e), { recursive: true, force: true }); // (an older version's)
      log('ready', TAILSCALE.version);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  /** Our own tailscaled: started (or the one already answering on its socket kept), and started again if it stops. */
  async function startDaemon() {
    if (daemon) return;
    if (await status()) return; // (one from before the bridge restarted)
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    try { fs.rmSync(SOCK, { force: true }); } catch {}
    set('starting');
    const p = spawnFn(path.join(BIN, 'tailscaled'), ['--tun=userspace-networking', `--statedir=${STATE}`, `--socket=${SOCK}`, '--port=0', '--no-logs-no-support'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No log upload to Tailscale, and no list of the tablet's open ports sent with its details. Its log's own files in
      // its state folder too (else /var/lib/tailscale, which turning it off wouldn't clear).
      env: { ...env, TS_NO_LOGS_NO_SUPPORT: 'true', TS_DEBUG_DISABLE_PORTLIST: 'true', TS_LOGS_DIR: STATE },
    });
    daemon = p;
    try { fs.writeFileSync(path.join(STATE, 'tailscaled.pid'), String(p.pid)); } catch {}
    const keep = (d) => { for (const l of String(d).split('\n')) if (l.trim()) { tail.push(l.slice(0, 300)); if (tail.length > 40) tail.shift(); } };
    p.stdout?.on('data', keep); p.stderr?.on('data', keep);
    p.on('error', (e) => { tail.push(e.message); });
    p.on('exit', (code, sig) => {
      if (daemon !== p) return;
      daemon = null;
      if (!on()) return;
      log('tailscaled stopped', code ?? sig, '|', tail.slice(-4).join(' | '));
      set('error', 'Tailscale stopped.');
      later([2e3, 5e3, 15e3, 60e3][Math.min(deaths++, 3)]);
    });
    // Still not answering after a while (seen once on an emulator, its first start after the download): what it said
    // goes in the bridge's log, and it's started again (the exit above), which got it going.
    setTimeout(async () => {
      if (daemon !== p || (await status())) return;
      log('tailscaled not answering: starting it again |', tail.slice(-8).join(' | '));
      try { p.kill('SIGKILL'); } catch {}
    }, 45e3).unref?.();
    for (let i = 0; i < 40 && daemon === p; i++) { if (await status()) return; await new Promise((r) => setTimeout(r, 250)); }
  }
  function stopDaemon() {
    const p = daemon; daemon = null;
    const pidFile = path.join(STATE, 'tailscaled.pid');
    let pid = p?.pid;
    if (!pid) try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch {}
    if (pid && (p || (() => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('tailscaled'); } catch { return false; } })())) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 3000).unref?.();
    }
  }

  /** `tailscale up`: signing in (its login URL), or with an auth key. It waits for the sign-in, so it runs alongside. */
  function startUp(key) {
    if (up) return;
    const args = ['up', `--hostname=${HOSTNAME}`, '--timeout=30m'];
    if (key) { // in a file, not on the command line other processes can read
      keyFile = path.join(STATE, `.key-${crypto.randomBytes(6).toString('hex')}`);
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
      args.push(`--auth-key=file:${keyFile}`);
    }
    const p = spawnFn(CLI, [...(own ? [`--socket=${SOCK}`] : []), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, TS_NO_LOGS_NO_SUPPORT: 'true' } });
    up = p;
    const seen = (d) => { const m = String(d).match(/https:\/\/\S+/); if (m && !key) { login = m[0]; if (state !== 'on') set('signin'); } };
    p.stdout?.on('data', seen); p.stderr?.on('data', seen);
    p.on('error', () => {});
    p.on('exit', (code) => {
      if (up === p) up = null;
      if (keyFile) { fs.rmSync(keyFile, { force: true }); keyFile = null; }
      if (key && code !== 0 && on()) keyError = "Tailscale didn't take that key.";
      later(500);
    });
  }
  const stopUp = () => { try { up?.kill(); } catch {} up = null; if (keyFile) { fs.rmSync(keyFile, { force: true }); keyFile = null; } };

  /** https at <name>, while the tailnet has HTTPS certificates on; else the node's own address, over plain http. */
  async function serve(st) {
    const dns = String(st.Self?.DNSName || '').replace(/\.$/, '');
    const certOk = Array.isArray(st.CertDomains) && st.CertDomains.includes(dns);
    name = dns || null;
    ip = (st.Self?.TailscaleIPs || []).find((a) => TAILNET_V4.test(a)) || null;
    let wantHttps = !!(certOk && dns);
    if (wantHttps && served !== dns) {
      const r = await cli(['serve', '--bg', '--yes', `--https=${SERVE_PORT}`, TARGET], 60e3);
      if (r.code === 0) served = dns;
      else { log('serve:', (r.err || r.out).trim().split('\n').slice(-1)[0]); wantHttps = false; }
    }
    https = wantHttps;
    const next = https ? `https://${dns}${SERVE_PORT === 443 ? '' : `:${SERVE_PORT}`}` : ip ? `http://${ip}:${PORT}` : null;
    if (next !== address) { address = next; log('reachable at', address); changed(); }
  }

  /** One look at where it is, and the next step. */
  async function step() {
    if (!on()) return;
    if (!own && !system) { set('error', NEEDS_OWN); return; }
    if (own) { await binary(); await startDaemon(); }
    const st = await status();
    if (!st) { set(own ? 'starting' : 'error', own ? null : "Tailscale isn't running on this computer."); return later(own ? 2e3 : 30e3); }
    const bs = st.BackendState;
    if (bs === 'Running') {
      deaths = 0; login = null; keyError = null;
      if (keyFile) { fs.rmSync(keyFile, { force: true }); keyFile = null; }
      set('on');
      await serve(st);
      return later(60e3);
    }
    if (address) { address = null; changed(); }
    if (bs === 'NeedsMachineAuth') { set('approve'); return later(5e3); }
    if (bs === 'NeedsLogin' || bs === 'Stopped' || bs === 'NoState') {
      // A computer's own Tailscale is signed in there, by whoever runs it: never `up` here, which would change its settings.
      if (!own) { set('error', 'Sign in to Tailscale on this computer first.'); return later(30e3); }
      if (st.AuthURL) login = st.AuthURL;
      if (!up) { startUp(pendingKey); pendingKey = null; }
      set(login ? 'signin' : 'starting', keyError);
      return later(2e3);
    }
    set('starting');
    later(2e3);
  }
  function later(ms) { clearTimeout(timer); timer = setTimeout(kick, ms); timer.unref?.(); }
  function kick() {
    busy ??= step().catch((e) => { if (on()) { set('error', e.message); if (!e.quiet) log(e.message); later(60e3); } }).finally(() => { busy = null; });
    return busy;
  }

  async function turnOn(key) {
    save({ on: true, at: new Date(now()).toISOString() });
    screens?.lanOn?.(); // the port it serves: the home network's
    login = null; deaths = 0; keyError = null;
    if (key) { stopUp(); pendingKey = key; }
    kick(); // (the download and the start go on after the answer: GET /tailscale follows them)
  }
  async function turnOff() {
    clearTimeout(timer); timer = null;
    stopUp(); pendingKey = null; keyError = null;
    const was = address; address = null; login = null; served = null; https = false; name = null; ip = null;
    if (own) {
      if (daemon || fs.existsSync(SOCK)) await cli(['logout'], 15e3); // (the node goes from the tailnet's list)
      stopDaemon();
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(STATE, { recursive: true, force: true });
      fs.rmSync(BIN_ROOT, { recursive: true, force: true });
      try { fs.rmSync(SOCK, { force: true }); } catch {}
    } else {
      await cli(['serve', `--https=${SERVE_PORT}`, 'off'], 15e3); // only our address: the computer stays signed in
      fs.rmSync(STATE, { recursive: true, force: true });
    }
    set('off');
    if (was) changed();
    log('off');
  }

  const view = () => ({ on: on(), state: on() ? state : 'off', login: on() && state === 'signin' ? login : null, address: on() ? address : null, https: on() && https, name: on() ? name : null, error: on() ? error : null, own });

  /** A hub's own tailscaled from before it needed the computer's: signed out, stopped, and its state and download gone. */
  async function retire() {
    log("signing out Opie's own Tailscale: on a hub, it would put every port of this computer's loopback on the tailnet. Install Tailscale on the computer to use it.");
    const old = path.join(BIN, 'tailscale');
    if (fs.existsSync(old) && fs.existsSync(SOCK)) await new Promise((r) => execFile(old, [`--socket=${SOCK}`, 'logout'], { timeout: 15e3 }, () => r()));
    stopDaemon();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(STATE, { recursive: true, force: true });
    fs.rmSync(BIN_ROOT, { recursive: true, force: true });
    try { fs.rmSync(SOCK, { force: true }); } catch {}
  }
  if (hub && fs.existsSync(BIN_ROOT)) retire().catch((e) => log('retiring:', e.message)).finally(() => { if (on()) kick(); });
  else if (on()) kick();
  process.on('exit', () => { try { daemon?.kill(); } catch {} try { up?.kill(); } catch {} });

  async function handle(req, res, url) {
    if (url.pathname !== '/tailscale') return false;
    if (req.headers['x-openhouse-screen'] && !screens?.who?.(req.headers['x-openhouse-screen'])?.scopes?.includes('admin')) { json(res, 403, { error: 'not for screens' }); return true; }
    if (req.method === 'GET') { json(res, 200, view()); return true; }
    if (req.method !== 'POST') return false;
    const b = await body(req);
    if (b.on === true) {
      const key = b.key == null || b.key === '' ? null : String(b.key).trim();
      if (key && !AUTH_KEY.test(key)) { json(res, 400, { error: "That isn't a Tailscale auth key. It starts with tskey-." }); return true; }
      if (!own && !system) { json(res, 400, { error: NEEDS_OWN }); return true; }
      if (key && !own) { json(res, 400, { error: 'Sign in to Tailscale on this computer instead.' }); return true; }
      await turnOn(key);
    } else if (b.on === false) await turnOff();
    else { json(res, 400, { error: 'on' }); return true; }
    json(res, 200, view());
    return true;
  }
  /** Where a phone or screen goes for this tablet over the tailnet, while it's up: {base, https}, else null. */
  handle.at = () => (on() && state === 'on' && address ? { base: address, https, name, ip } : null);
  handle.status = view;
  if (screens) screens.tailnetAt = handle.at; // (links, QR codes and a computer's welcome: screens.js)
  handle.stop = () => { clearTimeout(timer); stopUp(); try { daemon?.kill(); } catch {} };
  return handle;
}
