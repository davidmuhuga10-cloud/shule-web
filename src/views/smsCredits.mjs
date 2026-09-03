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
 *
 * Redesign (design review, "Option B" of three): balance and request
 * history used to be two separate cards, each wrapped in a colored
 * side-accent border (tile-teal / tile-amber) — direct feedback was that
 * the two colored strips made a screen that's really just "one number and
 * a button" look busier than it needed to. Now it's ONE plain card (no
 * accent color at all): the balance/buy-button strip on top, a single
 * plain rule, then requests listed underneath as simple rows instead of a
 * table — one wallet, not two competing boxes.
 */
import { esc, toast, loader, withBusy, modal, closeModal, fmtDate } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const ADMIN_PAY_PHONE = '0705041512';

export async function renderSmsCredits(body) {
  body.innerHTML = `
    <div class="card sms-wallet">
      <div class="sms-wallet-hero">
        <div>
          <div class="muted" style="font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:650">SMS credits remaining</div>
          <div id="sms-balance" style="font-size:34px;font-weight:700;font-variant-numeric:tabular-nums">${loader()}</div>
        </div>
        <button class="btn" id="sms-buy-btn">Buy SMS Credits</button>
      </div>
      <div class="sms-wallet-div">
        <div class="sms-wallet-subh">Your requests</div>
        <div id="sms-req-list" class="sms-wallet-rows">${loader()}</div>
      </div>
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
    listEl.innerHTML = `<div class="empty" style="padding:20px 0"><div class="e-ico">📶</div><h3>No requests yet</h3><p>Requests you submit will show up here with their status.</p></div>`;
    return;
  }
  listEl.innerHTML = rows.map((r) => `<div class="sms-wallet-row">
      <span>${esc(String(r.requested_credits))} credits <span class="d">— ${fmtDate(r.created_at)}${r.amount_paid != null ? ` · KSH ${esc(String(r.amount_paid))}` : ''}</span></span>
      <span class="badge ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'}">${esc(r.status)}</span>
    </div>`).join('');
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
