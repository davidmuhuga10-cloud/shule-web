/**
 * financeAccounting.mjs — Finance Expansion brief item 2 ("Accounting
 * Module"): Account Types, Vote Heads, and Bank/Cash Accounts.
 *
 * POST-BUILD FEEDBACK item 4 (BUG FIX): these three used to be crammed
 * together on one long page. Restructured into top tabs — the exact same
 * `.fin-tabs`/SUB_TABS/show() pattern Invoicing and Expenses already use —
 * in the order the review asked for: Account Types first (nothing else can
 * exist without one), Vote Heads second, Bank Accounts third (an account
 * picks a type, so types have to exist first; vote heads are independent of
 * both, but conceptually "what fees are for" reads naturally as the second
 * step before "where the money physically sits").
 *
 * Also closes the two real gaps the review called out:
 *  - Every row can now be edited (Db.finance.*.save() already accepted an
 *    `id` for upsert — the UI just never exposed it) and deactivated rather
 *    than deleted. None of these three ever get a hard-delete control: an
 *    Account Type is `on delete restrict`-referenced by real Accounts, and
 *    both Accounts and Vote Heads are referenced by real ledger entries/
 *    expenses/collections the moment they're used — deleting either would
 *    either fail loudly (the DB restrict) or, worse, silently orphan past
 *    records. Deactivating (already-existing `active` column on all three)
 *    is the safe equivalent: it disappears from pickers for new entries
 *    without touching anything already posted against it, and can be
 *    reactivated any time.
 *  - Bank Name is now genuinely required for a non-cash account (was only
 *    LABELED required — nothing stopped an empty string).
 *
 * Vote Heads already existed (migrations/0031) and were only ever
 * manageable inline from the fee-structure modal; Account Types and
 * Accounts are genuinely new (migrations/0050).
 */
import { esc, toast, modal, confirmAction, options, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const SUB_TABS = [
  { key: 'types', label: 'Account Types' },
  { key: 'voteheads', label: 'Vote Heads' },
  { key: 'accounts', label: 'Bank Accounts' }
];

function statusBadge(active) {
  return active === false ? '<span class="badge amber">Inactive</span>' : '<span class="badge green">Active</span>';
}

export async function viewFinanceAccounting(root, access) {
  if (!access || !access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to manage Accounting — ask your school admin for full Finance access.</div>`;
    return;
  }
  let active = 'types';
  root.innerHTML = `
    <div class="fin-tabs wrap-tabs">
      ${SUB_TABS.map((t) => `<button data-atab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fa-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#fa-body');
  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-atab]').forEach((b) => b.classList.toggle('active', b.dataset.atab === key));
    if (key === 'types') renderTypes(body);
    else if (key === 'voteheads') renderVoteHeads(body);
    else renderAccounts(body);
  };
  root.querySelectorAll('[data-atab]').forEach((b) => b.onclick = () => show(b.dataset.atab));
  show(active);
}

/* ---------------------------------------------------------- Account Types */
async function renderTypes(root) {
  root.innerHTML = loader();
  const res = await Db.finance.accountTypes.list();
  const types = res.ok ? res.data : [];
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Account Types</h3><span class="muted" style="font-size:12px">Groupings like School Fund, Activity Fund, Building Fund</span><button class="btn sm" id="fa-add-type" style="margin-left:auto">+ Add Account Type</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
        <tbody>${types.map((t) => `<tr>
          <td>${esc(t.name)}${t.is_default ? ' <span class="badge blue">Default</span>' : ''}</td>
          <td>${statusBadge(t.active)}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn sm ghost" data-edit="${t.id}">Edit</button>
            ${t.is_default ? '' : `<button class="btn sm ghost" data-toggle="${t.id}" data-active="${t.active !== false}">${t.active === false ? 'Activate' : 'Deactivate'}</button>`}
          </td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">No account types yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
  function openModal(existing) {
    modal({
      title: existing ? 'Edit Account Type' : 'Add Account Type',
      body: `<div class="field"><label>Name</label><input id="fa-type-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Activity Fund, Building Fund"></div>`,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fa-type-name').value.trim();
        if (!name) { toast('Enter a name.', 'err'); return; }
        const res = await Db.finance.accountTypes.save({ id: existing ? existing.id : undefined, name, active: existing ? existing.active : true });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(existing ? 'Account type updated.' : 'Account type added.', 'ok');
        await renderTypes(root);
      }
    });
  }
  root.querySelector('#fa-add-type').onclick = () => openModal(null);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openModal(types.find((t) => t.id === b.dataset.edit)));
  root.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
    const t = types.find((x) => x.id === b.dataset.toggle);
    const willActivate = b.dataset.active === 'false';
    confirmAction(
      willActivate
        ? `"${t.name}" will be selectable again for new accounts.`
        : `"${t.name}" will no longer be selectable for NEW accounts. Existing accounts and their history are untouched.`,
      async () => {
        const res = await Db.finance.accountTypes.save({ id: t.id, name: t.name, active: willActivate });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(willActivate ? 'Account type activated.' : 'Account type deactivated.', 'ok');
        await renderTypes(root);
      }
    );
  });
}

/* ------------------------------------------------------------- Vote Heads */
async function renderVoteHeads(root) {
  root.innerHTML = loader();
  const res = await Db.finance.voteHeads.list();
  const voteHeads = res.ok ? res.data : [];
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Vote Heads</h3><span class="muted" style="font-size:12px">What fees are for — used across Invoicing &amp; Collections</span><button class="btn sm" id="fa-add-votehead" style="margin-left:auto">+ Add Vote Head</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Code</th><th>Priority</th><th>Status</th><th></th></tr></thead>
        <tbody>${voteHeads.map((v) => `<tr>
          <td>${esc(v.name)}</td><td>${esc(v.code || '—')}</td><td>${v.priority}</td>
          <td>${statusBadge(v.active)}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn sm ghost" data-edit="${v.id}">Edit</button>
            <button class="btn sm ghost" data-toggle="${v.id}" data-active="${v.active !== false}">${v.active === false ? 'Activate' : 'Deactivate'}</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No vote heads yet.</td></tr>'}</tbody>
      </table></div>
      <div class="card-b" style="border-top:1px solid var(--line)"><div class="hint" style="margin:0">Vote heads are also manageable inline while setting up a Fee Structure (Invoicing tab) — this list is the same data, just easier to review all at once.</div></div>
    </div>
  `;
  function openModal(existing) {
    modal({
      title: existing ? 'Edit Vote Head' : 'Add Vote Head',
      body: `
        <div class="field"><label>Name</label><input id="fa-vh-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Activity Fee"></div>
        <div class="grid2">
          <div class="field"><label>Code (optional)</label><input id="fa-vh-code" value="${esc(existing ? existing.code || '' : '')}"></div>
          <div class="field"><label>Priority</label><input id="fa-vh-priority" type="number" value="${existing ? existing.priority : 100}"></div>
        </div>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fa-vh-name').value.trim();
        if (!name) { toast('Enter a name.', 'err'); return; }
        const res = await Db.finance.voteHeads.save({
          id: existing ? existing.id : undefined, name,
          code: document.getElementById('fa-vh-code').value.trim(),
          priority: document.getElementById('fa-vh-priority').value,
          active: existing ? existing.active : true
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(existing ? 'Vote head updated.' : 'Vote head added.', 'ok');
        await renderVoteHeads(root);
      }
    });
  }
  root.querySelector('#fa-add-votehead').onclick = () => openModal(null);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openModal(voteHeads.find((v) => v.id === b.dataset.edit)));
  root.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
    const v = voteHeads.find((x) => x.id === b.dataset.toggle);
    const willActivate = b.dataset.active === 'false';
    confirmAction(
      willActivate
        ? `"${v.name}" will be selectable again for new invoicing/collections.`
        : `"${v.name}" will no longer be selectable for NEW invoicing or collections. Past transactions under it are untouched.`,
      async () => {
        const res = await Db.finance.voteHeads.save({ id: v.id, name: v.name, code: v.code, priority: v.priority, active: willActivate });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(willActivate ? 'Vote head activated.' : 'Vote head deactivated.', 'ok');
        await renderVoteHeads(root);
      }
    );
  });
}

/* --------------------------------------------------------- Bank Accounts */
async function renderAccounts(root) {
  root.innerHTML = loader();
  const [accountsRes, typesRes] = await Promise.all([Db.finance.accounts.list(), Db.finance.accountTypes.list()]);
  const accountRows = accountsRes.ok ? accountsRes.data : [];
  const accountTypes = typesRes.ok ? typesRes.data : [];
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Bank &amp; Cash Accounts</h3><span class="muted" style="font-size:12px">Where money physically sits, by Account Type</span><button class="btn sm" id="fa-add-account" style="margin-left:auto">+ Add Account</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Type</th><th>Bank</th><th>Account No.</th><th>Branch</th><th>Status</th><th></th></tr></thead>
        <tbody>${accountRows.map((a) => `<tr>
          <td>${esc(a.name)}${a.is_cash ? ' <span class="badge blue">Cash</span>' : ''}</td>
          <td>${esc(a.finance_account_types ? a.finance_account_types.name : '')}</td>
          <td>${esc(a.bank_name || '—')}</td>
          <td>${esc(a.account_number || '—')}</td>
          <td>${esc(a.branch || '—')}</td>
          <td>${statusBadge(a.active)}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn sm ghost" data-edit="${a.id}">Edit</button>
            <button class="btn sm ghost" data-toggle="${a.id}" data-active="${a.active !== false}">${a.active === false ? 'Activate' : 'Deactivate'}</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No accounts yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
  function openModal(existing) {
    if (!accountTypes.length) { toast('Add an Account Type first.', 'err'); return; }
    modal({
      title: existing ? 'Edit Account' : 'Add Account',
      body: `
        <div class="field"><label>Account Type</label><select id="fa-acc-type">${options(accountTypes.filter((t) => t.active !== false || (existing && existing.account_type_id === t.id)), 'id', 'name', existing ? existing.account_type_id : '')}</select></div>
        <div class="field"><label>Account Name</label><input id="fa-acc-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Equity Bank - Main Account, or Petty Cash"></div>
        <label class="chk" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin:6px 0 10px">
          <input type="checkbox" id="fa-acc-cash" ${existing && existing.is_cash ? 'checked' : ''}><span>This is a cash account (not a bank account)</span>
        </label>
        <div id="fa-bank-fields" style="${existing && existing.is_cash ? 'display:none' : ''}">
          <div class="grid2">
            <div class="field"><label>Bank Name</label><input id="fa-acc-bank" value="${esc(existing ? existing.bank_name || '' : '')}"></div>
            <div class="field"><label>Account Number</label><input id="fa-acc-number" value="${esc(existing ? existing.account_number || '' : '')}"></div>
          </div>
          <div class="field"><label>Branch (optional)</label><input id="fa-acc-branch" value="${esc(existing ? existing.branch || '' : '')}"></div>
        </div>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fa-acc-name').value.trim();
        if (!name) { toast('Enter an account name.', 'err'); return; }
        const isCash = document.getElementById('fa-acc-cash').checked;
        // POST-BUILD FEEDBACK item 5 ("it's impossible to have a bank
        // account without a bank name"): Bank Name was only ever LABELED
        // required — nothing stopped an empty string reaching the DB. Only
        // enforced for a genuine bank account; a cash account correctly has
        // none of these fields at all.
        const bankName = document.getElementById('fa-acc-bank').value.trim();
        if (!isCash && !bankName) { toast('Bank Name is required for a bank account.', 'err'); return; }
        const res = await Db.finance.accounts.save({
          id: existing ? existing.id : undefined,
          account_type_id: document.getElementById('fa-acc-type').value,
          name, is_cash: isCash,
          bank_name: isCash ? null : bankName,
          account_number: isCash ? null : document.getElementById('fa-acc-number').value.trim(),
          branch: isCash ? null : document.getElementById('fa-acc-branch').value.trim(),
          active: existing ? existing.active : true
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(existing ? 'Account updated.' : 'Account added.', 'ok');
        await renderAccounts(root);
      },
      onOpen: () => {
        const bankFields = document.getElementById('fa-bank-fields');
        document.getElementById('fa-acc-cash').onchange = (e) => { bankFields.style.display = e.target.checked ? 'none' : ''; };
      }
    });
  }
  root.querySelector('#fa-add-account').onclick = () => openModal(null);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openModal(accountRows.find((a) => a.id === b.dataset.edit)));
  root.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
    const a = accountRows.find((x) => x.id === b.dataset.toggle);
    const willActivate = b.dataset.active === 'false';
    confirmAction(
      willActivate
        ? `"${a.name}" will be selectable again for new payments.`
        : `"${a.name}" will no longer be selectable for NEW collections, expenses or payroll runs. Its past ledger history is untouched.`,
      async () => {
        const res = await Db.finance.accounts.save({
          id: a.id, account_type_id: a.account_type_id, name: a.name, is_cash: a.is_cash,
          bank_name: a.bank_name, account_number: a.account_number, branch: a.branch, active: willActivate
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(willActivate ? 'Account activated.' : 'Account deactivated.', 'ok');
        await renderAccounts(root);
      }
    );
  });
}
