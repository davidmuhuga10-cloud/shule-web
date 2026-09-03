/**
 * school-seed.js
 * ----------------------------------------------------------------------------
 * Landing redesign brief C1 ("Background School Creation / Optimistic
 * Login"): the slow part of provisioning a brand-new school — CBC subjects,
 * a default grading scale, default settings, and (brief C2) a default
 * academic year + terms — used to run INSIDE school-signup.js before the
 * client ever got a response, which is why creating a school felt like it
 * took about a minute. school-signup.js now returns as soon as the admin's
 * login actually exists; the frontend logs the admin straight into the
 * dashboard and calls this endpoint separately, in the background, showing
 * a small dismissible "still setting up" notice instead of a wait screen.
 *
 * No session/Authorization is required — same reasoning as school-signup.js
 * itself (there's no session yet at the exact moment this fires, since it's
 * kicked off immediately after signup, in parallel with the very first
 * dashboard render). It's safe to call more than once for the same school —
 * seed_school_defaults is idempotent (ON CONFLICT DO NOTHING throughout).
 * ----------------------------------------------------------------------------
 */

const { getAdminClient } = require('./_lib/supabaseAdmin');

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function seedSchool(admin, payload) {
  const schoolId = String((payload || {}).school_id || '').trim();
  if (!schoolId) return { ok: false, message: 'school_id is required.' };

  // Confirm the school actually exists before seeding it — the request body
  // is client-supplied and unauthenticated, so this keeps the RPC targeted
  // at a real school rather than an arbitrary/garbage id.
  const { data: school } = await admin.from('schools').select('id').eq('id', schoolId).maybeSingle();
  if (!school) return { ok: false, message: 'School not found.' };

  const { error } = await admin.rpc('seed_school_defaults', { p_school_id: schoolId });
  if (error) {
    console.error('school-seed: seed_school_defaults failed for', schoolId, error.message);
    // The raw Postgres error (schema/column/constraint names) is logged
    // server-side above for debugging, but never sent to the client —
    // this endpoint is unauthenticated by design (see header comment), so
    // it's the last place that should leak schema details to whoever calls it.
    return { ok: false, message: 'Could not finish setting up your school. Try again shortly.' };
  }
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

  return json(200, await seedSchool(admin, payload));
};

// Exported for unit testing against a mocked Supabase admin client.
module.exports.seedSchool = seedSchool;
