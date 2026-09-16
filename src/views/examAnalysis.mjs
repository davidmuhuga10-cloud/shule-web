/**
 * examAnalysis.mjs — "Exam Analysis" reports (feature brief §7), redesigned
 * per live feedback into TWO separate downloadable/printable reports on one
 * screen: a "Class Analysis Report" (stat row, Zeraki-style charts, the full
 * Per Learning Area grade-summary table, a combined Overall/Boys/Girls
 * table, and NEW per-subject By Stream / By Gender breakdown tables) and a
 * "Top Students Report" (podium, top-students tables, per-subject
 * leaderboards as plain stacked sections — explicitly NOT tabs/pills, that
 * read as a dashboard — and NEW "Most Improved" sections against whichever
 * exam is set as the class's Deviation Exam).
 *
 * Built entirely from Db.results.getBroadsheet() (see src/lib/examAnalysis.mjs
 * for the aggregation) rather than a new RPC, and follows the same
 * printable-report standard as the Mark List/Class List/Score Sheet (shared
 * header, paper size/orientation controls, mandatory contact info before
 * printing). Each report has its own Print/Download control; printing one
 * temporarily hides the other so only that report ends up on paper/PDF.
 */
import { esc, options, renderPrereq, renderPrereqOrConnectivity, loader, go, printOptionsHtml, wirePrintOptions, toast } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsxAOA } from '../lib/xlsxUtil.mjs';
import { buildExamAnalysis } from '../lib/examAnalysis.mjs';
import { buildExamAnalysisAoa } from '../lib/examAnalysisXlsx.mjs';
import { printHeaderHtml, reportTitleBarHtml, isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';

export async function viewExamAnalysis(root) {
  // Perf/UX fix: paint the page shell instantly instead of leaving the
  // router's bare spinner up for the full round trip — see examDesk.mjs's
  // viewExamDesk for the fuller explanation of why this matters.
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Exam Analysis</h2><p>Top students and class-wide performance analysis for one exam and class.</p></div></div>
    <div class="card"><div class="card-b">
      <div class="skeleton" style="width:100%;height:60px;margin-bottom:12px"></div>
      <div class="skeleton" style="width:100%;height:60px"></div>
    </div></div>
  `;
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  // Round 6 §5 (recurring BUG, same class as Round 4 §5's Mark List fix):
  // a lost/flaky connection used to get silently treated the same as
  // "genuinely no classes exist yet", showing the misleading "No classes
  // found" message even on a fully set-up school — refreshing "fixed" it
  // because the retry just happened to succeed. Check `.ok` on each fetch
  // BEFORE falling back to an empty array, same renderPrereqOrConnectivity
  // pattern every other screen with this exact class of bug now uses.
  if (!examsRes.ok || !classesRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewExamAnalysis(root) });
    return;
  }
  const exams = examsRes.data;
  const classes = classesRes.data;
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
  // System Fixes brief §18 (mobile audit): this table was missing the
  // .table-wrap wrapper its sibling gradeSummaryTable() (below) already
  // has — an 8-column table with no wrap overflows the screen on a phone
  // instead of scrolling within its own box.
  //
  // Round 7: "Score" here is either a student's overall TOTAL MARKS (the
  // "Top Students/Boys/Girls - Overall" tables — src/lib/examAnalysis.mjs
  // passes `s.total`) or one subject's own score (the per-subject tables —
  // `s.scores[sub.id]`). Both are marks, and marks must never show as a
  // decimal, so this rounds to a whole number instead of .toFixed(2).
  return `<div style="margin-top:14px">
    <div style="font-weight:700;font-size:12.5px;margin-bottom:6px">${esc(title)}</div>
    <div class="table-wrap"><table class="print-grid"><thead><tr>
      <th>Admno</th><th>Name</th><th>Stream</th><th class="num">Stream Rank</th><th class="num">Ovrl Rank</th><th class="num">Score</th><th>Performance Level</th><th>Gender</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td>${esc(r.stream_name || '—')}</td>
      <td class="num">${r.stream_rank} / ${r.stream_total}</td><td class="num">${r.overall_rank} / ${r.overall_total}</td>
      <td class="num"><b>${Math.round(r.score)}</b></td><td>${esc(r.level || '—')}</td><td>${esc(r.gender || '—')}</td>
    </tr>`).join('')}</tbody></table></div>
  </div>`;
}

function gradeSummaryTable(title, rows, bandLabels) {
  if (!rows.length) return '';
  return `<div style="margin-top:14px">
    <div style="font-weight:700;font-size:12.5px;margin-bottom:6px">${esc(title)}</div>
    <div class="table-wrap"><table class="print-grid"><thead><tr>
      <th>&nbsp;</th>${bandLabels.map((l) => `<th class="num">${esc(l)}</th>`).join('')}<th class="num">X</th>
      <th class="num">Entries</th><th class="num">Mean Marks</th><th class="num">Mean Points</th><th>Performance Level</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${esc(r.label || r.subject_name)}</td>${bandLabels.map((l) => `<td class="num">${r.band_counts[l] || 0}</td>`).join('')}<td class="num">${r.x_count}</td>
      <td class="num">${r.entries}</td><td class="num">${r.mean_marks.toFixed(2)}</td><td class="num">${r.mean_points.toFixed(2)}</td><td>${esc(r.performance_level || '—')}</td>
    </tr>`).join('')}</tbody></table></div>
  </div>`;
}

/** Zeraki-style line chart — Learning Area Mean Points, one point per
 *  subject, in whatever order per_subject already lists them. Plain inline
 *  SVG (no charting library) since this is a printed report, not a live
 *  dashboard — it has to render identically in a browser's print/Save-as-PDF
 *  path with no JS re-render at print time. */
// Live feedback (repeated): "lines, borders, axis should not be gray... deep
// black" + "change the colour from green to pink or blue a sharper colour" —
// both charts' axes/gridlines/labels are pure black, and the data
// line/bars use a sharp blue instead of the earlier teal (which read as
// "green" to the school) — CHART_COLOR is the one place that controls both.
const CHART_COLOR = '#1d4ed8';
function lineChartSvg(perSubject) {
  if (!perSubject.length) return '<div style="font-size:12px;color:#000">No data yet.</div>';
  const W = 560, H = 210, padL = 30, padR = 14, padT = 14, padB = 34;
  const n = perSubject.length;
  const maxV = Math.max(4, ...perSubject.map((s) => s.mean_points)) * 1.15;
  const stepX = n > 1 ? (W - padL - padR) / (n - 1) : 0;
  const yFor = (v) => padT + (1 - (v / maxV)) * (H - padT - padB);
  const points = perSubject.map((s, i) => ({ x: padL + stepX * i, y: yFor(s.mean_points), s }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => padT + f * (H - padT - padB));
  const grid = gridY.map((y) => `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#000" stroke-width="0.6"/>`).join('');
  const gridLabels = gridY.map((y) => `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="#000" text-anchor="end">${Math.round(maxV * (1 - (y - padT) / (H - padT - padB)))}</text>`).join('');
  const dots = points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" fill="${CHART_COLOR}"/><text x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" font-size="9.5" fill="#000" text-anchor="middle" font-weight="700">${p.s.mean_points.toFixed(1)}</text>`).join('');
  const labels = points.map((p) => `<text x="${p.x.toFixed(1)}" y="${H - padB + 16}" font-size="9" fill="#000" text-anchor="middle">${esc((p.s.subject_code || p.s.subject_name || '').slice(0, 10))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img">${grid}${gridLabels}<path d="${path}" fill="none" stroke="${CHART_COLOR}" stroke-width="2.4"/>${dots}${labels}</svg>`;
}

/** Zeraki-style bar chart — Overall Grade Distribution, one bar per band
 *  (plus an "X" bucket for ungraded/absent), from the combined class's
 *  band_counts already computed by buildExamAnalysis(). Now with a Y axis
 *  (gridlines + counts) to match the line chart, per feedback that it was
 *  missing one. */
function barChartSvg(bandLabels, overallRow) {
  const cats = bandLabels.concat(['X']);
  const counts = cats.map((l) => (l === 'X' ? overallRow.x_count : (overallRow.band_counts[l] || 0)));
  const W = 560, H = 210, padL = 28, padR = 14, padT = 14, padB = 30;
  const maxV = Math.max(1, ...counts) * 1.2;
  const n = cats.length;
  const slot = (W - padL - padR) / n;
  const barW = Math.min(34, slot * 0.55);
  const plotH = H - padT - padB;
  const yFor = (v) => padT + (1 - (v / maxV)) * plotH;
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => padT + f * plotH);
  const grid = gridY.map((y) => `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#000" stroke-width="0.6"/>`).join('');
  const gridLabels = gridY.map((y) => `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="#000" text-anchor="end">${Math.round(maxV * (1 - (y - padT) / plotH))}</text>`).join('');
  const bars = cats.map((l, i) => {
    const cx = padL + slot * i + slot / 2;
    const y = yFor(counts[i]);
    const h = (padT + plotH) - y;
    return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${CHART_COLOR}" rx="2"/>
      <text x="${cx.toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="9.5" fill="#000" text-anchor="middle" font-weight="700">${counts[i]}</text>
      <text x="${cx.toFixed(1)}" y="${H - padB + 14}" font-size="9.5" fill="#000" text-anchor="middle">${esc(l)}</text>`;
  }).join('');
  const base = padT + plotH;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img">${grid}${gridLabels}<line x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}" stroke="#000" stroke-width="1"/>${bars}</svg>`;
}

function medal(rank) { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉'; }

function podiumHtml(top3) {
  if (!top3.length) return '';
  return `<div class="ea-podium">${top3.map((r) => `
    <div class="ea-podium-c ${r.overall_rank === 1 ? 'p1' : ''}">
      <div class="ea-podium-rank">${medal(r.overall_rank)} RANK ${r.overall_rank}</div>
      <div class="ea-podium-name">${esc(r.full_name)}</div>
      <div class="ea-podium-sub">${esc(r.admission_no)} · ${esc(r.stream_name || '—')}</div>
      <div class="ea-podium-score">${Math.round(r.score)}</div>
    </div>`).join('')}</div>`;
}

/** "Most Improved" — 2 cards, previous→current + delta, against whichever
 *  exam is the class's Deviation Exam. Callers only invoke this once
 *  `rows.length` has already been confirmed non-empty (buildExamAnalysis()
 *  itself returns an empty array whenever no Deviation Exam is set, or it
 *  had nothing to compare against — this never renders an empty section). */
function mostImprovedHtml(title, rows, devExamName) {
  if (!rows.length) return '';
  return `<div style="margin-top:16px">
    <div style="font-weight:700;font-size:12.5px;margin-bottom:2px">${esc(title)}</div>
    <div class="ea-mi-note">vs ${esc(devExamName)}</div>
    <div class="ea-mi-grid">${rows.map((r) => `
      <div class="ea-mi-c">
        <div class="ea-mi-name">${esc(r.full_name)}</div>
        <div class="ea-mi-sub">${esc(r.admission_no)} · ${esc(r.stream_name || '—')}</div>
        <div class="ea-mi-scores">${r.previous_score.toFixed(1)} → ${r.current_score.toFixed(1)}</div>
        <div class="ea-mi-delta">▲ +${r.delta.toFixed(1)}</div>
      </div>`).join('')}</div>
  </div>`;
}

/** ONE shared print/download toolbar with a tick box per report ("Class
 *  Analysis Report" / "Top Students Report") instead of two separate
 *  toolbars (which meant scrolling down to reach the second one). Both
 *  ticked (the default) prints/downloads them together as one combined
 *  document — Class Analysis pages, then Top Students pages, since they're
 *  just sibling elements on the same printable page flow; ticking only one
 *  hides the other's DOM for the duration of that one print/download, same
 *  'afterprint'/'focus'/timeout safety-net restore pattern every other print
 *  helper in this app already uses.
 *
 *  Live feedback clarified this stays — the only real bug was the shared
 *  app-wide mobile behaviour that swaps every "🖨️ Print" button's label to
 *  "⬇️ Download" on a phone (main.css's print-btn-label-mobile/-desktop):
 *  on THIS screen specifically that swap wasn't actually working right, so
 *  #ea-print-btn is exempted from it (see main.css) and always reads
 *  "🖨️ Print" — desktop is untouched, and every other report's own print
 *  button keeps the normal mobile "Download" label. */
// The two reports on this screen (Class Analysis / Top Students) are each
// individually tick-able, so printing needs to know which are actually
// wanted — without this it would always print both regardless of the
// checkboxes. Wraps whichever Print button app.js rendered (hide/restore
// around it) with no changes needed in app.js itself.
// ROUND 7 note: app.js's mobile-only "Download PDF" button (#idPrefix-pdf-btn)
// this used to also wrap has been removed entirely — Print is now the only
// way to get a PDF anywhere in the app (see app.js's ROUND 7 comment on
// printOptionsHtml()). wrap()'s own null-check makes that querySelector here
// a harmless no-op now rather than something that needs cleaning up.
function wireCombinedPrint(root, idPrefix, sections) {
  const wrap = (btn) => {
    if (!btn) return;
    const inner = btn.onclick;
    btn.onclick = (e) => {
      const toHide = sections.filter((s) => s.checkbox && !s.checkbox.checked && s.el);
      if (toHide.length === sections.length) {
        toast('Tick at least one report to print or download.', 'err');
        return;
      }
      toHide.forEach((s) => { s.el.style.display = 'none'; });
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        toHide.forEach((s) => { s.el.style.display = ''; });
        window.removeEventListener('afterprint', restore);
        window.removeEventListener('focus', restore);
      };
      window.addEventListener('afterprint', restore);
      window.addEventListener('focus', restore);
      inner(e);
      setTimeout(restore, 120000);
    };
  };
  wrap(root.querySelector(`#${idPrefix}-print-btn`));
  wrap(root.querySelector(`#${idPrefix}-pdf-btn`));
}

async function load(root, classes, sel) {
  const sheetEl = root.querySelector('#ea-sheet');
  sheetEl.innerHTML = loader();
  // Live feedback: "remove the info for deviation exam... that's already
  // entered while analysing the exam before it's published, use that info —
  // if not included ignore and show analysis report as it should be, if
  // included use that info." The manual "Deviation Exam" picker card that
  // used to live on this screen (Round 3 §16) is gone — getBroadsheet()
  // already resolves whatever was configured at publish time (exam_classes.
  // deviation_exam_id, set via Publish Results) straight into
  // bsRes.deviation_exam, and both reports below already render nothing
  // deviation-related whenever that's null. Nothing left here needs
  // listDeviationExamChoices() or a Save button.
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
  const examClassName = `${cls ? cls.name : 'Class'} — ${bsRes.exam.name}`;
  const classSuggestedName = `${examClassName} — Class Analysis Report`.replace(/[\\/:*?"<>|]+/g, '');

  const overallSummaryRows = [analysis.class_grade_summary.overall];
  if (analysis.boys_count) overallSummaryRows.push(analysis.class_grade_summary.boys);
  if (analysis.girls_count) overallSummaryRows.push(analysis.class_grade_summary.girls);

  const classAnalysisHtml = `
    <div class="card ea-report" id="ea-class-report">
      <div class="card-b" style="padding-bottom:12px">
        ${printHeaderHtml(settings)}
        <!-- Same approved letterhead/title-bar design as the Mark List
             (broadsheet.mjs): class far left, exam centered, report name
             far right — see reportTitleBarHtml()'s array form. -->
        <!-- Live feedback: "the name class analysis report should not be
             cut, just call it analysis report" — shortened label instead of
             relying on truncation to make the longer one fit. -->
        ${reportTitleBarHtml([cls ? cls.name : '', bsRes.exam.name, 'Analysis Report'])}
      </div>
      <div class="card-b">
        <div class="ea-stat-row">
          <div class="ea-stat-tile"><div class="ea-stat-l">STUDENTS WHO SAT</div><div class="ea-stat-v">${analysis.students_sat}</div></div>
          <!-- Sprint Review correction (final): every aggregate figure
               (Mean Marks, Mean Points, and every figure below) keeps 2dp
               — only an individual subject's own score rounds to a whole
               number. -->
          <div class="ea-stat-tile"><div class="ea-stat-l">MEAN MARKS</div><div class="ea-stat-v">${analysis.mean_marks.toFixed(2)}</div></div>
          <div class="ea-stat-tile"><div class="ea-stat-l">MEAN POINTS</div><div class="ea-stat-v">${analysis.mean_points.toFixed(2)}</div></div>
        </div>
        <div class="center" style="margin-top:8px"><span class="badge grade">${esc(analysis.performance_level || '—')}</span></div>
        ${bsRes.deviation_exam ? `
        <div class="center" style="margin-top:10px">
          <span class="badge ${bsRes.deviation_exam.delta >= 0 ? 'green' : 'red'}">vs ${esc(bsRes.deviation_exam.exam_name)}: ${bsRes.deviation_exam.delta > 0 ? '+' : ''}${bsRes.deviation_exam.delta.toFixed(2)} mean marks (${bsRes.deviation_exam.class_average.toFixed(2)} then → ${analysis.mean_marks.toFixed(2)} now)</span>
        </div>` : ''}

        <div class="ea-chart-grid">
          <div class="ea-chart-card"><div class="ea-chart-h">Learning Area Mean Points</div>${lineChartSvg(analysis.per_subject)}</div>
          <div class="ea-chart-card"><div class="ea-chart-h">Overall Grade Distribution</div>${barChartSvg(analysis.band_labels, analysis.class_grade_summary.overall)}</div>
        </div>

        <div style="margin-top:22px;font-weight:750;font-size:13.5px">CLASS GRADE SUMMARY</div>
        ${gradeSummaryTable('Per Learning Area', analysis.class_grade_summary.per_subject, analysis.band_labels)}
        ${gradeSummaryTable('Overall (Boys vs Girls)', overallSummaryRows, analysis.band_labels)}

        ${analysis.per_subject.map((sub) => `
          <div style="margin-top:20px;font-weight:750;font-size:13.5px">${esc(sub.subject_name.toUpperCase())}</div>
          ${sub.by_stream.length ? gradeSummaryTable('By Stream', sub.by_stream, analysis.band_labels) : ''}
          ${gradeSummaryTable('By Gender', sub.by_gender, analysis.band_labels)}
        `).join('')}
      </div>
    </div>`;

  const topStudentsHtml = `
    <div class="card ea-report" id="ea-top-report">
      <div class="card-b" style="padding-bottom:12px">
        ${printHeaderHtml(settings)}
        ${reportTitleBarHtml([cls ? cls.name : '', bsRes.exam.name, 'Top Students Report'])}
      </div>
      <div class="card-b">
        <div style="font-weight:750;font-size:13.5px">TOP 3 — OVERALL</div>
        ${podiumHtml(analysis.top_students_overall)}

        <div style="margin-top:20px;font-weight:750;font-size:13.5px">OVERALL — TOP STUDENTS</div>
        ${topTable('Top Students - Overall', analysis.top_students_overall)}
        <div class="grid2">
          ${topTable('Top Boys - Overall', analysis.top_boys_overall)}
          ${topTable('Top Girls - Overall', analysis.top_girls_overall)}
        </div>
        ${bsRes.deviation_exam ? mostImprovedHtml('MOST IMPROVED — OVERALL', analysis.most_improved_overall, bsRes.deviation_exam.exam_name) : ''}

        ${analysis.per_subject.map((sub) => `
          <div style="margin-top:22px;font-weight:750;font-size:13.5px">${esc(sub.subject_name.toUpperCase())}</div>
          ${topTable(`Top Students - ${sub.subject_name}`, sub.top_students)}
          ${topTable(`Top Boys - ${sub.subject_name}`, sub.top_boys)}
          ${topTable(`Top Girls - ${sub.subject_name}`, sub.top_girls)}
          ${bsRes.deviation_exam ? mostImprovedHtml(`MOST IMPROVED — ${sub.subject_name.toUpperCase()}`, sub.most_improved, bsRes.deviation_exam.exam_name) : ''}
        `).join('')}
        ${!bsRes.deviation_exam ? `<div class="ea-mi-note" style="margin-top:18px">Set a Deviation Exam when publishing this exam for this class to also show "Most Improved" sections here.</div>` : ''}
      </div>
    </div>`;

  // Live feedback: "I must scroll down the analysis report to get top
  // students report — introduce two buttons [tick boxes] in the same line
  // where we have print... when both are ticked the report will come as one
  // combined, if one is ticked that is what will print." One shared toolbar,
  // tick boxes on the left, Download/Print controls on the right.
  const combinedSuggestedName = `${examClassName} — Analysis Reports`.replace(/[\\/:*?"<>|]+/g, '');
  sheetEl.innerHTML = `
    <div class="report-toolbar no-print" style="justify-content:space-between">
      <div class="ea-report-checks">
        <label><input type="checkbox" id="ea-check-class" checked> Class Analysis Report</label>
        <label><input type="checkbox" id="ea-check-top" checked> Top Students Report</label>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button class="btn secondary xlsx-download-btn" id="ea-download">⬇️ Download Excel</button>
        ${printOptionsHtml('ea', 'portrait')}
      </div>
    </div>
    ${classAnalysisHtml}
    ${topStudentsHtml}
  `;

  const classReportEl = sheetEl.querySelector('#ea-class-report');
  const topReportEl = sheetEl.querySelector('#ea-top-report');

  // Round 8 live feedback: "the header should not have any margin at all to
  // the top/left/right, BUT ONLY ON THE FIRST PAGE" — 0mm on page 1 via the
  // 7th arg (firstPageMarginMm), normal 6mm margin (4th arg, reverted to
  // its original value) on every subsequent page. Same reasoning as
  // broadsheet.mjs's own wirePrintOptions() call (see its comment there for
  // the full explanation and the physical-printer caveat). Args 5/6
  // (fitSelector/headerSelector) are left undefined — this screen has no
  // wide-table auto-fit target, unlike the Mark List.
  wirePrintOptions(sheetEl, 'ea', combinedSuggestedName, 6, undefined, undefined, 0);
  wireCombinedPrint(sheetEl, 'ea', [
    { checkbox: sheetEl.querySelector('#ea-check-class'), el: classReportEl },
    { checkbox: sheetEl.querySelector('#ea-check-top'), el: topReportEl }
  ]);

  sheetEl.querySelector('#ea-download').onclick = () => {
    const aoa = buildExamAnalysisAoa({ settings, exam: bsRes.exam, cls, analysis });
    downloadXlsxAOA(classSuggestedName, aoa, 'Exam Analysis');
  };
}
