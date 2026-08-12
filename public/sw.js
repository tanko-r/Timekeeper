// App-shell service worker. This is NOT an offline data layer: Timekeeper is
// server-backed (SQLite over /api), so every /api/ request must always hit
// the live server — the SW never intercepts, caches, or serves it. What this
// SW gives you is fast/offline-tolerant loading of the static shell (React
// runtime, htm, app JS/CSS, icons) so the app opens instantly and installs
// as a standalone PWA. No writes are ever queued or replayed while offline.
//
// Bump CACHE to invalidate all previously cached shell assets on next visit.
const CACHE = 'timekeeper-v87';

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
  './vendor/inter/InterVariable.woff2',
  './vendor/inter/InterVariable-Italic.woff2',
  './vendor/clockface/NotoSansNum-Regular.woff2',
  './vendor/clockface/NotoSansNum-Bold.woff2',
  './vendor/htm.module.js',
  './vendor/react-dom.production.min.js',
  './vendor/react.production.min.js',
  './js/api.js',
  './js/app.js',
  './js/icons.js',
  './js/ui.js',
  './js/components/closeout.js',
  './js/components/cmpicker.js',
  './js/components/customfields.js',
  './js/components/entryeditor.js',
  './js/components/entrylist.js',
  './js/components/feedback.js',
  './js/components/ghosttext.js',
  './js/components/quickcapture.js',
  './js/components/shortcuts.js',
  './js/components/stopchips.js',
  './js/components/summary.js',
  './js/components/targetmeter.js',
  './js/components/timergrid.js',
  './js/components/timerimport.js',
  './js/components/todayfooter.js',
  './js/lib/activity.js',
  './js/lib/daterange.js',
  './js/lib/daysummary.js',
  './js/lib/expand.js',
  './js/lib/ghost.js',
  './js/lib/narrativesync.js',
  './js/lib/notify.js',
  './js/lib/pip.js',
  './js/lib/tick.js',
  './js/lib/timersort.js',
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

// Filling a NEW cache generation must go to the network, not to whatever the
// browser already has. cache.addAll() reads through the HTTP cache, so a
// client holding a still-fresh copy of a shell file would re-cache those exact
// stale bytes under the new CACHE name — and since the fetch handler below is
// cache-first with no revalidation, it would then serve them forever. That is
// not hypothetical: remote clients get Cloudflare's max-age=14400 on these
// files, so a CACHE bump silently pinned four-hour-old JS. {cache: 'reload'}
// bypasses the HTTP cache for exactly these requests. Non-ok responses reject
// the install (as addAll did), leaving the previous worker in charge.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(`shell fetch failed: ${url} → ${res.status}`);
      await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
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

  // Navigations are network-FIRST (cache only as an offline fallback). Serving
  // the shell from cache here hides the one thing a navigation is for: finding
  // out we're no longer allowed in. Remote clients sit behind Cloudflare
  // Access, and when that session lapses every request 302s to
  // cloudflareaccess.com. A cached navigation meant the login page never
  // rendered — the shell painted normally and then every /api/ call died on a
  // cross-origin redirect the browser won't follow, surfacing as "Failed to
  // fetch". The app reported a server outage while the server was healthy
  // (2026-08-02). Passing the real response through lets that 302 do its job:
  // an expired session lands on the Access login instead of a false error.
  // The redirect arrives as an opaqueredirect (navigations fetch with
  // redirect: 'manual'); returning it hands the browser the hop to follow, and
  // its status 0 keeps it out of the cache on its own.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.status === 200 && res.type === 'basic') {
          e.waitUntil(caches.open(CACHE).then((c) => c.put(req, res.clone())));
        }
        return res;
      } catch (err) {
        // Genuinely offline: fall back to the precached shell so the PWA still
        // opens (it will show its own "can't reach server" state).
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req, { ignoreVary: true })
          || await cache.match('./index.html', { ignoreVary: true })
          || await cache.match('./', { ignoreVary: true });
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

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
