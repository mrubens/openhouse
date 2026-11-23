// The phone page's service worker (chat/src/phone.jsx): the page opens with no signal (its files from here, its data
// from the page's own last copy), and a note from the tablet shows as a notification (Web Push, bridge/web-push.js).
const CACHE = 'openhouse-phone-1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !(/^\/(phone|app)\//.test(u.pathname) || u.pathname.startsWith(new URL(self.registration.scope).pathname))) return;
  // The page itself from the network first (a new version shows the next time it opens, not the time after), the kept
  // copy when there's no signal or it takes over 4 s; its other files from the kept copy first, refreshed behind.
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
      const slow = new Promise((ok) => setTimeout(ok, 4000)).then(() => c.match(e.request, { ignoreSearch: true }));
      try { return (await Promise.race([net, slow])) || await net; } catch { return (await c.match(e.request, { ignoreSearch: true })) || Response.error(); }
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
self.addEventListener('push', (e) => {
  let m = {}; try { m = e.data.json(); } catch { m = { title: 'OpenHouse', body: e.data?.text() || '' }; }
  // open: what a tap opens ('opie:<conversation>': Opie's answer to something shared, to answer back).
  const open = /^opie:[\w-]{1,40}$/.test(String(m.open || '')) ? m.open : '';
  e.waitUntil(self.registration.showNotification(m.title || 'OpenHouse', { body: m.body || '', tag: m.tag, icon: 'icon.svg', data: { open } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const open = e.notification.data?.open || '';
  e.waitUntil(clients.matchAll({ type: 'window' }).then((w) => {
    if (w[0]) { if (open) w[0].postMessage({ open }); return w[0].focus(); }
    return clients.openWindow(open ? `./?open=${encodeURIComponent(open)}` : './');
  }));
});
