import { esc, toast, options, renderPrereq, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

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
      <div class="card-b" style="padding-top:0"><div class="field" style="max-width:280px"><label>Subject</label><select id="mk-subject">${options(subjects, 'id', 'name', sel.subject_id, 'Choose a subject')}</select></div></div>
    </div>
    <div id="mk-grid"></div>
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
      stream_id: root.querySelector('#mk-stream').value,
      subject_id: root.querySelector('#mk-subject').value
    };
    if (next.exam_id && next.class_id && next.subject_id) loadGrid(root, next);
    else root.querySelector('#mk-grid').innerHTML = '';
  };

  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  root.querySelector('#mk-exam').onchange = reload;
  root.querySelector('#mk-subject').onchange = reload;

  if (sel.exam_id && sel.class_id && sel.subject_id) loadGrid(root, sel);
}

async function loadGrid(root, sel) {
  const gridEl = root.querySelector('#mk-grid');
  gridEl.innerHTML = loader();
  const res = await Db.results.getResultsEntry(sel);
  if (!res.ok) { gridEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const rows = res.data;

  if (!rows.length) {
    gridEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/stream yet.</p>
    </div></div></div>`;
    return;
  }

  gridEl.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Marks (out of ${res.out_of})</h3><div class="spacer"></div><button class="btn" id="mk-save">Save marks</button></div>
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
    const saveRes = await Db.results.saveResultsEntry({ exam_id: sel.exam_id, subject_id: sel.subject_id, scores });
    if (!saveRes.ok) { toast(saveRes.message, 'err'); return; }
    toast(`Saved ${saveRes.saved} score(s)${saveRes.cleared ? `, cleared ${saveRes.cleared}` : ''}.`, 'ok');
    loadGrid(root, sel);
  };
}
