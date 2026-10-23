// Offline support: app files load from cache, then refresh in the background.
// Bump VERSION when you deploy changes.
const VERSION = 'qy-v1';
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

  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const key = sameOrigin && req.mode === 'navigate' ? './index.html' : req;
    const hit = await cache.match(key);
    const net = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(key, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
