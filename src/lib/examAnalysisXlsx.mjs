/**
 * examAnalysisXlsx.mjs — pure, testable AOA builder for the Exam Analysis
 * report's "Download Excel" export (feature brief §7), built from the same
 * `buildExamAnalysis()` output (see examAnalysis.mjs) the on-screen report
 * renders from.
 */
// Sprint Review correction (final): only an INDIVIDUAL result — one
// subject's own score for one student — rounds to a whole number. Every
// aggregate/computed figure (a mean, a points sum, a class-wide statistic)
// keeps 2 decimal places wherever it appears, on screen and in this export
// alike — same rule applied to views/examAnalysis.mjs. The "Score" column
// here mirrors that view's topTable() (also 2dp, kept identical between
// overall and per-subject tables so the download never disagrees with the
// screen).
function topTableRows(title, rows) {
  const out = [[title], ['Admno', 'Name', 'Arm', 'Arm Rank', 'Ovrl Rank', 'Score', 'Performance Level', 'Gender']];
  rows.forEach((r) => {
    out.push([
      r.admission_no, r.full_name, r.stream_name,
      `${r.stream_rank || ''} / ${r.stream_total || ''}`, `${r.overall_rank || ''} / ${r.overall_total || ''}`,
      Number(r.score.toFixed(2)), r.level, r.gender
    ]);
  });
  out.push([]);
  return out;
}

function gradeSummaryRows(title, rows, bandLabels) {
  const out = [[title], ['Label', ...bandLabels, 'X', 'Entries', 'Mean Marks', 'Mean Points', 'Performance Level']];
  rows.forEach((r) => {
    out.push([r.label || r.subject_name, ...bandLabels.map((l) => r.band_counts[l] || 0), r.x_count, r.entries, Number(r.mean_marks.toFixed(2)), Number(r.mean_points.toFixed(2)), r.performance_level]);
  });
  out.push([]);
  return out;
}

export function buildExamAnalysisAoa({ settings, exam, cls, analysis }) {
  settings = settings || {};
  const contactBits = [];
  if (settings.po_box) contactBits.push('P.O. Box ' + settings.po_box + (settings.postal_code ? '-' + settings.postal_code : ''));
  if (settings.town) contactBits.push(settings.town);
  if (settings.phone) contactBits.push(settings.phone);
  if (settings.email) contactBits.push(settings.email);

  const aoa = [];
  aoa.push([settings.school_name || 'School']);
  if (contactBits.length) aoa.push([contactBits.join('  |  ')]);
  aoa.push([`${exam.name} — Exam Analysis — ${cls ? cls.name : ''}`]);
  aoa.push([]);

  aoa.push(['Students who sat', analysis.students_sat]);
  aoa.push(['Mean Marks', Number(analysis.mean_marks.toFixed(2))]);
  aoa.push(['Mean Points', Number(analysis.mean_points.toFixed(2))]);
  aoa.push(['Performance Level', analysis.performance_level]);
  aoa.push([]);

  aoa.push(['LEARNING AREA STATISTICS']);
  aoa.push(['Name', 'Mean Points', 'Performance Level']);
  analysis.learning_area_stats.forEach((r) => aoa.push([r.name, Number(r.points.toFixed(2)), r.performance_level]));
  aoa.push([]);

  aoa.push(['CLASS GRADE SUMMARY']);
  aoa.push(...gradeSummaryRows('Overall', [analysis.class_grade_summary.overall], analysis.band_labels));
  aoa.push(...gradeSummaryRows('Boys', [analysis.class_grade_summary.boys], analysis.band_labels));
  aoa.push(...gradeSummaryRows('Girls', [analysis.class_grade_summary.girls], analysis.band_labels));
  aoa.push(...gradeSummaryRows('Per Subject', analysis.class_grade_summary.per_subject, analysis.band_labels));

  aoa.push(...topTableRows('Top Students - Overall', analysis.top_students_overall));
  aoa.push(...topTableRows('Top Boys - Overall', analysis.top_boys_overall));
  aoa.push(...topTableRows('Top Girls - Overall', analysis.top_girls_overall));

  analysis.per_subject.forEach((sub) => {
    aoa.push([sub.subject_name.toUpperCase()]);
    aoa.push(...topTableRows(`Top Students - ${sub.subject_name}`, sub.top_students));
    aoa.push(...topTableRows(`Top Boys - ${sub.subject_name}`, sub.top_boys));
    aoa.push(...topTableRows(`Top Girls - ${sub.subject_name}`, sub.top_girls));
  });

  return aoa;
}
