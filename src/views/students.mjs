/**
 * students.mjs — "Students" module, redesigned per direct feedback on the
 * previous version:
 *   - No more full unfiltered roster shown by default. The home screen is a
 *     big, centered search box (find one student instantly) PLUS a
 *     Classes→Students drill-down mirroring classes.mjs: click a class once
 *     and see everyone in it, with print/download/filter right there.
 *   - "Move students" is now a top-level action styled like "+ Add student"
 *     — click it first, then a guided modal asks which class/stream to move
 *     FROM, which to move TO, and which students, all in one place. No more
 *     checkbox-select-then-click-a-button flow.
 *   - Bulk Upload is no longer its own nav item — it's one click away from
 *     "+ Add student" already, so there's only "Students" in the sidebar now.
 *
 * Three screens, all rendered into the same root (same convention as
 * classes.mjs/exams.mjs's internal panels):
 *   1. renderHome         — search + classes grid (or the Archived list)
 *   2. renderClassStudents — one class's students, with stream/gender
 *      filters, print, download Excel
 *   3. renderStudentProfile — one student's full profile + results
 */
import { esc, modal, closeModal, toast, confirmAction, options, renderPrereq, renderPrereqOrConnectivity, loader, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { LEAVING_REASON_LABELS } from '../lib/api/students.mjs';
import { setNavIntent } from '../lib/navIntent.mjs';
import { downloadXlsx } from '../lib/xlsxUtil.mjs';

/** Every exportable field, brief §5: "let the admin choose which fields to
 *  include, rather than forcing every field into the export." */
const EXPORT_COLS = [
  { key: 'admission_no', label: 'Admission No.', on: true },
  { key: 'full_name', label: 'Name', on: true },
  { key: 'gender', label: 'Gender', on: true },
  { key: 'class_name', label: 'Class', on: true },
  { key: 'stream_name', label: 'Arm', on: true },
  { key: 'guardian_name', label: 'Guardian Name', on: false },
  { key: 'guardian_contact', label: 'Guardian Contact', on: false },
  { key: 'date_of_birth', label: 'Date of Birth', on: false },
  { key: 'admission_date', label: 'Admission Date', on: false },
  { key: 'upi_number', label: 'UPI Number', on: false },
  { key: 'assessment_number', label: 'Assessment Number', on: false }
];

function genderBadge(g) {
  return `<span class="badge ${g === 'Female' ? 'red' : 'blue'}">${esc(g)}</span>`;
}

export async function viewStudents(root) {
  const classesRes = await Db.classes.list();
  // Round 6 §5 (recurring BUG): see examAnalysis.mjs for the full story.
  if (!classesRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewStudents(root) });
    return;
  }
  const classes = classesRes.data;
  if (!classes.length) {
    renderPrereq(root, 'No classes found', 'Please create a class before adding students.', 'classes', 'Go to Classes');
    return;
  }
  await renderHome(root, classes, 'active');
}

/* ============================================================================
 * Screen 1 — Students home: search + classes grid, or the Archived list
 * ==========================================================================*/
async function renderHome(root, classes, view) {
  const isArchived = view === 'archived';

  root.innerHTML = `
    <div class="page-head"><div><h2>Students</h2></div>
      <div class="spacer"></div>
      ${!isArchived ? `<button class="btn secondary" id="move-students">🔀 Move students</button>` : ''}
      <button class="btn" id="add-student">+ Add student</button></div>
    <div class="fin-tabs">
      <button data-view="active" class="${!isArchived ? 'active' : ''}">Active</button>
      <button data-view="archived" class="${isArchived ? 'active' : ''}">Left / Archived</button>
    </div>
    ${isArchived ? `<div class="card" id="archived-card">${loader()}</div>` : `
    <div class="search-hero">
      <input id="student-search" placeholder="🔍 Search by admission no. or name…">
    </div>
    <div id="search-results"></div>
    <div id="classes-grid">${loader()}</div>
    `}
  `;

  root.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => renderHome(root, classes, b.dataset.view));
  root.querySelector('#add-student').onclick = () => openAddChoiceModal(root, classes, () => renderHome(root, classes, view));
  const moveBtn = root.querySelector('#move-students');
  if (moveBtn) moveBtn.onclick = () => openMoveStudentsModal(root, classes, () => renderHome(root, classes, view));

  if (isArchived) { await loadArchived(root, classes); return; }

  wireSearch(root, classes);
  await loadClassesGrid(root, classes);
}

function wireSearch(root, classes) {
  const searchEl = root.querySelector('#student-search');
  const resultsEl = root.querySelector('#search-results');
  const gridEl = root.querySelector('#classes-grid');
  let searchTimer = null;
  searchEl.oninput = () => {
    clearTimeout(searchTimer);
    const q = searchEl.value.trim();
    if (!q) { resultsEl.innerHTML = ''; gridEl.style.display = ''; return; }
    searchTimer = setTimeout(async () => {
      gridEl.style.display = 'none';
      const res = await Db.students.search(q);
      const matches = res.ok ? res.data : [];
      resultsEl.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Search results</h3></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Admission No.</th><th>Name</th><th>Class</th><th>Arm</th><th></th></tr></thead>
          <tbody>${matches.length ? matches.map((s) => `<tr class="clickable-row" data-open-profile="${s.id}">
            <td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.class_name)}</td><td>${esc(s.stream_name || '—')}</td>
            <td class="muted" style="font-size:12.5px">View profile →</td></tr>`).join('') : `<tr><td colspan="5" class="muted center">No matching students.</td></tr>`}</tbody>
        </table></div></div>`;
      resultsEl.querySelectorAll('[data-open-profile]').forEach((tr) => tr.onclick = async () => {
        const sres = await Db.students.get(tr.dataset.openProfile);
        if (!sres.ok) { toast(sres.message, 'err'); return; }
        renderStudentProfile(root, classes, sres.data, () => { gridEl.style.display = ''; renderHome(root, classes, 'active'); });
      });
    }, 200);
  };
}

async function loadClassesGrid(root, classes) {
  const gridEl = root.querySelector('#classes-grid');
  const rows = classes.map((c) => `<tr class="clickable-row" data-open-class="${c.id}">
      <td>${esc(c.name)}</td><td class="num">${c.student_count || 0}</td>
      <td class="muted" style="font-size:12.5px">View students →</td></tr>`).join('');

  gridEl.innerHTML = `<div class="card"><div class="table-wrap"><table class="data">
    <thead><tr><th>Class</th><th class="num">Students</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;

  gridEl.querySelectorAll('[data-open-class]').forEach((tr) => tr.onclick = () => {
    renderClassStudents(root, classes, classes.find((c) => c.id === tr.dataset.openClass));
  });
}

async function loadArchived(root, classes) {
  const cardEl = root.querySelector('#archived-card');
  const res = await Db.students.list({ status: 'left' });
  const list = res.ok ? res.data : [];

  if (!list.length) {
    cardEl.innerHTML = `<div class="card-b"><div class="empty">
      <div class="e-ico">🎒</div><h3>No archived students</h3>
      <p>Students you archive (transferred, graduated, withdrawn) will show up here.</p>
    </div></div>`;
    return;
  }

  cardEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Admission No.</th><th>Name</th><th>Class</th><th>Reason</th><th>Date left</th><th></th></tr></thead>
    <tbody>${list.map((s) => `<tr>
      <td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.class_name)}</td>
      <td>${esc(LEAVING_REASON_LABELS[s.left_reason] || s.left_reason || '—')}</td><td>${esc(s.left_date || '—')}</td>
      <td class="row-actions">
        <button class="btn ghost sm" data-restore="${s.id}">Restore</button>
        <button class="btn sm danger" data-purge="${s.id}">Delete</button>
      </td></tr>`).join('')}</tbody>
  </table></div>`;

  cardEl.querySelectorAll('[data-restore]').forEach((b) => b.onclick = () => confirmAction(
    'Restore this student to the active roster?',
    async () => {
      const r = await Db.students.restore(b.dataset.restore);
      if (r.ok) { toast('Student restored.', 'ok'); renderHome(root, classes, 'archived'); } else toast(r.message, 'err');
    }
  ));
  cardEl.querySelectorAll('[data-purge]').forEach((b) => b.onclick = () => confirmAction(
    'Permanently delete this student? This also deletes their results, attendance and parent links — this cannot be undone. Only do this for a genuine mistake (e.g. a duplicate record); use Restore instead if they should still be on the roster.',
    async () => {
      const r = await Db.students.remove(b.dataset.purge);
      if (r.ok) { toast('Student permanently deleted.', 'ok'); renderHome(root, classes, 'archived'); } else toast(r.message, 'err');
    }, true
  ));
}

/* ============================================================================
 * Screen 2 — one class's students (brief §5: "clicking once shows all the
 * students there, with print, download, filter" — stream/gender filters
 * narrow that same view instead of needing a second click).
 * ==========================================================================*/
async function renderClassStudents(root, classes, cls) {
  const sres = await Db.streams.list(cls.id);
  const streams = sres.ok ? sres.data : [];
  await load({ stream_id: '', gender: '' });

  async function load(filters) {
    root.innerHTML = `
      <div class="page-head">
        <div><a class="back-link" id="back-to-students">← Students</a><h2>${esc(cls.name)}</h2><p>All active students in this class — filter by arm or gender, print, or download as Excel.</p></div>
      </div>
      <div class="fin-toolbar">
        <div class="fin-filters">
          <div class="field"><label>Arm</label>
            <select id="f-stream">${streams.length ? `<option value="">All arms</option>${options(streams, 'id', 'name', filters.stream_id)}` : '<option value="">No arms on this class</option>'}</select></div>
          <div class="field"><label>Gender</label>
            <select id="f-gender"><option value="">All genders</option><option value="Male" ${filters.gender === 'Male' ? 'selected' : ''}>Male</option><option value="Female" ${filters.gender === 'Female' ? 'selected' : ''}>Female</option></select></div>
        </div>
        <div class="spacer"></div>
        <button class="btn secondary" id="print-class">🖨️ Print</button>
        <button class="btn secondary" id="download-class">⬇️ Download Excel</button>
      </div>
      <div class="card" id="roster-card">${loader()}</div>
    `;

    root.querySelector('#back-to-students').onclick = () => renderHome(root, classes, 'active');
    root.querySelector('#f-stream').onchange = (e) => load({ ...filters, stream_id: e.target.value });
    root.querySelector('#f-gender').onchange = (e) => load({ ...filters, gender: e.target.value });
    root.querySelector('#print-class').onclick = () => {
      setNavIntent('class-list', { class_id: cls.id, stream_id: filters.stream_id });
      go('class-list');
    };
    root.querySelector('#download-class').onclick = () => openExportModal({ class_id: cls.id, stream_id: filters.stream_id, gender: filters.gender });

    const res = await Db.students.list({ class_id: cls.id, stream_id: filters.stream_id || undefined, status: 'active' });
    let list = res.ok ? res.data : [];
    if (filters.gender) list = list.filter((s) => s.gender === filters.gender);

    const rosterEl = root.querySelector('#roster-card');
    if (!list.length) {
      rosterEl.innerHTML = `<div class="card-b"><div class="empty">
        <div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this filter yet.</p>
        <button class="btn" id="empty-add-student">+ Add student</button>
      </div></div>`;
      rosterEl.querySelector('#empty-add-student').onclick = () => openAddChoiceModal(root, classes, () => load(filters), { class_id: cls.id, stream_id: filters.stream_id });
      return;
    }

    rosterEl.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Admission No.</th><th>Name</th><th>Gender</th><th>Arm</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr class="clickable-row" data-open-profile="${s.id}">
        <td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td>
        <td>${genderBadge(s.gender)}</td><td>${esc(s.stream_name || '—')}</td>
        <td class="row-actions">
          <button class="btn sm secondary" data-edit="${s.id}">Edit</button>
          <button class="btn sm danger" data-archive="${s.id}">Archive</button>
        </td></tr>`).join('')}</tbody>
    </table></div>`;

    rosterEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openStudentModal(root, classes, { class_id: cls.id, stream_id: filters.stream_id }, list.find((s) => s.id === b.dataset.edit), () => load(filters)); });
    rosterEl.querySelectorAll('[data-archive]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openArchiveModal(root, b.dataset.archive, () => load(filters)); });
    rosterEl.querySelectorAll('[data-open-profile]').forEach((tr) => tr.onclick = () => renderStudentProfile(root, classes, list.find((s) => s.id === tr.dataset.openProfile), () => load(filters)));
  }
}

/** Field-picker modal for "⬇️ Download Excel" (brief §5) — exports exactly
 *  the currently filtered class/stream/gender roster as a real .xlsx
 *  spreadsheet (not CSV), with the admin choosing which columns go in. */
function openExportModal(filters) {
  modal({
    title: 'Download Excel — choose fields',
    body: `<div class="chk-row">${EXPORT_COLS.map((c) => `<label class="chk"><input type="checkbox" data-export-col="${c.key}" ${c.on ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}</div>`,
    okLabel: 'Download',
    onOk: async () => {
      const activeCols = EXPORT_COLS.filter((c) => {
        const cb = document.querySelector(`[data-export-col="${c.key}"]`);
        return cb ? cb.checked : false;
      });
      if (!activeCols.length) { toast('Choose at least one field.', 'err'); return; }
      const res = await Db.students.list({ class_id: filters.class_id || undefined, stream_id: filters.stream_id || undefined, status: 'active' });
      let list = res.ok ? res.data : [];
      if (filters.gender) list = list.filter((s) => s.gender === filters.gender);
      if (!list.length) { toast('No students to export.', 'warn'); return; }
      closeModal();
      downloadXlsx('students-export.xlsx', list, activeCols, 'Students');
    }
  });
}

/** "+ Add student" now asks Single vs Bulk first, instead of always opening
 *  the one-at-a-time form — enrolling a whole new class at once is common
 *  enough (a new intake, promotion day) that it deserves equal billing with
 *  adding one student, not a buried nav link elsewhere. */
function openAddChoiceModal(root, classes, onSaved, presetFilters) {
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
  document.getElementById('choice-single').onclick = () => { closeModal(); openStudentModal(root, classes, presetFilters || {}, undefined, onSaved); };
  document.getElementById('choice-bulk').onclick = () => { closeModal(); go('bulk-upload'); };
}

/** Add/Edit Student. Brief: admission number, gender, name, class and
 *  stream are all required — UNLESS the chosen class has no streams set up,
 *  in which case there's nothing to require. Enforced here client-side for
 *  immediate feedback, and again server-side (students.mjs API) so bulk
 *  upload and any other caller can't skip it either. */
async function openStudentModal(root, classes, filters, existing, onSaved) {
  let streams = existing ? (await Db.streams.list(existing.class_id)).data || [] : (filters.class_id ? (await Db.streams.list(filters.class_id)).data || [] : []);
  renderModal(streams, existing ? existing.class_id : filters.class_id || '', existing ? existing.stream_id : filters.stream_id || '');

  function renderModal(currentStreams, selectedClass, selectedStream) {
    const req = '<span style="color:var(--danger,#c0392b)">*</span>';
    modal({
      title: existing ? 'Edit student' : 'Add student',
      body: `
        <div class="grid2">
          <div class="field"><label>Admission Number ${req}</label><input id="st-adm" value="${esc(existing ? existing.admission_no : '')}"></div>
          <div class="field"><label>Gender ${req}</label><select id="st-gender">${options([{ id: 'Male', name: 'Male' }, { id: 'Female', name: 'Female' }], 'id', 'name', existing ? existing.gender : '', 'Choose gender')}</select></div>
        </div>
        <div class="field"><label>Student Name ${req}</label><input id="st-name" value="${esc(existing ? existing.full_name : '')}"></div>
        <div class="grid2">
          <div class="field"><label>Class ${req}</label><select id="st-class">${options(classes, 'id', 'name', selectedClass, 'Choose a class')}</select></div>
          <div class="field"><label>Arm ${currentStreams.length ? req : '<span class="muted">(none for this class)</span>'}</label><select id="st-stream" ${currentStreams.length ? '' : 'disabled'}>${options(currentStreams, 'id', 'name', selectedStream, currentStreams.length ? 'Choose an arm' : 'No arms on this class')}</select></div>
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
        const admissionNo = document.getElementById('st-adm').value.trim();
        const fullName = document.getElementById('st-name').value.trim();
        const gender = document.getElementById('st-gender').value;
        const classId = document.getElementById('st-class').value;
        const streamSel = document.getElementById('st-stream');
        const streamId = streamSel && !streamSel.disabled ? streamSel.value : '';

        if (!admissionNo) { toast('Admission number is required.', 'err'); return; }
        if (!fullName) { toast('Student name is required.', 'err'); return; }
        if (!gender) { toast('Please choose a gender.', 'err'); return; }
        if (!classId) { toast('Please choose a class.', 'err'); return; }
        if (currentStreams.length && !streamId) { toast('Please choose an arm — this class has arms set up.', 'err'); return; }

        const payload = {
          id: existing ? existing.id : undefined,
          admission_no: admissionNo,
          full_name: fullName,
          gender,
          class_id: classId,
          stream_id: streamId || null,
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
        if (onSaved) onSaved(res.data);
      }
    });

    document.getElementById('st-class').onchange = async (e) => {
      const cid = e.target.value;
      const sres = cid ? await Db.streams.list(cid) : { ok: true, data: [] };
      renderModal(sres.ok ? sres.data : [], cid, '');
    };
  }
}

/** Archive (soft-remove) one student — asks why, so the reason shows up in
 *  the Left/Archived list later. Their results/attendance/parent links are
 *  left completely untouched; only their status flips off the active roster. */
function openArchiveModal(root, studentId, onDone) {
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
      onDone();
    }
  });
}

/** "Move students" — now a top-level action styled exactly like "+ Add
 *  student" (brief: "one must click it first, and then the window pops up
 *  asking for the class to move from/to and the selection of students to
 *  move"). Everything — source class/stream, destination class/stream, and
 *  which students — happens inside this one guided modal; no more
 *  pre-selecting checkboxes on a visible table first. */
/** Round 3 §3: "Apply the same clean redesign already delivered for the
 *  exam class-selection screen to this Move Students list — it currently
 *  looks disjointed the same way that screen did before." Reuses the exact
 *  same card-grid markup/CSS classes (.ex-class-grid/.ex-class-card/
 *  .ex-class-top/.ex-class-check/.ex-class-name — main.css, built for
 *  examDesk.mjs's "which classes are sitting this exam?" picker) rather
 *  than introducing a second, similar-but-different card style — one
 *  student per card, tap-anywhere-on-the-card to toggle, same search +
 *  Select all/Clear toolbar and live count. */
function studentCardHtml(s, selected) {
  const isSelected = selected.has(s.id);
  const searchKey = `${s.admission_no} ${s.full_name}`.toLowerCase();
  return `
    <div class="ex-class-card${isSelected ? ' on' : ''}" data-mv-student-card="${s.id}" data-student-name="${esc(searchKey)}">
      <div class="ex-class-top">
        <span class="ex-class-check">✓</span>
        <input type="checkbox" data-mv-student value="${s.id}" ${isSelected ? 'checked' : ''} style="position:absolute;opacity:0;width:0;height:0">
        <span class="ex-class-name">${esc(s.admission_no)} — ${esc(s.full_name)}${s.stream_name ? ` <span class="muted" style="font-weight:500">(${esc(s.stream_name)})</span>` : ''}</span>
      </div>
    </div>`;
}

function openMoveStudentsModal(root, classes, onDone) {
  let fromClassId = '', fromStreamId = '', toClassId = '', toStreamId = '';
  let fromStreams = [], toStreams = [];
  let students = [];
  let selected = new Set();
  let loadingStudents = false;

  renderModal();

  async function loadFromStudents() {
    if (!fromClassId) { students = []; selected = new Set(); renderModal(); return; }
    loadingStudents = true; renderModal();
    const res = await Db.students.list({ class_id: fromClassId, stream_id: fromStreamId || undefined });
    students = res.ok ? res.data : [];
    selected = new Set();
    loadingStudents = false;
    renderModal();
  }

  function renderModal() {
    modal({
      title: 'Move students',
      wide: true,
      body: `
        <p class="hint" style="margin-top:0">Choose which class/arm to move students from, then tick which ones — same idea as Add Student, everything happens right here.</p>
        <div class="grid2">
          <div class="field"><label>Move from — Class</label><select id="mv-from-class">${options(classes, 'id', 'name', fromClassId, 'Choose a class')}</select></div>
          <div class="field"><label>Arm</label><select id="mv-from-stream" ${fromClassId ? '' : 'disabled'}><option value="">Whole class</option>${options(fromStreams, 'id', 'name', fromStreamId)}</select></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Move to — Class</label><select id="mv-to-class">${options(classes, 'id', 'name', toClassId, 'Choose a class')}</select></div>
          <div class="field"><label>Arm</label><select id="mv-to-stream" ${toClassId ? '' : 'disabled'}><option value="">No arm</option>${options(toStreams, 'id', 'name', toStreamId)}</select></div>
        </div>
        <div class="field">
          <label id="mv-count-label">Students to move${students.length ? ` (${selected.size} of ${students.length} selected)` : ''}</label>
          ${!fromClassId ? '<p class="muted" style="margin:0">Choose a class above to see its students.</p>'
            : loadingStudents ? loader()
            : students.length ? `
              <div class="ex-class-toolbar">
                <div class="field" style="flex:1;margin:0"><input type="text" id="mv-student-search" placeholder="Search students…"></div>
                <button type="button" class="btn secondary sm" id="mv-select-all-btn">Select all</button>
                <button type="button" class="btn secondary sm" id="mv-clear-all-btn">Clear</button>
              </div>
              <div class="ex-class-scroll">
                <div class="ex-class-grid">${students.map((s) => studentCardHtml(s, selected)).join('')}</div>
              </div>
            ` : '<p class="muted" style="margin:0">No students in this class/arm.</p>'}
        </div>
      `,
      okLabel: 'Move',
      onOk: async () => {
        if (!toClassId) { toast('Choose a class to move students to.', 'err'); return; }
        if (!selected.size) { toast('Select at least one student to move.', 'err'); return; }
        const res = await Db.students.bulkMove({ student_ids: [...selected], class_id: toClassId, stream_id: toStreamId || null });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(`Moved ${res.moved} student(s).`, 'ok');
        closeModal();
        onDone();
      }
    });

    document.getElementById('mv-from-class').onchange = async (e) => {
      fromClassId = e.target.value; fromStreamId = '';
      const sres = fromClassId ? await Db.streams.list(fromClassId) : { ok: true, data: [] };
      fromStreams = sres.ok ? sres.data : [];
      await loadFromStudents();
    };
    document.getElementById('mv-from-stream').onchange = async (e) => { fromStreamId = e.target.value; await loadFromStudents(); };
    document.getElementById('mv-to-class').onchange = async (e) => {
      toClassId = e.target.value; toStreamId = '';
      const sres = toClassId ? await Db.streams.list(toClassId) : { ok: true, data: [] };
      toStreams = sres.ok ? sres.data : [];
      renderModal();
    };
    document.getElementById('mv-to-stream').onchange = (e) => { toStreamId = e.target.value; };

    if (!students.length) return;

    const countLabel = document.getElementById('mv-count-label');
    const refreshCount = () => { countLabel.textContent = `Students to move (${selected.size} of ${students.length} selected)`; };
    const syncCardState = (card, cb) => card.classList.toggle('on', cb.checked);

    // Tap anywhere on the card to toggle it, same as the exam
    // class-selection cards this pattern is reused from.
    document.querySelectorAll('[data-mv-student-card]').forEach((card) => {
      const cb = card.querySelector('[data-mv-student]');
      cb.onchange = () => {
        if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
        syncCardState(card, cb);
        refreshCount();
      };
      card.onclick = (e) => {
        if (e.target.tagName === 'INPUT') return; // native checkbox click already toggles + fires onchange
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      };
    });

    document.getElementById('mv-select-all-btn').onclick = () => {
      document.querySelectorAll('[data-mv-student-card]').forEach((card) => {
        if (card.style.display === 'none') return; // respect the active search filter
        const cb = card.querySelector('[data-mv-student]');
        cb.checked = true; selected.add(cb.value);
        syncCardState(card, cb);
      });
      refreshCount();
    };
    document.getElementById('mv-clear-all-btn').onclick = () => {
      document.querySelectorAll('[data-mv-student-card]').forEach((card) => {
        if (card.style.display === 'none') return;
        const cb = card.querySelector('[data-mv-student]');
        cb.checked = false; selected.delete(cb.value);
        syncCardState(card, cb);
      });
      refreshCount();
    };

    document.getElementById('mv-student-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('[data-mv-student-card]').forEach((card) => {
        card.style.display = !q || card.dataset.studentName.indexOf(q) !== -1 ? '' : 'none';
      });
    };
  }
}

/* ============================================================================
 * Student profile (brief §5) — "functioning like a student portal": the
 * full profile (view + edit-in-place via the same Add/Edit Student form)
 * plus every exam this student has results for, with a one-click jump
 * straight to their report form for any of them.
 * ==========================================================================*/
async function renderStudentProfile(root, classes, student, onBack) {
  const examsRes = await Db.results.getStudentExams(student.id);
  const exams = examsRes.ok ? examsRes.data : [];

  const examRows = exams.length ? exams.map((e) => `
    <tr>
      <td>${esc(e.name)}</td>
      <td>${esc(e.academic_year_name)} — ${esc(e.term_name)}</td>
      <td class="row-actions"><button class="btn ghost sm" data-view-report="${e.id}">🧾 View report form</button></td>
    </tr>`).join('') : `<tr><td colspan="3" class="muted center">No results recorded for this student yet.</td></tr>`;

  root.innerHTML = `
    <div class="page-head">
      <div><a class="back-link" id="back-to-students">← Back</a><h2>${esc(student.full_name)}</h2><p>Admission No. ${esc(student.admission_no)} · ${esc(student.class_name)}${student.stream_name ? ' — ' + esc(student.stream_name) : ''}</p></div>
      <div class="spacer"></div><button class="btn" id="edit-profile">✏️ Edit profile</button>
    </div>
    <div class="grid2">
      <div class="card">
        <div class="card-h"><h3>Profile</h3></div>
        <div class="card-b">
          <div class="profile-meta">
            <div><span>Gender</span><span>${esc(student.gender)}</span></div>
            <div><span>Class / Arm</span><span>${esc(student.class_name)}${student.stream_name ? ' — ' + esc(student.stream_name) : ''}</span></div>
            <div><span>Guardian</span><span>${esc(student.guardian_name || student.guardian_contact || '—')}</span></div>
            <div><span>Date of birth</span><span>${esc(student.date_of_birth || '—')}</span></div>
            <div><span>Admission date</span><span>${esc(student.admission_date || '—')}</span></div>
            <div><span>UPI number (NEMIS)</span><span>${esc(student.upi_number || '—')}</span></div>
            <div><span>Assessment number (KNEC)</span><span>${esc(student.assessment_number || '—')}</span></div>
            <div><span>Previous school</span><span>${esc(student.previous_school || '—')}</span></div>
            <div><span>Medical notes</span><span>${esc(student.medical_notes || '—')}</span></div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Results</h3></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Exam</th><th>Year / Term</th><th></th></tr></thead>
          <tbody>${examRows}</tbody>
        </table></div>
      </div>
    </div>
  `;

  root.querySelector('#back-to-students').onclick = onBack;
  root.querySelector('#edit-profile').onclick = () => openStudentModal(root, classes, { class_id: student.class_id, stream_id: student.stream_id }, student, async (saved) => {
    const fresh = await Db.students.get(saved.id);
    renderStudentProfile(root, classes, fresh.ok ? fresh.data : student, onBack);
  });
  root.querySelectorAll('[data-view-report]').forEach((b) => b.onclick = () => {
    setNavIntent('report-forms', { exam_id: b.dataset.viewReport, class_id: student.class_id, student_id: student.id });
    go('reports');
  });
}
