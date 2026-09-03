/**
 * verify-otp.js
 * ----------------------------------------------------------------------------
 * The second half of phone verification (see send-otp.js for the first) —
 * checks a submitted 6-digit code against the latest unconsumed
 * `phone_otps` row for that phone+purpose, and on a match issues a
 * short-lived signed token (otp.js's signVerifiedToken) proving THIS phone
 * was just verified for THIS purpose. school-signup.js and
 * forgot-password.js each require that token (matching their own phone +
 * purpose) before doing anything account-affecting — this endpoint never
 * touches an account itself, it only proves phone ownership.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient } = require('./_lib/supabaseAdmin');
const { normalize } = require('../../src/lib/phone.shared.js');
const { PURPOSES, MAX_ATTEMPTS, hashCode, signVerifiedToken } = require('./_lib/otp');

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function verifyOtp(admin, payload) {
  const phone = normalize((payload || {}).phone);
  const purpose = String((payload || {}).purpose || '').trim();
  const code = String((payload || {}).code || '').trim();

  if (!phone) return { ok: false, message: 'Missing phone number.' };
  if (PURPOSES.indexOf(purpose) === -1) return { ok: false, message: 'Unknown verification purpose.' };
  if (!/^\d{6}$/.test(code)) return { ok: false, message: 'Enter the 6-digit code.' };

  const { data: rows, error: readErr } = await admin
    .from('phone_otps')
    .select('*')
    .eq('phone', phone).eq('purpose', purpose)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (readErr) {
    console.error('verify-otp: failed to read code', readErr.message);
    return { ok: false, message: 'Could not verify that code right now. Try again shortly.' };
  }

  const otpRow = (rows || [])[0];
  if (!otpRow) return { ok: false, message: 'No code was requested for this number — request a new one.' };
  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    return { ok: false, message: 'That code has expired — request a new one.' };
  }
  if (otpRow.attempts >= MAX_ATTEMPTS) {
    // Burn it so a leaked/guessed code can't keep being retried forever.
    await admin.from('phone_otps').update({ consumed_at: new Date().toISOString() }).eq('id', otpRow.id);
    return { ok: false, message: 'Too many incorrect attempts — request a new code.' };
  }

  if (hashCode(phone, purpose, code) !== otpRow.code_hash) {
    await admin.from('phone_otps').update({ attempts: otpRow.attempts + 1 }).eq('id', otpRow.id);
    const left = MAX_ATTEMPTS - (otpRow.attempts + 1);
    return { ok: false, message: left > 0 ? `Incorrect code — ${left} attempt(s) left.` : 'Incorrect code — request a new one.' };
  }

  await admin.from('phone_otps').update({ consumed_at: new Date().toISOString() }).eq('id', otpRow.id);
  return { ok: true, verified_token: signVerifiedToken(phone, purpose) };
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
    return json(200, await verifyOtp(admin, payload));
  } catch (e) {
    console.error('verify-otp error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

// Exported for unit testing against a mocked Supabase admin client.
module.exports.verifyOtp = verifyOtp;
