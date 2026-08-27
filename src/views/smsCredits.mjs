/**
 * smsCredits.mjs — school-side "SMS Credits" screen (Admin_Dashboard_
 * Architecture3.docx). Shows this school's SMS wallet balance, lets an
 * admin/bursar submit a purchase request (instructed to pay 0705041512 and
 * paste the confirmation message), and shows the status/history of past
 * requests. The Super Admin reviews and approves from the separate /admin
 * dashboard — see admin/js/schools.js's SMS queue screen.
 */
import { esc, toast, loader, withBusy, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const ADMIN_PAY_PHONE = '0705041512';

export async function viewSmsCredits(root) {
  await render(root);
}

async function render(root) {
  root.innerHTML = `
    <div class="page-head"><div><h2>SMS Credits</h2><p>Buy SMS credits for sending messages to guardians. Payments are reviewed and approved by the platform administrator.</p></div></div>
    <div class="card"><div class="card-b" id="sms-wallet-box">${loader()}</div></div>
    <div class="card" style="margin-top:16px"><div class="card-h">Request more credits</div>
      <div class="card-b">
        <p class="muted">Send your payment to <b>${ADMIN_PAY_PHONE}</b>, then paste the payment confirmation message below.</p>
        <div class="form-row"><label>Credits requested</label><input id="sms-req-credits" type="number" min="1" placeholder="e.g. 1000"></div>
        <div class="form-row"><label>Amount paid (optional)</label><input id="sms-req-amount" type="number" min="0" step="0.01" placeholder="e.g. 1500"></div>
        <div class="form-row"><label>Payment confirmation message</label><textarea id="sms-req-message" rows="3" placeholder="Paste the M-Pesa/other confirmation message here…"></textarea></div>
        <button class="btn primary" id="sms-req-submit">Submit request</button>
      </div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h">Your requests</div>
      <div class="card-b" id="sms-req-list">${loader()}</div>
    </div>
  `;

  const walletBox = root.querySelector('#sms-wallet-box');
  const walletRes = await Db.smsCredits.wallet();
  walletBox.innerHTML = walletRes.ok
    ? `<div style="font-size:28px;font-weight:700">${esc(String((walletRes.data && walletRes.data.balance) || 0))}</div><div class="muted">SMS credits remaining</div>`
    : `⚠️ ${esc(walletRes.message)}`;

  const submitBtn = root.querySelector('#sms-req-submit');
  submitBtn.onclick = () => withBusy(submitBtn, async () => {
    const credits = parseInt(root.querySelector('#sms-req-credits').value, 10);
    const amount = parseFloat(root.querySelector('#sms-req-amount').value);
    const messageText = root.querySelector('#sms-req-message').value;
    const res = await Db.smsCredits.submitRequest({
      requested_credits: credits,
      amount_paid: isNaN(amount) ? null : amount,
      payment_message: messageText
    });
    if (!res.ok) { toast(res.message, 'err'); return; }
    toast('Request submitted — the platform administrator has been notified.', 'ok');
    render(root);
  }, 'Submitting…');

  const listEl = root.querySelector('#sms-req-list');
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
