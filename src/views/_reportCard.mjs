import { esc } from '../app.js';
import { printHeaderHtml } from '../lib/printHeader.mjs';

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
  const meanPoints = pointsCounted.length ? Math.round((totalPoints / pointsCounted.length) * 100) / 100 : null;
  const outOfTotal = (Number(exam.out_of) || 100) * (subjects.length || 1);

  const initials = (s.full_name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  container.innerHTML = `
    <div class="report">
      <div class="r-head">
        ${printHeaderHtml(settings, 'Academic Report Form')}
      </div>
      <div class="r-title-bar">${esc(s.class_name)}${s.stream_name ? ' ' + esc(s.stream_name) : ''} — ${esc(exam.name)}${data.term_name ? ' · ' + esc(data.term_name) : ''}${data.session_name ? ' · ' + esc(data.session_name) : ''}</div>
      <div class="r-student-row">
        <div class="r-avatar">${esc(initials)}</div>
        <div class="r-meta">
          <div><span>Name</span><b>${esc(s.full_name)}</b></div>
          <div><span>Admission No.</span><b>${esc(s.admission_no)}</b></div>
          <div><span>Class</span><b>${esc(s.class_name)}</b></div>
          <div><span>Stream</span><b>${esc(s.stream_name || '—')}</b></div>
          <div><span>Gender</span><b>${esc(s.gender)}</b></div>
          <div><span>Position</span><b>${data.position ? `${data.position} of ${data.class_size}` : '—'}</b></div>
        </div>
        ${classAvgBySubject ? chartHtml(subjects, classAvgBySubject) : ''}
      </div>
      <div class="r-summary">
        <div class="box"><div class="v">${esc(data.overall_grade || '—')}</div><div class="l">Performance Level</div></div>
        <div class="box"><div class="v">${data.total} / ${outOfTotal}</div><div class="l">Total Marks</div></div>
        <div class="box"><div class="v">${totalPoints === null ? '—' : totalPoints}</div><div class="l">Total Points</div></div>
        <div class="box"><div class="v">${meanPoints === null ? '—' : meanPoints}</div><div class="l">Mean Points</div></div>
        <div class="box"><div class="v">${data.position ? `<span class="pos-pill">#${data.position}</span>` : '—'}</div><div class="l">Position (of ${data.class_size})</div></div>
      </div>
      <div class="r-body">
        <div class="table-wrap"><table class="report-grid">
          <thead><tr><th>Learning Area</th><th class="num">Marks</th><th class="num">Dev.</th><th class="num">Grade</th><th>Comment</th><th>Teacher</th></tr></thead>
          <tbody>${subjects.map((sub) => {
            const dev = classAvgBySubject && classAvgBySubject[sub.subject_id] !== undefined && classAvgBySubject[sub.subject_id] !== null
              ? Math.round((sub.score - classAvgBySubject[sub.subject_id]) * 100) / 100 : null;
            const teacher = teacherBySubject[sub.subject_id] || '—';
            return `<tr>
              <td>${esc(sub.subject_name)}</td><td class="num">${sub.score}</td>
              <td class="num">${dev === null ? '—' : `${dev > 0 ? '+' : ''}${dev}`}</td>
              <td class="num"><span class="badge blue">${esc(sub.grade_label || '—')}</span></td>
              <td>${esc(sub.remark || '—')}</td><td>${esc(teacher)}</td>
            </tr>`;
          }).join('') || '<tr><td colspan="6" class="muted center">No marks recorded for this exam.</td></tr>'}</tbody>
        </table></div>
        ${remarksHtml(s, data.overall_grade, bands)}
        ${termDatesHtml(settings)}
        ${descriptorsHtml(bands)}
      </div>
    </div>
  `;
}

/** Brief §16: two optional parent-facing fields — "School Closed On" and
 *  "Next Term Begins On" — set (with a date picker) in School Settings and
 *  simply displayed here when present; nothing prints when a school hasn't
 *  set either one, since both are explicitly optional. */
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
  return `<div class="r-term-dates">
    ${closed ? `<div>School closes on: <b>${esc(closed)}</b></div>` : ''}
    ${nextTerm ? `<div>Next term begins on: <b>${esc(nextTerm)}</b></div>` : ''}
  </div>`;
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

/** A small inline "Learning Area Performance – Student vs Class" line chart —
 *  no charting library needed, just a hand-rolled SVG polyline per series. */
function chartHtml(subjects, classAvgBySubject) {
  if (!subjects.length) return '';
  const w = 210, h = 90, padX = 6, padY = 8;
  const max = 100;
  const stepX = subjects.length > 1 ? (w - padX * 2) / (subjects.length - 1) : 0;
  const y = (v) => h - padY - (Math.max(0, Math.min(max, v)) / max) * (h - padY * 2);
  const studentPts = subjects.map((sub, i) => `${(padX + i * stepX).toFixed(1)},${y(sub.score).toFixed(1)}`).join(' ');
  const hasClassLine = subjects.some((sub) => classAvgBySubject[sub.subject_id] !== undefined && classAvgBySubject[sub.subject_id] !== null);
  const classPts = hasClassLine
    ? subjects.map((sub, i) => `${(padX + i * stepX).toFixed(1)},${y(classAvgBySubject[sub.subject_id] || 0).toFixed(1)}`).join(' ')
    : '';
  return `
    <div class="r-chart">
      <div class="r-chart-title">Learning Area Performance — Student vs Class</div>
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
        ${hasClassLine ? `<polyline points="${classPts}" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="3,3"/>` : ''}
        <polyline points="${studentPts}" fill="none" style="stroke:var(--brand)" stroke-width="2.2"/>
      </svg>
      <div class="muted" style="font-size:9.5px;text-align:center">— Student &nbsp; ┄ Class avg.</div>
    </div>
  `;
}
