/**
 * broadsheetSummary.mjs — System Fixes brief §15: "Add stat tables (Class
 * Grade Summary, Grade Breakdown, Gender Grade Summary) beneath the mark
 * list; remove the current 'Class Average' figure."
 *
 * Pure computation only (no DOM, no HTML) — same convention as
 * marksCsv.mjs/xlsxUtil.mjs — so it's unit-testable without a browser, and
 * broadsheet.mjs just renders whatever shape this returns. Takes the exact
 * `students`/`subjects` arrays Db.results.getBroadsheet() already returns,
 * plus the school's grading-scale bands (same source reportForms.mjs's
 * Grade Descriptors table uses), so nothing new needs to be fetched from
 * the API beyond what the Mark List screen already loads.
 *
 * Three tables, each answering a different question:
 *   - classSummary    — how did the WHOLE CLASS do overall (count + % per
 *                        grade)?
 *   - genderSummary    — same overall distribution, split Male vs Female —
 *                        "Gender Grade Summary" per the brief.
 *   - subjectBreakdown — how did each SUBJECT do (count per grade), so a
 *                        teacher can see which learning areas are pulling
 *                        grades up or down — "Grade Breakdown" per the
 *                        brief.
 *
 * Grade order comes from the scale's bands (best-to-worst by min_score) —
 * NOT alphabetical, since e.g. "A-" would otherwise sort before "A". A grade
 * label that shows up on a student but isn't in `bands` (e.g. this exam used
 * a publish-time override scale different from the school default passed
 * in here) is still counted, just appended after the known bands rather
 * than silently dropped.
 *
 * Round 3 §20 fix: `students` is the class's FULL active roster (getBroadsheet()
 * includes every active student whether or not they have any marks yet), but
 * a student with literally zero subject scores recorded gets `overall_grade:
 * ''` (falsy) from getBroadsheet() — NOT the same as the 'X' a below-minimum
 * (but >0-subject) student gets. That '' student used to just silently
 * vanish from every count here (the reported bug: "Class Grade Summary
 * reports 13 when 14 actually sat the exam" — the 14th had no marks in yet).
 * Rather than guess whether such a student should count as having "sat" the
 * exam, both numbers are now returned explicitly — `totalStudents` (the
 * full roster) and `totalGraded` (how many of them have a computed grade,
 * `totalRanked` kept as an alias for backward compatibility) — so the
 * discrepancy is visible and auditable instead of silently wrong. The
 * per-grade percentages are still of the GRADED population (totalGraded),
 * which is the correct denominator for a grade distribution — an ungraded
 * student can't be "89% A, 11% ungraded" against a grade scale that has no
 * "ungraded" band.
 */
export function computeGradeSummaries(students, subjects, bands) {
  students = students || []; subjects = subjects || []; bands = bands || [];

  const rankedLabels = bands.slice()
    .sort((a, b) => Number(b.min_score) - Number(a.min_score))
    .map((b) => b.grade_label)
    .filter(Boolean);
  const observedLabels = [...new Set(students.map((s) => s.overall_grade).filter(Boolean))];
  const extraLabels = observedLabels.filter((g) => rankedLabels.indexOf(g) === -1);
  const gradeOrder = [...rankedLabels.filter((g) => observedLabels.indexOf(g) !== -1), ...extraLabels];

  const ranked = students.filter((s) => s.overall_grade);
  const totalRanked = ranked.length;
  const totalStudents = students.length;
  const totalGraded = totalRanked;
  const ungraded = totalStudents - totalGraded;

  const classSummary = gradeOrder.map((grade) => {
    const count = ranked.filter((s) => s.overall_grade === grade).length;
    // Round 6 §1: whole number, not one decimal place — "no subject should
    // ever report marks as a decimal" extends to every figure the Mark
    // List's summary tables show, this percentage included.
    return { grade, count, pct: totalRanked ? Math.round((count / totalRanked) * 100) : 0 };
  });

  const genderSummary = gradeOrder.map((grade) => {
    const inGrade = ranked.filter((s) => s.overall_grade === grade);
    const male = inGrade.filter((s) => String(s.gender || '').trim().toLowerCase().startsWith('m')).length;
    const female = inGrade.filter((s) => String(s.gender || '').trim().toLowerCase().startsWith('f')).length;
    return { grade, male, female, other: inGrade.length - male - female, total: inGrade.length };
  });

  // Sprint Review EX5 (redesign, approved): Grade Breakdown by Subject now
  // also carries each subject's Mean Marks, Mean Points, and a spelled-out
  // Performance Level (e.g. "Meeting Expectation") — same figures the Exam
  // Analysis report shows per subject (examAnalysis.mjs's perSubject),
  // computed the same way here so the two screens never disagree.
  const subjectBreakdown = subjects.map((sub) => {
    const counts = {};
    gradeOrder.forEach((grade) => { counts[grade] = 0; });
    const scores = [];
    const pointsList = [];
    students.forEach((s) => {
      const g = s.grades && s.grades[sub.id] ? s.grades[sub.id].grade_label : '';
      if (g && counts[g] !== undefined) counts[g]++;
      const sc = s.scores ? s.scores[sub.id] : undefined;
      if (sc !== null && sc !== undefined && !isNaN(sc)) scores.push(sc);
      const pts = s.grades && s.grades[sub.id] ? s.grades[sub.id].points : null;
      if (pts !== null && pts !== undefined && !isNaN(pts)) pointsList.push(pts);
    });
    const meanMarks = mean(scores);
    const meanPoints = mean(pointsList);
    return {
      subject_id: sub.id, subject_name: sub.name, counts,
      mean_marks: meanMarks, mean_points: meanPoints,
      performance_level: meanPoints === null ? '' : levelForPoints(meanPoints, bands)
    };
  });

  return { gradeOrder, totalRanked, totalStudents, totalGraded, ungraded, classSummary, genderSummary, subjectBreakdown };
}

/** Plain arithmetic mean, ignoring null/undefined/NaN — kept unrounded so
 *  the caller decides display precision (Sprint Review correction: an
 *  aggregate like Mean Marks/Mean Points keeps 2dp at render time, never
 *  rounded away here in the data layer). */
function mean(nums) {
  const vals = nums.filter((v) => v !== null && v !== undefined && !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, v) => a + v, 0) / vals.length;
}

/** Matches a Mean Points figure to its nearest grading-scale band by points
 *  (bands are sorted by min_score, not points, but points scales
 *  monotonically with min_score in every scale this app grades with) and
 *  returns that band's spelled-out remark (e.g. "Meeting Expectation"),
 *  falling back to the grade_label if no remark is configured — same
 *  convention examAnalysis.mjs's levelForPoints() uses. */
function levelForPoints(points, bands) {
  if (points === null || points === undefined) return '';
  let best = null, bestDiff = Infinity;
  bands.forEach((b) => {
    const diff = Math.abs(Number(b.points) - points);
    if (diff < bestDiff) { bestDiff = diff; best = b; }
  });
  return best ? (best.remark || best.grade_label || '') : '';
}
