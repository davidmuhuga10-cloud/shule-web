/**
 * smsProvider.js
 * ----------------------------------------------------------------------------
 * The one place a real SMS actually leaves this app — shared by
 * send-message.js (guardian/staff messaging, billed against a school's own
 * sms_wallets balance) and sms-credit-notify.js (the Super Admin's own
 * "a school just requested credit" ping, not billed to anyone). Both used to
 * carry their own dead `sendViaProvider()` stub waiting on a sender ID
 * application — that application is done, so this replaces both stubs with
 * one real Africa's Talking integration instead of duplicating it twice.
 *
 * Same shape as any other third-party SMS gateway would need: three env
 * vars, one outbound HTTPS POST, one response to interpret. Reads env vars
 * only — no credential ever lives in this file or in the database — set
 * these in the Netlify site's environment variables:
 *   SMS_PROVIDER_API_KEY       Africa's Talking "apiKey" for the account.
 *   SMS_PROVIDER_USERNAME      The AT account username (NOT "sandbox" for a
 *                              real send — "sandbox" automatically switches
 *                              this module to AT's sandbox endpoint, useful
 *                              for testing without spending real credit).
 *   SMS_PROVIDER_SENDER_ID     The already-approved alphanumeric Sender ID
 *                              (AT calls this the "from" / shortcode). Any
 *                              app sending through the SAME Africa's Talking
 *                              account can reuse the SAME approved Sender
 *                              ID — a Sender ID is approved once per AT
 *                              account, not once per app, so pointing this
 *                              at an already-live AT account+Sender ID skips
 *                              the whole application-and-wait process again.
 * ----------------------------------------------------------------------------
 */

function isProviderConfigured() {
  return !!(process.env.SMS_PROVIDER_API_KEY && process.env.SMS_PROVIDER_USERNAME);
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

/** Sends ONE message to ONE recipient. Returns
 *  { status: 'sent'|'failed', messageId, raw } — never throws for a normal
 *  provider-side failure (bad number, insufficient AT balance, etc.); it
 *  only throws if the provider couldn't be reached at all (network error),
 *  which the caller should treat the same as a failed send for that
 *  recipient rather than aborting the whole batch. */
async function sendSms(phone, message) {
  const apiKey = process.env.SMS_PROVIDER_API_KEY;
  const username = process.env.SMS_PROVIDER_USERNAME;
  const senderId = process.env.SMS_PROVIDER_SENDER_ID;
  if (!apiKey || !username) throw new Error('SMS provider is not configured.');

  const e164 = toE164Phone(phone);
  if (!e164 || e164.length < 8) {
    return { status: 'failed', messageId: null, raw: 'No usable phone number on file.' };
  }

  const base = String(username).toLowerCase() === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com';

  const form = new URLSearchParams();
  form.set('username', username);
  form.set('to', e164);
  form.set('message', String(message || ''));
  if (senderId) form.set('from', senderId);

  let raw = '';
  try {
    const res = await fetch(base + '/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey,
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

module.exports = { isProviderConfigured, toE164Phone, smsUnits, sendSms };
