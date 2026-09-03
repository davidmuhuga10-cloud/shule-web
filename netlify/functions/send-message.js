/**
 * send-message.js
 * ----------------------------------------------------------------------------
 * Fans a "send to a class / a student's guardian / a staff member / everyone
 * / a personalized batch (exam results, fee balances)" request out into one
 * message_logs row per actual recipient, charging the school's own
 * sms_wallets balance for what it costs (1 credit per 160-character segment,
 * per recipient) via the debit_sms_wallet() RPC
 * (migrations/0041_sms_wallet_debit_rpc.sql) BEFORE sending, so an
 * under-funded school gets a clear "top up first" instead of a
 * partially-sent batch. If no sms_platform_config row is set (e.g. a dev
 * environment), sends fall back to the original "logged only, not sent"
 * behavior — no wallet is touched in that case either.
 *
 * STANDING RULE (Messaging_Overhaul.docx item 2): every message this app
 * sends, of every kind, starts with the school's own name in CAPITAL
 * LETTERS on its own first line — enforced ONCE, here, server-side, so it
 * can never be missed by a call site that forgets it. Callers (compose,
 * exam results, fee balances) never put the school name in their own body
 * text; this function always adds it.
 *
 * Two shapes of batch:
 *   - scope: 'class'|'individual_student'|'individual_staff'|'broadcast' —
 *     the whole batch shares one `body` (this app's original shape).
 *   - scope: 'personalized' — payload.recipients is an array of
 *     { student_id?, staff_id?, phone, body }, each with its OWN text (a
 *     results message names one student; a fee balance message names one
 *     student's own balance). Introduced for Messaging_Overhaul.docx items
 *     4 (fee balances) and 6 (exam results, incl. single-student).
 *
 * Either way, the actual Africa's Talking round trips do NOT happen in this
 * function. Rows are written as status 'queued' and this handler returns
 * right away — the person who clicked "Send" sees "Sent"/"Processed"
 * immediately, even for a school-wide broadcast to hundreds of guardians,
 * instead of watching a spinner while each one is dialed out one at a time.
 * The real sending happens in deliver-sms-background.js, handed the batch
 * via a short-lived signed internal token (see _lib/internalToken.js) so
 * this function's own response never has to wait on it. Any recipient that
 * fails only shows up later in SMS History (status flips 'queued' ->
 * 'sent'/'failed') — exactly what was asked for: no waiting up front,
 * failures discoverable after.
 *
 * Uses requireStaff (admin OR teacher), not requireAdmin — messaging is a
 * day-to-day teacher action, not an admin-only one, matching Zeraki.
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const { getAdminClient, requireStaff } = require('./_lib/supabaseAdmin');
const { loadSmsConfig, isConfigured, smsUnits } = require('./_lib/smsProvider');
const { sign } = require('./_lib/internalToken');

const MAX_PERSONALIZED_RECIPIENTS = 2000;

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

/** Validates payload.recipients for scope 'personalized' — each needs its
 *  own phone + body, and any student_id/staff_id given must actually
 *  belong to the caller's own school (defence in depth: these ids come
 *  from the client, which normally only ever has its own school's data via
 *  RLS, but a batch send is exactly the kind of action worth double
 *  checking server-side before it costs real SMS credit). */
async function resolvePersonalizedRecipients(admin, schoolId, payload) {
  const list = Array.isArray(payload.recipients) ? payload.recipients : [];
  if (!list.length) return { error: 'No recipients to send to.' };
  if (list.length > MAX_PERSONALIZED_RECIPIENTS) return { error: `Too many recipients in one batch (max ${MAX_PERSONALIZED_RECIPIENTS}).` };

  const cleaned = list
    .map((r) => ({
      student_id: r.student_id || null,
      staff_id: r.staff_id || null,
      phone: String(r.phone || '').trim(),
      body: String(r.body || '').trim()
    }))
    .filter((r) => r.phone && r.body);
  if (!cleaned.length) return { error: 'None of the recipients have both a phone number and message text.' };
  if (cleaned.some((r) => r.body.length > 1000)) return { error: 'One of the personalized messages is too long (max 1000 characters).' };

  const studentIds = [...new Set(cleaned.filter((r) => r.student_id).map((r) => r.student_id))];
  if (studentIds.length) {
    const { data: owned } = await admin.from('students').select('id').eq('school_id', schoolId).in('id', studentIds);
    const ownedSet = new Set((owned || []).map((s) => s.id));
    const bogus = studentIds.filter((id) => !ownedSet.has(id));
    if (bogus.length) return { error: 'One or more students in this batch do not belong to your school.' };
  }
  const staffIds = [...new Set(cleaned.filter((r) => r.staff_id).map((r) => r.staff_id))];
  if (staffIds.length) {
    const { data: owned } = await admin.from('staff').select('id').eq('school_id', schoolId).in('id', staffIds);
    const ownedSet = new Set((owned || []).map((s) => s.id));
    const bogus = staffIds.filter((id) => !ownedSet.has(id));
    if (bogus.length) return { error: 'One or more staff members in this batch do not belong to your school.' };
  }

  return { recipients: cleaned, scopeLabel: payload.scope_label ? String(payload.scope_label).trim() : `Personalized (${cleaned.length})` };
}

async function getSchoolName(admin, schoolId) {
  const { data } = await admin.from('schools').select('name').eq('id', schoolId).maybeSingle();
  return (data && data.name) || 'Your School';
}

/** Standing rule (Messaging_Overhaul.docx item 2) — every message starts
 *  with the school's own name in caps, alone on line one, no exceptions. */
function withSchoolHeader(schoolName, body) {
  return `${String(schoolName).toUpperCase()}\n\n${body}`;
}

async function sendMessage(admin, payload, callerProfile, deliveryTrigger) {
  const schoolId = callerProfile.school_id;
  const isPersonalized = payload.scope === 'personalized';

  let recipients, scopeLabel, sharedBody;
  if (isPersonalized) {
    const res = await resolvePersonalizedRecipients(admin, schoolId, payload);
    if (res.error) return { ok: false, message: res.error };
    recipients = res.recipients;
    scopeLabel = res.scopeLabel;
  } else {
    sharedBody = String(payload.body || '').trim();
    if (!sharedBody) return { ok: false, message: 'Message cannot be empty.' };
    if (sharedBody.length > 1000) return { ok: false, message: 'Message is too long (max 1000 characters).' };
    const res = await resolveRecipients(admin, schoolId, payload);
    if (res.error) return { ok: false, message: res.error };
    recipients = res.recipients;
    scopeLabel = res.scopeLabel;
  }

  const schoolName = await getSchoolName(admin, schoolId);
  const smsConfig = await loadSmsConfig(admin);
  const providerConfigured = isConfigured(smsConfig);
  const batchId = crypto.randomUUID();

  // Each recipient's FINAL text (school header + their own body) is what
  // gets costed, stored, and — later, in deliver-sms-background.js — sent.
  const finalized = recipients.map((r) => ({
    ...r,
    finalBody: withSchoolHeader(schoolName, isPersonalized ? r.body : sharedBody),
    credits: smsUnits(withSchoolHeader(schoolName, isPersonalized ? r.body : sharedBody))
  }));

  // Charge BEFORE sending, not after — an insufficient wallet should stop
  // the whole batch up front (a clear "top up first") rather than sending
  // some recipients and silently dropping the rest partway through.
  if (providerConfigured) {
    const totalCredits = finalized.reduce((sum, r) => sum + r.credits, 0);
    const { error: debitErr } = await admin.rpc('debit_sms_wallet', { p_school_id: schoolId, p_credits: totalCredits });
    if (debitErr) return { ok: false, message: debitErr.message };
  }

  // Every row starts 'queued' — even when a provider IS configured — because
  // the actual send happens later, off this request, in
  // deliver-sms-background.js. Only the "no provider at all" case gets a
  // final status right here, since there is nothing left to do for it.
  const rows = finalized.map((r) => ({
    school_id: schoolId,
    batch_id: batchId,
    sent_by: callerProfile.staff_id || null,
    recipient_scope: payload.scope,
    scope_label: scopeLabel,
    student_id: r.student_id || null,
    staff_id: r.staff_id || null,
    phone: r.phone,
    body: r.finalBody,
    channel: 'sms',
    status: providerConfigured ? 'queued' : 'logged',
    credits: r.credits,
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
module.exports.resolvePersonalizedRecipients = resolvePersonalizedRecipients;
module.exports.triggerBackgroundDelivery = triggerBackgroundDelivery;
