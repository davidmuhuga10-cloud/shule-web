/**
 * examAnalysis.mjs — new "Exam Analysis" report (feature brief §7): a
 * per-class exam breakdown — top students (overall + per subject, overall/
 * boys/girls), a class grade-band summary, and learning-area statistics —
 * modeled on the two reference exports the school uploaded. Built entirely
 * from Db.results.getBroadsheet() (see src/lib/examAnalysis.mjs for the
 * aggregation) rather than a new RPC, and follows the same printable-report
 * standard as the Mark List/Class List/Score Sheet (shared header, paper
 * size/orientation controls, mandatory contact info before printing).
 */
import { esc, options, renderPrereq, loader, go, printOptionsHtml, wirePrintOptions } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsxAOA } from '../lib/xlsxUtil.mjs';
import { buildExamAnalysis } from '../lib/examAnalysis.mjs';
import { buildExamAnalysisAoa } from '../lib/examAnalysisXlsx.mjs';
import { printHeaderHtml, isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';

export async function viewExamAnalysis(root) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  // A "🔎 Analyze" click from the Manage Exams board (brief Step 13) hands
  // off straight to this exam+class — see navIntent.mjs.
  const intent = takeNavIntent('exam-analysis') || {};
  render(root, exams, classes, { exam_id: intent.exam_id || '', class_id: intent.class_id || '' });
}

function render(root, exams, classes, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Exam Analysis</h2><p>Top students and class-wide performance analysis for one exam and class.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid2">
        <div class="field"><label>Exam</label><select id="ea-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="ea-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
      </div>
    </div>
    <div id="ea-sheet"></div>
  `;
  const reload = () => {
    const next = { exam_id: root.querySelector('#ea-exam').value, class_id: root.querySelector('#ea-class').value };
    if (next.exam_id && next.class_id) load(root, classes, next); else root.querySelector('#ea-sheet').innerHTML = '';
  };
  root.querySelector('#ea-exam').onchange = reload;
  root.querySelector('#ea-class').onchange = reload;
  if (sel.exam_id && sel.class_id) load(root, classes, sel);
}

function topTable(title, rows) {
  if (!rows.length) return '';
  return `<div style="margin-top:14px">
    <div style="font-weight:700;font-size:12.5px;margin-bottom:6px">${esc(title)}</div>
    <table class="print-grid"><thead><tr>
      <th>Admno</th><th>Name</th><th>Stream</th><th class="num">Strm Rank</th><th class="num">Ovrl Rank</th><th class="num">Score</th><th>Performance Level</th><th>Gender</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td>${esc(r.stream_name || '—')}</td>
      <td class="num">${r.stream_rank} / ${r.stream_total}</td><td class="num">${r.overall_rank} / ${r.overall_total}</td>
      <td class="num"><b>${r.score}</b></td><td>${esc(r.level || '—')}</td><td>${esc(r.gender || '—')}</td>
    </tr>`).join('')}</tbody></table>
  </div>`;
}

function gradeSummaryTable(title, rows, bandLabels) {
  return `<div style="margin-top:14px">
    <div style="font-weight:700;font-size:12.5px;margin-bottom:6px">${esc(title)}</div>
    <div class="table-wrap"><table class="print-grid"><thead><tr>
      <th>&nbsp;</th>${bandLabels.map((l) => `<th class="num">${esc(l)}</th>`).join('')}<th class="num">X</th>
      <th class="num">Entries</th><th class="num">Mean Marks</th><th class="num">Mean Points</th><th>Performance Level</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${esc(r.label || r.subject_name)}</td>${bandLabels.map((l) => `<td class="num">${r.band_counts[l] || 0}</td>`).join('')}<td class="num">${r.x_count}</td>
      <td class="num">${r.entries}</td><td class="num">${r.mean_marks}</td><td class="num">${r.mean_points}</td><td>${esc(r.performance_level || '—')}</td>
    </tr>`).join('')}</tbody></table></div>
  </div>`;
}

async function load(root, classes, sel) {
  const sheetEl = root.querySelector('#ea-sheet');
  sheetEl.innerHTML = loader();
  const [bsRes, settingsRes, bands] = await Promise.all([
    Db.results.getBroadsheet(sel), Db.settings.get(), Db.grading.defaultScaleBands()
  ]);
  if (!bsRes.ok) { sheetEl.innerHTML = `<div class="card pad">⚠️ ${esc(bsRes.message)}</div>`; return; }
  const settings = settingsRes.ok ? settingsRes.data : {};
  const cls = classes.find((c) => c.id === sel.class_id);

  if (!isContactInfoComplete(settings)) { renderMissingContactInfo(sheetEl, () => go('settings')); return; }

  if (!bsRes.students.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students in this class yet.</p></div></div></div>`;
    return;
  }
  if (!bsRes.subjects.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No published subjects yet</h3><p>Analysis is based on published results — publish at least one subject for this class/exam first.</p></div></div></div>`;
    return;
  }

  const analysis = buildExamAnalysis(bsRes, bands || []);
  const suggestedName = `${cls ? cls.name : 'Class'} Exam Analysis — ${bsRes.exam.name}`.replace(/[\\/:*?"<>|]+/g, '');

  sheetEl.innerHTML = `
    <div class="report-toolbar no-print">
      <button class="btn secondary" id="ea-download">⬇️ Download Excel</button>
      ${printOptionsHtml('ea', 'portrait')}
    </div>
    <div class="card">
      <div class="card-b" style="border-bottom:1px solid var(--line);padding-bottom:12px">
        ${printHeaderHtml(settings, `${bsRes.exam.name} — Exam Analysis — ${cls ? cls.name : ''}`)}
      </div>
      <div class="card-b">
        <div class="grid3" style="text-align:center">
          <div><div class="muted" style="font-size:11px">STUDENTS WHO SAT</div><div style="font-size:22px;font-weight:800">${analysis.students_sat}</div></div>
          <div><div class="muted" style="font-size:11px">MEAN MARKS</div><div style="font-size:22px;font-weight:800">${analysis.mean_marks}</div></div>
          <div><div class="muted" style="font-size:11px">MEAN POINTS</div><div style="font-size:22px;font-weight:800">${analysis.mean_points}</div></div>
        </div>
        <div class="center" style="margin-top:8px"><span class="badge blue">${esc(analysis.performance_level || '—')}</span></div>

        <div style="margin-top:20px;font-weight:750;font-size:13.5px">LEARNING AREA STATISTICS</div>
        <div class="table-wrap"><table class="print-grid" style="margin-top:6px"><thead><tr><th>Name</th><th class="num">Mean Points</th><th>Performance Level</th></tr></thead>
        <tbody>${analysis.learning_area_stats.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.points}</td><td>${esc(r.performance_level || '—')}</td></tr>`).join('')}</tbody></table></div>

        <div style="margin-top:20px;font-weight:750;font-size:13.5px">CLASS GRADE SUMMARY</div>
        ${gradeSummaryTable('Overall', [analysis.class_grade_summary.overall], analysis.band_labels)}
        ${analysis.boys_count ? gradeSummaryTable('Boys', [analysis.class_grade_summary.boys], analysis.band_labels) : ''}
        ${analysis.girls_count ? gradeSummaryTable('Girls', [analysis.class_grade_summary.girls], analysis.band_labels) : ''}
        ${gradeSummaryTable('Per Learning Area', analysis.class_grade_summary.per_subject, analysis.band_labels)}

        <div style="margin-top:20px;font-weight:750;font-size:13.5px">OVERALL — TOP STUDENTS</div>
        ${topTable('Top Students - Overall', analysis.top_students_overall)}
        ${topTable('Top Boys - Overall', analysis.top_boys_overall)}
        ${topTable('Top Girls - Overall', analysis.top_girls_overall)}

        ${analysis.per_subject.map((sub) => `
          <div style="margin-top:22px;font-weight:750;font-size:13.5px;border-top:1px solid var(--line);padding-top:14px">${esc(sub.subject_name.toUpperCase())}</div>
          ${topTable(`Top Students - ${sub.subject_name}`, sub.top_students)}
          ${topTable(`Top Boys - ${sub.subject_name}`, sub.top_boys)}
          ${topTable(`Top Girls - ${sub.subject_name}`, sub.top_girls)}
        `).join('')}
      </div>
    </div>
  `;

  wirePrintOptions(sheetEl, 'ea', suggestedName);
  sheetEl.querySelector('#ea-download').onclick = () => {
    const aoa = buildExamAnalysisAoa({ settings, exam: bsRes.exam, cls, analysis });
    downloadXlsxAOA(suggestedName, aoa, 'Exam Analysis');
  };
}
