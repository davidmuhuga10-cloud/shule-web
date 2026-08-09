/**
 * examAnalysis.mjs — pure, testable aggregation for the new "Exam Analysis"
 * report (feature brief §7: "a new analysis report under Reports that
 * breaks down exam performance in detail — top students, and similar
 * performance analysis"), modeled on the two reference exports the school
 * uploaded (a Zeraki-style "Top Students" sheet and a "Term Analysis
 * Report"). Deliberately built as a pure transform over
 * Db.results.getBroadsheet()'s already-computed per-student data (scores,
 * grade_label/points per subject, overall total/average/grade, stream/
 * overall position) rather than a new database RPC — every number this
 * report needs is already sitting in that response, just not yet grouped
 * this way.
 *
 * `bands` is the school's default grading scale's bands (from
 * Db.grading.defaultScaleBands()), sorted by min_score descending — same
 * shape grading.mjs's listScales() sorts its bands into. It's only used
 * here for the FULL, STABLE column order (every band always gets a column,
 * even one with zero students in it this time — the reference sample shows
 * "AE1 0 AE2 0" rather than omitting empty bands).
 */

function rankBy(list, scoreFn) {
  const scored = list.map((item) => ({ item, score: scoreFn(item) })).filter((r) => r.score !== null && r.score !== undefined && !isNaN(r.score));
  scored.sort((a, b) => b.score - a.score);
  let lastScore = null, lastRank = 0;
  scored.forEach((r, i) => {
    if (r.score === lastScore) { r.rank = lastRank; }
    else { r.rank = i + 1; lastRank = i + 1; lastScore = r.score; }
  });
  return { ranked: scored, total: scored.length };
}

/** Top 3 (by score, ties share a rank) as {admno, name, stream, strmRank,
 *  ovrlRank, score, level, gender} rows — "ovrlRank" is against the WHOLE
 *  ranked group passed in (already gender-filtered by the caller when
 *  building a "Top Boys"/"Top Girls" table), "strmRank" is against just
 *  that student's own stream within the same group. */
function topN(students, scoreFn, levelFn, n) {
  const { ranked, total } = rankBy(students, scoreFn);
  const byStream = {};
  ranked.forEach((r) => { (byStream[r.item.stream_id] = byStream[r.item.stream_id] || []).push(r); });
  const streamRankOf = {};
  Object.values(byStream).forEach((group) => {
    let lastScore = null, lastRank = 0;
    group.forEach((r, i) => {
      if (r.score === lastScore) { streamRankOf[r.item.student_id] = lastRank; return; }
      lastRank = i + 1; lastScore = r.score; streamRankOf[r.item.student_id] = lastRank;
    });
  });
  return ranked.slice(0, n || 3).map((r) => ({
    admission_no: r.item.admission_no, full_name: r.item.full_name, stream_name: r.item.stream_name,
    stream_rank: streamRankOf[r.item.student_id] || '', stream_total: (byStream[r.item.stream_id] || []).length,
    overall_rank: r.rank, overall_total: total,
    score: Math.round(r.score * 100) / 100, level: levelFn(r.item), gender: r.item.gender || ''
  }));
}

/** Tally of grade_label -> count across `students`, using `bandLabels` for
 *  a stable full column set (0 where nobody fell in that band), plus an "X"
 *  bucket for anyone with no score at all (absent/ungraded). */
function bandCounts(students, gradeLabelFn, bandLabels) {
  const counts = {}; bandLabels.forEach((l) => { counts[l] = 0; });
  let x = 0;
  students.forEach((s) => {
    const label = gradeLabelFn(s);
    if (!label) { x++; return; }
    counts[label] = (counts[label] || 0) + 1;
  });
  return { counts, x };
}

function mean(nums) {
  const vals = nums.filter((v) => v !== null && v !== undefined && !isNaN(v));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 1000) / 1000;
}

function levelForPoints(points, bands) {
  if (points === null || points === undefined) return '';
  // Bands are sorted by min_score desc, not points — but points scale
  // monotonically with min_score in every scale this app grades with, so
  // matching a band by nearest points still lands on the right label.
  let best = null, bestDiff = Infinity;
  bands.forEach((b) => {
    const diff = Math.abs(Number(b.points) - points);
    if (diff < bestDiff) { bestDiff = diff; best = b; }
  });
  return best ? (best.remark || best.grade_label || '') : '';
}

/** One row of the "Class Grade Summary" / per-subject grade-summary tables:
 *  band counts + entries + mean marks + mean points + performance level. */
function gradeSummaryRow(label, students, opts) {
  const { scores, gradeLabelOf, pointsOf, bandLabels, bands } = opts;
  const entered = students.filter((s) => scores(s) !== null && scores(s) !== undefined);
  const { counts, x } = bandCounts(students, gradeLabelOf, bandLabels);
  const meanMarks = mean(entered.map((s) => scores(s)));
  const meanPoints = mean(entered.map((s) => pointsOf(s)).filter((v) => v !== null));
  return {
    label, band_counts: counts, x_count: x, entries: entered.length,
    mean_marks: meanMarks === null ? 0 : meanMarks, mean_points: meanPoints === null ? 0 : meanPoints,
    performance_level: meanPoints === null ? '' : levelForPoints(meanPoints, bands)
  };
}

export function buildExamAnalysis(bs, bands) {
  bands = (bands || []).slice().sort((a, b) => Number(b.min_score) - Number(a.min_score));
  const bandLabels = bands.map((b) => b.grade_label);
  const students = bs.students || [];
  const subjects = bs.subjects || [];
  const counted = students.filter((s) => s.counted > 0);

  const boys = students.filter((s) => String(s.gender || '').toLowerCase() === 'male');
  const girls = students.filter((s) => String(s.gender || '').toLowerCase() === 'female');

  const overallMeanMarks = mean(counted.map((s) => s.average));
  const overallMeanPoints = mean(counted.map((s) => s.mean_points).filter((v) => v !== null));

  const streamNames = [...new Set(students.map((s) => s.stream_name).filter(Boolean))];

  const topStudentsOverall = topN(counted, (s) => s.total, (s) => s.overall_grade, 3);
  const topBoysOverall = topN(boys.filter((s) => s.counted > 0), (s) => s.total, (s) => s.overall_grade, 3);
  const topGirlsOverall = topN(girls.filter((s) => s.counted > 0), (s) => s.total, (s) => s.overall_grade, 3);

  const perSubject = subjects.map((sub) => {
    const withScore = students.filter((s) => s.scores[sub.id] !== null && s.scores[sub.id] !== undefined);
    const top = topN(withScore, (s) => s.scores[sub.id], (s) => (s.grades[sub.id] || {}).grade_label || '', 3);
    const topBoys = topN(withScore.filter((s) => String(s.gender || '').toLowerCase() === 'male'), (s) => s.scores[sub.id], (s) => (s.grades[sub.id] || {}).grade_label || '', 3);
    const topGirls = topN(withScore.filter((s) => String(s.gender || '').toLowerCase() === 'female'), (s) => s.scores[sub.id], (s) => (s.grades[sub.id] || {}).grade_label || '', 3);
    const meanMarks = mean(withScore.map((s) => s.scores[sub.id]));
    const meanPoints = mean(withScore.map((s) => (s.grades[sub.id] || {}).points).filter((v) => v !== null && v !== undefined));
    const summary = gradeSummaryRow(sub.name, students, {
      scores: (s) => s.scores[sub.id], gradeLabelOf: (s) => (s.grades[sub.id] || {}).grade_label || '',
      pointsOf: (s) => (s.grades[sub.id] || {}).points, bandLabels, bands
    });
    return {
      subject_id: sub.id, subject_name: sub.name, subject_code: sub.code || '',
      entries: withScore.length, mean_marks: meanMarks === null ? 0 : meanMarks,
      mean_points: meanPoints === null ? 0 : meanPoints,
      performance_level: meanPoints === null ? '' : levelForPoints(meanPoints, bands),
      top_students: top, top_boys: topBoys, top_girls: topGirls, summary
    };
  });

  const learningAreaStats = perSubject.slice()
    .sort((a, b) => b.mean_points - a.mean_points)
    .map((p) => ({ name: p.subject_name, points: p.mean_points, performance_level: p.performance_level }));

  const classGradeSummary = {
    overall: gradeSummaryRow('Overall', students, {
      scores: (s) => (s.counted > 0 ? s.average : null), gradeLabelOf: (s) => s.overall_grade || '',
      pointsOf: (s) => s.mean_points, bandLabels, bands
    }),
    boys: gradeSummaryRow('Boys', boys, {
      scores: (s) => (s.counted > 0 ? s.average : null), gradeLabelOf: (s) => s.overall_grade || '',
      pointsOf: (s) => s.mean_points, bandLabels, bands
    }),
    girls: gradeSummaryRow('Girls', girls, {
      scores: (s) => (s.counted > 0 ? s.average : null), gradeLabelOf: (s) => s.overall_grade || '',
      pointsOf: (s) => s.mean_points, bandLabels, bands
    }),
    per_subject: perSubject.map((p) => ({ subject_name: p.subject_name, ...p.summary }))
  };

  return {
    band_labels: bandLabels,
    students_sat: students.length,
    students_counted: counted.length,
    mean_marks: overallMeanMarks === null ? 0 : overallMeanMarks,
    mean_points: overallMeanPoints === null ? 0 : overallMeanPoints,
    performance_level: overallMeanPoints === null ? '' : levelForPoints(overallMeanPoints, bands),
    stream_names: streamNames,
    boys_count: boys.length, girls_count: girls.length,
    top_students_overall: topStudentsOverall, top_boys_overall: topBoysOverall, top_girls_overall: topGirlsOverall,
    learning_area_stats: learningAreaStats,
    class_grade_summary: classGradeSummary,
    per_subject: perSubject
  };
}
