/**
 * financeAccess.mjs — Finance > Access (live feedback: "create access
 * module in finance where the school bursar maybe can add other finance
 * users eg accounts clerk and be able to restrict some operations or
 * modules from him or her, also be able to delete the finance user when
 * needed").
 *
 * Nothing here is a new permission MECHANISM — it's the exact same
 * staff_capabilities grant/revoke that staff.mjs's "Edit staff member"
 * modal already uses for finance_manage_fees/finance_record_collections/
 * finance_clerk (see that file's Access Control section), surfaced as its
 * own screen INSIDE Finance instead of requiring a trip to Teachers and
 * Staff. That matters most for a Finance Clerk bursar (NAV.financeOnly) —
 * their entire sidebar is Finance, so today they have no route to Teachers
 * and Staff at all and no way to bring on an Accounts Clerk themselves.
 *
 * Three things this screen adds on top of what already existed:
 *   1. A list of who currently has ANY finance access, in one place (the
 *      staff-edit modal only ever showed one person's grants at a time).
 *   2. Per-Finance-tab restrictions (deny_finance_students, ...finance_
 *      payroll, etc. — see capabilities.mjs's FINANCE_DENIABLE_TABS) on top
 *      of the existing manage/collect level, so an Accounts Clerk can be
 *      given collections access but kept out of, say, Payroll or Inventory.
 *   3. "Remove from Finance" — revokes every finance-related capability
 *      (base grant + any tab-level denies) in one action. Deliberately
 *      does NOT delete the staff member's account/login (that's a much
 *      bigger, separate action already covered by Teachers and Staff's own
 *      "Delete" button) — this only removes their access to THIS module,
 *      which is what "delete the finance user" means in context here.
 *
 * Gated to access.canManage (same bar as financePreferences.mjs) — a
 * collections-only bursar can use Finance day to day but shouldn't be able
 * to hand a colleague the keys to it.
 */
import { esc, modal, closeModal, toast, confirmAction, options } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { openStaffModal } from './staff.mjs';
import { FINANCE_DENIABLE_TABS } from '../lib/api/capabilities.mjs';

export async function viewFinanceAccess(root, access) {
  if (!access || !access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to manage Finance access — ask your school admin for full Finance access ("Finance: manage fees").</div>`;
    return;
  }
  await render(root);
}

function levelLabel(caps) {
  if (caps.indexOf('finance_manage_fees') !== -1) return 'Full access';
  if (caps.indexOf('finance_record_collections') !== -1) return 'Collections & viewing only';
  return 'None'; // shouldn't happen — listFinanceUsers only returns staff with at least one — defensive only
}

function restrictedTabsLabel(caps) {
  const blocked = FINANCE_DENIABLE_TABS.filter((m) => caps.indexOf(m.key) !== -1);
  if (!blocked.length) return '<span class="muted">None</span>';
  return blocked.map((m) => `<span class="badge grey" style="margin:2px 4px 2px 0">${esc(m.label)}</span>`).join('');
}

async function render(root) {
  const [usersRes, staffRes] = await Promise.all([Db.capabilities.listFinanceUsers(), Db.staff.list()]);
  const users = usersRes.ok ? usersRes.data : [];
  const allStaff = staffRes.ok ? staffRes.data : [];
  const financeStaffIds = users.map((u) => u.staff.id);

  root.innerHTML = `
    <div class="page-head"><div><h2>Finance Access</h2><p>Who can use Finance, and what they can do inside it.</p></div>
      <div class="spacer"></div><button class="btn" id="fa-add">+ Add finance user</button></div>
    <div class="card side-accent tile-indigo">
      ${users.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Role</th><th>Finance access</th><th>Blocked tabs</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td>${esc(u.staff.full_name)}</td>
          <td>${esc(u.staff.role || '—')}</td>
          <td>${esc(levelLabel(u.capabilities))}${u.capabilities.indexOf('finance_clerk') !== -1 ? ' <span class="badge blue" style="margin-left:4px">Finance Clerk</span>' : ''}</td>
          <td>${restrictedTabsLabel(u.capabilities)}</td>
          <td class="row-actions">
            <button class="btn sm secondary" data-edit="${u.staff.id}">Edit access</button>
            <button class="btn sm danger" data-remove="${u.staff.id}">Remove from Finance</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>` : `<div class="card-b"><div class="empty">
        <div class="e-ico">🔐</div><h3>No finance users yet</h3><p>Add a bursar or accounts clerk to give them access to Finance.</p>
        <button class="btn" id="fa-empty-add">+ Add finance user</button>
      </div></div>`}
    </div>
  `;

  const openAdd = () => openAddUserModal(root, allStaff, financeStaffIds);
  root.querySelector('#fa-add').onclick = openAdd;
  const emptyAdd = root.querySelector('#fa-empty-add');
  if (emptyAdd) emptyAdd.onclick = openAdd;

  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.staff.id === b.dataset.edit);
    if (u) openAccessModal(root, u.staff, u.capabilities);
  });
  root.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.staff.id === b.dataset.remove);
    if (!u) return;
    confirmAction(
      `Remove ${u.staff.full_name} from Finance? They'll lose all Finance access (collections, invoicing, reports, etc.) — their staff account and login stay exactly as they are.`,
      async () => {
        for (const cap of u.capabilities) {
          const r = await Db.capabilities.revoke(u.staff.id, cap);
          if (!r.ok) { toast(r.message, 'err'); return; }
        }
        toast('Removed from Finance.', 'ok');
        render(root);
      },
      true
    );
  });
}

/** Search-and-pick from existing staff not already in Finance, or jump
 *  straight into staff.mjs's own "Add staff member" form for someone who
 *  isn't in the system at all yet — either path lands on openAccessModal()
 *  next so their Finance permissions get set in the very same flow. */
function openAddUserModal(root, allStaff, financeStaffIds) {
  const candidates = allStaff.filter((s) => financeStaffIds.indexOf(s.id) === -1);
  modal({
    title: 'Add finance user',
    body: `
      <p class="hint" style="margin-top:0">Give an existing staff member access to Finance, or add someone new first.</p>
      ${candidates.length ? `
      <div class="field"><label>Staff member</label>
        <select id="fa-pick-staff">${options(candidates, 'id', 'full_name', '', 'Choose a staff member…')}</select>
      </div>` : `<p class="muted">Every current staff member already has some level of Finance access.</p>`}
      <div style="margin-top:12px;text-align:center">
        <button class="btn secondary sm" id="fa-new-staff">+ This person isn't in the system yet — add them as staff first</button>
      </div>
    `,
    okLabel: candidates.length ? 'Continue' : '',
    onOk: candidates.length ? async () => {
      const staffId = document.getElementById('fa-pick-staff').value;
      if (!staffId) { toast('Choose a staff member.', 'err'); return; }
      const chosen = candidates.find((s) => s.id === staffId);
      closeModal();
      openAccessModal(root, chosen, []);
    } : undefined
  });
  document.getElementById('fa-new-staff').onclick = () => {
    closeModal();
    // openStaffModal's onSaved now receives the saved staff row (see
    // staff.mjs) — used here to jump straight to setting THEIR Finance
    // permissions without making the admin hunt for the new name in a list.
    openStaffModal(root, undefined, (savedStaff) => {
      if (savedStaff) openAccessModal(root, savedStaff, []);
      else render(root);
    });
  };
}

/** The actual grant/revoke editor for one staff member's Finance access —
 *  level (collections-only vs. full manage), the Finance Clerk sidebar
 *  flag, and which of Finance's own tabs to block for them specifically.
 *  currentCaps is whatever capabilities.mjs's listFinanceUsers()/
 *  listForStaff() already found for them (empty array for a brand-new
 *  finance user). */
function openAccessModal(root, staff, currentCaps) {
  currentCaps = currentCaps || [];
  const hadManage = currentCaps.indexOf('finance_manage_fees') !== -1;
  const hadCollect = currentCaps.indexOf('finance_record_collections') !== -1;
  const hadClerk = currentCaps.indexOf('finance_clerk') !== -1;

  modal({
    title: `Finance access — ${staff.full_name}`,
    wide: true,
    body: `
      <p class="hint" style="margin-top:0">Choose what ${esc(staff.full_name)} can do in Finance, then optionally block specific sections.</p>
      <div class="field"><label class="chk"><input type="radio" name="fa-level" id="fa-level-collect" ${!hadManage ? 'checked' : ''}> Collections &amp; viewing only — record payments, view balances/statements/reports</label></div>
      <div class="field"><label class="chk"><input type="radio" name="fa-level" id="fa-level-manage" ${hadManage ? 'checked' : ''}> Full access — also manage fee structures, invoices &amp; credit/debit notes</label></div>
      <div class="field" style="margin-top:10px"><label class="chk"><input type="checkbox" id="fa-clerk" ${hadClerk ? 'checked' : ''}> Finance Clerk — this person's ENTIRE sidebar becomes Finance; they won't see Dashboard, Exams, Students, or anything else</label>
        <div class="hint" style="margin-left:26px">Good for a dedicated Accounts Clerk who should never need the rest of the school system.</div></div>
      <details open style="margin-top:14px">
        <summary style="cursor:pointer;font-weight:600;font-size:13px">Restrict specific Finance sections (optional)</summary>
        <div style="margin-top:8px">
          <p class="muted" style="margin:0 0 8px;font-size:12.5px">They'll see every Finance tab their access level above allows by default. Check a box to hide that ONE tab for them specifically — e.g. an Accounts Clerk who should never touch Payroll.</p>
          ${FINANCE_DENIABLE_TABS.map((m) => `<div class="field"><label class="chk"><input type="checkbox" data-fa-deny="${m.key}" ${currentCaps.indexOf(m.key) !== -1 ? 'checked' : ''}> Block ${esc(m.label)}</label></div>`).join('')}
        </div>
      </details>
    `,
    okLabel: 'Save access',
    onOk: async () => {
      const wantsManage = document.getElementById('fa-level-manage').checked;
      // Exclusive level, same reasoning as the module header comment:
      // finance_can_collect() on the database side already treats
      // finance_manage_fees as a superset of collection rights, so there's
      // never a need for both grants to coexist — keep exactly one.
      if (wantsManage) {
        if (!hadManage) { const r = await Db.capabilities.grant(staff.id, 'finance_manage_fees'); if (!r.ok) { toast(r.message, 'err'); return; } }
        if (hadCollect) { const r = await Db.capabilities.revoke(staff.id, 'finance_record_collections'); if (!r.ok) { toast(r.message, 'err'); return; } }
      } else {
        if (hadManage) { const r = await Db.capabilities.revoke(staff.id, 'finance_manage_fees'); if (!r.ok) { toast(r.message, 'err'); return; } }
        if (!hadCollect) { const r = await Db.capabilities.grant(staff.id, 'finance_record_collections'); if (!r.ok) { toast(r.message, 'err'); return; } }
      }

      const wantsClerk = document.getElementById('fa-clerk').checked;
      if (wantsClerk !== hadClerk) {
        const r = wantsClerk ? await Db.capabilities.grant(staff.id, 'finance_clerk') : await Db.capabilities.revoke(staff.id, 'finance_clerk');
        if (!r.ok) { toast(r.message, 'err'); return; }
      }

      for (const m of FINANCE_DENIABLE_TABS) {
        const box = document.querySelector(`[data-fa-deny="${m.key}"]`);
        const wantsDenied = !!(box && box.checked);
        const currentlyDenied = currentCaps.indexOf(m.key) !== -1;
        if (wantsDenied !== currentlyDenied) {
          const r = wantsDenied ? await Db.capabilities.grant(staff.id, m.key) : await Db.capabilities.revoke(staff.id, m.key);
          if (!r.ok) { toast(r.message, 'err'); return; }
        }
      }

      closeModal();
      toast('Finance access saved.', 'ok');
      render(root);
    }
  });
}
