import { esc, loader, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { renderReportCard } from './_reportCard.mjs';

export async function viewMyResults(root) {
  const studentId = state.profile.student_id;
  if (!studentId) {
    root.innerHTML = `<div class="card pad"><div class="empty"><div class="e-ico">⚠️</div><h3>No student record linked</h3><p>Your account isn't linked to a student record yet — ask your school admin.</p></div></div>`;
    return;
  }
  const res = await Db.results.getStudentExams(studentId);
  const exams = res.ok ? res.data : [];

  if (!exams.length) {
    root.innerHTML = `<div class="page-head"><div><h2>My Results</h2></div></div>
      <div class="card pad"><div class="empty"><div class="e-ico">🧾</div><h3>No results yet</h3><p>Your results will appear here once your teachers enter marks for an exam.</p></div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="page-head no-print"><div><h2>My Results</h2><p>Choose an exam to view your report form.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b"><div class="field" style="max-width:320px">
        <label>Exam</label>
        <select id="mr-exam"><option value="">Choose an exam</option>${exams.map((e) => `<option value="${e.id}">${esc(e.name)} (${esc(e.academic_year_name)} · ${esc(e.term_name)})</option>`).join('')}</select>
      </div></div>
    </div>
    <div id="mr-card"></div>
  `;

  root.querySelector('#mr-exam').onchange = async (e) => {
    const cardEl = root.querySelector('#mr-card');
    if (!e.target.value) { cardEl.innerHTML = ''; return; }
    cardEl.innerHTML = loader();
    const cardRes = await Db.results.getReportCard(e.target.value, studentId);
    if (!cardRes.ok) { cardEl.innerHTML = `<div class="card pad">⚠️ ${esc(cardRes.message)}</div>`; return; }
    renderReportCard(cardEl, cardRes.data);
    const printBtn = document.createElement('div');
    printBtn.className = 'no-print center'; printBtn.style.marginTop = '16px';
    printBtn.innerHTML = '<button class="btn secondary" onclick="window.print()">🖨️ Print</button>';
    cardEl.appendChild(printBtn);
  };

  // Auto-select the most recent exam.
  root.querySelector('#mr-exam').value = exams[0].id;
  root.querySelector('#mr-exam').dispatchEvent(new Event('change'));
}
