/**
 * userAccounts.mjs — "User Accounts" tab inside Settings (feature brief:
 * "User accounts – here just include only admins... one can add or revoke
 * admin rights here", modelled on Zeraki's "User Roles" screen). Deliberately
 * narrow: this is ONLY about who has full admin access, not a general
 * account-management screen for every login in the school (that's what used
 * to live here) — resetting a teacher's password or disabling their account
 * now happens from the Staff module instead, right next to everything else
 * about that person.
 */
import { esc, toast, confirmAction, options, modal, closeModal } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewUsers(root) {
  await render(root);
}

async function render(root) {
  const [usersRes, staffRes] = await Promise.all([Db.users.list(), Db.staff.list()]);
  const users = usersRes.ok ? usersRes.data : [];
  const staffById = {}; (staffRes.ok ? staffRes.data : []).forEach((s) => { staffById[s.id] = s; });

  const admins = users.filter((u) => u.role === 'admin');
  // Anyone with a staff login who ISN'T already an admin — the pool "+ Grant
  // admin" can promote from. A brand-new staff member without a login yet
  // isn't in this list; they get the "Grant admin access" checkbox at
  // creation time instead (Staff module), same as before.
  const promotable = users.filter((u) => u.role === 'teacher' && u.staff_id);

  root.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <p class="muted" style="margin:0;flex:1">School heads, directors, deputies and system admins — anyone with full admin access. Teachers and other staff are managed from the Staff module.</p>
      <button class="btn" id="add-admin" ${promotable.length ? '' : 'disabled title="No staff logins available to promote yet"'}>+ Grant admin</button>
    </div>
    <div class="card">
      ${admins.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Title</th><th>Login</th><th>Status</th><th></th></tr></thead>
        <tbody>${admins.map((u) => `<tr>
          <td>${esc(u.name)}</td>
          <td>${esc((staffById[u.staff_id] || {}).role || '—')}</td>
          <td>${esc(u.username || u.email || '—')}</td>
          <td><span class="badge ${u.status === 'active' ? 'green' : 'grey'}">${esc(u.status)}</span></td>
          <td class="row-actions"><button class="btn ghost sm danger" data-revoke="${u.id}">Revoke</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : `<div class="card-b"><p class="muted center" style="margin:20px 0">No admins found — this shouldn't normally happen since you're signed in as one.</p></div>`}
    </div>
  `;

  root.querySelector('#add-admin').onclick = () => openGrantModal(root, promotable);
  root.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = () => confirmAction(
    'Revoke admin access for this person? They\'ll keep their teacher/staff login, just without full admin rights.',
    async () => {
      const r = await Db.users.setRole(b.dataset.revoke, 'teacher');
      if (r.ok) { toast('Admin access revoked.', 'ok'); render(root); } else toast(r.message, 'err');
    }, true
  ));
}

function openGrantModal(root, promotable) {
  modal({
    title: 'Grant admin access',
    body: `
      <div class="field"><label>Staff member</label><select id="ga-staff">${options(promotable, 'id', 'name', '', 'Choose a staff member')}</select></div>
      <p class="hint" style="margin-top:0">They'll keep signing in the same way — this just gives their account full admin access instead of teacher-level access.</p>
    `,
    okLabel: 'Grant admin access',
    onOk: async () => {
      const profileId = document.getElementById('ga-staff').value;
      if (!profileId) { toast('Choose a staff member.', 'err'); return; }
      const res = await Db.users.setRole(profileId, 'admin');
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Admin access granted.', 'ok');
      render(root);
    }
  });
}
