/**
 * sms-credit-notify.js
 * ----------------------------------------------------------------------------
 * "When a school submits an SMS credit purchase request, the Super Admin
 * should receive an actual text message notification (to 0705041512)."
 *
 * Called by the frontend right after a school inserts a sms_credit_requests
 * row (see admin/messagingSms.mjs's submitCreditRequest()) — kept as its own
 * function, not a DB trigger, for exactly the same reason send-message.js
 * is: sending a real SMS is an outbound HTTP call to a third-party gateway,
 * which Postgres can't do on its own.
 *
 * No SMS provider is connected yet (a sender ID application is in progress —
 * expected within days). Exactly like send-message.js, this is written so
 * flipping it on later is ONE env var (SMS_PROVIDER_API_KEY) plus filling in
 * sendViaProvider() below — no frontend changes, and every notification
 * attempt is logged either way (sms_admin_notifications) so nothing is lost
 * while no provider is configured, and there's a record of every attempt
 * once one is.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient, requireStaff } = require('./_lib/supabaseAdmin');

const ADMIN_PHONE = '0705041512';

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function isProviderConfigured() {
  return !!process.env.SMS_PROVIDER_API_KEY;
}

/** The one seam a real SMS provider (Africa's Talking, etc.) plugs into —
 *  deliberately not implemented yet, see file header. */
async function sendViaProvider(message) {
  // Example (Africa's Talking) once SMS_PROVIDER_API_KEY / SMS_PROVIDER_USERNAME
  // / SMS_PROVIDER_SENDER_ID are set as Netlify env vars:
  //   const AT = require('africastalking')({ apiKey: process.env.SMS_PROVIDER_API_KEY, username: process.env.SMS_PROVIDER_USERNAME });
  //   await AT.SMS.send({ to: [ADMIN_PHONE], message, from: process.env.SMS_PROVIDER_SENDER_ID });
  throw new Error('No SMS provider is connected yet.');
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

  let caller;
  try {
    caller = await requireStaff(event, admin);
  } catch (e) {
    return json(e.statusCode || 401, { ok: false, message: e.message });
  }

  try {
    return json(200, await notifyAdmin(admin, payload, caller.profile));
  } catch (e) {
    console.error('sms-credit-notify error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

async function notifyAdmin(admin, payload, callerProfile) {
  const requestId = String(payload.request_id || '');
  if (!requestId) return { ok: false, message: 'Missing request_id.' };

  const { data: req } = await admin
    .from('sms_credit_requests')
    .select('id, school_id, requested_credits, schools(name)')
    .eq('id', requestId).eq('school_id', callerProfile.school_id)
    .maybeSingle();
  if (!req) return { ok: false, message: 'Request not found.' };

  const schoolName = (req.schools && req.schools.name) || 'A school';
  const message = `Shule Admin: ${schoolName} has requested ${req.requested_credits} SMS credits and submitted a payment confirmation. Please review and approve in the Admin Dashboard.`;

  const providerConfigured = isProviderConfigured();
  let delivered = false;
  let providerResponse = 'No SMS provider is connected yet — logged only, not actually sent.';
  if (providerConfigured) {
    try {
      await sendViaProvider(message);
      delivered = true;
      providerResponse = 'Sent.';
    } catch (e) {
      providerResponse = 'Send failed: ' + e.message;
    }
  }

  await admin.from('admin_audit_log').insert({
    actor: null,
    action: 'sms_credit_request_notification',
    target_school_id: req.school_id,
    details: { request_id: requestId, phone: ADMIN_PHONE, message, delivered, provider_response: providerResponse }
  });

  return {
    ok: true,
    delivered,
    message: delivered ? undefined : `Recorded, but not actually sent to ${ADMIN_PHONE} — no SMS provider is connected yet.`
  };
}

module.exports.notifyAdmin = notifyAdmin;
module.exports.isProviderConfigured = isProviderConfigured;
