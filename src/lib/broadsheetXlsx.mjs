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
    return v === null || v === undefined ? '—' : String(v);
  }
  if (col.type === 'pct') {
    const pct = student.subjectPct ? student.subjectPct[col.subject.id] : null;
    if (pct === null || pct === undefined) return '—';
    const gr = student.grades[col.subject.id];
    return gr && gr.grade_label ? `${pct} (${gr.grade_label})` : String(pct);
  }
  const score = student.scores[col.subject.id];
  if (score === null || score === undefined) return '—';
  const gr = student.grades[col.subject.id];
  return gr && gr.grade_label ? `${score} (${gr.grade_label})` : String(score);
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

  students.forEach((s) => {
    const subjCells = columns.map((c) => columnCell(c, s));
    aoa.push([
      s.admission_no, s.full_name, s.stream_name || '—', ...subjCells,
      s.subject_count, s.total, s.average, s.overall_grade || '—',
      s.total_points === null || s.total_points === undefined ? '—' : s.total_points,
      s.mean_points === null || s.mean_points === undefined ? '—' : s.mean_points,
      s.deviation > 0 ? `+${s.deviation}` : s.deviation,
      s.stream_position || '—', s.position || '—'
    ]);
  });

  aoa.push([]);
  aoa.push(['Class average:', class_average]);
  return aoa;
}
