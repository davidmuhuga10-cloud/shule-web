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
import { openStaffModal } from './staff.mjs';

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

  const cards = filtered.map((t) => `
    <div class="card teacher-card">
      <div class="card-b">
        <div style="display:flex;gap:14px;align-items:center">
          <div class="avatar-circle">${esc(initials(t.full_name))}</div>
          <div style="min-width:0">
            <div style="font-weight:700;font-size:15px">${esc(t.full_name)}</div>
            <div class="muted" style="font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.email || 'No email')}</div>
            <div class="muted" style="font-size:12.5px">${esc(t.phone || 'No phone')}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
          <button class="btn ghost sm" data-edit="${t.id}" style="flex:1">✏️ Edit</button>
          <button class="btn ghost sm" data-assign="${t.id}" style="flex:1">🔗 Assignments</button>
          <button class="btn ghost sm" data-msg="${t.id}" style="flex:1">💬 Message</button>
        </div>
        <span class="badge ${t.status === 'active' ? 'green' : 'grey'}" style="margin-top:10px;display:inline-block">${esc(t.status || 'active')}</span>
      </div>
    </div>`).join('');

  root.innerHTML = `
    <div class="page-head"><div><h2>Teachers</h2><p>Your teaching staff, at a glance.</p></div>
      <div class="spacer"></div><button class="btn" id="add-teacher">+ Add New Teacher</button></div>
    <div class="toolbar">
      <div class="field grow"><input id="teacher-search" placeholder="Search teachers by name…" value="${esc(query || '')}"></div>
    </div>
    ${filtered.length ? `<div class="teacher-grid">${cards}</div>` : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">🍎</div><h3>${teachers.length ? 'No teachers match your search' : 'No teachers yet'}</h3>
      <p>${teachers.length ? 'Try a different name.' : 'Add your first teacher to get started.'}</p>
      ${teachers.length ? '' : '<button class="btn" id="empty-add-teacher">+ Add New Teacher</button>'}
    </div></div></div>`}
  `;

  root.querySelector('#add-teacher').onclick = () => openStaffModal(root, undefined, () => render(root, query));
  const emptyBtn = root.querySelector('#empty-add-teacher');
  if (emptyBtn) emptyBtn.onclick = () => openStaffModal(root, undefined, () => render(root, query));
  root.querySelector('#teacher-search').oninput = (e) => render(root, e.target.value);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openStaffModal(root, all.find((s) => s.id === b.dataset.edit), () => render(root, query)));
  root.querySelectorAll('[data-assign]').forEach((b) => b.onclick = () => go('teacher-assignments'));
  root.querySelectorAll('[data-msg]').forEach((b) => b.onclick = () => go('messaging'));
}
