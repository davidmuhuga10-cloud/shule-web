import { buildExamAnalysis } from '../src/lib/examAnalysis.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

const BANDS = [
  { min_score: 85, max_score: 100, grade_label: 'EE1', points: 8, remark: 'Exceeding Expectations' },
  { min_score: 73, max_score: 84, grade_label: 'EE2', points: 7, remark: 'Exceeding Expectations' },
  { min_score: 61, max_score: 72, grade_label: 'ME1', points: 6, remark: 'Meeting Expectations' },
  { min_score: 50, max_score: 60, grade_label: 'ME2', points: 5, remark: 'Meeting Expectations' },
  { min_score: 37, max_score: 49, grade_label: 'AE1', points: 4, remark: 'Approaching Expectations' },
  { min_score: 25, max_score: 36, grade_label: 'AE2', points: 3, remark: 'Approaching Expectations' },
  { min_score: 13, max_score: 24, grade_label: 'BE1', points: 2, remark: 'Below Expectation' },
  { min_score: 0, max_score: 12, grade_label: 'BE2', points: 1, remark: 'Below Expectation' }
];

const SUBJECTS = [{ id: 's1', name: 'Mathematics', code: 'MAT' }, { id: 's2', name: 'English', code: 'ENG' }];

// 4 students in one stream: 2 boys, 2 girls, one subject (English) partly ungraded.
const STUDENTS = [
  { student_id: '1', admission_no: '184', full_name: 'Abigail Chebet', gender: 'Female', stream_id: 'e', stream_name: 'E',
    scores: { s1: 98, s2: 90 }, grades: { s1: { grade_label: 'EE1', points: 8 }, s2: { grade_label: 'EE1', points: 8 } },
    total: 188, counted: 2, average: 94, overall_grade: 'EE1', total_points: 16, mean_points: 8, stream_position: 1, position: 1 },
  { student_id: '2', admission_no: '185', full_name: 'Benson Otieno', gender: 'Male', stream_id: 'e', stream_name: 'E',
    scores: { s1: 76, s2: 70 }, grades: { s1: { grade_label: 'EE2', points: 7 }, s2: { grade_label: 'ME1', points: 6 } },
    total: 146, counted: 2, average: 73, overall_grade: 'EE2', total_points: 13, mean_points: 6.5, stream_position: 2, position: 2 },
  { student_id: '3', admission_no: '186', full_name: 'Clara Nyanchama', gender: 'Female', stream_id: 'e', stream_name: 'E',
    scores: { s1: 55, s2: null }, grades: { s1: { grade_label: 'ME2', points: 5 }, s2: { grade_label: '', points: null } },
    total: 55, counted: 1, average: 55, overall_grade: 'ME2', total_points: 5, mean_points: 5, stream_position: 3, position: 3 },
  { student_id: '4', admission_no: '187', full_name: 'Derrick Kipkoech', gender: 'Male', stream_id: 'e', stream_name: 'E',
    scores: { s1: 10, s2: 20 }, grades: { s1: { grade_label: 'BE2', points: 1 }, s2: { grade_label: 'BE1', points: 2 } },
    total: 30, counted: 2, average: 15, overall_grade: 'BE1', total_points: 3, mean_points: 1.5, stream_position: 4, position: 4 }
];

function run() {
  const bs = { exam: { name: 'End Term 1' }, subjects: SUBJECTS, students: STUDENTS, class_average: 60 };
  const out = buildExamAnalysis(bs, BANDS);

  check('band_labels preserves the scale\'s min_score-descending order', out.band_labels.join(',') === 'EE1,EE2,ME1,ME2,AE1,AE2,BE1,BE2');
  check('students_sat counts every student in the class', out.students_sat === 4);
  check('mean_marks is the mean of each counted student\'s own average', out.mean_marks === (94 + 73 + 55 + 15) / 4);
  check('boys_count and girls_count are correct', out.boys_count === 2 && out.girls_count === 2);

  check('top_students_overall is ranked by total, best first', out.top_students_overall[0].admission_no === '184' && out.top_students_overall[1].admission_no === '185');
  check('top_students_overall reports the class-wide N as the denominator', out.top_students_overall[0].overall_total === 4);
  check('top_boys_overall only contains boys, ranked among themselves', out.top_boys_overall.every((r) => r.gender === 'Male') && out.top_boys_overall[0].admission_no === '185');
  check('top_boys_overall\'s overall_total is scoped to boys only, not the whole class', out.top_boys_overall[0].overall_total === 2);
  check('top_girls_overall only contains girls, best first', out.top_girls_overall[0].admission_no === '184' && out.top_girls_overall[1].admission_no === '186');

  const eng = out.per_subject.find((p) => p.subject_name === 'English');
  check('a subject with one ungraded student excludes them from that subject\'s entries', eng.entries === 3);
  check('a subject\'s top_students ranks by THAT subject\'s score, not the overall total', eng.top_students[0].admission_no === '184' && eng.top_students[0].score === 90);
  check('a student with no score in a subject never appears in that subject\'s top lists', !eng.top_students.some((r) => r.admission_no === '186'));

  check('learning_area_stats is sorted by mean points descending', out.learning_area_stats[0].points >= out.learning_area_stats[1].points);

  const overall = out.class_grade_summary.overall;
  check('class_grade_summary.overall tallies every band label, even ones with zero students', Object.keys(overall.band_counts).length === 8);
  check('class_grade_summary.overall counts the one EE1 student correctly', overall.band_counts.EE1 === 1);
  check('class_grade_summary.overall.entries counts every student with an overall average', overall.entries === 4);

  const mathSummary = out.class_grade_summary.per_subject.find((r) => r.subject_name === 'Mathematics');
  check('per-subject grade summary counts a BE2 correctly', mathSummary.band_counts.BE2 === 1);
  check('per-subject grade summary reports 0 for a band nobody fell into', mathSummary.band_counts.AE1 === 0);

  // ---- edge case: nobody has sat any subject yet ----
  const empty = buildExamAnalysis({ exam: { name: 'Empty' }, subjects: SUBJECTS, students: [], class_average: 0 }, BANDS);
  check('an exam with no students yet does not crash and reports zero throughout', empty.students_sat === 0 && empty.mean_marks === 0 && empty.top_students_overall.length === 0);

  // ---- edge case: no default grading scale configured (empty bands) ----
  const noBands = buildExamAnalysis(bs, []);
  check('with no grading scale configured, band_labels is empty but the report still builds', Array.isArray(noBands.band_labels) && noBands.band_labels.length === 0);
  check('performance_level gracefully falls back to blank with no bands to grade against', noBands.performance_level === '');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
