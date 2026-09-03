/**
 * otp.js
 * ----------------------------------------------------------------------------
 * Shared phone-verification primitives for send-otp.js / verify-otp.js, and
 * the "prove you own this phone before we touch the account" check
 * school-signup.js (new signup) and forgot-password.js (password reset) now
 * both require — closing the exact gap both files used to flag in their own
 * comments ("no OTP/email verification for now... future sprint").
 *
 * Nothing here is a Supabase table concern — phone_otps (see
 * migrations/0042_phone_otps.sql) is read/written directly by send-otp.js
 * and verify-otp.js; this file is pure crypto/formatting so it's trivially
 * unit-testable without a database.
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const { normalize } = require('../../../src/lib/phone.shared.js');

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes to enter the code
const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes to actually use a verified token
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;
const PURPOSES = ['signup', 'password_reset'];

function generateCode() {
  // crypto.randomInt is cryptographically strong (unlike Math.random) and
  // still just a plain 6-digit string — no reason for anything fancier for
  // a 5-minute, 5-attempt, single-use code.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(phone, purpose, code) {
  // Salted with phone+purpose (not just a bare code hash) so two different
  // phones that happen to draw the same 6-digit code never collide in the
  // stored hash.
  return crypto.createHash('sha256').update(`${normalize(phone)}|${purpose}|${code}`).digest('hex');
}

/** Signs a short-lived "this phone was just verified for this purpose"
 *  token. Deliberately reuses SUPABASE_SERVICE_ROLE_KEY as the HMAC secret
 *  instead of requiring yet another env var to configure — that key is
 *  already a Netlify-Functions-only secret never sent to the browser, which
 *  is exactly the trust boundary this token needs too. Set OTP_TOKEN_SECRET
 *  explicitly if you'd rather this not share a secret with anything else. */
function tokenSecret() {
  const secret = process.env.OTP_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('Neither OTP_TOKEN_SECRET nor SUPABASE_SERVICE_ROLE_KEY is set.');
  return secret;
}

function signVerifiedToken(phone, purpose) {
  const payload = { phone: normalize(phone), purpose, exp: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Verifies a token was (a) actually signed by us, (b) not expired, and
 *  (c) issued for THIS phone + THIS purpose — a signup-purpose token can't
 *  be replayed against a password reset, and a token for one phone number
 *  can't be reused to touch a different one. Returns true/false, never
 *  throws (a malformed/tampered token just fails verification). */
function verifyToken(token, phone, purpose) {
  try {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return false;
    const expectedMac = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
    const macBuf = Buffer.from(mac);
    const expectedBuf = Buffer.from(expectedMac);
    if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.purpose !== purpose) return false;
    if (normalize(payload.phone) !== normalize(phone)) return false;
    if (!payload.exp || Date.now() > payload.exp) return false;
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  CODE_TTL_MS, TOKEN_TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS, PURPOSES,
  generateCode, hashCode, signVerifiedToken, verifyToken
};
