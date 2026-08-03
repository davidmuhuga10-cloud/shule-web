import { esc, toast, confirmAction, modal, closeModal } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewUsers(root) {
  await render(root);
}

/** What this person actually types to sign in — a username or phone number
 *  for staff, a phone number for parents, an admission number for students —
 *  rather than the raw internal synthetic email, which is meaningless to a
 *  human reading this list. Falls back to the stored email if none of the
 *  friendlier fields are on file (e.g. very old, not-yet-migrated accounts). */
function loginHandleFor(u) {
  if ((u.role === 'admin' || u.role === 'teacher') && u.username) return u.username;
  if (u.role === 'parent' && u.phone) return u.phone;
  return u.email || '—';
}

async function render(root) {
  const res = await Db.users.list();
  const users = res.ok ? res.data : [];

  root.innerHTML = `
    <div class="page-head"><div><h2>User Accounts</h2><p>Everyone with a login — reset passwords or disable access.</p></div></div>
    <div class="card">
      ${users.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Login</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td>${esc(u.name)}</td><td>${esc(loginHandleFor(u))}</td>
          <td><span class="badge blue">${esc(u.role)}</span></td>
          <td><span class="badge ${u.status === 'active' ? 'green' : 'grey'}">${esc(u.status)}</span></td>
          <td class="row-actions">
            <button class="btn ghost sm" data-reset="${u.id}">Reset password</button>
            <button class="btn ghost sm" data-toggle="${u.id}" data-status="${u.status}">${u.status === 'active' ? 'Disable' : 'Enable'}</button>
          </td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="card-b"><p class="muted center" style="margin:20px 0">No user accounts yet — they're created automatically when you add students or staff.</p></div>`}
    </div>`;

  root.querySelectorAll('[data-reset]').forEach((b) => b.onclick = () => confirmAction(
    'Reset this user\'s password to the default (they can change it after signing in)?',
    async () => {
      const r = await Db.users.resetPassword(b.dataset.reset);
      if (r.ok) toast(r.defaultPassword ? `Password reset — new default: ${r.defaultPassword}` : 'Password reset.', 'ok');
      else toast(r.message, 'err');
    }
  ));

  root.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
    const nextStatus = b.dataset.status === 'active' ? 'inactive' : 'active';
    confirmAction(`${nextStatus === 'inactive' ? 'Disable' : 'Enable'} this account?`, async () => {
      const r = await Db.users.setLoginStatus(b.dataset.toggle, nextStatus);
      if (r.ok) { toast('Account updated.', 'ok'); render(root); } else toast(r.message, 'err');
    }, nextStatus === 'inactive');
  });
}
