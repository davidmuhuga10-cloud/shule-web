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
import { addressLines, isContactInfoComplete, missingContactInfoHtml } from '../lib/printHeader.mjs';

export async function viewFinanceCollections(root, access, opts) {
  opts = opts || {};
  await load(root, access, opts);
}

async function load(root, access, opts) {
  root.innerHTML = loader();
  const [colRes, termsRes] = await Promise.all([
    Db.finance.collections.list({ student_id: opts.studentId || undefined, limit: 300 }),
    opts.studentId ? Promise.resolve({ ok: true, data: [] }) : Db.terms.list()
  ]);
  if (!colRes.ok) { root.innerHTML = `<div class="card pad">⚠️ ${esc(colRes.message)}</div>`; return; }
  let rows = colRes.data;
  const terms = termsRes.ok ? termsRes.data : [];
  const filters = { text: '', term_id: '', min_amount: '' };

  // Captured by renderTable() on every call so the mobile view (which needs
  // an async per-student balance lookup, unlike the plain desktop table)
  // can be kicked off right after with the exact same filtered set.
  let lastFiltered = [];
  const renderTable = () => {
    const filtered = opts.studentId ? rows : rows.filter((r) => {
      if (filters.text) {
        const t = filters.text.toLowerCase();
        const hit = ((r.students && r.students.full_name) || '').toLowerCase().indexOf(t) !== -1 ||
          ((r.students && r.students.admission_no) || '').toLowerCase().indexOf(t) !== -1 ||
          (r.receipt_no || '').toLowerCase().indexOf(t) !== -1;
        if (!hit) return false;
      }
      if (filters.term_id && r.term_id !== filters.term_id) return false;
      if (filters.min_amount !== '' && Number(r.amount || 0) < Number(filters.min_amount)) return false;
      return true;
    });
    lastFiltered = filtered;
    return `
    <div class="card side-accent tile-teal">
      <div class="card-b table-wrap fcol-desktop-view"><table class="data">
      <thead><tr><th>Date</th><th>Receipt No</th>${opts.studentId ? '' : '<th>Student</th><th>Class</th>'}<th>Mode</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${filtered.map((c) => `<tr>
        <td>${new Date(c.created_at).toLocaleDateString()}</td>
        <td>${esc(c.receipt_no || '')}</td>
        ${opts.studentId ? '' : `<td>${esc(c.students ? c.students.full_name : '')} <span class="muted">${esc(c.students ? c.students.admission_no : '')}</span></td><td>${esc(c.students && c.students.classes ? c.students.classes.name : '')}</td>`}
        <td>${esc(modeLabel(c.mode))}</td>
        <td class="num">${Number(c.amount || 0).toLocaleString()}</td>
        <td>${statusBadge(c.status)}</td>
        <td class="row-actions">
          <button class="icon-btn" data-print="${c.id}" title="Print receipt">🖨️</button>
          ${access.canCollect && c.status === 'active' ? `<button class="icon-btn warn" data-reverse="${c.id}" title="Reverse collection">↩️</button>
          <button class="icon-btn info" data-transfer="${c.id}" title="Transfer to another student">🔀</button>` : ''}
        </td>
      </tr>`).join('') || `<tr><td colspan="${opts.studentId ? 5 : 7}" class="muted">No collections match.</td></tr>`}</tbody>
    </table></div>
      <div class="card-b fcol-mobile-view" id="fc-mobile">${loader()}</div>
    </div>`;
  };
  /** Collections mobile view — two different shapes depending on where
   *  this list is shown:
   *   - Main Collections module (opts.studentId unset): one line per
   *     receipt — date (before the receipt no., per direct request),
   *     student + class/receipt/mode as a subtitle, amount and the
   *     student's current balance (red if owing, green if cleared/
   *     overpaid) on the right. Tapping a row prints that receipt — the
   *     same print already wired to the desktop table's icon button —
   *     since this list has no Reverse/Transfer actions on mobile anyway.
   *   - Student Profile's Collections tab (opts.studentId set): rethought
   *     separately, since Reverse is destructive and shouldn't be one
   *     stray tap away. Each row shows date/receipt/mode/amount (no
   *     invented per-purpose label — one receipt can span several vote
   *     heads) with small Print/Reverse icon buttons on the right,
   *     mirroring how the desktop row already works.
   *  Both cap at the 30 most recent rows shown (already newest-first);
   *  the main-module balance lookups are deduped per student, so this
   *  never fires more than a handful of extra requests even against the
   *  full 300-row list. */
  const renderMobileList = async (filtered) => {
    const mobileEl = root.querySelector('#fc-mobile');
    if (!mobileEl) return;
    const recent = filtered.slice(0, 30);
    if (!recent.length) { mobileEl.innerHTML = '<p class="muted center" style="margin:20px 0">No collections match.</p>'; return; }

    if (opts.studentId) {
      mobileEl.innerHTML = recent.map((c) => `<div class="fcol-row fcol-row-student">
        <div class="l"><span class="name">${esc(fmtShortDate(c.created_at))} · Receipt ${esc(c.receipt_no || '—')}</span><span class="sub">${esc(modeLabel(c.mode))} · ${Number(c.amount || 0).toLocaleString()}</span></div>
        <div class="fcol-icons">
          <button class="fcol-ico" data-mprint-btn="${c.id}" title="Print receipt">🖨️</button>
          ${access.canCollect && c.status === 'active' ? `<button class="fcol-ico warn" data-mreverse="${c.id}" title="Reverse collection">↩️</button>` : ''}
        </div>
      </div>`).join('');
      mobileEl.querySelectorAll('[data-mprint-btn]').forEach((b) => b.onclick = (e) => {
        e.stopPropagation();
        printReceipt(rows.find((x) => x.id === b.dataset.mprintBtn));
      });
      mobileEl.querySelectorAll('[data-mreverse]').forEach((b) => b.onclick = (e) => {
        e.stopPropagation();
        confirmAction('Reverse this collection? This restores the student\'s balance and cannot be undone.', () => withBusy(b, async () => {
          const reason = window.prompt('Reason for reversal (optional):') || null;
          const r = await Db.finance.collections.reverse(b.dataset.mreverse, reason);
          if (!r.ok) { toast(r.message, 'err'); return; }
          toast('Collection reversed.', 'ok');
          await load(root, access, opts);
        }), true);
      });
      return;
    }

    const uniqueIds = [...new Set(recent.map((c) => c.student_id).filter(Boolean))];
    const balMap = new Map();
    await Promise.all(uniqueIds.map(async (id) => {
      const r = await Db.finance.students.balance(id);
      balMap.set(id, r.ok ? Number((r.data || {}).balance || 0) : null);
    }));
    mobileEl.innerHTML = recent.map((c) => {
      const bal = c.student_id ? balMap.get(c.student_id) : null;
      const balHtml = bal == null ? '' : `<span class="fcol-bal ${bal > 0 ? 'owe' : 'ok'}">${bal > 0 ? `Owes ${bal.toLocaleString()}` : (bal < 0 ? `Overpaid ${Math.abs(bal).toLocaleString()}` : 'Cleared')}</span>`;
      const subLine = `${esc(fmtShortDate(c.created_at))} · ${esc(c.receipt_no || '')} · ${esc(c.students && c.students.classes ? c.students.classes.name : '')} · ${esc(modeLabel(c.mode))}`;
      return `<div class="fcol-row" data-mprint="${c.id}">
        <div class="l"><span class="name">${esc(c.students ? c.students.full_name : '')}</span><span class="sub">${subLine}</span></div>
        <div class="r"><span class="amt">${Number(c.amount || 0).toLocaleString()}</span>${balHtml}</div>
      </div>`;
    }).join('');
    mobileEl.querySelectorAll('[data-mprint]').forEach((el) => el.onclick = () => printReceipt(rows.find((x) => x.id === el.dataset.mprint)));
  };

  root.innerHTML = `
    <div class="fin-toolbar">
      ${opts.studentId ? '' : `
      <div class="fin-search"><input id="fc-search" placeholder="Search by student, admission no. or receipt no."></div>
      <div class="fin-filters">
        <div class="field"><label>Term</label><select id="fc-term"><option value="">All terms</option>${terms.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Min. Amount (KES)</label><input id="fc-min" type="number" min="0" placeholder="e.g. 1000"></div>
      </div>`}
      <div class="spacer"></div>
      ${access.canCollect ? '<button class="btn" id="fc-record">+ Record Collection</button>' : ''}
    </div>
    <div id="fc-table">${renderTable()}</div>
  `;
  renderMobileList(lastFiltered);

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
    const refresh = () => { root.querySelector('#fc-table').innerHTML = renderTable(); wireRows(); renderMobileList(lastFiltered); };
    root.querySelector('#fc-search').oninput = (e) => { filters.text = e.target.value; refresh(); };
    root.querySelector('#fc-term').onchange = (e) => { filters.term_id = e.target.value; refresh(); };
    root.querySelector('#fc-min').oninput = (e) => { filters.min_amount = e.target.value; refresh(); };
  }
  if (access.canCollect) {
    root.querySelector('#fc-record').onclick = () => openRecordModal(root, access, opts);
  }
}

function modeLabel(mode) { return { cash: 'Cash', paybill: 'Paybill', bank: 'Bank', other: 'Other' }[mode] || mode || ''; }
function fmtShortDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }); } catch (e) { return ''; }
}
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
        : `<div class="field" style="position:relative"><label>Student</label><input id="rc-student-q" placeholder="Type name or admission no. to search…" autocomplete="off">
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
        if (!q.length) { resultsEl.innerHTML = ''; return; }
        const r = await Db.finance.students.search(q);
        const list = r.ok ? r.data : [];
        resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}" data-name="${esc(s.full_name)}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('') || `<div class="muted" style="padding:6px">No student found matching "${esc(q)}".</div>`;
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
  const studentId = collection.student_id || (collection.students && collection.students.id);
  const [allocRes, studentRes, settingsRes, balRes] = await Promise.all([
    Db.finance.collections.allocations(collection.id),
    collection.students ? Promise.resolve({ ok: true, data: collection.students }) : Promise.resolve({ ok: true, data: null }),
    Db.settings.get(),
    studentId ? Db.finance.students.balance(studentId) : Promise.resolve({ ok: false })
  ]);
  const allocations = allocRes.ok ? allocRes.data : [];
  const student = studentRes.data;
  const settings = settingsRes.ok ? settingsRes.data : (state.settings || {});
  const balance = balRes.ok ? Number(balRes.data.balance || 0) : null;
  const preparedBy = (collection.created_by_profile && collection.created_by_profile.name) || '';

  const win = window.open('', '_blank', 'width=820,height=920');
  if (!win) { toast('Please allow pop-ups to print the receipt.', 'err'); return; }

  if (!isContactInfoComplete(settings)) {
    win.document.write(`<html><head><title>Receipt</title></head><body style="font-family:Arial,sans-serif;padding:40px">${missingContactInfoHtml()}</body></html>`);
    win.document.close();
    return;
  }

  const addrLines = addressLines(settings);
  const logoHtml = settings.logo
    ? `<img src="${esc(settings.logo)}" style="width:64px;height:64px;border-radius:10px;object-fit:cover">`
    : `<div style="width:64px;height:64px;border-radius:10px;border:1.5px dashed #ccc;display:flex;align-items:center;justify-content:center;font-size:26px;color:#999;background:#fafbfc">🏫</div>`;

  const total = allocations.reduce((a, x) => a + Number(x.amount || 0), 0) || Number(collection.amount || 0);
  const balanceHtml = balance === null ? ''
    : balance > 0
      ? `<div style="text-align:right;font-size:15px;margin-top:18px">Balance: <b style="font-size:20px;color:#c0392b">KES ${balance.toLocaleString()}</b></div>`
      : `<div style="text-align:right;font-size:15px;margin-top:18px">Balance: <b style="font-size:20px;color:#1a7f4b">KES ${balance.toLocaleString()}</b><div style="font-size:12.5px;color:#1a7f4b">(Prepaid ${esc(amountInWords(-balance))})</div></div>`;

  win.document.write(`
    <html><head><title>Receipt ${esc(collection.receipt_no || '')}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:36px 40px;color:#111}
      .rcpt-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
      .rcpt-brand{display:flex;gap:14px}
      .rcpt-school h2{margin:0;font-size:18px;font-weight:800;line-height:1.25}
      .rcpt-school p{margin:2px 0 0;font-size:12.5px;color:#555}
      .rcpt-no{text-align:right}
      .rcpt-no .lab{font-size:12px;color:#666}
      .rcpt-no .num{font-size:26px;font-weight:800;color:#1a7f4b;line-height:1.1;margin-top:2px}
      .rcpt-no .date{font-size:12.5px;color:#555;margin-top:6px}
      .rcpt-boxes{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px}
      .rcpt-box{border:1px solid #ddd;border-radius:8px;padding:14px 16px}
      .rcpt-box .lab{font-size:11.5px;color:#777;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
      .rcpt-box b{font-size:14.5px}
      .rcpt-dist{margin-top:22px;font-size:12px;color:#777;text-transform:uppercase;letter-spacing:.4px;font-weight:700}
      .rcpt-table{width:100%;border-collapse:collapse;margin-top:8px}
      .rcpt-table th,.rcpt-table td{border:1.3px solid #000;padding:9px 12px;font-size:13px}
      .rcpt-table th{background:#f7f9fb;font-weight:800;font-size:11px;text-transform:uppercase;text-align:left}
      .rcpt-table td.num,.rcpt-table th.num{text-align:right}
      .rcpt-total td{font-weight:800;background:#f7f9fb}
      .rcpt-words{margin-top:8px;font-style:italic;font-size:13px;color:#333}
      .rcpt-footer{margin-top:34px;font-size:12.5px;color:#444}
      .rcpt-footer .sig{border-top:1px solid #333;width:180px;margin-top:26px}
      .rcpt-status{margin-top:10px;font-weight:800;color:#c0392b}
      @media print{ body{padding:16mm} }
    </style></head><body onload="window.print()">
      <div class="rcpt-top">
        <div class="rcpt-brand">
          ${logoHtml}
          <div class="rcpt-school">
            <h2>${esc(settings.school_name || 'School')}</h2>
            ${addrLines.map((l) => `<p>${esc(l)}</p>`).join('')}
          </div>
        </div>
        <div class="rcpt-no">
          <div class="lab">Receipt No.</div>
          <div class="num">${esc(collection.receipt_no || '')}</div>
          <div class="date">${new Date(collection.created_at).toLocaleDateString()}</div>
        </div>
      </div>

      <div class="rcpt-boxes">
        <div class="rcpt-box">
          <div class="lab">Student</div>
          <b>${esc(student ? student.full_name : '')}</b>
          <div style="margin-top:4px;font-size:13px;color:#444">Adm No. ${esc(student ? student.admission_no : '')}</div>
          <div style="font-size:13px;color:#444">${esc(student && student.classes ? student.classes.name : '')}</div>
        </div>
        <div class="rcpt-box">
          <div class="lab">Payment Info</div>
          <div style="font-size:13px"><b>Mode of Payment:</b> ${esc(modeLabel(collection.mode))}</div>
          ${collection.reference ? `<div style="font-size:13px"><b>Reference:</b> ${esc(collection.reference)}</div>` : ''}
        </div>
      </div>

      <div class="rcpt-dist">Payment Distribution</div>
      <table class="rcpt-table">
        <thead><tr><th style="width:36px">#</th><th>Vote Head</th><th class="num" style="width:120px">Amount</th></tr></thead>
        <tbody>
          ${allocations.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.vote_head_id ? (a.finance_vote_heads ? a.finance_vote_heads.name : '') : 'Unallocated Credit')}</td><td class="num">KES ${Number(a.amount || 0).toLocaleString()}</td></tr>`).join('')}
          <tr class="rcpt-total"><td colspan="2">Total</td><td class="num">KES ${total.toLocaleString()}</td></tr>
        </tbody>
      </table>
      <div class="rcpt-words">${esc(amountInWords(collection.amount))}</div>

      ${balanceHtml}
      ${collection.status !== 'active' ? `<div class="rcpt-status">${esc(collection.status === 'reversed' ? 'REVERSED' : 'TRANSFERRED')}</div>` : ''}

      <div class="rcpt-footer">
        <div>Date of Issue: <b>${new Date(collection.created_at).toLocaleDateString()}</b></div>
        <div>Prepared By: <b>${esc(preparedBy)}</b></div>
        <div class="sig"></div>
        <div>Signature</div>
      </div>
    </body></html>
  `);
  win.document.close();
}
