/**
 * forgot-password.js
 * ----------------------------------------------------------------------------
 * Landing redesign brief B2 ("Forgot Password... Authentication required:
 * NO — implement a simple reset flow without OTP or email verification for
 * now"). This is an explicit, acknowledged tradeoff, not an oversight: given
 * only a phone number + school + role — the exact same triple the public
 * find_login_accounts_by_phone RPC already reveals to anyone at the login
 * screen — this endpoint lets the caller set a brand-new password for that
 * account. No proof of identity beyond knowing the phone number is required.
 * The brief itself flags this as temporary ("This can be upgraded to
 * verified reset in a future sprint") and the frontend repeats the warning
 * next to the form.
 *
 * Deliberately narrow regardless: only admin/teacher/parent accounts are
 * reachable (students are untouched, same as everywhere else in this
 * brief), the account must be active, and the (phone, school_code, role)
 * triple must match exactly one profile — never a bulk or wildcard reset.
 * ----------------------------------------------------------------------------
 */

const { getAdminClient } = require('./_lib/supabaseAdmin');

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const RESETTABLE_ROLES = ['admin', 'teacher', 'parent'];

async function resetForgottenPassword(admin, payload) {
  const phone = String((payload || {}).phone || '').trim();
  const schoolCode = String((payload || {}).school_code || '').trim().toLowerCase();
  const role = String((payload || {}).role || '').trim().toLowerCase();
  const newPassword = String((payload || {}).new_password || '');

  if (!phone) return { ok: false, message: 'Phone number is required.' };
  if (!schoolCode || !role) return { ok: false, message: 'Choose an account to reset.' };
  if (RESETTABLE_ROLES.indexOf(role) === -1) return { ok: false, message: 'That account type cannot be reset here.' };
  if (newPassword.length < 6) return { ok: false, message: 'New password must be at least 6 characters.' };

  const { data: school } = await admin.from('schools').select('id, status').eq('code', schoolCode).maybeSingle();
  if (!school || school.status !== 'active') return { ok: false, message: 'Could not find that account.' };

  const { data: profile } = await admin
    .from('profiles')
    .select('id, status')
    .eq('school_id', school.id)
    .eq('phone', phone)
    .eq('role', role)
    .maybeSingle();
  if (!profile || profile.status !== 'active') return { ok: false, message: 'Could not find that account.' };

  const { error } = await admin.auth.admin.updateUserById(profile.id, { password: newPassword });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, message: 'Method not allowed.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, message: 'Invalid JSON body.' });
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return json(500, { ok: false, message: e.message });
  }

  try {
    return json(200, await resetForgottenPassword(admin, payload));
  } catch (e) {
    console.error('forgot-password error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

// Exported for unit testing against a mocked Supabase admin client.
module.exports.resetForgottenPassword = resetForgottenPassword;
