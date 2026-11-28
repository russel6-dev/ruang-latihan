// Service worker: bikin aplikasi tetap bisa dibuka tanpa internet (di studio, dsb),
// dan mengatur update: versi baru diunduh utuh di belakang layar, lalu aktif saat kamu ketuk "Update".
// VERSION diganti otomatis saat diterbitkan (lihat .github/workflows/pages.yml).
const VERSION = 'rl-dev';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/api.js', 'js/db.js', 'js/player.js', 'js/grid.js', 'js/export.js', 'js/mp3worker.js', 'js/recorder.js', 'js/rec-ui.js', 'js/capture-worklet.js',
  'vendor/lame.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' = ambil langsung dari server, bukan dari cache HTTP browser
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // Peralihan dari versi lama (yang belum punya tombol update): langsung aktif seperti dulu.
    const keys = await caches.keys();
    if (keys.some((k) => /^rl-v\d+$/.test(k))) self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'VERSION') e.source?.postMessage({ type: 'VERSION', version: VERSION });
});

// Selalu dari cache versi ini (file satu versi nggak pernah campur dengan versi lain).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/models/')) return; // model AI disimpan sendiri oleh halaman uji (besar)
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.slice(scope.pathname.length);
  // Halaman lain di bawah aplikasi (mis. /uji/) jangan diganggu: langsung ke internet.
  if (rel.includes('/') && !/^(js|icons|vendor)\//.test(rel)) return;
  const isAppPage = rel === '' || rel === 'index.html';
  if (req.mode === 'navigate' && !isAppPage) return;
  const key = req.mode === 'navigate' ? new URL('index.html', scope).href : req;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    } catch {
      return new Response('Offline', { status: 503 });
    }
  })());
});
