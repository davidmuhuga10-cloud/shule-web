/**
 * seo-hide.js
 * ----------------------------------------------------------------------------
 * Removes the static #seo-landing marketing block (index.html) as early as
 * possible, independent of the main app bundle (src/app.js) finishing its
 * download. On a slow connection, app.js — which pulls in the Supabase
 * client and the rest of the app — can take several seconds to arrive, and
 * during that wait real visitors were seeing the marketing block sitting on
 * screen instead of the login form, looking like the site was broken.
 *
 * This file is deliberately tiny and has zero dependencies, so it fetches
 * and runs in a fraction of the time the full app bundle needs — clearing
 * the marketing block almost immediately even on a poor connection. It's
 * loaded as a plain (non-module) script placed right after #seo-landing in
 * index.html, ahead of the app's own <script type="module"> tag.
 *
 * app.js still also removes this element (guarded by a null check) as a
 * harmless safety net in case this file ever fails to load — but under
 * normal conditions this file is the one doing the job, and does it fast.
 * ----------------------------------------------------------------------------
 */
(function () {
  var el = document.getElementById('seo-landing');
  if (el) el.remove();
})();
