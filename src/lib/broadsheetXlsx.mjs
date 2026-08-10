/**
 * broadsheetXlsx.mjs — pure, testable builder for the Mark List's "Download
 * Excel" export (feature request: "make sure the mark list can be
 * downloaded also as excel and should come with school details at the
 * top"). Kept separate from views/broadsheet.mjs (which imports app.js and
 * so can't be unit-tested directly) so the layout logic has real test
 * coverage — same split as xlsxUtil.mjs's own pure-core/browser-wrapper
 * convention.
 */

/** Builds the Mark List export as an array-of-arrays: school details first
 *  (name, then address/contact if any are set) followed by a blank row,
 *  the exam/class/stream title, another blank row, then the same grid
 *  shown on screen — one row per student, one column per subject (score
 *  and grade combined into one cell, since a spreadsheet cell can't show
 *  the two-line badge the on-screen table uses) plus the summary columns,
 *  and a trailing class-average row. */
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

  const subjHeader = subjects.map((s) => s.code || s.name);
  aoa.push(['Adm. No.', 'Name', 'Arm', ...subjHeader, 'SBJ', 'TT MKS', 'MN MKS', 'PL', 'TT PTS', 'MN PTS', 'DEV', 'ARM POS', 'OVR POS']);

  students.forEach((s) => {
    const subjCells = subjects.map((sub) => {
      const score = s.scores[sub.id];
      if (score === null || score === undefined) return '—';
      const gr = s.grades[sub.id];
      return gr && gr.grade_label ? `${score} (${gr.grade_label})` : String(score);
    });
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
