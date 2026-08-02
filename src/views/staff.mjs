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

function openStaffModal(root, existing) {
  const titleChoices = JOB_TITLES.map((t) => ({ id: t, name: t }));
  modal({
    title: existing ? 'Edit staff member' : 'Add staff member',
    body: `
      <div class="field"><label>Full name</label><input id="sf-name" value="${esc(existing ? existing.full_name : '')}"></div>
      <div class="grid2">
        <div class="field"><label>Email (used to sign in)</label><input id="sf-email" type="email" value="${esc(existing ? existing.email : '')}"></div>
        <div class="field"><label>Phone</label><input id="sf-phone" value="${esc(existing ? existing.phone || '' : '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Job title</label><select id="sf-role">${options(titleChoices, 'id', 'name', existing ? existing.role : 'Teacher')}</select></div>
        <div class="field"><label>Gender</label><select id="sf-gender">${options([{ id: 'Male', name: 'Male' }, { id: 'Female', name: 'Female' }], 'id', 'name', existing ? existing.gender : '', 'Choose gender')}</select></div>
      </div>
      <div class="field"><label>Qualifications (optional)</label><input id="sf-qual" value="${esc(existing ? existing.qualifications || '' : '')}"></div>
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
        qualifications: document.getElementById('sf-qual').value
      };
      const res = await Db.staff.save(payload);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      if (!existing) {
        const isAdmin = document.getElementById('sf-admin') && document.getElementById('sf-admin').checked;
        const prov = await Db.users.provisionStaffLogin({
          staff_id: res.data.id, email: res.data.email, full_name: res.data.full_name, role: isAdmin ? 'admin' : 'teacher'
        });
        if (prov && prov.ok && prov.defaultPassword) {
          toast(`Staff saved. Login created — default password: ${prov.defaultPassword}`, 'ok');
        } else {
          toast('Staff saved. (Login provisioning will be available once the Netlify function is deployed.)', 'warn');
        }
      } else {
        toast('Staff saved.', 'ok');
      }
      render(root);
    }
  });
}
