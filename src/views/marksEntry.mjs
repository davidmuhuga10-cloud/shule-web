import { esc, toast, options, renderPrereq, loader, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { SUBMISSION_STATUS_LABELS } from '../lib/api/results.mjs';

const STATUS_BADGE_CLASS = { draft: 'grey', submitted: 'blue', approved: 'blue', published: 'green' };

export async function viewMarks(root) {
  const [examsRes, classesRes, subjectsRes] = await Promise.all([Db.results.listExams(), Db.classes.list(), Db.subjects.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  const subjects = subjectsRes.ok ? subjectsRes.data : [];

  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  if (!subjects.length) { renderPrereq(root, 'No subjects found', 'Please add subjects first.', 'subjects', 'Go to Subjects'); return; }

  render(root, exams, classes, subjects, {});
}

function render(root, exams, classes, subjects, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Enter Marks</h2><p>Choose an exam, class and subject to load the entry grid.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="mk-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="mk-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Stream (optional)</label><select id="mk-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Whole class</option></select></div>
      </div>
      <div class="card-b" style="padding-top:0"><div class="grid3">
        <div class="field"><label>Subject</label><select id="mk-subject">${options(subjects, 'id', 'name', sel.subject_id, 'Choose a subject')}</select></div>
        <div class="field" id="mk-paper-wrap" style="display:none"><label>Paper</label><select id="mk-paper"></select></div>
      </div></div>
    </div>
    <div id="mk-grid"></div>
  `;

  const classSel = root.querySelector('#mk-class'), streamSel = root.querySelector('#mk-stream');
  const subjectSel = root.querySelector('#mk-subject');
  const paperWrap = root.querySelector('#mk-paper-wrap'), paperSel = root.querySelector('#mk-paper');

  async function refreshStreams(cid) {
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Whole class</option>'; return; }
    const sres = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Whole class</option>' + options(sres.ok ? sres.data : [], 'id', 'name', '');
  }
  if (sel.class_id) refreshStreams(sel.class_id);

  async function refreshPapers(subjectId) {
    if (!subjectId) { paperWrap.style.display = 'none'; paperSel.innerHTML = ''; return; }
    const pres = await Db.subjectPapers.list(subjectId);
    const papers = pres.ok ? pres.data : [];
    if (!papers.length) { paperWrap.style.display = 'none'; paperSel.innerHTML = ''; return; }
    paperWrap.style.display = '';
    paperSel.innerHTML = options(papers, 'id', 'name', '');
  }
  if (sel.subject_id) refreshPapers(sel.subject_id);

  const reload = () => {
    const next = {
      exam_id: root.querySelector('#mk-exam').value,
      class_id: root.querySelector('#mk-class').value,
      stream_id: root.querySelector('#mk-stream').value,
      subject_id: root.querySelector('#mk-subject').value,
      paper_id: paperWrap.style.display !== 'none' ? paperSel.value : ''
    };
    if (next.exam_id && next.class_id && next.subject_id) loadGrid(root, next);
    else root.querySelector('#mk-grid').innerHTML = '';
  };

  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  root.querySelector('#mk-exam').onchange = reload;
  subjectSel.onchange = async (e) => { await refreshPapers(e.target.value); reload(); };
  paperSel.onchange = reload;

  if (sel.exam_id && sel.class_id && sel.subject_id) loadGrid(root, sel);
}

async function loadGrid(root, sel) {
  const gridEl = root.querySelector('#mk-grid');
  gridEl.innerHTML = loader();

  const [res, statusRes] = await Promise.all([
    Db.results.getResultsEntry(sel),
    Db.results.getSubmissionStatus(sel.exam_id, sel.class_id, sel.subject_id)
  ]);
  if (!res.ok) { gridEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const rows = res.data;
  const status = statusRes.ok ? statusRes.data.status : 'draft';

  if (!rows.length) {
    gridEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/stream yet.</p>
    </div></div></div>`;
    return;
  }

  const statusNote = status === 'draft' ? '' : `<div class="card-b" style="padding-top:0;padding-bottom:12px">
      <p class="hint">This subject's results are <b>${esc(SUBMISSION_STATUS_LABELS[status] || status)}</b> for this class. You can still save corrected marks here, but ask an admin to reopen it (in Publish Results) so the review can happen again.</p>
    </div>`;

  gridEl.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Marks (out of ${res.out_of})</h3>
        <span class="badge ${STATUS_BADGE_CLASS[status] || 'grey'}" style="margin-left:10px">${esc(SUBMISSION_STATUS_LABELS[status] || status)}</span>
        <div class="spacer"></div>
        ${status === 'draft' ? '<button class="btn secondary" id="mk-submit">Submit for approval</button>' : ''}
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

  gridEl.querySelector('#mk-save').onclick = async () => {
    const inputs = [...gridEl.querySelectorAll('input[data-student]')];
    const invalid = inputs.filter((i) => i.value !== '' && (isNaN(Number(i.value)) || Number(i.value) < 0 || Number(i.value) > res.out_of));
    if (invalid.length) { toast(`${invalid.length} score(s) are out of range (0–${res.out_of}).`, 'err'); return; }
    const scores = inputs.map((i) => ({ student_id: i.dataset.student, score: i.value }));
    const saveRes = await Db.results.saveResultsEntry({
      exam_id: sel.exam_id, class_id: sel.class_id, subject_id: sel.subject_id, paper_id: sel.paper_id || null, scores
    });
    if (!saveRes.ok) { toast(saveRes.message, 'err'); return; }
    toast(`Saved ${saveRes.saved} score(s)${saveRes.cleared ? `, cleared ${saveRes.cleared}` : ''}.`, 'ok');
    loadGrid(root, sel);
  };

  const submitBtn = gridEl.querySelector('#mk-submit');
  if (submitBtn) submitBtn.onclick = () => confirmAction(
    'Submit this subject\'s marks for approval? The class teacher (or an admin) will review before they can be published to parents.',
    async () => {
      const r = await Db.results.submitForApproval(sel.exam_id, sel.class_id, sel.subject_id);
      if (r.ok) { toast('Submitted for approval.', 'ok'); loadGrid(root, sel); } else toast(r.message, 'err');
    }
  );
}
