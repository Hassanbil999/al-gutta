// Offline support: app files come from the network when online, from the cache when offline.
// Bump VERSION when you deploy changes.
const VERSION = 'qy-v11';
const SHELL = [
  './', './index.html', './css/style.css', './config.js',
  './js/app.js', './js/store.js', './js/i18n.js', './js/qamariya.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return; // the database is always live

  // app files: network first (so updates show right away), cache when offline
  if (sameOrigin) {
    const key = req.mode === 'navigate' ? './index.html' : req;
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key)));
    return;
  }
  // fonts: cache first
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy));
    return res;
  })));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const hash = e.notification.data?.hash || '#/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const c = list[0];
    if (c) { c.navigate(new URL('./' + hash, self.registration.scope).href).catch(() => {}); return c.focus(); }
    return self.clients.openWindow('./' + hash);
  }));
});
