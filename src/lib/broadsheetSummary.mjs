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
    return { grade, count, pct: totalRanked ? Math.round((count / totalRanked) * 1000) / 10 : 0 };
  });

  const genderSummary = gradeOrder.map((grade) => {
    const inGrade = ranked.filter((s) => s.overall_grade === grade);
    const male = inGrade.filter((s) => String(s.gender || '').trim().toLowerCase().startsWith('m')).length;
    const female = inGrade.filter((s) => String(s.gender || '').trim().toLowerCase().startsWith('f')).length;
    return { grade, male, female, other: inGrade.length - male - female, total: inGrade.length };
  });

  const subjectBreakdown = subjects.map((sub) => {
    const counts = {};
    gradeOrder.forEach((grade) => { counts[grade] = 0; });
    students.forEach((s) => {
      const g = s.grades && s.grades[sub.id] ? s.grades[sub.id].grade_label : '';
      if (g && counts[g] !== undefined) counts[g]++;
    });
    return { subject_id: sub.id, subject_name: sub.name, counts };
  });

  return { gradeOrder, totalRanked, totalStudents, totalGraded, ungraded, classSummary, genderSummary, subjectBreakdown };
}
