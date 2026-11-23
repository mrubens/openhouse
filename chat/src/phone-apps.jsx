// The household's apps on someone's phone (docs/phones.md, "Every app on the phone"): each runs in a frame of its own
// (phone-frame.js) with no origin of its own, and everything it asks for comes through here, marked with the app of
// the frame it came from (never what the frame says), sealed with this phone's key. The tablet answers only what that
// app may do (its rights, as on the tablet) and only what this phone may (its scopes: a kid's ticks, a TV only reads).
// An app's files are kept here by their version, so a tab opens at once the second time, with no signal too.
import { useEffect, useRef, useState } from 'react';
import { Removed } from './screen-client.js';
import { paletteOf, worldOf } from './look.js';

const get = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
export const DEFAULT_TABS = ['today', 'calendar', 'weather', 'map', 'chores', 'lists', 'meals', 'recipes', 'photos', 'whiteboard', 'apps'];
const APPS = 'openhouse.phone.apps', STYLE = 'openhouse.phone.style';

/** The apps this phone runs ([{id, name, icon, tabIcon, shared, v}]): the last list until the tablet answers. */
export function usePhoneApps(c, door) {
  const [apps, setApps] = useState(() => get(APPS, null));
  useEffect(() => {
    let stop = false;
    (async () => {
      while (!stop) {
        try { const r = await c.json('GET', '/screens/apps'); if (r.status === 200 && Array.isArray(r.json)) { setApps(r.json); put(APPS, r.json); } } catch {}
        await new Promise((ok) => setTimeout(ok, 60e3));
      }
    })();
    return () => { stop = true; };
  }, [c]);
  const [style, setStyle] = useState(() => get(STYLE, null));
  useEffect(() => { if (door?.style) { setStyle(door.style); put(STYLE, door.style); } }, [door?.style]);
  return { apps, style };
}

/** The household's tabs in the tablet's order, those this phone has: [{id, name, app?}]. */
export function phoneTabs(style, apps) {
  const by = new Map((apps || []).map((a) => [a.id, a]));
  return (style?.tabs || DEFAULT_TABS.map((id) => ({ id })))
    .map((t) => (typeof t === 'string' ? { id: t } : t)).map((t) => (t.id === 'board' ? { ...t, id: 'apps' } : t))
    .filter((t) => t.id === 'today' || t.id === 'apps' || by.has(t.id) || !apps)
    .map((t) => ({ id: t.id, name: t.name || (t.id === 'today' ? 'Today' : t.id === 'apps' ? 'Apps' : by.get(t.id)?.name || t.id), app: by.get(t.id) || null }));
}

// ---- the apps' files, kept on the phone by version (IndexedDB: the Wi-Fi page is plain http, so no Cache Storage) ----
let db = null;
const idb = () => (db ||= new Promise((ok, no) => {
  try { const r = indexedDB.open('openhouse-apps', 1); r.onupgradeneeded = () => r.result.createObjectStore('b'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); } catch (e) { no(e); }
}));
const tx = async (mode, f) => { const d = await idb(); return new Promise((ok, no) => { const t = d.transaction('b', mode), r = f(t.objectStore('b')); t.oncomplete = () => ok(r?.result); t.onerror = () => no(t.error); }); };
const loading = new Map();
/** An app's files ({v, files}): kept, else asked for (one at a time per app) and kept, the older versions let go. */
export function appBundle(c, app) {
  const k = `${app.id}@${app.v}`;
  if (loading.has(k)) return loading.get(k);
  const p = (async () => {
    const kept = await tx('readonly', (s) => s.get(k)).catch(() => null);
    if (kept?.files) return kept;
    const r = await c.json('GET', '/screens/app-files?app=' + encodeURIComponent(app.id), undefined, { big: true });
    if (r.status !== 200 || !r.json?.files) throw new Error('no files');
    const b = { v: r.json.v, files: r.json.files };
    tx('readwrite', (s) => { s.put(b, k); const all = s.getAllKeys(); all.onsuccess = () => { for (const x of all.result) if (String(x).startsWith(app.id + '@') && x !== k) s.delete(x); }; }).catch(() => {});
    return b;
  })();
  loading.set(k, p); p.catch(() => loading.delete(k));
  return p;
}

// ---- one app in its frame ------------------------------------------------------------------------------------------
const FRAME = document.querySelector('meta[name="openhouse-relay"]') ? '/h/frame.html' : '/phone/frame.html';
const lsKey = (id) => 'openhouse.phone.ls.' + id;
const houseKey = (id) => 'openhouse.phone.house.' + id; // what this app last saw of the house (as cut for it), for no signal
/** What the kit takes from its address: the household's colors and type, and that it's on a phone. */
export function frameHash(style, app) {
  const p = paletteOf(style);
  return new URLSearchParams({ screen: '1', kind: 'phone', bg: worldOf(style, app?.id), panel: p.sheet, ink: p.ink, accent: p.accent, face: style?.type || 'clean', ...(style?.palette === 'dusk' ? { dark: '1' } : {}) }).toString();
}
// A change made with no signal waits and goes when the phone is back (only ticks and adds, as the phone always did).
const WAITS = /^\/house\/(list|chore)$/;

/**
 * One app, running in its frame. onOpen(id): it asked for another of the household's apps (an app from a link may
 * open only itself); onQueue({p, b, a}): a change to send later; onClose: its own Close.
 */
export function AppFrame({ c, app, style, hidden = false, onOpen, onClose, onQueue, onRemoved }) {
  const ref = useRef(null);
  const [gen, setGen] = useState(0), [state, setState] = useState('loading');
  useEffect(() => {
    const frame = ref.current;
    if (!frame || !app?.v) return;
    let sent = false, loads = 0, gone = false, firstHouse = false;
    // How long each part of opening it took (window.__ohOpen[app]: ms from the frame's start), for looking into speed.
    const t0 = performance.now(), T = ((window.__ohOpen ||= {})[app.id] = { at: Date.now() }), mark = (k) => { if (T[k] == null) T[k] = Math.round(performance.now() - t0); };
    const bundle = appBundle(c, app);
    bundle.then(() => mark('files'), () => {});
    bundle.catch(() => { if (!gone) setState('offline'); });
    const again = () => { if (!gone) setGen((g) => g + 1); };
    // It went somewhere else (it set its own address): a new frame, from the start. Nothing it read goes with it. (Two
    // loads are its own: the starting page, then the app's page written in its place. The page's frame-src keeps it
    // to this page's own address anyway.)
    const onLoad = () => { if (++loads > 2) again(); };
    frame.addEventListener('load', onLoad);
    const to = (m, t) => { try { frame.contentWindow?.postMessage(m, '*', t); } catch {} }; // (an opaque origin: '*' to this one frame)
    async function call(m) {
      const p = String(m.p || ''), method = m.m === 'POST' ? 'POST' : 'GET';
      if (!p.startsWith('/') || p.length > 2000) return to({ oh: 'reply', id: m.id, status: 400 });
      // Its first look at the house: what it saw last time, at once (its next /house/wait then answers straight away
      // with what's new, as the version it gives is old).
      const kept0 = method === 'GET' && p === '/house' && !firstHouse && get(houseKey(app.id));
      if (method === 'GET' && p === '/house') firstHouse = true;
      if (kept0 && Date.now() - kept0.at < 7 * 864e5) { mark('data'); mark('house'); return to({ oh: 'reply', id: m.id, status: 200, type: 'application/json', body: kept0.body }); }
      const t1 = performance.now();
      try {
        const r = await c.request(method, p, method === 'POST' ? m.b ?? {} : undefined, { app: app.id, big: method === 'GET' && p.startsWith('/house/photo/') });
        if (method === 'GET' && r.status === 200 && /^\/house(\/wait)?(\?|$)/.test(p)) put(houseKey(app.id), { body: new TextDecoder().decode(r.body), at: Date.now() });
        const body = r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength);
        to({ oh: 'reply', id: m.id, status: r.status, type: r.type, body }, [body]);
        if ((T.calls ||= []).length < 20) T.calls.push([p.slice(0, 40), Math.round(t1 - t0), Math.round(performance.now() - t1)]);
        mark('data'); if (/^\/house(\?|$)/.test(p)) mark('house');
      } catch (e) {
        if (e instanceof Removed) { onRemoved?.(); return; }
        // No signal: what it last saw of the house, a tick that waits, else a plain no.
        const kept = get(houseKey(app.id));
        if (method === 'GET' && p === '/house' && kept) return to({ oh: 'reply', id: m.id, status: 200, type: 'application/json', body: kept.body });
        if (method === 'GET' && p.startsWith('/house/wait')) { await new Promise((ok) => setTimeout(ok, 15e3)); return to({ oh: 'reply', id: m.id, status: 503 }); }
        if (method === 'POST' && WAITS.test(p) && onQueue) { onQueue({ p, b: m.b ?? {}, a: app.id }); return to({ oh: 'reply', id: m.id, status: 200, type: 'application/json', body: '{"ok":true,"waiting":true}' }); }
        to({ oh: 'reply', id: m.id, status: 503 });
      }
    }
    const on = async (e) => {
      if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
      const m = e.data;
      if (m.oh === 'ready') {
        if (sent) return again(); // started over without a new frame: a fresh one instead
        sent = true; mark('frame');
        try { const b = await bundle; if (!gone) { to({ oh: 'bundle', app: app.id, files: b.files, ls: get(lsKey(app.id), {}) }); mark('boot'); setState('ready'); } } catch {}
      }
      else if (m.oh === 'call' && Number.isSafeInteger(m.id)) call(m);
      else if (m.oh === 'ls' && m.data && typeof m.data === 'object') { const s = JSON.stringify(m.data); if (s.length < 2e6) put(lsKey(app.id), m.data); }
      else if (m.oh === 'failed') console.warn(`[${app.id}]`, String(m.text || '').slice(0, 300));
      else if (m.oh === 'close') onClose?.();
      else if (m.openhouse === 'open' && /^[a-z0-9][a-z0-9-]{0,60}$/.test(String(m.app || ''))) { if (!app.shared || m.app === app.id) onOpen?.(String(m.app)); }
    };
    addEventListener('message', on);
    return () => { gone = true; removeEventListener('message', on); frame.removeEventListener('load', onLoad); };
  }, [c, app?.id, app?.v, gen]);
  if (!app) return null;
  return (
    <div className="appframe" hidden={hidden}>
      {state === 'offline' && <p className="soft pad">{app.name} opens here once the phone is in touch with home.</p>}
      <iframe ref={ref} key={`${app.id}@${app.v}#${gen}`} title={app.name} className={state === 'ready' ? 'ready' : ''}
        sandbox="allow-scripts allow-forms allow-modals" allow="clipboard-write" referrerPolicy="no-referrer" src={`${FRAME}${app.reaches?.length ? '?r=' + encodeURIComponent(app.reaches.join(',')) : ''}#${frameHash(style, app)}`} />
    </div>
  );
}

/** An app's icon: its own svg (as a picture, so nothing in it runs), else its first letter. */
export function AppIcon({ app, name }) {
  return app?.icon ? <img className="app-icon" src={`data:image/svg+xml,${encodeURIComponent(app.icon)}`} alt="" draggable={false} />
    : <span className="app-icon letter">{String(name || app?.name || '?')[0].toUpperCase()}</span>;
}
