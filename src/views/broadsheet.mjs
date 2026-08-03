import { esc, options, renderPrereq, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const STATUS_BADGE_CLASS = { draft: 'grey', submitted: 'blue', approved: 'blue', published: 'green' };
const STATUS_SHORT = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', published: 'Published' };

export async function viewBroadsheet(root) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  render(root, exams, classes, {});
}

function render(root, exams, classes, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Mark List</h2><p>Students &times; subjects, with totals, average and class position.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="bs-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="bs-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Stream (optional)</label><select id="bs-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Whole class</option></select></div>
      </div>
    </div>
    <div id="bs-sheet"></div>
  `;

  const classSel = root.querySelector('#bs-class'), streamSel = root.querySelector('#bs-stream');
  async function refreshStreams(cid) {
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Whole class</option>'; return; }
    const sres = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Whole class</option>' + options(sres.ok ? sres.data : [], 'id', 'name', '');
  }
  if (sel.class_id) refreshStreams(sel.class_id);

  const reload = () => {
    const next = { exam_id: root.querySelector('#bs-exam').value, class_id: root.querySelector('#bs-class').value, stream_id: root.querySelector('#bs-stream').value };
    if (next.exam_id && next.class_id) load(root, next); else root.querySelector('#bs-sheet').innerHTML = '';
  };
  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  root.querySelector('#bs-exam').onchange = reload;

  if (sel.exam_id && sel.class_id) load(root, sel);
}

async function load(root, sel) {
  const sheetEl = root.querySelector('#bs-sheet');
  sheetEl.innerHTML = loader();
  const res = await Db.results.getBroadsheet(sel);
  if (!res.ok) { sheetEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }

  if (!res.students.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/stream yet.</p></div></div></div>`;
    return;
  }
  if (!res.subjects.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No subjects with marks yet</h3><p>Assign subjects to this class, or enter some marks, then come back.</p></div></div></div>`;
    return;
  }

  sheetEl.innerHTML = `
    <div class="card print-landscape">
      <div class="card-h"><h3>${esc(res.exam.name)} — Mark List</h3><div class="spacer"></div>
        <button class="btn secondary no-print" onclick="window.print()">🖨️ Print</button></div>
      <div class="card-b table-wrap"><table class="data broadsheet-table">
        <thead><tr><th>Adm. No.</th><th>Name</th><th>Stream</th>
          ${res.subjects.map((s) => `<th class="num">${esc(s.code || s.name)}<br><span class="badge ${STATUS_BADGE_CLASS[s.submission_status] || 'grey'}" style="font-size:10px">${esc(STATUS_SHORT[s.submission_status] || s.submission_status)}</span></th>`).join('')}
          <th class="num">Total</th><th class="num">Avg</th><th class="num">Position</th></tr></thead>
        <tbody>${res.students.map((s) => `<tr>
          <td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.stream_name || '—')}</td>
          ${res.subjects.map((sub) => `<td class="num">${s.scores[sub.id] === null || s.scores[sub.id] === undefined ? '—' : s.scores[sub.id]}</td>`).join('')}
          <td class="num"><b>${s.total}</b></td><td class="num">${s.average}</td><td class="num">${s.position || '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="card-b" style="border-top:1px solid var(--line)">Class average: <b>${res.class_average}</b></div>
    </div>
  `;
}
