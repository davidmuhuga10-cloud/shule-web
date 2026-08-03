/**
 * parentAccounts.mjs (view) — admin-only: provision parent logins and link
 * them to their children. Separate from the general "User Accounts" screen
 * because provisioning takes a phone number (not an email) and the whole
 * point of a parent account is the student link, which staff/student
 * accounts don't have.
 */
import { esc, options, toast, confirmAction, modal, closeModal, renderPrereq, loader, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';

/** What the parent actually types at the login screen — "phone@schoolcode" —
 *  rather than the raw synthetic email address, which would be confusing to
 *  read aloud or write down for someone. */
function loginHandleFor(phone) {
  const code = state.profile && state.profile.schools ? state.profile.schools.code : '';
  return code ? `${phone}@${code}` : phone;
}

/** Same idea, but for redisplaying an already-stored synthetic email (e.g.
 *  in the accounts table) — strips the ".parents.shule.internal" tail so it
 *  reads as the "phone@schoolcode" the parent actually types, not the full
 *  internal address. */
function displayLoginHandle(email) {
  return String(email || '').replace(/\.parents\.shule\.internal$/, '') || '—';
}

export async function viewParentAccounts(root) {
  const studentsRes = await Db.students.list({});
  const students = studentsRes.ok ? studentsRes.data : [];
  if (!students.length) { renderPrereq(root, 'No students found', 'Please add students before creating parent accounts.', 'students', 'Go to Students'); return; }
  await render(root, students);
}

async function render(root, students) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Parent Accounts</h2><p>Create parent logins and link them to their children.</p></div>
      <div class="spacer"></div><button class="btn" id="add-parent">+ New parent account</button></div>
    <div class="card" style="margin-bottom:16px"><div id="parent-list">${loader()}</div></div>
    <div class="card"><div class="card-b"><h3 style="margin:0 0 4px">Parent ↔ Student links</h3><p class="muted" style="font-size:13px;margin:0 0 14px">Which parent can see which child's attendance and results.</p>
      <button class="btn secondary sm" id="add-link">+ Link parent to student</button>
    </div><div id="link-list"></div></div>
  `;

  root.querySelector('#add-parent').onclick = () => openProvisionModal(root, students);
  root.querySelector('#add-link').onclick = () => openLinkModal(root, students);

  await Promise.all([loadParents(root), loadLinks(root, students)]);
}

async function loadParents(root) {
  const listEl = root.querySelector('#parent-list');
  const res = await Db.parents.list();
  const parents = res.ok ? res.data : [];
  if (!parents.length) {
    listEl.innerHTML = `<div class="card-b"><p class="muted center" style="margin:20px 0">No parent accounts yet — create one above.</p></div>`;
    return;
  }
  listEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Name</th><th>Login</th><th>Status</th></tr></thead>
    <tbody>${parents.map((p) => `<tr>
      <td>${esc(p.name)}</td><td>${esc(displayLoginHandle(p.email))}</td>
      <td><span class="badge ${p.status === 'active' ? 'green' : 'grey'}">${esc(p.status)}</span></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

async function loadLinks(root, students) {
  const listEl = root.querySelector('#link-list');
  const res = await Db.parents.links();
  const links = res.ok ? res.data : [];
  if (!links.length) {
    listEl.innerHTML = `<div class="card-b"><p class="muted center" style="margin:20px 0">No links yet — link a parent to their child above.</p></div>`;
    return;
  }
  listEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Parent</th><th>Student</th><th>Relationship</th><th></th></tr></thead>
    <tbody>${links.map((l) => `<tr>
      <td>${esc(l.parent_name)}<div class="muted" style="font-size:12px">${esc(displayLoginHandle(l.parent_email))}</div></td>
      <td>${esc(l.student_name)}<div class="muted" style="font-size:12px">${esc(l.admission_no || '')}</div></td>
      <td>${esc(l.relationship || '—')}</td>
      <td class="row-actions"><button class="icon-btn danger" data-unlink="${l.id}">🗑️</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  listEl.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = () => confirmAction('Remove this parent-student link?', async () => {
    const r = await Db.parents.unlink(b.dataset.unlink);
    if (r.ok) { toast('Link removed.', 'ok'); loadLinks(root, students); } else toast(r.message, 'err');
  }, true));
}

function openProvisionModal(root, students) {
  modal({
    title: 'New parent account',
    body: `
      <div class="field"><label>Parent's full name</label><input id="pa-name" placeholder="e.g. Jane Wanjiru"></div>
      <div class="field"><label>Phone number <span class="muted">(used to sign in)</span></label><input id="pa-phone" placeholder="e.g. 0712345678"></div>
      <div class="field"><label>Child</label><select id="pa-student">${options(students, 'id', 'full_name', '', 'Choose a student')}</select>
        <div class="hint">The parent's password will be this child's admission number.</div>
      </div>
      <div class="field"><label>Relationship (optional)</label><input id="pa-rel" placeholder="e.g. Mother, Father, Guardian"></div>
    `,
    okLabel: 'Create account',
    onOk: async () => {
      const full_name = document.getElementById('pa-name').value.trim();
      const phone = document.getElementById('pa-phone').value.trim();
      const student_id = document.getElementById('pa-student').value;
      const relationship = document.getElementById('pa-rel').value.trim();
      if (!full_name || !phone || !student_id) { toast('Name, phone number, and a child are required.', 'err'); return; }
      const res = await Db.parents.provision({ full_name, phone, student_id });
      if (!res.ok) { toast(res.message, 'err'); return; }
      if (res.alreadyProvisioned) {
        closeModal();
        toast('This parent already has an account.', 'warn');
        loadParents(root);
        return;
      }
      // Link the new account to the chosen child right away — the whole
      // point of a parent account is seeing this specific child's data.
      const linkRes = await Db.parents.linkStudent({ parent_profile_id: res.profile_id, student_id, relationship });
      closeModal();
      if (!linkRes.ok) {
        toast(`Account created (login: ${loginHandleFor(phone)}, password: ${res.defaultPassword}) but linking to the child failed: ${linkRes.message}`, 'warn');
      } else {
        toast(`Parent account created — login: ${loginHandleFor(phone)}, password (child's admission number): ${res.defaultPassword}`, 'ok');
      }
      loadParents(root);
      loadLinks(root, students);
    }
  });
}

async function openLinkModal(root, students) {
  const parentsRes = await Db.parents.list();
  const parents = parentsRes.ok ? parentsRes.data : [];
  if (!parents.length) { toast('Create a parent account first.', 'err'); return; }

  modal({
    title: 'Link parent to student',
    body: `
      <div class="field"><label>Parent</label><select id="lk-parent">${options(parents, 'id', 'name', '', 'Choose a parent')}</select></div>
      <div class="field"><label>Student</label><select id="lk-student">${options(students, 'id', 'full_name', '', 'Choose a student')}</select></div>
      <div class="field"><label>Relationship (optional)</label><input id="lk-rel" placeholder="e.g. Mother, Father, Guardian"></div>
    `,
    okLabel: 'Link',
    onOk: async () => {
      const parent_profile_id = document.getElementById('lk-parent').value;
      const student_id = document.getElementById('lk-student').value;
      const relationship = document.getElementById('lk-rel').value.trim();
      if (!parent_profile_id || !student_id) { toast('Choose both a parent and a student.', 'err'); return; }
      const res = await Db.parents.linkStudent({ parent_profile_id, student_id, relationship });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Linked.', 'ok');
      loadLinks(root, students);
    }
  });
}
