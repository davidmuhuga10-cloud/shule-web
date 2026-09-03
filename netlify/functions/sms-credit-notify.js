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
 * The Sender ID application is done and live — this now shares the same
 * real Africa's Talking integration send-message.js uses (see
 * netlify/functions/_lib/smsProvider.js) instead of carrying its own dead
 * stub. Not billed against any school's sms_wallets balance — this is a
 * platform-ops notification to the Super Admin, not a school's own send.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient, requireStaff } = require('./_lib/supabaseAdmin');
const { loadSmsConfig, isConfigured, sendSms } = require('./_lib/smsProvider');

const ADMIN_PHONE = '0705041512';

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
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

  const smsConfig = await loadSmsConfig(admin);
  const providerConfigured = isConfigured(smsConfig);
  let delivered = false;
  let providerResponse = 'No SMS provider is connected yet — logged only, not actually sent.';
  if (providerConfigured) {
    const result = await sendSms(smsConfig, ADMIN_PHONE, message);
    delivered = result.status === 'sent';
    providerResponse = delivered ? `Sent (id: ${result.messageId || 'n/a'}).` : `Send failed: ${result.raw}`;
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
