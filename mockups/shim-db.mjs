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

/* ============================================================================
 * Finance module fixtures (mockups-only) — a small, internally-consistent
 * fake dataset covering every Finance sub-screen: a handful of classes'
 * worth of students, suppliers/vote-heads/routes/inventory/payroll, and a
 * few collections/expenses/invoices so every screen has real content to
 * render (not just empty states). Mutating calls (save/record/issue/
 * reverse/etc.) just return {ok:true} with a plausible response shape —
 * same "no real persistence" level of fidelity the rest of this shim
 * already uses (see classes.save()/terms.save() above) — since the
 * screenshot harness re-navigates fresh each shot anyway.
 * ============================================================================ */
const AY_ID = 'ay-2026', TERM_ID = 'tm-1';
const FEE_BY_CLASS = { 'class-6': 15000, 'class-7': 16000, 'class-8': 18000, 'class-9': 19000 };
const CLASS_NAME_BY_ID = { 'class-6': 'Grade 6', 'class-7': 'Grade 7', 'class-8': 'Grade 8', 'class-9': 'Grade 9' };

// Extra students in OTHER classes (Grade 8's 10 already exist above as
// STUDENTS) so Finance's class/stream-scoped screens (debit/credit notes,
// class messaging, transport routes, reports) have more than one class to
// pick from.
const FIN_EXTRA_STUDENTS = [
  { id: 'stu-2001', admission_no: 'ADM2001', full_name: 'Susan Achieng', gender: 'Female', class_id: 'class-6', class_name: 'Grade 6', stream_id: 'str-east', stream_name: 'East', guardian_name: 'Mrs. Achieng', guardian_contact: '0722200001' },
  { id: 'stu-2002', admission_no: 'ADM2002', full_name: 'Victor Mutuku', gender: 'Male', class_id: 'class-6', class_name: 'Grade 6', stream_id: 'str-east', stream_name: 'East', guardian_name: 'Mr. Mutuku', guardian_contact: '0722200002' },
  { id: 'stu-2003', admission_no: 'ADM2003', full_name: 'Irene Nafula', gender: 'Female', class_id: 'class-6', class_name: 'Grade 6', stream_id: 'str-east', stream_name: 'East', guardian_name: '', guardian_contact: '' },
  { id: 'stu-2004', admission_no: 'ADM2004', full_name: 'Collins Odhiambo', gender: 'Male', class_id: 'class-7', class_name: 'Grade 7', stream_id: 'str-north', stream_name: 'North', guardian_name: 'Mrs. Odhiambo', guardian_contact: '0722200004' },
  { id: 'stu-2005', admission_no: 'ADM2005', full_name: 'Beatrice Njeri', gender: 'Female', class_id: 'class-7', class_name: 'Grade 7', stream_id: 'str-north', stream_name: 'North', guardian_name: 'Mr. Njeri', guardian_contact: '0722200005' },
  { id: 'stu-2006', admission_no: 'ADM2006', full_name: 'Erick Kiplangat', gender: 'Male', class_id: 'class-7', class_name: 'Grade 7', stream_id: 'str-north', stream_name: 'North', guardian_name: 'Mrs. Kiplangat', guardian_contact: '0722200006' },
  { id: 'stu-2007', admission_no: 'ADM2007', full_name: 'Diana Wanjala', gender: 'Female', class_id: 'class-9', class_name: 'Grade 9', stream_id: 'str-west', stream_name: 'West', guardian_name: 'Mr. Wanjala', guardian_contact: '0722200007' },
  { id: 'stu-2008', admission_no: 'ADM2008', full_name: 'Felix Barasa', gender: 'Male', class_id: 'class-9', class_name: 'Grade 9', stream_id: 'str-west', stream_name: 'West', guardian_name: 'Mrs. Barasa', guardian_contact: '0722200008' },
  { id: 'stu-2009', admission_no: 'ADM2009', full_name: 'Winnie Cherotich', gender: 'Female', class_id: 'class-9', class_name: 'Grade 9', stream_id: 'str-west', stream_name: 'West', guardian_name: 'Mr. Cherotich', guardian_contact: '0722200009' },
  { id: 'stu-2010', admission_no: 'ADM2010', full_name: 'Patrick Simiyu', gender: 'Male', class_id: 'class-9', class_name: 'Grade 9', stream_id: 'str-west', stream_name: 'West', guardian_name: '', guardian_contact: '' }
];

function finStudentView(s) {
  return {
    id: s.id, admission_no: s.admission_no, full_name: s.full_name, gender: s.gender,
    class_id: s.class_id, classes: { id: s.class_id, name: s.class_name },
    stream_id: s.stream_id, streams: s.stream_id ? { name: s.stream_name } : null,
    guardian_name: s.guardian_name, guardian_contact: s.guardian_contact
  };
}
const ALL_FIN_STUDENTS = STUDENTS.map((s) => ({ ...s, class_id: CLASS_ID, class_name: 'Grade 8' }))
  .concat(FIN_EXTRA_STUDENTS).map(finStudentView);

const VOTE_HEADS = [
  { id: 'vh-tuition', name: 'Tuition', code: 'TUI', priority: 10, active: true },
  { id: 'vh-lunch', name: 'Lunch', code: 'LUN', priority: 20, active: true },
  { id: 'vh-activity', name: 'Activity Fee', code: 'ACT', priority: 30, active: true },
  { id: 'vh-exam', name: 'Exam Fee', code: 'EXM', priority: 40, active: false },
  { id: 'vh-transport', name: 'Transport', code: 'TRP', priority: 50, active: true, is_transport: true },
  { id: 'vh-balbf', name: 'Balance B/F', code: 'BBF', priority: 5, active: true }
];
function voteHeadName(id) { return (VOTE_HEADS.find((v) => v.id === id) || {}).name || ''; }

// Each Grade's fee split into three line items that sum to FEE_BY_CLASS.
function feeItemsForClass(classId) {
  const total = FEE_BY_CLASS[classId] || 0;
  return [
    { vote_head_id: 'vh-tuition', amount: total - 4000 },
    { vote_head_id: 'vh-lunch', amount: 3000 },
    { vote_head_id: 'vh-activity', amount: 1000 }
  ];
}
function studentInvoiceItems(studentId) {
  const s = ALL_FIN_STUDENTS.find((x) => x.id === studentId);
  if (!s) return [];
  return feeItemsForClass(s.class_id).map((it, i) => ({
    ...it, description: '', academic_year_id: AY_ID, term_id: TERM_ID,
    created_at: '2026-04-28', finance_vote_heads: { name: voteHeadName(it.vote_head_id) }
  }));
}
function studentExpected(studentId) {
  const s = ALL_FIN_STUDENTS.find((x) => x.id === studentId);
  return s ? (FEE_BY_CLASS[s.class_id] || 0) : 0;
}

// A receipt per student — full payment for some, partial for others, a
// handful left owing entirely so Balances/Dashboard show real red numbers.
// mode covers every value modeLabel() knows about, including the two newer
// ones (Payment in Kind / Bursary) so their receipt/statement rendering
// gets exercised too.
const COLLECTIONS = [
  { id: 'col-1', student_id: 'stu-1001', receipt_no: 'RCT-000101', amount: 14000, mode: 'cash', status: 'active', created_at: '2026-05-03', term_id: TERM_ID, academic_year_id: AY_ID, reference: '' },
  { id: 'col-2', student_id: 'stu-1002', receipt_no: 'RCT-000102', amount: 18000, mode: 'paybill', status: 'active', created_at: '2026-05-04', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'QGH7T2K9X1' },
  { id: 'col-3', student_id: 'stu-1003', receipt_no: 'RCT-000103', amount: 6000, mode: 'cash', status: 'active', created_at: '2026-05-06', term_id: TERM_ID, academic_year_id: AY_ID, reference: '' },
  { id: 'col-4', student_id: 'stu-1004', receipt_no: 'RCT-000104', amount: 18000, mode: 'bank', status: 'active', created_at: '2026-05-07', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'DEP-88213' },
  { id: 'col-5', student_id: 'stu-1006', receipt_no: 'RCT-000105', amount: 9000, mode: 'paybill', status: 'active', created_at: '2026-05-09', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'QGH9K1L2M3' },
  { id: 'col-6', student_id: 'stu-1007', receipt_no: 'RCT-000106', amount: 5000, mode: 'kind', status: 'active', created_at: '2026-05-10', term_id: TERM_ID, academic_year_id: AY_ID, reference: '', in_kind_description: '2 bags of maize flour and 1 bag of rice, estimated at this amount' },
  { id: 'col-7', student_id: 'stu-1008', receipt_no: 'RCT-000107', amount: 18000, mode: 'bursary', status: 'active', created_at: '2026-05-11', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'CDF Nakuru Town East' },
  { id: 'col-8', student_id: 'stu-1009', receipt_no: 'RCT-000108', amount: 10000, mode: 'cash', status: 'active', created_at: '2026-05-13', term_id: TERM_ID, academic_year_id: AY_ID, reference: '' },
  { id: 'col-9', student_id: 'stu-1010', receipt_no: 'RCT-000109', amount: 18000, mode: 'bank', status: 'active', created_at: '2026-05-14', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'DEP-88250' },
  { id: 'col-10', student_id: 'stu-2001', receipt_no: 'RCT-000110', amount: 15000, mode: 'cash', status: 'active', created_at: '2026-05-15', term_id: TERM_ID, academic_year_id: AY_ID, reference: '' },
  { id: 'col-11', student_id: 'stu-2002', receipt_no: 'RCT-000111', amount: 7500, mode: 'paybill', status: 'active', created_at: '2026-05-16', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'QGH2A3B4C5' },
  { id: 'col-12', student_id: 'stu-2004', receipt_no: 'RCT-000112', amount: 16000, mode: 'bank', status: 'active', created_at: '2026-05-18', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'DEP-88310' },
  { id: 'col-13', student_id: 'stu-2005', receipt_no: 'RCT-000113', amount: 8000, mode: 'cash', status: 'active', created_at: '2026-05-19', term_id: TERM_ID, academic_year_id: AY_ID, reference: '' },
  { id: 'col-14', student_id: 'stu-2007', receipt_no: 'RCT-000114', amount: 19000, mode: 'paybill', status: 'active', created_at: '2026-05-20', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'QGH5D6E7F8' },
  { id: 'col-15', student_id: 'stu-2008', receipt_no: 'RCT-000115', amount: 9500, mode: 'cash', status: 'active', created_at: '2026-05-21', term_id: TERM_ID, academic_year_id: AY_ID, reference: '' },
  { id: 'col-16', student_id: 'stu-1002', receipt_no: 'RCT-000090', amount: 12000, mode: 'other', status: 'reversed', created_at: '2026-04-30', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'entered against wrong student' },
  { id: 'col-17', student_id: 'stu-2009', receipt_no: 'RCT-000116', amount: 19000, mode: 'bank', status: 'active', created_at: '2026-05-22', term_id: TERM_ID, academic_year_id: AY_ID, reference: 'DEP-88401' },
  { id: 'col-18', student_id: 'stu-2010', receipt_no: 'RCT-000117', amount: 4000, mode: 'cash', status: 'active', created_at: '2026-05-25', term_id: TERM_ID, academic_year_id: AY_ID, reference: '' }
];
function collectionView(c) {
  const s = ALL_FIN_STUDENTS.find((x) => x.id === c.student_id);
  return { ...c, students: s ? { id: s.id, full_name: s.full_name, admission_no: s.admission_no, classes: s.classes } : null };
}
function studentPaid(studentId) {
  return COLLECTIONS.filter((c) => c.student_id === studentId && c.status === 'active').reduce((a, c) => a + c.amount, 0);
}
const TOTAL_COLLECTED = COLLECTIONS.filter((c) => c.status === 'active').reduce((a, c) => a + c.amount, 0);
const TOTAL_EXPECTED = ALL_FIN_STUDENTS.reduce((a, s) => a + studentExpected(s.id), 0);

// A couple of debit/credit notes so financeStudent.mjs's notes table and
// the Invoicing tab's Debit/Credit Notes sub-tabs both have something real.
const DEBIT_NOTES = [
  { id: 'dn-1', student_id: 'stu-1003', vote_head_id: 'vh-activity', amount: 500, reason: 'Lost textbook — Mathematics', created_at: '2026-05-02', academic_year_id: AY_ID, term_id: TERM_ID, finance_vote_heads: { name: 'Activity Fee' } }
];
const CREDIT_NOTES = [
  { id: 'cn-1', student_id: 'stu-1004', vote_head_id: 'vh-tuition', amount: 2000, reason: 'Sibling discount', created_at: '2026-05-05', academic_year_id: AY_ID, term_id: TERM_ID, finance_vote_heads: { name: 'Tuition' } }
];
function studentBalance(studentId) {
  const dn = DEBIT_NOTES.filter((n) => n.student_id === studentId).reduce((a, n) => a + n.amount, 0);
  const cn = CREDIT_NOTES.filter((n) => n.student_id === studentId).reduce((a, n) => a + n.amount, 0);
  return studentExpected(studentId) + dn - cn - studentPaid(studentId);
}

const ROUTES = [
  { id: 'rt-a', name: 'Route A — Town', pickup_point: 'Town Centre Stage', one_way_amount: 2500, two_way_amount: 4500, active: true },
  { id: 'rt-b', name: 'Route B — Free Area', pickup_point: 'Free Area Market', one_way_amount: 2000, two_way_amount: 3800, active: true },
  { id: 'rt-c', name: 'Route C — Milimani', pickup_point: 'Milimani Estate Gate', one_way_amount: 3000, two_way_amount: 5200, active: false }
];
// A handful of students assigned to routes, some already invoiced this term.
const ROUTE_ASSIGNMENTS = [
  { student_id: 'stu-1001', route_id: 'rt-a', direction: 'two_way' },
  { student_id: 'stu-1004', route_id: 'rt-a', direction: 'two_way' },
  { student_id: 'stu-1006', route_id: 'rt-a', direction: 'one_way' },
  { student_id: 'stu-2001', route_id: 'rt-b', direction: 'two_way' },
  { student_id: 'stu-2004', route_id: 'rt-b', direction: 'two_way' },
  { student_id: 'stu-2007', route_id: 'rt-a', direction: 'two_way' },
  { student_id: 'stu-2009', route_id: 'rt-b', direction: 'one_way' }
];
const ROUTE_INVOICED_IDS = new Set(['stu-1001', 'stu-1004', 'stu-2001']);

const SUPPLIERS = [
  { id: 'sup-1', name: 'Rift Valley Stationers', contact_person: 'James Kariuki', phone: '0733 100 200', email: 'sales@rvstationers.co.ke', category: 'Stationery', address: 'Kenyatta Ave, Nakuru', active: true },
  { id: 'sup-2', name: 'Fresh Harvest Foodstuffs Ltd', contact_person: 'Mary Chepkoech', phone: '0722 300 400', email: 'orders@freshharvest.co.ke', category: 'Foodstuffs', address: 'Industrial Area, Nakuru', active: true },
  { id: 'sup-3', name: 'Nakuru General Hardware', contact_person: 'Peter Omondi', phone: '0700 500 600', email: '', category: 'Hardware', address: 'Mburu Gichua Rd, Nakuru', active: false }
];
const ACCOUNT_TYPES = [
  { id: 'at-1', name: 'School Fund', active: true, is_default: true },
  { id: 'at-2', name: 'Activity Fund', active: true, is_default: false },
  { id: 'at-3', name: 'Building Fund', active: false, is_default: false }
];
const ACCOUNTS = [
  { id: 'acc-1', name: 'Equity Bank — Main Account', account_type_id: 'at-1', is_cash: false, bank_name: 'Equity Bank', account_number: '0170298471234', branch: 'Nakuru Branch', active: true, finance_account_types: { name: 'School Fund' } },
  { id: 'acc-2', name: 'Petty Cash', account_type_id: 'at-1', is_cash: true, bank_name: null, account_number: null, branch: null, active: true, finance_account_types: { name: 'School Fund' } },
  { id: 'acc-3', name: 'KCB — Activity Account', account_type_id: 'at-2', is_cash: false, bank_name: 'KCB Bank', account_number: '1122334455', branch: 'Nakuru West', active: true, finance_account_types: { name: 'Activity Fund' } }
];
const LPOS = [
  { id: 'lpo-1', lpo_no: 'LPO-0001', issued_date: '2026-05-01', supplier_id: 'sup-1', description: '10 reams of photocopy paper, assorted pens', amount: 18500, status: 'fulfilled', finance_suppliers: { name: 'Rift Valley Stationers' } },
  { id: 'lpo-2', lpo_no: 'LPO-0002', issued_date: '2026-05-10', supplier_id: 'sup-2', description: 'Termly dry foodstuffs — maize, beans, rice', amount: 145000, status: 'pending', finance_suppliers: { name: 'Fresh Harvest Foodstuffs Ltd' } },
  { id: 'lpo-3', lpo_no: 'LPO-0003', issued_date: '2026-04-20', supplier_id: 'sup-3', description: 'Padlocks and door hinges for the dormitory', amount: 6200, status: 'cancelled', finance_suppliers: { name: 'Nakuru General Hardware' } }
];
const EXPENSES = [
  { id: 'exp-1', expense_no: 'EXP-0001', supplier_id: 'sup-1', lpo_id: 'lpo-1', vote_head_id: 'vh-activity', amount: 18500, paid_amount: 18500, expense_date: '2026-05-02', description: 'Stationery delivered per LPO-0001', status: 'paid', finance_suppliers: { name: 'Rift Valley Stationers' }, finance_vote_heads: { name: 'Activity Fee' }, finance_lpos: { lpo_no: 'LPO-0001' } },
  { id: 'exp-2', expense_no: 'EXP-0002', supplier_id: 'sup-2', lpo_id: null, vote_head_id: 'vh-lunch', amount: 92000, paid_amount: 40000, expense_date: '2026-05-12', description: '2 tonnes of maize flour delivered', status: 'partial', finance_suppliers: { name: 'Fresh Harvest Foodstuffs Ltd' }, finance_vote_heads: { name: 'Lunch' }, finance_lpos: null },
  { id: 'exp-3', expense_no: 'EXP-0003', supplier_id: 'sup-2', lpo_id: null, vote_head_id: 'vh-lunch', amount: 34000, paid_amount: 0, expense_date: '2026-05-24', description: 'Beans and rice — May top-up delivery', status: 'unpaid', finance_suppliers: { name: 'Fresh Harvest Foodstuffs Ltd' }, finance_vote_heads: { name: 'Lunch' }, finance_lpos: null },
  { id: 'exp-4', expense_no: 'EXP-0004', supplier_id: 'sup-3', lpo_id: null, vote_head_id: 'vh-activity', amount: 6200, paid_amount: 6200, expense_date: '2026-04-22', description: 'Padlocks and hinges delivered', status: 'paid', finance_suppliers: { name: 'Nakuru General Hardware' }, finance_vote_heads: { name: 'Activity Fee' }, finance_lpos: null },
  { id: 'exp-5', expense_no: 'EXP-0005', supplier_id: 'sup-1', lpo_id: null, vote_head_id: 'vh-tuition', amount: 210000, paid_amount: 210000, expense_date: '2026-04-30', description: 'Salaries & Wages — April payroll (posted)', status: 'paid', finance_suppliers: { name: 'Rift Valley Stationers' }, finance_vote_heads: { name: 'Tuition' }, finance_lpos: null }
];
const PAYMENT_VOUCHERS = [
  { id: 'pv-1', voucher_no: 'PV-0001', expense_id: 'exp-1', account_id: 'acc-1', amount: 18500, payment_date: '2026-05-02', payment_method: 'bank', status: 'active', notes: '', finance_expenses: EXPENSES[0], finance_accounts: { name: 'Equity Bank — Main Account' } },
  { id: 'pv-2', voucher_no: 'PV-0002', expense_id: 'exp-2', account_id: 'acc-1', amount: 40000, payment_date: '2026-05-13', payment_method: 'bank', status: 'active', notes: 'Part payment — balance next week', finance_expenses: EXPENSES[1], finance_accounts: { name: 'Equity Bank — Main Account' } },
  { id: 'pv-3', voucher_no: 'PV-0003', expense_id: 'exp-4', account_id: 'acc-2', amount: 6200, payment_date: '2026-04-22', payment_method: 'cash', status: 'active', notes: '', finance_expenses: EXPENSES[3], finance_accounts: { name: 'Petty Cash' } },
  { id: 'pv-4', voucher_no: 'PV-0004', expense_id: 'exp-5', account_id: 'acc-1', amount: 210000, payment_date: '2026-04-30', payment_method: 'bank', status: 'reversed', notes: 'April payroll payout', finance_expenses: EXPENSES[4], finance_accounts: { name: 'Equity Bank — Main Account' } }
];

// -------------------------------------------------------------- Inventory
const INVENTORY_CATEGORIES = [
  { id: 'ic-1', name: 'Stationery', active: true }, { id: 'ic-2', name: 'Foodstuffs', active: true },
  { id: 'ic-3', name: 'Cleaning Supplies', active: true }, { id: 'ic-4', name: 'Furniture', active: false }
];
const INVENTORY_UNITS = [
  { id: 'iu-1', name: 'Piece', active: true }, { id: 'iu-2', name: 'Dozen', active: true },
  { id: 'iu-3', name: 'Kilogram', active: true }, { id: 'iu-4', name: 'Litre', active: true }, { id: 'iu-5', name: 'Packet', active: true }
];
const INVENTORY_ITEMS = [
  { id: 'item-1', name: 'Photocopy Paper (Ream)', sku: 'STA-001', category_id: 'ic-1', unit_id: 'iu-1', quantity: 42, reorder_level: 20, unit_cost: 650, supplier_id: 'sup-1', storage_location: 'Store Room A', active: true, inventory_categories: { name: 'Stationery' }, inventory_units: { name: 'Piece' }, finance_suppliers: { name: 'Rift Valley Stationers' } },
  { id: 'item-2', name: 'Whiteboard Markers', sku: 'STA-002', category_id: 'ic-1', unit_id: 'iu-2', quantity: 3, reorder_level: 5, unit_cost: 900, supplier_id: 'sup-1', storage_location: 'Store Room A', active: true, inventory_categories: { name: 'Stationery' }, inventory_units: { name: 'Dozen' }, finance_suppliers: { name: 'Rift Valley Stationers' } },
  { id: 'item-3', name: 'Maize Flour', sku: 'FOD-001', category_id: 'ic-2', unit_id: 'iu-3', quantity: 0, reorder_level: 50, unit_cost: 120, supplier_id: 'sup-2', storage_location: 'Kitchen Store', active: true, inventory_categories: { name: 'Foodstuffs' }, inventory_units: { name: 'Kilogram' }, finance_suppliers: { name: 'Fresh Harvest Foodstuffs Ltd' } },
  { id: 'item-4', name: 'Cooking Oil', sku: 'FOD-002', category_id: 'ic-2', unit_id: 'iu-4', quantity: 60, reorder_level: 20, unit_cost: 280, supplier_id: 'sup-2', storage_location: 'Kitchen Store', active: true, inventory_categories: { name: 'Foodstuffs' }, inventory_units: { name: 'Litre' }, finance_suppliers: { name: 'Fresh Harvest Foodstuffs Ltd' } },
  { id: 'item-5', name: 'Detergent Powder', sku: 'CLN-001', category_id: 'ic-3', unit_id: 'iu-5', quantity: 15, reorder_level: 10, unit_cost: 350, supplier_id: 'sup-3', storage_location: 'Store Room B', active: true, inventory_categories: { name: 'Cleaning Supplies' }, inventory_units: { name: 'Packet' }, finance_suppliers: { name: 'Nakuru General Hardware' } },
  { id: 'item-6', name: 'Exercise Books (200pg)', sku: 'STA-003', category_id: 'ic-1', unit_id: 'iu-1', quantity: 480, reorder_level: 100, unit_cost: 55, supplier_id: 'sup-1', storage_location: 'Store Room A', active: true, inventory_categories: { name: 'Stationery' }, inventory_units: { name: 'Piece' }, finance_suppliers: { name: 'Rift Valley Stationers' } },
  { id: 'item-7', name: 'Student Desks', sku: 'FUR-001', category_id: 'ic-4', unit_id: 'iu-1', quantity: 8, reorder_level: 10, unit_cost: 4200, supplier_id: '', storage_location: 'Store Room C', active: false, inventory_categories: { name: 'Furniture' }, inventory_units: { name: 'Piece' }, finance_suppliers: null }
];
const INVENTORY_TRANSACTIONS = [
  { id: 'itx-1', item_id: 'item-1', type: 'receive', quantity: 50, reference: 'GRN-1001', created_at: '2026-05-01T09:00:00Z', staff: { full_name: 'Mary Wanjiku' }, inventory_items: { name: 'Photocopy Paper (Ream)' } },
  { id: 'itx-2', item_id: 'item-1', type: 'issue', quantity: -8, destination: 'Admin Office', person: 'Front Desk', created_at: '2026-05-06T09:00:00Z', staff: { full_name: 'Mary Wanjiku' }, inventory_items: { name: 'Photocopy Paper (Ream)' } },
  { id: 'itx-3', item_id: 'item-2', type: 'issue', quantity: -9, destination: 'Staffroom', created_at: '2026-05-10T09:00:00Z', staff: { full_name: 'Mary Wanjiku' }, inventory_items: { name: 'Whiteboard Markers' } },
  { id: 'itx-4', item_id: 'item-3', type: 'issue', quantity: -140, destination: 'Kitchen', reason: 'Weekly meals', created_at: '2026-05-15T09:00:00Z', staff: { full_name: 'James Mutua' }, inventory_items: { name: 'Maize Flour' } },
  { id: 'itx-5', item_id: 'item-4', type: 'receive', quantity: 60, reference: 'GRN-1002', created_at: '2026-05-12T09:00:00Z', staff: { full_name: 'James Mutua' }, inventory_items: { name: 'Cooking Oil' } },
  { id: 'itx-6', item_id: 'item-5', type: 'adjustment', quantity: -3, reason: 'Damaged', created_at: '2026-05-18T09:00:00Z', staff: { full_name: 'Mary Wanjiku' }, inventory_items: { name: 'Detergent Powder' } },
  { id: 'itx-7', item_id: 'item-6', type: 'stocktake', quantity: -20, reason: 'Term-end stock take', created_at: '2026-05-25T09:00:00Z', staff: { full_name: 'Mary Wanjiku' }, inventory_items: { name: 'Exercise Books (200pg)' } },
  { id: 'itx-8', item_id: 'item-7', type: 'receive', quantity: 8, reference: 'GRN-0990', created_at: '2026-03-14T09:00:00Z', staff: { full_name: 'James Mutua' }, inventory_items: { name: 'Student Desks' } }
];

// ---------------------------------------------------------------- Payroll
const PAYROLL_PROFILES = [
  { id: 'pp-1', staff_id: 'st-1', staff: { full_name: 'Peter Njoroge' }, position: 'Class Teacher', department: 'Academic', basic_salary: 45000, regular_allowances: 5000, regular_deductions: 2000, payment_method: 'bank', bank_name: 'Equity Bank', account_number: '0170298471234', active: true },
  { id: 'pp-2', staff_id: 'st-2', staff: { full_name: 'Alice Wambui' }, position: 'Class Teacher', department: 'Academic', basic_salary: 42000, regular_allowances: 4000, regular_deductions: 1800, payment_method: 'bank', bank_name: 'Equity Bank', account_number: '0170298471235', active: true },
  { id: 'pp-3', staff_id: 'st-3', staff: { full_name: 'Caroline Achieng' }, position: 'Class Teacher', department: 'Academic', basic_salary: 40000, regular_allowances: 4000, regular_deductions: 1500, payment_method: 'mpesa', bank_name: '', account_number: '0722111222', active: true },
  { id: 'pp-4', staff_id: 'st-7', staff: { full_name: 'Mary Wanjiku' }, position: 'Bursar', department: 'Support Staff', basic_salary: 38000, regular_allowances: 3000, regular_deductions: 1200, payment_method: 'bank', bank_name: 'KCB Bank', account_number: '1122334455', active: true },
  { id: 'pp-5', staff_id: 'st-8', staff: { full_name: 'James Mutua' }, position: 'Support Staff', department: 'Support Staff', basic_salary: 22000, regular_allowances: 1000, regular_deductions: 800, payment_method: 'cash', bank_name: '', account_number: '', active: true },
  { id: 'pp-6', staff_id: 'st-5', staff: { full_name: 'Judy Chebet' }, position: 'Class Teacher', department: 'Academic', basic_salary: 41000, regular_allowances: 4000, regular_deductions: 1500, payment_method: 'bank', bank_name: 'Equity Bank', account_number: '0170298471236', active: false }
];
function payrollItemFor(profile, extra) {
  const gross = profile.basic_salary + profile.regular_allowances + (extra ? extra.allowance || 0 : 0);
  const deductions = profile.regular_deductions + (extra ? extra.deduction || 0 : 0);
  return {
    id: `pi-${profile.id}`, staff_id: profile.staff_id, staff: profile.staff, position: profile.position, department: profile.department,
    basic_salary: profile.basic_salary, regular_allowances: profile.regular_allowances, regular_deductions: profile.regular_deductions,
    adjustments: extra && extra.label ? [{ label: extra.label, kind: extra.allowance ? 'allowance' : 'deduction', amount: extra.allowance || extra.deduction }] : [],
    gross_pay: gross, total_deductions: deductions, net_pay: gross - deductions
  };
}
const APRIL_ITEMS = PAYROLL_PROFILES.filter((p) => p.active).map((p) => payrollItemFor(p));
const APRIL_NET = APRIL_ITEMS.reduce((a, it) => a + it.net_pay, 0);
const PAYROLL_RUNS = [
  { id: 'run-april', period_year: 2026, period_month: 4, status: 'finalized', finance_expenses: { expense_no: 'EXP-0005', status: 'paid', paid_amount: APRIL_NET, amount: APRIL_NET } },
  { id: 'run-may', period_year: 2026, period_month: 5, status: 'draft', finance_expenses: null }
];
const PAYROLL_ITEMS = {
  'run-april': APRIL_ITEMS,
  'run-may': PAYROLL_PROFILES.filter((p) => p.active).map((p, i) => i === 0 ? payrollItemFor(p, { label: 'Exam Supervision Bonus', allowance: 2000 }) : payrollItemFor(p))
};

/* ============================================================================ */

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
    },
    async getActiveContext() {
      return { academic_year_name: '2026', term_name: 'Term 1' };
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
    // Harness-only proxy (same precedent as listExamsForClass elsewhere in
    // this file): marksEntry.mjs's loadSubjectTabs() calls
    // getClassSubjects(classId) directly (Phase 2g's per-stream assignment
    // model), which predates this shim and was never added here. Reuses
    // getStreamSubjects()'s fixture data shaped as { subject_id }.
    async getClassSubjects(classId) {
      return { ok: true, data: SUBJECTS.map((s) => ({ subject_id: s.id })) };
    },
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
      // Finance module screenshot support: unioned with FIN_EXTRA_STUDENTS
      // (mockups-only — real students in Grade 6/7/9 so Finance's
      // class/stream-targeted notes, messaging and reports have more than
      // one class to show) below Db.finance.* — same shape old callers
      // (classList/students/marksEntry/etc.) already rely on, just no
      // longer hardcoded to CLASS_ID for every row.
      const all = STUDENTS.map((s) => ({ ...s, class_id: CLASS_ID, class_name: 'Grade 8' })).concat(FIN_EXTRA_STUDENTS);
      const data = all
        .filter((s) => !q.class_id || q.class_id === s.class_id)
        .filter((s) => !q.stream_id || s.stream_id === q.stream_id)
        .map((s) => ({
          id: s.id, admission_no: s.admission_no, full_name: s.full_name, class_id: s.class_id, class_name: s.class_name,
          gender: s.gender, stream_id: s.stream_id,
          stream_name: s.stream_name || (STREAMS.find((st) => st.id === s.stream_id) || {}).name || '',
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
    // Harness-only fixture (same precedent as listExamsForClass/
    // getClassSubjects elsewhere in this file): Dashboard's "Last Exam
    // Analyzed" widget now calls this directly (see dashboard.mjs's
    // loadExamGraph / results.mjs's lastPublishedExamClass) instead of
    // just assuming the newest exam — points the harness at the same
    // (EXAM_ID, CLASS_ID) pair getBroadsheet's own fixture below actually
    // has data for, so the widget renders instead of showing "No published
    // results yet" in the offline harness.
    async lastPublishedExamClass() { return { ok: true, data: { exam_id: EXAM_ID, class_id: CLASS_ID, published_at: '2026-08-02T10:15:00Z' } }; },
    // Harness-only stand-in for the real per-class exam scoping (reportForms.mjs)
    // — this shim predates that feature; just proxy to listExams() so the
    // Report Forms screenshot flow (Class -> Exam -> Student) works.
    async listExamsForClass() { return this.listExams(); },
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
  },

  finance: {
    async bootstrap() { return { ok: true }; },
    students: {
      async search(q) {
        q = String(q || '').toLowerCase();
        const data = ALL_FIN_STUDENTS.filter((s) => s.full_name.toLowerCase().indexOf(q) !== -1 || s.admission_no.toLowerCase().indexOf(q) !== -1).slice(0, 30);
        return { ok: true, data };
      },
      async balance(id) { return { ok: true, data: { balance: studentBalance(id) } }; },
      async openingBalance() { return { ok: true, data: null }; },
      async openingBalancesForYear() { return { ok: true, data: {} }; },
      async bulkOpeningBalances(rows) { return { ok: true, data: { imported: (rows || []).length } }; },
      async transferOverpayment() { return { ok: true }; }
    },
    voteHeads: {
      async list() { return { ok: true, data: VOTE_HEADS }; },
      async save(payload) { return { ok: true, data: { id: payload.id || 'vh-new-' + Date.now(), name: payload.name, code: payload.code || '', priority: payload.priority || 100, active: true } }; }
    },
    accountTypes: {
      async list() { return { ok: true, data: ACCOUNT_TYPES }; },
      async save() { return { ok: true }; }
    },
    accounts: {
      async list() { return { ok: true, data: ACCOUNTS }; },
      async save() { return { ok: true }; }
    },
    feeStructures: {
      async list() {
        const data = ['class-6', 'class-7', 'class-8', 'class-9'].map((cid, i) => ({
          id: `fs-${cid}`, name: `${CLASS_NAME_BY_ID[cid]} Fees — Term 2`, academic_year_id: AY_ID, term_id: TERM_ID,
          finance_fee_structure_items: feeItemsForClass(cid),
          finance_fee_structure_classes: [{ class_id: cid }]
        }));
        return { ok: true, data };
      },
      async invoicedStructureIds() { return { ok: true, data: ['fs-class-6', 'fs-class-7', 'fs-class-8', 'fs-class-9'] }; },
      async save() { return { ok: true }; },
      async generateInvoices() { return { ok: true, data: { invoiced_count: 0 } }; },
      async uninvoice() { return { ok: true, data: { affected_students: 0, removed_items: 0 } }; }
    },
    debitNotes: {
      async forStudent(id) { return { ok: true, data: DEBIT_NOTES.filter((n) => n.student_id === id) }; },
      async issue() { return { ok: true }; },
      async reverse() { return { ok: true }; }
    },
    creditNotes: {
      async forStudent(id) { return { ok: true, data: CREDIT_NOTES.filter((n) => n.student_id === id) }; },
      async issue() { return { ok: true }; },
      async reverse() { return { ok: true }; }
    },
    invoices: {
      async forStudent(id) {
        return { ok: true, data: [{ id: `inv-${id}`, academic_year_id: AY_ID, term_id: TERM_ID, finance_invoice_items: studentInvoiceItems(id) }] };
      }
    },
    collections: {
      async list(q) {
        q = q || {};
        let rows = COLLECTIONS.map(collectionView);
        if (q.student_id) rows = rows.filter((c) => c.student_id === q.student_id);
        rows = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        if (q.limit) rows = rows.slice(0, q.limit);
        return { ok: true, data: rows };
      },
      async allocations(id) {
        const c = COLLECTIONS.find((x) => x.id === id);
        if (!c) return { ok: true, data: [] };
        // Simple even split across this student's fee vote heads — good
        // enough for a receipt screenshot, not meant to reconcile exactly.
        const items = feeItemsForClass((ALL_FIN_STUDENTS.find((s) => s.id === c.student_id) || {}).class_id);
        return { ok: true, data: items.map((it) => ({ amount: Math.round(c.amount / items.length), vote_head_id: it.vote_head_id, finance_vote_heads: { name: voteHeadName(it.vote_head_id) } })) };
      },
      async record() { return { ok: true, data: { id: 'col-new', receipt_no: 'RCT-000200' } }; },
      async reverse() { return { ok: true }; },
      async transfer() { return { ok: true }; }
    },
    suppliers: {
      async list() { return { ok: true, data: SUPPLIERS }; },
      async save() { return { ok: true }; }
    },
    lpos: {
      async list() { return { ok: true, data: LPOS }; },
      async pendingForSupplier(supplierId) { return { ok: true, data: LPOS.filter((l) => l.supplier_id === supplierId && l.status === 'pending') }; },
      async record() { return { ok: true, data: { id: 'lpo-new', lpo_no: 'LPO-0004' } }; },
      async cancel() { return { ok: true }; }
    },
    expenses: {
      async list(f) {
        f = f || {};
        return {
          ok: true, data: EXPENSES.filter((e) => (!f.supplier_id || e.supplier_id === f.supplier_id) && (!f.vote_head_id || e.vote_head_id === f.vote_head_id) && (!f.status || e.status === f.status))
        };
      },
      async record() { return { ok: true, data: { id: 'exp-new', expense_no: 'EXP-0006' } }; }
    },
    paymentVouchers: {
      async list() { return { ok: true, data: PAYMENT_VOUCHERS }; },
      async record() { return { ok: true, data: { id: 'pv-new', voucher_no: 'PV-0005' } }; },
      async reverse() { return { ok: true }; }
    },
    supplierBalances: {
      async list() {
        const data = SUPPLIERS.map((s) => {
          const invoiced = EXPENSES.filter((e) => e.supplier_id === s.id).reduce((a, e) => a + e.amount, 0);
          const paid = EXPENSES.filter((e) => e.supplier_id === s.id).reduce((a, e) => a + e.paid_amount, 0);
          return { supplier_id: s.id, name: s.name, invoiced, paid, balance: invoiced - paid };
        });
        return { ok: true, data };
      }
    },
    payrollProfiles: {
      async list() { return { ok: true, data: PAYROLL_PROFILES }; },
      async save() { return { ok: true }; }
    },
    payrollRuns: {
      async list() { return { ok: true, data: PAYROLL_RUNS }; },
      async items(runId) { return { ok: true, data: PAYROLL_ITEMS[runId] || [] }; },
      async create() { return { ok: true, data: { employee_count: PAYROLL_PROFILES.filter((p) => p.active).length } }; },
      async finalize() { return { ok: true, data: { expense_no: 'EXP-0007' } }; },
      async reverse() { return { ok: true }; },
      async updateItem() { return { ok: true }; },
      async historyForStaff(staffId) {
        const data = PAYROLL_RUNS.filter((r) => r.status === 'finalized').map((r) => {
          const item = (PAYROLL_ITEMS[r.id] || []).find((it) => it.staff_id === staffId);
          if (!item) return null;
          return { finance_payroll_runs: { period_month: r.period_month, period_year: r.period_year }, basic_salary: item.basic_salary, gross_pay: item.gross_pay, total_deductions: item.total_deductions, net_pay: item.net_pay };
        }).filter(Boolean);
        return { ok: true, data };
      }
    },
    routes: {
      async list() { return { ok: true, data: ROUTES }; },
      async save() { return { ok: true }; },
      async forStudent(studentId) {
        const a = ROUTE_ASSIGNMENTS.find((x) => x.student_id === studentId);
        return { ok: true, data: a ? { route_id: a.route_id, direction: a.direction } : null };
      },
      async studentsOnRoute(routeId) {
        const data = ROUTE_ASSIGNMENTS.filter((a) => a.route_id === routeId).map((a) => {
          const s = ALL_FIN_STUDENTS.find((x) => x.id === a.student_id);
          return { student_id: a.student_id, direction: a.direction, students: s ? { full_name: s.full_name, admission_no: s.admission_no, classes: s.classes } : null };
        });
        return { ok: true, data };
      },
      async invoicedStudentIds(routeId) {
        const ids = ROUTE_ASSIGNMENTS.filter((a) => a.route_id === routeId && ROUTE_INVOICED_IDS.has(a.student_id)).map((a) => a.student_id);
        return { ok: true, data: ids };
      },
      async invoiceRoute(routeId) {
        const total = ROUTE_ASSIGNMENTS.filter((a) => a.route_id === routeId).length;
        const already = ROUTE_ASSIGNMENTS.filter((a) => a.route_id === routeId && ROUTE_INVOICED_IDS.has(a.student_id)).length;
        return { ok: true, data: { invoiced_count: total - already, skipped_count: already } };
      },
      async assign() { return { ok: true }; },
      async classAssignments() {
        const data = ROUTE_ASSIGNMENTS.map((a) => {
          const s = ALL_FIN_STUDENTS.find((x) => x.id === a.student_id);
          const r = ROUTES.find((x) => x.id === a.route_id);
          return { direction: a.direction, students: s ? { full_name: s.full_name, admission_no: s.admission_no, classes: s.classes } : null, finance_routes: r ? { name: r.name } : null };
        });
        return { ok: true, data };
      }
    },
    reports: {
      async dashboard() {
        const perClass = ['class-6', 'class-7', 'class-8', 'class-9'].map((cid) => {
          const students = ALL_FIN_STUDENTS.filter((s) => s.class_id === cid);
          const expected = students.reduce((a, s) => a + studentExpected(s.id), 0);
          const collected = students.reduce((a, s) => a + studentPaid(s.id), 0);
          return { class_name: CLASS_NAME_BY_ID[cid], expected, collected, pct: expected ? Math.round((collected / expected) * 100) : 0 };
        });
        return {
          ok: true,
          data: {
            total_collected: TOTAL_COLLECTED, total_balance: TOTAL_EXPECTED - TOTAL_COLLECTED, total_students: ALL_FIN_STUDENTS.length,
            total_expected: TOTAL_EXPECTED, pct_collected: TOTAL_EXPECTED ? Math.round((TOTAL_COLLECTED / TOTAL_EXPECTED) * 100) : 0,
            per_class: perClass
          }
        };
      },
      async classBalances(classId, minBalance) {
        let rows = ALL_FIN_STUDENTS.filter((s) => !classId || s.class_id === classId).map((s) => {
          const expected = studentExpected(s.id);
          const paid = studentPaid(s.id);
          const cn = CREDIT_NOTES.filter((n) => n.student_id === s.id).reduce((a, n) => a + n.amount, 0);
          return { student_id: s.id, admission_no: s.admission_no, full_name: s.full_name, class_name: s.classes.name, stream_name: s.streams ? s.streams.name : '', expected, paid, credit_note: cn, balance: studentBalance(s.id) };
        });
        if (minBalance) rows = rows.filter((r) => r.balance >= Number(minBalance));
        return { ok: true, data: rows };
      },
      async voteHeadStudentBalances(voteHeadId) {
        const data = ALL_FIN_STUDENTS.map((s) => {
          const item = feeItemsForClass(s.class_id).find((it) => it.vote_head_id === voteHeadId);
          if (!item) return null;
          const paid = Math.min(studentPaid(s.id), item.amount);
          return { admission_no: s.admission_no, full_name: s.full_name, class_name: s.classes.name, stream_name: s.streams ? s.streams.name : '', expected: item.amount, paid, balance: item.amount - paid };
        }).filter(Boolean);
        return { ok: true, data };
      },
      async voteHeadCollections() {
        const weights = { 'vh-tuition': 0.65, 'vh-lunch': 0.2, 'vh-activity': 0.1, 'vh-transport': 0.05 };
        const data = Object.keys(weights).map((id) => ({ vote_head_name: voteHeadName(id), collected: Math.round(TOTAL_COLLECTED * weights[id]) }));
        return { ok: true, data };
      },
      async cashbook() {
        const data = COLLECTIONS.filter((c) => c.status === 'active').map((c) => {
          const s = ALL_FIN_STUDENTS.find((x) => x.id === c.student_id);
          return { collection_date: c.created_at, receipt_no: c.receipt_no, student_name: s ? s.full_name : '', admission_no: s ? s.admission_no : '', mode: c.mode, amount: c.amount };
        });
        return { ok: true, data };
      },
      async trialBalance() {
        const weights = { 'vh-tuition': 0.65, 'vh-lunch': 0.2, 'vh-activity': 0.1, 'vh-transport': 0.05 };
        const data = Object.keys(weights).map((id) => ({ vote_head_name: voteHeadName(id), invoiced: Math.round(TOTAL_EXPECTED * weights[id]), collected: Math.round(TOTAL_COLLECTED * weights[id]) }));
        return { ok: true, data };
      }
    }
  },

  inventory: {
    async bootstrap() { return { ok: true }; },
    items: {
      async list() { return { ok: true, data: INVENTORY_ITEMS }; },
      async save() { return { ok: true }; }
    },
    categories: {
      async list() { return { ok: true, data: INVENTORY_CATEGORIES }; },
      async save() { return { ok: true }; },
      async remove() { return { ok: true }; }
    },
    units: {
      async list() { return { ok: true, data: INVENTORY_UNITS }; },
      async save() { return { ok: true }; },
      async remove() { return { ok: true }; }
    },
    transactions: {
      async list(f) {
        f = f || {};
        let rows = INVENTORY_TRANSACTIONS.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        if (f.item_id) rows = rows.filter((t) => t.item_id === f.item_id);
        if (f.type) rows = rows.filter((t) => t.type === f.type);
        return { ok: true, data: rows };
      }
    },
    async receive() { return { ok: true, data: { new_quantity: 50 } }; },
    async issue() { return { ok: true, data: { new_quantity: 30 } }; },
    async adjust() { return { ok: true, data: { new_quantity: 28 } }; },
    async stocktake() { return { ok: true, data: { recorded: true, difference: -2 } }; }
  }
};
