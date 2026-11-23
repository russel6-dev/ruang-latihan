// Service worker: bikin aplikasi tetap bisa dibuka tanpa internet (di studio, dsb).
const VERSION = 'rl-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/api.js', 'js/db.js', 'js/player.js', 'js/grid.js', 'js/export.js', 'js/mp3worker.js',
  'vendor/lame.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  const key = req.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : req;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      e.waitUntil(network);
      return cached;
    }
    return (await network) || new Response('Offline', { status: 503 });
  })());
});
