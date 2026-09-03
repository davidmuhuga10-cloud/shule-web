/**
 * deliver-sms-background.js
 * ----------------------------------------------------------------------------
 * The part of sending a message that actually talks to Africa's Talking —
 * split out of send-message.js so the admin who clicks "Send" gets an
 * immediate "Sent" response instead of waiting for every recipient (a
 * school-wide broadcast can be hundreds of guardians) to be dialed out.
 *
 * send-message.js writes each recipient's message_logs row as status
 * 'queued', then fires an internal HTTP request at this function and moves
 * on WITHOUT waiting for it to finish. Netlify treats any function whose
 * filename ends in "-background.js" specially: it responds 202 the instant
 * this handler is invoked, and lets the handler itself keep running for up
 * to ~15 minutes — plenty for a batch that used to time out a normal
 * request/response function.
 *
 * There is no signed-in caller here (nothing but send-message.js ever hits
 * this URL) — the internal token from _lib/internalToken.js is the only
 * gate. A request without a valid one is dropped silently: an attacker
 * doesn't get a different response to learn anything from, and the schools
 * whose batch is actually pending just see it stay 'queued' (visible in SMS
 * history) rather than any 500 that would hint the endpoint exists.
 * ----------------------------------------------------------------------------
 */
const { getAdminClient } = require('./_lib/supabaseAdmin');
const { loadSmsConfig, isConfigured, sendBulkSms } = require('./_lib/smsProvider');
const { verify } = require('./_lib/internalToken');

async function deliverBatch(admin, batchId) {
  const { data: rows, error } = await admin
    .from('message_logs')
    .select('id, phone, body')
    .eq('batch_id', batchId)
    .eq('status', 'queued');
  if (error || !rows || !rows.length) return;

  const smsConfig = await loadSmsConfig(admin);
  if (!isConfigured(smsConfig)) {
    // Provider got unconfigured between send-message.js queuing the rows
    // and this function picking them up (or never was) — leave an honest
    // trail rather than a row stuck at 'queued' forever.
    await admin.from('message_logs')
      .update({ status: 'failed', provider_response: 'SMS provider is not configured.' })
      .eq('batch_id', batchId).eq('status', 'queued');
    return;
  }

  // Every row in one batch shares the same message body (one "Send" click),
  // so one bulk call — chunked internally by sendBulkSms — covers the lot.
  const body = rows[0].body;
  const results = await sendBulkSms(smsConfig, rows.map((r) => r.phone), body);

  for (let i = 0; i < rows.length; i++) {
    const r = results[i] || { status: 'failed', messageId: null, raw: 'No result returned.' };
    await admin.from('message_logs').update({
      status: r.status,
      provider_response: `${r.raw}${r.messageId ? ` (id: ${r.messageId})` : ''}`
    }).eq('id', rows[i].id);
  }
}

exports.handler = async (event) => {
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON body.' };
  }

  const claims = verify(payload.token);
  if (!claims || !claims.batch_id) {
    return { statusCode: 401, body: 'Invalid or expired internal token.' };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('deliver-sms-background: could not get admin client:', e);
    return { statusCode: 500, body: 'Server error.' };
  }

  try {
    await deliverBatch(admin, claims.batch_id);
  } catch (e) {
    console.error('deliver-sms-background error:', e);
  }
  return { statusCode: 200, body: 'ok' };
};

// Exported for unit testing against a mocked Supabase admin client.
module.exports.deliverBatch = deliverBatch;
