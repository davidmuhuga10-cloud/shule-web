/**
 * offlineBanner.js — controls #offline-banner (index.html). Extracted out of
 * an inline <script> block into this external file as a BUG FIX (v53):
 * this site's CSP is deliberately "script-src 'self'" with NO
 * 'unsafe-inline' (see netlify.toml's own comment — a documented, intentional
 * security hardening pass that audited the whole app down to zero inline
 * <script> blocks and zero inline event-handler attributes specifically so
 * this header could be this strict). Adding this logic as an inline
 * <script> block in index.html silently violated that invariant — the
 * browser blocks inline script execution under this CSP with no visible
 * failure in the UI, only a console error, so the banner's real fix never
 * actually ran on ANY device, in ANY browser, including a fresh incognito
 * window with nothing cached — explaining why it looked "stuck" no matter
 * how many times the underlying logic was corrected and redeployed. Moving
 * this to a same-origin external file makes it comply with 'self' with zero
 * change to the CSP itself.
 */
(function () {
  var banner = document.getElementById('offline-banner');
  var retryBtn = document.getElementById('offline-retry');
  var pollTimer = null;

  // Push the topbar/sidebar/scrim down clear of the banner while it's
  // shown (it can wrap to 2 lines on a narrow phone, so its height is
  // always measured, never assumed) instead of letting it sit on top of
  // and block the mobile hamburger menu.
  function syncOffset() {
    if (!banner) return;
    var h = banner.hidden ? 0 : banner.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--offline-banner-h', h + 'px');
    document.body.classList.toggle('has-offline-banner', h > 0);
  }
  function show() { if (banner) banner.hidden = false; syncOffset(); startPolling(); }
  function hide() { if (banner) banner.hidden = true; syncOffset(); stopPolling(); }
  window.addEventListener('resize', syncOffset);

  // navigator.onLine and the browser's 'online'/'offline' events are well
  // documented to be unreliable inside Android's WebView (this app's real
  // runtime once Capacitor wraps it) and can get stuck reporting the wrong
  // value indefinitely on some devices. They're only used below as a hint
  // to check sooner — whether the banner actually shows or hides is always
  // decided by a real, tiny, cache-busted network request against this
  // site's own robots.txt, re-checked every few seconds while showing.
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
  // Real verification on load too, not a navigator.onLine check — a
  // stuck-false reading there was exactly what caused the original bug.
  verifyConnectivity();
})();
