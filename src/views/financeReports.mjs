/**
 * financeReports.mjs — brief §Reports: Balances (with a min-balance filter
 * for scenario #2 — "every student above KES 400 across every class"),
 * Balances Per Term, Vote Head Balances (scenario #3), Cashbook (date
 * range) and Trial Balance (scenario #18) — each with a print + Excel
 * export, reusing the read-heavy cached RPCs in the API layer.
 */
import { esc, options, toast, loader, printOptionsHtml, wirePrintOptions, state, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsx, downloadXlsxAOA, readXlsxFile } from '../lib/xlsxUtil.mjs';
import { buildBalancesAoa, buildVoteHeadCollectionsAoa, buildCashbookAoa, buildTrialBalanceAoa } from '../lib/finance/financeXlsx.mjs';
import { printHeaderHtml, reportTitleBarHtml, isContactInfoComplete, missingContactInfoHtml } from '../lib/printHeader.mjs';

const SUB_TABS = [
  { key: 'balances', label: 'Balances' },
  { key: 'votehead', label: 'Vote Head Balances' },
  { key: 'cashbook', label: 'Cashbook' },
  { key: 'trial', label: 'Trial Balance' }
];

/** Round 2 §6 (approved redesign) — every Finance report now uses the exact
 *  same printable header Mark List / Class List / Report Forms already use
 *  (src/lib/printHeader.mjs): logo far left, school name centered, address
 *  block far right, then the brand-colour title bar naming the report —
 *  instead of a bare table with no header at all. Same mandatory-contact-
 *  info gate too, so a school that hasn't filled in P.O. Box/town/phone yet
 *  sees the same "set your details first" message every other report shows,
 *  rather than printing a blank address block. */
function reportSheetHtml(id, settings, title, innerTableHtml) {
  return `<div class="card print-grid" id="${id}"><div class="card-b">
    ${printHeaderHtml(settings)}
    ${reportTitleBarHtml(title)}
    <div class="table-wrap" style="margin-top:10px">${innerTableHtml}</div>
  </div></div>`;
}

export async function viewFinanceReports(root, access) {
  access = access || { canManage: false, canCollect: true };
  const tabs = access.canManage ? SUB_TABS.concat([{ key: 'opening', label: 'Opening Balances' }]) : SUB_TABS;
  let active = 'balances';
  root.innerHTML = `
    <div class="fin-tabs">
      ${tabs.map((t) => `<button data-rtab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fr-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#fr-body');
  const settingsRes = await Db.settings.get();
  const settings = settingsRes.ok ? settingsRes.data : {};
  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-rtab]').forEach((b) => b.classList.toggle('active', b.dataset.rtab === key));
    if (key === 'balances') renderBalances(body, settings);
    else if (key === 'votehead') renderVoteHead(body, settings);
    else if (key === 'cashbook') renderCashbook(body, settings);
    else if (key === 'trial') renderTrial(body, settings);
    else renderOpeningBalances(body);
  };
  root.querySelectorAll('[data-rtab]').forEach((b) => b.onclick = () => show(b.dataset.rtab));
  show(active);
}

/* --------------------------------------------------------- balances --- */
async function renderBalances(root, settings) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  await loadBalances(root, settings, classes, { class_id: '', min_balance: '' });
}

async function loadBalances(root, settings, classes, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Class</label><select id="fb-class">${options(classes, 'id', 'name', sel.class_id, 'All classes')}</select></div>
        <div class="field"><label>Min. Balance (KES)</label><input id="fb-min" type="number" placeholder="e.g. 400" value="${esc(sel.min_balance)}"></div>
        <div class="field" style="align-self:flex-end"><button class="btn secondary" id="fb-apply">Apply</button></div>
      </div>
      <div class="spacer"></div>
      <button class="btn secondary" id="fb-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('fb', 'landscape')}
    </div>
    <div id="fb-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#fb-apply').onclick = () => loadBalances(root, settings, classes, {
    class_id: root.querySelector('#fb-class').value, min_balance: root.querySelector('#fb-min').value
  });
  root.querySelector('#fb-xlsx').onclick = async () => {
    const res = await Db.finance.reports.classBalances(sel.class_id || null, sel.min_balance || null);
    downloadXlsxAOA('Balances.xlsx', buildBalancesAoa({ settings, rows: res.ok ? res.data : [], title: 'Balances' }), 'Balances');
  };

  const tableEl = root.querySelector('#fb-table');
  if (!isContactInfoComplete(settings)) { tableEl.innerHTML = missingContactInfoHtml(); wireGotoSettings(tableEl); return; }

  const res = await Db.finance.reports.classBalances(sel.class_id || null, sel.min_balance || null);
  const rows = res.ok ? res.data : [];
  tableEl.innerHTML = reportSheetHtml('fb-sheet', settings, 'Balances', `<table class="print-grid">
      <thead><tr><th>Adm. No.</th><th>Name</th><th>Class</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Credit Note</th><th class="num">Balance</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td>${esc(r.class_name)}${r.stream_name ? ' ' + esc(r.stream_name) : ''}</td>
        <td class="num">${Number(r.expected || 0).toLocaleString()}</td><td class="num">${Number(r.paid || 0).toLocaleString()}</td>
        <td class="num">${Number(r.credit_note || 0).toLocaleString()}</td><td class="num">${Number(r.balance || 0).toLocaleString()}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">No students match this filter.</td></tr>'}</tbody>
    </table>`);
  wirePrintOptions(root, 'fb', 'Balances');
}

/* --------------------------------------------------------- vote head --- */
async function renderVoteHead(root, settings) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  await loadVoteHead(root, settings, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: '' });
}

async function loadVoteHead(root, settings, years, terms, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label><select id="fv-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
        <div class="field"><label>Term</label><select id="fv-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      </div>
      <div class="spacer"></div>
      <button class="btn secondary" id="fv-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('fv', 'portrait')}
    </div>
    <div id="fv-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#fv-year').onchange = (e) => loadVoteHead(root, settings, years, terms, { academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#fv-term').onchange = (e) => loadVoteHead(root, settings, years, terms, { ...sel, term_id: e.target.value });
  root.querySelector('#fv-xlsx').onclick = async () => {
    const res = await Db.finance.reports.voteHeadCollections(sel.academic_year_id || null, sel.term_id || null);
    downloadXlsxAOA('Vote-Head-Collections.xlsx', buildVoteHeadCollectionsAoa({ settings, rows: res.ok ? res.data : [], title: 'Collections Per Vote Head' }), 'Vote Heads');
  };

  const tableEl = root.querySelector('#fv-table');
  if (!isContactInfoComplete(settings)) { tableEl.innerHTML = missingContactInfoHtml(); wireGotoSettings(tableEl); return; }

  const res = await Db.finance.reports.voteHeadCollections(sel.academic_year_id || null, sel.term_id || null);
  const rows = res.ok ? res.data : [];
  tableEl.innerHTML = reportSheetHtml('fv-sheet', settings, 'Vote Head Balances', `<table class="print-grid">
      <thead><tr><th>Vote Head</th><th class="num">Collected</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.vote_head_name)}</td><td class="num">${Number(r.collected || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No collections yet.</td></tr>'}</tbody>
    </table>`);
  wirePrintOptions(root, 'fv', 'Vote Head Balances');
}

/* --------------------------------------------------------- cashbook --- */
async function renderCashbook(root, settings) {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  await loadCashbook(root, settings, { from: firstOfMonth.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) });
}

async function loadCashbook(root, settings, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>From</label><input id="fcb-from" type="date" value="${esc(sel.from)}"></div>
        <div class="field"><label>To</label><input id="fcb-to" type="date" value="${esc(sel.to)}"></div>
        <div class="field" style="align-self:flex-end"><button class="btn secondary" id="fcb-apply">Apply</button></div>
      </div>
      <div class="spacer"></div>
      <button class="btn secondary" id="fcb-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('fcb', 'portrait')}
    </div>
    <div id="fcb-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#fcb-apply').onclick = () => loadCashbook(root, settings, { from: root.querySelector('#fcb-from').value, to: root.querySelector('#fcb-to').value });
  root.querySelector('#fcb-xlsx').onclick = async () => {
    const res = await Db.finance.reports.cashbook(sel.from, sel.to);
    downloadXlsxAOA('Cashbook.xlsx', buildCashbookAoa({ settings, rows: res.ok ? res.data : [], from: sel.from, to: sel.to }), 'Cashbook');
  };

  const tableEl = root.querySelector('#fcb-table');
  if (!isContactInfoComplete(settings)) { tableEl.innerHTML = missingContactInfoHtml(); wireGotoSettings(tableEl); return; }

  const res = await Db.finance.reports.cashbook(sel.from, sel.to);
  const rows = res.ok ? res.data : [];
  const total = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
  tableEl.innerHTML = reportSheetHtml('fcb-sheet', settings, `Cashbook — ${sel.from} to ${sel.to}`, `<table class="print-grid">
      <thead><tr><th>Date</th><th>Receipt No</th><th>Student</th><th>Adm. No.</th><th>Mode</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.collection_date)}</td><td>${esc(r.receipt_no)}</td><td>${esc(r.student_name)}</td><td>${esc(r.admission_no)}</td><td>${esc(r.mode)}</td><td class="num">${Number(r.amount || 0).toLocaleString()}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No collections in this range.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="5"><b>Total</b></td><td class="num"><b>${total.toLocaleString()}</b></td></tr></tfoot>
    </table>`);
  wirePrintOptions(root, 'fcb', `Cashbook ${sel.from} to ${sel.to}`);
}

/* --------------------------------------------------------- trial balance --- */
async function renderTrial(root, settings) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  await loadTrial(root, settings, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: '' });
}

async function loadTrial(root, settings, years, terms, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label><select id="ft-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
        <div class="field"><label>Term</label><select id="ft-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      </div>
      <div class="spacer"></div>
      <button class="btn secondary" id="ft-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('ft', 'portrait')}
    </div>
    <div id="ft-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#ft-year').onchange = (e) => loadTrial(root, settings, years, terms, { academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#ft-term').onchange = (e) => loadTrial(root, settings, years, terms, { ...sel, term_id: e.target.value });
  root.querySelector('#ft-xlsx').onclick = async () => {
    const res = await Db.finance.reports.trialBalance(sel.academic_year_id || null, sel.term_id || null);
    downloadXlsxAOA('Trial-Balance.xlsx', buildTrialBalanceAoa({ settings, rows: res.ok ? res.data : [] }), 'Trial Balance');
  };

  const tableEl = root.querySelector('#ft-table');
  if (!isContactInfoComplete(settings)) { tableEl.innerHTML = missingContactInfoHtml(); wireGotoSettings(tableEl); return; }

  const res = await Db.finance.reports.trialBalance(sel.academic_year_id || null, sel.term_id || null);
  const rows = res.ok ? res.data : [];
  const dr = rows.reduce((a, r) => a + Number(r.invoiced || 0), 0);
  const cr = rows.reduce((a, r) => a + Number(r.collected || 0), 0);
  tableEl.innerHTML = reportSheetHtml('ft-sheet', settings, 'Trial Balance', `<table class="print-grid">
      <thead><tr><th>Vote Head</th><th class="num">Invoiced (Dr)</th><th class="num">Collected (Cr)</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.vote_head_name)}</td><td class="num">${Number(r.invoiced || 0).toLocaleString()}</td><td class="num">${Number(r.collected || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No data yet.</td></tr>'}</tbody>
      <tfoot><tr><td><b>Total</b></td><td class="num"><b>${dr.toLocaleString()}</b></td><td class="num"><b>${cr.toLocaleString()}</b></td></tr></tfoot>
    </table>`);
  wirePrintOptions(root, 'ft', 'Trial Balance');
}

function wireGotoSettings(root) {
  const btn = root.querySelector('[data-goto-settings]');
  if (btn) btn.onclick = () => go('settings');
}

/* --------------------------------------------------------- opening balances --- */
/** Round 2 §11 — replaces the old CSV-paste modal with the same
 *  download-template → fill in → upload-back → preview → import pattern
 *  Bulk Upload already established for students (src/views/bulkUpload.mjs),
 *  rather than a bespoke flow just for this one feature. The template comes
 *  pre-filled with every active student (brief: "pre-filled with all
 *  students") so a bursar is only ever typing amounts, never admission
 *  numbers. */
const OB_TEMPLATE_COLUMNS = [
  { key: 'admission_no', label: 'Admission No.' },
  { key: 'full_name', label: 'Name' },
  { key: 'class_name', label: 'Class' },
  { key: 'stream_name', label: 'Arm' },
  { key: 'amount', label: 'Opening Balance (KES)' }
];

async function renderOpeningBalances(root) {
  root.innerHTML = loader();
  const [yearsRes, studentsRes] = await Promise.all([Db.academicYears.list(), Db.students.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const students = studentsRes.ok ? studentsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  await loadOpeningBalances(root, years, students, { academic_year_id: activeYear ? activeYear.id : '' });
}

async function loadOpeningBalances(root, years, students, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label><select id="ob-year">${options(years, 'id', 'name', sel.academic_year_id)}</select></div>
      </div>
      <div class="spacer"></div>
      <button class="btn secondary" id="ob-template">⬇ Download template (.xlsx)</button>
    </div>
    <div class="card pad">
      <p class="hint" style="margin-top:0">The template comes pre-filled with every active student — fill in the "Opening Balance" column (leave blank to skip a student), then upload the same file back below. Nothing is imported until you confirm the preview.</p>
      <div class="field" style="max-width:420px"><label>Upload the filled-in spreadsheet</label><input id="ob-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>
      <button class="btn" id="ob-preview" style="margin-top:6px" disabled>Preview</button>
    </div>
    <div id="ob-preview-area"></div>
  `;
  const yearSelect = root.querySelector('#ob-year');
  yearSelect.onchange = (e) => loadOpeningBalances(root, years, students, { academic_year_id: e.target.value });

  root.querySelector('#ob-template').onclick = async () => {
    const yearId = yearSelect.value;
    const existingRes = yearId ? await Promise.all(students.map((s) => Db.finance.students.openingBalance(s.id, yearId))) : [];
    const rows = students.map((s, i) => ({
      admission_no: s.admission_no, full_name: s.full_name, class_name: s.class_name || '', stream_name: s.stream_name || '',
      amount: existingRes[i] && existingRes[i].ok && existingRes[i].data ? existingRes[i].data.amount : ''
    }));
    downloadXlsx('shule-opening-balances-template.xlsx', rows, OB_TEMPLATE_COLUMNS, 'Opening Balances');
  };

  let pendingRows = null;
  const previewBtn = root.querySelector('#ob-preview');
  root.querySelector('#ob-file').onchange = async (e) => {
    const file = e.target.files[0];
    pendingRows = null;
    previewBtn.disabled = true;
    if (!file) return;
    try {
      const sheetRows = await readXlsxFile(file);
      pendingRows = sheetRows.slice(1).filter((r) => r.some((c) => String(c || '').trim() !== ''))
        .map((r) => ({ admission_no: String(r[0] || '').trim(), full_name: String(r[1] || '').trim(), amount: String(r[4] || '').trim() }));
      previewBtn.disabled = pendingRows.length === 0;
      if (!pendingRows.length) toast('No rows found in that spreadsheet.', 'err');
    } catch (e2) {
      toast('Could not read that file — please upload the .xlsx template.', 'err');
    }
  };

  previewBtn.onclick = () => {
    if (!yearSelect.value) { toast('Choose an academic year first.', 'err'); return; }
    renderOpeningPreview(root, years, students, { academic_year_id: yearSelect.value, rows: pendingRows });
  };
}

function renderOpeningPreview(root, years, students, sel) {
  const byAdm = {}; students.forEach((s) => { byAdm[String(s.admission_no).trim().toLowerCase()] = s; });
  const withStatus = sel.rows.map((r) => {
    const student = byAdm[r.admission_no.toLowerCase()];
    let error = null;
    if (!student) error = 'No matching student for this admission no.';
    else if (r.amount === '') error = 'skip'; // blank amount — not an error, just excluded
    else if (!Number.isFinite(Number(r.amount))) error = 'Amount is not a number';
    return { ...r, student, error };
  });
  const skipped = withStatus.filter((r) => r.error === 'skip').length;
  const invalid = withStatus.filter((r) => r.error && r.error !== 'skip');
  const ready = withStatus.filter((r) => !r.error);
  const blocked = invalid.length > 0;

  const area = root.querySelector('#ob-preview-area');
  area.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3>Preview (${sel.rows.length} row(s))</h3>
        <div class="spacer"></div>
        <button class="btn" id="ob-import" ${blocked ? 'disabled' : ''}>Import ${ready.length} balance(s)</button>
      </div>
      <div class="card-b" style="padding-bottom:0">
        ${blocked ? `<p class="hint" style="color:var(--danger,#c0392b)">${invalid.length} row(s) have an error — fix them in the spreadsheet and re-upload. Nothing will be imported until every filled-in row is valid.</p>`
          : `<p class="hint" style="color:var(--ok,#1a7f4b)">${ready.length} row(s) ready to import${skipped ? `, ${skipped} left blank and skipped` : ''}.</p>`}
      </div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Adm. No.</th><th>Name</th><th class="num">Amount</th><th>Status</th></tr></thead>
        <tbody>${withStatus.map((r) => `<tr style="${r.error && r.error !== 'skip' ? 'background:var(--danger-bg)' : ''}">
          <td>${esc(r.admission_no)}</td><td>${esc(r.student ? r.student.full_name : r.full_name)}</td><td class="num">${esc(r.amount)}</td>
          <td>${r.error === 'skip' ? '<span class="badge grey">Blank — skipped</span>' : r.error ? `<span class="badge red">${esc(r.error)}</span>` : '<span class="badge green">Ready</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
  `;
  if (blocked) return;
  area.querySelector('#ob-import').onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Importing…';
    const payload = ready.map((r) => ({ student_id: r.student.id, amount: r.amount }));
    const res = await Db.finance.students.bulkOpeningBalances(payload, sel.academic_year_id);
    if (!res.ok) { toast(res.message, 'err'); btn.disabled = false; btn.textContent = `Import ${ready.length} balance(s)`; return; }
    toast(`Imported ${payload.length} opening balance(s).`, 'ok');
    loadOpeningBalances(root, years, students, { academic_year_id: sel.academic_year_id });
  };
}
