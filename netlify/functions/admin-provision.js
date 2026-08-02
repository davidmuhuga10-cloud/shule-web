/**
 * admin-provision.js
 * ----------------------------------------------------------------------------
 * The ONE place the Supabase service_role key is used. Every action here
 * requires the caller to already be signed in as an active admin (checked via
 * requireAdmin() against their Supabase session token) — this is a deliberate
 * upgrade over the Apps Script version, which auto-provisioned student/teacher
 * logins the first time someone typed a plausible-looking username/password
 * at the login screen. That was fine for a simple custom-auth hack, but would
 * be a real hole here since this endpoint can create Auth accounts. Instead,
 * logins are provisioned the moment an admin creates the Student/Staff record
 * — the frontend must call this immediately after a successful saveStudent /
 * saveStaff, per the notes in SETUP_GUIDE.md.
 *
 * POST body: { action, ...fields }, header: Authorization: Bearer <admin JWT>
 * Actions: create_student | create_staff | reset_password | set_login_status
 * ----------------------------------------------------------------------------
 */

const { getAdminClient, requireAdmin } = require('./_lib/supabaseAdmin');
const { studentEmailFor, studentPasswordFor, DEFAULT_TEACHER_PASSWORD } = require('./_lib/studentLogin');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
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

  let caller;
  try {
    caller = await requireAdmin(event, admin);
  } catch (e) {
    return json(e.statusCode || 401, { ok: false, message: e.message });
  }
  // Every action below runs with the service_role key, which bypasses RLS
  // entirely — including the auto-stamp trigger's fallback (it reads
  // auth.uid(), which is null for a service-role connection). So every
  // insert this function makes must set school_id explicitly, scoped to the
  // CALLING admin's own school — never trust a school_id from the request
  // body, since that would let one school's admin provision a login into
  // another school's tenant.
  const schoolId = caller.profile.school_id;

  try {
    switch (payload.action) {
      case 'create_student':
        return json(200, await createStudentLogin(admin, payload, schoolId));
      case 'create_staff':
        return json(200, await createStaffLogin(admin, payload, schoolId));
      case 'reset_password':
        return json(200, await resetPassword(admin, payload, schoolId));
      case 'set_login_status':
        return json(200, await setLoginStatus(admin, payload, schoolId));
      default:
        return json(400, { ok: false, message: 'Unknown action: ' + payload.action });
    }
  } catch (e) {
    console.error('admin-provision error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

async function createStudentLogin(admin, payload, schoolId) {
  const { student_id, admission_no, full_name } = payload;
  if (!student_id || !admission_no || !full_name) {
    return { ok: false, message: 'student_id, admission_no and full_name are required.' };
  }

  const existing = await findProfileBy(admin, 'student_id', student_id, schoolId);
  if (existing) {
    return { ok: true, alreadyProvisioned: true, profile_id: existing.id };
  }

  const { data: school, error: schoolErr } = await admin
    .from('schools').select('code').eq('id', schoolId).maybeSingle();
  if (schoolErr || !school) return { ok: false, message: 'Could not resolve your school — please sign in again.' };

  const email = studentEmailFor(admission_no, school.code);
  const password = studentPasswordFor(admission_no);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'student', student_id, full_name, school_id: schoolId }
  });
  if (createErr) return { ok: false, message: 'Could not create the login: ' + createErr.message };

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, school_id: schoolId, name: full_name, email, role: 'student', student_id, status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id); // don't leave an orphaned auth account behind
    return { ok: false, message: 'Could not link the profile: ' + profileErr.message };
  }

  return { ok: true, profile_id: created.user.id, email, defaultPassword: password };
}

async function createStaffLogin(admin, payload, schoolId) {
  const { staff_id, email, full_name, role } = payload;
  if (!staff_id || !email || !full_name) {
    return { ok: false, message: 'staff_id, email and full_name are required.' };
  }
  const appRole = role === 'admin' ? 'admin' : 'teacher';

  const existing = await findProfileBy(admin, 'staff_id', staff_id, schoolId);
  if (existing) {
    return { ok: true, alreadyProvisioned: true, profile_id: existing.id };
  }

  const password = DEFAULT_TEACHER_PASSWORD;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: appRole, staff_id, full_name, school_id: schoolId }
  });
  if (createErr) return { ok: false, message: 'Could not create the login: ' + createErr.message };

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, school_id: schoolId, name: full_name, email, role: appRole, staff_id, status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return { ok: false, message: 'Could not link the profile: ' + profileErr.message };
  }

  return { ok: true, profile_id: created.user.id, email, defaultPassword: password };
}

async function resetPassword(admin, payload, schoolId) {
  const { profile_id, new_password } = payload;
  if (!profile_id) return { ok: false, message: 'profile_id is required.' };

  // Scoped by school_id — without this, any admin could reset a password for
  // a profile belonging to a completely different school just by knowing (or
  // guessing) its id, since this runs under the service_role key which
  // bypasses RLS entirely.
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, role, student_id')
    .eq('id', profile_id)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (profileErr || !profile) return { ok: false, message: 'Profile not found.' };

  let password = new_password;
  let isGeneratedDefault = false;
  if (!password) {
    isGeneratedDefault = true;
    if (profile.role === 'student') {
      const { data: student } = await admin
        .from('students')
        .select('admission_no')
        .eq('id', profile.student_id)
        .maybeSingle();
      password = studentPasswordFor(student ? student.admission_no : '');
    } else {
      password = DEFAULT_TEACHER_PASSWORD;
    }
  }
  if (String(password).length < 6) {
    return { ok: false, message: 'Password must be at least 6 characters.' };
  }

  const { error: updateErr } = await admin.auth.admin.updateUserById(profile_id, { password });
  if (updateErr) return { ok: false, message: updateErr.message };

  return { ok: true, defaultPassword: isGeneratedDefault ? password : undefined };
}

async function setLoginStatus(admin, payload, schoolId) {
  const { profile_id, status } = payload;
  if (!profile_id || (status !== 'active' && status !== 'inactive')) {
    return { ok: false, message: 'profile_id and a valid status (active/inactive) are required.' };
  }

  // Same cross-tenant guard as resetPassword: confirm the target profile is
  // actually in the calling admin's own school before touching anything.
  const { data: target } = await admin.from('profiles').select('id').eq('id', profile_id).eq('school_id', schoolId).maybeSingle();
  if (!target) return { ok: false, message: 'Profile not found.' };

  const { error: banErr } = await admin.auth.admin.updateUserById(profile_id, {
    ban_duration: status === 'inactive' ? '87600h' : 'none' // ~10 years, effectively "disabled", vs. lifted
  });
  if (banErr) return { ok: false, message: banErr.message };

  const { error: profileErr } = await admin.from('profiles').update({ status }).eq('id', profile_id).eq('school_id', schoolId);
  if (profileErr) return { ok: false, message: profileErr.message };

  return { ok: true };
}

async function findProfileBy(admin, column, value, schoolId) {
  const { data } = await admin.from('profiles').select('id').eq(column, value).eq('school_id', schoolId).maybeSingle();
  return data || null;
}

// Exported (in addition to `handler`) so these pure actions can be unit-tested
// against a mock Supabase client without needing a live project or env vars.
module.exports.createStudentLogin = createStudentLogin;
module.exports.createStaffLogin = createStaffLogin;
module.exports.resetPassword = resetPassword;
module.exports.setLoginStatus = setLoginStatus;
