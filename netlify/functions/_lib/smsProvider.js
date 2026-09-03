/**
 * smsProvider.js
 * ----------------------------------------------------------------------------
 * The one place a real SMS actually leaves this app — shared by
 * send-message.js (guardian/staff messaging, billed against a school's own
 * sms_wallets balance), sms-credit-notify.js (the Super Admin's own "a
 * school just requested credit" ping, not billed to anyone), and
 * send-otp.js (phone verification codes).
 *
 * Credentials live in the `sms_platform_config` table (single row, id=1 —
 * see migrations/0043_sms_platform_config.sql), NOT in Netlify environment
 * variables. This was deliberately moved off env vars: this app already
 * runs on Netlify Functions today, but the credential itself shouldn't be
 * tied to whichever host happens to run the server code — a database row
 * survives a move to a different hosting platform for free, an env var
 * doesn't. The table is server-only (RLS enabled, zero policies) — never
 * reachable by a browser session, only by the service_role key a Netlify
 * Function already holds. Set it once via the SQL editor:
 *
 *   update public.sms_platform_config set
 *     provider = 'africas_talking', username = 'your-at-username',
 *     api_key = 'your-at-api-key', sender_id = 'YourSenderId'
 *   where id = 1;
 *
 * Every caller loads the row ONCE per function invocation (loadSmsConfig)
 * and passes the resulting `cfg` into isConfigured()/sendSms() rather than
 * each one re-querying it — a batch of 200 guardian texts should cost 200
 * Africa's Talking calls, not 201 Supabase calls too.
 * ----------------------------------------------------------------------------
 */

/** Fetches the single sms_platform_config row. Returns `{}` (never throws,
 *  never returns null) on a missing row or a read error, so a caller can
 *  always safely pass the result straight into isConfigured()/sendSms()
 *  without a separate null check. */
async function loadSmsConfig(admin) {
  try {
    const { data, error } = await admin.from('sms_platform_config').select('*').eq('id', 1).maybeSingle();
    if (error || !data) return {};
    return data;
  } catch (e) {
    return {};
  }
}

function isConfigured(cfg) {
  return !!(cfg && cfg.api_key && cfg.username);
}

// Kenyan-number normalisation: 07XXXXXXXX / 7XXXXXXXX / 2547XXXXXXXX all
// become the +254... form Africa's Talking requires. Same rule this app
// already needs elsewhere for a phone number typed into a form.
function toE164Phone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.indexOf('254') === 0) return '+' + d;
  if (d.indexOf('0') === 0) return '+254' + d.slice(1);
  if (d.length === 9) return '+254' + d;
  return '+' + d;
}

// Africa's Talking bills (and this app should charge its own sms_wallets
// credit against) whole 160-character segments, not whole messages — a
// 300-character message is 2 units, not 1. Kept as its own export so
// send-message.js can total a batch's cost before committing to sending it.
function smsUnits(body) {
  const len = String(body || '').length;
  return Math.max(1, Math.ceil(len / 160));
}

function apiBase(cfg) {
  return String(cfg.username).toLowerCase() === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com';
}

// Africa's Talking accepts a comma-separated `to` list in ONE call — a
// school-wide broadcast to 300 guardians used to be 300 outbound HTTP
// requests (the actual reason a big send used to take a while); chunked
// into groups this size it's ~3. Kept comfortably under any practical
// request-size limit while still cutting round trips by ~100x.
const BULK_CHUNK_SIZE = 100;

/** Sends ONE chunk (already ≤ BULK_CHUNK_SIZE) to Africa's Talking and
 *  matches its response back to each input phone by number — not by
 *  response order, since that's not a documented guarantee. Returns an
 *  array the same length/order as `phones`. Internal to this module; call
 *  sendBulkSms (any size) or sendSms (one recipient) instead. */
async function sendChunk(cfg, phones, message) {
  const e164List = phones.map(toE164Phone);
  const valid = e164List.map((e, i) => ({ e, i })).filter((x) => x.e && x.e.length >= 8);
  const results = e164List.map((e) => (e && e.length >= 8 ? null : { status: 'failed', messageId: null, raw: 'No usable phone number on file.' }));
  if (!valid.length) return results;

  const form = new URLSearchParams();
  form.set('username', cfg.username);
  form.set('to', valid.map((v) => v.e).join(','));
  form.set('message', String(message || ''));
  if (cfg.sender_id) form.set('from', cfg.sender_id);

  try {
    const res = await fetch(apiBase(cfg) + '/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: cfg.api_key,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: form.toString()
    });
    const resJson = await res.json().catch(() => null);
    const wholeResponseRaw = resJson ? JSON.stringify(resJson) : `HTTP ${res.status}`;
    const recipients = (resJson && resJson.SMSMessageData && resJson.SMSMessageData.Recipients) || [];

    // AT can return more than one entry for the same number (shouldn't for
    // this app's use, since a batch never intentionally dupes a recipient,
    // but defend against it anyway) — queue per number, consumed in order.
    const queueByNumber = {};
    recipients.forEach((r) => { (queueByNumber[r.number] = queueByNumber[r.number] || []).push(r); });

    valid.forEach(({ e, i }) => {
      const queue = queueByNumber[e];
      const r = queue && queue.length ? queue.shift() : null;
      results[i] = r && String(r.status).toLowerCase() === 'success'
        ? { status: 'sent', messageId: r.messageId || null, raw: JSON.stringify(r) }
        : { status: 'failed', messageId: null, raw: r ? JSON.stringify(r) : wholeResponseRaw };
    });
  } catch (e) {
    const raw = String((e && e.message) || e);
    valid.forEach(({ i }) => { results[i] = { status: 'failed', messageId: null, raw }; });
  }
  return results;
}

/** Sends the SAME message to many recipients using an already-loaded `cfg`
 *  (see loadSmsConfig above), chunked into as few Africa's Talking calls as
 *  possible. Returns an array of { status: 'sent'|'failed', messageId, raw }
 *  the same length and order as `phones` — never throws for a normal
 *  provider-side failure, only if `cfg` itself isn't configured (callers
 *  should already have checked isConfigured() before calling this). */
async function sendBulkSms(cfg, phones, message) {
  if (!isConfigured(cfg)) throw new Error('SMS provider is not configured.');
  const list = phones || [];
  const results = [];
  for (let i = 0; i < list.length; i += BULK_CHUNK_SIZE) {
    const chunk = await sendChunk(cfg, list.slice(i, i + BULK_CHUNK_SIZE), message);
    results.push(...chunk);
  }
  return results;
}

/** Sends ONE message to ONE recipient — a thin convenience wrapper over
 *  sendBulkSms for the single-recipient callers (send-otp.js,
 *  sms-credit-notify.js) that don't need chunking at all. */
async function sendSms(cfg, phone, message) {
  const [result] = await sendBulkSms(cfg, [phone], message);
  return result;
}

module.exports = { loadSmsConfig, isConfigured, toE164Phone, smsUnits, sendSms, sendBulkSms, BULK_CHUNK_SIZE };
