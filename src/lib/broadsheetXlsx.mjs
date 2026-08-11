/**
 * broadsheetXlsx.mjs — pure, testable builder for the Mark List's "Download
 * Excel" export (feature request: "make sure the mark list can be
 * downloaded also as excel and should come with school details at the
 * top"). Kept separate from views/broadsheet.mjs (which imports app.js and
 * so can't be unit-tested directly) so the layout logic has real test
 * coverage — same split as xlsxUtil.mjs's own pure-core/browser-wrapper
 * convention.
 */

/** Learning Area Papers: expands `subjects` into a flat list of export
 *  columns — one column for a normal subject, or (one per paper + one
 *  combined "%") for a subject with papers configured for this exam. Built
 *  once and reused for both the header row and every student row so the
 *  two can never drift out of alignment. */
function buildSubjectColumns(subjects) {
  const columns = [];
  (subjects || []).forEach((sub) => {
    if (sub.papers && sub.papers.length) {
      sub.papers.forEach((p) => columns.push({ type: 'paper', subject: sub, paper: p, header: `${sub.code || sub.name} ${p.name}` }));
      columns.push({ type: 'pct', subject: sub, header: `${sub.code || sub.name} %` });
    } else {
      columns.push({ type: 'combined', subject: sub, header: sub.code || sub.name });
    }
  });
  return columns;
}

function columnCell(col, student) {
  if (col.type === 'paper') {
    const raw = (student.paperScores && student.paperScores[col.subject.id]) || {};
    const v = raw[col.paper.id];
    // Round 6 §1: rounded for display same as the on-screen Mark List's
    // paperCell() — a teacher can enter a fractional per-paper mark same
    // as any other score field.
    return v === null || v === undefined ? '—' : String(Math.round(v));
  }
  if (col.type === 'pct') {
    const pct = student.subjectPct ? student.subjectPct[col.subject.id] : null;
    if (pct === null || pct === undefined) return '—';
    const gr = student.grades[col.subject.id];
    return gr && gr.grade_label ? `${pct} (${gr.grade_label})` : String(pct);
  }
  let score = student.scores[col.subject.id];
  if (score === null || score === undefined) return '—';
  // Round 5 §2 rounded ONLY a combined subject's score (a weighted sum
  // across differently-scaled member subjects very often lands on a
  // decimal). Round 6 §1 (BUG): a plain subject's own raw mark can carry
  // the same 2dp precision and was still showing it here — round EVERY
  // subject's score for display, same as the on-screen Mark List
  // (views/broadsheet.mjs), so the Excel export and the screen never show
  // two different numbers for the same subject, combined or not.
  score = Math.round(score);
  const gr = student.grades[col.subject.id];
  return gr && gr.grade_label ? `${score} (${gr.grade_label})` : String(score);
}

/** Round 5 §2: same TOTAL/AVERAGE rows the on-screen Mark List now shows at
 *  the bottom of its grid (views/broadsheet.mjs's aggRowHtml) — one figure
 *  per subject column, summed/averaged across every student in this export.
 *  Kept in lockstep with the screen version's rounding rules (whole numbers
 *  for a Learning Area Papers % column or a combined subject, 2dp
 *  otherwise) so the download never disagrees with what was on screen. */
function aggregate(nums, mode) {
  if (!nums.length) return null;
  const sum = nums.reduce((a, v) => a + v, 0);
  return mode === 'sum' ? sum : sum / nums.length;
}
function columnAggCell(col, students, mode) {
  if (col.type === 'paper') {
    const nums = students.map((s) => s.paperScores && s.paperScores[col.subject.id] ? s.paperScores[col.subject.id][col.paper.id] : undefined).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    // Round 6 §1: whole number, not 2dp — see columnCell() above.
    return val === null ? '—' : Math.round(val);
  }
  if (col.type === 'pct') {
    const nums = students.map((s) => s.subjectPct && s.subjectPct[col.subject.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    return val === null ? '—' : Math.round(val);
  }
  const nums = students.map((s) => s.scores[col.subject.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
  const val = aggregate(nums, mode);
  if (val === null) return '—';
  // Round 6 §1: whole number for every subject, not just combinations.
  return Math.round(val);
}

/** Builds the Mark List export as an array-of-arrays: school details first
 *  (name, then address/contact if any are set) followed by a blank row,
 *  the exam/class/stream title, another blank row, then the same grid
 *  shown on screen — one row per student, one column per subject (score
 *  and grade combined into one cell, since a spreadsheet cell can't show
 *  the two-line badge the on-screen table uses; a Learning Area Papers
 *  subject instead gets one raw column per paper plus a combined "% "
 *  column) plus the summary columns, and a trailing class-average row. */
export function buildBroadsheetAoa({ settings, exam, cls, streamName, subjects, students, class_average }) {
  settings = settings || {};
  subjects = subjects || [];
  students = students || [];

  const contactBits = [];
  if (settings.po_box) contactBits.push('P.O. Box ' + settings.po_box);
  if (settings.phone) contactBits.push(settings.phone);
  if (settings.email) contactBits.push(settings.email);

  const aoa = [];
  aoa.push([settings.school_name || 'School']);
  if (contactBits.length) aoa.push([contactBits.join('  |  ')]);
  aoa.push([`${exam.name} — Mark List — ${cls ? cls.name : ''}${streamName ? ' (' + streamName + ')' : ''}`]);
  aoa.push([]);

  const columns = buildSubjectColumns(subjects);
  aoa.push(['Adm. No.', 'Name', 'Arm', ...columns.map((c) => c.header), 'SBJ', 'TT MKS', 'MN MKS', 'PL', 'TT PTS', 'MN PTS', 'DEV', 'ARM POS', 'OVR POS']);

  // Round 6 §1: TT MKS/MN MKS/TT PTS/MN PTS/DEV/class-average all rounded
  // to whole numbers for display here too, same as the on-screen Mark
  // List — the underlying values (s.total, s.average, etc, computed in
  // results.mjs) keep their exact precision for ranking; only the export
  // display rounds.
  // Round 6 §3: TT MKS shown as "earned/possible" (e.g. "830/1230"), same
  // as the on-screen Mark List (views/broadsheet.mjs) — see that file's
  // comment for why subject_count * examOutOf is the right "possible".
  const examOutOf = Number(exam && exam.out_of) || 100;
  students.forEach((s) => {
    const subjCells = columns.map((c) => columnCell(c, s));
    const deviation = Math.round(s.deviation);
    aoa.push([
      s.admission_no, s.full_name, s.stream_name || '—', ...subjCells,
      s.subject_count, `${Math.round(s.total)}/${s.subject_count * examOutOf}`, Math.round(s.average), s.overall_grade || '—',
      s.total_points === null || s.total_points === undefined ? '—' : Math.round(s.total_points),
      s.mean_points === null || s.mean_points === undefined ? '—' : Math.round(s.mean_points),
      deviation > 0 ? `+${deviation}` : deviation,
      s.stream_position || '—', s.position || '—'
    ]);
  });

  aoa.push(['', 'TOTAL', '', ...columns.map((c) => columnAggCell(c, students, 'sum'))]);
  aoa.push(['', 'AVERAGE', '', ...columns.map((c) => columnAggCell(c, students, 'avg'))]);
  aoa.push([]);
  aoa.push(['Class average:', class_average === null || class_average === undefined || isNaN(class_average) ? class_average : Math.round(class_average)]);
  return aoa;
}
