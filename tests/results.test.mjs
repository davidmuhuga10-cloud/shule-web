import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createGradingApi } from '../src/lib/api/grading.mjs';
import { createResultsApi } from '../src/lib/api/results.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

const BASE_TABLES = {
  academic_years: [{ id: 'y1', name: '2026' }],
  terms: [{ id: 't1', academic_year_id: 'y1', name: 'Term 1' }],
  classes: [{ id: 'c1', name: 'Grade 7' }],
  streams: [{ id: 'str1', class_id: 'c1', name: 'North' }],
  grading_scales: [{ id: 'gs1', name: 'Default', is_default: true }],
  grade_ranges: [
    { id: 'gr1', grading_scale_id: 'gs1', min_score: 80, max_score: 100, grade_label: 'A', points: 12 },
    { id: 'gr2', grading_scale_id: 'gs1', min_score: 50, max_score: 79, grade_label: 'B', points: 8 },
    { id: 'gr3', grading_scale_id: 'gs1', min_score: 0, max_score: 49, grade_label: 'C', points: 4 }
  ],
  subjects: [{ id: 'su1', name: 'Mathematics' }, { id: 'su2', name: 'English' }],
  students: [
    { id: 's1', admission_no: '23', full_name: 'Jane', gender: 'Female', class_id: 'c1', stream_id: 'str1', status: 'active' },
    { id: 's2', admission_no: '5', full_name: 'Amos', gender: 'Male', class_id: 'c1', stream_id: 'str1', status: 'active' },
    { id: 's3', admission_no: '9', full_name: 'Tie A', gender: 'Male', class_id: 'c1', stream_id: 'str1', status: 'active' },
    { id: 's4', admission_no: '10', full_name: 'Tie B', gender: 'Female', class_id: 'c1', stream_id: 'str1', status: 'active' }
  ],
  subject_class_assignments: [{ id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su2', class_id: 'c1' }]
};

function freshApis(extraTables) {
  const sb = createMockSupabase(JSON.parse(JSON.stringify(Object.assign({}, BASE_TABLES, extraTables || {}))));
  const grading = createGradingApi(sb);
  const results = createResultsApi(sb, grading);
  return { sb, results };
}

async function run() {
  // ---- exam CRUD ----------------------------------------------------------------
  {
    const { results } = freshApis();
    check('saveExam requires a name', (await results.saveExam({ academic_year_id: 'y1', term_id: 't1' })).ok === false);
    check('saveExam requires an academic year', (await results.saveExam({ name: 'Midterm', term_id: 't1' })).ok === false);
    const saved = await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' });
    check('saveExam succeeds and defaults out_of to 100', saved.ok === true && saved.data.out_of === 100);
    check('saveExam defaults exam_type to summative', saved.data.exam_type === 'summative');
    const typed = await results.saveExam({ name: 'CAT 1', academic_year_id: 'y1', term_id: 't1', exam_type: 'cat' });
    check('saveExam accepts a valid exam_type', typed.data.exam_type === 'cat');
    const badType = await results.saveExam({ name: 'Weird', academic_year_id: 'y1', term_id: 't1', exam_type: 'nonsense' });
    check('saveExam falls back to summative for an unrecognized exam_type', badType.data.exam_type === 'summative');
  }

  // ---- getResultsEntry / saveResultsEntry (whole-subject, no papers) ------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100 })).data;

    const entry = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1' });
    check('getResultsEntry returns all active students', entry.data.length === 4);
    check('getResultsEntry sorts numerically by admission number (5,9,10,23)', entry.data.map((r) => r.admission_no).join(',') === '5,9,10,23');

    check('saveResultsEntry requires class_id', (await results.saveResultsEntry({ exam_id: exam.id, subject_id: 'su1', scores: [] })).ok === false);

    const saveRes = await results.saveResultsEntry({
      exam_id: exam.id, class_id: 'c1', subject_id: 'su1',
      scores: [
        { student_id: 's1', score: '85' },  // -> A
        { student_id: 's2', score: '60' },  // -> B
        { student_id: 's3', score: 'not-a-number' }, // invalid, skipped
        { student_id: 's4', score: '150' }  // out of range (out_of=100), skipped
      ]
    });
    check('saveResultsEntry saves only the 2 valid scores', saveRes.saved === 2);

    const entry2 = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1' });
    const jane = entry2.data.find((r) => r.student_id === 's1');
    check('saved score is graded correctly against the default scale', jane.score === 85 && jane.grade_label === 'A');
    check('saved row is stamped with the class_id it was entered against', sb._tables.results.find((r) => r.student_id === 's1').class_id === 'c1');

    const clearRes = await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '' }] });
    check('saveResultsEntry clears a score when given an empty string', clearRes.cleared === 1);
    const entry3 = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1' });
    check('cleared score no longer appears', entry3.data.find((r) => r.student_id === 's1').score === '');
  }

  // ---- getResultsEntry / saveResultsEntry (per-paper marks) ----------------------
  {
    const { sb, results } = freshApis({
      subject_papers: [
        { id: 'p1', subject_id: 'su1', name: 'Paper 1', paper_no: 1, weight: 0.6, out_of: 100 },
        { id: 'p2', subject_id: 'su1', name: 'Paper 2', paper_no: 2, weight: 0.4, out_of: 50 }
      ]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100 })).data;

    const entryP1 = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p1' });
    check('getResultsEntry uses the paper\'s own out_of', entryP1.out_of === 100);
    const entryP2 = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p2' });
    check('getResultsEntry uses a different paper\'s own out_of', entryP2.out_of === 50);

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p1', scores: [{ student_id: 's1', score: '80' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p2', scores: [{ student_id: 's1', score: '40' }] });

    const rows = sb._tables.results.filter((r) => r.student_id === 's1');
    check('per-paper rows are saved separately (2 rows for one subject)', rows.length === 2);
    check('per-paper rows are not individually graded', rows.every((r) => r.grade_label === null));

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    // 80/100*100*0.6 = 48, 40/50*100*0.4 = 32 -> 80 combined, on the exam's own out_of (100).
    check('getBroadsheet combines per-paper marks into one weighted effective score', sheet.students.find((s) => s.student_id === 's1').scores.su1 === 80);
  }

  // ---- broadsheet ranking with ties -----------------------------------------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100 })).data;
    // Jane: 90 total. Amos: 70. Tie A & Tie B: both 60 (tie for 3rd).
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [
      { student_id: 's1', score: '90' }, { student_id: 's2', score: '70' }, { student_id: 's3', score: '60' }, { student_id: 's4', score: '60' }
    ] });

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    check('getBroadsheet succeeds', sheet.ok === true);
    check('getBroadsheet includes the subjects assigned to the class', sheet.subjects.length === 2);
    check('getBroadsheet reports each subject\'s (default draft) submission status', sheet.subjects.every((s) => s.submission_status === 'draft'));
    const byId = {}; sheet.students.forEach((s) => { byId[s.student_id] = s; });
    check('getBroadsheet ranks the top scorer #1', byId.s1.position === 1);
    check('getBroadsheet ranks second place #2', byId.s2.position === 2);
    check('tied students share the same rank (both #3)', byId.s3.position === 3 && byId.s4.position === 3);
    check('rows are sorted by total descending', sheet.students[0].student_id === 's1');
  }

  // ---- broadsheet honours min-subjects-for-ranking --------------------------------
  {
    const { sb, results } = freshApis({ settings: [{ id: 'set1', key: 'min_subjects_for_ranking', value: '2' }] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100 })).data;
    // Jane has both subjects; Amos only one -> Amos should be excluded from ranking.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '80' }, { student_id: 's2', score: '90' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '70' }] });

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    const byId = {}; sheet.students.forEach((s) => { byId[s.student_id] = s; });
    check('a student below min_subjects_for_ranking gets no position', byId.s2.position === '');
    check('a student meeting min_subjects_for_ranking is still ranked', byId.s1.position === 1);
  }

  // ---- getReportCard (via mocked RPC) ---------------------------------------------
  {
    const { sb, results } = freshApis();
    sb.__registerRpc('get_report_card', (args) => {
      if (args.p_student_id !== 's1') return { data: null, error: { message: 'Not authorized to view this report card' } };
      return { data: { student: { full_name: 'Jane' }, total: 170, average: 85, position: 1, class_size: 4 }, error: null };
    });
    const mine = await results.getReportCard('exam-1', 's1');
    check('getReportCard returns the RPC payload for an authorized call', mine.ok === true && mine.data.position === 1);
    const forbidden = await results.getReportCard('exam-1', 's2');
    check('getReportCard surfaces the authorization failure as a friendly error', forbidden.ok === false);
  }

  // ---- getStudentExams -------------------------------------------------------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    const mine = await results.getStudentExams('s1');
    check('getStudentExams finds exams the student has results for', mine.data.length === 1 && mine.data[0].id === exam.id);
    const none = await results.getStudentExams('s2');
    check('getStudentExams returns empty for a student with no results', none.data.length === 0);
  }

  // ---- publishing workflow (submission-status functions) --------------------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });

    const initial = await results.getSubmissionStatus(exam.id, 'c1', 'su1');
    check('getSubmissionStatus defaults to draft when no row exists yet', initial.data.status === 'draft');

    const submitted = await results.submitForApproval(exam.id, 'c1', 'su1');
    check('submitForApproval creates a submission row with status submitted', submitted.ok === true && submitted.data.status === 'submitted');

    const approved = await results.approveSubmission(exam.id, 'c1', 'su1');
    check('approveSubmission updates the SAME row (no duplicate) to approved', approved.ok === true && approved.data.status === 'approved'
      && sb._tables.result_submissions.filter((r) => r.exam_id === exam.id && r.class_id === 'c1' && r.subject_id === 'su1').length === 1);

    const published = await results.publishSubmission(exam.id, 'c1', 'su1');
    check('publishSubmission updates status to published', published.ok === true && published.data.status === 'published');

    const list = await results.listSubmissions(exam.id, 'c1');
    check('listSubmissions reports the current status for every subject with marks', list.ok === true && list.data.length === 1 && list.data[0].status === 'published');

    const reopened = await results.reopenSubmission(exam.id, 'c1', 'su1');
    check('reopenSubmission moves status back to draft', reopened.ok === true && reopened.data.status === 'draft');
  }

  // ---- publishExam bulk shortcut ---------------------------------------------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '60' }] });

    const bulk = await results.publishExam(exam.id, 'c1');
    check('publishExam publishes every subject with marks entered', bulk.ok === true && bulk.published === 2 && bulk.total === 2);
    const list = await results.listSubmissions(exam.id, 'c1');
    check('publishExam actually published both subjects', list.data.every((r) => r.status === 'published'));

    const empty = await results.publishExam(exam.id, 'c2');
    check('publishExam errors when the class has no marks at all', empty.ok === false);
  }

  // ---- listSubmissions: teacher name + entered/expected counts (Phase 2e) ---------
  {
    const { sb, results } = freshApis({
      staff: [{ id: 'stf1', full_name: 'Mrs Njeri' }],
      subject_teacher_assignments: [{ id: 'sta1', subject_id: 'su1', class_id: 'c1', staff_id: 'stf1' }]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    // Only 2 of the 4 active students in c1 get a Maths mark -> incomplete.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }, { student_id: 's2', score: '60' }] });

    const list = await results.listSubmissions(exam.id, 'c1');
    const maths = list.data.find((r) => r.subject_id === 'su1');
    check('listSubmissions reports the assigned teacher\'s name', maths.teacher_name === 'Mrs Njeri');
    check('listSubmissions reports how many students have a mark', maths.entered_count === 2);
    check('listSubmissions reports the full expected roster size', maths.expected_count === 4);
    check('listSubmissions flags an incomplete subject as not complete', maths.complete === false);

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '70' }] });
    const listBoth = await results.listSubmissions(exam.id, 'c1');
    const english = listBoth.data.find((r) => r.subject_id === 'su2');
    check('listSubmissions leaves teacher_name blank when nobody is assigned to that subject', english.teacher_name === '');

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's3', score: '55' }, { student_id: 's4', score: '65' }] });
    const list2 = await results.listSubmissions(exam.id, 'c1');
    check('listSubmissions marks a subject complete once every active student has a mark', list2.data.find((r) => r.subject_id === 'su1').complete === true);
  }

  // ---- listExamClasses (the Manage Exams board's data source) ---------------------
  {
    const { sb, results } = freshApis({
      classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }],
      students: [
        { id: 's1', admission_no: '1', full_name: 'A', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's5', admission_no: '5', full_name: 'E', gender: 'Male', class_id: 'c2', status: 'active' }
      ],
      subject_class_assignments: [
        { id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su2', class_id: 'c1' },
        { id: 'sca3', subject_id: 'su1', class_id: 'c2' }
      ]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;

    const none = await results.listExamClasses(exam.id);
    check('listExamClasses is empty before any marks are entered anywhere', none.ok === true && none.data.length === 0);

    // c1 has 2 assigned subjects; only 1 (su1) gets marks -> in progress.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    // c2 has 1 assigned subject (su1); it gets marks -> fully entered, not yet published.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c2', subject_id: 'su1', scores: [{ student_id: 's5', score: '50' }] });

    const inProgress = await results.listExamClasses(exam.id);
    check('listExamClasses now includes both classes with any activity', inProgress.data.length === 2);
    const c1Row = inProgress.data.find((r) => r.class_id === 'c1');
    const c2Row = inProgress.data.find((r) => r.class_id === 'c2');
    check('a class missing marks for some assigned subjects is in_progress', c1Row.status === 'in_progress');
    check('a class with marks for every assigned subject (not yet published) is ready_to_publish', c2Row.status === 'ready_to_publish');

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '60' }] });
    await results.publishExam(exam.id, 'c1');
    await results.publishExam(exam.id, 'c2');
    const done = await results.listExamClasses(exam.id);
    check('a fully-published class shows status published', done.data.every((r) => r.status === 'published'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
