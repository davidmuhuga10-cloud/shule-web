/**
 * internalToken.js
 * ----------------------------------------------------------------------------
 * Signs/verifies short-lived tokens for ONE specific purpose: send-message.js
 * handing a batch off to deliver-sms-background.js (see that file's header)
 * to actually reach Africa's Talking, without the person who clicked "Send"
 * waiting for every recipient to be dialed out one by one. The background
 * function has no caller session to check (nothing but send-message.js ever
 * calls it), so this token is its only gate — without a valid one it refuses
 * the request outright.
 *
 * Same reasoning as otp.js's token: reuses SUPABASE_SERVICE_ROLE_KEY as the
 * HMAC secret so this doesn't need its own env var to deploy. Set
 * INTERNAL_FUNCTION_SECRET explicitly if you'd rather this not share a
 * secret with anything else.
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000; // plenty for a background function to pick the request up

function secret() {
  const s = process.env.INTERNAL_FUNCTION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('Neither INTERNAL_FUNCTION_SECRET nor SUPABASE_SERVICE_ROLE_KEY is set.');
  return s;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Returns the decoded payload on success, or null on any failure (missing/
 *  malformed/tampered/expired) — never throws, so a caller can just check
 *  truthiness. */
function verify(token) {
  try {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const expectedMac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
    const macBuf = Buffer.from(mac), expectedBuf = Buffer.from(expectedMac);
    if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { sign, verify };
