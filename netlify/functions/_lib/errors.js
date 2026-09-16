/**
 * errors.js
 * ----------------------------------------------------------------------------
 * Cleanup audit fix: every Netlify function here used to return raw
 * Supabase/Postgres/Auth error messages — and, on a misconfigured deploy,
 * even the exact missing environment variable names — straight to the
 * browser. This is the exact same class of "customers shouldn't know we
 * are using Netlify/Supabase" bug already fixed on the frontend via
 * friendlyDbError() in src/lib/api/_util.mjs, just server-side. The rule
 * here is the same: log the real error to the function's own Netlify logs
 * (never in the response body) and return a safe, generic message instead.
 * ----------------------------------------------------------------------------
 */

/** Translate a Postgres/PostgREST error's .code into a safe, friendly
 *  message. Mirrors src/lib/api/_util.mjs's friendlyDbError() so a
 *  duplicate-admission-number or missing-required-field failure reads the
 *  same way whether it came from the browser's direct Supabase call or one
 *  of these server-side functions. Anything unrecognized (or a Supabase
 *  Auth Admin error, which doesn't carry these Postgres codes) falls back
 *  to one generic message. */
function friendlyDbError(error) {
  const code = error && error.code;
  if (code === '23505') return 'That record already exists.';
  if (code === '23503') return 'This action references something that no longer exists.';
  if (code === '23502') return 'A required field is missing.';
  if (code === '23514') return 'That value is not allowed.';
  if (code === '42501' || code === 'PGRST301') return 'You do not have permission to do that.';
  return 'Something went wrong. Please try again.';
}

/** For a function's outer catch-all. An error with a .statusCode attached
 *  was thrown deliberately (by requireAdmin/requireStaff/requireSuperAdmin
 *  for an auth failure, or by a handler's own input validation) and already
 *  carries a safe, hand-authored, user-facing message — pass it through
 *  as-is. Anything else (an unexpected exception, a misconfigured
 *  environment from getAdminClient(), a bug) is logged server-side and
 *  answered with one generic message — never e.message itself, which for
 *  an unexpected failure could be anything, including schema/env details. */
function toClientError(e, logLabel) {
  if (logLabel) console.error(logLabel, e);
  else console.error(e);
  if (e && e.statusCode) {
    return { statusCode: e.statusCode, message: e.message };
  }
  return { statusCode: 500, message: 'Something went wrong. Please try again shortly.' };
}

module.exports = { friendlyDbError, toClientError };
