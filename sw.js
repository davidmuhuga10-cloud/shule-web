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
 *  2. Cached files use "stale-while-revalidate": serve instantly from
 *     cache when we have it (this is what makes it fast/offline-capable),
 *     but ALWAYS also fetch fresh from the network in the background and
 *     overwrite the cache with whatever comes back. This is the actual
 *     anti-staleness mechanism — it needs no manual bookkeeping: the very
 *     next time a file is requested after we ship a change to it, that
 *     request already gets the fixed version, because the background
 *     fetch from the PREVIOUS request already updated the cache. A person
 *     might see one stale load right after a deploy; they cannot get
 *     permanently stuck the way a naive cache-forever setup would trap
 *     them (the exact class of bug this session spent hours chasing in
 *     exam-results sending — never again via this mechanism).
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

const SW_VERSION = 'v1';
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
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!isCacheable(request, url)) return; // let the browser handle it completely normally — no interception, no caching, no change in behavior

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request).then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);

      if (cached) {
        // Kick the revalidation off but don't make the visible response
        // wait on it — that's the entire "instant even on a bad
        // connection" benefit. Any failure here is silent on purpose:
        // the cached copy already answered the request just fine.
        event.waitUntil(networkFetch);
        return cached;
      }
      const fresh = await networkFetch;
      if (fresh) return fresh;
      return new Response(
        'This page needs a connection the first time you open it — please reconnect and try again.',
        { status: 503, headers: { 'Content-Type': 'text/plain' } }
      );
    })
  );
});
