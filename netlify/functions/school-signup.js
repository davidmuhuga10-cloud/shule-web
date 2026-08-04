/**
 * school-signup.js
 * ----------------------------------------------------------------------------
 * The ONE public, unauthenticated endpoint that creates a brand-new tenant:
 * a `schools` row and a first admin login (Supabase Auth + `profiles`) —
 * just enough for the admin to actually sign in. Seeding the new school's
 * default reference data (CBC subjects, default grading scale, default
 * settings, default academic year/terms) is a SEPARATE, slower step that
 * used to run here too, but landing-redesign brief C1 ("Background School
 * Creation / Optimistic Login") moved it out to school-seed.js, called by
 * the frontend AFTER it's already logged the admin into their dashboard —
 * so creating a school no longer feels like it takes a full minute of
 * waiting on this one request.
 *
 * This is deliberately the ONLY place besides admin-provision.js that uses
 * the service_role key — and unlike admin-provision.js, it does NOT require
 * an existing session, because there is no admin yet for a school that
 * doesn't exist yet. Every safeguard below exists because of that:
 *   - the School Code must be unique, url/email-safe, and not already taken
 *   - the admin signs in with a username (their first name) or phone number
 *     plus the School Code — not a real email — same as every other
 *     admin/teacher (see studentEmail.shared.js's staffEmailFor). A brand
 *     new school has no other accounts yet, so this can't collide.
 *   - on any failure partway through, everything already created is rolled
 *     back (auth user, then school row) so a failed signup never leaves an
 *     orphaned half-created tenant behind
 *   - passwords go through the same minimum-length rule Supabase itself
 *     enforces, checked here first so the error message is clear
 *
 * This endpoint is intentionally simple for this phase — no CAPTCHA/rate
 * limiting yet (see PRODUCT_ROADMAP.md Phase 0 notes). Netlify Functions
 * already sit behind Netlify's own abuse protections, and every action here
 * is idempotent-safe to retry, but a growth-stage hardening pass (e.g.
 * Cloudflare Turnstile on this form) is worth revisiting once real signup
 * volume shows up.
 * ----------------------------------------------------------------------------
 */

const { getAdminClient } = require('./_lib/supabaseAdmin');
const { staffUsernameFor, staffEmailFor } = require('./_lib/studentLogin');

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function slugifyCode(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
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
    return json(200, await createSchoolAndAdmin(admin, payload));
  } catch (e) {
    console.error('school-signup error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

async function createSchoolAndAdmin(admin, payload) {
  const schoolName = String(payload.school_name || '').trim();
  const adminName = String(payload.admin_name || '').trim();
  const adminPhone = String(payload.admin_phone || '').trim();
  const password = String(payload.password || '');
  let code = slugifyCode(payload.school_code);

  if (!schoolName || schoolName.length < 2) return { ok: false, message: 'Enter your school\'s name.' };
  if (!adminName) return { ok: false, message: 'Enter your (the admin\'s) full name.' };
  if (!adminPhone || adminPhone.length < 7) return { ok: false, message: 'Enter your (the admin\'s) phone number.' };
  if (password.length < 6) return { ok: false, message: 'Password must be at least 6 characters.' };
  if (!code || code.length < 3) return { ok: false, message: 'School Code must be at least 3 characters (letters, numbers, hyphens only).' };

  const { data: existingCode } = await admin.from('schools').select('id').eq('code', code).maybeSingle();
  if (existingCode) return { ok: false, message: `School Code "${code}" is already taken — please choose another.` };

  // Create the school row first (cheap, easy to clean up if the next step fails).
  const { data: school, error: schoolErr } = await admin
    .from('schools')
    .insert({ name: schoolName, code })
    .select('id, code, name')
    .single();
  if (schoolErr) {
    if (String(schoolErr.message || '').toLowerCase().includes('duplicate')) {
      return { ok: false, message: `School Code "${code}" is already taken — please choose another.` };
    }
    return { ok: false, message: 'Could not create the school: ' + schoolErr.message };
  }

  // The admin signs in with a username (their first name) or phone number,
  // combined with the School Code — not a real email address (see
  // resolve_staff_login_email() in schema.sql). A brand-new school has no
  // other profiles yet, so the first-name username can't collide here.
  const username = staffUsernameFor(adminName);
  const adminEmail = staffEmailFor(username, code);

  // Then the admin's Auth account + profile. If either fails, remove the
  // school row we just created so a failed signup never leaves an orphan.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: adminEmail,
    password,
    email_confirm: true,
    user_metadata: { role: 'admin', school_id: school.id, full_name: adminName }
  });
  if (createErr) {
    await admin.from('schools').delete().eq('id', school.id);
    return { ok: false, message: 'Could not create the admin login: ' + createErr.message };
  }

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, school_id: school.id, name: adminName, email: adminEmail, username, phone: adminPhone, role: 'admin', status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from('schools').delete().eq('id', school.id);
    return { ok: false, message: 'Could not link the admin profile: ' + profileErr.message };
  }

  // Seeding sensible defaults (CBC subjects, default grading scale, default
  // settings, default academic year/terms) happens in a separate call to
  // school-seed.js, kicked off by the client AFTER this response — see the
  // file header above. This endpoint's job ends the moment the admin has a
  // working login.
  return {
    ok: true,
    school_id: school.id,
    school_code: school.code,
    school_name: school.name,
    username
  };
}

// Exported for unit testing against a mocked Supabase admin client.
module.exports.createSchoolAndAdmin = createSchoolAndAdmin;
module.exports.slugifyCode = slugifyCode;
