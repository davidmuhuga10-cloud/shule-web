/**
 * financeCollections.mjs — brief §Collections: record a payment (auto
 * receipt + auto vote-head allocation, overpayment becomes an unallocated
 * credit — see finance_allocate_collection in migrations/0031), list
 * recent collections, and per-row Print / Reverse / Transfer actions.
 * Reused as-is (minus the "Record Collection" button) for a single
 * student's Collections tab from financeStudent.mjs.
 */
import { esc, toast, modal, closeModal, confirmAction, loader, withBusy, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { amountInWords } from '../lib/finance/amountInWords.mjs';

export async function viewFinanceCollections(root, access, opts) {
  opts = opts || {};
  await load(root, access, opts);
}

async function load(root, access, opts) {
  root.innerHTML = loader();
  const res = await Db.finance.collections.list({ student_id: opts.studentId || undefined, limit: 300 });
  if (!res.ok) { root.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  let rows = res.data;
  let filterText = '';

  const renderTable = () => {
    const filtered = opts.studentId ? rows : rows.filter((r) => !filterText ||
      (r.students && r.students.full_name || '').toLowerCase().indexOf(filterText.toLowerCase()) !== -1 ||
      (r.students && r.students.admission_no || '').toLowerCase().indexOf(filterText.toLowerCase()) !== -1 ||
      (r.receipt_no || '').toLowerCase().indexOf(filterText.toLowerCase()) !== -1);
    return `
    <div class="card"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Date</th><th>Receipt No</th>${opts.studentId ? '' : '<th>Student</th><th>Class</th>'}<th>Mode</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${filtered.map((c) => `<tr>
        <td>${new Date(c.created_at).toLocaleDateString()}</td>
        <td>${esc(c.receipt_no || '')}</td>
        ${opts.studentId ? '' : `<td>${esc(c.students ? c.students.full_name : '')} <span class="muted">${esc(c.students ? c.students.admission_no : '')}</span></td><td>${esc(c.students && c.students.classes ? c.students.classes.name : '')}</td>`}
        <td>${esc(modeLabel(c.mode))}</td>
        <td class="num">${Number(c.amount || 0).toLocaleString()}</td>
        <td>${statusBadge(c.status)}</td>
        <td>
          <button class="btn secondary sm" data-print="${c.id}">Print</button>
          ${access.canCollect && c.status === 'active' ? `<button class="btn secondary sm" data-reverse="${c.id}">Reverse</button>
          <button class="btn secondary sm" data-transfer="${c.id}">Transfer</button>` : ''}
        </td>
      </tr>`).join('') || `<tr><td colspan="${opts.studentId ? 5 : 7}" class="muted">No collections yet.</td></tr>`}</tbody>
    </table></div></div>`;
  };

  root.innerHTML = `
    <div class="page-head"><div>
      ${opts.studentId ? '' : '<div class="field" style="max-width:280px"><input id="fc-search" placeholder="Search by student, admission no. or receipt no."></div>'}
    </div>
      ${access.canCollect ? '<button class="btn" id="fc-record">+ Record Collection</button>' : ''}
    </div>
    <div id="fc-table">${renderTable()}</div>
  `;

  const wireRows = () => {
    root.querySelectorAll('[data-print]').forEach((b) => b.onclick = () => {
      const c = rows.find((x) => x.id === b.dataset.print);
      printReceipt(c);
    });
    root.querySelectorAll('[data-reverse]').forEach((b) => b.onclick = () => {
      confirmAction('Reverse this collection? This restores the student\'s balance and cannot be undone.', () => withBusy(b, async () => {
        const reason = window.prompt('Reason for reversal (optional):') || null;
        const r = await Db.finance.collections.reverse(b.dataset.reverse, reason);
        if (!r.ok) { toast(r.message, 'err'); return; }
        toast('Collection reversed.', 'ok');
        await load(root, access, opts);
      }), true);
    });
    root.querySelectorAll('[data-transfer]').forEach((b) => b.onclick = () => openTransferModal(root, access, opts, b.dataset.transfer));
  };
  wireRows();

  if (!opts.studentId) {
    root.querySelector('#fc-search').oninput = (e) => {
      filterText = e.target.value;
      root.querySelector('#fc-table').innerHTML = renderTable();
      wireRows();
    };
  }
  if (access.canCollect) {
    root.querySelector('#fc-record').onclick = () => openRecordModal(root, access, opts);
  }
}

function modeLabel(mode) { return { cash: 'Cash', paybill: 'Paybill', bank: 'Bank', other: 'Other' }[mode] || mode || ''; }
function statusBadge(status) {
  if (status === 'reversed') return '<span class="badge amber">Reversed</span>';
  if (status === 'transferred') return '<span class="badge amber">Transferred</span>';
  return '<span class="badge green">Active</span>';
}

async function openTransferModal(root, access, opts, collectionId) {
  const q = window.prompt('Search the student to transfer this payment to (name or admission no.):');
  if (!q) return;
  const res = await Db.finance.students.search(q);
  if (!res.ok || !res.data.length) { toast('No matching student found.', 'err'); return; }
  const target = res.data[0];
  confirmAction(`Transfer this payment to ${target.full_name} (${target.admission_no})?`, () => withBusy(document.body, async () => {
    const r = await Db.finance.collections.transfer(collectionId, target.id);
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast('Payment transferred.', 'ok');
    await load(root, access, opts);
  }));
}

function openRecordModal(root, access, opts) {
  modal({
    title: 'Record Collection',
    body: `
      ${opts.studentId
        ? `<p class="hint" style="margin-top:0">Recording for <b>${esc(opts.studentName || '')}</b>.</p><input type="hidden" id="rc-student-id" value="${esc(opts.studentId)}">`
        : `<div class="field"><label>Student</label><input id="rc-student-q" placeholder="Type name or admission no. to search…" autocomplete="off">
           <div id="rc-student-results" class="search-results"></div>
           <input type="hidden" id="rc-student-id"></div>`}
      <div class="grid2">
        <div class="field"><label>Amount (KES)</label><input id="rc-amount" type="number" min="0.01" step="0.01"></div>
        <div class="field"><label>Mode</label><select id="rc-mode">
          <option value="cash">Cash</option><option value="paybill">Paybill / M-Pesa</option><option value="bank">Bank</option><option value="other">Other</option>
        </select></div>
      </div>
      <div class="field"><label>Reference (optional)</label><input id="rc-reference" placeholder="e.g. M-Pesa code"></div>
      <div class="field"><label>Notes (optional)</label><input id="rc-notes"></div>
    `,
    okLabel: 'Record & Print Receipt',
    onOk: async () => {
      const studentId = document.getElementById('rc-student-id').value;
      const amount = document.getElementById('rc-amount').value;
      if (!studentId) { toast('Choose a student.', 'err'); return; }
      if (!amount || Number(amount) <= 0) { toast('Enter an amount greater than zero.', 'err'); return; }
      const mode = document.getElementById('rc-mode').value;
      const reference = document.getElementById('rc-reference').value;
      const notes = document.getElementById('rc-notes').value;
      const res = await Db.finance.collections.record(studentId, amount, mode, reference, notes);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Collection recorded.', 'ok');
      await load(root, access, opts);
      const listRes = await Db.finance.collections.list({ student_id: studentId, limit: 1 });
      if (listRes.ok && listRes.data[0]) printReceipt(listRes.data[0]);
    }
  });

  if (!opts.studentId) {
    const qEl = document.getElementById('rc-student-q');
    const resultsEl = document.getElementById('rc-student-results');
    let t = null;
    qEl.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = qEl.value.trim();
        if (q.length < 2) { resultsEl.innerHTML = ''; return; }
        const r = await Db.finance.students.search(q);
        const list = r.ok ? r.data : [];
        resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}" data-name="${esc(s.full_name)}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('') || '<div class="muted" style="padding:6px">No matches.</div>';
        resultsEl.querySelectorAll('[data-id]').forEach((h) => h.onclick = () => {
          document.getElementById('rc-student-id').value = h.dataset.id;
          qEl.value = h.dataset.name;
          resultsEl.innerHTML = '';
        });
      }, 250);
    };
  }
}

/** Reprints a past receipt exactly as issued (brief scenario #15) — pulls
 *  the collection's actual allocation rows rather than recomputing, so a
 *  reprint always matches what was handed to the parent at the time. */
async function printReceipt(collection) {
  if (!collection) return;
  const [allocRes, studentRes] = await Promise.all([
    Db.finance.collections.allocations(collection.id),
    collection.students ? Promise.resolve({ ok: true, data: collection.students }) : Promise.resolve({ ok: true, data: null })
  ]);
  const allocations = allocRes.ok ? allocRes.data : [];
  const student = studentRes.data;
  const schoolName = (state.settings && state.settings.school_name) || 'Shule';
  const win = window.open('', '_blank', 'width=480,height=700');
  if (!win) { toast('Please allow pop-ups to print the receipt.', 'err'); return; }
  win.document.write(`
    <html><head><title>Receipt ${esc(collection.receipt_no || '')}</title>
    <style>
      body{font-family:Arial,sans-serif;margin:16px;color:#111}
      .fin-receipt{width:100%;font-size:12.5px;border:1px solid #000}
      .fr-h{text-align:center;padding:10px;border-bottom:1px solid #000}
      .fr-row{display:flex;justify-content:space-between;padding:3px 10px}
      table{width:100%;border-collapse:collapse;margin:8px 0}
      table th,table td{border:1px solid #000;padding:4px 6px;font-size:11.5px}
      .fr-words{padding:6px 10px;font-style:italic;border-top:1px solid #000}
    </style></head><body onload="window.print()">
    <div class="fin-receipt">
      <div class="fr-h"><h3 style="margin:2px 0">${esc(schoolName)}</h3><div>Official Receipt</div></div>
      <div class="fr-row"><span>Receipt No.</span><b>${esc(collection.receipt_no || '')}</b></div>
      <div class="fr-row"><span>Date</span><span>${new Date(collection.created_at).toLocaleString()}</span></div>
      <div class="fr-row"><span>Student</span><span>${esc(student ? student.full_name : '')}</span></div>
      <div class="fr-row"><span>Admission No.</span><span>${esc(student ? student.admission_no : '')}</span></div>
      <div class="fr-row"><span>Class</span><span>${esc(student && student.classes ? student.classes.name : '')}</span></div>
      <div class="fr-row"><span>Mode</span><span>${esc(modeLabel(collection.mode))}${collection.reference ? ' — ' + esc(collection.reference) : ''}</span></div>
      <table><thead><tr><th>Vote Head</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${allocations.map((a) => `<tr><td>${esc(a.vote_head_id ? (a.finance_vote_heads ? a.finance_vote_heads.name : '') : 'Unallocated Credit')}</td><td style="text-align:right">${Number(a.amount || 0).toLocaleString()}</td></tr>`).join('')}</tbody>
      </table>
      <div class="fr-row"><b>Total Paid</b><b>KES ${Number(collection.amount || 0).toLocaleString()}</b></div>
      <div class="fr-words">${esc(amountInWords(collection.amount))}</div>
      ${collection.status !== 'active' ? `<div class="fr-row" style="color:#900"><b>${esc(collection.status === 'reversed' ? 'REVERSED' : 'TRANSFERRED')}</b></div>` : ''}
    </div>
    </body></html>
  `);
  win.document.close();
}
