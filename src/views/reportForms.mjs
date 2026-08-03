import { esc, options, renderPrereq, loader, toast } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { renderReportCard } from './_reportCard.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';

const BATCH_VALUE = '__all__';

export async function viewReports(root) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  // A "Go to Report Forms" click straight after a full publish hands off
  // exactly which exam+class to pre-select — see navIntent.mjs. Defaults to
  // batch-printing the whole class, since that's almost always the point of
  // that handoff.
  const intent = takeNavIntent('report-forms') || {};
  render(root, exams, classes, intent);
}

function render(root, exams, classes, intent) {
  intent = intent || {};
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Report Forms</h2><p>Pick an exam and a student to generate their report form — or choose "Print all" to batch-print a whole class at once.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="rf-exam">${options(exams, 'id', 'name', intent.exam_id || '', 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="rf-class">${options(classes, 'id', 'name', intent.class_id || '', 'Choose a class')}</select></div>
        <div class="field"><label>Student</label><select id="rf-student" disabled><option value="">Choose a class first</option></select></div>
      </div>
    </div>
    <div id="rf-card"></div>
  `;

  const refreshStudents = async (cid, preselect) => {
    const studentSel = root.querySelector('#rf-student');
    if (!cid) { studentSel.disabled = true; studentSel.innerHTML = '<option value="">Choose a class first</option>'; return; }
    const sres = await Db.students.list({ class_id: cid });
    const students = sres.ok ? sres.data : [];
    studentSel.disabled = false;
    const choices = students.length
      ? [{ id: BATCH_VALUE, name: '🖨️ Print all students in this class' }, ...students.map((s) => ({ id: s.id, name: `${s.admission_no} — ${s.full_name}` }))]
      : [];
    studentSel.innerHTML = options(choices, 'id', 'name', preselect || '', 'Choose a student');
  };

  const tryLoad = async () => {
    const examId = root.querySelector('#rf-exam').value, studentId = root.querySelector('#rf-student').value;
    const classId = root.querySelector('#rf-class').value;
    if (!examId || !studentId) return;
    const cardEl = root.querySelector('#rf-card');
    cardEl.innerHTML = loader();

    if (studentId === BATCH_VALUE) {
      const sres = await Db.students.list({ class_id: classId });
      const students = sres.ok ? sres.data : [];
      if (!students.length) { cardEl.innerHTML = `<div class="card pad">No students found in this class.</div>`; return; }
      cardEl.innerHTML = '';
      let printed = 0;
      for (const s of students) {
        const res = await Db.results.getReportCard(examId, s.id);
        if (!res.ok) continue;
        const page = document.createElement('div');
        page.className = 'batch-page';
        cardEl.appendChild(page);
        renderReportCard(page, res.data);
        printed++;
      }
      if (!printed) { cardEl.innerHTML = `<div class="card pad">⚠️ No accessible report cards for this class/exam yet.</div>`; return; }
      const printBtn = document.createElement('div');
      printBtn.className = 'no-print center'; printBtn.style.marginTop = '16px';
      printBtn.innerHTML = `<button class="btn secondary" onclick="window.print()">🖨️ Print all ${printed} report form(s)</button>`;
      cardEl.appendChild(printBtn);
      return;
    }

    const res = await Db.results.getReportCard(examId, studentId);
    if (!res.ok) { cardEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
    renderReportCard(cardEl, res.data);
    const printBtn = document.createElement('div');
    printBtn.className = 'no-print center'; printBtn.style.marginTop = '16px';
    printBtn.innerHTML = '<button class="btn secondary" onclick="window.print()">🖨️ Print</button>';
    cardEl.appendChild(printBtn);
  };

  root.querySelector('#rf-class').onchange = async (e) => { await refreshStudents(e.target.value); wireStudentSelect(); };
  root.querySelector('#rf-exam').onchange = tryLoad;
  function wireStudentSelect() {
    const s = root.querySelector('#rf-student');
    if (s) s.onchange = tryLoad;
  }
  wireStudentSelect();

  // Prefill straight from a "Go to Report Forms" handoff (see navIntent.mjs
  // at the top of this file) — defaults to batch-printing the whole class.
  if (intent.class_id && intent.exam_id) {
    refreshStudents(intent.class_id, BATCH_VALUE).then(() => { wireStudentSelect(); tryLoad(); });
  }
}
