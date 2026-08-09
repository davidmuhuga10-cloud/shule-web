import { esc, toast, options, renderPrereq, loader, confirmAction, modal, closeModal, go, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { SUBMISSION_STATUS_LABELS, RANKING_CRITERIA_LABELS } from '../lib/api/results.mjs';
import { takeNavIntent, setNavIntent } from '../lib/navIntent.mjs';

/** Publish Results — the school-side view of the publishing workflow
 *  (Subject Teacher -> Class Teacher -> Supervisor -> Admin; "Supervisor"
 *  here is any teacher an admin has granted the publish_results capability
 *  to, or an admin). A result only becomes visible to a parent once its
 *  (exam, class, subject) row here reaches "published" — see
 *  result_submissions in migrations/0005_exam_workflow.sql. Every button
 *  below just attempts the move; the database itself is what enforces who
 *  is allowed to do it, so a rejected action simply shows the server's
 *  explanation as a toast. */
const STATUS_BADGE_CLASS = { draft: 'grey', submitted: 'blue', approved: 'blue', published: 'green' };

export async function viewPublishing(root) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  // A "Review & Publish" click from the Manage Exams board hands off exactly
  // which exam+class to open here — see navIntent.mjs.
  const intent = takeNavIntent('publishing') || {};
  render(root, exams, classes, { exam_id: intent.exam_id || '', class_id: intent.class_id || '' });
}

function render(root, exams, classes, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Publish Results</h2><p>Approve and publish each subject's marks so parents can see them — nothing is visible to a parent until it's published here.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="pb-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="pb-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field" style="align-self:end"><button class="btn" id="pb-publish-all">🚀 Publish Results</button></div>
      </div>
    </div>
    <div id="pb-list"></div>
  `;

  const reload = () => {
    const next = { exam_id: root.querySelector('#pb-exam').value, class_id: root.querySelector('#pb-class').value };
    if (next.exam_id && next.class_id) loadList(root, next);
    else root.querySelector('#pb-list').innerHTML = '';
  };
  root.querySelector('#pb-exam').onchange = reload;
  root.querySelector('#pb-class').onchange = reload;
  // Brief Step 10: clicking Publish opens the Publish Results Settings
  // modal first (Ranking Criteria / Deviation Exam / Minimum learning areas
  // / Overall Grading System — deliberately exam+class-wide, never a
  // per-subject grading system per the brief's explicit exception) — those
  // settings are saved BEFORE the actual publish runs, so getBroadsheet()/
  // Exam Analysis pick them up immediately afterwards.
  root.querySelector('#pb-publish-all').onclick = () => {
    const examId = root.querySelector('#pb-exam').value, classId = root.querySelector('#pb-class').value;
    if (!examId || !classId) { toast('Choose an exam and class first.', 'err'); return; }
    openPublishSettingsModal(root, examId, classId);
  };

  if (sel.exam_id && sel.class_id) loadList(root, sel);
}

async function openPublishSettingsModal(root, examId, classId) {
  const [scalesRes, deviationRes, examClassesRes] = await Promise.all([
    Db.grading.listScales(), Db.results.listDeviationExamChoices(examId, classId), Db.results.listExamClasses(examId)
  ]);
  const scales = scalesRes.ok ? scalesRes.data : [];
  const deviationChoices = deviationRes.ok ? deviationRes.data : [];
  const current = (examClassesRes.ok ? examClassesRes.data : []).find((c) => c.class_id === classId) || {};

  modal({
    title: 'Publish Results Settings',
    body: `
      <p class="hint" style="margin-top:0">These apply to every subject in this class for this exam — there is no per-subject grading system, to keep report cards consistent.</p>
      <div class="field"><label>Ranking Criteria</label>
        <select id="ps-ranking">
          <option value="">Mean marks (default)</option>
          ${Object.keys(RANKING_CRITERIA_LABELS).map((k) => `<option value="${k}" ${current.ranking_criteria === k ? 'selected' : ''}>${esc(RANKING_CRITERIA_LABELS[k])}</option>`).join('')}
        </select>
      </div>
      ${deviationChoices.length ? `<div class="field"><label>Deviation Exam (compare against)</label>
        <select id="ps-deviation"><option value="">None</option>${options(deviationChoices, 'id', 'name', current.deviation_exam_id || '')}</select>
      </div>` : ''}
      <div class="field"><label>Minimum learning areas</label>
        <input type="number" min="0" step="1" id="ps-min-subjects" value="${current.min_subjects === null || current.min_subjects === undefined ? '' : current.min_subjects}" placeholder="e.g. 7 — students below this are excluded (X) from analysis">
      </div>
      <div class="field"><label>Overall Grading System</label>
        <select id="ps-grading-scale"><option value="">School default</option>${options(scales, 'id', 'name', current.grading_scale_id || '')}</select>
      </div>
    `,
    okLabel: 'Save and Publish',
    onOk: async () => {
      const settings = {
        ranking_criteria: document.getElementById('ps-ranking').value,
        min_subjects: document.getElementById('ps-min-subjects').value,
        grading_scale_id: document.getElementById('ps-grading-scale').value
      };
      const devSel = document.getElementById('ps-deviation');
      if (devSel) settings.deviation_exam_id = devSel.value;
      const saveRes = await Db.results.savePublishSettings(examId, classId, settings);
      if (!saveRes.ok) { toast(saveRes.message, 'err'); return; }
      const r = await Db.results.publishExam(examId, classId);
      closeModal();
      if (!r.ok) { toast(r.message, 'err'); return; }
      toast(`Published ${r.published} of ${r.total} subject(s)${r.failures.length ? ` — ${r.failures.length} could not be published yet` : ''}.`, r.failures.length ? 'warn' : 'ok');
      loadList(root, { exam_id: examId, class_id: classId });
    }
  });
}

/** Step 11: "Grant Teacher Access" — under an Action menu at the bottom of
 *  the publish screen, an admin can let specific teachers edit their
 *  results again after publishing. Reuses the existing admin-only
 *  reopenSubmission() (draft-reopen) mechanism per-subject rather than a
 *  new parallel "still published but editable" state — simpler and already
 *  covered by the same DB trigger rules. Selectable per learning area, with
 *  a select-all checkbox. */
function openGrantAccessModal(root, sel, rows) {
  const grantable = rows.filter((r) => r.status === 'published' || r.status === 'approved');
  if (!grantable.length) { toast('No published or approved subjects to grant edit access on yet.', 'err'); return; }
  modal({
    title: 'Grant teacher edit access',
    body: `
      <p class="hint" style="margin-top:0">Reopens the chosen subject(s) so their teacher can correct and resubmit them. They'll need to be re-approved and re-published afterwards.</p>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="ga-all"> <b>Select all</b></label>
      ${grantable.map((r) => `<label style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <input type="checkbox" class="ga-subject" value="${r.subject_id}"> ${esc(r.subject_name)} ${r.teacher_name ? `<span class="muted">— ${esc(r.teacher_name)}</span>` : ''}
      </label>`).join('')}
    `,
    okLabel: 'Grant access',
    onOpen: () => {
      const allBox = document.getElementById('ga-all');
      if (allBox) allBox.onchange = () => {
        document.querySelectorAll('.ga-subject').forEach((cb) => { cb.checked = allBox.checked; });
      };
    },
    onOk: async () => {
      const chosen = [...document.querySelectorAll('.ga-subject:checked')].map((cb) => cb.value);
      if (!chosen.length) { toast('Choose at least one subject.', 'err'); return; }
      let done = 0;
      const failures = [];
      for (const subjectId of chosen) {
        const r = await Db.results.reopenSubmission(sel.exam_id, sel.class_id, subjectId);
        if (r.ok) done++; else failures.push(r.message);
      }
      closeModal();
      toast(`Reopened ${done} of ${chosen.length} subject(s)${failures.length ? ' — some could not be reopened' : ''}.`, failures.length ? 'warn' : 'ok');
      loadList(root, sel);
    }
  });
}

/** Step 8's "send reminder" — messages every pending teacher (one still
 *  owing marks on this exam/class) in a single action, instead of an admin
 *  having to message them one at a time. */
async function remindPendingTeachers(root, sel, rows) {
  const pending = rows.filter((r) => r.teacher_staff_id && r.status !== 'published' && !r.complete);
  const byTeacher = {};
  pending.forEach((r) => {
    (byTeacher[r.teacher_staff_id] = byTeacher[r.teacher_staff_id] || { name: r.teacher_name, subjects: [] }).subjects.push(r.subject_name);
  });
  const teacherIds = Object.keys(byTeacher);
  if (!teacherIds.length) { toast('No pending teachers to remind — every assigned subject either has a teacher-independent status or is already complete.', 'err'); return; }
  confirmAction(
    `Send a reminder message to ${teacherIds.length} pending teacher(s) now?`,
    async () => {
      let sent = 0;
      for (const staffId of teacherIds) {
        const t = byTeacher[staffId];
        const body = `Reminder: marks for ${t.subjects.join(', ')} are still pending for this exam. Please enter and submit them as soon as possible.`;
        const r = await Db.messaging.send({ scope: 'individual_staff', staff_id: staffId, body });
        if (r.ok) sent++;
      }
      toast(`Reminder sent to ${sent} of ${teacherIds.length} teacher(s).`, sent ? 'ok' : 'err');
    }
  );
}

async function loadList(root, sel) {
  const listEl = root.querySelector('#pb-list');
  listEl.innerHTML = loader();
  const res = await Db.results.listSubmissions(sel.exam_id, sel.class_id);
  if (!res.ok) { listEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const rows = res.data;

  if (!rows.length) {
    listEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">📝</div><h3>No marks entered yet</h3><p>Enter marks for this exam and class first, then come back to publish them.</p>
    </div></div></div>`;
    return;
  }

  const missing = rows.filter((r) => !r.complete);
  const allPublished = rows.every((r) => r.status === 'published');
  const isAdmin = state.profile && state.profile.role === 'admin';
  // Step 8: "A 'Learning Area without results' table lists zero-upload
  // subjects" — distinct from `missing` (partial progress), this is
  // specifically the subjects nobody has started on at all.
  const noResultsYet = rows.filter((r) => r.entered_count === 0);

  listEl.innerHTML = `
    ${allPublished ? `<div class="card" style="margin-bottom:16px;border-color:var(--ok)"><div class="card-b" style="display:flex;align-items:center;gap:12px">
      <p class="hint" style="margin:0;flex:1"><b>✅ Every subject is published</b> for this class — report cards and analyses are ready to print, nothing further to do here.</p>
      <button class="btn" id="pb-go-reports">🖨️ Go to Report Forms</button>
    </div></div>` : ''}
    ${missing.length ? `<div class="card" style="margin-bottom:16px;border-color:var(--warn)"><div class="card-b" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <p class="hint" style="margin:0;flex:1"><b>⚠️ ${missing.length} subject(s) still have missing marks</b> — ${missing.map((r) => `${esc(r.subject_name)} (${r.entered_count}/${r.expected_count || '?'})`).join(', ')}. You can still publish what's complete, or wait for these to finish.</p>
      <button class="btn secondary sm" id="pb-remind">📣 Remind pending teachers</button>
    </div></div>` : ''}
    ${noResultsYet.length ? `<div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Learning area without results</h3></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Subject</th><th>Teacher</th><th>Missing</th><th></th></tr></thead>
        <tbody>${noResultsYet.map((r) => `<tr>
          <td>${esc(r.subject_name)}</td>
          <td>${r.teacher_name ? esc(r.teacher_name) : '<span class="muted">— unassigned —</span>'}</td>
          <td>${r.expected_count || '?'}</td>
          <td class="row-actions"><button class="btn ghost sm" data-upload="${r.subject_id}">Upload</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}
    <div class="card">
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Subject</th><th>Teacher</th><th>Marks entered</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.subject_name)}${r.subject_code ? ' (' + esc(r.subject_code) + ')' : ''}</td>
          <td>${r.teacher_name ? esc(r.teacher_name) : '<span class="muted">— unassigned —</span>'}</td>
          <td>${r.complete ? `<span class="badge green">${r.entered_count}/${r.expected_count}</span>` : `<span class="badge amber">${r.entered_count}/${r.expected_count || '?'} — incomplete</span>`}</td>
          <td><span class="badge ${STATUS_BADGE_CLASS[r.status] || 'grey'}">${esc(SUBMISSION_STATUS_LABELS[r.status] || r.status)}</span></td>
          <td class="row-actions">
            ${r.status === 'submitted' ? `<button class="btn ghost sm" data-approve="${r.subject_id}">Approve</button>` : ''}
            ${r.status === 'approved' ? `<button class="btn ghost sm" data-publish="${r.subject_id}">Publish</button>` : ''}
            ${r.status === 'draft' ? `<button class="btn ghost sm" data-approve="${r.subject_id}">Approve</button><button class="btn ghost sm" data-publish="${r.subject_id}">Publish</button>` : ''}
            ${r.status === 'published' ? `<button class="btn ghost sm" data-reopen="${r.subject_id}">Reopen</button>` : ''}
            ${isAdmin ? `<button class="btn ghost sm" data-edit="${r.subject_id}">✏️ Edit Marks</button>` : ''}
          </td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    ${isAdmin ? `<div class="card" style="margin-top:16px">
      <div class="card-h"><h3>Action</h3></div>
      <div class="card-b" style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn secondary sm" id="pb-grant-access">🔓 Grant teacher edit access</button>
        <button class="btn secondary sm" id="pb-withdraw">↩️ Withdraw Results</button>
      </div>
    </div>` : ''}`;

  const goReportsBtn = listEl.querySelector('#pb-go-reports');
  if (goReportsBtn) goReportsBtn.onclick = () => {
    setNavIntent('report-forms', { exam_id: sel.exam_id, class_id: sel.class_id });
    go('reports');
  };

  const remindBtn = listEl.querySelector('#pb-remind');
  if (remindBtn) remindBtn.onclick = () => remindPendingTeachers(root, sel, rows);

  const grantBtn = listEl.querySelector('#pb-grant-access');
  if (grantBtn) grantBtn.onclick = () => openGrantAccessModal(root, sel, rows);

  const withdrawBtn = listEl.querySelector('#pb-withdraw');
  if (withdrawBtn) withdrawBtn.onclick = () => confirmAction(
    'Withdraw all published results for this class? They go back to "not submitted" and will no longer be visible to parents until republished.',
    async () => {
      const r = await Db.results.withdrawExam(sel.exam_id, sel.class_id);
      if (r.ok) { toast(`Withdrew ${r.reopened} of ${r.total} subject(s).`, 'ok'); loadList(root, sel); } else toast(r.message, 'err');
    },
    true
  );

  listEl.querySelectorAll('[data-upload]').forEach((b) => b.onclick = () => {
    setNavIntent('marks-entry', { exam_id: sel.exam_id, class_id: sel.class_id, subject_id: b.dataset.upload });
    go('marks');
  });
  listEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    setNavIntent('marks-entry', { exam_id: sel.exam_id, class_id: sel.class_id, subject_id: b.dataset.edit });
    go('marks');
  });

  listEl.querySelectorAll('[data-approve]').forEach((b) => b.onclick = () => confirmAction(
    'Approve this subject\'s results? This confirms the class teacher has reviewed them.',
    async () => {
      const r = await Db.results.approveSubmission(sel.exam_id, sel.class_id, b.dataset.approve);
      if (r.ok) { toast('Approved.', 'ok'); loadList(root, sel); } else toast(r.message, 'err');
    }
  ));
  listEl.querySelectorAll('[data-publish]').forEach((b) => b.onclick = () => confirmAction(
    'Publish this subject\'s results? Parents will be able to see them immediately.',
    async () => {
      const r = await Db.results.publishSubmission(sel.exam_id, sel.class_id, b.dataset.publish);
      if (r.ok) { toast('Published.', 'ok'); loadList(root, sel); } else toast(r.message, 'err');
    }
  ));
  listEl.querySelectorAll('[data-reopen]').forEach((b) => b.onclick = () => confirmAction(
    'Reopen this subject? It goes back to "not submitted" — the class teacher will need to approve and publish it again after any corrections.',
    async () => {
      const r = await Db.results.reopenSubmission(sel.exam_id, sel.class_id, b.dataset.reopen);
      if (r.ok) { toast('Reopened.', 'ok'); loadList(root, sel); } else toast(r.message, 'err');
    },
    true
  ));
}
