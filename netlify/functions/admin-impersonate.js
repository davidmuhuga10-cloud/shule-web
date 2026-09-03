/**
 * admin-impersonate.js
 * ----------------------------------------------------------------------------
 * "Login as School" (Admin_Dashboard_Architecture3.docx, marked with a
 * warning: implement via a secure, server-generated session — NEVER by
 * knowing or resetting the school's actual admin password). Opens in a NEW
 * TAB (see admin.js) so the Super Admin's own /admin tab stays open and
 * signed in the whole time — no "restore my session" step needed, they just
 * switch back to that tab, or the new tab's Exit button closes itself.
 *
 * action: "start" — Super Admin only (requireSuperAdmin). Looks up the
 * target school's admin profile, mints a genuine Supabase magic-link token
 * for that profile's email via the service_role Auth admin API
 * (admin.auth.admin.generateLink), records an admin_impersonation_sessions
 * row + admin_audit_log entry, and returns the verifiable {email,
 * token_hash} pair. The BROWSER still does the actual sign-in (via
 * supabase.auth.verifyOtp, using `token_hash` — NOT `token`, a real bug
 * this shipped with once already: verifyOtp's `token` param is for a typed
 * 6-digit code, `token_hash` is for exactly what generateLink returns) —
 * this function never sees or needs the target's password.
 *
 * action: "end" — the NEW tab calls this with ITS OWN (impersonated)
 * session's token, not the Super Admin's — that tab never has the Super
 * Admin's credentials at all, by design (see src/lib/supabaseClient.js's
 * per-tab sessionStorage isolation for impersonation tabs). So this is
 * requireStaff, not requireSuperAdmin, with an ownership check: the caller
 * must BE the profile that session was opened for.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient, requireSuperAdmin, requireStaff } = require('./_lib/supabaseAdmin');

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
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
    if (payload.action === 'end') {
      let caller;
      try {
        caller = await requireStaff(event, admin);
      } catch (e) {
        return json(e.statusCode || 401, { ok: false, message: e.message });
      }
      return json(200, await endImpersonation(admin, payload, caller.user.id));
    }

    let caller;
    try {
      caller = await requireSuperAdmin(event, admin);
    } catch (e) {
      return json(e.statusCode || 401, { ok: false, message: e.message });
    }
    return json(200, await startImpersonation(admin, payload, caller.user.id));
  } catch (e) {
    console.error('admin-impersonate error:', e);
    return json(e.statusCode || 500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

async function startImpersonation(admin, payload, adminId) {
  const schoolId = String(payload.school_id || '');
  if (!schoolId) return { ok: false, message: 'Missing school_id.' };

  const { data: school } = await admin.from('schools').select('id, name, deleted_at, locked_at').eq('id', schoolId).maybeSingle();
  if (!school) return { ok: false, message: 'School not found.' };
  if (school.deleted_at) return { ok: false, message: 'This school has been deleted — cannot log in as it.' };

  const { data: targetProfile } = await admin
    .from('profiles')
    .select('id, email, name')
    .eq('school_id', schoolId).eq('role', 'admin')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!targetProfile || !targetProfile.email) {
    return { ok: false, message: 'This school has no admin login with an email on file to impersonate.' };
  }

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: targetProfile.email
  });
  if (linkErr || !linkData || !linkData.properties) {
    return { ok: false, message: 'Could not create an impersonation session: ' + (linkErr && linkErr.message) };
  }

  // Record the audit trail directly (this function already runs under the
  // service_role key, which bypasses RLS and has no auth.uid() of its own —
  // requireSuperAdmin() above is what already verified the caller, so we
  // write the actor explicitly rather than going through a SECURITY DEFINER
  // RPC that expects auth.uid()).
  const { data: sessionRow, error: sessionErr } = await admin
    .from('admin_impersonation_sessions')
    .insert({ admin_id: adminId, school_id: schoolId, target_profile_id: targetProfile.id })
    .select('id').single();
  if (sessionErr) return { ok: false, message: 'Could not record the impersonation session: ' + sessionErr.message };

  await admin.from('admin_audit_log').insert({
    actor: adminId, action: 'impersonation_start', target_school_id: schoolId,
    details: { session_id: sessionRow.id, target_email: targetProfile.email }
  });

  return {
    ok: true,
    session_id: sessionRow.id,
    school_name: school.name,
    email: targetProfile.email,
    token_hash: linkData.properties.hashed_token
  };
}

async function endImpersonation(admin, payload, callerProfileId) {
  const sessionId = String(payload.session_id || '');
  if (!sessionId) return { ok: false, message: 'Missing session_id.' };

  const { data: session, error: fetchErr } = await admin
    .from('admin_impersonation_sessions')
    .select('id, school_id, admin_id, target_profile_id, ended_at')
    .eq('id', sessionId).maybeSingle();
  if (fetchErr || !session) return { ok: false, message: 'Impersonation session not found.' };
  if (session.ended_at) return { ok: true }; // already closed — nothing to do

  // Only the profile that WAS impersonated may close out its own session
  // this way (the caller here is a school admin/teacher token, never a
  // Super Admin one — see the header comment). This is a narrow, checked
  // exception, not an open "any staff member can end any session" door.
  if (session.target_profile_id !== callerProfileId) {
    const err = new Error('You are not authorized to end this impersonation session.');
    err.statusCode = 403;
    throw err;
  }

  const { error } = await admin.from('admin_impersonation_sessions')
    .update({ ended_at: new Date().toISOString() }).eq('id', sessionId);
  if (error) {
    console.error('admin-impersonate: failed to end session', sessionId, error.message);
    return { ok: false, message: 'Could not end the impersonation session. Try again.' };
  }

  await admin.from('admin_audit_log').insert({
    actor: session.admin_id, action: 'impersonation_end', target_school_id: session.school_id,
    details: { session_id: sessionId }
  });
  return { ok: true };
}

module.exports.startImpersonation = startImpersonation;
module.exports.endImpersonation = endImpersonation;
