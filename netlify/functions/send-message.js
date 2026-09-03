/**
 * send-message.js
 * ----------------------------------------------------------------------------
 * Fans a "send to a class / a student's guardian / a staff member / everyone"
 * request out into one message_logs row per actual recipient, charging the
 * school's own sms_wallets balance for what it costs (1 credit per
 * 160-character segment, per recipient) via the debit_sms_wallet() RPC
 * (migrations/0041_sms_wallet_debit_rpc.sql) BEFORE sending, so an
 * under-funded school gets a clear "top up first" instead of a
 * partially-sent batch. If no sms_platform_config row is set (e.g. a dev
 * environment), sends fall back to the original "logged only, not sent"
 * behavior — no wallet is touched in that case either.
 *
 * The actual Africa's Talking round trips do NOT happen in this function.
 * Rows are written as status 'queued' and this handler returns right away —
 * the person who clicked "Send" sees "Sent" immediately, even for a
 * school-wide broadcast to hundreds of guardians, instead of watching a
 * spinner while each one is dialed out one at a time. The real sending
 * happens in deliver-sms-background.js, handed the batch via a short-lived
 * signed internal token (see _lib/internalToken.js) so this function's own
 * response never has to wait on it. Any recipient that fails only shows up
 * later in SMS History (status flips 'queued' -> 'sent'/'failed') — exactly
 * what was asked for: no waiting up front, failures discoverable after.
 *
 * Uses requireStaff (admin OR teacher), not requireAdmin — messaging is a
 * day-to-day teacher action, not an admin-only one, matching Zeraki.
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const { getAdminClient, requireStaff } = require('./_lib/supabaseAdmin');
const { loadSmsConfig, isConfigured, smsUnits } = require('./_lib/smsProvider');
const { sign } = require('./_lib/internalToken');

/** Hands a queued batch off to deliver-sms-background.js and returns as soon
 *  as that request is ACCEPTED (Netlify background functions answer 202
 *  immediately, before doing any real work) — never waits for the actual
 *  SMS sending to finish. Failure to even reach the trigger (e.g. no site
 *  URL available, which can happen when running the functions bundle
 *  somewhere unusual) is logged, not thrown: the batch simply stays
 *  'queued' until something retries it, which is safer than failing the
 *  whole "Send" action after the wallet has already been debited. */
async function triggerBackgroundDelivery(batchId) {
  const base = process.env.URL || process.env.DEPLOY_URL || process.env.DEPLOY_PRIME_URL;
  if (!base) {
    console.error('send-message: no site URL env var set — cannot trigger deliver-sms-background; batch', batchId, 'will stay queued.');
    return;
  }
  try {
    await fetch(base + '/.netlify/functions/deliver-sms-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sign({ batch_id: batchId }) })
    });
  } catch (e) {
    console.error('send-message: background trigger failed for batch', batchId, e);
  }
}

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
    return json(200, await sendMessage(admin, payload, caller.profile, triggerBackgroundDelivery));
  } catch (e) {
    console.error('send-message error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

async function resolveRecipients(admin, schoolId, payload) {
  const { scope, class_id, student_id, staff_id } = payload;

  if (scope === 'class') {
    if (!class_id) return { error: 'Missing class_id.' };
    const { data: cls } = await admin.from('classes').select('id, name').eq('id', class_id).eq('school_id', schoolId).maybeSingle();
    if (!cls) return { error: 'Class not found.' };
    const { data: students } = await admin.from('students').select('id, full_name, guardian_contact')
      .eq('class_id', class_id).eq('school_id', schoolId).eq('status', 'active');
    const recipients = (students || []).filter((s) => s.guardian_contact).map((s) => ({ student_id: s.id, phone: s.guardian_contact, label: s.full_name }));
    if (!recipients.length) return { error: 'No guardian phone numbers found for this class.' };
    return { recipients, scopeLabel: `${cls.name} (${recipients.length} guardian${recipients.length === 1 ? '' : 's'})` };
  }

  if (scope === 'individual_student') {
    if (!student_id) return { error: 'Missing student_id.' };
    const { data: s } = await admin.from('students').select('id, full_name, guardian_contact').eq('id', student_id).eq('school_id', schoolId).maybeSingle();
    if (!s) return { error: 'Student not found.' };
    if (!s.guardian_contact) return { error: 'This student has no guardian contact on file — add one in Students first.' };
    return { recipients: [{ student_id: s.id, phone: s.guardian_contact, label: s.full_name }], scopeLabel: s.full_name };
  }

  if (scope === 'individual_staff') {
    if (!staff_id) return { error: 'Missing staff_id.' };
    const { data: st } = await admin.from('staff').select('id, full_name, phone').eq('id', staff_id).eq('school_id', schoolId).maybeSingle();
    if (!st) return { error: 'Staff member not found.' };
    if (!st.phone) return { error: 'This staff member has no phone number on file.' };
    return { recipients: [{ staff_id: st.id, phone: st.phone, label: st.full_name }], scopeLabel: st.full_name };
  }

  if (scope === 'broadcast') {
    const { data: students } = await admin.from('students').select('id, full_name, guardian_contact').eq('school_id', schoolId).eq('status', 'active');
    const recipients = (students || []).filter((s) => s.guardian_contact).map((s) => ({ student_id: s.id, phone: s.guardian_contact, label: s.full_name }));
    if (!recipients.length) return { error: 'No guardian phone numbers found for this school.' };
    return { recipients, scopeLabel: `All guardians (${recipients.length})` };
  }

  return { error: 'Unknown recipient scope: ' + scope };
}

async function sendMessage(admin, payload, callerProfile, deliveryTrigger) {
  const body = String(payload.body || '').trim();
  if (!body) return { ok: false, message: 'Message cannot be empty.' };
  if (body.length > 1000) return { ok: false, message: 'Message is too long (max 1000 characters).' };

  const schoolId = callerProfile.school_id;
  const { recipients, scopeLabel, error } = await resolveRecipients(admin, schoolId, payload);
  if (error) return { ok: false, message: error };

  const smsConfig = await loadSmsConfig(admin);
  const providerConfigured = isConfigured(smsConfig);
  const batchId = crypto.randomUUID();
  const unitsPerRecipient = smsUnits(body);

  // Charge BEFORE sending, not after — an insufficient wallet should stop
  // the whole batch up front (a clear "top up first") rather than sending
  // some recipients and silently dropping the rest partway through.
  if (providerConfigured) {
    const totalCredits = unitsPerRecipient * recipients.length;
    const { error: debitErr } = await admin.rpc('debit_sms_wallet', { p_school_id: schoolId, p_credits: totalCredits });
    if (debitErr) return { ok: false, message: debitErr.message };
  }

  // Every row starts 'queued' — even when a provider IS configured — because
  // the actual send happens later, off this request, in
  // deliver-sms-background.js. Only the "no provider at all" case gets a
  // final status right here, since there is nothing left to do for it.
  const rows = recipients.map((r) => ({
    school_id: schoolId,
    batch_id: batchId,
    sent_by: callerProfile.staff_id || null,
    recipient_scope: payload.scope,
    scope_label: scopeLabel,
    student_id: r.student_id || null,
    staff_id: r.staff_id || null,
    phone: r.phone,
    body,
    channel: 'sms',
    status: providerConfigured ? 'queued' : 'logged',
    provider_response: providerConfigured ? null : 'No SMS provider is connected yet — this message was recorded but not actually sent.'
  }));

  const { error: insertErr } = await admin.from('message_logs').insert(rows);
  if (insertErr) return { ok: false, message: 'Could not save the message log: ' + insertErr.message };

  if (providerConfigured) {
    // Not awaited by the CALLER of sendMessage in spirit — deliveryTrigger
    // itself only waits for the background function to ACCEPT the batch
    // (an instant 202), never for the sends themselves. See
    // triggerBackgroundDelivery's own comment above.
    await (deliveryTrigger || (() => {}))(batchId);
  }

  return {
    ok: true,
    batch_id: batchId,
    recipients: rows.length,
    delivered: providerConfigured,
    message: providerConfigured
      ? `Sent to ${rows.length} recipient(s).`
      : `Logged for ${rows.length} recipient(s), but not actually sent — no SMS provider is connected yet.`
  };
}

// Exported for unit testing against a mocked Supabase admin client.
module.exports.sendMessage = sendMessage;
module.exports.resolveRecipients = resolveRecipients;
