/**
 * school-signup.js
 * ----------------------------------------------------------------------------
 * The ONE public, unauthenticated endpoint that creates a brand-new tenant:
 * a `schools` row, a first admin login (Supabase Auth + `profiles`), and the
 * new school's default reference data (CBC subjects, default grading scale,
 * default settings — via the `seed_school_defaults` SQL function), so a new
 * school can start using Shule within a minute of signing up.
 *
 * This is deliberately the ONLY place besides admin-provision.js that uses
 * the service_role key — and unlike admin-provision.js, it does NOT require
 * an existing session, because there is no admin yet for a school that
 * doesn't exist yet. Every safeguard below exists because of that:
 *   - the School Code must be unique, url/email-safe, and not already taken
 *   - the admin's email must not already have a Supabase Auth login (the
 *     platform-wide uniqueness constraint every synthetic/staff email is
 *     subject to — see studentEmail.shared.js's multi-tenancy note)
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
  const adminEmail = String(payload.admin_email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  let code = slugifyCode(payload.school_code);

  if (!schoolName || schoolName.length < 2) return { ok: false, message: 'Enter your school\'s name.' };
  if (!adminName) return { ok: false, message: 'Enter your (the admin\'s) full name.' };
  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return { ok: false, message: 'Enter a valid admin email address.' };
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
    const msg = /already.*registered|already.*exists/i.test(createErr.message || '')
      ? 'That admin email is already in use on Shule (by this or another school). Please use a different email.'
      : 'Could not create the admin login: ' + createErr.message;
    return { ok: false, message: msg };
  }

  const { error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, school_id: school.id, name: adminName, email: adminEmail, role: 'admin', status: 'active' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from('schools').delete().eq('id', school.id);
    return { ok: false, message: 'Could not link the admin profile: ' + profileErr.message };
  }

  // Seed sensible defaults (CBC subjects, default grading scale, default
  // settings rows) so the new school isn't staring at an empty app. Not
  // fatal if this fails — the admin can still sign in and add these by hand
  // — so we report it but don't roll back the account that already works.
  const { error: seedErr } = await admin.rpc('seed_school_defaults', { p_school_id: school.id });
  if (seedErr) {
    console.error('seed_school_defaults failed for new school', school.id, seedErr.message);
  }

  return {
    ok: true,
    school_code: school.code,
    school_name: school.name,
    admin_email: adminEmail,
    seeded: !seedErr
  };
}

// Exported for unit testing against a mocked Supabase admin client.
module.exports.createSchoolAndAdmin = createSchoolAndAdmin;
module.exports.slugifyCode = slugifyCode;
