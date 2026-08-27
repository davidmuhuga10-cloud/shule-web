/**
 * smsCredits.mjs — the SCHOOL side of "buy SMS credits" (Admin_Dashboard_
 * Architecture3.docx). A school pays the Super Admin directly (instructed to
 * send payment to 0705041512), then submits the payment confirmation
 * message text here; the Super Admin reviews/approves it from the /admin
 * mini-app (see admin/js/adminApi.js — a completely separate client, but the
 * same sms_credit_requests table, RLS-scoped by school on this side, opened
 * up cross-school only through the admin_* SECURITY DEFINER functions on
 * that side).
 *
 * Plain RLS-scoped reads/insert here (see migrations/0035_admin_dashboard.
 * sql's sms_wallets/sms_credit_requests/sms_credit_ledger policies) — no
 * Netlify function needed for the submission itself, only for the outbound
 * "text the admin" notification afterward (sendAdminNotification below),
 * same reasoning as messaging.mjs's send().
 */
import { ok, err } from './_util.mjs';
import { getAccessToken } from '../auth.js';

export function createSmsCreditsApi(supabase) {
  return {
    async wallet() {
      const { data, error } = await supabase.from('sms_wallets').select('*').maybeSingle();
      if (error) return err(error.message);
      return ok(data || { balance: 0 });
    },

    async requests() {
      const { data, error } = await supabase.from('sms_credit_requests').select('*').order('created_at', { ascending: false });
      if (error) return err(error.message);
      return ok(data || []);
    },

    async ledger() {
      const { data, error } = await supabase.from('sms_credit_ledger').select('*').order('created_at', { ascending: false });
      if (error) return err(error.message);
      return ok(data || []);
    },

    /** Submits the request, then best-effort notifies the Super Admin (a
     *  failed notification still leaves the request itself submitted and
     *  visible in the admin queue — it just means the admin finds out from
     *  the dashboard rather than a text, so this never blocks the submit). */
    async submitRequest({ requested_credits, amount_paid, payment_message }) {
      if (!requested_credits || requested_credits <= 0) return err('Enter how many SMS credits you are requesting.');
      if (!String(payment_message || '').trim()) return err('Paste the payment confirmation message you received.');

      const { data, error } = await supabase
        .from('sms_credit_requests')
        .insert({ requested_credits, amount_paid: amount_paid || null, payment_message: payment_message.trim() })
        .select('id').single();
      if (error) return err(error.message);

      try {
        const token = await getAccessToken();
        if (token) {
          await fetch('/.netlify/functions/sms-credit-notify', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ request_id: data.id })
          });
        }
      } catch (e) {
        // Notification is best-effort — see header comment.
      }

      return ok(data);
    }
  };
}
