// Email to the tablet (docs/tablet-email.md): mail from the household's approved senders, by the cloud's address
// (sealed for this tablet's mail key until it's fetched) or the household's own mailbox (the shell's IMAP, MailAccount.kt).
// Photos (and videos, kept as they come) go into the Email album and events are offered on the Calendar app to say yes to (house.js readEmail). Mail from
// anyone else is held, unread, for Allow in Settings → Email, and deleted after 3 days.
//
//   GET  /mail                 what Settings → Email shows: {cloud, own, senders, held, recent, notes}
//   POST /mail/set             {on?, address?: 'new' | <name>, senders?: [{address, who}], own?}
//   POST /mail/held            {id, allow}
//   POST /mail/incoming        {raw: base64 MIME, source: 'imap'} (the shell's own mailbox) -> {ok} | {error}
// Display only (server.js): apps, and screens and phones through the relay, never reach these.
//
// State in display/mail.json (senders, held and recent lists, counts); held and recent messages themselves in
// display/mail/ (a week at most); the mail key in display/.cloud/mail-key.json (0600, never in a backup).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newMailKey, open, senderHash } from './mail-seal.js';
import { parseMail, authenticated } from './mime.js';

const DAY = 86400e3;
export const LIMITS = { size: 25e6, perDay: 50, heldPerDay: 10, images: 20, videos: 5, pdfs: 5, pages: 20, heldDays: 3, recentDays: 7 };
const IMAGE = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const HEIC = /^image\/hei[cf]/;
const VIDEO = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v' };
/** A video attachment's file type (some mail apps send one as octet-stream, named .mov), or null. */
const videoType = (a) => VIDEO[a.type] || (a.type === 'application/octet-stream' && /\.(mp4|mov|m4v)$/i.exec(a.name || '')?.[0].toLowerCase()) || null;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function mailRoutes({ DISPLAY, json, body, house, cloud = null, shell = null, now = Date.now, every = 5 * 60e3, log = (m) => console.log(m) }) {
  const FILE = path.join(DISPLAY, 'mail.json'), DIR = path.join(DISPLAY, 'mail'), KEY = path.join(DISPLAY, '.cloud', 'mail-key.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { st = {}; }
  st.senders ||= []; st.held ||= []; st.recent ||= []; st.notes ||= []; st.counts ||= {};
  const save = () => { const t = FILE + '.new'; fs.writeFileSync(t, JSON.stringify(st, null, 2)); fs.renameSync(t, FILE); };
  const raw = (id) => path.join(DIR, id.replace(/[^\w-]/g, '') + '.eml');
  const keep = (id, bytes) => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(raw(id), bytes, { mode: 0o600 }); };
  const drop = (id) => fs.rmSync(raw(id), { force: true });
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const counts = () => { if (st.counts.day !== day()) st.counts = { day: day(), n: 0, held: 0 }; return st.counts; };
  const note = (text) => { st.notes = [...st.notes, { text, at: now() }].slice(-10); save(); };
  const whoOf = (address) => st.senders.find((s) => s.address === address);

  // ---- arriving ----
  /** A message from a source: checked, then held or read. {ok} or {error} (the shell's mailbox keeps it then). */
  async function receive(bytes, source) {
    if (bytes.length > LIMITS.size) { note('A message was too big to take (25 MB at most).'); return { ok: true, dropped: 'size' }; }
    let m; try { m = parseMail(bytes); } catch { return { ok: true, dropped: 'unreadable' }; }
    const from = m.from?.address;
    if (!from || !EMAIL.test(from)) return { ok: true, dropped: 'no sender' };
    const c = counts();
    if (c.n >= LIMITS.perDay) { if (c.n === LIMITS.perDay) note('More than 50 messages came today; the rest were left out.'); c.n++; save(); return { ok: true, dropped: 'cap' }; }
    // The cloud's gate checked the sender's domain (SPF, DKIM, DMARC); the household's own mailbox has its provider's verdict.
    const verified = source === 'cloud' || authenticated(m.headers, from);
    const id = now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    c.n++;
    if (!verified || !whoOf(from)) {
      if (c.held >= LIMITS.heldPerDay) { save(); return { ok: true, dropped: 'held cap' }; }
      c.held++;
      keep(id, bytes);
      st.held.push({ id, from, name: m.from.name || '', subject: m.subject.slice(0, 200), at: now(), ...(verified ? {} : { unverified: true }) });
      save();
      return { ok: true, held: true };
    }
    save();
    await read(id, bytes, m);
    return { ok: true };
  }

  /** An approved sender's message, read: photos and events (house.readEmail); a note of it in recent. */
  async function read(id, bytes, m = parseMail(bytes)) {
    const from = m.from.address, s = whoOf(from);
    const images = [], pages = [], videos = [];
    let pdfs = 0, skipped = 0;
    for (const a of m.attachments) {
      if (IMAGE[a.type] && images.length < LIMITS.images) images.push({ bytes: a.bytes, type: a.type === 'image/jpg' ? 'image/jpeg' : a.type, name: (a.name || 'email').replace(/\.[^.]*$/, '').slice(0, 60) + IMAGE[a.type] });
      else if (videoType(a) && videos.length < LIMITS.videos) videos.push({ bytes: a.bytes, name: (a.name || 'email').replace(/\.[^.]*$/, '').slice(0, 60) + videoType(a) });
      else if (HEIC.test(a.type) && images.length < LIMITS.images && shell) {
        const r = await shell('/mail/heic', { heic: a.bytes.toString('base64') }).catch(() => null);
        if (r?.jpeg) images.push({ bytes: Buffer.from(r.jpeg, 'base64'), type: 'image/jpeg', name: (a.name || 'email').replace(/\.[^.]*$/, '').slice(0, 60) + '.jpg' }); else skipped++;
      } else if (a.type === 'application/pdf' && pdfs < LIMITS.pdfs && pages.length < LIMITS.pages && shell) {
        pdfs++;
        const r = await shell('/mail/pdf', { pdf: a.bytes.toString('base64'), pages: LIMITS.pages - pages.length }).catch(() => null);
        if (Array.isArray(r?.pages)) for (const p of r.pages.slice(0, LIMITS.pages - pages.length)) pages.push({ bytes: Buffer.from(String(p), 'base64'), type: 'image/jpeg' }); else skipped++;
      } else skipped++;
    }
    const entry = { id, from, who: s?.who || '', subject: m.subject.slice(0, 200), at: now(), photos: 0, events: 0 };
    try {
      const r = await house.readEmail({ from: s?.who || m.from.name || from, subject: m.subject, text: m.text, images, pages, videos });
      entry.photos = r.photos.length; entry.events = r.events;
      if (r.unread) entry.unread = true; // no assistant yet: read again once there is one (tick)
    } catch (e) { entry.unread = true; entry.error = String(e.message || e).slice(0, 120); }
    if (skipped) entry.skipped = skipped;
    keep(id, bytes); // a week, to see in Settings and to read again
    st.recent = [...st.recent.filter((x) => x.id !== id), entry].slice(-50);
    save();
    return entry;
  }

  // ---- held ----
  async function held({ id, allow }) {
    const h = st.held.find((x) => x.id === id);
    if (!h) return { error: 'That message isn’t waiting any more.' };
    st.held = st.held.filter((x) => x !== h);
    if (!allow) { drop(id); save(); return { ok: true }; }
    if (!whoOf(h.from)) { st.senders.push({ address: h.from, who: '' }); syncSenders(); }
    save();
    let bytes; try { bytes = fs.readFileSync(raw(id)); } catch { return { error: 'That message is gone.' }; }
    drop(id);
    await read(id, bytes);
    // Other messages waiting from the same sender come in too.
    for (const o of st.held.filter((x) => x.from === h.from && !x.unverified)) await held({ id: o.id, allow: true });
    return { ok: true };
  }

  // ---- the cloud's address ----
  function mailKey() {
    try { return JSON.parse(fs.readFileSync(KEY, 'utf8')); } catch {}
    const k = newMailKey();
    fs.mkdirSync(path.dirname(KEY), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY, JSON.stringify(k), { mode: 0o600 });
    return k;
  }
  const linked = () => !!cloud?.credential?.();
  /** On by default: once linked, the cloud gets this tablet's mail key and gives the address (and the account's sign-in
   *  addresses, approved from the start). */
  async function ensure() {
    if (!linked() || st.off) return;
    const k = mailKey();
    if (st.cloud?.key === k.pub && st.cloud?.address) return;
    const r = await cloud.mailApi('POST', '/v1/mail', { on: true, key: k.pub });
    st.cloud = { address: String(r.address || ''), hashKey: String(r.hashKey || ''), key: k.pub };
    for (const a of Array.isArray(r.accounts) ? r.accounts : []) { const x = String(a).trim().toLowerCase(); if (EMAIL.test(x) && !whoOf(x)) st.senders.push({ address: x, who: '', account: true }); }
    save();
    await syncSenders();
  }
  async function syncSenders() {
    if (!linked() || st.off || !st.cloud?.hashKey) return;
    try { await cloud.mailApi('PUT', '/v1/mail/senders', { senders: st.senders.slice(0, 50).map((s) => senderHash(st.cloud.hashKey, s.address)) }); }
    catch (e) { log(`[mail] senders: ${e.message}`); }
  }
  let polling = null;
  /** What's waiting in the cloud: fetched, opened with the mail key, read; then removed there. */
  function poll() {
    if (polling) return polling;
    polling = (async () => {
      try {
        await ensure();
        if (!linked() || st.off || !st.cloud?.address) return;
        const k = mailKey();
        for (const w of (await cloud.mailApi('GET', '/v1/mail/waiting')) || []) {
          const key = String(w?.key || '');
          try {
            const sealed = await cloud.mailFetch(key);
            let bytes = null; try { bytes = open(k, sealed); } catch { log('[mail] a message sealed for another key was left out'); }
            if (bytes) await receive(bytes, 'cloud');
            await cloud.mailApi('POST', '/v1/mail/done', { key });
          } catch (e) { log(`[mail] fetch: ${e.message}`); }
        }
      } catch (e) { if (e.code !== 'unlinked' && e.code !== 'http404') log(`[mail] ${e.message}`); }
      finally { polling = null; }
    })();
    return polling;
  }

  // ---- upkeep: held after 3 days and recent after a week go; unread ones are read once there's an assistant ----
  async function tidy() {
    const t = now();
    for (const h of st.held.filter((x) => t - x.at > LIMITS.heldDays * DAY)) drop(h.id);
    st.held = st.held.filter((x) => t - x.at <= LIMITS.heldDays * DAY);
    for (const r of st.recent.filter((x) => t - x.at > LIMITS.recentDays * DAY)) drop(r.id);
    st.recent = st.recent.filter((x) => t - x.at <= LIMITS.recentDays * DAY);
    st.notes = st.notes.filter((x) => t - x.at <= LIMITS.recentDays * DAY);
    save();
    for (const r of st.recent.filter((x) => x.unread && !x.retried)) {
      r.retried = true; save();
      try { await read(r.id, fs.readFileSync(raw(r.id))); } catch {}
    }
  }
  const timer = every ? setInterval(() => { tidy().catch(() => {}); poll(); }, every) : null;
  timer?.unref?.();
  if (every) setTimeout(() => { tidy().catch(() => {}); poll(); }, 5e3).unref?.();

  // ---- Settings → Email ----
  function view() {
    return {
      cloud: linked() ? { on: !st.off, address: st.off ? null : st.cloud?.address || null } : null,
      own: !!st.own,
      senders: st.senders.map(({ address, who, account }) => ({ address, who, ...(account ? { account: true } : {}) })),
      held: st.held.map(({ id, from, name, subject, at, unverified }) => ({ id, from, name, subject, at, ...(unverified ? { unverified: true } : {}) })),
      recent: st.recent.slice().reverse().map(({ id, from, who, subject, at, photos, events, unread }) => ({ id, from, who, subject, at, photos, events, ...(unread ? { unread: true } : {}) })),
      notes: st.notes.map((n) => n.text),
      limits: LIMITS,
    };
  }
  async function set(b) {
    if (Array.isArray(b.senders)) {
      const seen = new Set();
      st.senders = b.senders.slice(0, 50).map((s) => String(s?.address || '').trim().toLowerCase())
        .map((address) => ({ address, who: String(b.senders.find((s) => String(s?.address || '').trim().toLowerCase() === address)?.who || '').trim().slice(0, 40), ...(whoOf(address)?.account ? { account: true } : {}) }))
        .filter((s) => EMAIL.test(s.address) && !seen.has(s.address) && seen.add(s.address));
      save(); await syncSenders();
    }
    if (typeof b.own === 'boolean') { st.own = b.own; save(); }
    if (b.on === false && linked()) {
      try { await cloud.mailApi('POST', '/v1/mail', { on: false }); } catch (e) { return { error: e.message }; }
      st.off = true; st.cloud = null; save();
    }
    if (b.on === true) { st.off = false; st.cloud = null; save(); try { await ensure(); } catch (e) { return { error: e.message }; } }
    if (b.address !== undefined && linked() && !st.off) {
      const a = String(b.address).trim().toLowerCase();
      if (a !== 'new' && !/^[a-z0-9-]{4,30}$/.test(a)) return { error: 'An address is 4 to 30 letters, digits or dashes.' };
      try { const r = await cloud.mailApi('POST', '/v1/mail', { address: a }); st.cloud = { ...st.cloud, address: String(r.address || '') }; save(); }
      catch (e) { return { error: e.message }; }
    }
    return { ok: true, ...view() };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!/^\/mail(\/|$)/.test(p)) return false;
    if (req.headers['x-openhouse-app']) { json(res, 403, { error: 'Only the display can do that.' }); return true; }
    if (req.method === 'GET' && p === '/mail') { json(res, 200, view()); return true; }
    if (req.method !== 'POST') { json(res, 405, { error: 'POST' }); return true; }
    const b = await body(req);
    if (p === '/mail/set') { const r = await set(b); json(res, r.error ? 400 : 200, r); return true; }
    if (p === '/mail/held') { const r = await held({ id: String(b.id || ''), allow: !!b.allow }); json(res, r.error ? 400 : 200, r); return true; }
    if (p === '/mail/incoming') {
      if (!st.own) { json(res, 409, { error: 'No mailbox is set up here.' }); return true; }
      const bytes = Buffer.from(String(b.raw || ''), 'base64');
      if (!bytes.length) { json(res, 400, { error: 'no message' }); return true; }
      try { json(res, 200, await receive(bytes, 'imap')); } catch (e) { json(res, 500, { error: String(e.message || e).slice(0, 120) }); }
      return true;
    }
    json(res, 404, { error: 'not found' }); return true;
  }

  return { handle, receive, held, poll, tidy, view, set, nudge: () => poll(), stop: () => timer && clearInterval(timer) };
}
