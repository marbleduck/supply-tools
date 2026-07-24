// Service Worker: caches the full app shell on install so the tool works
// offline after the first visit (Phase 4 requirement). Cache-first for
// everything precached - this app has no server-rendered content or
// user data to keep fresh; every file here is a static asset that only
// changes when a new version is deployed, at which point CACHE_NAME below
// changes too (see build.mjs - it stamps this file with a content-derived
// version so a new deploy automatically gets a new cache and evicts the old
// one, without needing any manual cache-busting logic at runtime).
//
// The two tokens below (cache version, precache list) are placeholders
// substituted by build.mjs at build time - this file is never deployed
// as-is, only its built-and-substituted form in dist/.
const CACHE_NAME = 'da3161-parser-d00715eb52';
const PRECACHE_URLS = [
  "app.51e2cf5ddf.js",
  "index.html",
  "lib/da3161-config.37d30789e0.js",
  "lib/da3161-parser.77c59479f4.js",
  "lib/md5.bf3f3de50d.js",
  "lib/ocr.138efb088a.js",
  "lib/pdf-xfa-parser.4fb65653dc.js",
  "lib/vendor/pako_inflate.umd.min.5399434c66.js",
  "lib/vendor/pdf.0ca136ece0.mjs",
  "lib/vendor/pdf.worker.dde66d5cd4.mjs",
  "lib/xml-lite.fbeedbde13.js",
  "styles.37b9319bbc.css",
  "sw.js",
  "worker.b6c42d438c.js"
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Opportunistically cache anything same-origin we didn't already
        // precache (e.g. if PRECACHE_URLS ever drifts), but never cache
        // cross-origin/opaque responses.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
