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
 *
 * MULTI-TENANCY NOTE: Supabase Auth enforces ONE global email uniqueness
 * constraint across the whole project, but admission numbers are only
 * unique WITHIN a school (two different schools both have a "23"). Since
 * this same Supabase project now serves every school, the school's own
 * code must be folded into the synthetic address, or two schools' student
 * "23" would collide on the exact same login. That's why every call site
 * now has to pass the school's code alongside the admission number.
 * ----------------------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ShuleStudentEmail = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var STUDENT_EMAIL_DOMAIN_SUFFIX = 'students.shule.internal';
  var DEFAULT_TEACHER_PASSWORD = 'teacher123';

  function slugify(v, fallback) {
    var slug = String(v || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || fallback;
  }

  function studentEmailFor(admissionNo, schoolCode) {
    var admSlug = slugify(admissionNo, 'student');
    var codeSlug = slugify(schoolCode, '');
    if (!codeSlug) {
      throw new Error('studentEmailFor() requires a school code — every school shares this one Supabase project, so the code is what keeps admission numbers from colliding across schools.');
    }
    return admSlug + '@' + codeSlug + '.' + STUDENT_EMAIL_DOMAIN_SUFFIX;
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

  return {
    studentEmailFor: studentEmailFor,
    studentPasswordFor: studentPasswordFor,
    DEFAULT_TEACHER_PASSWORD: DEFAULT_TEACHER_PASSWORD,
    STUDENT_EMAIL_DOMAIN_SUFFIX: STUDENT_EMAIL_DOMAIN_SUFFIX
  };
});
