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
 * Actions: create_student | create_students_bulk | create_staff | create_staff_bulk |
 *          create_parent | reset_password | set_login_status
 * ----------------------------------------------------------------------------
 */

const { getAdminClient, requireAdmin } = require('./_lib/supabaseAdmin');
const { studentEmailFor, studentPasswordFor, parentEmailFor, staffUsernameFor, staffEmailFor, DEFAULT_TEACHER_PASSWORD } = require('./_lib/studentLogin');

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
      case 'create_students_bulk':
        return json(200, await createStudentsBulk(admin, payload, schoolId));
      case 'create_staff':
        return json(200, await createStaffLogin(admin, payload, schoolId));
      case 'create_staff_bulk':
        return json(200, await createStaffBulk(admin, payload, schoolId));
      case 'create_parent':
        return json(200, await createParentLogin(admin, payload, schoolId));
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

  const { data: school, error: schoolErr } = await admin
    .from('schools').select('code').eq('id', schoolId).maybeSingle();
  if (schoolErr || !school) return { ok: false, message: 'Could not resolve your school — please sign in again.' };

  return provisionOneStudent(admin, schoolId, school.code, { student_id, admission_no, full_name });
}

/** Shared by the single (`create_student`) and bulk (`create_students_bulk`)
 *  paths so both provision a login exactly the same way — the bulk path just
 *  resolves the school code ONCE up front instead of once per student. */
async function provisionOneStudent(admin, schoolId, schoolCode, { student_id, admission_no, full_name }) {
  if (!student_id || !admission_no || !full_name) {
    return { ok: false, admission_no, message: 'student_id, admission_no and full_name are required.' };
  }

  const existing = await findProfileBy(admin, 'student_id', student_id, schoolId);
  if (existing) {
    return { ok: true, alreadyProvisioned: true, profile_id: existing.id, admission_no };
  }

  const email = studentEmailFor(admission_no, schoolCode);
  const password = studentPasswordFor(admission_no);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'student', student_id, full_name, school_id: schoolId }
  });
  if (createErr) return { ok: false, admission_no, message: 'Could not create the login: ' + createErr.message };

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, school_id: schoolId, name: full_name, email, role: 'student', student_id, status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id); // don't leave an orphaned auth account behind
    return { ok: false, admission_no, message: 'Could not link the profile: ' + profileErr.message };
  }

  return { ok: true, profile_id: created.user.id, email, defaultPassword: password, admission_no };
}

/**
 * Bulk-provision student logins in ONE request instead of one Netlify
 * function round-trip per student (the previous frontend behavior — the
 * direct cause of a 19-student import "freezing" the site: 19 sequential
 * HTTP round trips, each itself doing 2-3 Supabase Admin API calls). Runs
 * with limited concurrency server-side (not full parallel) so we don't
 * hammer Supabase's Admin API with a burst that could get rate-limited.
 * payload.rows: [{ student_id, admission_no, full_name }]
 */
async function createStudentsBulk(admin, payload, schoolId) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) return { ok: false, message: 'No students to provision.' };

  const { data: school, error: schoolErr } = await admin
    .from('schools').select('code').eq('id', schoolId).maybeSingle();
  if (schoolErr || !school) return { ok: false, message: 'Could not resolve your school — please sign in again.' };

  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((row) => provisionOneStudent(admin, schoolId, school.code, row))
    );
    results.push(...batchResults);
  }
  const provisioned = results.filter((r) => r.ok).length;
  return { ok: true, provisioned, total: rows.length, results };
}

/**
 * Staff/admin accounts sign in with a short username (their first name, e.g.
 * "mercy") or their phone number, combined with the School Code — NOT their
 * real email — see splitLoginUsername() / resolve_staff_login_email() and
 * the note at the top of PRODUCT_ROADMAP.md's login-UX section for why. The
 * real email typed on the Staff form (if any) is kept only as contact info
 * on the `staff` table; it plays no role in signing in.
 */
async function createStaffLogin(admin, payload, schoolId) {
  const { staff_id, full_name, role, phone } = payload;
  if (!staff_id || !full_name) {
    return { ok: false, message: 'staff_id and full_name are required.' };
  }
  const { data: school, error: schoolErr } = await admin
    .from('schools').select('code').eq('id', schoolId).maybeSingle();
  if (schoolErr || !school) return { ok: false, message: 'Could not resolve your school — please sign in again.' };

  return provisionOneStaff(admin, schoolId, school.code, { staff_id, full_name, role, phone });
}

/** Shared by the single (`create_staff`) and bulk (`create_staff_bulk`)
 *  paths so both provision a login exactly the same way — the bulk path just
 *  resolves the school code ONCE up front instead of once per staff member.
 *  Mirrors provisionOneStudent()'s shape. */
async function provisionOneStaff(admin, schoolId, schoolCode, { staff_id, full_name, role, phone }, precomputedUsername) {
  if (!staff_id || !full_name) {
    return { ok: false, staff_id, message: 'staff_id and full_name are required.' };
  }
  const appRole = role === 'admin' ? 'admin' : 'teacher';

  const existing = await findProfileBy(admin, 'staff_id', staff_id, schoolId);
  if (existing) {
    return { ok: true, alreadyProvisioned: true, profile_id: existing.id, staff_id };
  }

  // The bulk path (see createStaffBulk) precomputes every row's username up
  // front, sequentially, before any concurrent work starts — otherwise two
  // rows sharing a first name and running concurrently could each query the
  // table before the other's profile is inserted and both grab "mercy".
  const username = precomputedUsername || await findAvailableUsername(admin, staffUsernameFor(full_name), schoolId);
  const email = staffEmailFor(username, schoolCode);
  const password = DEFAULT_TEACHER_PASSWORD;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: appRole, staff_id, full_name, school_id: schoolId }
  });
  if (createErr) return { ok: false, staff_id, message: 'Could not create the login: ' + createErr.message };

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, school_id: schoolId, name: full_name, email, username, phone: phone || null, role: appRole, staff_id, status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return { ok: false, staff_id, message: 'Could not link the profile: ' + profileErr.message };
  }

  return { ok: true, profile_id: created.user.id, username, defaultPassword: password, staff_id };
}

/**
 * Bulk-provision staff logins in ONE request instead of one Netlify function
 * round trip per staff member — same rationale, and same limited-concurrency
 * shape, as createStudentsBulk().
 * payload.rows: [{ staff_id, full_name, role, phone }]
 */
async function createStaffBulk(admin, payload, schoolId) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) return { ok: false, message: 'No staff to provision.' };

  const { data: school, error: schoolErr } = await admin
    .from('schools').select('code').eq('id', schoolId).maybeSingle();
  if (schoolErr || !school) return { ok: false, message: 'Could not resolve your school — please sign in again.' };

  // Resolve every row's username up front, in order, against one snapshot of
  // already-taken usernames — see provisionOneStaff's comment on why this
  // can't safely happen inside the concurrent batch below.
  const { data: existingProfiles } = await admin.from('profiles').select('username').eq('school_id', schoolId);
  const taken = new Set((existingProfiles || []).map((r) => r.username).filter(Boolean).map((u) => String(u).toLowerCase()));
  const usernameFor = new Map();
  rows.forEach((row) => {
    if (!row || !row.full_name) return;
    const base = staffUsernameFor(row.full_name);
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) { candidate = base + suffix; suffix++; }
    taken.add(candidate);
    usernameFor.set(row, candidate);
  });

  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((row) => provisionOneStaff(admin, schoolId, school.code, row, usernameFor.get(row)))
    );
    results.push(...batchResults);
  }
  const provisioned = results.filter((r) => r.ok).length;
  return { ok: true, provisioned, total: rows.length, results };
}

/** Finds the first available username at this school — "mercy", then
 *  "mercy2", "mercy3", ... — since two different staff members (or two
 *  different schools, but that's already scoped out by schoolId) can easily
 *  share a first name, unlike an admission number or phone number. */
async function findAvailableUsername(admin, baseUsername, schoolId) {
  const { data } = await admin.from('profiles').select('username').eq('school_id', schoolId);
  const taken = new Set((data || []).map((r) => r.username).filter(Boolean).map((u) => String(u).toLowerCase()));
  if (!taken.has(baseUsername)) return baseUsername;
  let suffix = 2;
  while (taken.has(baseUsername + suffix)) suffix++;
  return baseUsername + suffix;
}

/**
 * Parent accounts have no dedicated FK column on `profiles` the way
 * students/staff do (no `staff_id`/`student_id` to key off — a parent isn't
 * "the same row as" any one student, since one parent can be linked to
 * several children via parent_links). So idempotency here is keyed off the
 * synthetic email instead, scoped to the calling admin's own school.
 *
 * A student_id is required up front (not just a name+phone) because the
 * parent's password is their (first) linked child's admission number —
 * something every parent reliably already knows, instead of a generic
 * password an admin has to separately communicate and the parent has to
 * remember. The actual parent_links row is still created as its own step by
 * the frontend right after this call (see src/lib/api/parents.mjs) — this
 * function only needs the student to derive the password from.
 */
async function createParentLogin(admin, payload, schoolId) {
  const { full_name, phone, student_id } = payload;
  if (!full_name || !phone || !student_id) {
    return { ok: false, message: 'Parent name, phone number, and a child to link are required.' };
  }

  const { data: student, error: studentErr } = await admin
    .from('students').select('id, admission_no').eq('id', student_id).eq('school_id', schoolId).maybeSingle();
  if (studentErr || !student) return { ok: false, message: 'Student not found.' };

  const { data: school, error: schoolErr } = await admin
    .from('schools').select('code').eq('id', schoolId).maybeSingle();
  if (schoolErr || !school) return { ok: false, message: 'Could not resolve your school — please sign in again.' };

  const email = parentEmailFor(phone, school.code);

  const existing = await findProfileByEmail(admin, email, schoolId);
  if (existing) {
    return { ok: true, alreadyProvisioned: true, profile_id: existing.id, email };
  }

  const password = studentPasswordFor(student.admission_no);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'parent', full_name, school_id: schoolId }
  });
  if (createErr) return { ok: false, message: 'Could not create the login: ' + createErr.message };

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, school_id: schoolId, name: full_name, email, role: 'parent', status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id); // don't leave an orphaned auth account behind
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
    } else if (profile.role === 'parent') {
      // Same rule as creation: a parent's default password is their (first)
      // linked child's admission number — see createParentLogin's comment.
      const { data: link } = await admin
        .from('parent_links').select('student_id').eq('parent_profile_id', profile_id).limit(1).maybeSingle();
      let admissionNo = '';
      if (link) {
        const { data: student } = await admin.from('students').select('admission_no').eq('id', link.student_id).maybeSingle();
        admissionNo = student ? student.admission_no : '';
      }
      password = studentPasswordFor(admissionNo);
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

async function findProfileByEmail(admin, email, schoolId) {
  const { data } = await admin.from('profiles').select('id').eq('email', email).eq('school_id', schoolId).maybeSingle();
  return data || null;
}

// Exported (in addition to `handler`) so these pure actions can be unit-tested
// against a mock Supabase client without needing a live project or env vars.
module.exports.createStudentLogin = createStudentLogin;
module.exports.createStudentsBulk = createStudentsBulk;
module.exports.createStaffLogin = createStaffLogin;
module.exports.createStaffBulk = createStaffBulk;
module.exports.createParentLogin = createParentLogin;
module.exports.resetPassword = resetPassword;
module.exports.setLoginStatus = setLoginStatus;
