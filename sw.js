/**
 * sw.js — Shule's service worker: makes repeat visits load near-instantly
 * and keeps already-visited screens usable with no connection at all,
 * without ever risking someone getting stuck on a stale/broken version of
 * the app after we ship a fix (see the design notes below — this was the
 * #1 requirement, not an afterthought).
 *
 * Scope is deliberately narrow and simple:
 *
 *  1. ONLY same-origin GET requests for static files (HTML/CSS/JS, this
 *     app's own module files) are ever touched. Anything else — every
 *     Supabase read/write (a different origin entirely), every Netlify
 *     function call (/.netlify/functions/*), any non-GET request — is
 *     never intercepted at all; it goes straight to the network exactly
 *     as it does today. Actual data (results, messages, balances) is
 *     NEVER cached, by construction, not by care.
 *
 *  2. BUG FIX (live report, v52): cached files used to use
 *     "stale-while-revalidate" — serve instantly from cache, then update
 *     the cache in the background for NEXT time. During active, rapid
 *     development that turned into a real problem, not just a one-load
 *     flicker: with fixes shipping every few minutes, a person is
 *     effectively ALWAYS one or more versions behind whatever was last
 *     shipped, because "next time" never arrives before the next deploy
 *     does. That's what made a real, already-pushed nav/offline-banner fix
 *     look like it "wasn't fixed at all" on both the phone app and the
 *     desktop browser. Switched to network-first: always try the real
 *     network first and cache whatever comes back, only falling back to
 *     the cached copy if the network request actually fails (i.e. this
 *     device is genuinely offline). This keeps the exact same offline
 *     capability while guaranteeing that anyone online always gets what
 *     was actually deployed, immediately, no second load required.
 *
 *  3. SW_VERSION below exists only as a periodic hygiene tool — bump it
 *     when files get renamed/removed (not just edited) and you want old,
 *     now-orphaned cache entries cleared out immediately rather than
 *     lingering harmlessly forever. It is NOT what keeps content fresh
 *     (that's #2) — don't stress about forgetting to bump it.
 *
 *  4. Nothing here ever queues a failed write (sending an SMS, saving
 *     marks, etc.) for automatic retry. Those depend on live checks
 *     (credit balance, current data) that could easily be stale by the
 *     time a queued retry actually fires — safer to just fail visibly
 *     right away (see the online/offline toast wiring in app.js) and let
 *     the person retry once they're back online, with fresh information.
 */

const SW_VERSION = 'v2';
const SHELL_CACHE = `shule-shell-${SW_VERSION}`;

// Small, load-bearing set fetched once up front so the very first visit
// (and every offline visit after it) has at least the app shell available.
// Everything else — every view module, admin.html, the vendored xlsx/
// supabase-js bundles — is cached opportunistically the first time it's
// actually requested, not forced onto a first-time visitor on a slow link.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/src/styles/main.css',
  '/src/lib/config.js',
  '/src/lib/studentEmail.shared.js',
  '/src/lib/phone.shared.js',
  '/src/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Take over immediately rather than waiting for every open tab to
      // close — safe here specifically because of #2/#3 above: an already
      // -open tab just starts getting stale-while-revalidate treatment
      // too, it never gets served something wrong.
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
  if (url.origin !== self.location.origin) return false; // never touch Supabase (a different origin) or anything else external
  if (url.pathname.startsWith('/.netlify/functions/')) return false; // never touch an API call
  // index.html's offline banner probes this with a fresh cache-busting
  // query string on every single check — caching it would be pure
  // storage waste (each timestamped URL is a distinct cache key, never
  // reused) and it must always reflect a real, un-cached network attempt
  // for the connectivity check to mean anything.
  if (url.pathname === '/robots.txt') return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!isCacheable(request, url)) return; // let the browser handle it completely normally — no interception, no caching, no change in behavior

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // Network-first (see BUG FIX note above): try the real network
      // request before ever touching the cache, so anyone online always
      // gets exactly what was actually deployed. Cache is only a fallback
      // for when this fetch genuinely fails (offline, or briefly
      // unreachable) — updated on every successful network response so
      // it stays as fresh as possible for that fallback case.
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
