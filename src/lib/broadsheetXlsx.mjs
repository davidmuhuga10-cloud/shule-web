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

// Sprint Review §8: "Show achievement levels on the Mark List" — when a
// school has this off, the grade letter in parentheses is dropped from
// every cell here too, mirroring the on-screen Mark List (views/
// broadsheet.mjs's cell()) so the download never disagrees with the screen.
function columnCell(col, student, showLevels) {
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
    return showLevels && gr && gr.grade_label ? `${pct} (${gr.grade_label})` : String(pct);
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
  return showLevels && gr && gr.grade_label ? `${score} (${gr.grade_label})` : String(score);
}

/** Round 5 §2: same TOTAL/AVERAGE rows the on-screen Mark List now shows at
 *  the bottom of its grid (views/broadsheet.mjs's aggRowHtml) — one figure
 *  per subject column, summed/averaged across every student in this export.
 *  Kept in lockstep with the screen version's rounding rules — TOTAL shows
 *  earned/possible as whole numbers, AVERAGE ("Mean Marks") keeps 2dp — so
 *  the download never disagrees with what was on screen. */
function aggregate(nums, mode) {
  if (!nums.length) return null;
  const sum = nums.reduce((a, v) => a + v, 0);
  return mode === 'sum' ? sum : sum / nums.length;
}
// Sprint Review redo of Round 6 §3: the earned/possible ("870/1200")
// total-of-total format moved off the per-student TT MKS figure and onto
// the class-level TOTAL row's subject columns instead — mirrors
// views/broadsheet.mjs's subjectAggCellsHtml exactly, including only
// applying it to the 'sum' row (an AVERAGE isn't a "total" and has no
// "possible" of its own).
function columnAggCell(col, students, mode, examOutOf) {
  if (col.type === 'paper') {
    const nums = students.map((s) => s.paperScores && s.paperScores[col.subject.id] ? s.paperScores[col.subject.id][col.paper.id] : undefined).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    if (val === null) return '—';
    if (mode === 'sum') return `${Math.round(val)}/${nums.length * (Number(col.paper.out_of) || 100)}`;
    // Sprint Review correction: the AVERAGE row is "Mean Marks" — 2dp, not
    // rounded to a whole number (exception to the usual rounding rule).
    return Number(val.toFixed(2));
  }
  if (col.type === 'pct') {
    const nums = students.map((s) => s.subjectPct && s.subjectPct[col.subject.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
    const val = aggregate(nums, mode);
    if (val === null) return '—';
    if (mode === 'sum') return `${Math.round(val)}/${nums.length * 100}`; // subjectPct is already 0-100
    return Number(val.toFixed(2));
  }
  const nums = students.map((s) => s.scores[col.subject.id]).filter((v) => v !== null && v !== undefined && !isNaN(v));
  const val = aggregate(nums, mode);
  if (val === null) return '—';
  if (mode === 'sum') return `${Math.round(val)}/${nums.length * examOutOf}`;
  return Number(val.toFixed(2));
}

/** Builds the Mark List export as an array-of-arrays: school details first
 *  (name, then address/contact if any are set) followed by a blank row,
 *  the exam/class/stream title, another blank row, then the same grid
 *  shown on screen — one row per student, one column per subject (score
 *  and grade combined into one cell, since a spreadsheet cell can't show
 *  the two-line badge the on-screen table uses; a Learning Area Papers
 *  subject instead gets one raw column per paper plus a combined "% "
 *  column) plus the summary columns, and a trailing class-average row. */
export function buildBroadsheetAoa({ settings, exam, cls, streamName, subjects, students, class_average, showLevels }) {
  settings = settings || {};
  subjects = subjects || [];
  students = students || [];
  // Sprint Review §8: same "missing key means true" default the on-screen
  // Mark List uses — a caller that already resolved this (views/
  // broadsheet.mjs does) can just pass the boolean straight through.
  if (showLevels === undefined) showLevels = settings.show_achievement_levels === undefined ? true : String(settings.show_achievement_levels) === 'true';

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
  aoa.push(['Adm. No.', 'Name', 'Stream', ...columns.map((c) => c.header), 'SBJ', 'TT MKS', 'MN MKS', 'PL', 'TT PTS', 'MN PTS', 'DEV', 'STREAM POS', 'OVR POS']);

  // Sprint Review correction (final): only an INDIVIDUAL result — one
  // subject's own score for one student — rounds to a whole number
  // (columnCell above). Every aggregate figure (a total, a mean/average, a
  // points sum, a deviation, a class average) keeps 2 decimal places
  // wherever it appears, on screen and in this export alike, instead of
  // losing precision to Math.round(). TT MKS is a plain 2dp number per
  // student (the earned/possible format lives on the TOTAL row instead).
  const examOutOf = Number(exam && exam.out_of) || 100;
  students.forEach((s) => {
    const subjCells = columns.map((c) => columnCell(c, s, showLevels));
    const deviation = Number(s.deviation.toFixed(2));
    aoa.push([
      s.admission_no, s.full_name, s.stream_name || '—', ...subjCells,
      s.subject_count, Number(s.total.toFixed(2)), Number(s.average.toFixed(2)), showLevels ? (s.overall_grade || '—') : '—',
      s.total_points === null || s.total_points === undefined ? '—' : Number(s.total_points.toFixed(2)),
      s.mean_points === null || s.mean_points === undefined ? '—' : Number(s.mean_points.toFixed(2)),
      deviation > 0 ? `+${deviation}` : deviation,
      s.stream_position || '—', s.position || '—'
    ]);
  });

  aoa.push(['', 'TOTAL', '', ...columns.map((c) => columnAggCell(c, students, 'sum', examOutOf))]);
  aoa.push(['', 'AVERAGE', '', ...columns.map((c) => columnAggCell(c, students, 'avg', examOutOf))]);
  aoa.push([]);
  aoa.push(['Class average:', class_average === null || class_average === undefined || isNaN(class_average) ? class_average : Number(class_average.toFixed(2))]);
  return aoa;
}
