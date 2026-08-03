import { esc, toast, options, renderPrereq, loader, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { SUBMISSION_STATUS_LABELS } from '../lib/api/results.mjs';

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
  render(root, exams, classes, {});
}

function render(root, exams, classes, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Publish Results</h2><p>Approve and publish each subject's marks so parents can see them — nothing is visible to a parent until it's published here.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="pb-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="pb-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field" style="align-self:end"><button class="btn" id="pb-publish-all">🚀 Publish entire exam for this class</button></div>
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
  root.querySelector('#pb-publish-all').onclick = () => {
    const examId = root.querySelector('#pb-exam').value, classId = root.querySelector('#pb-class').value;
    if (!examId || !classId) { toast('Choose an exam and class first.', 'err'); return; }
    confirmAction(
      'Publish every subject for this class at once? Any subject that still needs its normal Submit -> Approve steps first (and you\'re not an admin) will be skipped and reported.',
      async () => {
        const r = await Db.results.publishExam(examId, classId);
        if (!r.ok) { toast(r.message, 'err'); return; }
        toast(`Published ${r.published} of ${r.total} subject(s)${r.failures.length ? ` — ${r.failures.length} could not be published yet` : ''}.`, r.failures.length ? 'warn' : 'ok');
        loadList(root, { exam_id: examId, class_id: classId });
      }
    );
  };

  if (sel.exam_id && sel.class_id) loadList(root, sel);
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

  listEl.innerHTML = `
    <div class="card">
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Subject</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.subject_name)}${r.subject_code ? ' (' + esc(r.subject_code) + ')' : ''}</td>
          <td><span class="badge ${STATUS_BADGE_CLASS[r.status] || 'grey'}">${esc(SUBMISSION_STATUS_LABELS[r.status] || r.status)}</span></td>
          <td class="row-actions">
            ${r.status === 'submitted' ? `<button class="btn ghost sm" data-approve="${r.subject_id}">Approve</button>` : ''}
            ${r.status === 'approved' ? `<button class="btn ghost sm" data-publish="${r.subject_id}">Publish</button>` : ''}
            ${r.status === 'published' ? `<button class="btn ghost sm" data-reopen="${r.subject_id}">Reopen</button>` : ''}
          </td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;

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
