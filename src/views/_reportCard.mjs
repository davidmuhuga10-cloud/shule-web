import { esc } from '../app.js';
import { printHeaderHtml, reportTitleBarHtml } from '../lib/printHeader.mjs';

/**
 * Renders a Report Form (report card) into `container` from a
 * get_report_card() RPC payload — redesigned Zeraki-style (feature brief
 * "Report Forms and Merit List Design"): school header, a blue title bar, a
 * student info row with an avatar + optional "student vs class" line chart,
 * summary boxes (Performance Level / Total Marks / Total Points / Mean
 * Points / Position), and a bordered learning-area grid with Dev. and
 * Teacher columns.
 *
 * `extra` is optional and additive so the three very different-permission
 * callers (staff: reportForms.mjs, parent: myChildren.mjs, student:
 * myResults.mjs) can all keep working:
 *   - extra.settings           — school_name/logo/po_box/phone/email, for
 *                                 the header. Every role can read `settings`
 *                                 (RLS: readable by any authenticated member
 *                                 of the school), so all three callers pass
 *                                 this.
 *   - extra.teacherBySubject   — { subject_id: teacher full_name }. Staff
 *                                 only (comes from listSubmissions(), which
 *                                 is a staff-facing query) — degrades to '—'.
 *   - extra.classAvgBySubject  — { subject_id: class average score }. Staff
 *                                 only (derived from getBroadsheet()) — used
 *                                 for the Dev. column and the chart; both
 *                                 are omitted when not supplied.
 *   - extra.bands              — the school's default grading-scale bands
 *                                 ([{grade_label,points,min_score,max_score,
 *                                 remark}, ...]). Every role can read
 *                                 `grade_ranges`/`grading_scales` (same
 *                                 school-wide RLS as `settings`), so all
 *                                 three callers pass this too — it drives
 *                                 both the auto-generated Class
 *                                 Teacher's/Principal's remarks (brief:
 *                                 "remarks are a must... the system should
 *                                 know how to give remarks based on the
 *                                 performance of the learner") and the
 *                                 Grade Descriptors table at the bottom.
 */
export function renderReportCard(container, data, extra) {
  extra = extra || {};
  const settings = extra.settings || {};
  const teacherBySubject = extra.teacherBySubject || {};
  const classAvgBySubject = extra.classAvgBySubject || null;
  const bands = (extra.bands || []).slice().sort((a, b) => Number(b.min_score) - Number(a.min_score));
  const s = data.student, exam = data.exam;
  const subjects = data.subjects || [];

  const pointsCounted = subjects.filter((x) => x.points !== null && x.points !== undefined && x.points !== '');
  const totalPoints = pointsCounted.length ? pointsCounted.reduce((a, x) => a + Number(x.points), 0) : null;
  // Round 6 §1: whole number, not 2dp — same "no subject should ever
  // report marks as a decimal" fix as the Mark List (views/broadsheet.mjs),
  // applied here to the Report Form's own summary boxes. get_report_card()
  // (schema.sql / migrations/0028_round_report_card.sql) now rounds
  // `total`/`average`/each subject's `score` the same way at the source —
  // this JS-side rounding is a defensive backstop so the display is
  // correct even against an older, not-yet-migrated database.
  const meanPoints = pointsCounted.length ? Math.round(totalPoints / pointsCounted.length) : null;
  const outOfTotal = (Number(exam.out_of) || 100) * (subjects.length || 1);

  const initials = (s.full_name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  // Print-robustness pass: a first exam (nobody else's results in yet) or a
  // single-student class has no real class average to compare against —
  // classAvgBySubject then either arrives as null, or as an object where
  // every subject's value is null/undefined. Either way, hasDeviation is
  // false and the whole "Dev. (vs Class)" column is left out of the table
  // (not just dashed out row by row) — see the colgroup/thead/tbody below,
  // which reflow the remaining 5 columns to fill the freed-up width instead
  // of leaving an empty-looking gap.
  const hasDeviation = !!classAvgBySubject && subjects.some((sub) => classAvgBySubject[sub.subject_id] !== undefined && classAvgBySubject[sub.subject_id] !== null);

  container.innerHTML = `
    <div class="report">
      <div class="r-head">
        ${printHeaderHtml(settings)}
      </div>
      ${reportTitleBarHtml(`${s.class_name || ''}${s.stream_name ? ' ' + s.stream_name : ''} — ${exam.name || ''}${data.term_name ? ' · ' + data.term_name : ''}${data.session_name ? ' · ' + data.session_name : ''}`)}
      <div class="r-student-row">
        <div class="r-avatar">${esc(initials)}</div>
        <div class="r-meta">
          <div><span>Name</span><b>${esc(s.full_name)}</b></div>
          <div><span>Admission No.</span><b>${esc(s.admission_no)}</b></div>
          <div><span>Class</span><b>${esc(s.class_name)}</b></div>
          <div><span>Arm</span><b>${esc(s.stream_name || '—')}</b></div>
          <div><span>Gender</span><b>${esc(s.gender)}</b></div>
          <div><span>Position</span><b>${data.position ? `${data.position} of ${data.class_size}` : '—'}</b></div>
        </div>
        ${classAvgBySubject ? chartHtml(subjects, classAvgBySubject) : ''}
      </div>
      <div class="r-summary">
        <div class="box"><div class="v">${esc(data.overall_grade || '—')}</div><div class="l">Performance Level</div></div>
        <div class="box"><div class="v">${Math.round(data.total)} / ${outOfTotal}</div><div class="l">Total Marks</div></div>
        <div class="box"><div class="v">${totalPoints === null ? '—' : Math.round(totalPoints)}</div><div class="l">Total Points</div></div>
        <div class="box"><div class="v">${meanPoints === null ? '—' : meanPoints}</div><div class="l">Mean Points</div></div>
      </div>
      <div class="r-body">
        <div class="table-wrap"><table class="report-grid">
          <colgroup>
            ${hasDeviation
              ? '<col style="width:22%"><col style="width:9%"><col style="width:12%"><col style="width:9%"><col style="width:26%"><col style="width:22%">'
              : '<col style="width:24%"><col style="width:11%"><col style="width:11%"><col style="width:30%"><col style="width:24%">'}
          </colgroup>
          <thead><tr><th>Learning Area</th><th class="num">Marks</th>${hasDeviation ? `<th class="num" title="This subject's score minus the class average for the same subject, in this exam only.">Dev. (vs Class)</th>` : ''}<th class="num">Grade</th><th>Performance Level</th><th>Teacher</th></tr></thead>
          <tbody>${subjects.map((sub) => {
            const dev = hasDeviation && classAvgBySubject[sub.subject_id] !== undefined && classAvgBySubject[sub.subject_id] !== null
              ? Math.round(sub.score - classAvgBySubject[sub.subject_id]) : null;
            const teacher = teacherBySubject[sub.subject_id] || '—';
            return `<tr>
              <td>${esc(sub.subject_name)}</td><td class="num">${Math.round(sub.score)}</td>
              ${hasDeviation ? `<td class="num">${dev === null ? '—' : `${dev > 0 ? '+' : ''}${dev}`}</td>` : ''}
              <td class="num"><span class="badge grade">${esc(sub.grade_label || '—')}</span></td>
              <td>${esc(sub.remark || '—')}</td><td>${esc(teacher)}</td>
            </tr>`;
          }).join('') || `<tr><td colspan="${hasDeviation ? 6 : 5}" class="muted center">No marks recorded for this exam.</td></tr>`}</tbody>
        </table></div>
        ${classAvgBySubject ? `<p class="hint no-print" style="margin:6px 0 0">Performance Level column = this subject's grade band, written out (e.g. "Exceeding expectation").${hasDeviation ? ' Dev. (vs Class) = this student\'s score minus the class average for that learning area, in this exam — no prior exam is used or needed here.' : ' A Dev. (vs Class) column appears once there\'s a class average to compare against — e.g. once more than one student\'s results are recorded for this exam.'} A class-wide comparison against a chosen prior exam is available under Exam Analysis.</p>` : ''}
        ${settings.show_pathway_summary === 'true' ? clusterSummaryHtml(subjects) : ''}
        ${remarksHtml(s, data.overall_grade, bands)}
        ${termDatesHtml(settings)}
        ${descriptorsHtml(bands)}
      </div>
      ${mottoHtml(settings)}
    </div>
  `;
}

/** §4: subject-cluster averages (STEM / Social Sciences / Arts and Sport
 *  Science), shown as a small 3-column table under the main learning-area
 *  grid, matching the reference report. There's no per-school "which
 *  cluster is this subject in" setting yet, so this classifies by matching
 *  common CBC subject-name keywords — good enough to cover the standard CBC
 *  subject list this app already seeds (see seed_school_defaults() in
 *  supabase/migrations), but a school's own custom-named subject that
 *  doesn't match any keyword is simply left out of all three clusters
 *  rather than guessed into the wrong one. If a cluster ends up with zero
 *  matched subjects for this particular student, its box shows "—" instead
 *  of being dropped, so the row's shape stays the same report to report. */
const CLUSTER_KEYWORDS = {
  'STEM': ['math', 'science', 'technology', 'technical', 'agriculture', 'home science', 'computer', 'ict'],
  'Social Sciences': ['social studies', 'religious', 'cre', 'ire', 'english', 'kiswahili', 'language', 'history', 'geography', 'business'],
  'Arts and Sport Science': ['creative art', 'sport', 'physical', 'music', 'art activities']
};
function classifySubjectCluster(name) {
  const n = String(name || '').toLowerCase();
  for (const cluster of Object.keys(CLUSTER_KEYWORDS)) {
    if (CLUSTER_KEYWORDS[cluster].some((kw) => n.includes(kw))) return cluster;
  }
  return null;
}
function clusterSummaryHtml(subjects) {
  if (!subjects.length) return '';
  const clusters = Object.keys(CLUSTER_KEYWORDS);
  const buckets = {};
  clusters.forEach((c) => { buckets[c] = []; });
  subjects.forEach((sub) => {
    const c = classifySubjectCluster(sub.subject_name);
    if (c) buckets[c].push(Number(sub.score) || 0);
  });
  const hasAny = clusters.some((c) => buckets[c].length);
  if (!hasAny) return '';
  return `
    <div class="r-clusters">
      <div class="table-wrap"><table class="r-cluster-grid">
        <thead><tr>${clusters.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody><tr>${clusters.map((c) => {
          const vals = buckets[c];
          const avg = vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10 : null;
          return `<td>${avg === null ? '—' : avg}</td>`;
        }).join('')}</tr></tbody>
      </table></div>
    </div>
  `;
}

/** §6: a branded finishing strip at the very bottom of the report — the
 *  school's own motto, if they've set one in Settings. Nothing prints when
 *  no motto is set (same "only show what's actually configured" rule as
 *  the term dates section). */
function mottoHtml(settings) {
  const motto = String(settings.school_motto || '').trim();
  if (!motto) return '';
  return `<div class="r-motto">School Motto: ${esc(motto)}</div>`;
}

/** Brief §16: two optional parent-facing fields — "School Closed On" and
 *  "Next Term Begins On" — simply displayed here when present; nothing
 *  prints when a school hasn't set either one, since both are explicitly
 *  optional. Round 3 §4: edited from the Report Forms module now (see
 *  reportForms.mjs), not School Settings — still the exact same
 *  `settings.school_closed_on`/`next_term_begins_on` values underneath, so
 *  this display logic didn't need to change at all. */
function fmtReportDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function termDatesHtml(settings) {
  const closed = fmtReportDate(settings.school_closed_on);
  const nextTerm = fmtReportDate(settings.next_term_begins_on);
  if (!closed && !nextTerm) return '';
  return `
    <div class="r-term-dates-h">Term Dates</div>
    <table class="r-term-dates-grid">
      <thead><tr><th>Term Ends</th><th>Next Term Begins</th></tr></thead>
      <tbody><tr><td>${closed ? esc(closed) : '—'}</td><td>${nextTerm ? esc(nextTerm) : '—'}</td></tr></tbody>
    </table>
  `;
}

/** Auto-generated Class Teacher's / Principal's remarks (feature brief:
 *  "remarks are a must.. the system should know how to give remarks based
 *  on the performance of the learner" — no free-text box, a signature line
 *  instead, same as the Zeraki reference). Classifies the student's overall
 *  band into a quartile of however many bands the school's default scale
 *  has (works whether that's the 8-band CBC default or a school's own
 *  custom letter-grade scale) rather than string-matching a specific
 *  remark label, so it isn't hard-wired to the CBC preset's exact wording. */
const TIER_REMARKS = [
  {
    teacher: (n) => `${n}, excellent work! You consistently demonstrate a deep understanding and have exceeded the learning expectations. Keep up your outstanding effort!`,
    principal: (n) => `${n}, outstanding performance! Your dedication to exceeding expectations is commendable and reflects positively on our school community. Well done!`
  },
  {
    teacher: (n) => `${n}, well done — you have met the learning expectations for this term. Keep working hard to build on this progress.`,
    principal: (n) => `${n}, a solid term's work. Keep up the consistency and aim even higher next term.`
  },
  {
    teacher: (n) => `${n}, you are making steady progress and are approaching the learning expectations. With more effort and consistent practice, you will meet them fully.`,
    principal: (n) => `${n}, keep pushing — steady improvement will get you to meeting the expectations. We believe in you.`
  },
  {
    teacher: (n) => `${n}, you have not yet met the learning expectations this term. Extra support and consistent practice will help you improve.`,
    principal: (n) => `${n}, let's work together to turn this around next term — please speak to your teachers for extra support.`
  }
];
const FALLBACK_REMARK = {
  teacher: (n) => `${n}, keep working hard and stay consistent with your studies this term.`,
  principal: (n) => `${n}, we encourage you to keep working hard and to reach out to your teachers for any support you need.`
};

function pickRemark(overallGrade, bands) {
  if (bands.length) {
    const idx = bands.findIndex((b) => b.grade_label === overallGrade);
    if (idx !== -1) {
      const tier = Math.min(3, Math.floor((idx / bands.length) * 4));
      return TIER_REMARKS[tier];
    }
  }
  return FALLBACK_REMARK;
}

function remarksHtml(student, overallGrade, bands) {
  const firstName = (student.full_name || 'The learner').trim().split(/\s+/)[0];
  const remark = pickRemark(overallGrade, bands);
  return `
    <div class="r-remarks">
      <div class="r-remark-box">
        <div class="r-remark-h">Class Teacher's Remarks</div>
        <p>${esc(remark.teacher(firstName))}</p>
        <div class="r-sig">Signature: <span class="r-sig-line"></span></div>
      </div>
      <div class="r-remark-box">
        <div class="r-remark-h">Principal's Remarks</div>
        <p>${esc(remark.principal(firstName))}</p>
        <div class="r-sig">Signature: <span class="r-sig-line"></span></div>
      </div>
    </div>
  `;
}

/** The "Grade Descriptors" reference table — whatever bands the school's
 *  default grading scale actually has (not hard-coded to CBC's 4/8 bands),
 *  so a custom scale still shows its own real ranges here.
 *
 *  System Fixes brief §10: TRANSPOSED — performance levels run across as
 *  COLUMNS instead of down as rows (image4 -> image5 in the brief), so this
 *  table takes a fixed 2 rows of vertical space no matter how many bands the
 *  school's scale has, instead of growing one row taller per band — the
 *  single biggest contributor to the form spilling onto a second printed
 *  page for scales with a lot of bands (e.g. CBC's 8-band default). Each
 *  band's optional remark moves into its column header (under the grade
 *  label) instead of being dropped, so no information is lost in the swap. */
function descriptorsHtml(bands) {
  if (!bands.length) return '';
  return `
    <div class="r-descriptors">
      <div class="r-descriptors-h">Grade Descriptors</div>
      <div class="table-wrap"><table class="report-grid r-descriptors-grid">
        <thead><tr>
          <th>Performance Level</th>
          ${bands.map((b) => `<th class="num"><b>${esc(b.grade_label)}</b>${b.remark ? `<div class="r-descriptor-remark">${esc(b.remark)}</div>` : ''}</th>`).join('')}
        </tr></thead>
        <tbody>
          <tr><td>Points</td>${bands.map((b) => `<td class="num">${esc(b.points === null || b.points === undefined ? '—' : b.points)}</td>`).join('')}</tr>
          <tr><td>Range (%)</td>${bands.map((b) => `<td class="num">${esc(b.min_score)}–${esc(b.max_score)}</td>`).join('')}</tr>
        </tbody>
      </table></div>
    </div>
  `;
}

/** A wide "Learning Area Performance – Student vs Class" line chart, styled
 *  after the Zeraki reference — full-width (fills whatever the flex layout
 *  gives .r-chart, see main.css), with y-axis % gridlines and per-subject
 *  x-axis labels instead of a small bare polyline. No charting library
 *  needed, just hand-rolled SVG. */
function chartHtml(subjects, classAvgBySubject) {
  if (!subjects.length) return '';
  // Reference-layout pass (§1): "significantly more visual room" — taller
  // viewBox (was 150, now 220) plus the legend moved out of its own
  // dedicated line into the same row as the title (see .r-chart-head),
  // so all the extra height goes to the actual plot, not chrome around it.
  const w = 480, h = 220, padL = 28, padR = 10, padT = 8, padB = 26;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const max = 100;
  const stepX = subjects.length > 1 ? innerW / (subjects.length - 1) : 0;
  const x = (i) => padL + i * stepX;
  const y = (v) => padT + innerH - (Math.max(0, Math.min(max, v)) / max) * innerH;
  const studentPts = subjects.map((sub, i) => `${x(i).toFixed(1)},${y(sub.score).toFixed(1)}`).join(' ');
  const hasClassLine = subjects.some((sub) => classAvgBySubject[sub.subject_id] !== undefined && classAvgBySubject[sub.subject_id] !== null);
  const classPts = hasClassLine
    ? subjects.map((sub, i) => `${x(i).toFixed(1)},${y(classAvgBySubject[sub.subject_id] || 0).toFixed(1)}`).join(' ')
    : '';
  // Soft grey area fill under the class-average line — the same "shaded
  // baseline" treatment the reference chart uses, drawn as a closed polygon
  // (the line's points, then straight down to the plot's bottom edge).
  const classArea = hasClassLine
    ? `${classPts} ${x(subjects.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)}`
    : '';
  const gridLines = [0, 25, 50, 75, 100].map((v) => `
    <line x1="${padL}" x2="${w - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e6ebf1" stroke-width="1"/>
    <text x="${padL - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="#6b7a8d">${v}</text>
  `).join('');
  const xLabels = subjects.map((sub, i) => `
    <text x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle" font-size="8" fill="#6b7a8d">${esc((sub.subject_name || '').slice(0, 3).toUpperCase())}</text>
  `).join('');
  return `
    <div class="r-chart">
      <div class="r-chart-head">
        <div class="r-chart-title">Learning Area Performance — Student vs Class</div>
        <div class="r-chart-legend"><span><i></i>Student</span><span><i class="avg"></i>Class avg.</span></div>
      </div>
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        ${gridLines}
        ${hasClassLine ? `<polygon points="${classArea}" fill="#cfd6de" opacity="0.35"/>` : ''}
        ${hasClassLine ? `<polyline points="${classPts}" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4,3"/>` : ''}
        <polyline points="${studentPts}" fill="none" style="stroke:var(--brand)" stroke-width="2.6"/>
        ${subjects.map((sub, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(sub.score).toFixed(1)}" r="2.6" style="fill:var(--brand)"/>`).join('')}
        ${xLabels}
      </svg>
    </div>
  `;
}
