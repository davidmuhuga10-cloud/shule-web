/**
 * offlineBanner.js — controls #offline-banner (index.html), a small corner
 * toast that appears when the device loses connectivity and disappears
 * the moment it's back.
 *
 * This is an external file rather than an inline <script> block because
 * the site's CSP is "script-src 'self'" with no 'unsafe-inline' (see
 * netlify.toml) — an inline block never executes under it.
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
  // actually shows is always decided by a real, cache-busted network
  // request against this site's own robots.txt.
  function verifyConnectivity() {
    if (typeof fetch !== 'function') return;
    fetch('/robots.txt?_=' + Date.now(), { cache: 'no-store' })
      .then(function (res) { if (res && res.ok) hide(); else show(); })
      .catch(function () { show(); });
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
