import { esc, modal, closeModal, toast, confirmAction, options, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { DENIABLE_MODULES } from '../lib/api/capabilities.mjs';

export const JOB_TITLES = ['Teacher', 'Head Teacher', 'Deputy Head Teacher', 'Bursar', 'Support Staff'];

// Bug fix (feature brief §9.1): a teacher was showing up under BOTH
// Teachers and Staff — a teacher isn't a Staff member in this app's
// structure, the two lists are meant to be kept separate (same isTeacher()
// rule teachers.mjs already uses to decide what belongs on ITS list).
function isTeacher(s) {
  return String(s.role || '').toLowerCase() === 'teacher';
}

export async function viewStaff(root) {
  await render(root);
}

async function render(root) {
  const [res, usersRes] = await Promise.all([Db.staff.list(), Db.users.list()]);
  const staff = (res.ok ? res.data : []).filter((s) => !isTeacher(s));
  // Login account per staff member, for the reset-password/enable-disable
  // actions below — those moved here from the old, now-admin-only "User
  // Accounts" screen (see userAccounts.mjs), so managing a staff member's
  // login lives right next to everything else about that person.
  const profileByStaffId = {};
  (usersRes.ok ? usersRes.data : []).forEach((u) => { if (u.staff_id) profileByStaffId[u.staff_id] = u; });

  root.innerHTML = `
    <div class="page-head"><div><h2>Staff</h2><p>Teachers and other staff members, and who has admin access.</p></div>
      <div class="spacer"></div><button class="btn" id="add-staff">+ Add staff</button></div>
    <div class="card side-accent tile-green">
      ${staff.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Phone</th><th>Status</th><th></th></tr></thead>
        <tbody>${staff.map((s) => {
          const profile = profileByStaffId[s.id];
          return `<tr>
          <td>${esc(s.full_name)}</td><td>${esc(s.email)}</td><td>${esc(s.role)}</td><td>${esc(s.phone || '—')}</td>
          <td><span class="badge ${s.status === 'active' ? 'green' : 'grey'}">${esc(s.status)}</span></td>
          <td class="row-actions">
            ${profile ? `<button class="icon-btn" data-reset="${profile.id}" title="Reset password">🔑</button>
            <button class="icon-btn" data-toggle="${profile.id}" data-status="${profile.status}" title="${profile.status === 'active' ? 'Disable login' : 'Enable login'}">${profile.status === 'active' ? '🚫' : '✅'}</button>` : ''}
            <button class="btn sm secondary" data-edit="${s.id}">Edit</button>
            <button class="btn sm danger" data-del="${s.id}">Delete</button>
          </td></tr>`;
        }).join('')}</tbody>
      </table></div>` : `<div class="card-b"><div class="empty">
        <div class="e-ico">👨‍🏫</div><h3>No staff yet</h3><p>Add your first teacher or staff member.</p>
        <button class="btn" id="empty-add-staff">+ Add staff</button>
      </div></div>`}
    </div>`;

  root.querySelector('#add-staff').onclick = () => openAddChoiceModal(root);
  const emptyBtn = root.querySelector('#empty-add-staff');
  if (emptyBtn) emptyBtn.onclick = () => openAddChoiceModal(root);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openStaffModal(root, staff.find((s) => s.id === b.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction('Remove this staff member?', async () => {
    const r = await Db.staff.remove(b.dataset.del);
    if (r.ok) { toast('Staff member removed.', 'ok'); render(root); } else toast(r.message, 'err');
  }, true));
  root.querySelectorAll('[data-reset]').forEach((b) => b.onclick = () => confirmAction(
    'Reset this person\'s password to the default (they can change it after signing in)?',
    async () => {
      const r = await Db.users.resetPassword(b.dataset.reset);
      if (r.ok) toast(r.defaultPassword ? `Password reset — new default: ${r.defaultPassword}` : 'Password reset.', 'ok');
      else toast(r.message, 'err');
    }
  ));
  root.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
    const nextStatus = b.dataset.status === 'active' ? 'inactive' : 'active';
    confirmAction(`${nextStatus === 'inactive' ? 'Disable' : 'Enable'} this person's login?`, async () => {
      const r = await Db.users.setLoginStatus(b.dataset.toggle, nextStatus);
      if (r.ok) { toast('Login updated.', 'ok'); render(root); } else toast(r.message, 'err');
    }, nextStatus === 'inactive');
  });
}

/** "+ Add staff" asks Single vs Bulk first, same pattern as "+ Add student"
 *  (students.mjs's openAddChoiceModal) — Round 2 §5: "Add bulk upload for
 *  Teachers/Staff, matching the bulk upload capability that already exists
 *  for Students." Editing an existing staff member always uses the single
 *  form directly (see the [data-edit] handler above), so this only gates
 *  the "add new" entry point. */
export function openAddChoiceModal(root, onSaved) {
  modal({
    title: 'Add staff',
    body: `
      <p class="hint" style="margin-top:0">How would you like to add staff?</p>
      <div class="grid2">
        <button class="btn secondary" id="staff-choice-single" style="width:100%;padding:18px 12px;flex-direction:column;height:auto;gap:6px">
          <div style="font-size:22px">🧑‍🏫</div><div>Single staff member</div>
        </button>
        <button class="btn secondary" id="staff-choice-bulk" style="width:100%;padding:18px 12px;flex-direction:column;height:auto;gap:6px">
          <div style="font-size:22px">📥</div><div>Bulk upload</div>
        </button>
      </div>
    `,
    footer: false
  });
  document.getElementById('staff-choice-single').onclick = () => { closeModal(); openStaffModal(root, undefined, onSaved); };
  document.getElementById('staff-choice-bulk').onclick = () => { closeModal(); go('staff-bulk-upload'); };
}

/** onSaved: optional callback run after a successful save instead of this
 *  module's own flat-table render — lets other screens (e.g. teachers.mjs's
 *  card grid) reuse this same form without being redirected back to the
 *  Staff list. Defaults to re-rendering the Staff screen itself. */
export async function openStaffModal(root, existing, onSaved) {
  onSaved = onSaved || (() => render(root));
  const titleChoices = JOB_TITLES.map((t) => ({ id: t, name: t }));
  let canPublish = false;
  let canFinanceCollect = false;
  let canFinanceManage = false;
  // SignUp_Fixes §5: which modules THIS staff member is currently blocked
  // from (deny_* rows) — everything not listed here they get by default.
  let deniedModules = [];
  if (existing) {
    const capsRes = await Db.capabilities.listForStaff(existing.id);
    const caps = capsRes.ok ? capsRes.data : [];
    canPublish = caps.indexOf('publish_results') !== -1;
    canFinanceCollect = caps.indexOf('finance_record_collections') !== -1;
    canFinanceManage = caps.indexOf('finance_manage_fees') !== -1;
    deniedModules = caps.filter((c) => c.indexOf('deny_') === 0);
  }
  modal({
    title: existing ? 'Edit staff member' : 'Add staff member',
    body: `
      ${existing ? `<div class="field"><label>Full name</label><input id="sf-name" value="${esc(existing.full_name)}"></div>` : `
      <div class="grid2">
        <div class="field"><label>First name</label><input id="sf-fname" placeholder="e.g. Jane"></div>
        <div class="field"><label>Last name</label><input id="sf-lname" placeholder="e.g. Wanjiru"></div>
      </div>`}
      <div class="grid2">
        <div class="field"><label>Phone${existing ? '' : ' (required — used to sign in)'}</label><input id="sf-phone" value="${esc(existing ? existing.phone || '' : '')}"></div>
        <div class="field"><label>Email (optional, contact only)</label><input id="sf-email" type="email" value="${esc(existing ? existing.email : '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Job title</label><select id="sf-role">${options(titleChoices, 'id', 'name', existing ? existing.role : 'Teacher')}</select></div>
        <div class="field"><label>Gender</label><select id="sf-gender">${options([{ id: 'Male', name: 'Male' }, { id: 'Female', name: 'Female' }], 'id', 'name', existing ? existing.gender : '', 'Choose gender')}</select></div>
      </div>
      <div class="field"><label>Qualifications (optional)</label><input id="sf-qual" value="${esc(existing ? existing.qualifications || '' : '')}"></div>
      <details style="margin-top:4px">
        <summary style="cursor:pointer;font-weight:600;font-size:13px">More details (optional)</summary>
        <div style="margin-top:10px">
          <div class="grid2">
            <div class="field"><label>Date of birth</label><input id="sf-dob" type="date" value="${esc(existing ? existing.date_of_birth || '' : '')}"></div>
            <div class="field"><label>National ID number</label><input id="sf-national-id" value="${esc(existing ? existing.national_id || '' : '')}"></div>
          </div>
          <div class="field"><label>TSC number</label><input id="sf-tsc" value="${esc(existing ? existing.tsc_number || '' : '')}"></div>
          <div class="grid2">
            <div class="field"><label>Next of kin name</label><input id="sf-kin-name" value="${esc(existing ? existing.next_of_kin_name || '' : '')}"></div>
            <div class="field"><label>Next of kin contact</label><input id="sf-kin-contact" value="${esc(existing ? existing.next_of_kin_contact || '' : '')}"></div>
          </div>
        </div>
      </details>
      ${existing ? `<div class="field"><label class="chk"><input type="checkbox" id="sf-publish" ${canPublish ? 'checked' : ''}> Can publish exam results (final step of the approval workflow)</label></div>` : ''}
      ${existing ? `<div class="field"><label class="chk"><input type="checkbox" id="sf-finance-collect" ${canFinanceCollect ? 'checked' : ''}> Finance: can record collections &amp; view statements</label></div>` : ''}
      ${existing ? `<div class="field"><label class="chk"><input type="checkbox" id="sf-finance-manage" ${canFinanceManage ? 'checked' : ''}> Finance: can manage fees, invoices &amp; credit/debit notes</label></div>` : ''}
      ${existing ? `
      <details style="margin-top:4px">
        <summary style="cursor:pointer;font-weight:600;font-size:13px">Access Control — block modules (optional)</summary>
        <div style="margin-top:8px">
          <p class="muted" style="margin:0 0 8px;font-size:12.5px">This staff member sees every module above by default (unless it's an admin login, which always sees everything). Check a box below to block them from that specific module — e.g. a bursar who should only use Finance.</p>
          ${DENIABLE_MODULES.map((m) => `<div class="field"><label class="chk"><input type="checkbox" data-deny-module="${m.key}" ${deniedModules.indexOf(m.key) !== -1 ? 'checked' : ''}> Block access to ${esc(m.label)}</label></div>`).join('')}
        </div>
      </details>` : ''}
      ${existing ? '' : `<div class="field"><label class="chk"><input type="checkbox" id="sf-admin"> Grant admin (full) access, not just teacher access</label></div>`}
    `,
    okLabel: 'Save',
    onOk: async () => {
      // New teachers/staff only (existing logins/records are untouched):
      // First/Last Name are separate inputs for a cleaner add-form, but the
      // `full_name` column is unchanged — they're just concatenated here.
      // Phone is required for a new record since it's now how they sign in
      // (see the "First time here?" phone-verified password-set flow).
      if (!existing) {
        const fname = document.getElementById('sf-fname').value.trim();
        const lname = document.getElementById('sf-lname').value.trim();
        if (!fname || !lname) { toast('Please enter both first and last name.', 'err'); return; }
        if (!document.getElementById('sf-phone').value.trim()) { toast('Phone number is required — it\'s how this person will sign in.', 'err'); return; }
      }
      const payload = {
        id: existing ? existing.id : undefined,
        full_name: existing ? document.getElementById('sf-name').value
          : `${document.getElementById('sf-fname').value.trim()} ${document.getElementById('sf-lname').value.trim()}`.trim(),
        email: document.getElementById('sf-email').value,
        phone: document.getElementById('sf-phone').value,
        role: document.getElementById('sf-role').value,
        gender: document.getElementById('sf-gender').value || null,
        qualifications: document.getElementById('sf-qual').value,
        date_of_birth: document.getElementById('sf-dob').value || null,
        national_id: document.getElementById('sf-national-id').value,
        tsc_number: document.getElementById('sf-tsc').value,
        next_of_kin_name: document.getElementById('sf-kin-name').value,
        next_of_kin_contact: document.getElementById('sf-kin-contact').value
      };
      const res = await Db.staff.save(payload);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      if (!existing) {
        const isAdmin = document.getElementById('sf-admin') && document.getElementById('sf-admin').checked;
        const prov = await Db.users.provisionStaffLogin({
          staff_id: res.data.id, full_name: res.data.full_name, role: isAdmin ? 'admin' : 'teacher', phone: res.data.phone
        });
        if (prov && prov.ok && prov.username) {
          // Round 2 (Item 2): no more sharing a single static default
          // password out loud — the teacher sets their own via "First time
          // here?" on the login screen (phone-verified, same flow as
          // Forgot Password), so nothing sensitive needs to be read out or
          // written down here.
          toast('Staff saved. Ask them to sign in and tap "First time here?" using their phone number to set a password.', 'ok');
        } else {
          toast('Staff saved. (Login provisioning will be available once the Netlify function is deployed.)', 'warn');
        }
      } else {
        const wantsPublish = document.getElementById('sf-publish') && document.getElementById('sf-publish').checked;
        if (wantsPublish !== canPublish) {
          const capRes = wantsPublish
            ? await Db.capabilities.grant(existing.id, 'publish_results')
            : await Db.capabilities.revoke(existing.id, 'publish_results');
          if (!capRes.ok) toast(capRes.message, 'err');
        }
        const wantsFinanceCollect = document.getElementById('sf-finance-collect') && document.getElementById('sf-finance-collect').checked;
        if (wantsFinanceCollect !== canFinanceCollect) {
          const capRes = wantsFinanceCollect
            ? await Db.capabilities.grant(existing.id, 'finance_record_collections')
            : await Db.capabilities.revoke(existing.id, 'finance_record_collections');
          if (!capRes.ok) toast(capRes.message, 'err');
        }
        const wantsFinanceManage = document.getElementById('sf-finance-manage') && document.getElementById('sf-finance-manage').checked;
        if (wantsFinanceManage !== canFinanceManage) {
          const capRes = wantsFinanceManage
            ? await Db.capabilities.grant(existing.id, 'finance_manage_fees')
            : await Db.capabilities.revoke(existing.id, 'finance_manage_fees');
          if (!capRes.ok) toast(capRes.message, 'err');
        }
        // SignUp_Fixes §5: Access Control's module-block checkboxes — each
        // is its own independent deny_* capability, same grant/revoke calls
        // as every other checkbox above, just inverted (checked = blocked).
        for (const m of DENIABLE_MODULES) {
          const box = document.querySelector(`[data-deny-module="${m.key}"]`);
          const wantsDenied = !!(box && box.checked);
          const currentlyDenied = deniedModules.indexOf(m.key) !== -1;
          if (wantsDenied !== currentlyDenied) {
            const capRes = wantsDenied
              ? await Db.capabilities.grant(existing.id, m.key)
              : await Db.capabilities.revoke(existing.id, m.key);
            if (!capRes.ok) toast(capRes.message, 'err');
          }
        }
        toast('Staff saved.', 'ok');
      }
      onSaved();
    }
  });
}
