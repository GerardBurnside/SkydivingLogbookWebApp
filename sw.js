// Service Worker for offline-first PWA functionality
importScripts('./js/cache-version.js');
const CACHE_NAME = `skydiving-logbook-v${CACHE_VERSION}`;

// All app shell files that must be cached for offline use
const urlsToCache = [
  './',
  './index.html',
  './css/style.css',
  './js/cache-version.js',
  './js/db.js',
  './js/auth.js',
  './js/external-csv-import.js',
  './js/flysight.js',
  './js/app.js',
  './js/sheets.js',
  './manifest.json'
];

// ── Install: pre-cache app shell, then activate immediately ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Pre-caching app shell');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting()) // activate new SW immediately
  );
});

// ── Activate: claim clients & purge old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim()) // take control of all open pages
  );
});

// ── Fetch: stale-while-revalidate for app shell, cache-first overall ──
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only handle GET requests; let POST/PUT etc. pass through
  if (request.method !== 'GET') return;

  // For Google API / external requests: network-only (don't cache auth tokens etc.)
  if (request.url.includes('googleapis.com') || request.url.includes('accounts.google.com')) {
    return; // let the browser handle these normally
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      // Start a background fetch to update the cache for next time
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          // Only cache valid responses
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Network failed – fall back to cache (handled below)
          return cachedResponse;
        });

      // Return cached version immediately if available, otherwise wait for network
      return cachedResponse || fetchPromise;
    })
  );
});