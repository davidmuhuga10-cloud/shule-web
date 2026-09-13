/**
 * myProfile.mjs — "Edit Profile": every signed-in user (admin, teacher,
 * finance clerk, parent, student) can update their own name and contact
 * details from here, reached via the top-right user menu (see index.html's
 * #um-edit-profile) rather than the Privacy Policy / Delete Account links
 * that used to live there — those only belong at sign-up (privacy consent
 * tickbox) and in the "Delete Account / Data" link at the bottom of this
 * screen, one click away, per Google Play's account-deletion requirement.
 *
 * Two paths, same screen:
 *  - Linked to a staff record (admin/teacher/finance clerk): the fuller
 *    form (name, phone, gender, DOB, national ID, next of kin), written
 *    through staff_update_own_profile (0034 + 0065) — role/status/email/
 *    login stay untouched, exactly as before.
 *  - Everyone else (parent/student, or a staff account with no staff row
 *    yet): a plain name + phone form, written through profile_update_own
 *    (0065) directly against `profiles`.
 */
import { esc, toast, loader, state, withBusy, renderPrereqOrConnectivity } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewMyProfile(root) {
  const staffId = state.profile && state.profile.staff_id;
  if (staffId) return renderStaffForm(root, staffId);
  return renderGenericForm(root);
}

function deleteAccountFooter() {
  return `<p style="margin-top:20px;text-align:center">
    <a href="/account-deletion.html" target="_blank" rel="noopener" class="muted" style="font-size:12.5px">🗑️ Delete Account / Data</a>
  </p>`;
}

async function renderStaffForm(root, staffId) {
  root.innerHTML = loader();
  const res = await Db.staff.get(staffId);
  if (!res.ok) { renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewMyProfile(root) }); return; }
  const s = res.data;

  root.innerHTML = `
    <div class="page-head"><div><h2>Edit Profile</h2><p>Update your own name and contact details. Your role and login stay unchanged — ask an admin for those.</p></div></div>
    <div class="card pad">
      <div class="grid2">
        <div class="field"><label>Full name</label><input id="mp-name" value="${esc(s.full_name)}"></div>
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
      ${deleteAccountFooter()}
    </div>
  `;

  const saveBtn = root.querySelector('#mp-save');
  saveBtn.onclick = () => withBusy(saveBtn, async () => {
    const fullName = root.querySelector('#mp-name').value.trim();
    if (!fullName) { toast('Name cannot be empty.', 'err'); return; }
    const r = await Db.staff.updateOwnProfile({
      full_name: fullName,
      phone: root.querySelector('#mp-phone').value.trim(),
      gender: root.querySelector('#mp-gender').value,
      date_of_birth: root.querySelector('#mp-dob').value || null,
      national_id: root.querySelector('#mp-nid').value.trim(),
      next_of_kin_name: root.querySelector('#mp-kin-name').value.trim(),
      next_of_kin_contact: root.querySelector('#mp-kin-contact').value.trim()
    });
    if (!r.ok) { toast(r.message, 'err'); return; }
    if (state.profile) state.profile.name = fullName;
    toast('Profile updated.', 'ok');
  }, 'Saving…');
}

function renderGenericForm(root) {
  const p = state.profile || {};
  root.innerHTML = `
    <div class="page-head"><div><h2>Edit Profile</h2><p>Update your own name and phone number.</p></div></div>
    <div class="card pad">
      <div class="grid2">
        <div class="field"><label>Full name</label><input id="mp-name" value="${esc(p.name || '')}"></div>
        <div class="field"><label>Phone number</label><input id="mp-phone" type="tel" value="${esc(p.phone || '')}" placeholder="e.g. 0712345678"></div>
      </div>
      <button class="btn" id="mp-save">Save changes</button>
      ${deleteAccountFooter()}
    </div>
  `;

  const saveBtn = root.querySelector('#mp-save');
  saveBtn.onclick = () => withBusy(saveBtn, async () => {
    const name = root.querySelector('#mp-name').value.trim();
    if (!name) { toast('Name cannot be empty.', 'err'); return; }
    const r = await Db.users.updateOwnProfile({
      name,
      phone: root.querySelector('#mp-phone').value.trim()
    });
    if (!r.ok) { toast(r.message, 'err'); return; }
    if (state.profile) { state.profile.name = name; state.profile.phone = r.data.phone; }
    toast('Profile updated.', 'ok');
  }, 'Saving…');
}
