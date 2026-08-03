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
  var PARENT_EMAIL_DOMAIN_SUFFIX = 'parents.shule.internal';
  var STAFF_EMAIL_DOMAIN_SUFFIX = 'staff.shule.internal';
  var DEFAULT_TEACHER_PASSWORD = 'teacher123';
  var DEFAULT_PARENT_PASSWORD = 'parent123';

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

  /**
   * Same multi-tenancy problem as studentEmailFor: a parent's phone number is
   * only unique WITHIN a school (or may not even be — the same guardian
   * phone can appear on more than one student), so the school's code is
   * folded into the synthetic login the same way. Two different parents at
   * two different schools who both typed "0712345678" at signup still get
   * distinct logins.
   */
  function parentEmailFor(phone, schoolCode) {
    var phoneSlug = slugify(phone, 'parent');
    var codeSlug = slugify(schoolCode, '');
    if (!codeSlug) {
      throw new Error('parentEmailFor() requires a school code — every school shares this one Supabase project, so the code is what keeps phone numbers from colliding across schools.');
    }
    return phoneSlug + '@' + codeSlug + '.' + PARENT_EMAIL_DOMAIN_SUFFIX;
  }

  /**
   * A staff member's (admin or teacher) chosen sign-in handle — just their
   * first name, lowercased (e.g. "Mercy Njeri" -> "mercy"). This is only the
   * PROPOSED handle; the two schools sharing this Supabase project can each
   * have their own "mercy", and even the SAME school could end up with two —
   * the actual uniqueness check + "mercy2", "mercy3", ... fallback happens
   * server-side (see admin-provision.js's createStaffLogin), where the
   * existing usernames for that school can actually be queried.
   */
  function staffUsernameFor(fullName) {
    var firstName = String(fullName || '').trim().split(/\s+/)[0] || '';
    return slugify(firstName, 'staff');
  }

  /**
   * Same multi-tenancy fold-in-the-school-code pattern as students/parents,
   * but built from a server-assigned username rather than something the
   * person typed themselves — see staffUsernameFor() above for why a school
   * code alone isn't enough here (first names collide much more than
   * admission numbers or phone numbers do).
   */
  function staffEmailFor(username, schoolCode) {
    var userSlug = slugify(username, 'staff');
    var codeSlug = slugify(schoolCode, '');
    if (!codeSlug) {
      throw new Error('staffEmailFor() requires a school code — every school shares this one Supabase project, so the code is what keeps usernames from colliding across schools.');
    }
    return userSlug + '@' + codeSlug + '.' + STAFF_EMAIL_DOMAIN_SUFFIX;
  }

  /**
   * Splits what someone types at the login screen — "mercy@tumaini",
   * "0712345678@tumaini" — into the identifier part (before the LAST '@')
   * and the School Code part (after it). Used so the Staff/Admin and Parent
   * login tabs can offer ONE combined field instead of a separate "School
   * Code" box most people don't remember to fill in — see PRODUCT_ROADMAP.md
   * Phase 1.5 notes. The Student tab is deliberately NOT changed to this
   * pattern yet (frozen for now), so this helper isn't used there.
   */
  function splitLoginUsername(combined) {
    var raw = String(combined || '').trim();
    var at = raw.lastIndexOf('@');
    if (at === -1) return { identifier: raw, schoolCode: '' };
    return { identifier: raw.slice(0, at).trim(), schoolCode: raw.slice(at + 1).trim() };
  }

  return {
    studentEmailFor: studentEmailFor,
    studentPasswordFor: studentPasswordFor,
    parentEmailFor: parentEmailFor,
    staffUsernameFor: staffUsernameFor,
    staffEmailFor: staffEmailFor,
    splitLoginUsername: splitLoginUsername,
    DEFAULT_TEACHER_PASSWORD: DEFAULT_TEACHER_PASSWORD,
    DEFAULT_PARENT_PASSWORD: DEFAULT_PARENT_PASSWORD,
    STUDENT_EMAIL_DOMAIN_SUFFIX: STUDENT_EMAIL_DOMAIN_SUFFIX,
    PARENT_EMAIL_DOMAIN_SUFFIX: PARENT_EMAIL_DOMAIN_SUFFIX,
    STAFF_EMAIL_DOMAIN_SUFFIX: STAFF_EMAIL_DOMAIN_SUFFIX
  };
});
