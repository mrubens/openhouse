// The tablet's own https address on its home network (docs/networking.md, "An https address at home"), so a browser
// on the Wi-Fi (an Android phone, another screen, a TV) gets the pages that hold its key over TLS, not plain http that
// anyone on the Wi-Fi could change.
//
// A linked tablet asks the cloud for its name (t-<random>.<the cloud's lan domain>, pointed at its address on the
// Wi-Fi: openhouse-cloud lambda/lan.ts), makes its own key here, and gets a certificate for the name from Let's Encrypt
// (acme.js), proving it by DNS-01 through the cloud, which puts the challenge's TXT record on this tablet's name only.
// The key never leaves this folder (.lan-tls, not in backups). It renews when a third of the certificate is left.
// Once it has one it keeps serving it with no internet and no cloud; only renewing needs them.
//
// The Wi-Fi's links and QR codes use the https name only while it works here: this tablet looks its name up as a
// phone on the same Wi-Fi would (the router's DNS) and gets its own address back. Some routers refuse public names
// that point at home addresses (DNS rebinding protection), and with the internet down the name may not resolve;
// then the links stay plain http, as before.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { certificate, newKey, LETS_ENCRYPT } from './acme.js';

export const LAN_TLS = { renewLeft: 1 / 3, checkMs: 6 * 3600e3, retryMs: [3600e3, 6 * 3600e3, 24 * 3600e3], lookupMs: 30 * 60e3, txtWaitMs: 120e3 };

const privateIPv4 = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) && m.slice(1).every((x) => Number(x) <= 255) ? m[0] : null;
};

/** Waits until public resolvers see the challenge (Let's Encrypt asks the zone itself, but the cloud's change takes a moment). */
async function publicTxt(name, value, { servers = (process.env.LAN_DNS_SERVERS || '1.1.1.1,8.8.8.8').split(','), ms = LAN_TLS.txtWaitMs } = {}) {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  r.setServers(servers);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await r.resolveTxt(name)).some((t) => t.join('') === value)) return true; } catch {}
    await new Promise((res) => setTimeout(res, 3000));
  }
  return false; // (asked anyway: the CA may see it before these resolvers do)
}

/**
 * cloud: { linked(): bool, lan(what, body): Promise<json> } (cloud.js). PORT: the home network's port, on which the
 * screens server answers https and http alike (screens.js). onChange(): the certificate or the name changed.
 */
export function lanTls({ DIR, cloud, PORT, directory = process.env.LAN_ACME_DIRECTORY || LETS_ENCRYPT, off = process.env.LAN_TLS === 'off', now = Date.now,
  lookup = (n) => dns.promises.lookup(n, { family: 4 }).then((r) => r.address), waitTxt = publicTxt, onChange = () => {}, log = (...a) => console.log('[lan-tls]', ...a) }) {
  const f = (n) => path.join(DIR, n);
  const readText = (n) => { try { return fs.readFileSync(f(n), 'utf8'); } catch { return null; } };
  const writeText = (n, s) => { memo = null; fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(f(n) + '.tmp', s, { mode: 0o600 }); fs.renameSync(f(n) + '.tmp', f(n)); };
  let state = (() => { try { return JSON.parse(readText('lan.json')) || {}; } catch { return {}; } })();
  const save = (p) => { state = { ...state, ...p }; writeText('lan.json', JSON.stringify(state, null, 2)); };
  let ip = privateIPv4(state.ip), reachable = false, busy = null, timer = null; // (the last address it was told, until the shell says again)

  /** The certificate on disk, if it's for this name and still good (looked at again after a minute, or a change). */
  let memo = null;
  const current = () => (memo && now() - memo.at < 60e3 ? memo.v : (memo = { at: now(), v: read() }).v);
  function read() {
    const chain = readText('cert.pem'), key = readText('key.pem');
    if (!chain || !key || !state.name) return null;
    try {
      const c = new crypto.X509Certificate(chain);
      const from = Date.parse(c.validFrom), to = Date.parse(c.validTo);
      if (!c.checkHost(state.name) || to <= now() || !c.checkPrivateKey(crypto.createPrivateKey(key))) return null;
      return { key, cert: chain, from, to };
    } catch { return null; }
  }
  const due = (c) => !c || c.to - now() < (c.to - c.from) * LAN_TLS.renewLeft;

  async function step() {
    if (off) return;
    if (!cloud.linked()) { if (state.name) forget(false); return; } // (unlinked: the cloud took the name away)
    if (!ip) return;
    // The name, pointed at this address (the same name each time; a new address when the router gave a new one).
    if (!state.name || state.ip !== ip) {
      const r = await cloud.lan('name', { ip });
      save({ name: r.name, ip: r.ip }); onChange();
      log('name', r.name, '->', r.ip);
    }
    const had = current();
    if (due(had) && !(state.failedAt && now() - state.failedAt < LAN_TLS.retryMs[Math.min(state.failures || 0, LAN_TLS.retryMs.length) - 1])) {
      try {
        let accountKey = readText('account.key');
        if (!accountKey) { accountKey = newKey(); writeText('account.key', accountKey); }
        const certKey = newKey(); // a new key each time: a renewal doesn't keep using the old one
        log('asking Let\'s Encrypt for', state.name);
        const chain = await certificate({ directory, accountKey, certKey, name: state.name, log,
          setTxt: (value) => cloud.lan('challenge', { value }),
          waitTxt: (value) => waitTxt(`_acme-challenge.${state.name}`, value),
          clearTxt: () => cloud.lan('challenge/done', {}) });
        writeText('key.pem', certKey); writeText('cert.pem', chain);
        save({ failedAt: null, failures: 0 });
        log('certificate until', current()?.to && new Date(current().to).toISOString());
        onChange();
      } catch (e) {
        save({ failedAt: now(), failures: (state.failures || 0) + 1 });
        log('no certificate:', e.message);
      }
    }
    await check();
  }
  /** Whether a phone on this Wi-Fi would find this tablet at its name (see the top of this file). */
  async function check() {
    if (!off && state.name && !cloud.linked()) forget(false);
    const was = reachable;
    try { reachable = !!(state.name && ip && current() && (await lookup(state.name)) === ip); } catch { reachable = false; }
    if (was !== reachable) { log(reachable ? 'links use https' : 'links stay http'); onChange(); }
  }
  /** One step at a time; an unlinked tablet forgets its name and certificate (the cloud took the name away). */
  function kick() {
    busy ??= step().catch((e) => {
      if (e.code === 'unlinked') return forget(false);
      log('not now:', e.message);
    }).finally(() => { busy = null; });
    return busy;
  }
  function forget(tellCloud = true) {
    if (tellCloud && state.name && cloud.linked()) cloud.lan('forget', {}).catch(() => {});
    for (const n of ['cert.pem', 'key.pem', 'lan.json']) fs.rmSync(f(n), { force: true });
    state = {}; memo = null; reachable = false; onChange();
  }

  if (!off) {
    setTimeout(kick, 30e3 + Math.floor(Math.random() * 60e3)).unref?.(); // (soon after starting: renew if due, and look the name up)
    timer = setInterval(kick, LAN_TLS.checkMs + Math.floor(Math.random() * 3600e3)); timer.unref?.();
    const t2 = setInterval(() => check(), LAN_TLS.lookupMs); t2.unref?.();
  }

  return {
    /** This tablet's address on the Wi-Fi (the shell says, as the router gives it). */
    address(a) { const p = privateIPv4(a); if (p && p !== ip) { ip = p; kick(); } return !!p; },
    /** The certificate and key to serve, while there's a good one (also with no internet). */
    tls: () => (off ? null : current()),
    /** Where a phone on the Wi-Fi should go: https://<name>:<port>, while that works here; else null (plain http). */
    base: () => (!off && reachable && current() ? `https://${state.name}:${PORT}` : null),
    status: () => ({ on: !off, name: state.name || null, until: current()?.to ? new Date(current().to).toISOString() : null, reachable, failures: state.failures || 0 }),
    kick, forget, check,
    stop: () => timer && clearInterval(timer),
  };
}
