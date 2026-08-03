import { esc, toast, options, renderPrereq, loader, confirmAction, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { SUBMISSION_STATUS_LABELS } from '../lib/api/results.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';
import { buildMarkColumns, buildMarksTemplateCsv, parseMarksCsv, matchAndValidate, scoresByColumn } from '../lib/marksCsv.mjs';

const STATUS_BADGE_CLASS = { draft: 'grey', submitted: 'blue', approved: 'blue', published: 'green' };
const STATUS_DOT = { draft: '', submitted: '🟦', approved: '🟦', published: '🟩' };

export async function viewMarks(root) {
  const [examsRes, classesRes, subjectsRes] = await Promise.all([Db.results.listExams(), Db.classes.list(), Db.subjects.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  const subjects = subjectsRes.ok ? subjectsRes.data : [];

  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  if (!subjects.length) { renderPrereq(root, 'No subjects found', 'Open a class\'s stream and assign it some subjects first.', 'classes', 'Go to Classes'); return; }

  // A "🎯 Enter Marks" click from the Manage Exams board hands off exactly
  // which exam+class to open here — see navIntent.mjs. Falls back to the
  // normal blank pickers when opened directly from the sidebar.
  const intent = takeNavIntent('marks-entry') || {};
  render(root, exams, classes, subjects, { exam_id: intent.exam_id || '', class_id: intent.class_id || '', stream_id: '' });
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
 *  its current publishing status and how many students already have a mark. */
async function loadSubjectTabs(examId, classId, allSubjects) {
  const [assignedRes, submissionsRes] = await Promise.all([
    Db.assignments.getClassSubjects(classId),
    Db.results.listSubmissions(examId, classId)
  ]);
  const assignedIds = (assignedRes.ok ? assignedRes.data : []).map((a) => a.subject_id);
  const bySubjectId = {};
  allSubjects.forEach((s) => { bySubjectId[s.id] = s; });
  const pool = assignedIds.length ? assignedIds.map((id) => bySubjectId[id]).filter(Boolean) : allSubjects;
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
        <button class="btn secondary sm" id="mk-bulk-toggle">📥 Bulk upload marks (this class)</button>
      </div>
    </div>
    <div id="mk-bulk-area"></div>
    <div id="mk-grid"></div>
  `;

  panel.querySelectorAll('[data-subject]').forEach((chip) => chip.onclick = () => {
    loadClassPanel(root, exams, classes, subjects, { ...sel, subject_id: chip.dataset.subject });
  });

  let bulkOpen = false;
  panel.querySelector('#mk-bulk-toggle').onclick = () => {
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

    const paperPicker = papers.length ? `<select id="mk-paper" style="margin-left:10px">${options(papers, 'id', 'name', paperId)}</select>` : '';
    const statusNote = status === 'draft' ? '' : `<div class="card-b" style="padding-top:0;padding-bottom:12px">
        <p class="hint">This subject's results are <b>${esc(SUBMISSION_STATUS_LABELS[status] || status)}</b> for this class.
        ${isAdmin ? 'You can save corrected marks here, or reopen it below to let the workflow run again.' : 'You can still save corrected marks here, but ask an admin to reopen it (in Publish Results) so the review can happen again.'}</p>
      </div>`;
    const hasAnyMarks = rows.some((r) => r.score !== '' && r.score !== null && r.score !== undefined);

    gridEl.innerHTML = `
      <div class="card">
        <div class="card-h"><h3>${esc(subject.name)} — marks (out of ${res.out_of})</h3>${paperPicker}
          <span class="badge ${STATUS_BADGE_CLASS[status] || 'grey'}" style="margin-left:10px">${esc(SUBMISSION_STATUS_LABELS[status] || status)}</span>
          <div class="spacer"></div>
          ${status === 'draft' ? '<button class="btn secondary" id="mk-submit">Submit for approval</button>' : ''}
          ${status !== 'draft' && isAdmin ? '<button class="btn secondary" id="mk-reopen">Reopen</button>' : ''}
          ${hasAnyMarks && status !== 'published' ? '<button class="btn danger sm" id="mk-delete-all">🗑️ Delete All Results</button>' : ''}
          <button class="btn" id="mk-save">Save marks</button></div>
        ${statusNote}
        <div class="card-b table-wrap"><table class="data">
          <thead><tr><th class="num">#</th><th>Admission No.</th><th>Name</th><th class="num" style="width:120px">Score</th><th>Grade</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr>
            <td class="num">${i + 1}</td><td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td>
            <td><input type="number" min="0" max="${res.out_of}" step="0.5" value="${esc(r.score)}" data-student="${r.student_id}" style="text-align:center"></td>
            <td><span class="badge blue" data-grade="${r.student_id}">${esc(r.grade_label || '—')}</span></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;

    const paperSel = gridEl.querySelector('#mk-paper');
    if (paperSel) paperSel.onchange = (e) => { paperId = e.target.value; renderGridForPaper(); };

    gridEl.querySelector('#mk-save').onclick = async () => {
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
    if (submitBtn) submitBtn.onclick = () => confirmAction(
      'Submit this subject\'s marks for approval? The class teacher (or an admin) will review before they can be published to parents.',
      async () => {
        const r = await Db.results.submitForApproval(examId, classId, subject.id);
        if (r.ok) { toast('Submitted for approval.', 'ok'); renderGridForPaper(); } else toast(r.message, 'err');
      }
    );
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
