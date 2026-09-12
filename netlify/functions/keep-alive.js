/**
 * keep-alive.js
 * ----------------------------------------------------------------------------
 * Live feedback: "Supabase pauses projects after 7 days of inactivity, is
 * there a trigger we can use to run something every 6 days to avoid this
 * pause (or the project becoming unrestorable after ~3 months of staying
 * paused)?" — see Supabase's own docs (Project Pausing): "a few user
 * requests to the database each day over the previous week is enough to
 * keep the project from being paused."
 *
 * This is a scheduled Netlify Function (see the [functions."keep-alive"]
 * entry in netlify.toml) that does the smallest possible real read against
 * the database on a recurring schedule, purely so Supabase always sees
 * genuine activity within its lookback window — nothing here is meant to be
 * useful data, it exists ONLY to keep the project warm.
 *
 * Runs every 3 days, not every 6: Supabase's own wording above ("each day
 * over the previous week") suggests it wants activity spread across the
 * week, not one lone ping right at the edge of it — a 6-day cadence leaves
 * zero margin for a single missed/delayed run (a Netlify hiccup, a
 * temporary Supabase outage, a deploy that briefly breaks this function)
 * to tip the project over the 7-day line. 3 days leaves a real safety
 * margin either way. Change the cron expression below if you'd rather
 * match the original 6-day ask once you've seen this run reliably for a
 * while — see the schedule line in netlify.toml.
 *
 * IMPORTANT — this reduces the RISK of an unwanted pause, it does not make
 * it impossible: it depends on Netlify's scheduler firing (which itself
 * assumes the site stays deployed and these env vars stay set), and
 * Supabase's own exact pausing rule is not publicly documented in full
 * (see their own "Project Pausing" doc). For a live production school
 * system, the fully reliable fix is upgrading the Supabase project to a
 * paid plan — "paid projects cannot be paused" — which also removes the
 * separate 90-day-after-pause restorability window this same worry was
 * about. This function is the free-tier mitigation, not a replacement for
 * that if/when the budget allows it.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient } = require('./_lib/supabaseAdmin');

// Split out from exports.handler, same reasoning as forgot-password.js's
// resetForgottenPassword(admin, payload): everything that doesn't depend on
// real environment variables/network access lives here and takes the
// Supabase client as a parameter, so tests can pass in a mock instead of
// exports.handler's real getAdminClient().
async function pingDatabase(admin) {
  // Cheapest real read available — one column, one row, no joins. Any
  // table would do; `schools` always exists and is tiny. The point is only
  // that Supabase logs a genuine database request, not what it returns.
  const { error } = await admin.from('schools').select('id').limit(1);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

exports.handler = async () => {
  try {
    const admin = getAdminClient();
    const result = await pingDatabase(admin);
    if (!result.ok) console.error('keep-alive: query failed:', result.message);
    else console.log('keep-alive: ok at', new Date().toISOString());
    return { statusCode: result.ok ? 200 : 500, body: JSON.stringify(result) };
  } catch (e) {
    console.error('keep-alive: unexpected error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, message: e.message }) };
  }
};

module.exports.pingDatabase = pingDatabase;
