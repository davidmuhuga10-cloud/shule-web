/**
 * financePayroll.mjs — Finance Expansion brief item 3 ("Payroll Module").
 * Four sub-tabs following the brief's own process (§3.8): Staff Payroll
 * (profiles) -> Run Payroll (create/review/edit/finalize) -> History
 * (past months + per-employee history) -> Reports.
 *
 * Manage-only, same as Expenses (migrations/0054's header comment) — this
 * whole screen is gated the same way financeAccounting.mjs/
 * financeExpenses.mjs gate themselves.
 */
import { esc, options, toast, modal, closeModal, confirmAction, loader, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { printHeaderHtml, addressLines, isContactInfoComplete, missingContactInfoHtml } from '../lib/printHeader.mjs';

const SUB_TABS = [
  { key: 'run', label: 'Run Payroll' },
  { key: 'profiles', label: 'Staff Payroll' },
  { key: 'history', label: 'History' },
  { key: 'reports', label: 'Reports' }
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function money(n) { return 'KES ' + Number(n || 0).toLocaleString(); }

export async function viewFinancePayroll(root, access) {
  if (!access || !access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to manage Payroll — ask your school admin for full Finance access.</div>`;
    return;
  }
  let active = 'run';
  root.innerHTML = `
    <div class="fin-tabs wrap-tabs">
      ${SUB_TABS.map((t) => `<button data-ptab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fpr-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#fpr-body');
  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-ptab]').forEach((b) => b.classList.toggle('active', b.dataset.ptab === key));
    if (key === 'run') renderRun(body);
    else if (key === 'profiles') renderProfiles(body);
    else if (key === 'history') renderHistory(body);
    else renderReports(body);
  };
  root.querySelectorAll('[data-ptab]').forEach((b) => b.onclick = () => show(b.dataset.ptab));
  show(active);
}

/* ---------------------------------------------------------------- Profiles */
async function renderProfiles(root) {
  root.innerHTML = loader();
  const [profilesRes, staffRes] = await Promise.all([Db.finance.payrollProfiles.list(), Db.staff.list()]);
  const profiles = profilesRes.ok ? profilesRes.data : [];
  const staff = (staffRes.ok ? staffRes.data : []).filter((s) => s.status === 'active');
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Staff Payroll Profiles</h3><span class="muted" style="font-size:12px">Reuses existing staff records — only staff with a profile here are pulled into a monthly payroll run</span><button class="btn sm" id="fpp-add" style="margin-left:auto">+ Add Payroll Profile</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Staff</th><th>Position</th><th>Department</th><th>Basic Salary</th><th>Allowances</th><th>Deductions</th><th>Status</th><th></th></tr></thead>
        <tbody>${profiles.map((p) => `<tr>
          <td>${esc(p.staff ? p.staff.full_name : '')}</td><td>${esc(p.position || '—')}</td><td>${esc(p.department || '—')}</td>
          <td>${money(p.basic_salary)}</td><td>${money(p.regular_allowances)}</td><td>${money(p.regular_deductions)}</td>
          <td>${p.active === false ? '<span class="badge amber">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
          <td><button class="btn secondary sm" data-edit="${p.id}">Edit</button></td>
        </tr>`).join('') || '<tr><td colspan="8" class="muted">No payroll profiles yet — add one for each employee you want to pay through Payroll.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
  const openModal = (existing) => {
    const profiledStaffIds = new Set(profiles.filter((p) => !existing || p.id !== existing.id).map((p) => p.staff_id));
    const pickable = existing ? staff : staff.filter((s) => !profiledStaffIds.has(s.id));
    modal({
      title: existing ? 'Edit Payroll Profile' : 'Add Payroll Profile',
      body: `
        <div class="field"><label>Staff Member</label>
          <select id="fpp-staff" ${existing ? 'disabled' : ''}>${pickable.length ? options(pickable, 'id', 'full_name', existing ? existing.staff_id : '') : '<option value="">No unprofiled active staff left</option>'}</select>
        </div>
        <div class="grid2">
          <div class="field"><label>Position</label><input id="fpp-position" placeholder="e.g. Class Teacher, Cook, Gateman" value="${esc(existing ? existing.position || '' : '')}"></div>
          <div class="field"><label>Department (optional)</label><input id="fpp-department" placeholder="e.g. Academic, Support Staff" value="${esc(existing ? existing.department || '' : '')}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Basic Salary (KES)</label><input id="fpp-basic" type="number" min="0" step="0.01" value="${existing ? existing.basic_salary : ''}"></div>
          <div class="field"><label>Regular Allowances (KES)</label><input id="fpp-allow" type="number" min="0" step="0.01" value="${existing ? existing.regular_allowances : 0}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Regular Deductions (KES)</label><input id="fpp-deduct" type="number" min="0" step="0.01" value="${existing ? existing.regular_deductions : 0}"></div>
          <div class="field"><label>Payment Method</label><select id="fpp-method">
            <option value="bank" ${existing && existing.payment_method === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="mpesa" ${existing && existing.payment_method === 'mpesa' ? 'selected' : ''}>M-Pesa</option>
            <option value="cash" ${existing && existing.payment_method === 'cash' ? 'selected' : ''}>Cash</option>
          </select></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Bank Name (optional)</label><input id="fpp-bank" value="${esc(existing ? existing.bank_name || '' : '')}"></div>
          <div class="field"><label>Account/Till Number (optional)</label><input id="fpp-acc" value="${esc(existing ? existing.account_number || '' : '')}"></div>
        </div>
        ${existing ? `<label class="chk" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-top:6px"><input type="checkbox" id="fpp-active" ${existing.active !== false ? 'checked' : ''}><span>Active (included in future payroll runs)</span></label>` : ''}
      `,
      okLabel: 'Save',
      onOk: async () => {
        const staffId = document.getElementById('fpp-staff').value;
        if (!staffId) { toast('Choose a staff member.', 'err'); return; }
        const res = await Db.finance.payrollProfiles.save({
          id: existing ? existing.id : undefined, staff_id: staffId,
          position: document.getElementById('fpp-position').value, department: document.getElementById('fpp-department').value,
          basic_salary: document.getElementById('fpp-basic').value, regular_allowances: document.getElementById('fpp-allow').value,
          regular_deductions: document.getElementById('fpp-deduct').value, payment_method: document.getElementById('fpp-method').value,
          bank_name: document.getElementById('fpp-bank').value, account_number: document.getElementById('fpp-acc').value,
          active: existing ? document.getElementById('fpp-active').checked : true
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        toast('Payroll profile saved.', 'ok');
        await renderProfiles(root);
      }
    });
  };
  root.querySelector('#fpp-add').onclick = () => openModal(null);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openModal(profiles.find((p) => p.id === b.dataset.edit)));
}

/* -------------------------------------------------------------- Run Payroll */
async function renderRun(root) {
  const now = new Date();
  await loadRun(root, { year: now.getFullYear(), month: now.getMonth() + 1 });
}

async function loadRun(root, sel) {
  root.innerHTML = loader();
  const runsRes = await Db.finance.payrollRuns.list();
  const runs = runsRes.ok ? runsRes.data : [];
  const existing = runs.find((r) => r.period_year === sel.year && r.period_month === sel.month);

  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Month</label><select id="fpr-month">${MONTHS.map((m, i) => `<option value="${i + 1}" ${sel.month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="field"><label>Year</label><input id="fpr-year" type="number" value="${sel.year}" style="width:100px"></div>
      </div>
      <div class="spacer"></div>
      ${!existing ? '<button class="btn" id="fpr-create">Create Payroll</button>' : ''}
    </div>
    <div id="fpr-content">${loader()}</div>
  `;
  root.querySelector('#fpr-month').onchange = (e) => loadRun(root, { ...sel, month: Number(e.target.value) });
  root.querySelector('#fpr-year').onchange = (e) => loadRun(root, { ...sel, year: Number(e.target.value) || sel.year });

  const contentEl = root.querySelector('#fpr-content');
  if (!existing) {
    contentEl.innerHTML = `<div class="card pad muted">No payroll created yet for ${MONTHS[sel.month - 1]} ${sel.year}. Click "Create Payroll" to bring in every active payroll profile.</div>`;
    root.querySelector('#fpr-create').onclick = async () => {
      const res = await Db.finance.payrollRuns.create(sel.year, sel.month);
      if (!res.ok) { toast(res.message, 'err'); return; }
      if (!res.data.employee_count) toast('Payroll created, but no staff have a payroll profile yet — add some under Staff Payroll first.', 'err');
      else toast(`Payroll created for ${res.data.employee_count} employee(s).`, 'ok');
      await loadRun(root, sel);
    };
    return;
  }
  await renderRunDetail(contentEl, existing, sel, () => loadRun(root, sel));
}

async function renderRunDetail(root, run, sel, onRefresh) {
  root.innerHTML = loader();
  const itemsRes = await Db.finance.payrollRuns.items(run.id);
  const items = itemsRes.ok ? itemsRes.data : [];
  const editable = run.status === 'draft';
  const totals = items.reduce((a, it) => ({ gross: a.gross + Number(it.gross_pay), ded: a.ded + Number(it.total_deductions), net: a.net + Number(it.net_pay) }), { gross: 0, ded: 0, net: 0 });

  root.innerHTML = `
    <div class="card pad" style="margin-bottom:10px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div><b>${MONTHS[run.period_month - 1]} ${run.period_year}</b> — ${items.length} employee(s)</div>
      <div>${run.status === 'draft' ? '<span class="badge amber">Draft</span>' : run.status === 'finalized' ? '<span class="badge green">Finalized</span>' : '<span class="badge">Reversed</span>'}</div>
      <div class="spacer"></div>
      ${editable ? `<button class="btn" id="fpr-finalize">Finalize Payroll</button>` : ''}
      ${run.status === 'finalized' && run.finance_expenses && Number(run.finance_expenses.paid_amount) === 0 ? `<button class="btn secondary" id="fpr-reverse">Reverse Payroll</button>` : ''}
    </div>
    ${run.status === 'finalized' && run.finance_expenses ? `<div class="card pad" style="margin-bottom:10px">Posted to Finance as <b>${esc(run.finance_expenses.expense_no)}</b> — ${esc(run.finance_expenses.status)} (${money(run.finance_expenses.paid_amount)} of ${money(run.finance_expenses.amount)} paid). Record the actual payment from the Expenses tab.</div>` : ''}
    <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Employee</th><th>Position</th><th>Department</th><th>Basic</th><th>Allowances</th><th>Deductions</th><th>Adjustments</th><th>Gross</th><th>Net</th><th></th></tr></thead>
      <tbody>${items.map((it) => `<tr>
        <td>${esc(it.staff ? it.staff.full_name : '')}</td><td>${esc(it.position || '—')}</td><td>${esc(it.department || '—')}</td>
        <td>${money(it.basic_salary)}</td><td>${money(it.regular_allowances)}</td><td>${money(it.regular_deductions)}</td>
        <td>${(it.adjustments || []).length ? `${it.adjustments.length} item(s)` : '—'}</td>
        <td>${money(it.gross_pay)}</td><td><b>${money(it.net_pay)}</b></td>
        <td>${editable ? `<button class="btn secondary sm" data-adjust="${it.id}">Adjust</button>` : `<button class="btn secondary sm" data-payslip="${it.id}">Payslip</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="10" class="muted">No employees in this payroll.</td></tr>'}</tbody>
      <tfoot><tr style="font-weight:700"><td colspan="7" style="text-align:right">Totals</td><td>${money(totals.gross)}</td><td>${money(totals.net)}</td><td></td></tr></tfoot>
    </table></div></div>
  `;

  if (editable) {
    root.querySelectorAll('[data-adjust]').forEach((b) => b.onclick = () => {
      const item = items.find((i) => i.id === b.dataset.adjust);
      openAdjustModal(item, async () => { await renderRunDetail(root, run, sel, onRefresh); });
    });
    const finalizeBtn = root.querySelector('#fpr-finalize');
    if (finalizeBtn) finalizeBtn.onclick = () => {
      confirmAction(`Finalize payroll for ${MONTHS[run.period_month - 1]} ${run.period_year}? This posts a single expense of ${money(totals.net)} to Finance under "Salaries & Wages" and locks these figures — use Reverse afterwards if a mistake is found before anything is paid.`, async () => {
        const res = await Db.finance.payrollRuns.finalize(run.id);
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(`Payroll finalized — posted as ${res.data.expense_no}.`, 'ok');
        if (onRefresh) await onRefresh();
      });
    };
  } else {
    root.querySelectorAll('[data-payslip]').forEach((b) => b.onclick = () => {
      const item = items.find((i) => i.id === b.dataset.payslip);
      printPayslip(run, item);
    });
    const reverseBtn = root.querySelector('#fpr-reverse');
    if (reverseBtn) reverseBtn.onclick = () => openReverseModal(run, async () => { if (onRefresh) await onRefresh(); });
  }
}

function openAdjustModal(item, onSaved) {
  let rows = [...(item.adjustments || [])];
  const render = () => {
    modal({
      title: `Adjustments — ${item.staff ? item.staff.full_name : ''}`,
      body: `
        <p class="hint" style="margin-top:0">One-off items for this month only — bonuses, remedial pay, salary advances, loan repayments, unpaid-absence deductions, etc. Regular allowances/deductions from the profile still apply on top of these.</p>
        <div id="fadj-rows">${rows.map((r, i) => `
          <div class="grid2" style="align-items:end;margin-bottom:6px">
            <div class="field"><label>${i === 0 ? 'Label' : ''}</label><input class="fadj-label" value="${esc(r.label || '')}"></div>
            <div style="display:flex;gap:8px;align-items:end">
              <div class="field" style="flex:1"><label>${i === 0 ? 'Type' : ''}</label><select class="fadj-kind"><option value="allowance" ${r.kind === 'allowance' ? 'selected' : ''}>Allowance (+)</option><option value="deduction" ${r.kind === 'deduction' ? 'selected' : ''}>Deduction (-)</option></select></div>
              <div class="field" style="flex:1"><label>${i === 0 ? 'Amount' : ''}</label><input class="fadj-amount" type="number" min="0" step="0.01" value="${r.amount}"></div>
              <button class="btn secondary sm" data-remove="${i}">✕</button>
            </div>
          </div>
        `).join('') || '<p class="muted">No adjustments yet.</p>'}</div>
        <button class="btn secondary sm" id="fadj-add">+ Add Adjustment</button>
      `,
      okLabel: 'Save Adjustments',
      onOk: async () => {
        const labels = document.querySelectorAll('.fadj-label');
        const kinds = document.querySelectorAll('.fadj-kind');
        const amounts = document.querySelectorAll('.fadj-amount');
        const adjustments = [];
        for (let i = 0; i < labels.length; i++) {
          const amount = Number(amounts[i].value);
          if (amount > 0) adjustments.push({ label: labels[i].value || (kinds[i].value === 'allowance' ? 'Allowance' : 'Deduction'), kind: kinds[i].value, amount });
        }
        const res = await Db.finance.payrollRuns.updateItem(item.id, adjustments);
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        toast('Adjustments saved.', 'ok');
        onSaved();
      },
      onOpen: () => {
        document.getElementById('fadj-add').onclick = () => { rows.push({ label: '', kind: 'allowance', amount: 0 }); render(); };
        document.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => { rows.splice(Number(b.dataset.remove), 1); render(); });
      }
    });
  };
  render();
}

function openReverseModal(run, onDone) {
  modal({
    title: 'Reverse Payroll',
    body: `
      <p style="margin-top:0">This voids the posted Finance expense and marks ${MONTHS[run.period_month - 1]} ${run.period_year}'s payroll as reversed. Nothing is deleted — it stays visible in History for the record. Only possible because no payment has been recorded against it yet.</p>
      <div class="field"><label>Reason (optional)</label><textarea id="frev-reason" rows="2" placeholder="e.g. Two staff omitted, recreating with correct list"></textarea></div>
    `,
    okLabel: 'Reverse Payroll',
    onOk: async () => {
      const res = await Db.finance.payrollRuns.reverse(run.id, document.getElementById('frev-reason').value);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Payroll reversed.', 'ok');
      onDone();
    }
  });
}

/* ------------------------------------------------------------------ History */
async function renderHistory(root) {
  root.innerHTML = loader();
  const [runsRes, staffRes] = await Promise.all([Db.finance.payrollRuns.list(), Db.staff.list()]);
  const runs = runsRes.ok ? runsRes.data : [];
  const staff = staffRes.ok ? staffRes.data : [];
  root.innerHTML = `
    <div class="fin-tabs" style="margin-bottom:10px"><button class="active" data-htab="months">By Month</button><button data-htab="staff">By Employee</button></div>
    <div id="fh-content"></div>
  `;
  const contentEl = root.querySelector('#fh-content');
  const showMonths = () => {
    contentEl.innerHTML = `
      <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Period</th><th>Status</th><th>Posted Expense</th><th></th></tr></thead>
        <tbody>${runs.map((r) => `<tr>
          <td>${MONTHS[r.period_month - 1]} ${r.period_year}</td>
          <td>${r.status === 'draft' ? '<span class="badge amber">Draft</span>' : r.status === 'finalized' ? '<span class="badge green">Finalized</span>' : '<span class="badge">Reversed</span>'}</td>
          <td>${r.finance_expenses ? `${esc(r.finance_expenses.expense_no)} — ${money(r.finance_expenses.amount)} (${esc(r.finance_expenses.status)})` : '—'}</td>
          <td><button class="btn secondary sm" data-view="${r.id}">View</button></td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">No payrolls created yet.</td></tr>'}</tbody>
      </table></div></div>
      <div id="fh-detail" style="margin-top:12px"></div>
    `;
    contentEl.querySelectorAll('[data-view]').forEach((b) => b.onclick = async () => {
      const run = runs.find((r) => r.id === b.dataset.view);
      const detailEl = contentEl.querySelector('#fh-detail');
      // Refreshing after a finalize/reverse here just re-runs the whole
      // History tab (re-fetches the run list fresh) rather than trying to
      // patch this one row in place — simplest correct option, and History
      // is read-mostly so the extra round-trip is not something a user
      // would notice as a "lag."
      await renderRunDetail(detailEl, run, { year: run.period_year, month: run.period_month }, () => renderHistory(root));
    });
  };
  const showStaff = () => {
    contentEl.innerHTML = `
      <div class="field" style="max-width:360px"><label>Employee</label><select id="fh-staff"><option value="">Choose a staff member…</option>${options(staff, 'id', 'full_name')}</select></div>
      <div id="fh-staff-history" style="margin-top:12px"></div>
    `;
    contentEl.querySelector('#fh-staff').onchange = async (e) => {
      const historyEl = contentEl.querySelector('#fh-staff-history');
      if (!e.target.value) { historyEl.innerHTML = ''; return; }
      historyEl.innerHTML = loader();
      const res = await Db.finance.payrollRuns.historyForStaff(e.target.value);
      const rows = res.ok ? res.data : [];
      historyEl.innerHTML = `
        <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
          <thead><tr><th>Period</th><th>Basic</th><th>Gross</th><th>Deductions</th><th>Net Pay</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${MONTHS[r.finance_payroll_runs.period_month - 1]} ${r.finance_payroll_runs.period_year}</td>
            <td>${money(r.basic_salary)}</td><td>${money(r.gross_pay)}</td><td>${money(r.total_deductions)}</td><td><b>${money(r.net_pay)}</b></td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No finalized payroll history for this employee yet.</td></tr>'}</tbody>
        </table></div></div>
      `;
    };
  };
  root.querySelectorAll('[data-htab]').forEach((b) => b.onclick = () => {
    root.querySelectorAll('[data-htab]').forEach((x) => x.classList.toggle('active', x === b));
    if (b.dataset.htab === 'months') showMonths(); else showStaff();
  });
  showMonths();
}

/* ------------------------------------------------------------------ Reports */
async function renderReports(root) {
  root.innerHTML = loader();
  const runsRes = await Db.finance.payrollRuns.list();
  const finalized = (runsRes.ok ? runsRes.data : []).filter((r) => r.status === 'finalized');
  root.innerHTML = `
    <div class="field" style="max-width:320px"><label>Payroll Month</label><select id="frp-run"><option value="">Choose a finalized month…</option>${finalized.map((r) => `<option value="${r.id}">${MONTHS[r.period_month - 1]} ${r.period_year}</option>`).join('')}</select></div>
    <div id="frp-content" style="margin-top:12px"></div>
  `;
  root.querySelector('#frp-run').onchange = async (e) => {
    const contentEl = root.querySelector('#frp-content');
    if (!e.target.value) { contentEl.innerHTML = ''; return; }
    contentEl.innerHTML = loader();
    const res = await Db.finance.payrollRuns.items(e.target.value);
    const items = res.ok ? res.data : [];
    const totals = items.reduce((a, it) => ({ gross: a.gross + Number(it.gross_pay), ded: a.ded + Number(it.total_deductions), net: a.net + Number(it.net_pay) }), { gross: 0, ded: 0, net: 0 });
    const byDept = new Map();
    items.forEach((it) => {
      const dept = it.department || 'Unassigned';
      const cur = byDept.get(dept) || { count: 0, gross: 0, ded: 0, net: 0 };
      cur.count++; cur.gross += Number(it.gross_pay); cur.ded += Number(it.total_deductions); cur.net += Number(it.net_pay);
      byDept.set(dept, cur);
    });
    contentEl.innerHTML = `
      <div class="fin-summary-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px">
        <div class="card pad"><div class="muted" style="font-size:12px">Employees</div><div style="font-size:20px;font-weight:700">${items.length}</div></div>
        <div class="card pad"><div class="muted" style="font-size:12px">Total Gross</div><div style="font-size:20px;font-weight:700">${money(totals.gross)}</div></div>
        <div class="card pad"><div class="muted" style="font-size:12px">Total Deductions</div><div style="font-size:20px;font-weight:700">${money(totals.ded)}</div></div>
        <div class="card pad"><div class="muted" style="font-size:12px">Total Net Pay</div><div style="font-size:20px;font-weight:700">${money(totals.net)}</div></div>
      </div>
      <div class="card"><div class="card-h"><h3>By Department</h3></div><div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Department</th><th>Employees</th><th>Gross</th><th>Deductions</th><th>Net</th></tr></thead>
        <tbody>${[...byDept.entries()].map(([dept, d]) => `<tr><td>${esc(dept)}</td><td>${d.count}</td><td>${money(d.gross)}</td><td>${money(d.ded)}</td><td>${money(d.net)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No data.</td></tr>'}</tbody>
      </table></div></div>
    `;
  };
}

/* ------------------------------------------------------------------ Payslip */
async function printPayslip(run, item) {
  const settingsRes = await Db.settings.get();
  const settings = settingsRes.ok ? settingsRes.data : (state.settings || {});
  const win = window.open('', '_blank', 'width=820,height=920');
  if (!win) { toast('Please allow pop-ups to print the payslip.', 'err'); return; }
  if (!isContactInfoComplete(settings)) {
    win.document.write(`<html><head><title>Payslip</title></head><body style="font-family:Arial,sans-serif;padding:40px">${missingContactInfoHtml()}</body></html>`);
    win.document.close();
    return;
  }
  const addrLines = addressLines(settings);
  const monthLabel = `${MONTHS[run.period_month - 1]} ${run.period_year}`;
  const rows = (item.adjustments || []);
  win.document.write(`
    <html><head><title>Payslip — ${esc(item.staff ? item.staff.full_name : '')} — ${esc(monthLabel)}</title>
    <style>
      *{box-sizing:border-box} body{font-family:'Segoe UI',Arial,sans-serif;margin:0;padding:36px 40px;color:#111;position:relative}
      .ps-water{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-25deg);opacity:.06;width:340px;height:340px;object-fit:contain;z-index:0}
      .ps-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;position:relative;z-index:1}
      .ps-school h2{margin:0;font-size:18px;font-weight:800} .ps-school p{margin:2px 0 0;font-size:12px;color:#555}
      .ps-title{text-align:center;margin:18px 0;font-size:16px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;position:relative;z-index:1}
      table{width:100%;border-collapse:collapse;position:relative;z-index:1} th,td{border:1px solid #ddd;padding:8px 10px;font-size:13px;text-align:left}
      th{background:#f7f9fb;text-transform:uppercase;font-size:10.5px;letter-spacing:.4px}
      .num{text-align:right} .net-row td{font-weight:800;font-size:15px;background:#f3faf6}
      .ps-meta{margin:14px 0;font-size:13px} .ps-meta b{display:inline-block;width:140px}
      @media print{ body{padding:0 24px} }
    </style></head>
    <body>
      ${settings.logo ? `<img class="ps-water" src="${esc(settings.logo)}">` : ''}
      <div class="ps-top">
        <div class="ps-school"><h2>${esc(settings.school_name || 'School')}</h2>${addrLines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
        <div style="text-align:right"><div style="font-size:12px;color:#666">Payslip</div><div style="font-weight:700">${esc(monthLabel)}</div></div>
      </div>
      <div class="ps-title">Payslip — ${esc(monthLabel)}</div>
      <div class="ps-meta">
        <div><b>Employee</b> ${esc(item.staff ? item.staff.full_name : '')}</div>
        <div><b>Position</b> ${esc(item.position || '—')}</div>
        <div><b>Department</b> ${esc(item.department || '—')}</div>
      </div>
      <table>
        <thead><tr><th>Description</th><th class="num">Earnings</th><th class="num">Deductions</th></tr></thead>
        <tbody>
          <tr><td>Basic Salary</td><td class="num">${item.basic_salary.toLocaleString ? item.basic_salary.toLocaleString() : item.basic_salary}</td><td class="num">—</td></tr>
          <tr><td>Regular Allowances</td><td class="num">${Number(item.regular_allowances).toLocaleString()}</td><td class="num">—</td></tr>
          <tr><td>Regular Deductions</td><td class="num">—</td><td class="num">${Number(item.regular_deductions).toLocaleString()}</td></tr>
          ${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.kind === 'allowance' ? Number(r.amount).toLocaleString() : '—'}</td><td class="num">${r.kind === 'deduction' ? Number(r.amount).toLocaleString() : '—'}</td></tr>`).join('')}
          <tr style="font-weight:700"><td>Gross Pay</td><td class="num">${Number(item.gross_pay).toLocaleString()}</td><td class="num">${Number(item.total_deductions).toLocaleString()}</td></tr>
          <tr class="net-row"><td>Net Pay</td><td class="num" colspan="2">KES ${Number(item.net_pay).toLocaleString()}</td></tr>
        </tbody>
      </table>
      <p style="margin-top:24px;font-size:11px;color:#888">Generated by ${esc(settings.school_name || 'the school')}'s Finance system. This is a system-generated payslip.</p>
      <script>window.onload = () => setTimeout(() => window.print(), 200);</script>
    </body></html>
  `);
  win.document.close();
}
