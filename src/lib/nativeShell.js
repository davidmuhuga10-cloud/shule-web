/**
 * nativeShell.js — native Android app shell (ShuleTop wrapped via Capacitor,
 * shared over WhatsApp today, not yet on the Play Store). This site loads
 * as-is inside the native WebView, so this file does nothing when opened in
 * a normal browser: window.Capacitor only exists inside the wrapped app.
 * Handles the hardware/gesture back button (walk the in-app hash history
 * instead of closing the app), paints the status bar to match the brand's
 * dark teal sidebar, and (see the splash-screen block below) keeps the
 * native splash up through the app's real loading sequence instead of
 * letting it disappear early.
 *
 * External file rather than an inline <script> block because the site's
 * CSP blocks inline script execution.
 */
(function () {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;
  var Plugins = window.Capacitor.Plugins || {};
  if (Plugins.StatusBar) {
    try {
      Plugins.StatusBar.setBackgroundColor({ color: '#0f3d3e' });
      Plugins.StatusBar.setStyle({ style: 'LIGHT' }); // light icons for a dark status bar
    } catch (e) { /* best-effort */ }
  }
  // Live feedback: "on opening [the app] always rendering green empty
  // screen for a few seconds then white screen for a few seconds" — the
  // native splash (green/teal) used to auto-hide on a fixed timer
  // regardless of whether the app had actually loaded yet (capacitor.config
  // .json's server.url points at the live site, so a cold start over mobile
  // data can genuinely take a few seconds just to fetch index.html/CSS/JS —
  // that's the "white screen" in between). capacitor.config.json now sets
  // launchAutoHide:false, and app.js's hideNativeSplashOnce() calls
  // Plugins.SplashScreen.hide() itself the moment there's real content to
  // show (either the sign-in screen or the "Setting up your dashboard"
  // loading card). This is a SAFETY NET only, independent of app.js ever
  // running at all — if the network is down or app.js itself fails to load,
  // the splash would otherwise stay up forever with launchAutoHide:false
  // and nothing left to dismiss it; better to fall through to whatever
  // index.html shows on its own (a blank/offline state) than hang on the
  // splash indefinitely.
  if (Plugins.SplashScreen) {
    setTimeout(function () {
      try { Plugins.SplashScreen.hide(); } catch (e) { /* best-effort */ }
    }, 8000);
  }
  if (Plugins.App) {
    Plugins.App.addListener('backButton', function () {
      var atRoot = !location.hash || location.hash === '#/' || location.hash === '#' ||
        location.hash.replace(/^#\/?/, '').split('/')[0] === '' ||
        document.getElementById('auth-screen') && !document.getElementById('auth-screen').classList.contains('hidden');
      if (!atRoot && history.length > 1) {
        history.back();
      } else {
        Plugins.App.exitApp();
      }
    });
  }
})();
