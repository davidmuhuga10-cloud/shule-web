/**
 * sw.js — Shule's service worker. Makes repeat visits load fast and keeps
 * already-visited screens usable offline, without ever serving stale
 * content once a new version has shipped.
 *
 * Scope:
 *  1. Only same-origin GET requests for static files (HTML/CSS/JS) are
 *     touched. Everything else — Supabase reads/writes, Netlify function
 *     calls, any non-GET request — goes straight to the network,
 *     untouched. App data is never cached.
 *  2. Caching strategy is network-first: always try the real network
 *     first and refresh the cache with whatever comes back; only fall
 *     back to the cached copy if the network request genuinely fails
 *     (the device is offline). This guarantees anyone online always gets
 *     exactly what's deployed, on the first load, with no cache running
 *     ahead of or behind the live site.
 *  3. SW_VERSION is a hygiene tool — bump it when files are renamed or
 *     removed (not just edited) to clear out orphaned cache entries on
 *     activation.
 */

const SW_VERSION = 'v2';
const SHELL_CACHE = `shule-shell-${SW_VERSION}`;

// Small, load-bearing set fetched once up front so the very first visit
// (and every offline visit after it) has at least the app shell available.
// Everything else is cached opportunistically the first time it's requested.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/src/styles/main.css',
  '/src/lib/config.js',
  '/src/lib/studentEmail.shared.js',
  '/src/lib/phone.shared.js',
  '/src/lib/offlineBanner.js',
  '/src/lib/nativeShell.js',
  '/src/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Take over immediately rather than waiting for every open tab to
      // close — safe because of the network-first strategy above: an
      // already-open tab just starts getting network-first treatment too.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function isCacheable(request, url) {
  if (request.method !== 'GET') return false; // never touch a write
  if (url.origin !== self.location.origin) return false; // never touch Supabase or anything external
  if (url.pathname.startsWith('/.netlify/functions/')) return false; // never touch an API call
  // The offline toast probes this with a fresh cache-busting query string
  // every time — caching it is pure waste (each URL is a distinct, never
  // reused cache key) and it must always be a real network attempt for
  // the connectivity check to mean anything.
  if (url.pathname === '/robots.txt') return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!isCacheable(request, url)) return; // let the browser handle it normally

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(request);
        if (cached) return cached;
        return new Response(
          'This page needs a connection the first time you open it — please reconnect and try again.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } }
        );
      }
    })
  );
});
