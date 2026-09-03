/**
 * smsCredits.mjs — the "SMS Credits" submodule under Messaging (moved here
 * per direct request — this used to be its own top-level sidebar item, and
 * before that, messaging.mjs's placeholder "Buy Bulk SMS" tab). The Super
 * Admin reviews and approves purchase requests from the separate /admin
 * dashboard — see admin.js's SMS Requests screen.
 *
 * Messaging_Overhaul.docx item 9: "Keep this screen simple: just the
 * remaining balance and a clear way to buy more." The purchase-request
 * form (pay 0705041512, paste the confirmation message) used to sit open
 * on the page at all times, with its own request history below it — moved
 * the form into a modal behind one "Buy SMS Credits" button so the screen
 * itself is just the balance and that button; past requests stay one tap
 * away underneath, for the rare time someone needs to check on one.
 *
 * Exported as renderSmsCredits(body) — a plain tab-body renderer, not a
 * full view — so messaging.mjs can host it inside its own tab bar/page-head
 * exactly the way it already hosts Compose/History.
 */
import { esc, toast, loader, withBusy, modal, closeModal, fmtDate } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const ADMIN_PAY_PHONE = '0705041512';

export async function renderSmsCredits(body) {
  body.innerHTML = `
    <div class="card side-accent tile-teal">
      <div class="card-b" style="text-align:center;padding:34px 20px">
        <div class="muted" style="font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:650">SMS credits remaining</div>
        <div id="sms-balance" style="font-size:40px;font-weight:700;margin:8px 0 20px">${loader()}</div>
        <button class="btn" id="sms-buy-btn">Buy SMS Credits</button>
      </div>
    </div>
    <div class="card side-accent tile-amber" style="margin-top:16px">
      <div class="card-h">Your requests</div>
      <div class="card-b" id="sms-req-list">${loader()}</div>
    </div>
  `;

  const balanceEl = body.querySelector('#sms-balance');
  const walletRes = await Db.smsCredits.wallet();
  balanceEl.textContent = walletRes.ok ? String((walletRes.data && walletRes.data.balance) || 0) : '—';
  if (!walletRes.ok) toast(walletRes.message, 'err');

  body.querySelector('#sms-buy-btn').onclick = () => openBuyModal(body);

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

function openBuyModal(body) {
  modal({
    title: 'Buy SMS Credits',
    okLabel: 'Submit request',
    busyLabel: 'Submitting…',
    body: `
      <p class="hint" style="margin-top:0">Send your payment to <b>${ADMIN_PAY_PHONE}</b>, then paste the payment confirmation message below. The platform administrator reviews and approves requests from the Admin Dashboard.</p>
      <div class="field"><label>Credits requested</label><input id="sms-req-credits" type="number" min="1" placeholder="e.g. 1000"></div>
      <div class="field"><label>Amount paid (optional)</label><input id="sms-req-amount" type="number" min="0" step="0.01" placeholder="e.g. 1500"></div>
      <div class="field"><label>Payment confirmation message</label><textarea id="sms-req-message" rows="3" placeholder="Paste the M-Pesa/other confirmation message here…"></textarea></div>
    `,
    onOk: async () => {
      const credits = parseInt(document.getElementById('sms-req-credits').value, 10);
      const amount = parseFloat(document.getElementById('sms-req-amount').value);
      const messageText = document.getElementById('sms-req-message').value;
      const res = await Db.smsCredits.submitRequest({
        requested_credits: credits,
        amount_paid: isNaN(amount) ? null : amount,
        payment_message: messageText
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Request submitted — the platform administrator has been notified.', 'ok');
      renderSmsCredits(body);
    }
  });
}
