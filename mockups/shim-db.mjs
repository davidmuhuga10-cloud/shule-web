/**
 * shim-db.mjs — screenshot-harness stand-in for src/lib/api/index.mjs's `Db`.
 *
 * Returns realistic, internally-consistent mock data (a Kenyan CBC school,
 * Grade 8 with two streams) shaped EXACTLY like the real API's return
 * values, so the real, unmodified view modules (dashboard.mjs, teachers.mjs,
 * broadsheet.mjs, reportForms.mjs/_reportCard.mjs) render for real — no
 * network, no Supabase project needed. Fixed IDs (EXAM_ID/CLASS_ID/etc.)
 * are shared with mockups/shoot.mjs so it knows which <select> values to
 * pick when driving the real UI.
 */
export const EXAM_ID = 'exam-1';
export const CLASS_ID = 'class-8';
export const REPORT_STUDENT_ID = 'stu-1002';
export const BATCH_VALUE = '__all__';

const SETTINGS = {
  school_name: 'Tumaini Junior School',
  po_box: '245',
  postal_code: '20100',
  town: 'Nakuru',
  phone: '0712 345 678',
  email: 'info@tumaini.ac.ke',
  logo: null
};

const SUBJECTS = [
  { id: 'sub-kis', name: 'Kiswahili', code: 'KIS' },
  { id: 'sub-mat', name: 'Mathematics', code: 'MAT' },
  { id: 'sub-eng', name: 'English', code: 'ENG' },
  // Deliberately no `code` here (screenshot QA for the H1 mark-list print
  // fix — long subject names must wrap vertically within a fixed-width
  // column instead of stretching it) — every other subject has a short
  // code and would mask the bug this is meant to catch.
  { id: 'sub-int', name: 'Integrated Science and Technology', code: '' },
  { id: 'sub-sst', name: 'Social Studies', code: 'SST' },
  { id: 'sub-cre', name: 'CRE', code: 'CRE' },
  { id: 'sub-agr', name: 'Agriculture', code: 'AGR' },
  { id: 'sub-crw', name: 'Creative Arts', code: 'CRW' },
  { id: 'sub-hsc', name: 'Home Science', code: 'HSC' },
  { id: 'sub-cmp', name: 'Comprehension', code: 'CMP' }
];

const TEACHER_BY_SUBJECT = {
  'sub-kis': 'Mr. Peter Njoroge', 'sub-mat': 'Mrs. Alice Wambui', 'sub-eng': 'Ms. Caroline Achieng',
  'sub-int': 'Mr. Brian Otieno', 'sub-sst': 'Mrs. Judy Chebet', 'sub-cre': 'Mr. Samuel Kimani',
  'sub-agr': 'Mrs. Grace Wanjiru', 'sub-crw': 'Ms. Mercy Nyambura', 'sub-hsc': 'Mrs. Faith Wangari', 'sub-cmp': 'Mr. Dennis Kiptoo'
};

const SUBMISSION_STATUS = {
  'sub-kis': 'published', 'sub-mat': 'published', 'sub-eng': 'published', 'sub-int': 'published',
  'sub-sst': 'approved', 'sub-cre': 'published', 'sub-agr': 'submitted', 'sub-crw': 'published',
  'sub-hsc': 'draft', 'sub-cmp': 'published'
};

const STREAMS = [{ id: 'str-amani', name: 'Amani' }, { id: 'str-furaha', name: 'Furaha' }];

// 10 students, two streams — scores per subject (in SUBJECTS order) out of 100.
const STUDENTS = [
  { id: 'stu-1001', admission_no: 'ADM1001', full_name: 'Brian Otieno', gender: 'Male', stream_id: 'str-amani', guardian_name: 'Mrs. Otieno', guardian_contact: '0722100001', scores: [72, 65, 80, 74, 69, 88, 76, 71, 60, 82] },
  { id: 'stu-1002', admission_no: 'ADM1002', full_name: 'Faith Wanjiku', gender: 'Female', stream_id: 'str-amani', guardian_name: 'Mr. Wanjiku', guardian_contact: '0722100002', scores: [91, 87, 94, 89, 92, 96, 85, 90, 88, 93] },
  { id: 'stu-1003', admission_no: 'ADM1003', full_name: 'Kevin Mwangi', gender: 'Male', stream_id: 'str-amani', guardian_name: 'Mrs. Mwangi', guardian_contact: '0722100003', scores: [55, 48, 60, 52, 58, 66, 61, 50, 45, 57] },
  { id: 'stu-1004', admission_no: 'ADM1004', full_name: 'Grace Achieng', gender: 'Female', stream_id: 'str-amani', guardian_name: '', guardian_contact: '', scores: [78, 82, 75, 80, 77, 84, 79, 81, 74, 80] },
  { id: 'stu-1005', admission_no: 'ADM1005', full_name: 'Dennis Kiptoo', gender: 'Male', stream_id: 'str-amani', guardian_name: 'Mr. Kiptoo', guardian_contact: '0722100005', scores: [64, 70, 58, 66, 63, 72, 68, 60, 55, 65] },
  { id: 'stu-1006', admission_no: 'ADM1006', full_name: 'Mercy Nyambura', gender: 'Female', stream_id: 'str-amani', guardian_name: 'Mrs. Nyambura', guardian_contact: '0722100006', scores: [86, 79, 88, 83, 85, 90, 81, 84, 78, 87] },
  { id: 'stu-1007', admission_no: 'ADM1007', full_name: 'Samuel Kimani', gender: 'Male', stream_id: 'str-furaha', guardian_name: 'Mr. Kimani', guardian_contact: '0722100007', scores: [45, 52, 40, 48, 44, 55, 50, 42, 38, 46] },
  { id: 'stu-1008', admission_no: 'ADM1008', full_name: 'Purity Wambui', gender: 'Female', stream_id: 'str-furaha', guardian_name: 'Mrs. Wambui', guardian_contact: '0722100008', scores: [95, 92, 97, 94, 96, 98, 91, 93, 90, 95] },
  { id: 'stu-1009', admission_no: 'ADM1009', full_name: 'John Otieno', gender: 'Male', stream_id: 'str-furaha', guardian_name: 'Mr. Otieno', guardian_contact: '0722100009', scores: [68, 61, 73, 69, 66, 75, 70, 64, 59, 71] },
  { id: 'stu-1010', admission_no: 'ADM1010', full_name: 'Ann Chebet', gender: 'Female', stream_id: 'str-furaha', guardian_name: 'Mrs. Chebet', guardian_contact: '0722100010', scores: [73, 76, 71, 74, 72, 79, 75, 73, 68, 77] }
];

const BANDS = [
  { min_score: 90, max_score: 100, grade_label: 'EE1', points: 12, remark: 'Exceeding Expectation' },
  { min_score: 75, max_score: 89, grade_label: 'EE2', points: 11, remark: 'Exceeding Expectation' },
  { min_score: 58, max_score: 74, grade_label: 'ME1', points: 9, remark: 'Meeting Expectation' },
  { min_score: 41, max_score: 57, grade_label: 'ME2', points: 7, remark: 'Meeting Expectation' },
  { min_score: 31, max_score: 40, grade_label: 'AE1', points: 5, remark: 'Approaching Expectation' },
  { min_score: 21, max_score: 30, grade_label: 'AE2', points: 4, remark: 'Approaching Expectation' },
  { min_score: 11, max_score: 20, grade_label: 'BE1', points: 2, remark: 'Below Expectation' },
  { min_score: 0, max_score: 10, grade_label: 'BE2', points: 1, remark: 'Below Expectation' }
];
function grade(score) {
  const hit = BANDS.find((b) => score >= b.min_score && score <= b.max_score);
  return hit || { grade_label: '', points: null, remark: '' };
}

function rankByTotal(list, field) {
  const ranked = list.slice().sort((a, b) => b.total - a.total);
  let lastTotal = null, lastPos = 0;
  ranked.forEach((r, i) => {
    if (r.total === lastTotal) { r[field] = lastPos; }
    else { r[field] = i + 1; lastPos = i + 1; lastTotal = r.total; }
  });
}

function buildBroadsheetRows(subjectList) {
  subjectList = subjectList || SUBJECTS;
  const rows = STUDENTS.map((s) => {
    const scores = {}, grades = {};
    let total = 0, pointsTotal = 0, counted = 0;
    subjectList.forEach((sub) => {
      const i = SUBJECTS.indexOf(sub);
      const v = s.scores[i];
      scores[sub.id] = v;
      const g = grade(v);
      grades[sub.id] = { grade_label: g.grade_label, points: g.points };
      total += v; pointsTotal += g.points || 0; counted++;
    });
    const average = counted ? Math.round((total / counted) * 100) / 100 : 0;
    return {
      student_id: s.id, admission_no: s.admission_no, full_name: s.full_name, gender: s.gender,
      stream_id: s.stream_id, stream_name: STREAMS.find((st) => st.id === s.stream_id).name,
      scores, grades, total: Math.round(total * 100) / 100, counted, subject_count: counted,
      average, total_points: Math.round(pointsTotal * 100) / 100, mean_points: counted ? Math.round((pointsTotal / counted) * 100) / 100 : null,
      overall_grade: grade(average).grade_label
    };
  });
  rankByTotal(rows, 'position');
  const byStream = {};
  rows.forEach((r) => { (byStream[r.stream_id] = byStream[r.stream_id] || []).push(r); });
  Object.values(byStream).forEach((group) => rankByTotal(group, 'stream_position'));
  const classAverage = Math.round((rows.reduce((a, r) => a + r.average, 0) / rows.length) * 100) / 100;
  rows.forEach((r) => { r.deviation = Math.round((r.average - classAverage) * 100) / 100; });
  rows.sort((a, b) => b.total - a.total);
  return { rows, classAverage };
}

export const Db = {
  grading: {
    async defaultScaleBands() { return BANDS; }
  },
  dashboard: {
    async get() {
      return {
        ok: true, data: null,
        counts: { students: 486, staff: 34, teachers: 28, classes: 9, streams: 15, subjects: 12, exams: 3 },
        smsBalance: 1250,
        gender: { M: 251, F: 235 },
        perClass: [
          { name: 'Grade 8', count: 62 }, { name: 'Grade 7', count: 58 }, { name: 'Grade 6', count: 55 },
          { name: 'Grade 5', count: 51 }, { name: 'Grade 4', count: 49 }, { name: 'Grade 3', count: 47 },
          { name: 'Grade 2', count: 44 }, { name: 'Grade 1', count: 40 }, { name: 'PP2', count: 40 }
        ],
        checklist: [
          { key: 'academic_year', label: 'Create an academic year', done: true, route: '#/settings' },
          { key: 'term', label: 'Add terms to the academic year', done: true, route: '#/settings' },
          { key: 'classes', label: 'Set up classes', done: true, route: '#/classes' },
          { key: 'streams', label: 'Add streams to classes', done: true, route: '#/classes' },
          { key: 'subjects', label: 'Assign subjects to a stream', done: true, route: '#/classes' },
          { key: 'students', label: 'Enroll students', done: true, route: '#/students' },
          { key: 'staff', label: 'Add teachers / staff', done: true, route: '#/staff' }
        ],
        setupComplete: true
      };
    }
  },
  classes: {
    async list() {
      return {
        ok: true, data: [
          { id: 'class-pp2', name: 'PP2', stream_count: 1, student_count: 32, class_teacher_staff_id: 'st-1' },
          { id: 'class-1', name: 'Grade 1', stream_count: 2, student_count: 66, class_teacher_staff_id: 'st-1' },
          { id: 'class-4', name: 'Grade 4', stream_count: 2, student_count: 74, class_teacher_staff_id: 'st-2' },
          { id: 'class-6', name: 'Grade 6', stream_count: 2, student_count: 78, class_teacher_staff_id: 'st-2' },
          { id: 'class-7', name: 'Grade 7', stream_count: 3, student_count: 91, class_teacher_staff_id: 'st-3' },
          { id: CLASS_ID, name: 'Grade 8', stream_count: STREAMS.length, student_count: 84, class_teacher_staff_id: 'st-4' },
          { id: 'class-9', name: 'Grade 9', stream_count: 2, student_count: 58, class_teacher_staff_id: 'st-4' }
        ]
      };
    },
    async save() { return { ok: true }; },
    async remove() { return { ok: true }; }
  },
  streams: {
    async list(classId) {
      return { ok: true, data: classId === CLASS_ID ? STREAMS.map((s) => ({ ...s, student_count: 42 })) : [{ id: 'stream-x', name: 'North', student_count: 39 }] };
    }
  },
  assignments: {
    async getStreamSubjects(streamId) {
      return {
        ok: true,
        data: [
          { subject_id: 'sub-1', name: 'English', code: 'ENG', teacher_staff_id: 'st-2', teacher_name: 'Alice Wambui' },
          { subject_id: 'sub-2', name: 'Kiswahili', code: 'KIS', teacher_staff_id: 'st-3', teacher_name: 'Caroline Achieng' },
          { subject_id: 'sub-3', name: 'Mathematics', code: 'MAT', teacher_staff_id: '', teacher_name: '' },
          { subject_id: 'sub-4', name: 'Integrated Science', code: 'SCI', teacher_staff_id: 'st-4', teacher_name: 'Brian Otieno' }
        ],
        inherited: false
      };
    }
  },
  settings: {
    async get() { return { ok: true, data: SETTINGS }; },
    async save() { return { ok: true }; }
  },
  academicYears: {
    async list() { return { ok: true, data: [{ id: 'ay-2026', name: '2026', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31' }] }; },
    async save() { return { ok: true }; },
    async remove() { return { ok: true }; }
  },
  terms: {
    async list() { return { ok: true, data: [{ id: 'tm-1', academic_year_id: 'ay-2026', academic_year_name: '2026', name: 'Term 2', status: 'active', start_date: '2026-04-27', end_date: '2026-08-23' }] }; },
    async save() { return { ok: true }; },
    async remove() { return { ok: true }; }
  },
  users: {
    async list() {
      return {
        ok: true, data: [
          { id: 'profile-1', name: 'Peter Njoroge', email: 'peter.njoroge@tumaini.ac.ke', username: 'peter.njoroge', phone: '0722 111 222', role: 'admin', status: 'active', staff_id: 'st-1' },
          { id: 'profile-2', name: 'Alice Wambui', email: 'alice.wambui@tumaini.ac.ke', username: 'alice.wambui', phone: '0733 222 333', role: 'teacher', status: 'active', staff_id: 'st-2' },
          { id: 'profile-3', name: 'Caroline Achieng', email: 'caroline.achieng@tumaini.ac.ke', username: 'caroline.achieng', phone: '0700 333 444', role: 'teacher', status: 'active', staff_id: 'st-3' },
          { id: 'profile-4', name: 'Brian Otieno', email: 'brian.otieno@tumaini.ac.ke', username: 'brian.otieno', phone: '0711 444 555', role: 'teacher', status: 'active', staff_id: 'st-4' },
          { id: 'profile-5', name: 'Judy Chebet', email: 'judy.chebet@tumaini.ac.ke', username: 'judy.chebet', phone: '0755 555 666', role: 'teacher', status: 'inactive', staff_id: 'st-5' },
          { id: 'profile-6', name: 'Samuel Kimani', email: 'samuel.kimani@tumaini.ac.ke', username: 'samuel.kimani', phone: '0788 666 777', role: 'admin', status: 'active', staff_id: 'st-6' }
        ]
      };
    },
    async setRole() { return { ok: true }; },
    async resetPassword() { return { ok: true, defaultPassword: 'changeme123' }; },
    async setLoginStatus() { return { ok: true }; }
  },
  staff: {
    async list() {
      return {
        ok: true, data: [
          { id: 'st-1', full_name: 'Peter Njoroge', role: 'teacher', status: 'active', email: 'peter.njoroge@tumaini.ac.ke', phone: '0722 111 222' },
          { id: 'st-2', full_name: 'Alice Wambui', role: 'teacher', status: 'active', email: 'alice.wambui@tumaini.ac.ke', phone: '0733 222 333' },
          { id: 'st-3', full_name: 'Caroline Achieng', role: 'teacher', status: 'active', email: 'caroline.achieng@tumaini.ac.ke', phone: '0700 333 444' },
          { id: 'st-4', full_name: 'Brian Otieno', role: 'teacher', status: 'active', email: 'brian.otieno@tumaini.ac.ke', phone: '0711 444 555' },
          { id: 'st-5', full_name: 'Judy Chebet', role: 'teacher', status: 'inactive', email: 'judy.chebet@tumaini.ac.ke', phone: '0755 555 666' },
          { id: 'st-6', full_name: 'Samuel Kimani', role: 'teacher', status: 'active', email: 'samuel.kimani@tumaini.ac.ke', phone: '0788 666 777' },
          // Non-teacher staff (feature brief §9.1 screenshot QA: these two
          // should still show on the Staff tab; the 6 teachers above should
          // NOT — they only belong on the Teachers tab now).
          { id: 'st-7', full_name: 'Mary Wanjiku', role: 'Bursar', status: 'active', email: 'mary.wanjiku@tumaini.ac.ke', phone: '0799 111 222' },
          { id: 'st-8', full_name: 'James Mutua', role: 'Support Staff', status: 'active', email: 'james.mutua@tumaini.ac.ke', phone: '0799 222 333' }
        ]
      };
    }
  },
  subjects: {
    async list() { return { ok: true, data: SUBJECTS }; }
  },
  students: {
    async list(q) {
      q = q || {};
      const data = STUDENTS
        .filter((s) => !q.class_id || q.class_id === CLASS_ID)
        .filter((s) => !q.stream_id || s.stream_id === q.stream_id)
        .map((s) => ({
          id: s.id, admission_no: s.admission_no, full_name: s.full_name, class_id: CLASS_ID,
          gender: s.gender, stream_id: s.stream_id, stream_name: STREAMS.find((st) => st.id === s.stream_id).name,
          guardian_name: s.guardian_name, guardian_contact: s.guardian_contact
        }));
      return { ok: true, data };
    }
  },
  messaging: {
    async history() { return { ok: true, data: [] }; },
    async send() { return { ok: true, recipients: 1, delivered: true }; }
  },
  results: {
    async listExams() { return { ok: true, data: [{ id: EXAM_ID, name: 'End Term 2 Exam' }, { id: 'exam-0', name: 'Mid Term 2 Exam' }] }; },
    // Exam Desk board rows — Round 2 §7/§8 screenshot QA: a deliberate mix
    // of statuses so the board shows off the renamed/reordered row actions
    // ("✅ Review and Publish" replacing "📝 Enter Marks" for not_started;
    // "📝 Continue marks entry" unchanged for in_progress; full post-publish
    // action set for published) in one screenshot.
    async listExamClasses(examId) {
      if (examId !== EXAM_ID) return { ok: true, data: [] };
      return {
        ok: true, data: [
          { class_id: 'class-6', class_name: 'Grade 6', subjects_with_marks: 0, subjects_total: 8, status: 'not_started', last_published_at: null, last_published_by: null, min_subjects: null },
          { class_id: 'class-7', class_name: 'Grade 7', subjects_with_marks: 4, subjects_total: 9, status: 'in_progress', last_published_at: null, last_published_by: null, min_subjects: 7 },
          { class_id: CLASS_ID, class_name: 'Grade 8', subjects_with_marks: 10, subjects_total: 10, status: 'published', last_published_at: '2026-08-02T10:15:00Z', last_published_by: 'David Kinyua', min_subjects: 7 }
        ]
      };
    },
    async saveExam() { return { ok: true, data: { id: EXAM_ID } }; },
    async softDeleteExam() { return { ok: true }; },
    async getBroadsheet(q) {
      q = q || {};
      // Mirrors the real getBroadsheet()'s feature-brief §5 behavior: only
      // PUBLISHED subjects show on the Mark List by default.
      const visibleSubjects = q.includeUnpublished ? SUBJECTS : SUBJECTS.filter((s) => SUBMISSION_STATUS[s.id] === 'published');
      const { rows, classAverage } = buildBroadsheetRows(visibleSubjects);
      const filtered = q.stream_id ? rows.filter((r) => r.stream_id === q.stream_id) : rows;
      return {
        ok: true,
        exam: { id: EXAM_ID, name: 'End Term 2 Exam', out_of: 100, exam_type: 'end_term' },
        subjects: visibleSubjects.map((s) => ({ id: s.id, name: s.name, code: s.code, submission_status: SUBMISSION_STATUS[s.id] })),
        students: filtered,
        class_average: classAverage
      };
    },
    async listSubmissions() {
      return {
        ok: true,
        data: SUBJECTS.map((s) => ({ subject_id: s.id, subject_name: s.name, subject_code: s.code, status: SUBMISSION_STATUS[s.id], teacher_name: TEACHER_BY_SUBJECT[s.id] }))
      };
    },
    async getReportCard(examId, studentId) {
      const s = STUDENTS.find((x) => x.id === studentId) || STUDENTS[1];
      const subjects = SUBJECTS.map((sub, i) => {
        const score = s.scores[i];
        const g = grade(score);
        return { subject_id: sub.id, subject_name: sub.name, score, grade_label: g.grade_label, points: g.points, remark: g.remark };
      });
      const total = subjects.reduce((a, x) => a + x.score, 0);
      const average = Math.round((total / subjects.length) * 100) / 100;
      const { rows } = buildBroadsheetRows();
      const me = rows.find((r) => r.student_id === s.id);
      return {
        ok: true,
        data: {
          student: { full_name: s.full_name, admission_no: s.admission_no, class_name: 'Grade 8', stream_name: STREAMS.find((st) => st.id === s.stream_id).name, gender: s.gender },
          exam: { name: 'End Term 2 Exam', out_of: 100, exam_type: 'end_term' },
          session_name: '2026 Academic Year', term_name: 'Term 2',
          subjects, total: Math.round(total * 100) / 100, average,
          overall_grade: grade(average).grade_label,
          position: me ? me.position : null, class_size: rows.length
        }
      };
    }
  }
};
