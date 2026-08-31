/**
 * teachers.mjs — Teachers module (Phase 2g / brief §6): a dedicated,
 * card-grid teacher directory, distinct from the flatter all-staff CRUD
 * table (Staff module still covers bursars, support staff, etc). Reuses
 * staff.mjs's existing add/edit form (openStaffModal) rather than
 * duplicating it — same data, same login-provisioning flow, just a
 * teacher-focused view on top of it.
 */
import { esc, initials, go, toast, confirmAction } from '../app.js';
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
  // Design standard brief item 2 (round 1): cycle through the same accent
  // hues the Reports/Exams tiles use, one per card, purely decorative.
  // Round 2 item 7 (approved): the avatar badge now carries the SAME hue
  // as the card's border, via the matching .t-* icon-tint utility class —
  // same pairing dashboard.mjs's CAT_ACCENT does for .s-ico/.stat-*.
  const ACCENTS = ['tile-blue', 'tile-green', 'tile-purple', 'tile-amber', 'tile-teal', 'tile-rose', 'tile-indigo'];
  const ICO_ACCENTS = ['t-blue', 't-green', 't-purple', 't-amber', 't-teal', 't-rose', 't-indigo'];
  const cards = filtered.map((t, i) => `
    <div class="card teacher-card ${ACCENTS[i % ACCENTS.length]}">
      <div class="card-b">
        <div class="teacher-card-head">
          <div class="avatar-circle ${ICO_ACCENTS[i % ICO_ACCENTS.length]}">${esc(initials(t.full_name))}</div>
          <div class="teacher-card-name">
            <div class="t-name">${esc(t.full_name)}</div>
            <div class="t-contact">${esc(t.email || 'No email')}${t.phone ? ' · ' + esc(t.phone) : ''}</div>
          </div>
          <span class="badge ${t.status === 'active' ? 'green' : 'grey'}">${esc(t.status || 'active')}</span>
        </div>
        <div class="teacher-card-actions">
          <button class="btn sm secondary" data-edit="${t.id}">Edit</button>
          <button class="icon-btn" data-assign="${t.id}" title="Subject assignments (in Classes &amp; Streams)">🔗</button>
          <button class="icon-btn" data-msg="${t.id}" title="Message">💬</button>
          <button class="icon-btn" data-del="${t.id}" title="Remove teacher">🗑️</button>
        </div>
      </div>
    </div>`).join('');

  root.innerHTML = `
    <div class="page-head"><div><h2>Teachers</h2><p>Your teaching staff, at a glance.</p></div></div>
    <div class="fin-toolbar">
      <div class="fin-search field"><input id="teacher-search" placeholder="🔍 Search teachers by name…" value="${esc(query || '')}"></div>
      <div class="spacer"></div>
      <button class="btn" id="add-teacher">+ Add New Teacher</button>
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
  // Round 2 §4 bug fix: there was previously no way to remove a teacher
  // once added — Staff (staff.mjs) already had this exact action for every
  // OTHER kind of staff member (Db.staff.remove, same table), it just never
  // made it onto this teacher-focused card view.
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction(
    'Remove this teacher? This cannot be undone.',
    async () => {
      const r = await Db.staff.remove(b.dataset.del);
      if (r.ok) { toast('Teacher removed.', 'ok'); render(root, query); } else toast(r.message, 'err');
    },
    true
  ));
}
