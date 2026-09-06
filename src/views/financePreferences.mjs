/**
 * financePreferences.mjs — Finance's own "Preferences / Customization" tab
 * (Finance Expansion brief item 1.2): "almost the same as what we have as
 * Permissions in the Exams system" — same settings-key-backed toggle-card
 * pattern as permissionsSettings.mjs (each control saves itself on change,
 * no separate Save button), just scoped to Finance's own settings.
 *
 * Today's one setting: whether recording a Collection also texts the
 * parent a payment-received + new-balance SMS. Off by default per the
 * brief ("turn it off by default") — a school opts in, and can edit the
 * message template that gets used (financeCollections.mjs's
 * buildReceiptSmsBody() below is the single place that fills it in).
 */
import { esc, toast } from '../app.js';
import { Db } from '../lib/api/index.mjs';

// Kept under 160 characters even with realistic worst-case values (a long
// school name, a 6-figure amount) so a receipt SMS is always exactly one
// segment — see verify_finance_sms.mjs for the length check against real
// data. Placeholders: {student}, {amount}, {receipt_no}, {balance}, {school}.
export const DEFAULT_RECEIPT_SMS_TEMPLATE =
  "Dear parent, we've received KES {amount} for {student} (Receipt {receipt_no}). New balance: KES {balance}. Thank you - {school}.";

export async function viewFinancePreferences(root, access) {
  // School-wide default behavior (what every future Collection is pre-
  // ticked to do), same manage-level gate financeInvoicing.mjs uses for
  // fee structures/notes — a bursar who can only record collections
  // shouldn't be able to change what every OTHER collector's form defaults
  // to. They still see and can override the checkbox on their own receipt.
  if (!access || !access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to change Finance preferences — ask your school admin for full Finance access.</div>`;
    return;
  }
  const res = await Db.settings.get();
  const settings = res.ok ? res.data : {};
  render(root, settings);
}

function render(root, settings) {
  const smsOnReceipt = String(settings.finance_sms_on_receipt) === 'true';
  const template = settings.finance_sms_receipt_template || DEFAULT_RECEIPT_SMS_TEMPLATE;

  root.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Collections — SMS on receipt</h3></div>
      <div class="card-b">
        <label style="display:flex;align-items:center;gap:12px;cursor:pointer">
          <input type="checkbox" id="fp-sms-on-receipt" ${smsOnReceipt ? 'checked' : ''}>
          <span><b>Text the parent automatically when a payment is recorded</b><br>
          <span class="hint" style="margin:0">Off by default. When on, recording a Collection is pre-ticked to also send the parent a payment-received SMS with the new balance — the person recording the payment can still untick it for that one receipt. Uses your school's existing SMS balance.</span></span>
        </label>
      </div>
      <div class="card-b" style="border-top:1px solid var(--line)">
        <div class="field">
          <label>Receipt SMS message</label>
          <textarea id="fp-sms-template" rows="3" maxlength="320">${esc(template)}</textarea>
          <div class="hint" id="fp-sms-len" style="margin-top:4px"></div>
          <div class="hint" style="margin-top:4px">Placeholders: <code>{student}</code>, <code>{amount}</code>, <code>{receipt_no}</code>, <code>{balance}</code>, <code>{school}</code></div>
        </div>
        <button class="btn sm" id="fp-sms-save">Save message</button>
        <button class="btn sm secondary" id="fp-sms-reset" style="margin-left:8px">Reset to default</button>
      </div>
    </div>
  `;

  const lenEl = root.querySelector('#fp-sms-len');
  const taEl = root.querySelector('#fp-sms-template');
  const updateLen = () => {
    // Rough same-ballpark preview using realistic placeholder values —
    // the exact length depends on the real student/amount/balance at send
    // time, so this is a guide, not an exact count.
    const sample = fillTemplate(taEl.value, { student: 'Jane Wanjiru', amount: '15,000', receipt_no: 'RCT-000123', balance: '5,000', school: settings.school_name || 'Your School' });
    const segments = Math.ceil((sample.length || 1) / 160);
    lenEl.textContent = `${sample.length} characters with sample values — ${segments} SMS segment${segments === 1 ? '' : 's'}${segments > 1 ? ' (consider shortening — extra segments cost more credits)' : ''}.`;
  };
  updateLen();
  taEl.oninput = updateLen;

  root.querySelector('#fp-sms-on-receipt').onchange = async (e) => {
    const val = e.target.checked;
    const r = await Db.settings.save({ finance_sms_on_receipt: String(val) });
    if (!r.ok) { toast(r.message, 'err'); e.target.checked = !val; return; }
    toast(val ? 'Collections will now default to sending a receipt SMS.' : 'Collections will no longer default to sending a receipt SMS.', 'ok');
  };

  root.querySelector('#fp-sms-save').onclick = async () => {
    const val = taEl.value.trim();
    if (!val) { toast('Message cannot be empty.', 'err'); return; }
    const r = await Db.settings.save({ finance_sms_receipt_template: val });
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast('Receipt SMS message saved.', 'ok');
  };

  root.querySelector('#fp-sms-reset').onclick = () => {
    taEl.value = DEFAULT_RECEIPT_SMS_TEMPLATE;
    updateLen();
  };
}

/** Shared with financeCollections.mjs so the live send uses EXACTLY the
 *  same fill logic this preview does — a placeholder left unfilled here
 *  would otherwise show up differently in the two places. */
export function fillTemplate(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] !== undefined ? values[key] : m));
}
