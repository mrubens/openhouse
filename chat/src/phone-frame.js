// An app's frame on someone's phone (docs/phones.md, "Every app on the phone"). The phone's page (phone.jsx) makes an
// <iframe sandbox="allow-scripts"> of this page: no origin of its own (an opaque one), so the app can't read the
// phone's key, its storage, or another app's frame, and this page's rules (screens.js frameHeaders, the cloud's
// /h/frame.html) let it reach nothing on the network. The app's files come from the phone's page by message (it has
// them sealed from the tablet, kept by version), and this page runs them: each file a blob: URL made here, its imports
// and its CSS's url()s pointing at those, and the app's own page written in place of this one. The kit in it asks the
// phone's page for everything (/kit/openhouse.js, SCREEN), and the phone's page marks each call with this frame's app.
//
// Messages: to the page {oh: 'ready'} once loaded, {oh: 'ls', data} (its localStorage, kept per app by the page),
// {oh: 'failed', text}; from the page {oh: 'bundle', files: {rel: {t, s} | {t, b}}, ls}.
const BASE = 'https://app.invalid/'; // where the app's own files seem to be (nothing is ever fetched from it)
const real = (p) => new URL(p, location.href).href; // the page this came from (the tablet's, or the cloud's)

let files = {}; const made = new Map(), making = new Set();
const relOf = (u) => {
  let x; try { x = new URL(u, document.baseURI || BASE); } catch { return null; }
  if (x.href.startsWith(BASE)) return decodeURIComponent(x.pathname.slice(1)).replace(/^apps\/[a-z0-9-]+\//, '');
  return null;
};
const bytes = (f) => (f.s != null ? new TextEncoder().encode(f.s) : Uint8Array.from(atob(f.b), (c) => c.charCodeAt(0)));
const isJs = (rel, f) => /\.m?js$/.test(rel) || /javascript/.test(f.t);

// import x from './a.js', import './a.js', export * from '../b.js', import('./c.js'): to the blob: URL of that file.
const SPEC = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g;
function js(rel, text) {
  return text.replace(SPEC, (all, head, q, spec) => {
    if (!/^(\.{1,2}\/|\/)/.test(spec)) return all; // a package or a full address: as it was (it won't load here)
    const r = relOf(new URL(spec, BASE + rel).href);
    const u = r != null && urlOf(r);
    return u ? head + q + u + q : all;
  });
}
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
function css(rel, text) {
  return text.replace(CSS_URL, (all, q1, u1, q2, u2) => {
    const spec = u1 || u2;
    if (/^(data|blob|https?):/i.test(spec) || spec.startsWith('#')) return all;
    const abs = new URL(spec, BASE + rel).href, r = relOf(abs);
    // The kit's fonts aren't sent: the page this came from has them (the tablet's /kit/; from away, the faces fall back).
    const u = (r != null && urlOf(r)) || (r?.startsWith('kit/') ? real('/' + r) : null);
    return u ? (u1 ? `url("${u}")` : `@import "${u}"`) : all;
  });
}
/** The blob: URL for one of the app's files (made once), or null when it has no such file. */
function urlOf(rel) {
  if (made.has(rel)) return made.get(rel);
  const f = files[rel];
  if (!f || making.has(rel)) return null; // (a file that imports itself round a loop: left out)
  making.add(rel);
  let body;
  if (f.s != null && isJs(rel, f)) body = js(rel, f.s);
  else if (f.s != null && /\.css$/.test(rel)) body = css(rel, f.s);
  else body = bytes(f);
  making.delete(rel);
  const u = URL.createObjectURL(new Blob([body], { type: f.t }));
  made.set(rel, u);
  return u;
}
const swap = (v) => { const r = v == null ? null : relOf(String(v)); return (r != null && urlOf(r)) || v; };

/** Every way the app's page names one of its own files after it's written: to its blob: URL. */
function shims(app, ls) {
  // Storage: an opaque origin has none. The app's localStorage is kept by the phone's page, under this app only.
  const store = (data, save) => {
    const m = new Map(Object.entries(data || {}));
    const s = { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); save(m); }, removeItem: (k) => { m.delete(String(k)); save(m); },
      clear: () => { m.clear(); save(m); }, key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
    return new Proxy(s, { get: (t, k) => (k in t ? t[k] : t.getItem(k)), set: (t, k, v) => { t.setItem(k, v); return true; } });
  };
  let t = 0;
  const local = store(ls, (m) => { clearTimeout(t); t = setTimeout(() => parent.postMessage({ oh: 'ls', data: Object.fromEntries(m) }, '*'), 300); });
  for (const [k, v] of [['localStorage', local], ['sessionStorage', store({}, () => {})]]) { try { Object.defineProperty(window, k, { configurable: true, get: () => v }); } catch {} }
  for (const k of ['indexedDB', 'caches']) { try { Object.defineProperty(window, k, { configurable: true, get: () => undefined }); } catch {} }

  // fetch('./words.json'): from its files; anything else goes nowhere (connect-src 'none').
  const net = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const r = relOf(input instanceof Request ? input.url : String(input));
    if (r != null) { const f = files[r]; return Promise.resolve(f ? new Response(bytes(f), { status: 200, headers: { 'content-type': f.t } }) : new Response('Not found', { status: 404 })); }
    return net(input, init);
  };
  const W = window.Worker;
  if (W) window.Worker = function Worker(u, o) { return new W(swap(u), o); };
  const A = window.Audio;
  if (A) window.Audio = function Audio(u) { return u === undefined ? new A() : new A(swap(u)); };
  for (const [C, prop] of [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLLinkElement, 'href'], [HTMLVideoElement, 'poster']]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, prop);
    if (d?.set) Object.defineProperty(C.prototype, prop, { ...d, set(v) { d.set.call(this, swap(v)); } });
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (k, v) { return setAttr.call(this, k, /^(src|href|poster)$/i.test(k) && !(this instanceof HTMLAnchorElement) ? swap(v) : v); };
  window.open = () => null;
  void app;
}
/** Elements added later from HTML text (innerHTML): their own files too. */
function watch() {
  const fix = (el) => { for (const k of ['src', 'href', 'poster']) { if (el.hasAttribute?.(k) && !(el instanceof HTMLAnchorElement)) { const v = el.getAttribute(k), s = swap(v); if (s !== v) el.setAttribute(k, s); } } };
  const restyle = (st) => { const t = st.textContent, n = css('index.html', t); if (n !== t) st.textContent = n; }; // (the kit's @font-face, a style an app adds)
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'attributes') fix(m.target);
      else if (m.target.nodeName === 'STYLE') restyle(m.target);
      else for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.nodeName === 'STYLE') restyle(n); fix(n); n.querySelectorAll?.('[src],[href],[poster]').forEach(fix); n.querySelectorAll?.('style').forEach(restyle); }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'href', 'poster'] });
}
/** The app's index.html, with its own files as blob: URLs and nothing it could use to go elsewhere. */
function page() {
  const html = files['index.html']?.s;
  if (html == null) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const b of doc.querySelectorAll('base')) b.remove();
  const base = doc.createElement('base'); base.href = BASE; doc.head.prepend(base);
  for (const el of doc.querySelectorAll('[src],[href],[poster]')) for (const k of ['src', 'href', 'poster']) {
    if (!el.hasAttribute(k) || el.tagName === 'A' || el.tagName === 'BASE') continue;
    const v = el.getAttribute(k); const r = relOf(new URL(v, BASE).href); const u = r != null && urlOf(r);
    if (u) el.setAttribute(k, u);
  }
  // Inline scripts and styles: their imports and url()s too (scripts as files of their own, so nothing runs inline).
  let n = 0;
  for (const s of doc.querySelectorAll('script:not([src])')) {
    const rel = `inline-${n++}.js`, text = s.type === 'module' ? js('index.html', s.textContent) : s.textContent;
    s.src = URL.createObjectURL(new Blob([text], { type: 'text/javascript' })); s.textContent = ''; void rel;
  }
  for (const s of doc.querySelectorAll('style')) s.textContent = css('index.html', s.textContent);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

function failed(text) { parent.postMessage({ oh: 'failed', text: String(text || '').slice(0, 300) }, '*'); }
addEventListener('message', function first(e) {
  if (e.source !== parent || e.data?.oh !== 'bundle') return;
  removeEventListener('message', first);
  files = e.data.files || {};
  const html = page();
  if (!html) return failed('no index.html');
  shims(e.data.app, e.data.ls);
  document.open();
  watch();
  addEventListener('error', (ev) => failed(ev.message || 'error')); // (the page notes it; the app may well go on)
  document.write(html);
  document.close();
});
parent.postMessage({ oh: 'ready' }, '*');
