/**
 * phone.shared.js
 * ----------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for validating a Kenyan phone number — used by BOTH
 * the frontend (loaded as a plain <script>, browser-global `window.ShulePhone`,
 * same UMD pattern as studentEmail.shared.js) and the school-signup Netlify
 * function (required as a CommonJS module), so client-side and server-side
 * validation can never silently drift apart.
 *
 * SignUp_Fixes_Class_Correction_Permissions_1 §1 (BUG): the old signup form
 * had no real format check at all — the backend only rejected an EMPTY or
 * too-short string, so typing something like "abcdef" or a random 4-digit
 * number produced the exact same generic "Enter your (the admin's) phone
 * number" message you'd get from leaving the field blank. That reads as the
 * placeholder restyled red, not as an actual "this is wrong" error. This
 * gives both sides a real isValidPhone() check so an actually-malformed
 * number gets its own distinct message.
 * ----------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ShulePhone = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // Kenyan mobile numbers: 07XXXXXXXX / 01XXXXXXXX (10 digits total), or the
  // same number with the country code instead of the leading 0 — 2547.../
  // 2541... or +2547.../+2541... Deliberately permissive about spaces and
  // hyphens (people type "0712 345 678" or "0712-345-678" all the time) —
  // those are stripped before matching, not rejected.
  var PHONE_RE = /^(?:\+?254|0)[17]\d{8}$/;

  function normalize(v) {
    return String(v == null ? '' : v).trim().replace(/[\s-]/g, '');
  }

  function isValidPhone(v) {
    var s = normalize(v);
    return !!s && PHONE_RE.test(s);
  }

  return { isValidPhone: isValidPhone, normalize: normalize };
});
