/**
 * offlineBanner.js — controls #offline-banner (index.html), a small toast
 * that appears when the device loses connectivity and disappears the
 * moment it's back.
 *
 * This is an external file rather than an inline <script> block because
 * the site's CSP is "script-src 'self'" with no 'unsafe-inline' (see
 * netlify.toml) — an inline block never executes under it. Must load
 * after config.js (window.SHULE_CONFIG) — see index.html's script order.
 *
 * Connectivity check: pings this project's own Supabase instance (already
 * proven reachable — every screen in the app depends on it) rather than a
 * same-origin static file, which one real user's browser/network was
 * blocking specifically even though the rest of the app worked fine.
 *
 * Timing/bandwidth (live feedback: does this cost meaningful data on a
 * phone that goes on and off line a lot?): each check is a single tiny
 * GET request (well under 1KB). It only repeats quickly (every 3s) while
 * the toast is actually showing — i.e. while genuinely offline, when
 * requests fail near-instantly and transfer effectively nothing — and
 * otherwise checks in the background only every 20s as a safety net (see
 * below), so total data use even over a full day is negligible, nowhere
 * near what a single image or page load costs.
 *
 * Both a fast path and a safety net decide when to check:
 *  - window's 'online'/'offline' events trigger an immediate check — fast
 *    when they fire, but they're well documented to be unreliable inside
 *    Android's WebView (this app's runtime once Capacitor wraps it), so
 *    they're a hint, not the source of truth.
 *  - A self-rescheduling timer is always running underneath, so a silent
 *    drop is still caught even if that event never fires: every 3s while
 *    the toast is showing (fast recovery detection), every 20s while
 *    hidden (light background safety net).
 */
(function () {
  var banner = document.getElementById('offline-banner');
  var retryBtn = document.getElementById('offline-retry');
  var timer = null;
  var checking = false; // guards against overlapping checks from event bursts

  var SHOWN_INTERVAL_MS = 3000;
  var HIDDEN_INTERVAL_MS = 20000;
  var FETCH_TIMEOUT_MS = 4000;

  function show() { if (banner) banner.hidden = false; }
  function hide() { if (banner) banner.hidden = true; }

  function scheduleNext(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(verifyConnectivity, ms);
  }

  function verifyConnectivity() {
    if (checking) return;
    if (typeof fetch !== 'function') return;
    var cfg = window.SHULE_CONFIG || {};
    if (!cfg.SUPABASE_URL) { hide(); scheduleNext(HIDDEN_INTERVAL_MS); return; }
    checking = true;
    var url = cfg.SUPABASE_URL + '/auth/v1/health';
    var headers = cfg.SUPABASE_ANON_KEY ? { apikey: cfg.SUPABASE_ANON_KEY } : {};
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var abortTimer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;
    fetch(url, { cache: 'no-store', headers: headers, signal: controller ? controller.signal : undefined })
      // Any real HTTP response — even an error status — proves the network
      // path to the server works, which is all "online" needs to mean here.
      .then(function () {
        if (abortTimer) clearTimeout(abortTimer);
        checking = false;
        hide();
        scheduleNext(HIDDEN_INTERVAL_MS);
      })
      .catch(function () {
        if (abortTimer) clearTimeout(abortTimer);
        checking = false;
        show();
        scheduleNext(SHOWN_INTERVAL_MS);
      });
  }

  window.addEventListener('offline', verifyConnectivity);
  window.addEventListener('online', verifyConnectivity);
  if (retryBtn) retryBtn.onclick = verifyConnectivity;
  verifyConnectivity();
})();
