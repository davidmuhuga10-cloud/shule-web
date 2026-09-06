/**
 * financeAccounting.mjs — Finance Expansion brief item 2 ("Accounting
 * Module"): Account Types, Vote Heads, and Accounts (bank/cash) in one
 * simple screen — three plain list+add cards, no sub-navigation, per the
 * brief's own "keep it simple" framing throughout.
 *
 * Vote Heads already existed (migrations/0031) and were only ever
 * manageable inline from the fee-structure modal — this gives them the
 * dedicated screen the brief asks for ("look at where it is and map it
 * here now"), without changing what a vote head IS or how invoicing uses
 * it. Account Types and Accounts are genuinely new (migrations/0050).
 */
import { esc, toast, modal, confirmAction, options } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewFinanceAccounting(root, access) {
  if (!access || !access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to manage Accounting — ask your school admin for full Finance access.</div>`;
    return;
  }
  await load(root, access);
}

async function load(root, access) {
  root.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  const [typesRes, accountsRes, voteHeadsRes] = await Promise.all([
    Db.finance.accountTypes.list(), Db.finance.accounts.list(), Db.finance.voteHeads.list()
  ]);
  const accountTypes = typesRes.ok ? typesRes.data : [];
  const accountRows = accountsRes.ok ? accountsRes.data : [];
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  render(root, access, accountTypes, accountRows, voteHeads);
}

function render(root, access, accountTypes, accountRows, voteHeads) {
  root.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Account Types</h3><button class="btn sm" id="fa-add-type" style="margin-left:auto">+ Add Account Type</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Default</th></tr></thead>
        <tbody>${accountTypes.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.is_default ? '<span class="badge green">School Fund (default)</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No account types yet.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Accounts</h3><span class="muted" style="font-size:12px">Bank and cash accounts, by type</span><button class="btn sm" id="fa-add-account" style="margin-left:auto">+ Add Account</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Type</th><th>Bank</th><th>Account No.</th><th>Branch</th></tr></thead>
        <tbody>${accountRows.map((a) => `<tr>
          <td>${esc(a.name)}${a.is_cash ? ' <span class="badge blue">Cash</span>' : ''}</td>
          <td>${esc(a.finance_account_types ? a.finance_account_types.name : '')}</td>
          <td>${esc(a.bank_name || '—')}</td>
          <td>${esc(a.account_number || '—')}</td>
          <td>${esc(a.branch || '—')}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No accounts yet.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-h"><h3>Vote Heads</h3><span class="muted" style="font-size:12px">What fees are for — used across Invoicing &amp; Collections</span><button class="btn sm" id="fa-add-votehead" style="margin-left:auto">+ Add Vote Head</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Code</th><th>Priority</th><th>Status</th></tr></thead>
        <tbody>${voteHeads.map((v) => `<tr>
          <td>${esc(v.name)}</td><td>${esc(v.code || '—')}</td><td>${v.priority}</td>
          <td>${v.active === false ? '<span class="badge amber">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">No vote heads yet.</td></tr>'}</tbody>
      </table></div>
      <div class="card-b" style="border-top:1px solid var(--line)"><div class="hint" style="margin:0">Vote heads are also manageable inline while setting up a Fee Structure (Invoicing tab) — this list is the same data, just easier to review all at once.</div></div>
    </div>
  `;

  root.querySelector('#fa-add-type').onclick = () => {
    modal({
      title: 'Add Account Type', body: `<div class="field"><label>Name</label><input id="fa-type-name" placeholder="e.g. Activity Fund, Building Fund"></div>`,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fa-type-name').value.trim();
        if (!name) { toast('Enter a name.', 'err'); return; }
        const res = await Db.finance.accountTypes.save({ name });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast('Account type added.', 'ok');
        await load(root, access);
      }
    });
  };

  root.querySelector('#fa-add-account').onclick = () => {
    if (!accountTypes.length) { toast('Add an Account Type first.', 'err'); return; }
    modal({
      title: 'Add Account',
      body: `
        <div class="field"><label>Account Type</label><select id="fa-acc-type">${options(accountTypes.filter((t) => t.active !== false), 'id', 'name')}</select></div>
        <div class="field"><label>Account Name</label><input id="fa-acc-name" placeholder="e.g. Equity Bank - Main Account, or Petty Cash"></div>
        <label class="chk" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin:6px 0 10px">
          <input type="checkbox" id="fa-acc-cash"><span>This is a cash account (not a bank account)</span>
        </label>
        <div id="fa-bank-fields">
          <div class="grid2">
            <div class="field"><label>Bank Name</label><input id="fa-acc-bank"></div>
            <div class="field"><label>Account Number</label><input id="fa-acc-number"></div>
          </div>
          <div class="field"><label>Branch (optional)</label><input id="fa-acc-branch"></div>
        </div>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fa-acc-name').value.trim();
        if (!name) { toast('Enter an account name.', 'err'); return; }
        const isCash = document.getElementById('fa-acc-cash').checked;
        const res = await Db.finance.accounts.save({
          account_type_id: document.getElementById('fa-acc-type').value,
          name, is_cash: isCash,
          bank_name: isCash ? null : document.getElementById('fa-acc-bank').value,
          account_number: isCash ? null : document.getElementById('fa-acc-number').value,
          branch: isCash ? null : document.getElementById('fa-acc-branch').value
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast('Account added.', 'ok');
        await load(root, access);
      },
      onOpen: () => {
        const bankFields = document.getElementById('fa-bank-fields');
        document.getElementById('fa-acc-cash').onchange = (e) => { bankFields.style.display = e.target.checked ? 'none' : ''; };
      }
    });
  };

  root.querySelector('#fa-add-votehead').onclick = () => {
    modal({
      title: 'Add Vote Head', body: `<div class="field"><label>Name</label><input id="fa-vh-name" placeholder="e.g. Activity Fee"></div>`,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fa-vh-name').value.trim();
        if (!name) { toast('Enter a name.', 'err'); return; }
        const res = await Db.finance.voteHeads.save({ name });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast('Vote head added.', 'ok');
        await load(root, access);
      }
    });
  };
}
