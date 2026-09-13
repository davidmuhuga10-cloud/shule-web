/**
 * financeTrail.mjs — "Notes & Reversals" (live feedback: "we dont have a
 * train [trail] of debit notes and credit notes ..incase we want to
 * reverse or edit ..fix that one ..also we dont have a place for reversed
 * reciepts..this is very important").
 *
 * Every one of these already existed as real, individually-auditable
 * records (finance_credit_notes/finance_debit_notes with reversed_at/by,
 * finance_collections with status='reversed') — see finance.mjs and
 * migrations/0031 + 0033. What was missing was a single SCHOOL-WIDE screen
 * to see them all without hunting through each student's own profile one
 * at a time. This is that screen — three sub-tabs, same SUB_TABS/
 * `.fin-tabs` convention financeTransport.mjs already established.
 *
 * "Edit" a note/receipt is deliberately never a raw in-place edit — a
 * wrongly-entered note or receipt is REVERSED (inserts the exact opposite
 * entry, flags the original) so both the mistake and its correction stay
 * on a permanent, dated, attributed record and every balance/report query
 * summing these tables keeps working unchanged. That reverse action is
 * front and center on every row here, which is what actually answers the
 * "reverse or edit" ask.
 */
import { esc, options, toast, confirmAction, loader, printOptionsHtml, wirePrintOptions, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsx } from '../lib/xlsxUtil.mjs';
import { printHeaderHtml, reportTitleBarHtml, isContactInfoComplete, missingContactInfoHtml } from '../lib/printHeader.mjs';

const SUB_TABS = [
  { key: 'credit', label: 'Credit Notes' },
  { key: 'debit', label: 'Debit Notes' },
  { key: 'reversed', label: 'Reversed Receipts' }
];
const PAGE_SIZE = 15;

export async function viewFinanceTrail(root, access) {
  let active = 'credit';
  root.innerHTML = `
    <div class="fin-tabs wrap-tabs">
      ${SUB_TABS.map((t) => `<button data-nttab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="ftl-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#ftl-body');
  const [settingsRes, yearsRes, termsRes] = await Promise.all([Db.settings.get(), Db.academicYears.list(), Db.terms.list()]);
  const settings = settingsRes.ok ? settingsRes.data : {};
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];

  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-nttab]').forEach((b) => b.classList.toggle('active', b.dataset.nttab === key));
    const sel = { academic_year_id: activeYear ? activeYear.id : '', term_id: activeTerm ? activeTerm.id : '', status: '', page: 1 };
    if (key === 'reversed') renderReversedTab(body, access, settings, years, terms, sel);
    else renderNotesTab(body, access, settings, years, terms, { ...sel, kind: key });
  };
  root.querySelectorAll('[data-nttab]').forEach((b) => b.onclick = () => show(b.dataset.nttab));
  show(active);
}

function yearTermFilterHtml(idPrefix, years, terms, sel) {
  return `
    <div class="field"><label>Academic Year</label><select id="${idPrefix}-year"><option value="">All years</option>${options(years, 'id', 'name', sel.academic_year_id)}</select></div>
    <div class="field"><label>Term</label><select id="${idPrefix}-term"><option value="">All terms</option>${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id)}</select></div>`;
}

function pagerHtml(idPrefix, page, totalPages, totalCount, noun) {
  if (totalPages <= 1) return '';
  return `<div class="pagination no-print">
    <button class="btn sm secondary" id="${idPrefix}-page-prev" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="muted">Page ${page} of ${totalPages} (${totalCount} ${noun}${totalCount === 1 ? '' : 's'})</span>
    <button class="btn sm secondary" id="${idPrefix}-page-next" ${page >= totalPages ? 'disabled' : ''}>Next ›</button>
  </div>`;
}

/* ----------------------------------------------------- Credit/Debit Notes */
async function renderNotesTab(root, access, settings, years, terms, sel) {
  root.innerHTML = loader();
  const api = sel.kind === 'debit' ? Db.finance.debitNotes : Db.finance.creditNotes;
  const res = await api.list({ academic_year_id: sel.academic_year_id || undefined, term_id: sel.term_id || undefined, status: sel.status || undefined });
  const allRows = res.ok ? res.data : [];
  const noteLabel = sel.kind === 'debit' ? 'Debit Note' : 'Credit Note';
  const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, sel.page || 1), totalPages);
  const pageRows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const noteRow = (n, forPrint) => `<tr${n.reversed_at ? ' style="opacity:.6"' : ''}>
      <td>${new Date(n.created_at).toLocaleDateString()}</td>
      <td>${esc(n.students ? n.students.full_name : '')} <span class="muted">${esc(n.students ? n.students.admission_no : '')}</span></td>
      <td>${esc(n.students && n.students.classes ? n.students.classes.name : '')}</td>
      <td>${esc(n.finance_vote_heads ? n.finance_vote_heads.name : '')}</td>
      <td class="num">${Number(n.amount || 0).toLocaleString()}</td>
      <td>${esc(n.reason || '')}</td>
      <td>${esc((n.created_by_profile && n.created_by_profile.name) || '')}</td>
      <td>${n.reversed_at ? `<span class="badge amber">Reversed ${new Date(n.reversed_at).toLocaleDateString()}</span>` : '<span class="badge green">Active</span>'}</td>
      ${forPrint ? '' : `<td class="row-actions">${!n.reversed_at && access.canManage ? `<button class="btn ghost sm" data-reverse-note="${n.id}">↩️ Reverse</button>` : ''}</td>`}
    </tr>`;
  const head = (forPrint) => `<thead><tr><th>Date</th><th>Student</th><th>Class</th><th>Vote Head</th><th class="num">Amount</th><th>Reason</th><th>Issued By</th><th>Status</th>${forPrint ? '' : '<th></th>'}</tr></thead>`;
  const noMatch = `<tr><td colspan="9" class="muted">No ${noteLabel.toLowerCase()}s match this filter.</td></tr>`;

  const yearName = (years.find((y) => y.id === sel.academic_year_id) || {}).name || 'All Years';
  const termName = (terms.find((t) => t.id === sel.term_id) || {}).name || 'All Terms';
  const reportTitle = `${noteLabel}s — ${yearName} ${sel.term_id ? termName : ''}`.trim();

  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        ${yearTermFilterHtml('ftl', years, terms, sel)}
        <div class="field"><label>Status</label><select id="ftl-status">
          <option value="">All</option>
          <option value="active" ${sel.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="reversed" ${sel.status === 'reversed' ? 'selected' : ''}>Reversed</option>
        </select></div>
      </div>
      <div class="spacer"></div>
      <div class="fin-report-actions">
        <button class="btn secondary" id="ftl-xlsx">⬇️ Excel</button>
        ${printOptionsHtml('ftl', 'landscape', { simple: true })}
      </div>
    </div>
    <div class="card print-grid" id="ftl-table"><div class="card-b">
      ${printHeaderHtml(settings)}
      ${reportTitleBarHtml(reportTitle)}
      <div class="ftl-desktop-view">
        <div class="table-wrap" style="margin-top:10px"><table class="data compact">
          ${head(false)}
          <tbody>${pageRows.map((n) => noteRow(n, false)).join('') || noMatch}</tbody>
        </table></div>
        ${pagerHtml('ftl', page, totalPages, allRows.length, noteLabel.toLowerCase())}
      </div>
      <div class="ftl-print-full"><table class="data compact">
        ${head(true)}
        <tbody>${allRows.map((n) => noteRow(n, true)).join('') || noMatch}</tbody>
      </table></div>
    </div></div>
  `;
  if (!isContactInfoComplete(settings)) {
    root.innerHTML = `<div class="fin-toolbar no-print">${yearTermFilterHtml('ftl', years, terms, sel)}</div>${missingContactInfoHtml()}`;
    root.querySelector('#ftl-year').onchange = (e) => renderNotesTab(root, access, settings, years, terms, { ...sel, academic_year_id: e.target.value, term_id: '', page: 1 });
    root.querySelector('#ftl-term').onchange = (e) => renderNotesTab(root, access, settings, years, terms, { ...sel, term_id: e.target.value, page: 1 });
    return;
  }
  root.querySelector('#ftl-year').onchange = (e) => renderNotesTab(root, access, settings, years, terms, { ...sel, academic_year_id: e.target.value, term_id: '', page: 1 });
  root.querySelector('#ftl-term').onchange = (e) => renderNotesTab(root, access, settings, years, terms, { ...sel, term_id: e.target.value, page: 1 });
  root.querySelector('#ftl-status').onchange = (e) => renderNotesTab(root, access, settings, years, terms, { ...sel, status: e.target.value, page: 1 });
  const prevBtn = root.querySelector('#ftl-page-prev');
  const nextBtn = root.querySelector('#ftl-page-next');
  if (prevBtn) prevBtn.onclick = () => renderNotesTab(root, access, settings, years, terms, { ...sel, page: page - 1 });
  if (nextBtn) nextBtn.onclick = () => renderNotesTab(root, access, settings, years, terms, { ...sel, page: page + 1 });

  root.querySelectorAll('[data-reverse-note]').forEach((b) => b.onclick = () => confirmAction(
    `Reverse this ${noteLabel.toLowerCase()}? This adds a matching opposite entry to correct the balance — the original stays on record, marked as reversed.`,
    () => withBusy(b, async () => {
      const reason = window.prompt('Reason for reversal (optional):') || null;
      const r = await api.reverse(b.dataset.reverseNote, reason);
      if (!r.ok) { toast(r.message, 'err'); return; }
      toast(`${noteLabel} reversed.`, 'ok');
      await renderNotesTab(root, access, settings, years, terms, sel);
    }), true
  ));

  wirePrintOptions(root, 'ftl', reportTitle);
  root.querySelector('#ftl-xlsx').onclick = () => {
    downloadXlsx(`${reportTitle}.xlsx`, allRows.map((n) => ({
      date: new Date(n.created_at).toLocaleDateString(),
      student: n.students ? n.students.full_name : '',
      admission_no: n.students ? n.students.admission_no : '',
      class: n.students && n.students.classes ? n.students.classes.name : '',
      vote_head: n.finance_vote_heads ? n.finance_vote_heads.name : '',
      amount: Number(n.amount || 0),
      reason: n.reason || '',
      issued_by: (n.created_by_profile && n.created_by_profile.name) || '',
      status: n.reversed_at ? `Reversed ${new Date(n.reversed_at).toLocaleDateString()}` : 'Active'
    })), [
      { key: 'date', label: 'Date' }, { key: 'student', label: 'Student' }, { key: 'admission_no', label: 'Adm. No.' },
      { key: 'class', label: 'Class' }, { key: 'vote_head', label: 'Vote Head' }, { key: 'amount', label: 'Amount' },
      { key: 'reason', label: 'Reason' }, { key: 'issued_by', label: 'Issued By' }, { key: 'status', label: 'Status' }
    ], noteLabel + 's');
  };
}

/* ------------------------------------------------------- Reversed Receipts */
async function renderReversedTab(root, access, settings, years, terms, sel) {
  root.innerHTML = loader();
  const res = await Db.finance.collections.list({ status: 'reversed', academic_year_id: sel.academic_year_id || undefined, term_id: sel.term_id || undefined, limit: 500 });
  const allRows = res.ok ? res.data : [];
  const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, sel.page || 1), totalPages);
  const pageRows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const row = (c) => `<tr>
      <td>${new Date(c.created_at).toLocaleDateString()}</td>
      <td>${esc(c.receipt_no || '')}</td>
      <td>${esc(c.students ? c.students.full_name : '')} <span class="muted">${esc(c.students ? c.students.admission_no : '')}</span></td>
      <td>${esc(c.students && c.students.classes ? c.students.classes.name : '')}</td>
      <td class="num">${Number(c.amount || 0).toLocaleString()}</td>
      <td>${esc(c.reversed_reason || '')}</td>
      <td>${c.reversed_at ? new Date(c.reversed_at).toLocaleDateString() : ''}</td>
    </tr>`;
  const head = `<thead><tr><th>Date Received</th><th>Receipt No.</th><th>Student</th><th>Class</th><th class="num">Amount</th><th>Reason for Reversal</th><th>Reversed On</th></tr></thead>`;
  const noMatch = `<tr><td colspan="7" class="muted">No reversed receipts match this filter.</td></tr>`;

  const yearName = (years.find((y) => y.id === sel.academic_year_id) || {}).name || 'All Years';
  const termName = (terms.find((t) => t.id === sel.term_id) || {}).name || 'All Terms';
  const reportTitle = `Reversed Receipts — ${yearName} ${sel.term_id ? termName : ''}`.trim();

  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">${yearTermFilterHtml('ftl', years, terms, sel)}</div>
      <div class="spacer"></div>
      <div class="fin-report-actions">
        <button class="btn secondary" id="ftl-xlsx">⬇️ Excel</button>
        ${printOptionsHtml('ftl', 'landscape', { simple: true })}
      </div>
    </div>
    <div class="card print-grid" id="ftl-table"><div class="card-b">
      ${printHeaderHtml(settings)}
      ${reportTitleBarHtml(reportTitle)}
      <div class="ftl-desktop-view">
        <div class="table-wrap" style="margin-top:10px"><table class="data compact">
          ${head}
          <tbody>${pageRows.map(row).join('') || noMatch}</tbody>
        </table></div>
        ${pagerHtml('ftl', page, totalPages, allRows.length, 'reversed receipt')}
      </div>
      <div class="ftl-print-full"><table class="data compact">
        ${head}
        <tbody>${allRows.map(row).join('') || noMatch}</tbody>
      </table></div>
    </div></div>
  `;
  if (!isContactInfoComplete(settings)) {
    root.innerHTML = `<div class="fin-toolbar no-print">${yearTermFilterHtml('ftl', years, terms, sel)}</div>${missingContactInfoHtml()}`;
    root.querySelector('#ftl-year').onchange = (e) => renderReversedTab(root, access, settings, years, terms, { ...sel, academic_year_id: e.target.value, term_id: '', page: 1 });
    root.querySelector('#ftl-term').onchange = (e) => renderReversedTab(root, access, settings, years, terms, { ...sel, term_id: e.target.value, page: 1 });
    return;
  }
  root.querySelector('#ftl-year').onchange = (e) => renderReversedTab(root, access, settings, years, terms, { ...sel, academic_year_id: e.target.value, term_id: '', page: 1 });
  root.querySelector('#ftl-term').onchange = (e) => renderReversedTab(root, access, settings, years, terms, { ...sel, term_id: e.target.value, page: 1 });
  const prevBtn = root.querySelector('#ftl-page-prev');
  const nextBtn = root.querySelector('#ftl-page-next');
  if (prevBtn) prevBtn.onclick = () => renderReversedTab(root, access, settings, years, terms, { ...sel, page: page - 1 });
  if (nextBtn) nextBtn.onclick = () => renderReversedTab(root, access, settings, years, terms, { ...sel, page: page + 1 });

  wirePrintOptions(root, 'ftl', reportTitle);
  root.querySelector('#ftl-xlsx').onclick = () => {
    downloadXlsx(`${reportTitle}.xlsx`, allRows.map((c) => ({
      date: new Date(c.created_at).toLocaleDateString(), receipt_no: c.receipt_no || '',
      student: c.students ? c.students.full_name : '', admission_no: c.students ? c.students.admission_no : '',
      class: c.students && c.students.classes ? c.students.classes.name : '',
      amount: Number(c.amount || 0), reason: c.reversed_reason || '',
      reversed_on: c.reversed_at ? new Date(c.reversed_at).toLocaleDateString() : ''
    })), [
      { key: 'date', label: 'Date Received' }, { key: 'receipt_no', label: 'Receipt No.' }, { key: 'student', label: 'Student' },
      { key: 'admission_no', label: 'Adm. No.' }, { key: 'class', label: 'Class' }, { key: 'amount', label: 'Amount' },
      { key: 'reason', label: 'Reason for Reversal' }, { key: 'reversed_on', label: 'Reversed On' }
    ], 'Reversed Receipts');
  };
}
