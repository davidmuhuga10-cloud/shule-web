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

/** Sends ONE message to ONE recipient using an already-loaded `cfg` (see
 *  loadSmsConfig above). Returns { status: 'sent'|'failed', messageId, raw }
 *  — never throws for a normal provider-side failure (bad number,
 *  insufficient AT balance, etc.); it only throws if `cfg` itself isn't
 *  configured, which every caller should have already checked via
 *  isConfigured() before looping over recipients. */
async function sendSms(cfg, phone, message) {
  if (!isConfigured(cfg)) throw new Error('SMS provider is not configured.');

  const e164 = toE164Phone(phone);
  if (!e164 || e164.length < 8) {
    return { status: 'failed', messageId: null, raw: 'No usable phone number on file.' };
  }

  const base = String(cfg.username).toLowerCase() === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com';

  const form = new URLSearchParams();
  form.set('username', cfg.username);
  form.set('to', e164);
  form.set('message', String(message || ''));
  if (cfg.sender_id) form.set('from', cfg.sender_id);

  let raw = '';
  try {
    const res = await fetch(base + '/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: cfg.api_key,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: form.toString()
    });
    const resJson = await res.json().catch(() => null);
    raw = resJson ? JSON.stringify(resJson) : `HTTP ${res.status}`;
    const recipient = resJson && resJson.SMSMessageData && resJson.SMSMessageData.Recipients
      && resJson.SMSMessageData.Recipients[0];
    if (recipient && String(recipient.status).toLowerCase() === 'success') {
      return { status: 'sent', messageId: recipient.messageId || null, raw };
    }
    return { status: 'failed', messageId: null, raw };
  } catch (e) {
    return { status: 'failed', messageId: null, raw: String((e && e.message) || e) };
  }
}

module.exports = { loadSmsConfig, isConfigured, toE164Phone, smsUnits, sendSms };
