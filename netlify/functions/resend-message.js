/**
 * resend-message.js
 * ----------------------------------------------------------------------------
 * Messaging_Overhaul.docx item 8: the SMS History batch detail view gets a
 * "resend" action for anything that failed. Flips the chosen message_logs
 * rows back to 'queued' (only the ones that are actually 'failed' — a
 * 'sent' or already-'queued' row is left alone) and re-triggers
 * deliver-sms-background.js for their batch(es); deliverBatch only ever
 * touches rows still marked 'queued', so this naturally picks up just the
 * resent rows without re-sending anything that already succeeded.
 *
 * Does NOT debit sms_wallets again — the school was already charged once
 * for the original attempt; a provider-side failure isn't the school's
 * fault to pay for twice.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient, requireStaff } = require('./_lib/supabaseAdmin');
const { triggerBackgroundDelivery } = require('./send-message');

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function resendMessages(admin, payload, callerProfile, deliveryTrigger) {
  const ids = Array.isArray(payload.ids) ? payload.ids : (payload.id ? [payload.id] : []);
  if (!ids.length) return { ok: false, message: 'Nothing selected to resend.' };

  const { data: rows, error } = await admin
    .from('message_logs')
    .select('id, batch_id, status')
    .in('id', ids)
    .eq('school_id', callerProfile.school_id);
  if (error) return { ok: false, message: error.message };

  const failed = (rows || []).filter((r) => r.status === 'failed');
  if (!failed.length) return { ok: false, message: 'Nothing here has failed — only failed messages can be resent.' };

  const failedIds = failed.map((r) => r.id);
  const { error: updErr } = await admin.from('message_logs')
    .update({ status: 'queued', provider_response: null })
    .in('id', failedIds);
  if (updErr) return { ok: false, message: updErr.message };

  const batchIds = [...new Set(failed.map((r) => r.batch_id))];
  for (const batchId of batchIds) {
    await (deliveryTrigger || triggerBackgroundDelivery)(batchId);
  }

  return { ok: true, resent: failedIds.length };
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
    return json(200, await resendMessages(admin, payload, caller.profile));
  } catch (e) {
    console.error('resend-message error:', e);
    return json(500, { ok: false, message: e.message || 'Unexpected server error.' });
  }
};

// Exported for unit testing against a mocked Supabase admin client.
module.exports.resendMessages = resendMessages;
