/**
 * teachers.mjs — Teachers module (Phase 2g / brief §6): a dedicated,
 * card-grid teacher directory, distinct from the flatter all-staff CRUD
 * table (Staff module still covers bursars, support staff, etc). Reuses
 * staff.mjs's existing add/edit form (openStaffModal) rather than
 * duplicating it — same data, same login-provisioning flow, just a
 * teacher-focused view on top of it.
 */
import { esc, initials, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { openStaffModal, openAddChoiceModal } from './staff.mjs';

function isTeacher(s) {
  return String(s.role || 'teacher').toLowerCase() === 'teacher';
}

export async function viewTeachers(root) {
  await render(root, '');
}

async function render(root, query) {
  const res = await Db.staff.list();
  const all = res.ok ? res.data : [];
  const teachers = all.filter(isTeacher);
  const q = String(query || '').trim().toLowerCase();
  const filtered = q ? teachers.filter((t) => String(t.full_name || '').toLowerCase().indexOf(q) !== -1) : teachers;

  // Card layout: name + status badge share one header row (instead of the
  // badge dangling below everything else), email/phone collapse onto one
  // line, and the three actions are compact icon buttons instead of three
  // full-width text buttons stacked under the contact details — same fields,
  // just not "getting out of hand" the way three stretched rows did.
  const cards = filtered.map((t) => `
    <div class="card teacher-card">
      <div class="card-b">
        <div class="teacher-card-head">
          <div class="avatar-circle">${esc(initials(t.full_name))}</div>
          <div class="teacher-card-name">
            <div class="t-name">${esc(t.full_name)}</div>
            <div class="t-contact">${esc(t.email || 'No email')}${t.phone ? ' · ' + esc(t.phone) : ''}</div>
          </div>
          <span class="badge ${t.status === 'active' ? 'green' : 'grey'}">${esc(t.status || 'active')}</span>
        </div>
        <div class="teacher-card-actions">
          <button class="btn sm secondary" data-edit="${t.id}">Edit</button>
          <button class="icon-btn" data-assign="${t.id}" title="Subject assignments (in Classes &amp; Arms)">🔗</button>
          <button class="icon-btn" data-msg="${t.id}" title="Message">💬</button>
        </div>
      </div>
    </div>`).join('');

  root.innerHTML = `
    <div class="page-head"><div><h2>Teachers</h2><p>Your teaching staff, at a glance.</p></div>
      <div class="spacer"></div><button class="btn" id="add-teacher">+ Add New Teacher</button></div>
    <div class="toolbar">
      <div class="field grow"><input id="teacher-search" placeholder="Search teachers by name…" value="${esc(query || '')}"></div>
    </div>
    ${filtered.length ? `<div class="teacher-grid">${cards}</div>` : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">🧑‍🏫</div><h3>${teachers.length ? 'No teachers match your search' : 'No teachers yet'}</h3>
      <p>${teachers.length ? 'Try a different name.' : 'Add your first teacher to get started.'}</p>
      ${teachers.length ? '' : '<button class="btn" id="empty-add-teacher">+ Add New Teacher</button>'}
    </div></div></div>`}
  `;

  root.querySelector('#add-teacher').onclick = () => openAddChoiceModal(root, () => render(root, query));
  const emptyBtn = root.querySelector('#empty-add-teacher');
  if (emptyBtn) emptyBtn.onclick = () => openAddChoiceModal(root, () => render(root, query));
  root.querySelector('#teacher-search').oninput = (e) => render(root, e.target.value);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openStaffModal(root, all.find((s) => s.id === b.dataset.edit), () => render(root, query)));
  // Teacher-to-subject assignment now happens inside Classes & Streams (per
  // stream, right next to that stream's subjects) — the standalone "Teacher
  // Assignments" module was removed as a duplicate of that (feature brief:
  // "TEACHING and Assignments... should be done under subject (we already
  // build that) so it's just deleting the module").
  root.querySelectorAll('[data-assign]').forEach((b) => b.onclick = () => go('classes'));
  root.querySelectorAll('[data-msg]').forEach((b) => b.onclick = () => go('messaging'));
}
