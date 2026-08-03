/**
 * send-message.js
 * ----------------------------------------------------------------------------
 * Fans a "send to a class / a student's guardian / a staff member / everyone"
 * request out into one message_logs row per actual recipient, and — if (and
 * only if) a real SMS provider is configured via environment variables —
 * would hand each one off to that provider. No provider is configured yet
 * (see PRODUCT_ROADMAP.md's Phase 1 notes: this is deliberately staged so
 * the whole compose/recipient/history workflow is real and usable today,
 * without pretending messages are being delivered when there's no SMS
 * account behind it yet). Every send is still fully logged either way, so
 * flipping on a real provider later is a matter of implementing
 * sendViaProvider() below and setting one env var — no frontend changes.
 *
 * Uses requireStaff (admin OR teacher), not requireAdmin — messaging is a
 * day-to-day teacher action, not an admin-only one, matching Zeraki.
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const { getAdminClient, requireStaff } = require('./_lib/supabaseAdmin');

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
    return json(200, await sendMessage(admin, payload, caller.profile));
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

/** The one seam a real SMS provider (e.g. Africa's Talking) plugs into
 *  later. Deliberately not implemented yet — see the file header. */
function isProviderConfigured() {
  return !!process.env.SMS_PROVIDER_API_KEY;
}

async function sendMessage(admin, payload, callerProfile) {
  const body = String(payload.body || '').trim();
  if (!body) return { ok: false, message: 'Message cannot be empty.' };
  if (body.length > 1000) return { ok: false, message: 'Message is too long (max 1000 characters).' };

  const schoolId = callerProfile.school_id;
  const { recipients, scopeLabel, error } = await resolveRecipients(admin, schoolId, payload);
  if (error) return { ok: false, message: error };

  const providerConfigured = isProviderConfigured();
  const batchId = crypto.randomUUID();

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

  return {
    ok: true,
    batch_id: batchId,
    recipients: rows.length,
    delivered: providerConfigured,
    message: providerConfigured
      ? undefined
      : `Logged for ${rows.length} recipient(s), but not actually sent — no SMS provider is connected yet.`
  };
}

// Exported for unit testing against a mocked Supabase admin client.
module.exports.sendMessage = sendMessage;
module.exports.resolveRecipients = resolveRecipients;
