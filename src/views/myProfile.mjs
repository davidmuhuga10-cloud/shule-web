/**
 * myProfile.mjs — "My Profile" (teacher role, Next Sprint 2 §11): lets the
 * signed-in teacher update their OWN personal details (phone number,
 * gender, date of birth, national ID, next of kin) without needing an
 * admin. Deliberately a narrow set of fields — role, status, employment
 * dates, TSC number and email/login stay admin-only, exactly as before
 * (see staff_update_own_profile() in schema.sql, which is the only write
 * path this screen goes through and physically can't touch anything else).
 */
import { esc, toast, loader, state, withBusy, renderPrereqOrConnectivity } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewMyProfile(root) {
  const staffId = state.profile && state.profile.staff_id;
  if (!staffId) {
    root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No staff profile linked</h3><p>Your login isn't linked to a staff record, so there's no profile to show. Ask an admin to check your account.</p></div></div></div>`;
    return;
  }
  root.innerHTML = loader();
  const res = await Db.staff.get(staffId);
  if (!res.ok) { renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewMyProfile(root) }); return; }
  const s = res.data;

  root.innerHTML = `
    <div class="page-head"><div><h2>My Profile</h2><p>Update your own contact details. For your name, role, or login, ask an admin.</p></div></div>
    <div class="card pad">
      <div class="grid2">
        <div class="field"><label>Full name</label><input value="${esc(s.full_name)}" disabled></div>
        <div class="field"><label>Role</label><input value="${esc(s.role)}" disabled></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Phone number</label><input id="mp-phone" type="tel" value="${esc(s.phone || '')}" placeholder="e.g. 0712345678"></div>
        <div class="field"><label>Gender</label><select id="mp-gender">
          <option value="">— Not set —</option>
          <option value="Male" ${s.gender === 'Male' ? 'selected' : ''}>Male</option>
          <option value="Female" ${s.gender === 'Female' ? 'selected' : ''}>Female</option>
        </select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Date of birth</label><input id="mp-dob" type="date" value="${esc(s.date_of_birth || '')}"></div>
        <div class="field"><label>National ID</label><input id="mp-nid" value="${esc(s.national_id || '')}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Next of kin — name</label><input id="mp-kin-name" value="${esc(s.next_of_kin_name || '')}"></div>
        <div class="field"><label>Next of kin — contact</label><input id="mp-kin-contact" value="${esc(s.next_of_kin_contact || '')}"></div>
      </div>
      <button class="btn" id="mp-save">Save changes</button>
    </div>
  `;

  const saveBtn = root.querySelector('#mp-save');
  saveBtn.onclick = () => withBusy(saveBtn, async () => {
    const r = await Db.staff.updateOwnProfile({
      phone: root.querySelector('#mp-phone').value.trim(),
      gender: root.querySelector('#mp-gender').value,
      date_of_birth: root.querySelector('#mp-dob').value || null,
      national_id: root.querySelector('#mp-nid').value.trim(),
      next_of_kin_name: root.querySelector('#mp-kin-name').value.trim(),
      next_of_kin_contact: root.querySelector('#mp-kin-contact').value.trim()
    });
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast('Profile updated.', 'ok');
  }, 'Saving…');
}
