import { esc, options, renderPrereq, loader, toast, printOptionsHtml, wirePrintOptions } from '../app.js';
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

  // Report-form extras (feature brief "Report Forms and Merit List
  // Design"): school header, per-subject teacher name and class average are
  // all staff-only, cheap lookups — fetched ONCE per class/exam (not per
  // student) and reused across the whole batch. Neither requires a new RPC:
  // teacher names already come back from listSubmissions(), and per-subject
  // class averages are derived client-side from getBroadsheet()'s
  // already-computed per-student per-subject scores.
  const loadExtra = async (examId, classId) => {
    const [settingsRes, subsRes, bsRes, bands] = await Promise.all([
      Db.settings.get(), Db.results.listSubmissions(examId, classId), Db.results.getBroadsheet({ exam_id: examId, class_id: classId }), Db.grading.defaultScaleBands()
    ]);
    const teacherBySubject = {};
    (subsRes.ok ? subsRes.data : []).forEach((r) => { if (r.teacher_name) teacherBySubject[r.subject_id] = r.teacher_name; });
    const classAvgBySubject = {};
    if (bsRes.ok) {
      bsRes.subjects.forEach((sub) => {
        const scored = bsRes.students.map((s) => s.scores[sub.id]).filter((v) => v !== null && v !== undefined);
        classAvgBySubject[sub.id] = scored.length ? Math.round((scored.reduce((a, v) => a + v, 0) / scored.length) * 100) / 100 : null;
      });
    }
    return { settings: settingsRes.ok ? settingsRes.data : {}, teacherBySubject, classAvgBySubject, bands: bands || [] };
  };

  const tryLoad = async () => {
    const examId = root.querySelector('#rf-exam').value, studentId = root.querySelector('#rf-student').value;
    const classId = root.querySelector('#rf-class').value;
    if (!examId || !studentId) return;
    const cardEl = root.querySelector('#rf-card');
    cardEl.innerHTML = loader();
    const extra = await loadExtra(examId, classId);

    if (studentId === BATCH_VALUE) {
      const sres = await Db.students.list({ class_id: classId });
      const students = sres.ok ? sres.data : [];
      if (!students.length) { cardEl.innerHTML = `<div class="card pad">No students found in this class.</div>`; return; }
      cardEl.innerHTML = '';
      // Print bar goes at the TOP, above every report form — not appended
      // after the fact, which is what put it below the content before.
      // Brief §11: same shared portrait/landscape + A4/A5/Letter print
      // controls every other report (Mark List/Class List/Score Sheet) uses,
      // instead of a bare print button with no size/orientation choice.
      const printBar = document.createElement('div');
      printBar.className = 'report-toolbar no-print'; printBar.style.marginBottom = '16px';
      printBar.innerHTML = printOptionsHtml('rf', 'portrait');
      cardEl.appendChild(printBar);
      // Brief §12: this used to be N sequential get_report_card() RPC round
      // trips, one per student, awaited one at a time in a for-loop — for a
      // class of 40+ students that's 40 round trips back to back, the
      // highest-value cause identified for "report forms... take too long to
      // generate." Firing every request at once and awaiting the whole batch
      // turns "N round trips in series" into "1 round trip's worth of wait."
      const results = await Promise.all(students.map((s) => Db.results.getReportCard(examId, s.id)));
      let printed = 0;
      students.forEach((s, i) => {
        const res = results[i];
        if (!res.ok) return;
        const page = document.createElement('div');
        page.className = 'batch-page';
        cardEl.appendChild(page);
        renderReportCard(page, res.data, extra);
        printed++;
      });
      if (!printed) { cardEl.innerHTML = `<div class="card pad">⚠️ No accessible report cards for this class/exam yet.</div>`; return; }
      wirePrintOptions(printBar, 'rf', `Report Forms — ${classes.find((c) => c.id === classId) ? classes.find((c) => c.id === classId).name : ''}`);
      return;
    }

    const res = await Db.results.getReportCard(examId, studentId);
    if (!res.ok) { cardEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
    cardEl.innerHTML = '';
    // Same top-of-page placement + shared print controls for the
    // single-student case.
    const printBar = document.createElement('div');
    printBar.className = 'report-toolbar no-print'; printBar.style.marginBottom = '16px';
    printBar.innerHTML = printOptionsHtml('rf', 'portrait');
    cardEl.appendChild(printBar);
    const cardBody = document.createElement('div');
    cardEl.appendChild(cardBody);
    renderReportCard(cardBody, res.data, extra);
    wirePrintOptions(printBar, 'rf', `Report Form — ${res.data.student ? res.data.student.full_name : ''}`);
  };

  root.querySelector('#rf-class').onchange = async (e) => { await refreshStudents(e.target.value); wireStudentSelect(); };
  root.querySelector('#rf-exam').onchange = tryLoad;
  function wireStudentSelect() {
    const s = root.querySelector('#rf-student');
    if (s) s.onchange = tryLoad;
  }
  wireStudentSelect();

  // Prefill straight from a "Go to Report Forms" handoff (see navIntent.mjs
  // at the top of this file) — defaults to batch-printing the whole class,
  // unless a specific student_id was handed off too (e.g. from a student's
  // profile page — brief §5's "view results" action), in which case that
  // one student is preselected instead.
  if (intent.class_id && intent.exam_id) {
    refreshStudents(intent.class_id, intent.student_id || BATCH_VALUE).then(() => { wireStudentSelect(); tryLoad(); });
  }
}
