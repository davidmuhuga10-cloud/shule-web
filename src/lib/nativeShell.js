/**
 * nativeShell.js — native Android app shell (ShuleTop wrapped via Capacitor
 * for the Play Store). This site loads as-is inside the native WebView, so
 * this file does nothing when opened in a normal browser: window.Capacitor
 * only exists inside the wrapped app. Handles the hardware/gesture back
 * button (walk the in-app hash history instead of closing the app) and
 * paints the status bar to match the brand's dark teal sidebar.
 *
 * External file rather than an inline <script> block for the same reason
 * as offlineBanner.js — the site's CSP blocks inline script execution.
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
