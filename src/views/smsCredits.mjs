/**
 * smsCredits.mjs — the "SMS Credits" submodule under Messaging (moved here
 * per direct request — this used to be its own top-level sidebar item, and
 * before that, messaging.mjs's placeholder "Buy Bulk SMS" tab). Shows this
 * school's SMS wallet balance, lets an admin/bursar submit a purchase
 * request (instructed to pay 0705041512 and paste the confirmation
 * message), and shows the status/history of past requests. The Super Admin
 * reviews and approves from the separate /admin dashboard — see admin.js's
 * SMS Requests screen.
 *
 * Exported as renderSmsCredits(body) — a plain tab-body renderer, not a
 * full view — so messaging.mjs can host it inside its own tab bar/page-head
 * exactly the way it already hosts Compose/History.
 */
import { esc, toast, loader, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const ADMIN_PAY_PHONE = '0705041512';

export async function renderSmsCredits(body) {
  body.innerHTML = `
    <div class="card"><div class="card-b" id="sms-wallet-box">${loader()}</div></div>
    <div class="card" style="margin-top:16px"><div class="card-h">Request more credits</div>
      <div class="card-b">
        <p class="hint" style="margin-top:0">Send your payment to <b>${ADMIN_PAY_PHONE}</b>, then paste the payment confirmation message below. The platform administrator reviews and approves requests from the Admin Dashboard.</p>
        <div class="field"><label>Credits requested</label><input id="sms-req-credits" type="number" min="1" placeholder="e.g. 1000"></div>
        <div class="field"><label>Amount paid (optional)</label><input id="sms-req-amount" type="number" min="0" step="0.01" placeholder="e.g. 1500"></div>
        <div class="field"><label>Payment confirmation message</label><textarea id="sms-req-message" rows="3" placeholder="Paste the M-Pesa/other confirmation message here…"></textarea></div>
        <button class="btn" id="sms-req-submit">Submit request</button>
      </div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h">Your requests</div>
      <div class="card-b" id="sms-req-list">${loader()}</div>
    </div>
  `;

  const walletBox = body.querySelector('#sms-wallet-box');
  const walletRes = await Db.smsCredits.wallet();
  walletBox.innerHTML = walletRes.ok
    ? `<div style="font-size:28px;font-weight:700">${esc(String((walletRes.data && walletRes.data.balance) || 0))}</div><div class="muted">SMS credits remaining</div>`
    : `⚠️ ${esc(walletRes.message)}`;

  const submitBtn = body.querySelector('#sms-req-submit');
  submitBtn.onclick = () => withBusy(submitBtn, async () => {
    const credits = parseInt(body.querySelector('#sms-req-credits').value, 10);
    const amount = parseFloat(body.querySelector('#sms-req-amount').value);
    const messageText = body.querySelector('#sms-req-message').value;
    const res = await Db.smsCredits.submitRequest({
      requested_credits: credits,
      amount_paid: isNaN(amount) ? null : amount,
      payment_message: messageText
    });
    if (!res.ok) { toast(res.message, 'err'); return; }
    toast('Request submitted — the platform administrator has been notified.', 'ok');
    renderSmsCredits(body);
  }, 'Submitting…');

  const listEl = body.querySelector('#sms-req-list');
  const reqRes = await Db.smsCredits.requests();
  if (!reqRes.ok) { listEl.innerHTML = `⚠️ ${esc(reqRes.message)}`; return; }
  const rows = reqRes.data || [];
  if (!rows.length) {
    listEl.innerHTML = `<div class="empty"><div class="e-ico">📶</div><h3>No requests yet</h3><p>Requests you submit will show up here with their status.</p></div>`;
    return;
  }
  listEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Date</th><th>Credits</th><th>Amount</th><th>Status</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="muted" style="font-size:12px">${fmtDate(r.created_at)}</td>
      <td>${esc(String(r.requested_credits))}</td>
      <td>${r.amount_paid != null ? esc(String(r.amount_paid)) : '—'}</td>
      <td><span class="badge ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'}">${esc(r.status)}</span></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}
