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
  // Perf/UX fix: paint the page shell instantly instead of leaving the
  // router's bare spinner up for the full round trip — see examDesk.mjs's
  // viewExamDesk for the fuller explanation of why this matters.
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Mark List</h2><p>Students &times; subjects, with grades, points and position — stream and overall.</p></div></div>
    <div class="card"><div class="card-b">
      <div class="skeleton" style="width:100%;height:60px;margin-bottom:12px"></div>
      <div class="skeleton" style="width:100%;height:60px"></div>
    </div></div>
  `;
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
function cell(score, gr, showLevels, tintClass) {
  if (score === null || score === undefined) return `<td class="num${tintClass}">—</td>`;
  // Live feedback: "trying to avoid marks being in bold can help us a
  // little — let's just have the headers and total and average at the
  // bottom as the only bold. PL, total marks, ovr position should also be
  // in bold" — this used to wrap every individual subject mark in <b>,
  // which is the bulk of the ink on the page fighting the header/summary
  // rows for attention. Plain weight now; the header row (.mark-list-grid
  // th), the TOTAL/AVERAGE rows (.bs-agg-row), and the per-student TT
  // MKS/PL/OVR POS cells below keep their bold.
  //
  // ROUND 2 (reverted): a later round tried removing ALL of that extra
  // bold too, plus tighter padding/bigger font and DEV rounded to 1dp —
  // live feedback called the result "awkward" and asked to revert
  // completely back to normal font size and bold. Back to the state
  // above; DEV is back to 2dp too (see subjectRowCellsHtml below).
  return `<td class="num mark-cell${tintClass}">${score}${showLevels && gr && gr.grade_label ? ` <span class="mark-grade">${esc(gr.grade_label)}</span>` : ''}</td>`;
}

/** Plain-number cell for one paper's raw score — no grade badge (Learning
 *  Area Papers brief: "per-paper rows are NOT graded individually"; the
 *  combined % column carries the grade instead). Round 6 §1: rounded for
 *  display same as every other mark on this sheet — a teacher can enter a
 *  fractional mark for a paper same as any other score field. */
function paperCell(score, tintClass) {
  return score === null || score === undefined ? `<td class="num${tintClass}">—</td>` : `<td class="num${tintClass}">${Math.round(score)}</td>`;
}

/** Legibility pass (live feedback comparing our printout to Zeraki's):
 *  alternating subjects get a pale tint across their WHOLE column group —
 *  header + every data/agg cell, paper sub-columns included — so a
 *  subject reads as one visual block without needing another heavy
 *  border. `idx` is the subject's position among all shown subjects
 *  (0-based); odd subjects get tinted, even ones stay plain white. */
function subjectHeaderHtml(sub, idx) {
  const tint = idx % 2 === 1 ? ' subj-tint' : '';
  if (!sub.papers || !sub.papers.length) return `<th class="num subj-col${tint}">${esc(sub.code || sub.name)}</th>`;
  // Paper sub-columns use the narrower paper-col width (see main.css) —
  // they only ever hold a bare number, never a grade badge, so they don't
  // need the wider subj-col reserved for a "score + grade label" pairing.
  const paperHeaders = sub.papers.map((p) => `<th class="num paper-col${tint}">${esc(sub.code || sub.name)} ${esc(p.name)}</th>`).join('');
  return `${paperHeaders}<th class="num subj-col${tint}">${esc(sub.code || sub.name)} %</th>`;
}

function subjectRowCellsHtml(sub, student, showLevels, idx) {
  const tintClass = idx % 2 === 1 ? ' subj-tint' : '';
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
    return cell(displayScore, student.grades[sub.id], showLevels, tintClass);
  }
  const raw = (student.paperScores && student.paperScores[sub.id]) || {};
  const paperCells = sub.papers.map((p) => paperCell(raw[p.id] === undefined ? null : raw[p.id], tintClass)).join('');
  const pct = student.subjectPct ? student.subjectPct[sub.id] : null;
  return `${paperCells}${cell(pct === null || pct === undefined ? null : pct, student.grades[sub.id], showLevels, tintClass)}`;
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
// Live feedback: the combined "870/1200" (earned/possible) format packed
// into one TOTAL-row cell was hard to read at a glance — asked to split it
// into its own two rows instead: TOTAL (just the earned figure) directly
// above a new OUT OF row (just the possible figure), with AVERAGE staying
// where it already was, below both. `sumPart` ('earned' | 'outof') picks
// which half of that pair a 'sum' mode row shows; it's ignored for 'avg'
// mode, which was never a combined earned/possible figure to begin with.
function subjectAggCellsHtml(sub, students, mode, examOutOf, sumPart) {
  if (!sub.papers || !sub.papers.length) {
    const nums = students.map((s) => s.scores[sub.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    if (val === null) return '<td class="num">—</td>';
    // Round 6 §1: whole number for every subject's TOTAL/AVERAGE row, not
    // just Subject Combinations (see subjectRowCellsHtml above for why).
    if (mode === 'sum') {
      return sumPart === 'outof'
        ? `<td class="num"><b>${nums.length * examOutOf}</b></td>`
        : `<td class="num"><b>${Math.round(val)}</b></td>`;
    }
    // Sprint Review correction: the AVERAGE row is this sheet's "Mean
    // Marks" figure — an explicit exception to the "round everything to a
    // whole number" rule, so it keeps 2 decimal places instead.
    return `<td class="num"><b>${val.toFixed(2)}</b></td>`;
  }
  const paperCells = sub.papers.map((p) => {
    const nums = students.map((s) => (s.paperScores && s.paperScores[sub.id] ? s.paperScores[sub.id][p.id] : undefined)).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    if (val === null) return '<td class="num">—</td>';
    if (mode === 'sum') {
      return sumPart === 'outof'
        ? `<td class="num">${nums.length * (Number(p.out_of) || 100)}</td>`
        : `<td class="num">${Math.round(val)}</td>`;
    }
    return `<td class="num">${val.toFixed(2)}</td>`;
  }).join('');
  const pctNums = students.map((s) => s.subjectPct && s.subjectPct[sub.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
  const pctVal = aggregate(pctNums, mode);
  let pctCell;
  if (pctVal === null) pctCell = '<td class="num">—</td>';
  else if (mode === 'sum') {
    // subjectPct is already 0-100
    pctCell = sumPart === 'outof'
      ? `<td class="num"><b>${pctNums.length * 100}</b></td>`
      : `<td class="num"><b>${Math.round(pctVal)}</b></td>`;
  } else pctCell = `<td class="num"><b>${pctVal.toFixed(2)}</b></td>`;
  return `${paperCells}${pctCell}`;
}
function aggRowHtml(label, subjects, students, mode, examOutOf, sumPart) {
  return `<tr class="bs-agg-row"><td class="id-col"></td><td class="name-col"><b>${esc(label)}</b></td><td class="str-col"></td>
    ${subjects.map((sub) => subjectAggCellsHtml(sub, students, mode, examOutOf, sumPart)).join('')}
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
  //
  // Round 7: explicit instruction — a student's marks (individual subject
  // scores AND their TT MKS total) must never display as a decimal, so TT
  // MKS below now shows Math.round(s.total) instead of s.total.toFixed(2).
  // `s.total` itself stays the exact, unrounded sum at the API layer (see
  // results.mjs) because it's also the field ranking sorts/ties by — only
  // the on-screen/PDF/Excel presentation rounds. MN MKS (Mean Marks/
  // "average") is a deliberate, separate exception that keeps 2dp, per the
  // Sprint Review correction already documented on subjectAggCellsHtml
  // above.
  const examOutOf = Number(res.exam.out_of) || 100;

  // Sprint Review §8: same "missing key means true" default as
  // show_papers_separately — ticked yes unless a school has explicitly
  // turned it off.
  const showLevels = settings.show_achievement_levels === undefined ? true : String(settings.show_achievement_levels) === 'true';

  sheetEl.innerHTML = `
    <div class="report-toolbar no-print">
      <!-- Live feedback: "the buttons look scattered — arrange them well" —
           Download Excel + the print controls used to be loose siblings in
           this toolbar; every Finance report already groups its own
           equivalent pair into one visually distinct pill (.fin-report-
           actions, see financeTrail.mjs/financeReports.mjs) instead of
           leaving them to float separately, so this now matches that same
           established pattern rather than inventing a new one. -->
      <div class="fin-report-actions">
        <!-- Live feedback: "I should see Download as Excel, not just
             Download" — .xlsx-download-btn is already hidden entirely on
             mobile (main.css, max-width:960px), so its own label text only
             ever shows on desktop; spelling it out doesn't touch mobile at
             all. -->
        <button class="btn secondary xlsx-download-btn" id="bs-download">⬇️ Download as Excel</button>
        <!-- Live feedback: repeated, unresolved reports of the Mark List
             printing in portrait no matter what, with wildly inconsistent
             blank gaps down the page — briefly blamed on lockOrientation
             (dropped for a round, matching Class List's plain, unlocked
             dropdown) while investigating, but the ACTUAL cause turned out
             to be unrelated: autoFitPrintWidth() below was shrinking this
             table with a CSS transform, which repaints an element smaller
             without changing the page-flow size the browser's own print
             pagination measures — proven with a real before/after test
             (see autoFitPrintWidth's own comment). Fixed there, using
             CSS zoom instead. With the real bug gone, lockOrientation is
             restored — the Mark List's many columns never make sense in
             portrait, exactly why this was locked to landscape in the
             first place; Class List has no such restriction because it
             never needed one. -->
        ${printOptionsHtml('bs', 'landscape', { lockOrientation: true })}
      </div>
    </div>
    <div class="card">
      <!-- Sprint Review bug: this div used to carry border-bottom:1px solid
           var(--line), left over from before the green title bar existed —
           it printed as a stray grey line directly under reportTitleBarHtml's
           solid green rectangle. printHeader.mjs's own comment already says
           "no divider line under this row anymore"; this was the one place
           that hadn't caught up. -->
      <!-- id="bs-print-header": lets wirePrintOptions() below stretch this
           block to match the Mark List table's own auto-fit width — see
           autoFitPrintWidth()'s headerEl comment (app.js) for why they'd
           otherwise fall out of alignment once the table shrinks/bleeds
           past this card's normal 20px padding. -->
      <div class="card-b" id="bs-print-header" style="padding-bottom:12px">
        ${printHeaderHtml(settings)}
        <!-- Approved design (Option 2D): class far left, exam name centered,
             the report's own name ("Mark List") far right, enlarged — see
             reportTitleBarHtml()'s array form in printHeader.mjs. -->
        ${reportTitleBarHtml([cls ? cls.name : '', res.exam.name, 'Mark List'])}
      </div>
      <div class="card-b table-wrap" id="bs-table-wrap"><table class="mark-list-grid">
        <thead><tr><th class="id-col">Adm. No.</th><th class="name-col">Name</th><th class="str-col">Stream</th>
          ${res.subjects.map((s, i) => subjectHeaderHtml(s, i)).join('')}
          <th class="num sum-col">SBJ</th><th class="num sum-col">TT MKS</th><th class="num sum-col">MN MKS</th><th class="num sum-col">PL</th>
          <th class="num sum-col">TT PTS</th><th class="num sum-col">MN PTS</th><th class="num sum-col dev-col">DEV</th><th class="num sum-col">STREAM POS</th><th class="num sum-col">OVR POS</th></tr></thead>
        <tbody>${res.students.map((s) => `<tr>
          <td class="id-col">${esc(s.admission_no)}</td><td class="name-col">${esc(s.full_name)}</td><td class="str-col">${esc(s.stream_name || '—')}</td>
          ${res.subjects.map((sub, i) => subjectRowCellsHtml(sub, s, showLevels, i)).join('')}
          <td class="num sum-col">${s.subject_count}</td>
          <td class="num sum-col"><b>${Math.round(s.total)}</b></td><td class="num sum-col">${s.average.toFixed(2)}</td>
          <td class="num sum-col">${showLevels ? `<span class="badge grade"><b>${esc(s.overall_grade || '—')}</b></span>` : '—'}</td>
          <td class="num sum-col">${s.total_points === null ? '—' : s.total_points.toFixed(2)}</td><td class="num sum-col">${s.mean_points === null ? '—' : s.mean_points.toFixed(2)}</td>
          <td class="num sum-col dev-col">${s.deviation > 0 ? '+' : ''}${s.deviation.toFixed(2)}</td>
          <td class="num sum-col">${s.stream_position || '—'}</td><td class="num sum-col"><b>${s.position || '—'}</b></td>
        </tr>`).join('')}${aggRowHtml('TOTAL', res.subjects, res.students, 'sum', examOutOf, 'earned')}${aggRowHtml('OUT OF', res.subjects, res.students, 'sum', examOutOf, 'outof')}${aggRowHtml('AVERAGE', res.subjects, res.students, 'avg', examOutOf)}</tbody>
      </table></div>
      ${showLevels ? summaryTablesHtml(res.students, res.subjects, bands) : ''}
    </div>
  `;
  // Next Sprint 2 §8: margins halved (10mm -> 5mm) specifically for this
  // screen so there's room to bump the grid's font size without the wide,
  // many-subject-column table overflowing the printed page width. The 5th
  // arg (new) is the fit-target selector — see autoFitPrintWidth() in
  // app.js: this table's fixed column widths can sum wider than even a
  // landscape page once a school has enough subjects, and this guarantees
  // no column is ever silently clipped off the printed page.
  wirePrintOptions(sheetEl, 'bs', `${cls ? cls.name : 'Class'} Mark List — ${res.exam.name}`, 5, '.mark-list-grid', '#bs-print-header');
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
