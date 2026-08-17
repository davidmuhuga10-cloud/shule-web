/**
 * financeReports.mjs — brief §Reports: Balances (with a min-balance filter
 * for scenario #2 — "every student above KES 400 across every class"),
 * Balances Per Term, Vote Head Balances (scenario #3), Cashbook (date
 * range) and Trial Balance (scenario #18) — each with a print + Excel
 * export, reusing the read-heavy cached RPCs in the API layer.
 */
import { esc, options, loader, printOptionsHtml, wirePrintOptions, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsxAOA } from '../lib/xlsxUtil.mjs';
import { buildBalancesAoa, buildVoteHeadCollectionsAoa, buildCashbookAoa, buildTrialBalanceAoa } from '../lib/finance/financeXlsx.mjs';

const SUB_TABS = [
  { key: 'balances', label: 'Balances' },
  { key: 'votehead', label: 'Vote Head Balances' },
  { key: 'cashbook', label: 'Cashbook' },
  { key: 'trial', label: 'Trial Balance' }
];

export async function viewFinanceReports(root) {
  let active = 'balances';
  root.innerHTML = `
    <div class="tabs" style="max-width:560px">
      ${SUB_TABS.map((t) => `<button data-rtab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fr-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#fr-body');
  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-rtab]').forEach((b) => b.classList.toggle('active', b.dataset.rtab === key));
    if (key === 'balances') renderBalances(body);
    else if (key === 'votehead') renderVoteHead(body);
    else if (key === 'cashbook') renderCashbook(body);
    else renderTrial(body);
  };
  root.querySelectorAll('[data-rtab]').forEach((b) => b.onclick = () => show(b.dataset.rtab));
  show(active);
}

/* --------------------------------------------------------- balances --- */
async function renderBalances(root) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  await loadBalances(root, classes, { class_id: '', min_balance: '' });
}

async function loadBalances(root, classes, sel) {
  root.innerHTML = `
    <div class="card"><div class="card-b no-print" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="max-width:220px"><label>Class</label><select id="fb-class">${options(classes, 'id', 'name', sel.class_id, 'All classes')}</select></div>
      <div class="field" style="max-width:220px"><label>Min. Balance (KES)</label><input id="fb-min" type="number" placeholder="e.g. 400" value="${esc(sel.min_balance)}"></div>
      <button class="btn secondary" id="fb-apply">Apply</button>
      <button class="btn secondary" id="fb-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('fb', 'landscape')}
    </div></div>
    <div id="fb-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#fb-apply').onclick = () => loadBalances(root, classes, {
    class_id: root.querySelector('#fb-class').value, min_balance: root.querySelector('#fb-min').value
  });

  const res = await Db.finance.reports.classBalances(sel.class_id || null, sel.min_balance || null);
  const rows = res.ok ? res.data : [];
  const tableEl = root.querySelector('#fb-table');
  tableEl.innerHTML = `
    <div class="card print-grid" id="fb-sheet"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Adm. No.</th><th>Name</th><th>Class</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Credit Note</th><th class="num">Balance</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td>${esc(r.class_name)}${r.stream_name ? ' ' + esc(r.stream_name) : ''}</td>
        <td class="num">${Number(r.expected || 0).toLocaleString()}</td><td class="num">${Number(r.paid || 0).toLocaleString()}</td>
        <td class="num">${Number(r.credit_note || 0).toLocaleString()}</td><td class="num">${Number(r.balance || 0).toLocaleString()}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">No students match this filter.</td></tr>'}</tbody>
    </table></div></div>
  `;
  wirePrintOptions(root.querySelector('#fb-sheet'), 'fb', 'Balances');
  root.querySelector('#fb-xlsx').onclick = () => downloadXlsxAOA('Balances.xlsx', buildBalancesAoa({ settings: state.settings, rows, title: 'Balances' }), 'Balances');
}

/* --------------------------------------------------------- vote head --- */
async function renderVoteHead(root) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  await loadVoteHead(root, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: '' });
}

async function loadVoteHead(root, years, terms, sel) {
  root.innerHTML = `
    <div class="card"><div class="card-b no-print" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="max-width:220px"><label>Academic Year</label><select id="fv-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
      <div class="field" style="max-width:220px"><label>Term</label><select id="fv-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      <button class="btn secondary" id="fv-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('fv', 'portrait')}
    </div></div>
    <div id="fv-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#fv-year').onchange = (e) => loadVoteHead(root, years, terms, { academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#fv-term').onchange = (e) => loadVoteHead(root, years, terms, { ...sel, term_id: e.target.value });

  const res = await Db.finance.reports.voteHeadCollections(sel.academic_year_id || null, sel.term_id || null);
  const rows = res.ok ? res.data : [];
  const tableEl = root.querySelector('#fv-table');
  tableEl.innerHTML = `
    <div class="card print-grid" id="fv-sheet"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Vote Head</th><th class="num">Collected</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.vote_head_name)}</td><td class="num">${Number(r.collected || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No collections yet.</td></tr>'}</tbody>
    </table></div></div>
  `;
  wirePrintOptions(root.querySelector('#fv-sheet'), 'fv', 'Vote Head Balances');
  root.querySelector('#fv-xlsx').onclick = () => downloadXlsxAOA('Vote-Head-Collections.xlsx', buildVoteHeadCollectionsAoa({ settings: state.settings, rows, title: 'Collections Per Vote Head' }), 'Vote Heads');
}

/* --------------------------------------------------------- cashbook --- */
async function renderCashbook(root) {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  await loadCashbook(root, { from: firstOfMonth.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) });
}

async function loadCashbook(root, sel) {
  root.innerHTML = `
    <div class="card"><div class="card-b no-print" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field"><label>From</label><input id="fcb-from" type="date" value="${esc(sel.from)}"></div>
      <div class="field"><label>To</label><input id="fcb-to" type="date" value="${esc(sel.to)}"></div>
      <button class="btn secondary" id="fcb-apply">Apply</button>
      <button class="btn secondary" id="fcb-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('fcb', 'portrait')}
    </div></div>
    <div id="fcb-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#fcb-apply').onclick = () => loadCashbook(root, { from: root.querySelector('#fcb-from').value, to: root.querySelector('#fcb-to').value });

  const res = await Db.finance.reports.cashbook(sel.from, sel.to);
  const rows = res.ok ? res.data : [];
  const total = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
  const tableEl = root.querySelector('#fcb-table');
  tableEl.innerHTML = `
    <div class="card print-grid" id="fcb-sheet"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Date</th><th>Receipt No</th><th>Student</th><th>Adm. No.</th><th>Mode</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.collection_date)}</td><td>${esc(r.receipt_no)}</td><td>${esc(r.student_name)}</td><td>${esc(r.admission_no)}</td><td>${esc(r.mode)}</td><td class="num">${Number(r.amount || 0).toLocaleString()}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No collections in this range.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="5"><b>Total</b></td><td class="num"><b>${total.toLocaleString()}</b></td></tr></tfoot>
    </table></div></div>
  `;
  wirePrintOptions(root.querySelector('#fcb-sheet'), 'fcb', `Cashbook ${sel.from} to ${sel.to}`);
  root.querySelector('#fcb-xlsx').onclick = () => downloadXlsxAOA('Cashbook.xlsx', buildCashbookAoa({ settings: state.settings, rows, from: sel.from, to: sel.to }), 'Cashbook');
}

/* --------------------------------------------------------- trial balance --- */
async function renderTrial(root) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  await loadTrial(root, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: '' });
}

async function loadTrial(root, years, terms, sel) {
  root.innerHTML = `
    <div class="card"><div class="card-b no-print" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="max-width:220px"><label>Academic Year</label><select id="ft-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
      <div class="field" style="max-width:220px"><label>Term</label><select id="ft-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      <button class="btn secondary" id="ft-xlsx">⬇️ Excel</button>
      ${printOptionsHtml('ft', 'portrait')}
    </div></div>
    <div id="ft-table" style="margin-top:14px">${loader()}</div>
  `;
  root.querySelector('#ft-year').onchange = (e) => loadTrial(root, years, terms, { academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#ft-term').onchange = (e) => loadTrial(root, years, terms, { ...sel, term_id: e.target.value });

  const res = await Db.finance.reports.trialBalance(sel.academic_year_id || null, sel.term_id || null);
  const rows = res.ok ? res.data : [];
  const dr = rows.reduce((a, r) => a + Number(r.invoiced || 0), 0);
  const cr = rows.reduce((a, r) => a + Number(r.collected || 0), 0);
  const tableEl = root.querySelector('#ft-table');
  tableEl.innerHTML = `
    <div class="card print-grid" id="ft-sheet"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Vote Head</th><th class="num">Invoiced (Dr)</th><th class="num">Collected (Cr)</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.vote_head_name)}</td><td class="num">${Number(r.invoiced || 0).toLocaleString()}</td><td class="num">${Number(r.collected || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No data yet.</td></tr>'}</tbody>
      <tfoot><tr><td><b>Total</b></td><td class="num"><b>${dr.toLocaleString()}</b></td><td class="num"><b>${cr.toLocaleString()}</b></td></tr></tfoot>
    </table></div></div>
  `;
  wirePrintOptions(root.querySelector('#ft-sheet'), 'ft', 'Trial Balance');
  root.querySelector('#ft-xlsx').onclick = () => downloadXlsxAOA('Trial-Balance.xlsx', buildTrialBalanceAoa({ settings: state.settings, rows }), 'Trial Balance');
}
