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

// soonMs: after a step that couldn't finish (the cloud unreachable, a new address not yet told), it's tried again after
// each of these in turn, then every last one, until one does.
export const LAN_TLS = { renewLeft: 1 / 3, checkMs: 6 * 3600e3, retryMs: [3600e3, 6 * 3600e3, 24 * 3600e3], soonMs: [60e3, 3 * 60e3, 10 * 60e3, 30 * 60e3], lookupMs: 30 * 60e3, txtWaitMs: 120e3 };

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
 * cloud: { linked(): bool, revoked(): bool, linkId(): string|null, lan(what, body): Promise<json> } (cloud.js): revoked
 * says the tablet was unlinked for certain (only then do the name and certificate go here), linkId which link this is. PORT: the home network's port, on which the
 * screens server answers https and http alike (screens.js). onChange(): the certificate or the name changed.
 */
export function lanTls({ DIR, cloud, PORT, directory = process.env.LAN_ACME_DIRECTORY || LETS_ENCRYPT, off = process.env.LAN_TLS === 'off', now = Date.now,
  lookup = (n) => dns.promises.lookup(n, { family: 4 }).then((r) => r.address), waitTxt = publicTxt, onChange = () => {}, log = (...a) => console.log('[lan-tls]', ...a) }) {
  const f = (n) => path.join(DIR, n);
  const readText = (n) => { try { return fs.readFileSync(f(n), 'utf8'); } catch { return null; } };
  const writeText = (n, s) => { memo = null; fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(f(n) + '.tmp', s, { mode: 0o600 }); fs.renameSync(f(n) + '.tmp', f(n)); };
  let state = (() => { try { return JSON.parse(readText('lan.json')) || {}; } catch { return {}; } })();
  const save = (p) => { state = { ...state, ...p }; writeText('lan.json', JSON.stringify(state, null, 2)); };
  let ip = privateIPv4(state.ip), reachable = false, busy = null, timer = null, soon = null, misses = 0; // (the last address it was told, until the shell says again)
  // Unlinked for certain (cloud.js revoked): an older cloud.js without it, any unlink. Unlinked otherwise (a 401 that
  // may be a hiccup), the certificate stays and is served; the name is asked for again once it's linked.
  const gone = () => !cloud.linked() && (typeof cloud.revoked === 'function' ? !!cloud.revoked() : true);
  const linkId = () => (typeof cloud.linkId === 'function' ? cloud.linkId() || null : null);
  /** Another step after a while: sooner while they keep failing, from soonMs. */
  function later(ms) { clearTimeout(soon); soon = setTimeout(kick, ms); soon.unref?.(); }
  const again = () => later(LAN_TLS.soonMs[Math.min(misses++, LAN_TLS.soonMs.length - 1)]);

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
    if (!cloud.linked()) { // unlinked for good: the cloud took the name away; else looked at again, for a relink
      if (gone() && state.name) forget(false);
      if (state.name || state.was) later(LAN_TLS.soonMs[LAN_TLS.soonMs.length - 1]);
      return;
    }
    if (!ip) return;
    // The name, pointed at this address (the same name each time; a new address when the router gave a new one; asked
    // again after a relink, for the name it had: keep, which the cloud gives back where it can).
    const link = linkId();
    if (!state.name || state.ip !== ip || (link && state.link && state.link !== link)) {
      // Refused a new name for now (the service's or the household's new names this week): asked again only once it
      // said, with no name meanwhile (the tablet works at its plain address).
      if (!state.name && state.nameAfter > now()) { later(state.nameAfter - now() + 1000); return; }
      const keep = state.name || state.was || null;
      const r = await cloud.lan('name', { ip, ...(keep ? { keep } : {}) });
      save({ name: r.name, ip: r.ip, link, was: null }); onChange();
      log('name', r.name, '->', r.ip);
    } else if (link && !state.link) save({ link });
    const had = current();
    // After a failed try, the next waits its turn (retryMs), then comes by itself rather than at the next check.
    const wait = state.failedAt ? state.failedAt + LAN_TLS.retryMs[Math.min(state.failures || 1, LAN_TLS.retryMs.length) - 1] - now() : 0;
    if (due(had) && wait > 0) later(wait + 1000);
    else if (due(had)) {
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
        later(LAN_TLS.retryMs[Math.min(state.failures, LAN_TLS.retryMs.length) - 1] + 1000);
      }
    }
    await check();
  }
  /** Whether a phone on this Wi-Fi would find this tablet at its name (see the top of this file). */
  async function check() {
    if (!off && state.name && gone()) forget(false);
    const was = reachable;
    try { reachable = !!(state.name && ip && current() && (await lookup(state.name)) === ip); } catch { reachable = false; }
    if (was !== reachable) { log(reachable ? 'links use https' : 'links stay http'); onChange(); }
  }
  /** One step at a time; an unlinked tablet forgets its name and certificate (the cloud took the name away). */
  function kick() {
    busy ??= step().then(() => { misses = 0; }, (e) => {
      if (e.code === 'unlinked') { if (gone()) forget(false); return; }
      if (e.retryAfter && !state.name) { save({ nameAfter: now() + e.retryAfter * 1000 }); log('no new name until', new Date(state.nameAfter).toISOString()); later(e.retryAfter * 1000 + 1000); return; }
      log('not now:', e.message);
      again();
    }).finally(() => { busy = null; });
    return busy;
  }
  function forget(tellCloud = true) {
    if (tellCloud && state.name && cloud.linked()) cloud.lan('forget', {}).catch(() => {});
    const was = state.name || state.was || null;
    for (const n of ['cert.pem', 'key.pem', 'lan.json']) fs.rmSync(f(n), { force: true });
    state = {}; memo = null; reachable = false;
    if (was) save({ was }); // (only the name, to ask for again if it's linked again)
    onChange();
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
    stop: () => { if (timer) clearInterval(timer); clearTimeout(soon); },
  };
}
