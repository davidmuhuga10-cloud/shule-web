import { esc, options, renderPrereq, renderPrereqOrConnectivity, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

/** Transcript — one student's academic history across every exam they have
 *  results for, one row per exam (not a full per-subject grid, since the
 *  subject set changes across CBC levels/years and a per-subject grid would
 *  end up ragged) — total/average/overall grade/class position per exam,
 *  so a school can see a student's trend over time at a glance. */
export async function viewTranscript(root) {
  const classesRes = await Db.classes.list();
  // Round 6 §5 (recurring BUG): see examAnalysis.mjs for the full story.
  if (!classesRes.ok) { renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewTranscript(root) }); return; }
  const classes = classesRes.data;
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  render(root, classes, {});
}

function render(root, classes, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Transcript</h2><p>A student's full academic history across every exam, in one printable document.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Class</label><select id="tr-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Student</label><select id="tr-student" disabled><option value="">Choose a class first</option></select></div>
      </div>
    </div>
    <div id="tr-sheet"></div>
  `;

  root.querySelector('#tr-class').onchange = async (e) => {
    const cid = e.target.value;
    const studentSel = root.querySelector('#tr-student');
    root.querySelector('#tr-sheet').innerHTML = '';
    if (!cid) { studentSel.disabled = true; studentSel.innerHTML = '<option value="">Choose a class first</option>'; return; }
    const sres = await Db.students.list({ class_id: cid });
    const students = sres.ok ? sres.data : [];
    studentSel.disabled = false;
    studentSel.innerHTML = options(students.map((s) => ({ id: s.id, name: `${s.admission_no} — ${s.full_name}` })), 'id', 'name', '', 'Choose a student');
    studentSel.onchange = () => { if (studentSel.value) load(root, studentSel.value); else root.querySelector('#tr-sheet').innerHTML = ''; };
  };

  if (sel.class_id) root.querySelector('#tr-class').dispatchEvent(new Event('change'));
}

async function load(root, studentId) {
  const sheetEl = root.querySelector('#tr-sheet');
  sheetEl.innerHTML = loader();

  const [studentRes, examsRes, settingsRes] = await Promise.all([
    Db.students.get(studentId), Db.results.getStudentExams(studentId), Db.settings.get()
  ]);
  if (!studentRes.ok) { sheetEl.innerHTML = `<div class="card pad">⚠️ ${esc(studentRes.message)}</div>`; return; }
  const student = studentRes.data;
  const exams = examsRes.ok ? examsRes.data : [];
  const settings = settingsRes.ok ? settingsRes.data : {};

  if (!exams.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🧾</div><h3>No exam history yet</h3><p>This student has no results recorded for any exam.</p></div></div></div>`;
    return;
  }

  // Oldest first, so the transcript reads top-to-bottom chronologically.
  const ordered = exams.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const rows = [];
  for (const exam of ordered) {
    const cardRes = await Db.results.getReportCard(exam.id, studentId);
    if (!cardRes.ok) continue;
    const d = cardRes.data;
    rows.push({
      exam_name: exam.name, academic_year_name: exam.academic_year_name, term_name: exam.term_name,
      total: d.total, average: d.average, overall_grade: d.overall_grade,
      position: d.position, class_size: d.class_size
    });
  }

  const logoHtml = settings.logo ? `<img class="logo-thumb" src="${settings.logo}">` : `<div class="logo-placeholder">🏫</div>`;

  sheetEl.innerHTML = `
    <div class="card">
      <div class="card-b" style="display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:16px">
        ${logoHtml}
        <div>
          <h3 style="font-size:18px">${esc(settings.school_name || 'School')}</h3>
          <div class="muted" style="font-size:12.5px">
            ${settings.po_box ? 'P.O. Box ' + esc(settings.po_box) + ' · ' : ''}${settings.phone ? esc(settings.phone) + ' · ' : ''}${esc(settings.email || '')}
          </div>
          <div style="font-weight:650;margin-top:4px">Academic Transcript</div>
        </div>
        <div class="spacer"></div>
        <button class="btn secondary no-print" onclick="window.print()">🖨️ Print</button>
      </div>
      <div class="card-b" style="border-bottom:1px solid var(--line)">
        <div class="r-meta">
          <div><span>Name</span><b>${esc(student.full_name)}</b></div>
          <div><span>Admission No.</span><b>${esc(student.admission_no)}</b></div>
          <div><span>Class</span><b>${esc(student.class_name)}</b></div>
          <div><span>Arm</span><b>${esc(student.stream_name || '—')}</b></div>
          <div><span>Gender</span><b>${esc(student.gender)}</b></div>
          <div><span>UPI Number</span><b>${esc(student.upi_number || '—')}</b></div>
        </div>
      </div>
      <div class="card-b table-wrap">
        <table class="data">
          <thead><tr><th>Year</th><th>Term</th><th>Exam</th><th class="num">Total</th><th class="num">Average</th><th>Grade</th><th class="num">Position</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${esc(r.academic_year_name)}</td><td>${esc(r.term_name)}</td><td>${esc(r.exam_name)}</td>
            <td class="num">${r.total}</td><td class="num">${r.average}</td>
            <td><span class="badge grade">${esc(r.overall_grade || '—')}</span></td>
            <td class="num">${r.position ? `${r.position} of ${r.class_size}` : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted center">No accessible exam results.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}
