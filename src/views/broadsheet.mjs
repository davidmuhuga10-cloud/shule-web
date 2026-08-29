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
import { esc, options, renderPrereq, renderPrereqOrConnectivity, loader, go, printOptionsHtml, wirePrintOptions } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { computeGradeSummaries } from '../lib/broadsheetSummary.mjs';
import { downloadXlsxAOA } from '../lib/xlsxUtil.mjs';
import { buildBroadsheetAoa } from '../lib/broadsheetXlsx.mjs';
import { applyMeritListDisplayPrefs } from '../lib/meritListPrefs.mjs';
import { printHeaderHtml, reportTitleBarHtml, isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';

export async function viewBroadsheet(root) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  // Round 6 §5 (recurring BUG): don't conflate a lost/flaky connection with
  // "genuinely nothing set up yet" — see examAnalysis.mjs for the full
  // story. The Mark List is the exact screen the brief's screenshot showed
  // this happening on.
  if (!examsRes.ok || !classesRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewBroadsheet(root) });
    return;
  }
  const exams = examsRes.data;
  const classes = classesRes.data;
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  render(root, exams, classes, {});
}

function render(root, exams, classes, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Mark List</h2><p>Students &times; subjects, with grades, points and position — stream and overall.</p></div></div>
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
    if (next.exam_id && next.class_id) load(root, classes, next); else root.querySelector('#bs-sheet').innerHTML = '';
  };
  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  root.querySelector('#bs-exam').onchange = reload;

  if (sel.exam_id && sel.class_id) load(root, classes, sel);
}

// Sprint Review §8: "Show achievement levels on the Mark List" (Settings >
// Permissions, default ON) — when off, every grade/achievement-level badge
// on this sheet is suppressed and only the raw mark is shown. Threaded as
// an explicit param rather than a module-level flag so this file stays a
// plain function of its arguments (same convention as everything else
// here reading from `settings`).
function cell(score, gr, showLevels) {
  if (score === null || score === undefined) return '<td class="num">—</td>';
  return `<td class="num mark-cell"><b>${score}</b>${showLevels && gr && gr.grade_label ? ` <span class="mark-grade">${esc(gr.grade_label)}</span>` : ''}</td>`;
}

/** Plain-number cell for one paper's raw score — no grade badge (Learning
 *  Area Papers brief: "per-paper rows are NOT graded individually"; the
 *  combined % column carries the grade instead). Round 6 §1: rounded for
 *  display same as every other mark on this sheet — a teacher can enter a
 *  fractional mark for a paper same as any other score field. */
function paperCell(score) {
  return score === null || score === undefined ? '<td class="num">—</td>' : `<td class="num">${Math.round(score)}</td>`;
}

function subjectHeaderHtml(sub) {
  if (!sub.papers || !sub.papers.length) return `<th class="num subj-col">${esc(sub.code || sub.name)}</th>`;
  const paperHeaders = sub.papers.map((p) => `<th class="num subj-col">${esc(sub.code || sub.name)} ${esc(p.name)}</th>`).join('');
  return `${paperHeaders}<th class="num subj-col">${esc(sub.code || sub.name)} %</th>`;
}

function subjectRowCellsHtml(sub, student, showLevels) {
  if (!sub.papers || !sub.papers.length) {
    // Round 5 §2 rounded ONLY Subject Combinations (SST/CRE-style, two
    // different subjects merged) for display, since those most often land
    // on an obvious decimal (e.g. 74.35). Round 6 §1 (BUG): a plain
    // subject's own raw mark can carry the same 2dp precision (see
    // results.mjs's `scores[sub.id] = Math.round(map[s.id] * 100) / 100`)
    // and was still showing it — "no subject should ever report marks as
    // a decimal" means every subject here, not just combinations. The
    // exact value keeps feeding total/average/ranking unchanged either
    // way (see results.mjs, where `scores` is computed) — this is purely
    // a "how it's shown" change.
    const score = student.scores[sub.id];
    const displayScore = (score === null || score === undefined) ? null : Math.round(score);
    return cell(displayScore, student.grades[sub.id], showLevels);
  }
  const raw = (student.paperScores && student.paperScores[sub.id]) || {};
  const paperCells = sub.papers.map((p) => paperCell(raw[p.id] === undefined ? null : raw[p.id])).join('');
  const pct = student.subjectPct ? student.subjectPct[sub.id] : null;
  return `${paperCells}${cell(pct === null || pct === undefined ? null : pct, student.grades[sub.id], showLevels)}`;
}

/** Round 5 §2: the TOTAL/AVERAGE rows at the very bottom of the Merit List —
 *  one figure per subject column (each Learning Area Paper's own
 *  sub-column, and its combined % column, get their own total/average too),
 *  summed/averaged across whichever students are currently shown (respects
 *  the active class/arm filter — same set the grid above renders). Ranks,
 *  grades and the other summary columns (SBJ..OVR POS) aren't meaningful to
 *  sum or average, so they're left blank on these two rows. */
function aggregate(nums, mode) {
  if (!nums.length) return null;
  const sum = nums.reduce((a, v) => a + v, 0);
  return mode === 'sum' ? sum : sum / nums.length;
}
function subjectAggCellsHtml(sub, students, mode, examOutOf) {
  if (!sub.papers || !sub.papers.length) {
    const nums = students.map((s) => s.scores[sub.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    if (val === null) return '<td class="num">—</td>';
    // Round 6 §1: whole number for every subject's TOTAL/AVERAGE row, not
    // just Subject Combinations (see subjectRowCellsHtml above for why).
    // Round 6 (Sprint Review §4, redo of the original §3 fix): the TOTAL
    // row — and only the TOTAL row, an AVERAGE isn't a "total" and has no
    // "possible" of its own — shows the earned/possible total-of-total
    // (e.g. "870/1200": 870 marks earned across the students who sat this
    // subject, out of nums.length students times the exam's out_of).
    if (mode === 'sum') return `<td class="num"><b>${Math.round(val)}/${nums.length * examOutOf}</b></td>`;
    // Sprint Review correction: the AVERAGE row is this sheet's "Mean
    // Marks" figure — an explicit exception to the "round everything to a
    // whole number" rule, so it keeps 2 decimal places instead.
    return `<td class="num"><b>${val.toFixed(2)}</b></td>`;
  }
  const paperCells = sub.papers.map((p) => {
    const nums = students.map((s) => (s.paperScores && s.paperScores[sub.id] ? s.paperScores[sub.id][p.id] : undefined)).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    if (val === null) return '<td class="num">—</td>';
    if (mode === 'sum') return `<td class="num">${Math.round(val)}/${nums.length * (Number(p.out_of) || 100)}</td>`;
    return `<td class="num">${val.toFixed(2)}</td>`;
  }).join('');
  const pctNums = students.map((s) => s.subjectPct && s.subjectPct[sub.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
  const pctVal = aggregate(pctNums, mode);
  let pctCell;
  if (pctVal === null) pctCell = '<td class="num">—</td>';
  else if (mode === 'sum') pctCell = `<td class="num"><b>${Math.round(pctVal)}/${pctNums.length * 100}</b></td>`; // subjectPct is already 0-100
  else pctCell = `<td class="num"><b>${pctVal.toFixed(2)}</b></td>`;
  return `${paperCells}${pctCell}`;
}
function aggRowHtml(label, subjects, students, mode, examOutOf) {
  return `<tr class="bs-agg-row"><td class="id-col"></td><td class="name-col"><b>${esc(label)}</b></td><td class="str-col"></td>
    ${subjects.map((sub) => subjectAggCellsHtml(sub, students, mode, examOutOf)).join('')}
    <td class="num sum-col" colspan="9"></td>
  </tr>`;
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
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/stream yet.</p></div></div></div>`;
    return;
  }
  if (!res.subjects.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No published subjects yet</h3><p>A subject only appears on the Mark List once its results are published — assign subjects and publish results, then come back.</p></div></div></div>`;
    return;
  }

  // Round 2 §1/§2: apply the school's Mark List display preferences once,
  // right after fetching — everything below (screen grid, summary tables,
  // Excel export) reads from this SAME adjusted list, so the two can never
  // disagree with each other.
  res.subjects = applyMeritListDisplayPrefs(res.subjects, settings);

  // Round 6 §4 (Sprint Review redo): the earned/possible ("870/1200")
  // total-of-total format belongs on the class-level TOTAL row at the
  // bottom of the sheet (see aggRowHtml/subjectAggCellsHtml below), NOT on
  // each student's own TT MKS figure — that column reverted back to a
  // plain rounded number per the review. Still need the exam's out_of
  // here to compute each subject's "possible" on that TOTAL row.
  const examOutOf = Number(res.exam.out_of) || 100;

  // Sprint Review §8: same "missing key means true" default as
  // show_papers_separately — ticked yes unless a school has explicitly
  // turned it off.
  const showLevels = settings.show_achievement_levels === undefined ? true : String(settings.show_achievement_levels) === 'true';

  sheetEl.innerHTML = `
    <div class="report-toolbar no-print">
      <button class="btn secondary" id="bs-download">⬇️ Download Excel</button>
      ${printOptionsHtml('bs', 'landscape')}
    </div>
    <div class="card">
      <!-- Sprint Review bug: this div used to carry border-bottom:1px solid
           var(--line), left over from before the green title bar existed —
           it printed as a stray grey line directly under reportTitleBarHtml's
           solid green rectangle. printHeader.mjs's own comment already says
           "no divider line under this row anymore"; this was the one place
           that hadn't caught up. -->
      <div class="card-b" style="padding-bottom:12px">
        ${printHeaderHtml(settings)}
        ${reportTitleBarHtml(`${res.exam.name} — Mark List — ${cls ? cls.name : ''}`)}
      </div>
      <div class="card-b table-wrap"><table class="mark-list-grid">
        <thead><tr><th class="id-col">Adm. No.</th><th class="name-col">Name</th><th class="str-col">Stream</th>
          ${res.subjects.map((s) => subjectHeaderHtml(s)).join('')}
          <th class="num sum-col">SBJ</th><th class="num sum-col">TT MKS</th><th class="num sum-col">MN MKS</th><th class="num sum-col">PL</th>
          <th class="num sum-col">TT PTS</th><th class="num sum-col">MN PTS</th><th class="num sum-col">DEV</th><th class="num sum-col">STREAM POS</th><th class="num sum-col">OVR POS</th></tr></thead>
        <tbody>${res.students.map((s) => `<tr>
          <td class="id-col">${esc(s.admission_no)}</td><td class="name-col">${esc(s.full_name)}</td><td class="str-col">${esc(s.stream_name || '—')}</td>
          ${res.subjects.map((sub) => subjectRowCellsHtml(sub, s, showLevels)).join('')}
          <td class="num sum-col">${s.subject_count}</td>
          <td class="num sum-col"><b>${s.total.toFixed(2)}</b></td><td class="num sum-col">${s.average.toFixed(2)}</td>
          <td class="num sum-col">${showLevels ? `<span class="badge grade">${esc(s.overall_grade || '—')}</span>` : '—'}</td>
          <td class="num sum-col">${s.total_points === null ? '—' : s.total_points.toFixed(2)}</td><td class="num sum-col">${s.mean_points === null ? '—' : s.mean_points.toFixed(2)}</td>
          <td class="num sum-col">${s.deviation > 0 ? '+' : ''}${s.deviation.toFixed(2)}</td>
          <td class="num sum-col">${s.stream_position || '—'}</td><td class="num sum-col"><b>${s.position || '—'}</b></td>
        </tr>`).join('')}${aggRowHtml('TOTAL', res.subjects, res.students, 'sum', examOutOf)}${aggRowHtml('AVERAGE', res.subjects, res.students, 'avg', examOutOf)}</tbody>
      </table></div>
      ${showLevels ? summaryTablesHtml(res.students, res.subjects, bands) : ''}
    </div>
  `;
  // Next Sprint 2 §8: margins halved (10mm -> 5mm) specifically for this
  // screen so there's room to bump the grid's font size without the wide,
  // many-subject-column table overflowing the printed page width.
  wirePrintOptions(sheetEl, 'bs', `${cls ? cls.name : 'Class'} Mark List — ${res.exam.name}`, 5);
  sheetEl.querySelector('#bs-download').onclick = () => {
    const streamSel = root.querySelector('#bs-stream');
    const streamName = streamSel && streamSel.selectedIndex > 0 ? streamSel.options[streamSel.selectedIndex].textContent : '';
    const aoa = buildBroadsheetAoa({ settings, exam: res.exam, cls, streamName, subjects: res.subjects, students: res.students, class_average: res.class_average, showLevels });
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
// Sprint Review EX5 (redesign, approved after the black-grid mockup):
// the Round 6 §4 boxed 2x2 tile layout was rejected — this reverts to the
// original unboxed heading + table look (plain heading text, no bordered
// "tile" wrapper), with Class Grade Summary and Gender Grade Summary side
// by side (`.grid2`, same 2-column class used elsewhere in the app) and
// Grade Breakdown by Subject on its own full-width row below them, not
// wrapped alongside. Every table still uses `print-grid` (black borders/
// text) so the black-on-white look approved in the mockup carries through.
function summaryHeadingHtml(title, note) {
  return `<div style="font-weight:700;font-size:12.5px;margin-bottom:6px;color:#000">${esc(title)}</div>
    ${note ? `<p class="hint" style="margin:0 0 6px">${note}</p>` : ''}`;
}

function summaryTablesHtml(students, subjects, bands) {
  const { gradeOrder, totalStudents, totalGraded, ungraded, classSummary, genderSummary, subjectBreakdown } = computeGradeSummaries(students, subjects, bands);
  if (!gradeOrder.length) return '';

  const ungradedNote = ungraded > 0
    ? `${totalGraded} of ${totalStudents} student(s) graded — ${ungraded} still has${ungraded === 1 ? '' : 've'} no marks entered for this exam yet, so ${ungraded === 1 ? "isn't" : "aren't"} in the breakdown below.`
    : '';

  return `
    <div class="card-b bs-summary" style="border-top:1.3px solid var(--grid-ink)">
      <div class="grid2">
        <div>
          ${summaryHeadingHtml('Class Grade Summary', ungradedNote)}
          <div class="table-wrap"><table class="print-grid">
            <thead><tr><th>Grade</th><th class="num">Students</th><th class="num">%</th></tr></thead>
            <tbody>${classSummary.map((r) => `<tr>
                <td><b>${esc(r.grade)}</b></td><td class="num">${r.count}</td><td class="num">${r.pct}%</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div>
        <div>
          ${summaryHeadingHtml('Gender Grade Summary', '')}
          <div class="table-wrap"><table class="print-grid">
            <thead><tr><th>Grade</th><th class="num">Male</th><th class="num">Female</th><th class="num">Total</th></tr></thead>
            <tbody>${genderSummary.map((r) => `<tr>
                <td><b>${esc(r.grade)}</b></td><td class="num">${r.male}</td><td class="num">${r.female}</td><td class="num">${r.total}</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>
      <div style="margin-top:20px">
        ${summaryHeadingHtml('Grade Breakdown by Subject', '')}
        <div class="table-wrap"><table class="print-grid">
          <thead><tr>
            <th>Subject</th>${gradeOrder.map((g) => `<th class="num">${esc(g)}</th>`).join('')}
            <th class="num">Mean Marks</th><th class="num">Mean Points</th><th>Performance Level</th>
          </tr></thead>
          <tbody>${subjectBreakdown.map((row) => `<tr>
            <td>${esc(row.subject_name)}</td>${gradeOrder.map((g) => `<td class="num">${row.counts[g] || '—'}</td>`).join('')}
            <td class="num">${row.mean_marks === null ? '—' : row.mean_marks.toFixed(2)}</td>
            <td class="num">${row.mean_points === null ? '—' : row.mean_points.toFixed(2)}</td>
            <td>${esc(row.performance_level || '—')}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
    </div>
  `;
}
