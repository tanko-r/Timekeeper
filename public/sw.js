// App-shell service worker. This is NOT an offline data layer: Timekeeper is
// server-backed (SQLite over /api), so every /api/ request must always hit
// the live server — the SW never intercepts, caches, or serves it. What this
// SW gives you is fast/offline-tolerant loading of the static shell (React
// runtime, htm, app JS/CSS, icons) so the app opens instantly and installs
// as a standalone PWA. No writes are ever queued or replayed while offline.
//
// Bump CACHE to invalidate all previously cached shell assets on next visit.
const CACHE = 'timekeeper-v28';

// Same-origin static assets pre-cached on install. Keep this list in sync
// with the actual public/ tree (index.html, css, vendor, and every js/**
// module — hash routing means the whole module graph can be requested on
// first paint, so it's all worth pre-caching).
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './css/app.css',
  './vendor/htm.module.js',
  './vendor/react-dom.production.min.js',
  './vendor/react.production.min.js',
  './js/api.js',
  './js/app.js',
  './js/icons.js',
  './js/ui.js',
  './js/components/closeout.js',
  './js/components/cmpicker.js',
  './js/components/entryeditor.js',
  './js/components/entrylist.js',
  './js/components/feedback.js',
  './js/components/ghosttext.js',
  './js/components/quickcapture.js',
  './js/components/shortcuts.js',
  './js/components/stopchips.js',
  './js/components/targetmeter.js',
  './js/components/timergrid.js',
  './js/components/timerimport.js',
  './js/components/todayfooter.js',
  './js/lib/daterange.js',
  './js/lib/expand.js',
  './js/lib/ghost.js',
  './js/lib/narrativesync.js',
  './js/lib/notify.js',
  './js/lib/pip.js',
  './js/lib/tick.js',
  './js/lib/titlebar.js',
  './js/lib/timeamounts.js',
  './js/views/calendar.js',
  './js/views/cms.js',
  './js/views/dashboard.js',
  './js/views/day.js',
  './js/views/exportview.js',
  './js/views/login.js',
  './js/views/search.js',
  './js/views/settings.js',
  './js/views/stats.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept the API — auth, timers, entries, exports must always be
  // live. This also keeps cookie-authed remote (cloudflared) requests honest:
  // no cached JSON is ever served in place of a real network round-trip.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  // Cross-origin requests (none expected today, but be conservative) also
  // pass straight through rather than being cached.
  if (url.origin !== self.location.origin) return;

  // Cache-first, network-fallback for same-origin static assets.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type !== 'opaque') {
        e.waitUntil(cache.put(req, res.clone()));
      }
      return res;
    } catch (err) {
      const fallback = await cache.match(req, { ignoreVary: true });
      if (fallback) return fallback;
      throw err;
    }
  })());
});
