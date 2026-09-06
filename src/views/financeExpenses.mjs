/**
 * financeExpenses.mjs — Finance Expansion brief item 7 ("Expenses Module").
 * Five sub-tabs mirroring the brief's own flow: Suppliers -> LPOs ->
 * Expenses (record + pay) -> Payments (voucher history) -> Supplier
 * Balances. Manage-only throughout (see migrations/0052's header comment
 * for why) — this whole screen is gated the same way financeAccounting.mjs
 * gates itself.
 */
import { esc, options, toast, modal, closeModal, confirmAction, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const SUB_TABS = [
  { key: 'expenses', label: 'Expenses' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'lpos', label: 'LPOs' },
  { key: 'vouchers', label: 'Payments' },
  { key: 'balances', label: 'Supplier Balances' }
];

const STATUS_BADGE = {
  unpaid: '<span class="badge amber">Unpaid</span>',
  partial: '<span class="badge blue">Partial</span>',
  paid: '<span class="badge green">Paid</span>',
  pending: '<span class="badge amber">Pending</span>',
  fulfilled: '<span class="badge green">Fulfilled</span>',
  cancelled: '<span class="badge">Cancelled</span>',
  // Payroll Expansion §3.7 — a reversed payroll voids its posted expense
  // rather than deleting it (see migrations/0054). Shown distinctly so it
  // reads as "never actually owed," not just another unpaid bill.
  void: '<span class="badge">Voided</span>'
};

export async function viewFinanceExpenses(root, access) {
  if (!access || !access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to manage Expenses — ask your school admin for full Finance access.</div>`;
    return;
  }
  let active = 'expenses';
  root.innerHTML = `
    <div class="fin-tabs wrap-tabs">
      ${SUB_TABS.map((t) => `<button data-etab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fe-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#fe-body');
  const show = (key, ctx) => {
    active = key;
    root.querySelectorAll('[data-etab]').forEach((b) => b.classList.toggle('active', b.dataset.etab === key));
    if (key === 'expenses') renderExpenses(body, ctx);
    else if (key === 'suppliers') renderSuppliers(body);
    else if (key === 'lpos') renderLpos(body);
    else if (key === 'vouchers') renderVouchers(body);
    else renderBalances(body, (supplierId) => show('expenses', { supplier_id: supplierId }));
  };
  root.querySelectorAll('[data-etab]').forEach((b) => b.onclick = () => show(b.dataset.etab));
  show(active);
}

/* --------------------------------------------------------------- Expenses */
async function renderExpenses(root, ctx) {
  root.innerHTML = loader();
  const [suppliersRes, voteHeadsRes] = await Promise.all([Db.finance.suppliers.list(), Db.finance.voteHeads.list()]);
  const suppliers = suppliersRes.ok ? suppliersRes.data : [];
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  await loadExpenses(root, suppliers, voteHeads, { supplier_id: (ctx && ctx.supplier_id) || '', vote_head_id: '', status: '' });
}

async function loadExpenses(root, suppliers, voteHeads, filters) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Supplier</label><select id="fe-f-supplier"><option value="">All</option>${options(suppliers, 'id', 'name', filters.supplier_id)}</select></div>
        <div class="field"><label>Votehead</label><select id="fe-f-vh"><option value="">All</option>${options(voteHeads, 'id', 'name', filters.vote_head_id)}</select></div>
        <div class="field"><label>Status</label><select id="fe-f-status">
          <option value="">All</option>
          <option value="unpaid" ${filters.status === 'unpaid' ? 'selected' : ''}>Unpaid</option>
          <option value="partial" ${filters.status === 'partial' ? 'selected' : ''}>Partial</option>
          <option value="paid" ${filters.status === 'paid' ? 'selected' : ''}>Paid</option>
        </select></div>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="fe-add">+ Record Expense</button>
    </div>
    <div id="fe-list">${loader()}</div>
  `;
  const refresh = async () => {
    const f = {
      supplier_id: root.querySelector('#fe-f-supplier').value, vote_head_id: root.querySelector('#fe-f-vh').value,
      status: root.querySelector('#fe-f-status').value
    };
    const listEl = root.querySelector('#fe-list');
    listEl.innerHTML = loader();
    const res = await Db.finance.expenses.list(f);
    const rows = res.ok ? res.data : [];
    const totalOwed = rows.filter((r) => r.status !== 'void').reduce((a, r) => a + (Number(r.amount) - Number(r.paid_amount)), 0);
    listEl.innerHTML = `
      <div class="card pad" style="margin-bottom:10px"><b>${rows.length}</b> expense(s) shown · Outstanding across them: <b>KES ${totalOwed.toLocaleString()}</b></div>
      <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Expense No.</th><th>Supplier/Payee</th><th>Description</th><th>Votehead</th><th>LPO</th><th>Amount</th><th>Paid</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.expense_date)}</td>
          <td>${esc(r.expense_no)}</td>
          <td>${esc(r.finance_suppliers ? r.finance_suppliers.name : 'Miscellaneous')}</td>
          <td>${esc(r.description || '—')}</td>
          <td>${esc(r.finance_vote_heads ? r.finance_vote_heads.name : '')}</td>
          <td>${esc(r.finance_lpos ? r.finance_lpos.lpo_no : '—')}</td>
          <td>KES ${Number(r.amount).toLocaleString()}</td>
          <td>KES ${Number(r.paid_amount).toLocaleString()}</td>
          <td>${STATUS_BADGE[r.status] || esc(r.status)}</td>
          <td>${r.status !== 'paid' && r.status !== 'void' ? `<button class="btn secondary sm" data-pay="${r.id}">Record Payment</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="10" class="muted">No expenses match these filters.</td></tr>'}</tbody>
      </table></div></div>
    `;
    listEl.querySelectorAll('[data-pay]').forEach((b) => b.onclick = () => {
      const row = rows.find((r) => r.id === b.dataset.pay);
      openPaymentModal(row, async () => { await refresh(); });
    });
  };
  root.querySelector('#fe-f-supplier').onchange = refresh;
  root.querySelector('#fe-f-vh').onchange = refresh;
  root.querySelector('#fe-f-status').onchange = refresh;
  root.querySelector('#fe-add').onclick = () => openExpenseModal(suppliers, voteHeads, async () => { await refresh(); });
  await refresh();
}

function openExpenseModal(suppliers, voteHeads, onSaved) {
  modal({
    title: 'Record an Expense / Supplier Invoice',
    body: `
      <div class="field"><label>Supplier (optional — leave blank for a miscellaneous expense like fuel, transport, utilities)</label>
        <select id="fe-supplier"><option value="">— Miscellaneous / no supplier —</option>${options(suppliers.filter((s) => s.active !== false), 'id', 'name')}</select>
      </div>
      <div class="field" id="fe-lpo-field" style="display:none"><label>LPO (optional — only pending LPOs for this supplier show up)</label>
        <select id="fe-lpo"><option value="">— No LPO —</option></select>
      </div>
      <div class="grid2">
        <div class="field"><label>Expense Account / Votehead</label><select id="fe-vh">${options(voteHeads.filter((v) => v.active !== false), 'id', 'name')}</select></div>
        <div class="field"><label>Amount (KES)</label><input id="fe-amount" type="number" min="0" step="0.01"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Date</label><input id="fe-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Description</label><input id="fe-desc" placeholder="e.g. Electricity bill — June"></div>
      </div>
    `,
    okLabel: 'Record Expense',
    onOk: async () => {
      const amount = Number(document.getElementById('fe-amount').value);
      if (!(amount > 0)) { toast('Enter an amount greater than zero.', 'err'); return; }
      const res = await Db.finance.expenses.record({
        supplier_id: document.getElementById('fe-supplier').value || null,
        lpo_id: document.getElementById('fe-lpo').value || null,
        vote_head_id: document.getElementById('fe-vh').value,
        amount, expense_date: document.getElementById('fe-date').value,
        description: document.getElementById('fe-desc').value
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`Expense ${res.data.expense_no} recorded.`, 'ok');
      onSaved();
    },
    onOpen: () => {
      const supplierSel = document.getElementById('fe-supplier');
      const lpoField = document.getElementById('fe-lpo-field');
      const lpoSel = document.getElementById('fe-lpo');
      supplierSel.onchange = async () => {
        const supplierId = supplierSel.value;
        if (!supplierId) { lpoField.style.display = 'none'; lpoSel.innerHTML = ''; return; }
        const res = await Db.finance.lpos.pendingForSupplier(supplierId);
        const pending = res.ok ? res.data : [];
        lpoField.style.display = pending.length ? '' : 'none';
        lpoSel.innerHTML = '<option value="">— No LPO —</option>' + pending.map((l) => `<option value="${l.id}">${esc(l.lpo_no)} — KES ${Number(l.amount).toLocaleString()}</option>`).join('');
      };
    }
  });
}

function openPaymentModal(expense, onSaved) {
  const remaining = Number(expense.amount) - Number(expense.paid_amount);
  modal({
    title: `Record Payment — ${expense.expense_no}`,
    body: `
      <p class="muted" style="margin-top:0">Remaining balance owed: <b>KES ${remaining.toLocaleString()}</b></p>
      <div class="grid2">
        <div class="field"><label>Pay From (Account)</label><select id="fp-account">${loader()}</select></div>
        <div class="field"><label>Amount (KES)</label><input id="fp-amount" type="number" min="0.01" step="0.01" max="${remaining}" value="${remaining}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Payment Method</label><select id="fp-method">
          <option value="bank">Bank</option><option value="cash">Cash</option><option value="paybill">Paybill</option><option value="other">Other</option>
        </select></div>
        <div class="field"><label>Date</label><input id="fp-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label>Notes (optional)</label><input id="fp-notes"></div>
    `,
    okLabel: 'Record Payment',
    onOk: async () => {
      const amount = Number(document.getElementById('fp-amount').value);
      if (!(amount > 0)) { toast('Enter an amount greater than zero.', 'err'); return; }
      if (amount > remaining + 0.001) { toast(`Amount cannot exceed the remaining balance (KES ${remaining.toLocaleString()}).`, 'err'); return; }
      const accountId = document.getElementById('fp-account').value;
      if (!accountId) { toast('Choose which account this is paid from.', 'err'); return; }
      const res = await Db.finance.paymentVouchers.record(
        expense.id, accountId, amount, document.getElementById('fp-date').value,
        document.getElementById('fp-method').value, document.getElementById('fp-notes').value
      );
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`Payment Voucher ${res.data.voucher_no} recorded.`, 'ok');
      onSaved();
    },
    onOpen: async () => {
      const accRes = await Db.finance.accounts.list();
      const accs = accRes.ok ? accRes.data.filter((a) => a.active !== false) : [];
      document.getElementById('fp-account').innerHTML = accs.length ? options(accs, 'id', 'name') : '<option value="">No accounts set up yet — add one in Accounting first</option>';
    }
  });
}

/* -------------------------------------------------------------- Suppliers */
async function renderSuppliers(root) {
  root.innerHTML = loader();
  const res = await Db.finance.suppliers.list();
  const rows = res.ok ? res.data : [];
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Suppliers</h3><button class="btn sm" id="fsup-add" style="margin-left:auto">+ Add Supplier</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Contact Person</th><th>Phone</th><th>Category</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((s) => `<tr>
          <td>${esc(s.name)}</td><td>${esc(s.contact_person || '—')}</td><td>${esc(s.phone || '—')}</td><td>${esc(s.category || '—')}</td>
          <td>${s.active === false ? '<span class="badge amber">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
          <td><button class="btn secondary sm" data-edit="${s.id}">Edit</button></td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">No suppliers yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
  const openModal = (existing) => {
    modal({
      title: existing ? 'Edit Supplier' : 'Add Supplier',
      body: `
        <div class="field"><label>Supplier Name</label><input id="fsup-name" value="${esc(existing ? existing.name : '')}"></div>
        <div class="grid2">
          <div class="field"><label>Contact Person</label><input id="fsup-contact" value="${esc(existing ? existing.contact_person || '' : '')}"></div>
          <div class="field"><label>Phone</label><input id="fsup-phone" value="${esc(existing ? existing.phone || '' : '')}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Email (optional)</label><input id="fsup-email" value="${esc(existing ? existing.email || '' : '')}"></div>
          <div class="field"><label>Category (optional)</label><input id="fsup-cat" placeholder="e.g. Stationery, Foodstuffs" value="${esc(existing ? existing.category || '' : '')}"></div>
        </div>
        <div class="field"><label>Address (optional)</label><input id="fsup-addr" value="${esc(existing ? existing.address || '' : '')}"></div>
        ${existing ? `<label class="chk" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-top:6px"><input type="checkbox" id="fsup-active" ${existing.active !== false ? 'checked' : ''}><span>Active</span></label>` : ''}
      `,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fsup-name').value.trim();
        if (!name) { toast('Enter a supplier name.', 'err'); return; }
        const res = await Db.finance.suppliers.save({
          id: existing ? existing.id : undefined, name,
          contact_person: document.getElementById('fsup-contact').value,
          phone: document.getElementById('fsup-phone').value,
          email: document.getElementById('fsup-email').value,
          category: document.getElementById('fsup-cat').value,
          address: document.getElementById('fsup-addr').value,
          active: existing ? document.getElementById('fsup-active').checked : true
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        toast('Supplier saved.', 'ok');
        await renderSuppliers(root);
      }
    });
  };
  root.querySelector('#fsup-add').onclick = () => openModal(null);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openModal(rows.find((s) => s.id === b.dataset.edit)));
}

/* ------------------------------------------------------------------- LPOs */
async function renderLpos(root) {
  root.innerHTML = loader();
  const [lposRes, suppliersRes] = await Promise.all([Db.finance.lpos.list(), Db.finance.suppliers.list()]);
  const rows = lposRes.ok ? lposRes.data : [];
  const suppliers = suppliersRes.ok ? suppliersRes.data : [];
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Local Purchase Orders</h3><button class="btn sm" id="flpo-add" style="margin-left:auto">+ New LPO</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>LPO No.</th><th>Date</th><th>Supplier</th><th>Description</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((l) => `<tr>
          <td>${esc(l.lpo_no)}</td><td>${esc(l.issued_date)}</td><td>${esc(l.finance_suppliers ? l.finance_suppliers.name : '')}</td>
          <td>${esc(l.description || '—')}</td><td>KES ${Number(l.amount).toLocaleString()}</td>
          <td>${STATUS_BADGE[l.status] || esc(l.status)}</td>
          <td>${l.status === 'pending' ? `<button class="btn secondary sm" data-cancel="${l.id}">Cancel</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No LPOs yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
  root.querySelector('#flpo-add').onclick = () => {
    if (!suppliers.length) { toast('Add a Supplier first.', 'err'); return; }
    modal({
      title: 'New LPO',
      body: `
        <div class="field"><label>Supplier</label><select id="flpo-supplier">${options(suppliers.filter((s) => s.active !== false), 'id', 'name')}</select></div>
        <div class="grid2">
          <div class="field"><label>Amount (KES)</label><input id="flpo-amount" type="number" min="0" step="0.01"></div>
          <div class="field"><label>Date</label><input id="flpo-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        </div>
        <div class="field"><label>Items / Services / Description</label><textarea id="flpo-desc" rows="3" placeholder="e.g. 10 reams of photocopy paper, 5 marker pens"></textarea></div>
      `,
      okLabel: 'Create LPO',
      onOk: async () => {
        const amount = Number(document.getElementById('flpo-amount').value);
        if (!(amount >= 0)) { toast('Enter a valid amount.', 'err'); return; }
        const res = await Db.finance.lpos.record(
          document.getElementById('flpo-supplier').value, document.getElementById('flpo-desc').value, amount, document.getElementById('flpo-date').value
        );
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        toast(`${res.data.lpo_no} created.`, 'ok');
        await renderLpos(root);
      }
    });
  };
  root.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => {
    confirmAction('Cancel this LPO? It will no longer be available to attach to an expense.', async () => {
      const res = await Db.finance.lpos.cancel(b.dataset.cancel);
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast('LPO cancelled.', 'ok');
      await renderLpos(root);
    });
  });
}

/* --------------------------------------------------------------- Payments */
async function renderVouchers(root) {
  root.innerHTML = loader();
  const res = await Db.finance.paymentVouchers.list();
  const rows = res.ok ? res.data : [];
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Payment History</h3></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Voucher No.</th><th>Supplier/Payee</th><th>Expense Ref.</th><th>Amount</th><th>Method</th><th>Account</th></tr></thead>
        <tbody>${rows.map((v) => `<tr>
          <td>${esc(v.payment_date)}</td><td>${esc(v.voucher_no)}</td>
          <td>${esc(v.finance_expenses && v.finance_expenses.finance_suppliers ? v.finance_expenses.finance_suppliers.name : 'Miscellaneous')}</td>
          <td>${esc(v.finance_expenses ? v.finance_expenses.expense_no : '')}${v.finance_expenses && v.finance_expenses.description ? ` — ${esc(v.finance_expenses.description)}` : ''}</td>
          <td>KES ${Number(v.amount).toLocaleString()}</td>
          <td style="text-transform:capitalize">${esc(v.payment_method)}</td>
          <td>${esc(v.finance_accounts ? v.finance_accounts.name : '')}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No payments recorded yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
}

/* --------------------------------------------------------- Supplier Balances */
async function renderBalances(root, onViewSupplier) {
  root.innerHTML = loader();
  const res = await Db.finance.supplierBalances.list();
  const rows = res.ok ? res.data : [];
  const totalOutstanding = rows.reduce((a, r) => a + Number(r.balance || 0), 0);
  root.innerHTML = `
    <div class="card pad" style="margin-bottom:10px">Total outstanding across all suppliers: <b>KES ${totalOutstanding.toLocaleString()}</b></div>
    <div class="card side-accent tile-amber"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Supplier</th><th>Invoiced</th><th>Paid</th><th>Balance</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.name)}</td><td>KES ${Number(r.invoiced).toLocaleString()}</td><td>KES ${Number(r.paid).toLocaleString()}</td>
        <td>KES ${Number(r.balance).toLocaleString()}</td>
        <td>${Number(r.invoiced) > 0 ? `<button class="btn secondary sm" data-view="${r.supplier_id}">View Expenses</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No suppliers with invoices yet.</td></tr>'}</tbody>
    </table></div></div>
  `;
  root.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => onViewSupplier(b.dataset.view));
}
