/**
 * broadsheet.mjs — "Mark List", redesigned to match the Zeraki-style
 * condensed, gridded class sheet (feature brief "Merit List Design" — what
 * Zeraki's manual calls a Merit List is this exact per-class, per-subject
 * grid, just under a different name; Shule's own separate, thinner "Merit
 * List" module — a bare top-N ranking with no per-subject detail — is gone,
 * folded into this richer view instead of kept as a second, redundant
 * screen). Every cell has a visible border (a real grid, not just
 * bottom-rule table rows), each subject cell shows the score AND its grade
 * together, and the row of summary columns matches Zeraki's: SBJ (subject
 * count), TT MKS/MN MKS (total/mean marks), PL (performance level — the
 * student's overall grade), TT PTS/MN PTS (total/mean points), DEV
 * (deviation from the class average), STR POS and OVR POS (position within
 * the student's own stream vs. within the whole class).
 */
import { esc, options, renderPrereq, loader, go, printOptionsHtml, wirePrintOptions } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { computeGradeSummaries } from '../lib/broadsheetSummary.mjs';
import { downloadXlsxAOA } from '../lib/xlsxUtil.mjs';
import { buildBroadsheetAoa } from '../lib/broadsheetXlsx.mjs';
import { printHeaderHtml, isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';

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
    <div class="page-head no-print"><div><h2>Mark List</h2><p>Students &times; subjects, with grades, points and position — arm and overall.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="bs-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="bs-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Arm (optional)</label><select id="bs-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Whole class</option></select></div>
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
    if (next.exam_id && next.class_id) load(root, classes, next); else root.querySelector('#bs-sheet').innerHTML = '';
  };
  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  root.querySelector('#bs-exam').onchange = reload;

  if (sel.exam_id && sel.class_id) load(root, classes, sel);
}

function cell(score, gr) {
  if (score === null || score === undefined) return '<td class="num">—</td>';
  return `<td class="num mark-cell"><b>${score}</b>${gr && gr.grade_label ? ` <span class="mark-grade">${esc(gr.grade_label)}</span>` : ''}</td>`;
}

/** Plain-number cell for one paper's raw score — no grade badge (Learning
 *  Area Papers brief: "per-paper rows are NOT graded individually"; the
 *  combined % column carries the grade instead). */
function paperCell(score) {
  return score === null || score === undefined ? '<td class="num">—</td>' : `<td class="num">${score}</td>`;
}

function subjectHeaderHtml(sub) {
  if (!sub.papers || !sub.papers.length) return `<th class="num subj-col">${esc(sub.code || sub.name)}</th>`;
  const paperHeaders = sub.papers.map((p) => `<th class="num subj-col">${esc(sub.code || sub.name)} ${esc(p.name)}</th>`).join('');
  return `${paperHeaders}<th class="num subj-col">${esc(sub.code || sub.name)} %</th>`;
}

function subjectRowCellsHtml(sub, student) {
  if (!sub.papers || !sub.papers.length) return cell(student.scores[sub.id], student.grades[sub.id]);
  const raw = (student.paperScores && student.paperScores[sub.id]) || {};
  const paperCells = sub.papers.map((p) => paperCell(raw[p.id] === undefined ? null : raw[p.id])).join('');
  const pct = student.subjectPct ? student.subjectPct[sub.id] : null;
  return `${paperCells}${cell(pct === null || pct === undefined ? null : pct, student.grades[sub.id])}`;
}

async function load(root, classes, sel) {
  const sheetEl = root.querySelector('#bs-sheet');
  sheetEl.innerHTML = loader();
  const [res, settingsRes, bandsRes] = await Promise.all([Db.results.getBroadsheet(sel), Db.settings.get(), Db.grading.defaultScaleBands()]);
  if (!res.ok) { sheetEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const settings = settingsRes.ok ? settingsRes.data : {};
  const cls = classes.find((c) => c.id === sel.class_id);
  const bands = bandsRes || [];

  // Feature brief §3: block printing/downloading until the school's
  // structured contact/address details are set — the logo stays optional.
  if (!isContactInfoComplete(settings)) { renderMissingContactInfo(sheetEl, () => go('settings')); return; }

  if (!res.students.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/arm yet.</p></div></div></div>`;
    return;
  }
  if (!res.subjects.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No published subjects yet</h3><p>A subject only appears on the Mark List once its results are published — assign subjects and publish results, then come back.</p></div></div></div>`;
    return;
  }

  sheetEl.innerHTML = `
    <div class="report-toolbar no-print">
      <button class="btn secondary" id="bs-download">⬇️ Download Excel</button>
      ${printOptionsHtml('bs', 'landscape')}
    </div>
    <div class="card">
      <div class="card-b" style="border-bottom:1px solid var(--line);padding-bottom:12px">
        ${printHeaderHtml(settings, `${res.exam.name} — Mark List — ${cls ? cls.name : ''}`)}
      </div>
      <div class="card-b table-wrap"><table class="mark-list-grid">
        <thead><tr><th class="id-col">Adm. No.</th><th class="name-col">Name</th><th class="str-col">Arm</th>
          ${res.subjects.map((s) => subjectHeaderHtml(s)).join('')}
          <th class="num sum-col">SBJ</th><th class="num sum-col">TT MKS</th><th class="num sum-col">MN MKS</th><th class="num sum-col">PL</th>
          <th class="num sum-col">TT PTS</th><th class="num sum-col">MN PTS</th><th class="num sum-col">DEV</th><th class="num sum-col">ARM POS</th><th class="num sum-col">OVR POS</th></tr></thead>
        <tbody>${res.students.map((s) => `<tr>
          <td class="id-col">${esc(s.admission_no)}</td><td class="name-col">${esc(s.full_name)}</td><td class="str-col">${esc(s.stream_name || '—')}</td>
          ${res.subjects.map((sub) => subjectRowCellsHtml(sub, s)).join('')}
          <td class="num sum-col">${s.subject_count}</td>
          <td class="num sum-col"><b>${s.total}</b></td><td class="num sum-col">${s.average}</td>
          <td class="num sum-col"><span class="badge blue">${esc(s.overall_grade || '—')}</span></td>
          <td class="num sum-col">${s.total_points === null ? '—' : s.total_points}</td><td class="num sum-col">${s.mean_points === null ? '—' : s.mean_points}</td>
          <td class="num sum-col">${s.deviation > 0 ? '+' : ''}${s.deviation}</td>
          <td class="num sum-col">${s.stream_position || '—'}</td><td class="num sum-col"><b>${s.position || '—'}</b></td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${summaryTablesHtml(res.students, res.subjects, bands)}
    </div>
  `;
  wirePrintOptions(sheetEl, 'bs', `${cls ? cls.name : 'Class'} Mark List — ${res.exam.name}`);
  sheetEl.querySelector('#bs-download').onclick = () => {
    const streamSel = root.querySelector('#bs-stream');
    const streamName = streamSel && streamSel.selectedIndex > 0 ? streamSel.options[streamSel.selectedIndex].textContent : '';
    const aoa = buildBroadsheetAoa({ settings, exam: res.exam, cls, streamName, subjects: res.subjects, students: res.students, class_average: res.class_average });
    const fname = `mark-list-${(cls ? cls.name : 'class')}-${res.exam.name}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadXlsxAOA(fname, aoa, 'Mark List');
  };
}

/** Brief §15: renders computeGradeSummaries()'s data as three tables below
 *  the grid, replacing the old single "Class average" figure. Reuses the
 *  same generic `table.data` styling every other admin table already uses
 *  (main.css:208) rather than introducing a third table look, and the same
 *  single @page override printWithOptions() applies to the whole print job
 *  (app.js) — there's no per-section stylesheet here that could let these
 *  tables end up in a different orientation than the grid above them within
 *  one printout. */
function summaryTablesHtml(students, subjects, bands) {
  const { gradeOrder, totalStudents, totalGraded, ungraded, classSummary, genderSummary, subjectBreakdown } = computeGradeSummaries(students, subjects, bands);
  if (!gradeOrder.length) return '';

  return `
    <div class="card-b bs-summary" style="border-top:1px solid var(--line)">
      <div class="bs-summary-grid">
        <div>
          <div class="bs-summary-h">Class Grade Summary</div>
          ${ungraded > 0 ? `<p class="hint" style="margin:0 0 6px">${totalGraded} of ${totalStudents} student(s) graded — ${ungraded} still has${ungraded === 1 ? '' : 've'} no marks entered for this exam yet, so ${ungraded === 1 ? "isn't" : "aren't"} in the breakdown below.</p>` : ''}
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Grade</th><th class="num">Students</th><th class="num">%</th></tr></thead>
            <tbody>${classSummary.map((r) => `<tr>
              <td><span class="badge blue">${esc(r.grade)}</span></td><td class="num">${r.count}</td><td class="num">${r.pct}%</td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>
        <div>
          <div class="bs-summary-h">Gender Grade Summary</div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Grade</th><th class="num">Male</th><th class="num">Female</th><th class="num">Total</th></tr></thead>
            <tbody>${genderSummary.map((r) => `<tr>
              <td><span class="badge blue">${esc(r.grade)}</span></td><td class="num">${r.male}</td><td class="num">${r.female}</td><td class="num">${r.total}</td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>
      <div style="margin-top:16px">
        <div class="bs-summary-h">Grade Breakdown by Subject</div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Subject</th>${gradeOrder.map((g) => `<th class="num">${esc(g)}</th>`).join('')}</tr></thead>
          <tbody>${subjectBreakdown.map((row) => `<tr>
            <td>${esc(row.subject_name)}</td>${gradeOrder.map((g) => `<td class="num">${row.counts[g] || '—'}</td>`).join('')}
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
    </div>
  `;
}
