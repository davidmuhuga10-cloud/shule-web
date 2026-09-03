/**
 * messaging.mjs — compose-and-log messaging. The actual send goes through
 * the `send-message` Netlify function (sendMessageFn, injected — see
 * index.mjs), because fanning a "whole class" send out into one row per
 * guardian phone, and eventually calling a real SMS provider, both need to
 * happen server-side. Everything else here (recipient previews, history) is
 * a plain RLS-scoped read, same as every other module.
 */
import { ok, err, createMemoCache, clearAllCaches } from './_util.mjs';

export function createMessagingApi(supabase, sendMessageFn, resendMessageFn) {
  // Same short-window in-memory memoization pattern as the rest of the app
  // (see _util.mjs's createMemoCache header comment for the app-wide
  // invalidation bus this shares). Scoped per createMessagingApi() CALL,
  // not module-level — see the same note in academics.mjs/students.mjs.
  const { cached } = createMemoCache(20000);
  return {
    /** Guardians for a class — shown in the compose screen so an admin/
     *  teacher can see who a "whole class" send will actually reach before
     *  sending it. */
    async classRecipients(class_id) {
      if (!class_id) return err('Choose a class.');
      return cached('classRecipients', class_id, async () => {
        const { data, error } = await supabase
          .from('students')
          .select('id, full_name, guardian_name, guardian_contact')
          .eq('class_id', class_id).eq('status', 'active')
          .order('full_name');
        if (error) return err(error.message);
        return ok(data || []);
      });
    },

    async history(limit) {
      return cached('history', limit || 200, async () => {
        const { data, error } = await supabase
          .from('message_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(limit || 200);
        if (error) return err(error.message);
        return ok(data || []);
      });
    },

    /** payload: { scope: 'class'|'individual_student'|'individual_staff'|'broadcast',
     *             class_id?, student_id?, staff_id?, body }
     *  OR { scope: 'personalized', scope_label?, recipients: [{student_id?, staff_id?, phone, body}] }
     *  — Messaging_Overhaul.docx items 4 (fee balances) and 6 (exam results):
     *  one batch, every recipient gets their OWN text. Goes through the
     *  send-message Netlify function, not `supabase` directly (see header
     *  comment) — clearAllCaches() still needs to run on success since it
     *  writes message_logs, which history() above caches. */
    async send(payload) {
      payload = payload || {};
      if (!payload.scope) return err('Choose who this message goes to.');
      if (payload.scope === 'personalized') {
        if (!Array.isArray(payload.recipients) || !payload.recipients.length) return err('No recipients to send to.');
      } else {
        if (!String(payload.body || '').trim()) return err('Message cannot be empty.');
        if (payload.scope === 'class' && !payload.class_id) return err('Choose a class.');
        if (payload.scope === 'individual_student' && !payload.student_id) return err('Choose a student.');
        if (payload.scope === 'individual_staff' && !payload.staff_id) return err('Choose a staff member.');
      }
      const res = await sendMessageFn(payload);
      if (res && res.ok) clearAllCaches();
      return res;
    },

    /** Messaging_Overhaul.docx item 8 — "a resend option for anything that
     *  failed" in the SMS History batch detail view. ids: message_logs row
     *  id(s) to retry; anything that isn't currently 'failed' is left
     *  untouched server-side. */
    async resend(ids) {
      ids = Array.isArray(ids) ? ids : [ids];
      if (!ids.length) return err('Nothing selected to resend.');
      const res = await resendMessageFn({ ids });
      if (res && res.ok) clearAllCaches();
      return res;
    }
  };
}

/** Groups raw message_logs rows (one per recipient) into sends (one per
 *  batch_id) for a readable history list — pure function, no I/O, so views
 *  can call it directly and it's trivially unit-testable.
 *
 *  Also totals `credits` (Messaging_Overhaul.docx item 7's "Credits Used"
 *  column) and keeps `sent_by` (the composing staff member's id — the
 *  view resolves this to a name against the staff list it already has,
 *  rather than this pure function needing a second data source). A
 *  'personalized' batch (item 4/6) has a different body per recipient, so
 *  `body` on the batch itself is only ever the FIRST recipient's — good
 *  enough for a one-line preview in the list; the detail view (item 8)
 *  shows every recipient's own text. */
export function groupMessagesByBatch(rows) {
  const batches = {};
  const order = [];
  (rows || []).forEach((r) => {
    if (!batches[r.batch_id]) {
      batches[r.batch_id] = {
        batch_id: r.batch_id, scope_label: r.scope_label, recipient_scope: r.recipient_scope,
        body: r.body, channel: r.channel, created_at: r.created_at, sent_by: r.sent_by,
        recipients: [], counts: { logged: 0, queued: 0, sent: 0, failed: 0 }, credits: 0
      };
      order.push(r.batch_id);
    }
    const b = batches[r.batch_id];
    b.recipients.push(r);
    if (b.counts[r.status] !== undefined) b.counts[r.status]++;
    b.credits += Number(r.credits || 0);
  });
  return order.map((id) => batches[id]);
}
