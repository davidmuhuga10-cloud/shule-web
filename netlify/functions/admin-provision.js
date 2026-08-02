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

  try {
    await requireAdmin(event, admin);
  } catch (e) {
    return json(e.statusCode || 401, { ok: false, message: e.message });
  }

  try {
    switch (payload.action) {
      case 'create_student':
        return json(200, await createStudentLogin(admin, payload));
      case 'create_staff':
        return json(200, await createStaffLogin(admin, payload));
      case 'reset_password':
        return json(200, await resetPassword(admin, payload));
      case 'set_login_status':
        return json(200, await setLoginStatus(admin, payload));
      default:
        return json(400, { ok: false, message: 'Unknown action: ' + payload.action });
    }
  } catch (e) {
    console.error('admin-provision error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

async function createStudentLogin(admin, payload) {
  const { student_id, admission_no, full_name } = payload;
  if (!student_id || !admission_no || !full_name) {
    return { ok: false, message: 'student_id, admission_no and full_name are required.' };
  }

  const existing = await findProfileBy(admin, 'student_id', student_id);
  if (existing) {
    return { ok: true, alreadyProvisioned: true, profile_id: existing.id };
  }

  const email = studentEmailFor(admission_no);
  const password = studentPasswordFor(admission_no);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'student', student_id, full_name }
  });
  if (createErr) return { ok: false, message: 'Could not create the login: ' + createErr.message };

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, name: full_name, email, role: 'student', student_id, status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id); // don't leave an orphaned auth account behind
    return { ok: false, message: 'Could not link the profile: ' + profileErr.message };
  }

  return { ok: true, profile_id: created.user.id, email, defaultPassword: password };
}

async function createStaffLogin(admin, payload) {
  const { staff_id, email, full_name, role } = payload;
  if (!staff_id || !email || !full_name) {
    return { ok: false, message: 'staff_id, email and full_name are required.' };
  }
  const appRole = role === 'admin' ? 'admin' : 'teacher';

  const existing = await findProfileBy(admin, 'staff_id', staff_id);
  if (existing) {
    return { ok: true, alreadyProvisioned: true, profile_id: existing.id };
  }

  const password = DEFAULT_TEACHER_PASSWORD;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: appRole, staff_id, full_name }
  });
  if (createErr) return { ok: false, message: 'Could not create the login: ' + createErr.message };

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, name: full_name, email, role: appRole, staff_id, status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return { ok: false, message: 'Could not link the profile: ' + profileErr.message };
  }

  return { ok: true, profile_id: created.user.id, email, defaultPassword: password };
}

async function resetPassword(admin, payload) {
  const { profile_id, new_password } = payload;
  if (!profile_id) return { ok: false, message: 'profile_id is required.' };

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, role, student_id')
    .eq('id', profile_id)
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

async function setLoginStatus(admin, payload) {
  const { profile_id, status } = payload;
  if (!profile_id || (status !== 'active' && status !== 'inactive')) {
    return { ok: false, message: 'profile_id and a valid status (active/inactive) are required.' };
  }

  const { error: banErr } = await admin.auth.admin.updateUserById(profile_id, {
    ban_duration: status === 'inactive' ? '87600h' : 'none' // ~10 years, effectively "disabled", vs. lifted
  });
  if (banErr) return { ok: false, message: banErr.message };

  const { error: profileErr } = await admin.from('profiles').update({ status }).eq('id', profile_id);
  if (profileErr) return { ok: false, message: profileErr.message };

  return { ok: true };
}

async function findProfileBy(admin, column, value) {
  const { data } = await admin.from('profiles').select('id').eq(column, value).maybeSingle();
  return data || null;
}

// Exported (in addition to `handler`) so these pure actions can be unit-tested
// against a mock Supabase client without needing a live project or env vars.
module.exports.createStudentLogin = createStudentLogin;
module.exports.createStaffLogin = createStaffLogin;
module.exports.resetPassword = resetPassword;
module.exports.setLoginStatus = setLoginStatus;
