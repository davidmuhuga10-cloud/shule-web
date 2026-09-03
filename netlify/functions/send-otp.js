/**
 * send-otp.js
 * ----------------------------------------------------------------------------
 * Public, unauthenticated endpoint (there's no session yet at signup, and a
 * forgotten-password caller can't be signed in either) that texts a 6-digit
 * code to a phone number and records its hash in `phone_otps` — the first
 * half of the real phone verification school-signup.js and
 * forgot-password.js now both require before touching an account (see
 * verify-otp.js for the second half).
 *
 * Rate-limited per phone+purpose (not globally) since it's unauthenticated
 * and every send costs real SMS credit: a resend cooldown blocks spamming
 * the same number faster than a person could plausibly re-request, and a
 * short window cap blocks a script from working through a large budget in
 * a burst. Both are enforced against `phone_otps` itself — no separate rate
 * limit store needed for a check this cheap.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient } = require('./_lib/supabaseAdmin');
const { isValidPhone, normalize } = require('../../src/lib/phone.shared.js');
const { loadSmsConfig, isConfigured, sendSms } = require('./_lib/smsProvider');
const { CODE_TTL_MS, RESEND_COOLDOWN_MS, PURPOSES, generateCode, hashCode } = require('./_lib/otp');

const MAX_SENDS_PER_WINDOW = 5;
const WINDOW_MS = 15 * 60 * 1000;

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function sendOtp(admin, payload) {
  const phone = normalize((payload || {}).phone);
  const purpose = String((payload || {}).purpose || '').trim();

  if (!phone || !isValidPhone(phone)) return { ok: false, message: 'Enter a correct phone number, e.g. 0712345678.' };
  if (PURPOSES.indexOf(purpose) === -1) return { ok: false, message: 'Unknown verification purpose.' };

  const sinceWindow = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: recent, error: recentErr } = await admin
    .from('phone_otps')
    .select('id, created_at')
    .eq('phone', phone).eq('purpose', purpose)
    .gte('created_at', sinceWindow)
    .order('created_at', { ascending: false });
  if (recentErr) {
    console.error('send-otp: failed to check recent codes', recentErr.message);
    return { ok: false, message: 'Could not send a code right now. Try again shortly.' };
  }

  const rows = recent || [];
  if (rows.length && Date.now() - new Date(rows[0].created_at).getTime() < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - new Date(rows[0].created_at).getTime())) / 1000);
    return { ok: false, message: `Please wait ${waitSec}s before requesting another code.` };
  }
  if (rows.length >= MAX_SENDS_PER_WINDOW) {
    return { ok: false, message: 'Too many codes requested for this number — please try again later.' };
  }

  const code = generateCode();
  const { error: insertErr } = await admin.from('phone_otps').insert({
    phone, purpose,
    code_hash: hashCode(phone, purpose, code),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString()
  });
  if (insertErr) {
    console.error('send-otp: failed to store code', insertErr.message);
    return { ok: false, message: 'Could not send a code right now. Try again shortly.' };
  }

  const smsConfig = await loadSmsConfig(admin);
  if (!isConfigured(smsConfig)) {
    // Same "recorded, not actually deliverable" honesty as send-message.js
    // when no provider is configured — never silently pretend a code went
    // out. sent:false lets the frontend say so instead of telling someone
    // to go check a phone that got nothing.
    return { ok: true, sent: false, message: 'SMS provider is not configured — no code was actually sent.' };
  }

  const message = `Your Shule verification code is ${code}. It expires in 5 minutes. Do not share this code.`;
  const result = await sendSms(smsConfig, phone, message);
  if (result.status !== 'sent') {
    return { ok: true, sent: false, message: `Could not deliver the code: ${result.raw}` };
  }
  return { ok: true, sent: true };
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
    return json(200, await sendOtp(admin, payload));
  } catch (e) {
    console.error('send-otp error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

// Exported for unit testing against a mocked Supabase admin client.
module.exports.sendOtp = sendOtp;
