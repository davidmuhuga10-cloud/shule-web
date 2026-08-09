import { esc, toast, options, renderPrereq, loader, confirmAction, modal, closeModal, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { SUBMISSION_STATUS_LABELS } from '../lib/api/results.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';
import { buildMarkColumns, buildMarksTemplateCsv, parseMarksCsv, matchAndValidate, scoresByColumn } from '../lib/marksCsv.mjs';

/** Brief Step 5's "spreadsheet upload should be a PC-only option; on phone,
 *  only key-in should be offered" — a pragmatic, no-library heuristic
 *  (coarse pointer = touch-primary device) rather than literal user-agent
 *  sniffing, which is trivially spoofable and actively discouraged; this is
 *  just a UX nudge (a phone CAN still technically drive a file picker), not
 *  a security boundary, so an approximation is the right level of effort. */
function isLikelyPc() {
  try { return !window.matchMedia('(pointer: coarse)').matches; } catch (e) { return true; }
}

const STATUS_BADGE_CLASS = { draft: 'grey', submitted: 'blue', approved: 'blue', published: 'green' };
const STATUS_DOT = { draft: '', submitted: '🟦', approved: '🟦', published: '🟩' };

// Step 4/12: which subjects a non-admin teacher sees here is gated by
// Settings > Permissions' "Show all school reports to all teachers" toggle
// — fetched once per view-load (it doesn't change mid-session) rather than
// threaded as an extra parameter through every render/load function below.
let teachersSeeAllReports = false;

export async function viewMarks(root) {
  const [examsRes, classesRes, subjectsRes, settingsRes] = await Promise.all([
    Db.results.listExams(), Db.classes.list(), Db.subjects.list(), Db.settings.get()
  ]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  const subjects = subjectsRes.ok ? subjectsRes.data : [];
  teachersSeeAllReports = settingsRes.ok && String(settingsRes.data.teachers_see_all_reports) === 'true';

  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  if (!subjects.length) { renderPrereq(root, 'No subjects found', 'Open a class\'s stream and assign it some subjects first.', 'classes', 'Go to Classes'); return; }

  // A "🎯 Enter Marks" click from the Manage Exams board hands off exactly
  // which exam+class to open here — see navIntent.mjs. An admin's "Edit
  // Marks" quick-link from Publish Results (Step 9) additionally hands off
  // a specific subject_id, so it lands straight on that subject's grid
  // instead of whichever one happens to sort first. Falls back to the
  // normal blank pickers when opened directly from the sidebar.
  const intent = takeNavIntent('marks-entry') || {};
  render(root, exams, classes, subjects, { exam_id: intent.exam_id || '', class_id: intent.class_id || '', stream_id: '', subject_id: intent.subject_id || '' });
}

function render(root, exams, classes, subjects, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Enter Marks</h2><p>Choose an exam and class, then pick any subject to mark — every subject assigned to the class is available here, no need to hunt through a separate menu.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="mk-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="mk-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Stream (optional)</label><select id="mk-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Whole class</option></select></div>
      </div>
    </div>
    <div id="mk-panel"></div>
  `;

  const classSel = root.querySelector('#mk-class'), streamSel = root.querySelector('#mk-stream');

  async function refreshStreams(cid) {
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Whole class</option>'; return; }
    const sres = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Whole class</option>' + options(sres.ok ? sres.data : [], 'id', 'name', '');
  }
  if (sel.class_id) refreshStreams(sel.class_id);

  const reload = () => {
    const next = {
      exam_id: root.querySelector('#mk-exam').value,
      class_id: root.querySelector('#mk-class').value,
      stream_id: root.querySelector('#mk-stream').value
    };
    if (next.exam_id && next.class_id) loadClassPanel(root, exams, classes, subjects, next);
    else root.querySelector('#mk-panel').innerHTML = '';
  };

  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  root.querySelector('#mk-exam').onchange = reload;

  if (sel.exam_id && sel.class_id) loadClassPanel(root, exams, classes, subjects, sel);
}

/** Every subject assigned to the class (falling back to every subject in
 *  the school if none have been explicitly assigned yet — an unconfigured
 *  class should never BLOCK marks entry, just not pre-narrow it), each with
 *  its current publishing status and how many students already have a mark.
 *
 *  Brief Step 4: "a teacher should see only the exams and subjects actually
 *  assigned to them" — an admin (or a teacher when Settings > Permissions'
 *  "Show all school reports to all teachers" is on) still sees every
 *  assigned-to-the-class subject exactly as before; a plain teacher is
 *  further narrowed down to subject_teacher_assignments rows naming THEM
 *  specifically for this class. Reassigning a subject to a different
 *  teacher is picked up live (this list is rebuilt fresh on every
 *  load, never cached), matching Step 4's "disappear from the original
 *  teacher's list and appear on the newly assigned teacher's list
 *  automatically." A teacher with zero subjects assigned to them in an
 *  otherwise-configured class sees none here — that's the point of the
 *  filter, not a bug. */
async function loadSubjectTabs(examId, classId, allSubjects) {
  const [assignedRes, submissionsRes] = await Promise.all([
    Db.assignments.getClassSubjects(classId),
    Db.results.listSubmissions(examId, classId)
  ]);
  const classAssignedIds = (assignedRes.ok ? assignedRes.data : []).map((a) => a.subject_id);
  const isAdmin = state.profile && state.profile.role === 'admin';

  let poolIds;
  if (classAssignedIds.length) poolIds = classAssignedIds;
  else if (isAdmin || teachersSeeAllReports) poolIds = allSubjects.map((s) => s.id);
  else poolIds = [];

  if (!isAdmin && !teachersSeeAllReports && state.profile && state.profile.staff_id) {
    const mineRes = await Db.assignments.listTeacherAssignments({ staff_id: state.profile.staff_id, class_id: classId });
    const mineIds = new Set((mineRes.ok ? mineRes.data : []).map((a) => a.subject_id));
    poolIds = poolIds.filter((id) => mineIds.has(id));
  }

  const bySubjectId = {};
  allSubjects.forEach((s) => { bySubjectId[s.id] = s; });
  const pool = poolIds.map((id) => bySubjectId[id]).filter(Boolean);
  const statusRows = submissionsRes.ok ? submissionsRes.data : [];
  const statusBySubject = {};
  statusRows.forEach((r) => { statusBySubject[r.subject_id] = r; });
  return pool.map((s) => ({ ...s, submission: statusBySubject[s.id] || null }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function loadClassPanel(root, exams, classes, subjects, sel) {
  const panel = root.querySelector('#mk-panel');
  panel.innerHTML = loader();

  const subjectTabs = await loadSubjectTabs(sel.exam_id, sel.class_id, subjects);
  if (!subjectTabs.length) {
    panel.innerHTML = `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">📚</div><h3>No subjects found</h3><p>Add subjects to the school (or assign some to this class) first.</p>
    </div></div></div>`;
    return;
  }
  const activeSubjectId = sel.subject_id && subjectTabs.some((s) => s.id === sel.subject_id) ? sel.subject_id : subjectTabs[0].id;

  panel.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-b">
        <div class="chips" id="mk-subject-chips">${subjectTabs.map((s) => `
          <span class="chip ${s.id === activeSubjectId ? 'on' : ''}" data-subject="${s.id}">
            ${s.submission ? (STATUS_DOT[s.submission.status] || '') : ''} ${esc(s.name)}
            ${s.submission ? `<small style="opacity:.8">${s.submission.entered_count}/${s.submission.expected_count || '?'}</small>` : ''}
          </span>`).join('')}</div>
      </div>
      <div class="modal-f" style="border-top:1px solid var(--line);justify-content:flex-start">
        ${isLikelyPc()
          ? '<button class="btn secondary sm" id="mk-bulk-toggle">📥 Bulk upload marks (this class)</button>'
          : '<span class="hint" style="margin:0">Spreadsheet bulk upload is available on a computer — key in marks here on a phone/tablet.</span>'}
      </div>
    </div>
    <div id="mk-bulk-area"></div>
    <div id="mk-grid"></div>
  `;

  panel.querySelectorAll('[data-subject]').forEach((chip) => chip.onclick = () => {
    loadClassPanel(root, exams, classes, subjects, { ...sel, subject_id: chip.dataset.subject });
  });

  let bulkOpen = false;
  const bulkToggleBtn = panel.querySelector('#mk-bulk-toggle');
  if (bulkToggleBtn) bulkToggleBtn.onclick = () => {
    bulkOpen = !bulkOpen;
    const area = panel.querySelector('#mk-bulk-area');
    if (bulkOpen) { renderBulkUpload(area, sel, subjectTabs); panel.querySelector('#mk-grid').style.display = 'none'; }
    else { area.innerHTML = ''; panel.querySelector('#mk-grid').style.display = ''; }
  };

  await loadGrid(root, panel, sel.exam_id, sel.class_id, sel.stream_id, subjectTabs.find((s) => s.id === activeSubjectId));
}

async function loadGrid(root, panel, examId, classId, streamId, subject) {
  const gridEl = panel.querySelector('#mk-grid');
  gridEl.innerHTML = loader();

  let paperId = '';
  const papersRes = await Db.subjectPapers.list(subject.id);
  const papers = papersRes.ok ? papersRes.data : [];
  if (papers.length) paperId = papers[0].id;

  await renderGridForPaper();

  async function renderGridForPaper() {
    const sel = { exam_id: examId, class_id: classId, stream_id: streamId, subject_id: subject.id, paper_id: paperId };
    const [res, statusRes] = await Promise.all([
      Db.results.getResultsEntry(sel),
      Db.results.getSubmissionStatus(examId, classId, subject.id)
    ]);
    if (!res.ok) { gridEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
    const rows = res.data;
    const status = statusRes.ok ? statusRes.data.status : 'draft';
    const isAdmin = state.profile && state.profile.role === 'admin';

    if (!rows.length) {
      gridEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty">
        <div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/stream yet.</p>
      </div></div></div>`;
      return;
    }

    const hasAnyMarks = rows.some((r) => r.score !== '' && r.score !== null && r.score !== undefined);

    // Step 5: "the teacher must set Maximum Marks for that subject before
    // entering scores" — a paper-less subject with no Maximum Marks set yet
    // and no scores recorded yet is BLOCKED from the grid entirely (a
    // confirmed number has to exist before anyone types anything, otherwise
    // the system silently assumes "out of 100" as the brief warns against).
    // Once marks already exist (imported, or set under an earlier default)
    // we no longer hard-block — that would strand real data behind a wall —
    // we just show a non-blocking hint so it can still be corrected.
    if (!papers.length && !res.max_marks_set && !hasAnyMarks) {
      gridEl.innerHTML = `
        <div class="card">
          <div class="card-h"><h3>${esc(subject.name)} — set Maximum Marks first</h3></div>
          <div class="card-b">
            <p class="hint" style="margin-top:0">Before any scores can be entered for <b>${esc(subject.name)}</b> in this class, set what the marks are out of (e.g. 100, 50, 30). This avoids the system silently assuming "out of 100" for every subject.</p>
            <div class="field" style="max-width:220px"><label>Maximum Marks</label><input type="number" min="1" step="1" id="mk-maxmarks-input" placeholder="e.g. 100"></div>
            <button class="btn" id="mk-maxmarks-save" style="margin-top:10px">Save and continue</button>
          </div>
        </div>`;
      gridEl.querySelector('#mk-maxmarks-save').onclick = async () => {
        const val = gridEl.querySelector('#mk-maxmarks-input').value;
        if (!val || Number(val) <= 0) { toast('Enter a positive Maximum Marks value.', 'err'); return; }
        const r = await Db.results.setMaxMarks(examId, classId, subject.id, val);
        if (!r.ok) { toast(r.message, 'err'); return; }
        toast('Maximum Marks set.', 'ok');
        renderGridForPaper();
      };
      return;
    }
    const maxMarksHint = (!papers.length && !res.max_marks_set && hasAnyMarks) ? `
      <div class="card-b" style="padding-top:0;padding-bottom:12px">
        <p class="hint" style="color:var(--danger)">⚠️ No Maximum Marks has been confirmed for this subject yet — marks below are currently treated as out of ${res.out_of} (the exam default).
        <a href="#" id="mk-maxmarks-fix">Set it now</a></p>
      </div>` : '';

    const canEdit = isAdmin || status === 'draft';
    const paperPicker = papers.length ? `<select id="mk-paper" style="margin-left:10px">${options(papers, 'id', 'name', paperId)}</select>` : '';
    const statusNote = status === 'draft' ? '' : `<div class="card-b" style="padding-top:0;padding-bottom:12px">
        <p class="hint">This subject's results are <b>${esc(SUBMISSION_STATUS_LABELS[status] || status)}</b> for this class.
        ${isAdmin ? 'You can save corrected marks here, or reopen it below to let the workflow run again.' : 'Editing is locked now that this has been submitted — ask an admin to reopen it (in Publish Results) if a correction is needed.'}</p>
      </div>`;

    gridEl.innerHTML = `
      <div class="card">
        <div class="card-h"><h3>${esc(subject.name)} — marks (out of ${res.out_of})</h3>${paperPicker}
          <span class="badge ${STATUS_BADGE_CLASS[status] || 'grey'}" style="margin-left:10px">${esc(SUBMISSION_STATUS_LABELS[status] || status)}</span>
          <div class="spacer"></div>
          ${status === 'draft' && canEdit ? '<button class="btn secondary" id="mk-submit">Submit for approval</button>' : ''}
          ${status !== 'draft' && isAdmin ? '<button class="btn secondary" id="mk-reopen">Reopen</button>' : ''}
          ${hasAnyMarks && status !== 'published' && canEdit ? '<button class="btn danger sm" id="mk-delete-all">🗑️ Delete All Results</button>' : ''}
          ${canEdit ? '<button class="btn" id="mk-save">Save marks</button>' : ''}</div>
        ${statusNote}
        ${maxMarksHint}
        <div class="card-b table-wrap"><table class="data">
          <thead><tr><th class="num">#</th><th>Admission No.</th><th>Name</th><th class="num" style="width:120px">Score</th><th>Grade</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr>
            <td class="num">${i + 1}</td><td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td>
            <td><input type="number" min="0" max="${res.out_of}" step="0.5" value="${esc(r.score)}" data-student="${r.student_id}" style="text-align:center" ${canEdit ? '' : 'disabled'}></td>
            <td><span class="badge blue" data-grade="${r.student_id}">${esc(r.grade_label || '—')}</span></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;

    const paperSel = gridEl.querySelector('#mk-paper');
    if (paperSel) paperSel.onchange = (e) => { paperId = e.target.value; renderGridForPaper(); };
    const maxMarksFixLink = gridEl.querySelector('#mk-maxmarks-fix');
    if (maxMarksFixLink) maxMarksFixLink.onclick = (e) => {
      e.preventDefault();
      modal({
        title: 'Set Maximum Marks',
        body: `<div class="field"><label>Maximum Marks for ${esc(subject.name)}</label><input type="number" min="1" step="1" id="mk-maxmarks-input2" value="${res.out_of}"></div>`,
        okLabel: 'Save',
        onOk: async () => {
          const val = document.getElementById('mk-maxmarks-input2').value;
          if (!val || Number(val) <= 0) { toast('Enter a positive Maximum Marks value.', 'err'); return; }
          const r = await Db.results.setMaxMarks(examId, classId, subject.id, val);
          if (!r.ok) { toast(r.message, 'err'); return; }
          closeModal();
          toast('Maximum Marks set.', 'ok');
          renderGridForPaper();
        }
      });
    };

    if (canEdit) gridEl.querySelector('#mk-save').onclick = async () => {
      const inputs = [...gridEl.querySelectorAll('input[data-student]')];
      const invalid = inputs.filter((i) => i.value !== '' && (isNaN(Number(i.value)) || Number(i.value) < 0 || Number(i.value) > res.out_of));
      if (invalid.length) { toast(`${invalid.length} score(s) are out of range (0–${res.out_of}).`, 'err'); return; }
      const scores = inputs.map((i) => ({ student_id: i.dataset.student, score: i.value }));
      const saveRes = await Db.results.saveResultsEntry({
        exam_id: examId, class_id: classId, subject_id: subject.id, paper_id: paperId || null, scores
      });
      if (!saveRes.ok) { toast(saveRes.message, 'err'); return; }
      toast(`Saved ${saveRes.saved} score(s)${saveRes.cleared ? `, cleared ${saveRes.cleared}` : ''}.`, 'ok');
      renderGridForPaper();
    };

    const submitBtn = gridEl.querySelector('#mk-submit');
    if (submitBtn) submitBtn.onclick = () => {
      const inputs = [...gridEl.querySelectorAll('input[data-student]')];
      const previewRows = inputs.map((inp, i) => ({ admission_no: rows[i].admission_no, full_name: rows[i].full_name, score: inp.value }));
      modal({
        title: `Preview — ${subject.name}`,
        body: `
          <p class="hint" style="margin-top:0">This is what will be submitted for approval. Use Edit to go back and change anything first — once this is confirmed, editing locks until an admin reopens it.</p>
          <div class="table-wrap" style="max-height:360px;overflow:auto"><table class="data">
            <thead><tr><th class="num">#</th><th>Admission No.</th><th>Name</th><th class="num">Score</th></tr></thead>
            <tbody>${previewRows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td class="num">${esc(r.score === '' ? '—' : r.score)}</td></tr>`).join('')}</tbody>
          </table></div>`,
        okLabel: 'Confirm and submit',
        cancelLabel: 'Edit',
        onOk: async () => {
          const r = await Db.results.submitForApproval(examId, classId, subject.id);
          if (r.ok) { closeModal(); toast('Submitted for approval.', 'ok'); renderGridForPaper(); } else { toast(r.message, 'err'); }
        }
      });
    };
    const reopenBtn = gridEl.querySelector('#mk-reopen');
    if (reopenBtn) reopenBtn.onclick = () => confirmAction(
      'Reopen this subject? It goes back to "not submitted" so it can be corrected, resubmitted and re-approved.',
      async () => {
        const r = await Db.results.reopenSubmission(examId, classId, subject.id);
        if (r.ok) { toast('Reopened.', 'ok'); renderGridForPaper(); } else toast(r.message, 'err');
      },
      true
    );
    const deleteAllBtn = gridEl.querySelector('#mk-delete-all');
    if (deleteAllBtn) deleteAllBtn.onclick = () => confirmAction(
      `Delete ALL recorded marks for ${subject.name} in this class? This cannot be undone — use this for a genuine re-do, not a small correction (edit the cell above instead for that).`,
      async () => {
        const r = await Db.results.deleteAllResults(examId, classId, subject.id);
        if (r.ok) { toast(`Deleted ${r.deleted} mark(s).`, 'ok'); renderGridForPaper(); } else toast(r.message, 'err');
      },
      true
    );
  }
}

/** Bulk Upload Marks — one file covers every subject (and paper) assigned
 *  to the class at once, instead of uploading subject-by-subject. Same
 *  download-template -> fill in -> upload -> preview -> import shape as the
 *  student bulk upload, just with one column per subject/paper instead of
 *  one row per student being the only unit. */
async function renderBulkUpload(area, sel, subjectTabs) {
  area.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="card-b">${loader()}</div></div>`;

  const [studentsRes, papersLists] = await Promise.all([
    Db.students.list({ class_id: sel.class_id, stream_id: sel.stream_id || undefined }),
    Promise.all(subjectTabs.map((s) => Db.subjectPapers.list(s.id)))
  ]);
  const students = studentsRes.ok ? studentsRes.data : [];
  const papersBySubjectId = {};
  subjectTabs.forEach((s, i) => { papersBySubjectId[s.id] = papersLists[i].ok ? papersLists[i].data : []; });
  const columns = buildMarkColumns(subjectTabs, papersBySubjectId);

  if (!students.length) {
    area.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="card-b"><div class="empty">
      <div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/stream yet.</p>
    </div></div></div>`;
    return;
  }

  // Pre-fill the template with whatever's already been entered, so
  // re-downloading after partial entry doesn't wipe out existing marks.
  const existingByColumn = await Promise.all(columns.map((c) => Db.results.getResultsEntry({
    exam_id: sel.exam_id, class_id: sel.class_id, stream_id: sel.stream_id, subject_id: c.subject_id, paper_id: c.paper_id
  })));
  const existingScores = {};
  columns.forEach((c, i) => {
    const rows = existingByColumn[i].ok ? existingByColumn[i].data : [];
    rows.forEach((r) => {
      existingScores[r.student_id] = existingScores[r.student_id] || {};
      if (r.score !== '' && r.score !== null && r.score !== undefined) existingScores[r.student_id][c.key] = r.score;
    });
  });
  columns.forEach((c, i) => {
    const outOfSource = existingByColumn[i];
    c.out_of = outOfSource && outOfSource.ok ? outOfSource.out_of : 100;
  });

  area.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Bulk upload marks</h3><div class="spacer"></div>
        <button class="btn secondary sm" id="bm-template">⬇ Download template</button></div>
      <div class="card-b">
        <p class="hint" style="margin-top:0">One row per student, one column per subject${columns.some((c) => c.paper_id) ? ' (or subject/paper)' : ''} — download, fill in the marks in Excel/Sheets, then upload the same file back. Any marks already entered are pre-filled.</p>
        <input id="bm-file" type="file" accept=".csv,text/csv">
        <button class="btn" id="bm-preview" style="margin-top:10px">Preview</button>
      </div>
    </div>
    <div id="bm-preview-area"></div>
  `;

  area.querySelector('#bm-template').onclick = () => {
    const csv = buildMarksTemplateCsv(students, columns, existingScores);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'shule-marks-upload-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  area.querySelector('#bm-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseMarksCsv(text, columns);
    if (!parsed.length) { toast('No rows found in that file.', 'err'); return; }
    const { matched, unmatched } = matchAndValidate(parsed, students, columns);
    renderBulkPreview(area, sel, columns, matched, unmatched);
  };
}

function renderBulkPreview(area, sel, columns, matched, unmatched) {
  const totalCells = matched.reduce((acc, r) => acc + Object.keys(r.scores).filter((k) => String(r.scores[k]).trim() !== '').length, 0);
  const badCells = matched.reduce((acc, r) => acc + Object.keys(r.cellErrors).length, 0);

  const previewArea = area.querySelector('#bm-preview-area');
  previewArea.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Preview (${matched.length} student row(s) matched, ${totalCells - badCells} mark(s) ready${badCells ? `, ${badCells} flagged` : ''})</h3>
        <div class="spacer"></div>
        <button class="btn" id="bm-import" ${matched.length ? '' : 'disabled'}>Import marks</button>
      </div>
      ${unmatched.length ? `<div class="card-b" style="padding-bottom:0"><p class="hint" style="color:var(--danger)">${unmatched.length} row(s) didn't match any student in this class by admission number and will be skipped.</p></div>` : ''}
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Admission No.</th><th>Name</th>${columns.map((c) => `<th>${esc(c.header)}</th>`).join('')}</tr></thead>
        <tbody>${matched.map((r) => `<tr>
          <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td>
          ${columns.map((c) => `<td style="${r.cellErrors[c.key] ? 'background:var(--danger-bg)' : ''}">${esc(r.scores[c.key] || '')}${r.cellErrors[c.key] ? ` <span class="badge red">${esc(r.cellErrors[c.key])}</span>` : ''}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
  `;

  previewArea.querySelector('#bm-import').onclick = async () => {
    const btn = previewArea.querySelector('#bm-import');
    btn.disabled = true; btn.textContent = 'Importing…';
    const byColumn = scoresByColumn(matched, columns);
    let saved = 0;
    for (const c of columns) {
      const scores = byColumn[c.key];
      if (!scores.length) continue;
      const r = await Db.results.saveResultsEntry({ exam_id: sel.exam_id, class_id: sel.class_id, subject_id: c.subject_id, paper_id: c.paper_id, scores });
      if (r.ok) saved += r.saved;
    }
    toast(`Imported ${saved} mark(s).`, 'ok');
    previewArea.innerHTML = `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">✅</div><h3>Import complete</h3><p>${saved} mark(s) saved. Reload this page's subject tabs (switch class/exam and back) to see updated status, or click a subject above.</p>
    </div></div></div>`;
  };
}
