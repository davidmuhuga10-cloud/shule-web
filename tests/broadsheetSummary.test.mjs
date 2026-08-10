import { computeGradeSummaries } from '../src/lib/broadsheetSummary.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  const bands = [
    { grade_label: 'A', min_score: 80, max_score: 100 },
    { grade_label: 'B', min_score: 60, max_score: 79 },
    { grade_label: 'C', min_score: 40, max_score: 59 }
  ];
  const subjects = [{ id: 'math', name: 'Mathematics' }, { id: 'eng', name: 'English' }];
  const students = [
    { student_id: 's1', gender: 'Male', overall_grade: 'A', grades: { math: { grade_label: 'A' }, eng: { grade_label: 'B' } } },
    { student_id: 's2', gender: 'Female', overall_grade: 'A', grades: { math: { grade_label: 'A' }, eng: { grade_label: 'A' } } },
    { student_id: 's3', gender: 'Female', overall_grade: 'B', grades: { math: { grade_label: 'B' }, eng: { grade_label: 'C' } } },
    { student_id: 's4', gender: 'Male', overall_grade: '', grades: { math: { grade_label: '' }, eng: { grade_label: '' } } } // unranked (e.g. below min subjects)
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
  check('Class Grade Summary percentage is of ranked students only (2/3)', Math.abs(aRow.pct - 66.7) < 0.1);

  // ---- Gender Grade Summary ----------------------------------------------------------
  const genderA = genderSummary.find((r) => r.grade === 'A');
  check('Gender Grade Summary splits grade A: 1 male, 1 female', genderA.male === 1 && genderA.female === 1);

  // ---- Grade Breakdown by Subject -----------------------------------------------------
  const mathRow = subjectBreakdown.find((r) => r.subject_id === 'math');
  check('Subject breakdown counts Math grade A twice', mathRow.counts.A === 2);
  check('Subject breakdown counts Math grade B once', mathRow.counts.B === 1);
  const engRow = subjectBreakdown.find((r) => r.subject_id === 'eng');
  check('Subject breakdown counts English grade A once (student 2 only)', engRow.counts.A === 1);

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
