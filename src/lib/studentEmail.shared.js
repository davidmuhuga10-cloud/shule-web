/**
 * studentEmail.shared.js
 * ----------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for the admission-number <-> internal-login mapping.
 * Used by BOTH the frontend (loaded as a plain <script>, browser-global
 * `window.ShuleStudentEmail`) and the Netlify function (required as a
 * CommonJS module) — so there is exactly one place this logic can drift,
 * instead of two copies that have to be kept in sync by hand.
 *
 * Supabase Auth is email/password only; students only ever type their
 * admission number, so both sides translate it the same way before calling
 * supabase.auth.signInWithPassword() / auth.admin.createUser().
 * ----------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ShuleStudentEmail = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var STUDENT_EMAIL_DOMAIN = 'students.shule.internal';
  var DEFAULT_TEACHER_PASSWORD = 'teacher123';

  function studentEmailFor(admissionNo) {
    var slug = String(admissionNo || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return (slug || 'student') + '@' + STUDENT_EMAIL_DOMAIN;
  }

  /**
   * Default student password. A deliberate change from the Apps Script
   * version, which used the bare admission number with no minimum length.
   * Supabase enforces a 6-character floor; the "student-" prefix alone is
   * long enough that every generated password clears it regardless of
   * admission-number length — still deterministic, still easy to read aloud,
   * always valid.
   */
  function studentPasswordFor(admissionNo) {
    return 'student-' + String(admissionNo || '').trim();
  }

  return { studentEmailFor: studentEmailFor, studentPasswordFor: studentPasswordFor, DEFAULT_TEACHER_PASSWORD: DEFAULT_TEACHER_PASSWORD, STUDENT_EMAIL_DOMAIN: STUDENT_EMAIL_DOMAIN };
});
