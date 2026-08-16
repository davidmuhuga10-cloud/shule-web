import { computeGradeSummaries } from '../src/lib/broadsheetSummary.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  const bands = [
    { grade_label: 'A', min_score: 80, max_score: 100, points: 12, remark: 'Exceeding Expectation' },
    { grade_label: 'B', min_score: 60, max_score: 79, points: 9, remark: 'Meeting Expectation' },
    { grade_label: 'C', min_score: 40, max_score: 59, points: 6, remark: 'Approaching Expectation' }
  ];
  const subjects = [{ id: 'math', name: 'Mathematics' }, { id: 'eng', name: 'English' }];
  const students = [
    { student_id: 's1', gender: 'Male', overall_grade: 'A', scores: { math: 90, eng: 65 }, grades: { math: { grade_label: 'A', points: 12 }, eng: { grade_label: 'B', points: 9 } } },
    { student_id: 's2', gender: 'Female', overall_grade: 'A', scores: { math: 85, eng: 88 }, grades: { math: { grade_label: 'A', points: 12 }, eng: { grade_label: 'A', points: 12 } } },
    { student_id: 's3', gender: 'Female', overall_grade: 'B', scores: { math: 70, eng: 45 }, grades: { math: { grade_label: 'B', points: 9 }, eng: { grade_label: 'C', points: 6 } } },
    { student_id: 's4', gender: 'Male', overall_grade: '', scores: {}, grades: { math: { grade_label: '' }, eng: { grade_label: '' } } } // unranked (e.g. below min subjects)
  ];

  // ---- grade order: best-to-worst by band, not alphabetical ----------------------
  const { gradeOrder, totalRanked, totalStudents, totalGraded, ungraded, classSummary, genderSummary, subjectBreakdown } = computeGradeSummaries(students, subjects, bands);
  check('grade order follows the bands, best first', gradeOrder.join(',') === 'A,B');
  check('an unranked student (empty overall_grade) is excluded from the ranked total', totalRanked === 3);

  // ---- Round 3 §20 regression: the roster total and the ungraded count are now
  // both explicit, so an admin can see WHY a "3 graded" figure doesn't match a
  // "4 students sat the exam" headcount, instead of the ungraded student just
  // silently vanishing from every number (the reported bug: "Class Grade
  // Summary reports 13 when 14 actually sat the exam"). ----
  check('totalStudents reflects the FULL roster passed in, not just graded ones', totalStudents === 4);
  check('totalGraded matches totalRanked', totalGraded === totalRanked && totalGraded === 3);
  check('ungraded accounts for exactly the missing student', ungraded === 1);
  check('totalGraded + ungraded always reconciles to totalStudents', totalGraded + ungraded === totalStudents);

  // ---- Class Grade Summary ---------------------------------------------------------
  const aRow = classSummary.find((r) => r.grade === 'A');
  const bRow = classSummary.find((r) => r.grade === 'B');
  check('Class Grade Summary counts 2 students in grade A', aRow.count === 2);
  check('Class Grade Summary counts 1 student in grade B', bRow.count === 1);
  // Round 6 §1: whole number now (2/3 = 66.7%, rounds to 67), not one
  // decimal place — "no subject should ever report marks as a decimal"
  // extends to every figure the summary tables show.
  check('Class Grade Summary percentage is of ranked students only (2/3, rounded to a whole number)', aRow.pct === 67);

  // ---- Gender Grade Summary ----------------------------------------------------------
  const genderA = genderSummary.find((r) => r.grade === 'A');
  check('Gender Grade Summary splits grade A: 1 male, 1 female', genderA.male === 1 && genderA.female === 1);

  // ---- Grade Breakdown by Subject -----------------------------------------------------
  const mathRow = subjectBreakdown.find((r) => r.subject_id === 'math');
  check('Subject breakdown counts Math grade A twice', mathRow.counts.A === 2);
  check('Subject breakdown counts Math grade B once', mathRow.counts.B === 1);
  const engRow = subjectBreakdown.find((r) => r.subject_id === 'eng');
  check('Subject breakdown counts English grade A once (student 2 only)', engRow.counts.A === 1);

  // ---- Sprint Review EX5 (redesign, approved): Grade Breakdown by Subject
  // now also carries Mean Marks / Mean Points / a spelled-out Performance
  // Level per subject — an aggregate figure, so it's unrounded here (2dp is
  // applied only at display/export time, same convention as every other
  // aggregate in this app). Math: (90+85+70)/3 = 81.666...; points
  // (12+12+9)/3 = 11 -> nearest band is A (points:12) here since B(9) is
  // further away... actually 11 is closer to 12 (diff 1) than to 9 (diff 2).
  check('Math mean marks is the plain average of every student with a score (90+85+70)/3', Math.abs(mathRow.mean_marks - 81.66666666666667) < 1e-9);
  check('Math mean points is the plain average of every student with points (12+12+9)/3', Math.abs(mathRow.mean_points - 11) < 1e-9);
  check('Math performance level resolves to the nearest band by points (11 -> closest to A\'s 12)', mathRow.performance_level === 'Exceeding Expectation');
  const engMeanPoints = (9 + 12 + 6) / 3;
  check('English mean points is the plain average (9+12+6)/3 = 9', Math.abs(engRow.mean_points - engMeanPoints) < 1e-9);
  check('English performance level resolves to band B\'s remark (9 matches B\'s points exactly)', engRow.performance_level === 'Meeting Expectation');

  // ---- a grade label present on a student but missing from bands still counts -------
  const withOverride = computeGradeSummaries(
    [{ student_id: 'x1', gender: 'Male', overall_grade: 'EE', grades: {} }],
    [],
    bands
  );
  check('an out-of-scale grade label (publish-time override scale) is still included, appended after known bands', withOverride.gradeOrder.indexOf('EE') !== -1);

  // ---- no ranked students at all -> nothing to show, not a crash --------------------
  const empty = computeGradeSummaries([], subjects, bands);
  check('empty student list yields no grade order', empty.gradeOrder.length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
