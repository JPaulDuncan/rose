/**
 * App service worker — caches the SPA shell + recently fetched
 * pages/digest/me responses so the app loads offline and previously
 * viewed wiki pages stay readable on a plane. Distinct from
 * /push-sw.js which only handles WebPush notifications.
 *
 * Strategies:
 *   - HTML / JS / CSS app shell: stale-while-revalidate
 *   - GET /api/pages/by-slug/*: stale-while-revalidate (offline reads)
 *   - GET /api/me, /api/digest, /api/codex, /api/me/favorites:
 *     network-first, fallback to cache so the app boots offline
 *   - Other /api: network only (no cache, no offline)
 *
 * Cache name is bumped on every deploy by the build hash that Vite
 * fingerprints into the asset filenames; old caches drop on activate.
 */

const SHELL_CACHE = 'rose-shell-v1';
const PAGE_CACHE = 'rose-pages-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(['/', '/index.html', '/rose.svg', '/manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => ![SHELL_CACHE, PAGE_CACHE].includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const PAGE_PATHS = [
  /^\/api\/pages\/by-slug\//,
  /^\/api\/me\/?(?:\?|$)/,
  /^\/api\/me\/favorites/,
  /^\/api\/digest/,
  /^\/api\/codex/,
];

function matchesPagePath(url) {
  return PAGE_PATHS.some((re) => re.test(url.pathname));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin only — never intercept third-party requests (analytics,
  // images, anything cross-origin).
  if (url.origin !== self.location.origin) return;

  // Asset / shell files: stale-while-revalidate.
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/rose.svg' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetcher = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached ?? (await fetcher) ?? new Response('Offline', { status: 503 });
      }),
    );
    return;
  }

  // Cached API endpoints: network-first → cache fallback.
  if (url.pathname.startsWith('/api/') && matchesPagePath(url)) {
    event.respondWith(
      caches.open(PAGE_CACHE).then(async (cache) => {
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          const cached = await cache.match(req);
          if (cached) return cached;
          throw err;
        }
      }),
    );
    return;
  }
  // Everything else (POSTs / streaming SSE / non-cached APIs): pass
  // through untouched.
});
