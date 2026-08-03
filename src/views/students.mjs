import { esc, modal, closeModal, toast, confirmAction, options, renderPrereq, loader, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { LEAVING_REASON_LABELS } from '../lib/api/students.mjs';

function genderBadge(g) {
  return `<span class="badge ${g === 'Female' ? 'red' : 'blue'}">${esc(g)}</span>`;
}

export async function viewStudents(root) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  if (!classes.length) {
    renderPrereq(root, 'No classes found', 'Please create a class before adding students.', 'classes', 'Go to Classes');
    return;
  }
  await render(root, classes, { class_id: '', stream_id: '', view: 'active' });
}

async function render(root, classes, filters) {
  let streams = [];
  if (filters.class_id) {
    const sres = await Db.streams.list(filters.class_id);
    streams = sres.ok ? sres.data : [];
  }
  const isArchived = filters.view === 'archived';

  root.innerHTML = `
    <div class="page-head"><div><h2>Students</h2><p>${isArchived ? 'Students who have transferred, graduated or withdrawn — historical records are kept intact.' : 'All enrolled students, ranked by admission number.'}</p></div>
      <div class="spacer"></div>
      ${!isArchived ? `<button class="btn secondary" id="move-selected" disabled>Move selected ▸</button>` : ''}
      <button class="btn" id="add-student">+ Add student</button></div>
    <div class="tabs" style="max-width:320px">
      <button data-view="active" class="${!isArchived ? 'active' : ''}">Active</button>
      <button data-view="archived" class="${isArchived ? 'active' : ''}">Left / Archived</button>
    </div>
    <div class="toolbar">
      <select id="f-class" class="grow"><option value="">All classes</option>${options(classes, 'id', 'name', filters.class_id)}</select>
      <select id="f-stream" ${filters.class_id ? '' : 'disabled'}><option value="">All streams</option>${options(streams, 'id', 'name', filters.stream_id)}</select>
    </div>
    <div class="card"><div id="student-list">${loader()}</div></div>
  `;

  root.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => render(root, classes, { ...filters, view: b.dataset.view }));
  root.querySelector('#f-class').onchange = (e) => render(root, classes, { ...filters, class_id: e.target.value, stream_id: '' });
  root.querySelector('#f-stream').onchange = (e) => render(root, classes, { ...filters, stream_id: e.target.value });
  root.querySelector('#add-student').onclick = () => openAddChoiceModal(root, classes, filters);

  const listEl = root.querySelector('#student-list');
  const res = await Db.students.list({
    class_id: filters.class_id || undefined, stream_id: filters.stream_id || undefined,
    status: isArchived ? 'left' : 'active'
  });
  const list = res.ok ? res.data : [];

  if (!list.length) {
    listEl.innerHTML = `<div class="card-b"><div class="empty">
      <div class="e-ico">🎒</div><h3>${isArchived ? 'No archived students' : 'No students found'}</h3>
      <p>${isArchived ? 'Students you archive (transferred, graduated, withdrawn) will show up here.' : (filters.class_id ? 'No students match this filter yet.' : 'Please add students first.')}</p>
      ${isArchived ? '' : '<button class="btn" id="empty-add-student">+ Add student</button>'}
    </div></div>`;
    const b = listEl.querySelector('#empty-add-student');
    if (b) b.onclick = () => openAddChoiceModal(root, classes, filters);
    return;
  }

  if (isArchived) {
    listEl.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th class="num">#</th><th>Admission No.</th><th>Name</th><th>Class</th><th>Reason</th><th>Date left</th><th></th></tr></thead>
      <tbody>${list.map((s, i) => `<tr>
        <td class="num">${i + 1}</td><td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.class_name)}</td>
        <td>${esc(LEAVING_REASON_LABELS[s.left_reason] || s.left_reason || '—')}</td><td>${esc(s.left_date || '—')}</td>
        <td class="row-actions">
          <button class="btn ghost sm" data-restore="${s.id}">Restore</button>
          <button class="icon-btn danger" data-purge="${s.id}">🗑️</button>
        </td></tr>`).join('')}</tbody>
    </table></div>`;

    listEl.querySelectorAll('[data-restore]').forEach((b) => b.onclick = () => confirmAction(
      'Restore this student to the active roster?',
      async () => {
        const r = await Db.students.restore(b.dataset.restore);
        if (r.ok) { toast('Student restored.', 'ok'); render(root, classes, filters); } else toast(r.message, 'err');
      }
    ));
    listEl.querySelectorAll('[data-purge]').forEach((b) => b.onclick = () => confirmAction(
      'Permanently delete this student? This also deletes their results, attendance and parent links — this cannot be undone. Only do this for a genuine mistake (e.g. a duplicate record); use Restore instead if they should still be on the roster.',
      async () => {
        const r = await Db.students.remove(b.dataset.purge);
        if (r.ok) { toast('Student permanently deleted.', 'ok'); render(root, classes, filters); } else toast(r.message, 'err');
      }, true
    ));
    return;
  }

  listEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th style="width:36px"><input type="checkbox" id="sel-all"></th><th class="num">#</th><th>Admission No.</th><th>Name</th><th>Gender</th><th>Class</th><th>Stream</th><th></th></tr></thead>
    <tbody>${list.map((s, i) => `<tr>
      <td><input type="checkbox" class="sel-row" data-id="${s.id}"></td>
      <td class="num">${i + 1}</td><td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td>
      <td>${genderBadge(s.gender)}</td><td>${esc(s.class_name)}</td><td>${esc(s.stream_name || '—')}</td>
      <td class="row-actions">
        <button class="icon-btn" data-edit="${s.id}">✏️</button>
        <button class="icon-btn danger" data-archive="${s.id}">📤</button>
      </td></tr>`).join('')}</tbody>
  </table></div>`;

  listEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openStudentModal(root, classes, filters, list.find((s) => s.id === b.dataset.edit)));
  listEl.querySelectorAll('[data-archive]').forEach((b) => b.onclick = () => openArchiveModal(root, classes, filters, b.dataset.archive));

  const moveBtn = root.querySelector('#move-selected');
  const selAll = listEl.querySelector('#sel-all');
  const rowChecks = () => [...listEl.querySelectorAll('.sel-row')];
  const updateMoveBtn = () => { moveBtn.disabled = rowChecks().filter((c) => c.checked).length === 0; };
  selAll.onchange = () => { rowChecks().forEach((c) => { c.checked = selAll.checked; }); updateMoveBtn(); };
  rowChecks().forEach((c) => c.onchange = updateMoveBtn);
  moveBtn.onclick = () => {
    const ids = rowChecks().filter((c) => c.checked).map((c) => c.dataset.id);
    if (!ids.length) return;
    openMoveModal(root, classes, filters, ids);
  };
}

/** "+ Add student" now asks Single vs Bulk first, instead of always opening
 *  the one-at-a-time form — enrolling a whole new class at once is common
 *  enough (a new intake, promotion day) that it deserves equal billing with
 *  adding one student, not a buried nav link elsewhere. */
function openAddChoiceModal(root, classes, filters) {
  modal({
    title: 'Add student',
    body: `
      <p class="hint" style="margin-top:0">How would you like to add students?</p>
      <div class="grid2">
        <button class="btn secondary" id="choice-single" style="width:100%;padding:18px 12px;flex-direction:column;height:auto;gap:6px">
          <div style="font-size:22px">🎒</div><div>Single student</div>
        </button>
        <button class="btn secondary" id="choice-bulk" style="width:100%;padding:18px 12px;flex-direction:column;height:auto;gap:6px">
          <div style="font-size:22px">📥</div><div>Bulk upload</div>
        </button>
      </div>
    `,
    footer: false
  });
  document.getElementById('choice-single').onclick = () => { closeModal(); openStudentModal(root, classes, filters); };
  document.getElementById('choice-bulk').onclick = () => { closeModal(); go('bulk-upload'); };
}

async function openStudentModal(root, classes, filters, existing) {
  let streams = existing ? (await Db.streams.list(existing.class_id)).data || [] : [];
  renderModal(streams, existing ? existing.class_id : filters.class_id || '');

  function renderModal(currentStreams, selectedClass) {
    modal({
      title: existing ? 'Edit student' : 'Add student',
      body: `
        <div class="grid2">
          <div class="field"><label>Admission Number</label><input id="st-adm" value="${esc(existing ? existing.admission_no : '')}"></div>
          <div class="field"><label>Gender</label><select id="st-gender">${options([{ id: 'Male', name: 'Male' }, { id: 'Female', name: 'Female' }], 'id', 'name', existing ? existing.gender : '', 'Choose gender')}</select></div>
        </div>
        <div class="field"><label>Student Name</label><input id="st-name" value="${esc(existing ? existing.full_name : '')}"></div>
        <div class="grid2">
          <div class="field"><label>Class</label><select id="st-class">${options(classes, 'id', 'name', selectedClass, 'Choose a class')}</select></div>
          <div class="field"><label>Stream (optional)</label><select id="st-stream">${options(currentStreams, 'id', 'name', existing ? existing.stream_id : '', 'No stream')}</select></div>
        </div>
        <div class="field"><label>Parent/Guardian Name or Contact</label><input id="st-guardian" value="${esc(existing ? existing.guardian_name || existing.guardian_contact || '' : '')}" placeholder="Name or phone number"></div>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;font-weight:600;font-size:13px">More details (optional)</summary>
          <div style="margin-top:10px">
            <div class="grid2">
              <div class="field"><label>Date of birth</label><input id="st-dob" type="date" value="${esc(existing ? existing.date_of_birth || '' : '')}"></div>
              <div class="field"><label>Admission date</label><input id="st-admdate" type="date" value="${esc(existing ? existing.admission_date || '' : '')}"></div>
            </div>
            <div class="grid2">
              <div class="field"><label>UPI number (NEMIS)</label><input id="st-upi" value="${esc(existing ? existing.upi_number || '' : '')}"></div>
              <div class="field"><label>Assessment number (KNEC)</label><input id="st-assessment" value="${esc(existing ? existing.assessment_number || '' : '')}"></div>
            </div>
            <div class="grid2">
              <div class="field"><label>Guardian relationship</label><input id="st-guardian-rel" value="${esc(existing ? existing.guardian_relationship || '' : '')}" placeholder="e.g. Mother, Father, Guardian"></div>
              <div class="field"><label>Guardian ID number</label><input id="st-guardian-id" value="${esc(existing ? existing.guardian_id_number || '' : '')}"></div>
            </div>
            <div class="field"><label>Previous school (if transferred in)</label><input id="st-prev-school" value="${esc(existing ? existing.previous_school || '' : '')}"></div>
            <div class="field"><label>Medical notes (allergies, conditions, etc.)</label><input id="st-medical" value="${esc(existing ? existing.medical_notes || '' : '')}"></div>
          </div>
        </details>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const payload = {
          id: existing ? existing.id : undefined,
          admission_no: document.getElementById('st-adm').value,
          full_name: document.getElementById('st-name').value,
          gender: document.getElementById('st-gender').value,
          class_id: document.getElementById('st-class').value,
          stream_id: document.getElementById('st-stream').value || null,
          guardian_name: document.getElementById('st-guardian').value,
          guardian_contact: document.getElementById('st-guardian').value,
          date_of_birth: document.getElementById('st-dob').value || null,
          admission_date: document.getElementById('st-admdate').value || null,
          guardian_relationship: document.getElementById('st-guardian-rel').value,
          upi_number: document.getElementById('st-upi').value,
          assessment_number: document.getElementById('st-assessment').value,
          guardian_id_number: document.getElementById('st-guardian-id').value,
          previous_school: document.getElementById('st-prev-school').value,
          medical_notes: document.getElementById('st-medical').value
        };
        const res = await Db.students.save(payload);
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        if (!existing) {
          const prov = await Db.users.provisionStudentLogin({ student_id: res.data.id, admission_no: res.data.admission_no, full_name: res.data.full_name });
          if (prov && prov.ok && prov.defaultPassword) {
            toast(`Student saved. Login created — default password: ${prov.defaultPassword}`, 'ok');
          } else {
            toast('Student saved. (Login provisioning will be available once the Netlify function is deployed.)', 'warn');
          }
        } else {
          toast('Student saved.', 'ok');
        }
        render(root, classes, filters);
      }
    });

    document.getElementById('st-class').onchange = async (e) => {
      const cid = e.target.value;
      const sres = cid ? await Db.streams.list(cid) : { ok: true, data: [] };
      renderModal(sres.ok ? sres.data : [], cid);
    };
  }
}

/** Archive (soft-remove) one student — asks why, so the reason shows up in
 *  the Left/Archived list later. Their results/attendance/parent links are
 *  left completely untouched; only their status flips off the active roster. */
function openArchiveModal(root, classes, filters, studentId) {
  const reasonChoices = Object.keys(LEAVING_REASON_LABELS).map((k) => ({ id: k, name: LEAVING_REASON_LABELS[k] }));
  modal({
    title: 'Archive student',
    body: `
      <p class="hint">This takes the student off the active roster, but keeps all their historical results and attendance for reference. You can restore them later from the "Left / Archived" tab.</p>
      <div class="grid2">
        <div class="field"><label>Reason</label><select id="ar-reason">${options(reasonChoices, 'id', 'name', 'other')}</select></div>
        <div class="field"><label>Date left</label><input id="ar-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label>Notes (optional)</label><input id="ar-notes" placeholder="e.g. new school name"></div>
    `,
    okLabel: 'Archive',
    onOk: async () => {
      const res = await Db.students.archive(studentId, {
        reason: document.getElementById('ar-reason').value,
        left_date: document.getElementById('ar-date').value,
        notes: document.getElementById('ar-notes').value
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast('Student archived.', 'ok');
      closeModal();
      render(root, classes, filters);
    }
  });
}

/** Bulk "move students" — the promotion-day case (moving a whole class up a
 *  grade at once) instead of editing students one at a time. */
function openMoveModal(root, classes, filters, studentIds) {
  modal({
    title: `Move ${studentIds.length} student(s)`,
    body: `
      <div class="field"><label>Move to class</label><select id="mv-class">${options(classes, 'id', 'name', '', 'Choose a class')}</select></div>
      <div class="field"><label>Stream (optional)</label><select id="mv-stream" disabled><option value="">No stream</option></select></div>
    `,
    okLabel: 'Move',
    onOk: async () => {
      const classId = document.getElementById('mv-class').value;
      const streamId = document.getElementById('mv-stream').value || null;
      if (!classId) { toast('Please choose a class.', 'err'); return; }
      const res = await Db.students.bulkMove({ student_ids: studentIds, class_id: classId, stream_id: streamId });
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast(`Moved ${res.moved} student(s).`, 'ok');
      closeModal();
      render(root, classes, filters);
    }
  });
  document.getElementById('mv-class').onchange = async (e) => {
    const streamSel = document.getElementById('mv-stream');
    if (!e.target.value) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">No stream</option>'; return; }
    const sres = await Db.streams.list(e.target.value);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">No stream</option>' + options(sres.ok ? sres.data : [], 'id', 'name', '');
  };
}
