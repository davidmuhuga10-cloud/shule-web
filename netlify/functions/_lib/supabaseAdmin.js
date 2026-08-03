/**
 * supabaseAdmin.js
 * ----------------------------------------------------------------------------
 * Creates the privileged Supabase client (service_role key) used ONLY inside
 * Netlify Functions — this key must never be sent to the browser. Also
 * verifies that an incoming request's bearer token belongs to a signed-in,
 * active admin before any privileged action is allowed to run.
 * ----------------------------------------------------------------------------
 */

const { createClient } = require('@supabase/supabase-js');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in the Netlify site environment variables.'
    );
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/**
 * Verify the caller sent a valid Supabase session token ("Authorization:
 * Bearer <access_token>") AND that the token belongs to an active profile
 * whose role is one of `allowedRoles`. Throws an Error with a .statusCode
 * on any failure. Shared by requireAdmin (admin-only actions) and
 * requireStaff (admin+teacher actions, e.g. messaging/attendance).
 */
async function requireRole(event, admin, allowedRoles, roleLabel) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const err = new Error('Missing Authorization bearer token.');
    err.statusCode = 401;
    throw err;
  }

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    const err = new Error('Invalid or expired session — please log in again.');
    err.statusCode = 401;
    throw err;
  }

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, role, status, school_id, staff_id')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileErr || !profile) {
    const err = new Error('No profile is linked to this account.');
    err.statusCode = 403;
    throw err;
  }
  if (allowedRoles.indexOf(profile.role) === -1 || profile.status !== 'active') {
    const err = new Error((roleLabel || 'Admin') + ' access is required for this action.');
    err.statusCode = 403;
    throw err;
  }

  return { user: userData.user, profile };
}

async function requireAdmin(event, admin) {
  return requireRole(event, admin, ['admin'], 'Admin');
}

/** Same as requireAdmin, but also allows teachers — used by endpoints like
 *  messaging that Zeraki-parity intends for any staff member, not admin only. */
async function requireStaff(event, admin) {
  return requireRole(event, admin, ['admin', 'teacher'], 'Staff');
}

module.exports = { getAdminClient, requireAdmin, requireStaff };
