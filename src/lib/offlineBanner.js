/**
 * offlineBanner.js — controls #offline-banner (index.html), a small corner
 * toast that appears when the device loses connectivity and disappears
 * the moment it's back.
 *
 * This is an external file rather than an inline <script> block because
 * the site's CSP is "script-src 'self'" with no 'unsafe-inline' (see
 * netlify.toml) — an inline block never executes under it. Must load
 * after config.js (window.SHULE_CONFIG) — see index.html's script order.
 *
 * Connectivity check: pings this project's own Supabase instance (already
 * proven reachable — every screen in the app depends on it) rather than a
 * same-origin static file. An earlier version probed /robots.txt, which
 * kept reporting "offline" for at least one real user even while the rest
 * of the app was actively loading data from Supabase just fine — some
 * browser extension or network security tool blocking that specific
 * request was the likely cause. Pinging the same backend the app already
 * depends on removes that whole class of false positive: what actually
 * matters is "can this device reach Supabase", not "can it reach an
 * arbitrary static file on this domain".
 */
(function () {
  var banner = document.getElementById('offline-banner');
  var retryBtn = document.getElementById('offline-retry');
  var pollTimer = null;

  function show() { if (banner) banner.hidden = false; startPolling(); }
  function hide() { if (banner) banner.hidden = true; stopPolling(); }

  // navigator.onLine and the browser's online/offline events are unreliable
  // inside Android's WebView (this app's runtime once Capacitor wraps it),
  // so they're only used as a hint to check sooner. Whether the toast
  // actually shows is always decided by a real network request.
  function verifyConnectivity() {
    if (typeof fetch !== 'function') return;
    var cfg = window.SHULE_CONFIG || {};
    if (!cfg.SUPABASE_URL) { hide(); return; } // can't check — assume fine rather than nag
    var url = cfg.SUPABASE_URL + '/auth/v1/health';
    var headers = cfg.SUPABASE_ANON_KEY ? { apikey: cfg.SUPABASE_ANON_KEY } : {};
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
    fetch(url, { cache: 'no-store', headers: headers, signal: controller ? controller.signal : undefined })
      // Any real HTTP response — even an error status — proves the network
      // path to the server works, which is all "online" needs to mean here.
      .then(function () { if (timer) clearTimeout(timer); hide(); })
      .catch(function () { if (timer) clearTimeout(timer); show(); });
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(verifyConnectivity, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  window.addEventListener('offline', verifyConnectivity);
  window.addEventListener('online', verifyConnectivity);
  if (retryBtn) retryBtn.onclick = verifyConnectivity;
  verifyConnectivity();
})();
