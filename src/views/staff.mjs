import { esc, modal, closeModal, toast, confirmAction, options } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const JOB_TITLES = ['Teacher', 'Head Teacher', 'Deputy Head Teacher', 'Bursar', 'Support Staff'];

export async function viewStaff(root) {
  await render(root);
}

async function render(root) {
  const res = await Db.staff.list();
  const staff = res.ok ? res.data : [];

  root.innerHTML = `
    <div class="page-head"><div><h2>Staff</h2><p>Teachers and other staff members, and who has admin access.</p></div>
      <div class="spacer"></div><button class="btn" id="add-staff">+ Add staff</button></div>
    <div class="card">
      ${staff.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Phone</th><th>Status</th><th></th></tr></thead>
        <tbody>${staff.map((s) => `<tr>
          <td>${esc(s.full_name)}</td><td>${esc(s.email)}</td><td>${esc(s.role)}</td><td>${esc(s.phone || '—')}</td>
          <td><span class="badge ${s.status === 'active' ? 'green' : 'grey'}">${esc(s.status)}</span></td>
          <td class="row-actions">
            <button class="icon-btn" data-edit="${s.id}">✏️</button>
            <button class="icon-btn danger" data-del="${s.id}">🗑️</button>
          </td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="card-b"><div class="empty">
        <div class="e-ico">👨‍🏫</div><h3>No staff yet</h3><p>Add your first teacher or staff member.</p>
        <button class="btn" id="empty-add-staff">+ Add staff</button>
      </div></div>`}
    </div>`;

  root.querySelector('#add-staff').onclick = () => openStaffModal(root);
  const emptyBtn = root.querySelector('#empty-add-staff');
  if (emptyBtn) emptyBtn.onclick = () => openStaffModal(root);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openStaffModal(root, staff.find((s) => s.id === b.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction('Remove this staff member?', async () => {
    const r = await Db.staff.remove(b.dataset.del);
    if (r.ok) { toast('Staff member removed.', 'ok'); render(root); } else toast(r.message, 'err');
  }, true));
}

/** onSaved: optional callback run after a successful save instead of this
 *  module's own flat-table render — lets other screens (e.g. teachers.mjs's
 *  card grid) reuse this same form without being redirected back to the
 *  Staff list. Defaults to re-rendering the Staff screen itself. */
export async function openStaffModal(root, existing, onSaved) {
  onSaved = onSaved || (() => render(root));
  const titleChoices = JOB_TITLES.map((t) => ({ id: t, name: t }));
  let canPublish = false;
  if (existing) {
    const capsRes = await Db.capabilities.listForStaff(existing.id);
    canPublish = capsRes.ok && capsRes.data.indexOf('publish_results') !== -1;
  }
  modal({
    title: existing ? 'Edit staff member' : 'Add staff member',
    body: `
      <div class="field"><label>Full name</label><input id="sf-name" value="${esc(existing ? existing.full_name : '')}"></div>
      <div class="grid2">
        <div class="field"><label>Phone${existing ? '' : ' (used to sign in, along with a username)'}</label><input id="sf-phone" value="${esc(existing ? existing.phone || '' : '')}"></div>
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
      ${existing ? '' : `<div class="field"><label class="chk"><input type="checkbox" id="sf-admin"> Grant admin (full) access, not just teacher access</label></div>`}
    `,
    okLabel: 'Save',
    onOk: async () => {
      const payload = {
        id: existing ? existing.id : undefined,
        full_name: document.getElementById('sf-name').value,
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
          toast(`Staff saved. Login created — username: ${prov.username}, default password: ${prov.defaultPassword}`, 'ok');
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
        toast('Staff saved.', 'ok');
      }
      onSaved();
    }
  });
}
