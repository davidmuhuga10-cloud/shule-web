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
  subject_class_assignments: [{ id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su2', class_id: 'c1' }],
  subject_papers: [],
  subject_combinations: [],
  subject_combination_members: []
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
    check('saveExam defaults exam_type to written (Zeraki-style types, brief Step 1)', saved.data.exam_type === 'written');
    const typed = await results.saveExam({ name: 'Supplementary 1', academic_year_id: 'y1', term_id: 't1', exam_type: 'supplementary' });
    check('saveExam accepts a valid exam_type', typed.data.exam_type === 'supplementary');
    const badType = await results.saveExam({ name: 'Weird', academic_year_id: 'y1', term_id: 't1', exam_type: 'nonsense' });
    check('saveExam falls back to written for an unrecognized exam_type', badType.data.exam_type === 'written');
  }

  // ---- listExamsForClass (Round 4 §4: Report Forms flow is Class-first) ---------
  {
    const { results } = freshApis({ classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }] });
    check('listExamsForClass returns nothing for an empty/missing class id', (await results.listExamsForClass('')).ok === true && (await results.listExamsForClass('')).data.length === 0);
    check('listExamsForClass returns nothing for a class assigned to zero exams', (await results.listExamsForClass('c2')).ok === true && (await results.listExamsForClass('c2')).data.length === 0);
    const examA = (await results.saveExam({ name: 'Opener', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    await results.saveExam({ name: 'Midterm (Grade 8 only)', academic_year_id: 'y1', term_id: 't1', class_ids: ['c2'] });
    const forC1 = await results.listExamsForClass('c1');
    check('listExamsForClass only returns exams actually assigned to that class (via exam_classes)', forC1.ok === true && forC1.data.length === 1 && forC1.data[0].id === examA.id);
    const forC2 = await results.listExamsForClass('c2');
    check('a different class sees its own, different exam list', forC2.ok === true && forC2.data.length === 1 && forC2.data[0].name === 'Midterm (Grade 8 only)');
    // Unassigning a class from an exam (re-saving with a narrower class_ids)
    // must drop it from that class's list too — same exam_classes replace-
    // the-set behavior saveExam() already documents.
    await results.saveExam({ id: examA.id, name: 'Opener', academic_year_id: 'y1', term_id: 't1', class_ids: [] });
    const afterUnassign = await results.listExamsForClass('c1');
    check('listExamsForClass reflects a class being unassigned from an exam', afterUnassign.ok === true && afterUnassign.data.length === 0);
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

  // ---- Phase 2f: saveResultsEntry is ONE round trip regardless of class size ------
  // This is the actual fix for "marks import takes 4-5 minutes" — the old
  // implementation awaited one select-then-insert-or-update per student;
  // asserting exactly one supabase.rpc() call proves a 40-student class (or
  // a 10-subject bulk upload) now costs one network round trip, not dozens.
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100 })).data;
    let rpcCalls = 0;
    const realRpc = sb.rpc.bind(sb);
    sb.rpc = (name, args) => { if (name === 'save_results_batch') rpcCalls++; return realRpc(name, args); };

    const res = await results.saveResultsEntry({
      exam_id: exam.id, class_id: 'c1', subject_id: 'su1',
      scores: [{ student_id: 's1', score: '85' }, { student_id: 's2', score: '60' }, { student_id: 's3', score: '70' }, { student_id: 's4', score: '90' }]
    });
    check('saveResultsEntry succeeds', res.ok === true && res.saved === 4);
    check('saveResultsEntry issues exactly ONE supabase.rpc() call no matter how many students are in the grid', rpcCalls === 1);
  }

  // ---- deleteAllResults (brief §7.2 "Delete All Results") -------------------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '80' }, { student_id: 's2', score: '60' }] });

    const wiped = await results.deleteAllResults(exam.id, 'c1', 'su1');
    check('deleteAllResults succeeds and reports how many rows it removed', wiped.ok === true && wiped.deleted === 2);
    check('deleteAllResults actually removes the rows', sb._tables.results.filter((r) => r.exam_id === exam.id && r.subject_id === 'su1').length === 0);

    const missing = await results.deleteAllResults(null, 'c1', 'su1');
    check('deleteAllResults requires an exam', missing.ok === false);

    // Once published, deleteAllResults refuses (reopen first).
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '80' }] });
    await results.publishSubmission(exam.id, 'c1', 'su2');
    const blocked = await results.deleteAllResults(exam.id, 'c1', 'su2');
    check('deleteAllResults refuses once a subject is published', blocked.ok === false);
  }

  // ---- getResultsEntry / saveResultsEntry (per-paper marks) ----------------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    sb._tables.subject_papers.push(
      { id: 'p1', exam_id: exam.id, class_id: 'c1', subject_id: 'su1', name: 'Paper 1', paper_no: 1, weight: 0.6, out_of: 100 },
      { id: 'p2', exam_id: exam.id, class_id: 'c1', subject_id: 'su1', name: 'Paper 2', paper_no: 2, weight: 0.4, out_of: 50 }
    );

    const entryP1 = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p1' });
    check('getResultsEntry uses the paper\'s own out_of', entryP1.out_of === 100);
    const entryP2 = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p2' });
    check('getResultsEntry uses a different paper\'s own out_of', entryP2.out_of === 50);

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p1', scores: [{ student_id: 's1', score: '80' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p2', scores: [{ student_id: 's1', score: '40' }] });

    const rows = sb._tables.results.filter((r) => r.student_id === 's1');
    check('per-paper rows are saved separately (2 rows for one subject)', rows.length === 2);
    check('per-paper rows are not individually graded', rows.every((r) => r.grade_label === null));

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    // 80/100*100*0.6 = 48, 40/50*100*0.4 = 32 -> 80 combined, on the exam's own out_of (100).
    const janeRow = sheet.students.find((s) => s.student_id === 's1');
    check('getBroadsheet combines per-paper marks into one weighted effective score', janeRow.scores.su1 === 80);

    // ---- Learning Area Papers: display-only fields (papers, paperScores, subjectPct) ----
    const su1Subject = sheet.subjects.find((s) => s.id === 'su1');
    check('getBroadsheet exposes the subject\'s paper configuration for this exam', Array.isArray(su1Subject.papers) && su1Subject.papers.length === 2);
    check('getBroadsheet keeps papers in paper_no order', su1Subject.papers[0].id === 'p1' && su1Subject.papers[1].id === 'p2');
    check('getBroadsheet exposes each student\'s raw per-paper scores', janeRow.paperScores.su1.p1 === 80 && janeRow.paperScores.su1.p2 === 40);
    check('getBroadsheet exposes the combined subject % (same weighted formula, expressed on the exam out_of)', janeRow.subjectPct.su1 === 80);
    // The combined %, not the raw paper scores, is what feeds totals/ranking.
    check('the combined score (not a raw paper score) is what drives the student\'s total', janeRow.total === 80 + (janeRow.scores.su2 || 0));

    // A subject with no papers configured for this exam gets no `papers`/paperScores/subjectPct entries.
    const su2Subject = sheet.subjects.find((s) => s.id === 'su2');
    check('a subject with no papers configured for this exam has an empty papers list', Array.isArray(su2Subject.papers) && su2Subject.papers.length === 0);
    check('a student\'s paperScores has no entry for a non-papers subject', !('su2' in (janeRow.paperScores || {})));
  }

  // ---- Round 5 §2: Learning Area Papers % is rounded to a whole number ------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    sb._tables.subject_papers.push(
      { id: 'p1', exam_id: exam.id, class_id: 'c1', subject_id: 'su1', name: 'Paper 1', paper_no: 1, weight: 0.5, out_of: 100 },
      { id: 'p2', exam_id: exam.id, class_id: 'c1', subject_id: 'su1', name: 'Paper 2', paper_no: 2, weight: 0.5, out_of: 100 }
    );
    // 77*0.5 + 78*0.5 = 77.5 -> would have shown as 77.5 before Round 5;
    // now rounds to a whole number (77.5 rounds up to 78) for display.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p1', scores: [{ student_id: 's1', score: '77' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'p2', scores: [{ student_id: 's1', score: '78' }] });
    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    const jane = sheet.students.find((s) => s.student_id === 's1');
    check('subjectPct rounds a decimal (77.5) to the nearest whole number (78)', jane.subjectPct.su1 === 78);
    check('the underlying combined score used for totals/ranking stays precise, unrounded', jane.scores.su1 === 77.5);
  }

  // ---- Learning Area Papers: setup is scoped per-exam, not a permanent subject property ----
  {
    const { sb, results } = freshApis();
    const examA = (await results.saveExam({ name: 'Opener', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    const examB = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    // su1 (Mathematics) uses papers in examA only; examB reverts to a single combined score.
    sb._tables.subject_papers.push(
      { id: 'pa1', exam_id: examA.id, class_id: 'c1', subject_id: 'su1', name: 'Paper 1', paper_no: 1, weight: 0.5, out_of: 100 },
      { id: 'pa2', exam_id: examA.id, class_id: 'c1', subject_id: 'su1', name: 'Paper 2', paper_no: 2, weight: 0.5, out_of: 100 }
    );
    await results.saveResultsEntry({ exam_id: examA.id, class_id: 'c1', subject_id: 'su1', paper_id: 'pa1', scores: [{ student_id: 's1', score: '80' }] });
    await results.saveResultsEntry({ exam_id: examA.id, class_id: 'c1', subject_id: 'su1', paper_id: 'pa2', scores: [{ student_id: 's1', score: '60' }] });
    await results.saveResultsEntry({ exam_id: examB.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '55' }] });

    const sheetA = await results.getBroadsheet({ exam_id: examA.id, class_id: 'c1', includeUnpublished: true });
    const sheetB = await results.getBroadsheet({ exam_id: examB.id, class_id: 'c1', includeUnpublished: true });
    check('exam A sees su1 configured with 2 papers', sheetA.subjects.find((s) => s.id === 'su1').papers.length === 2);
    check('exam B (same subject, no papers configured for it) sees su1 with zero papers', sheetB.subjects.find((s) => s.id === 'su1').papers.length === 0);
    check('exam A combines the papers into 70', sheetA.students.find((s) => s.student_id === 's1').scores.su1 === 70);
    check('exam B just uses the single plain score of 55, unaffected by exam A\'s paper setup', sheetB.students.find((s) => s.student_id === 's1').scores.su1 === 55);
  }

  // ---- Subject Combination (Round 2 §3): getBroadsheet folds 2+ subjects into one ----
  {
    const { sb, results } = freshApis({
      subjects: [{ id: 'su1', name: 'Mathematics' }, { id: 'su2', name: 'Social Studies' }, { id: 'su3', name: 'CRE' }],
      subject_class_assignments: [
        { id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su2', class_id: 'c1' }, { id: 'sca3', subject_id: 'su3', class_id: 'c1' }
      ]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    sb._tables.subject_combinations.push({ id: 'combo1', exam_id: exam.id, name: 'SST/CRE Combined' });
    sb._tables.subject_combination_members.push(
      { id: 'm1', combination_id: 'combo1', subject_id: 'su2', weight: 0.6 },
      { id: 'm2', combination_id: 'combo1', subject_id: 'su3', weight: 0.4 }
    );
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '80' }, { student_id: 's2', score: '50' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '70' }, { student_id: 's2', score: '84' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su3', scores: [{ student_id: 's1', score: '50' }, { student_id: 's2', score: '73' }] });

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    check('getBroadsheet folds the 2 combined subjects into ONE entry in `subjects`', sheet.subjects.length === 2 && sheet.subjects.some((s) => s.id === 'su1') && sheet.subjects.some((s) => s.id === 'combo:combo1'));
    check('the individual member subjects (su2, su3) no longer appear separately', !sheet.subjects.some((s) => s.id === 'su2' || s.id === 'su3'));
    const jane = sheet.students.find((s) => s.student_id === 's1');
    // 70*0.6 + 50*0.4 = 42 + 20 = 62
    check('the combined score is the weighted sum of its members (70*0.6 + 50*0.4 = 62)', jane.scores['combo:combo1'] === 62);
    check('the combo shows the school-chosen name', sheet.subjects.find((s) => s.id === 'combo:combo1').name === 'SST/CRE Combined');
    check('subject_count (SBJ) treats the combo as ONE subject, not two (Math + combo = 2, not 3)', jane.subject_count === 2);
    check('the student\'s total is Math + the combined score (80 + 62 = 142), not Math + 2 raw subjects', jane.total === 142);

    // ---- Sprint Review bug fix: a combo score landing on a fraction must
    // still get a Performance Level, not fall through a gap between two
    // integer grade bands (this school's bands: C 0-49, B 50-79, A 80-100
    // — nothing covers e.g. 79.6) ----
    const amos = sheet.students.find((s) => s.student_id === 's2');
    // 84*0.6 + 73*0.4 = 50.4 + 29.2 = 79.6 — used to have NO grade_label at
    // all (79.6 is in neither the B 50-79 nor the A 80-100 band); grading
    // off the rounded whole number (80) now correctly lands it in A.
    check('a fractional combo score (79.6) is still graded, not left blank', amos.scores['combo:combo1'] === 79.6);
    check('...graded off its rounded whole number (79.6 -> 80 -> A), closing the gap between integer bands', amos.grades['combo:combo1'].grade_label === 'A');

    // ---- independence: a combo must NOT activate if a member is unpublished (default view) ----
    await results.saveExam({ id: exam.id, name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] });
    await results.submitForApproval(exam.id, 'c1', 'su1');
    await results.approveSubmission(exam.id, 'c1', 'su1');
    await results.publishSubmission(exam.id, 'c1', 'su1');
    // su2/su3 stay in draft — the combo needs BOTH members published to activate.
    const publishedOnly = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    check('a combo with an unpublished member does not activate — only the fully-published subject shows', publishedOnly.subjects.length === 1 && publishedOnly.subjects[0].id === 'su1');

    // ---- deleting the combination reverts to two separate columns ----
    sb._tables.subject_combination_members.length = 0;
    sb._tables.subject_combinations.length = 0;
    const afterDelete = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    check('deleting the combination reverts to 3 separate subject columns', afterDelete.subjects.length === 3);
  }

  // ---- Round 2 §5 correction: Learning Area Papers is scoped per CLASS, not school-wide ----
  {
    const { sb, results } = freshApis({
      classes: [{ id: 'c1', name: 'Grade 1' }, { id: 'c8', name: 'Grade 8' }],
      streams: [{ id: 'str1', class_id: 'c1', name: 'North' }, { id: 'str8', class_id: 'c8', name: 'North' }],
      students: [
        { id: 's1', admission_no: '1', full_name: 'Grade1 Kid', gender: 'Female', class_id: 'c1', stream_id: 'str1', status: 'active' },
        { id: 's2', admission_no: '2', full_name: 'Grade8 Kid', gender: 'Male', class_id: 'c8', stream_id: 'str8', status: 'active' }
      ],
      subject_class_assignments: [{ id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su1', class_id: 'c8' }]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1', 'c8'] })).data;
    // Grade 8 gets 2 papers for English (su1); Grade 1 stays single-mark —
    // same subject, same exam, deliberately different setups per class.
    sb._tables.subject_papers.push(
      { id: 'g8p1', exam_id: exam.id, class_id: 'c8', subject_id: 'su1', name: 'Paper 1', paper_no: 1, weight: 0.5, out_of: 100 },
      { id: 'g8p2', exam_id: exam.id, class_id: 'c8', subject_id: 'su1', name: 'Paper 2', paper_no: 2, weight: 0.5, out_of: 100 }
    );
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c8', subject_id: 'su1', paper_id: 'g8p1', scores: [{ student_id: 's2', score: '80' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c8', subject_id: 'su1', paper_id: 'g8p2', scores: [{ student_id: 's2', score: '60' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '55' }] });

    const sheetG1 = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    const sheetG8 = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c8', includeUnpublished: true });
    check('Grade 1\'s Mark List sees su1 as single-mark (zero papers), even though Grade 8 has 2 for the SAME exam/subject', sheetG1.subjects.find((s) => s.id === 'su1').papers.length === 0);
    check('Grade 8\'s Mark List sees su1 configured with its own 2 papers', sheetG8.subjects.find((s) => s.id === 'su1').papers.length === 2);
    check('Grade 1\'s score is the plain 55 entered for it, not affected by Grade 8\'s paper setup', sheetG1.students.find((s) => s.student_id === 's1').scores.su1 === 55);
    check('Grade 8 combines its own papers into 70', sheetG8.students.find((s) => s.student_id === 's2').scores.su1 === 70);

    // Defense in depth: a paper_id that belongs to a DIFFERENT class must be
    // rejected, not silently accepted with the wrong out_of.
    const wrongClass = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', paper_id: 'g8p1' });
    check('a paper_id from a different class is rejected, not silently applied', wrongClass.ok === false);
  }

  // ---- listExamSubjects (Learning Area Papers setup screen's subject list) --------
  {
    const { sb, results } = freshApis({
      subjects: [{ id: 'su1', name: 'Mathematics' }, { id: 'su2', name: 'English' }, { id: 'su3', name: 'Not assigned to any class' }],
      subject_class_assignments: [{ id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su2', class_id: 'c1' }]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    const listed = await results.listExamSubjects(exam.id);
    check('listExamSubjects succeeds', listed.ok === true);
    check('listExamSubjects only returns subjects actually assigned to a class sitting this exam', listed.data.length === 2 && listed.data.every((s) => s.id !== 'su3'));
    check('listExamSubjects sorts alphabetically', listed.data[0].name === 'English' && listed.data[1].name === 'Mathematics');

    const missing = await results.listExamSubjects('');
    check('listExamSubjects requires an exam', missing.ok === false);

    const { results: results2 } = freshApis({ classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }] });
    const examNoClass = (await results2.saveExam({ name: 'Unassigned', academic_year_id: 'y1', term_id: 't1', class_ids: ['c2'] })).data;
    // c2 has no subject_class_assignments seeded in this fresh instance -> zero subjects, not an error.
    const none = await results2.listExamSubjects(examNoClass.id);
    check('listExamSubjects returns an empty list (not an error) for an exam whose class has no assigned subjects', none.ok === true && none.data.length === 0);
  }

  // ---- listExamClassNames (Learning Area Papers screen's "which classes?" picker) ---
  {
    const { results } = freshApis({ classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1', 'c2'] })).data;
    const listed = await results.listExamClassNames(exam.id);
    check('listExamClassNames succeeds', listed.ok === true);
    check('listExamClassNames returns every class actually assigned to this exam, sorted', listed.data.length === 2 && listed.data[0].name === 'Grade 7' && listed.data[1].name === 'Grade 8');

    const missing = await results.listExamClassNames('');
    check('listExamClassNames requires an exam', missing.ok === false);

    const { results: results2 } = freshApis({ classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }] });
    const examOneClass = (await results2.saveExam({ name: 'Opener', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    const oneListed = await results2.listExamClassNames(examOneClass.id);
    check('listExamClassNames only returns classes actually chosen for this exam, not every class in the school', oneListed.data.length === 1 && oneListed.data[0].id === 'c1');
  }

  // ---- broadsheet ranking with ties -----------------------------------------------
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    // Jane: 90 total. Amos: 70. Tie A & Tie B: both 60 (tie for 3rd).
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [
      { student_id: 's1', score: '90' }, { student_id: 's2', score: '70' }, { student_id: 's3', score: '60' }, { student_id: 's4', score: '60' }
    ] });

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    check('getBroadsheet succeeds', sheet.ok === true);
    check('getBroadsheet includes the subjects assigned to the class', sheet.subjects.length === 2);
    check('getBroadsheet reports each subject\'s (default draft) submission status', sheet.subjects.every((s) => s.submission_status === 'draft'));
    const byId = {}; sheet.students.forEach((s) => { byId[s.student_id] = s; });
    check('getBroadsheet ranks the top scorer #1', byId.s1.position === 1);
    check('getBroadsheet ranks second place #2', byId.s2.position === 2);
    check('tied students share the same rank (both #3)', byId.s3.position === 3 && byId.s4.position === 3);
    check('rows are sorted by total descending', sheet.students[0].student_id === 's1');

    // ---- Zeraki-style Mark List additions: per-subject grade/points, totals, PL, stream position, deviation ----
    check('getBroadsheet grades each subject score against the default scale', byId.s1.grades.su1.grade_label === 'A' && byId.s1.grades.su1.points === 12);
    check('getBroadsheet leaves grade/points blank for a subject with no score', byId.s1.grades.su2.grade_label === '' && byId.s1.grades.su2.points === null);
    check('getBroadsheet computes total/mean points from graded subjects only', byId.s1.total_points === 12 && byId.s1.mean_points === 12);
    check('getBroadsheet grades the overall average as the performance level (PL)', byId.s1.overall_grade === 'A' && byId.s2.overall_grade === 'B');
    check('getBroadsheet computes a stream position alongside the class-wide one (all 4 share one stream, so they match)',
      byId.s1.stream_position === byId.s1.position && byId.s3.stream_position === byId.s3.position && byId.s4.stream_position === byId.s4.position);
    check('getBroadsheet computes each student\'s deviation from the class average', typeof byId.s1.deviation === 'number' && byId.s1.deviation > 0 && byId.s2.deviation < byId.s1.deviation);
  }

  // ---- broadsheet: stream position is scoped per-stream, not just a copy of the class-wide rank ----
  {
    const { sb, results } = freshApis({
      streams: [{ id: 'str1', class_id: 'c1', name: 'North' }, { id: 'str2', class_id: 'c1', name: 'South' }],
      students: [
        { id: 's1', admission_no: '1', full_name: 'North Best', gender: 'Female', class_id: 'c1', stream_id: 'str1', status: 'active' },
        { id: 's2', admission_no: '2', full_name: 'North Worst', gender: 'Male', class_id: 'c1', stream_id: 'str1', status: 'active' },
        { id: 's3', admission_no: '3', full_name: 'South Only', gender: 'Male', class_id: 'c1', stream_id: 'str2', status: 'active' }
      ]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    // Class-wide order: South Only (95) > North Best (85) > North Worst (40).
    // Within North alone, North Best is #1 even though they're #2 class-wide.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [
      { student_id: 's1', score: '85' }, { student_id: 's2', score: '40' }, { student_id: 's3', score: '95' }
    ] });
    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    const byId = {}; sheet.students.forEach((s) => { byId[s.student_id] = s; });
    check('class-wide position ranks South Only first', byId.s3.position === 1);
    check('North Best is #2 class-wide but #1 within their own stream', byId.s1.position === 2 && byId.s1.stream_position === 1);
    check('North Worst is #3 class-wide and #2 within their own stream', byId.s2.position === 3 && byId.s2.stream_position === 2);
    check('South Only is #1 in both scopes (only student in their stream)', byId.s3.position === 1 && byId.s3.stream_position === 1);
  }

  // ---- broadsheet honours min-subjects-for-ranking --------------------------------
  {
    const { sb, results } = freshApis({ settings: [{ id: 'set1', key: 'min_subjects_for_ranking', value: '2' }] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    // Jane has both subjects; Amos only one -> Amos should be excluded from ranking.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '80' }, { student_id: 's2', score: '90' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '70' }] });

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    const byId = {}; sheet.students.forEach((s) => { byId[s.student_id] = s; });
    check('a student below min_subjects_for_ranking gets no position', byId.s2.position === '');
    check('a student meeting min_subjects_for_ranking is still ranked', byId.s1.position === 1);
    // Round 2 §10: below-minimum students now also get an automatic "X"
    // overall grade (not just an excluded position) — a student meeting the
    // minimum keeps their real computed grade.
    check('a student below min_subjects_for_ranking gets an automatic X overall grade', byId.s2.overall_grade === 'X' && byId.s2.below_minimum === true);
    check('a student meeting min_subjects_for_ranking keeps a real computed grade, not X', byId.s1.overall_grade !== 'X' && byId.s1.overall_grade !== '' && byId.s1.below_minimum === false);
  }

  // ---- getBroadsheet (Mark List) only shows PUBLISHED subjects (feature brief §5) ----
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '85' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '70' }] });

    const beforePublish = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    check('with nothing published yet, the Mark List shows no subjects at all', beforePublish.subjects.length === 0);

    await results.submitForApproval(exam.id, 'c1', 'su1');
    await results.approveSubmission(exam.id, 'c1', 'su1');
    const stillDraft = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    check('a subject that is submitted/approved but not yet published still does not appear', stillDraft.subjects.length === 0);

    await results.publishSubmission(exam.id, 'c1', 'su1');
    const afterPublish = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    check('once published, exactly that one subject appears', afterPublish.subjects.length === 1 && afterPublish.subjects[0].id === 'su1');
    check('the still-draft subject (su2) is omitted entirely, not shown with a draft badge', afterPublish.subjects.every((s) => s.id !== 'su2'));
    const jane = afterPublish.students.find((s) => s.student_id === 's1');
    check('a published subject\'s score is still included in the student\'s row', jane.scores.su1 === 85);
    check('an omitted (unpublished) subject\'s score key is not present on the student row', !('su2' in jane.scores));

    const unfiltered = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    check('includeUnpublished:true opts back into seeing every assigned subject regardless of status', unfiltered.subjects.length === 2);
  }

  // ---- Round 3 §12: getBroadsheet says "No exams found" for a class that was
  // never actually selected to sit this exam, instead of quietly generating
  // an empty, marks-less Mark List/Report Form. ----
  {
    const { results } = freshApis({ classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }] });
    // c2 deliberately left out of class_ids, exactly like the c3 case above.
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;

    const wrongClass = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c2' });
    check('a class never selected for this exam gets a clear error, not an empty report', wrongClass.ok === false && /no exams found/i.test(wrongClass.message));

    const rightClass = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    check('the actually-selected class still works normally', rightClass.ok === true);
  }

  // ---- Next Sprint 2 §9 (BUG): a student who joined the class AFTER an exam
  // was created should not auto-appear on that exam's Mark List (graded 'X'
  // for never having sat it) unless a mark was actually, deliberately
  // entered for them. Existing students (created at-or-before the exam)
  // keep showing exactly as before this fix. ------------------------------
  {
    const { results } = freshApis({
      students: [
        ...BASE_TABLES.students,
        // Joined well after the exam below will be created (mock default
        // created_at for anything saveExam() inserts is the epoch, 1970 —
        // see mockSupabase.mjs's insert() — so "now" is comfortably later).
        { id: 's5', admission_no: '11', full_name: 'Late Joiner', gender: 'Male', class_id: 'c1', stream_id: 'str1', status: 'active', created_at: new Date().toISOString() }
      ]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '85' }] });

    const sheet = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    check('a student who joined after the exam was created, with no marks, is left off the Mark List', !sheet.students.some((s) => s.student_id === 's5'));
    check('a student who already existed when the exam was created still appears', sheet.students.some((s) => s.student_id === 's1'));

    // Now deliberately enter a mark for the late joiner — they should
    // appear from that point on, exactly as if they'd been added on time.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's5', score: '60' }] });
    const sheet2 = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1', includeUnpublished: true });
    check('once a mark is deliberately entered for a late joiner, they appear on the Mark List', sheet2.students.some((s) => s.student_id === 's5'));
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
    // c1 has TWO assigned subjects (su1, su2 — see BASE_TABLES); only su1 got
    // marks/was published, but su2 must still show up (brief §7.3: a subject
    // with zero marks yet is a visible gap, not silently absent).
    check('listSubmissions includes every assigned subject, not just ones with marks', list.ok === true && list.data.length === 2);
    check('listSubmissions reports the published subject\'s status correctly', list.data.find((r) => r.subject_id === 'su1').status === 'published');
    check('listSubmissions reports an assigned-but-untouched subject as draft with zero entered', list.data.find((r) => r.subject_id === 'su2').status === 'draft' && list.data.find((r) => r.subject_id === 'su2').entered_count === 0);

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

  // ---- publishExam: Round 3 §8 "no grading scale, no publish" gate ----------------
  {
    // No grading_scales table at all (no default scale exists for this
    // school) -- publishing must be rejected outright, even with marks entered.
    const { results } = freshApis({ grading_scales: [] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    const blocked = await results.publishExam(exam.id, 'c1');
    check('publishExam refuses to publish with no active grading scale', blocked.ok === false);
    check('publishExam explains a grading scale is needed', /grading scale/i.test(blocked.message));

    const list = await results.listSubmissions(exam.id, 'c1');
    check('nothing got published while blocked', list.data.every((r) => r.status !== 'published'));
  }
  {
    // A scale exists but none is marked default (Round 3 §8's "do not
    // auto-set a grading scale" — present-but-inactive) -- still blocked.
    const { results } = freshApis({ grading_scales: [{ id: 'gs1', name: 'CBC Competency Scale', is_default: false }] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    const blocked = await results.publishExam(exam.id, 'c1');
    check('publishExam refuses to publish when a scale exists but is not active', blocked.ok === false);
  }
  {
    // A per-(exam,class) grading scale override (Step 10 / Publish Settings)
    // counts as "having a scale" even with no school-wide default.
    const { results } = freshApis({ grading_scales: [] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    const setRes = await results.savePublishSettings(exam.id, 'c1', { grading_scale_id: 'some-scale-id' });
    check('savePublishSettings accepts a grading_scale_id override even with no school-wide scale', setRes.ok === true);
    const allowed = await results.publishExam(exam.id, 'c1');
    check('publishExam allows publishing when this exam+class has its own grading scale override', allowed.ok === true);
  }

  // ---- publishExam: Round 2 §10 minimum-subjects publish gate ---------------------
  {
    // School-wide fallback (no per-class override): 2 subjects assigned,
    // minimum set to 2 — publishing with only 1 subject's marks in is
    // blocked, and unblocks once the 2nd subject gets marks too.
    const { sb, results } = freshApis({ settings: [{ id: 'set1', key: 'min_subjects_for_ranking', value: '2' }] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });

    const tooFew = await results.publishExam(exam.id, 'c1');
    check('publishExam blocks when fewer than min_subjects have any marks uploaded', tooFew.ok === false);
    check('publishExam explains how many subjects are still needed', /2 subject/.test(tooFew.message) && /only 1/.test(tooFew.message));
    const stillDraft = await results.listSubmissions(exam.id, 'c1');
    check('publishExam did not publish anything while blocked', stillDraft.data.every((r) => r.status !== 'published'));

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '60' }] });
    const nowOk = await results.publishExam(exam.id, 'c1');
    check('publishExam succeeds once min_subjects worth of subjects have marks', nowOk.ok === true && nowOk.published === 2);
  }
  {
    // Per-class override (exam_classes.min_subjects) takes precedence over
    // the school-wide setting here too, same as getBroadsheet already does.
    const { sb, results } = freshApis({ settings: [{ id: 'set1', key: 'min_subjects_for_ranking', value: '1' }] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    await results.savePublishSettings(exam.id, 'c1', { min_subjects: 2 });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });

    const blocked = await results.publishExam(exam.id, 'c1');
    check('publishExam honors a per-class min_subjects override over the lower school-wide setting', blocked.ok === false);
  }
  {
    // min_subjects left at 0/unset (the default) never gates anything —
    // exactly today's behaviour for every class that's never touched this.
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    const res = await results.publishExam(exam.id, 'c1');
    check('publishExam is ungated when min_subjects is unset', res.ok === true);
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

  // ---- listExamClasses (the Manage Exams board's data source, Phase 2h) -----------
  {
    const { sb, results } = freshApis({
      classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }, { id: 'c3', name: 'Grade 9' }],
      students: [
        { id: 's1', admission_no: '1', full_name: 'A', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's5', admission_no: '5', full_name: 'E', gender: 'Male', class_id: 'c2', status: 'active' }
      ],
      subject_class_assignments: [
        { id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su2', class_id: 'c1' },
        { id: 'sca3', subject_id: 'su1', class_id: 'c2' }
      ],
      staff: [{ id: 'stf1', full_name: 'Mrs Publisher' }]
    });
    // Brief §7.1: which classes sit an exam is now an explicit choice at
    // creation time (c3 is deliberately left OUT — it should never appear).
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1', 'c2'] })).data;

    const none = await results.listExamClasses(exam.id);
    check('listExamClasses shows every SELECTED class up front, even with zero marks yet', none.ok === true && none.data.length === 2);
    check('a selected class with zero marks is not_started, not just absent', none.data.every((r) => r.status === 'not_started'));
    check('an un-selected class never appears', !none.data.some((r) => r.class_id === 'c3'));

    // c1 has 2 assigned subjects; only 1 (su1) gets marks -> in progress.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    // c2 has 1 assigned subject (su1); it gets marks -> fully entered, not yet published.
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c2', subject_id: 'su1', scores: [{ student_id: 's5', score: '50' }] });

    const inProgress = await results.listExamClasses(exam.id);
    check('listExamClasses still includes both selected classes', inProgress.data.length === 2);
    const c1Row = inProgress.data.find((r) => r.class_id === 'c1');
    const c2Row = inProgress.data.find((r) => r.class_id === 'c2');
    check('a class missing marks for some assigned subjects is in_progress', c1Row.status === 'in_progress');
    check('a class with marks for every assigned subject (not yet published) is ready_to_publish', c2Row.status === 'ready_to_publish');

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '60' }] });
    await results.publishExam(exam.id, 'c1');
    await results.publishExam(exam.id, 'c2');
    // published_by/published_at are stamped by a DB trigger in real Postgres
    // (check_result_submission_transition(), migration 0005) — the mock
    // doesn't replicate triggers, so simulate its effect directly here to
    // test listExamClasses' own aggregation logic (find the latest
    // published_at per class, resolve published_by to a staff name).
    sb._tables.result_submissions.filter((r) => r.status === 'published').forEach((r) => {
      r.published_by = 'stf1'; r.published_at = '2026-01-01T00:00:00.000Z';
    });
    const done = await results.listExamClasses(exam.id);
    check('a fully-published class shows status published', done.data.every((r) => r.status === 'published'));
    check('a published class reports who last published', done.data.every((r) => r.last_published_by === 'Mrs Publisher'));
    check('a published class reports when it was last published', done.data.every((r) => !!r.last_published_at));

    // Removing a class that already has marks is a no-op, not silent data loss.
    const resaved = await results.saveExam({ id: exam.id, name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: [] });
    check('saveExam keeps a class that already has recorded marks even if unticked', resaved.ok === true);
    const stillThere = await results.listExamClasses(exam.id);
    check('a class with marks is never silently dropped from the board', stillThere.data.length === 2);
  }

  // ---- Round 3 §9 regression: a class published with FEWER subjects than are
  // currently assigned must still show 'published', never fall back to
  // 'in_progress'/"Marks incomplete" — publishExam() only ever publishes the
  // subjects that actually have marks (the min-subjects gate deliberately
  // allows that), so requiring every assigned subject to be published before
  // showing 'published' left a genuinely-published class stuck amber forever
  // (the brief's own reported example: 8/9 subjects, permanently "incomplete"). ----
  {
    const { sb, results } = freshApis({
      classes: [{ id: 'c1', name: 'Grade 8' }],
      students: [{ id: 's1', admission_no: '1', full_name: 'A', gender: 'Male', class_id: 'c1', status: 'active' }],
      // 3 subjects assigned; only 2 will ever get marks/be published — the
      // 3rd (su3) never gets a single mark, mirroring a subject nobody
      // teaches this term or simply hasn't started yet.
      subject_class_assignments: [
        { id: 'sca1', subject_id: 'su1', class_id: 'c1' },
        { id: 'sca2', subject_id: 'su2', class_id: 'c1' },
        { id: 'sca3', subject_id: 'su3', class_id: 'c1' }
      ]
    });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: '50' }] });
    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2', scores: [{ student_id: 's1', score: '60' }] });
    const pub = await results.publishExam(exam.id, 'c1');
    check('publishExam succeeds with only 2 of 3 assigned subjects having marks', pub.ok === true && pub.published === 2);

    const afterPublish = await results.listExamClasses(exam.id);
    const row = afterPublish.data.find((r) => r.class_id === 'c1');
    check('a class published with fewer subjects than assigned still shows published, not in_progress', row.status === 'published');
    check('subjects_published/subjects_total are still reported honestly for the UI (2 of 3)', row.subjects_published === 2 && row.subjects_total === 3);

    // A new subject assigned to the class AFTER publishing must not flip a
    // published class back to "incomplete" either — it stays published
    // until the admin explicitly withdraws/republishes.
    sb._tables.subject_class_assignments.push({ id: 'sca4', subject_id: 'su4', class_id: 'c1' });
    const afterNewSubject = await results.listExamClasses(exam.id);
    const row2 = afterNewSubject.data.find((r) => r.class_id === 'c1');
    check('a newly-assigned subject after publishing does not revert a published class to in_progress', row2.status === 'published');
  }

  // ---- listExamClasses shows a class with ZERO enrolled students honestly, doesn't hide it (System Fixes brief §7) ----
  {
    const { sb, results } = freshApis({
      classes: [{ id: 'c1', name: 'Grade 8' }, { id: 'c2', name: 'Grade 9' }, { id: 'c3', name: 'PP1' }],
      students: [{ id: 's1', admission_no: '1', full_name: 'A', gender: 'Male', class_id: 'c1', status: 'active' }],
      subject_class_assignments: [{ id: 'sca1', subject_id: 'su1', class_id: 'c1' }, { id: 'sca2', subject_id: 'su1', class_id: 'c2' }, { id: 'sca3', subject_id: 'su1', class_id: 'c3' }]
    });
    // Grade 9 and PP1 have zero enrolled students. An earlier version of
    // this fix hid such classes from the board entirely, which is exactly
    // what the System Fixes brief's §7 bug report describes ("all 3 classes
    // were ticked... but after creation only Grade 8 was actually saved —
    // the other two classes were dropped") even though saveExam genuinely
    // saved all three. The real fix: show every selected class, with a
    // distinct 'no_students' status for ones that have nothing to enter.
    const exam = (await results.saveExam({ name: 'Opener Exams', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1', 'c2', 'c3'] })).data;

    const rows = await results.listExamClasses(exam.id);
    check('every selected class is saved and shown, not just the one with students', rows.data.length === 3);
    check('the zero-student classes get an honest no_students status, not "pending"', rows.data.filter((r) => r.class_id === 'c2' || r.class_id === 'c3').every((r) => r.status === 'no_students'));
    check('the class with students gets its normal status, unaffected', rows.data.find((r) => r.class_id === 'c1').status !== 'no_students');

    // Enroll a student into Grade 9 after the fact — its status should
    // flip away from no_students automatically, without touching the exam.
    sb._tables.students.push({ id: 's9', admission_no: '9', full_name: 'New Kid', gender: 'Male', class_id: 'c2', status: 'active' });
    const afterEnroll = await results.listExamClasses(exam.id);
    check('a class that gains a student is no longer no_students', afterEnroll.data.find((r) => r.class_id === 'c2').status !== 'no_students');
    check('the still-empty class (PP1) stays no_students, but stays visible', afterEnroll.data.find((r) => r.class_id === 'c3').status === 'no_students');
  }

  // ---- listExamClassChoices (Phase 2h) ---------------------------------------------
  {
    const { results } = freshApis({ classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }] });
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;
    const choices = await results.listExamClassChoices(exam.id);
    check('listExamClassChoices excludes classes already added to the exam', choices.data.length === 1 && choices.data[0].id === 'c2');
  }

  // ---- setMaxMarks / getResultsEntry max_marks_set (Zeraki brief Step 5) ----------
  {
    const { results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', class_ids: ['c1'] })).data;

    check('setMaxMarks requires exam/class/subject', (await results.setMaxMarks(null, 'c1', 'su1', 50)).ok === false);
    check('setMaxMarks rejects a non-positive value', (await results.setMaxMarks(exam.id, 'c1', 'su1', -5)).ok === false);
    check('setMaxMarks rejects a non-numeric value', (await results.setMaxMarks(exam.id, 'c1', 'su1', 'abc')).ok === false);

    const before = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1' });
    check('getResultsEntry reports max_marks_set=false before Maximum Marks is ever set', before.max_marks_set === false && before.out_of === 100);

    const set = await results.setMaxMarks(exam.id, 'c1', 'su1', 50);
    check('setMaxMarks succeeds with a positive value', set.ok === true);

    const after = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1' });
    check('getResultsEntry picks up the new Maximum Marks', after.out_of === 50);
    check('getResultsEntry reports max_marks_set=true once confirmed', after.max_marks_set === true);

    const other = await results.getResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su2' });
    check('setMaxMarks is scoped to the one subject, not the whole exam', other.max_marks_set === false && other.out_of === 100);

    const updated = await results.setMaxMarks(exam.id, 'c1', 'su1', 40);
    check('setMaxMarks updates an already-set value rather than erroring', updated.ok === true && updated.data.max_marks === 40);
  }

  // ---- savePublishSettings + getBroadsheet ranking/min-subjects (Step 10) --------
  {
    const { results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;

    check('savePublishSettings fails for a class not on the exam', (await results.savePublishSettings(exam.id, 'no-such-class', { min_subjects: 2 })).ok === false);

    const saved = await results.savePublishSettings(exam.id, 'c1', { ranking_criteria: 'mean_points', min_subjects: 1 });
    check('savePublishSettings succeeds for a class actually on the exam', saved.ok === true);

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: 80 }, { student_id: 's2', score: 60 }] });
    await results.publishExam(exam.id, 'c1');

    const bs = await results.getBroadsheet({ exam_id: exam.id, class_id: 'c1' });
    check('getBroadsheet reflects the saved ranking_criteria', bs.ranking_criteria === 'mean_points');
    check('getBroadsheet reflects the saved min_subjects', bs.min_subjects === 1);
    check('getBroadsheet has no deviation_exam when none was configured', bs.deviation_exam === null);

    // A class that never went through Publish Settings behaves exactly as
    // before: default ranking, and min_subjects falls back to the school
    // setting (0 here, since none was seeded).
    const exam2 = (await results.saveExam({ name: 'Opener', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    const bs2 = await results.getBroadsheet({ exam_id: exam2.id, class_id: 'c1' });
    check('getBroadsheet defaults ranking_criteria to mean_marks when unset', bs2.ranking_criteria === 'mean_marks');
    check('getBroadsheet defaults min_subjects to 0 when unset and no school setting exists', bs2.min_subjects === 0);
  }

  // ---- listDeviationExamChoices + Deviation Exam comparison (Step 10) ------------
  {
    const { results } = freshApis();
    const exam1 = (await results.saveExam({ name: 'Term 1 Exam', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;
    const exam2 = (await results.saveExam({ name: 'Term 2 Exam', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;

    check('listDeviationExamChoices is empty before any OTHER exam has published results', (await results.listDeviationExamChoices(exam2.id, 'c1')).data.length === 0);

    await results.saveResultsEntry({ exam_id: exam1.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: 90 }, { student_id: 's2', score: 70 }] });
    await results.publishExam(exam1.id, 'c1');

    const choices = await results.listDeviationExamChoices(exam2.id, 'c1');
    check('listDeviationExamChoices includes a different, published-for-this-class exam', choices.data.length === 1 && choices.data[0].id === exam1.id);
    check('listDeviationExamChoices excludes the exam being configured itself', (await results.listDeviationExamChoices(exam1.id, 'c1')).data.every((e) => e.id !== exam1.id));

    await results.savePublishSettings(exam2.id, 'c1', { deviation_exam_id: exam1.id });
    await results.saveResultsEntry({ exam_id: exam2.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: 60 }, { student_id: 's2', score: 60 }] });
    await results.publishExam(exam2.id, 'c1');

    const bs = await results.getBroadsheet({ exam_id: exam2.id, class_id: 'c1' });
    check('getBroadsheet resolves the configured Deviation Exam', bs.deviation_exam !== null && bs.deviation_exam.exam_id === exam1.id);
    check('getBroadsheet\'s deviation_exam carries the comparison exam\'s name', bs.deviation_exam.exam_name === 'Term 1 Exam');
  }

  // ---- withdrawExam / markReleased (Step 13: Withdraw Results / Send Results) ----
  {
    const { results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1', out_of: 100, class_ids: ['c1'] })).data;

    check('withdrawExam fails when nothing has been published yet', (await results.withdrawExam(exam.id, 'c1')).ok === false);

    await results.saveResultsEntry({ exam_id: exam.id, class_id: 'c1', subject_id: 'su1', scores: [{ student_id: 's1', score: 80 }] });
    await results.publishExam(exam.id, 'c1');
    const released = await results.markReleased(exam.id, 'c1', 'stf1');
    check('markReleased succeeds once a subject is published', released.ok === true && !!released.data.released_at);

    const withdrawn = await results.withdrawExam(exam.id, 'c1');
    check('withdrawExam reopens every published subject back to draft', withdrawn.ok === true && withdrawn.reopened === 1);

    const status = await results.getSubmissionStatus(exam.id, 'c1', 'su1');
    check('a withdrawn subject is back to draft', status.data.status === 'draft');

    const ec = await results.listExamClasses(exam.id);
    check('withdrawExam clears the released_at stamp', ec.data.find((r) => r.class_id === 'c1').released_at === null);
  }

  // ---- Deleted Exams: soft-delete, restore, 30-day auto-purge (System Fixes brief §8) ----
  {
    const { sb, results } = freshApis();
    const exam = (await results.saveExam({ name: 'Midterm', academic_year_id: 'y1', term_id: 't1' })).data;

    const before = await results.listExams();
    check('a fresh exam appears in the normal exam list', before.data.some((e) => e.id === exam.id));

    const del = await results.softDeleteExam(exam.id);
    check('softDeleteExam succeeds and stamps deleted_at', del.ok === true && !!del.data.deleted_at);

    const afterDelete = await results.listExams();
    check('a soft-deleted exam disappears from the normal exam list', !afterDelete.data.some((e) => e.id === exam.id));

    const deletedList = await results.listDeletedExams();
    check('a soft-deleted exam appears in Deleted Exams', deletedList.data.some((e) => e.id === exam.id));
    const row = deletedList.data.find((e) => e.id === exam.id);
    check('a freshly-deleted exam reports ~30 days remaining', row.days_remaining >= 29 && row.days_remaining <= 30);

    const restored = await results.restoreExam(exam.id);
    check('restoreExam clears deleted_at', restored.ok === true && restored.data.deleted_at === null);
    const afterRestore = await results.listExams();
    check('a restored exam reappears in the normal exam list', afterRestore.data.some((e) => e.id === exam.id));
    const deletedAfterRestore = await results.listDeletedExams();
    check('a restored exam no longer appears in Deleted Exams', !deletedAfterRestore.data.some((e) => e.id === exam.id));

    // Simulate an exam that's been sitting deleted for 31 days — past the
    // window — and confirm it's actually gone from the database, not just
    // hidden, the moment anything touches listDeletedExams/purge.
    await results.softDeleteExam(exam.id);
    const old = sb._tables.exams.find((e) => e.id === exam.id);
    old.deleted_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const purge = await results.purgeExpiredDeletedExams();
    check('purgeExpiredDeletedExams reports the purged count', purge.ok === true && purge.purged === 1);
    check('an expired deleted exam is actually gone from the table, not just hidden', !sb._tables.exams.some((e) => e.id === exam.id));
    const deletedAfterPurge = await results.listDeletedExams();
    check('a purged exam no longer appears anywhere', !deletedAfterPurge.data.some((e) => e.id === exam.id));

    // A deleted exam still within its window is NOT purged by the sweep.
    const exam2 = (await results.saveExam({ name: 'Recent Delete', academic_year_id: 'y1', term_id: 't1' })).data;
    await results.softDeleteExam(exam2.id);
    await results.purgeExpiredDeletedExams();
    check('a recently-deleted exam survives the purge sweep', sb._tables.exams.some((e) => e.id === exam2.id));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
