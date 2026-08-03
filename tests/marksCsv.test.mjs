import { buildMarkColumns, buildMarksTemplateCsv, parseMarksCsv, matchAndValidate, scoresByColumn } from '../src/lib/marksCsv.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  const subjects = [{ id: 'sub1', name: 'Mathematics' }, { id: 'sub2', name: 'English' }];
  const papersBySubjectId = { sub1: [{ id: 'p1', name: 'Paper 1' }, { id: 'p2', name: 'Paper 2' }] };

  // ---- buildMarkColumns ---------------------------------------------------------
  const columns = buildMarkColumns(subjects, papersBySubjectId);
  check('a subject with papers gets one column per paper', columns.filter((c) => c.subject_id === 'sub1').length === 2);
  check('a subject without papers gets exactly one column', columns.filter((c) => c.subject_id === 'sub2').length === 1);
  check('paper columns carry their paper_id', columns.find((c) => c.key === 's:sub1:p:p1').paper_id === 'p1');
  check('single-paper columns have a null paper_id', columns.find((c) => c.subject_id === 'sub2').paper_id === null);
  columns.forEach((c) => { c.out_of = 100; });

  // ---- template round-trip --------------------------------------------------------
  const students = [
    { student_id: 'st1', admission_no: '1', full_name: 'Amos' },
    { student_id: 'st2', admission_no: '2', full_name: 'Jane' }
  ];
  const existingScores = { st1: { 's:sub2': 88 } };
  const csv = buildMarksTemplateCsv(students, columns, existingScores);
  check('template has a header row plus one row per student', csv.trim().split('\n').length === 3);
  check('template header lists every column', csv.split('\n')[0].indexOf('English') !== -1 && csv.split('\n')[0].indexOf('Paper 1') !== -1);
  check('template prefills an existing score', csv.indexOf('88') !== -1);

  const parsed = parseMarksCsv(csv, columns);
  check('parseMarksCsv strips the header row', parsed.length === 2);
  check('parseMarksCsv recovers the prefilled score', parsed.find((r) => r.admission_no === '1').scores['s:sub2'] === '88');
  check('parseMarksCsv recovers a blank cell as empty string', parsed.find((r) => r.admission_no === '2').scores['s:sub2'] === '');

  // ---- parse a fresh (no header) upload with new marks entered -------------------
  const uploadedText = '1,Amos,70,75,88\n2,Jane,60,65,200\n3,Ghost Student,50,55,50\n';
  const uploadedRows = parseMarksCsv(uploadedText, columns);
  check('parseMarksCsv works fine without a header row too', uploadedRows.length === 3);

  // ---- matchAndValidate -----------------------------------------------------------
  const { matched, unmatched } = matchAndValidate(uploadedRows, students, columns);
  check('matches rows to the class roster by admission number', matched.length === 2);
  check('reports a row with no matching student as unmatched', unmatched.length === 1 && unmatched[0].admission_no === '3');
  const janeRow = matched.find((r) => r.admission_no === '2');
  check('flags an out-of-range score', !!janeRow.cellErrors['s:sub2']);
  const amosRow = matched.find((r) => r.admission_no === '1');
  check('does not flag an in-range score', !amosRow.cellErrors['s:sub1:p:p1']);

  // ---- scoresByColumn ---------------------------------------------------------------
  const byColumn = scoresByColumn(matched, columns);
  check('groups valid scores under the right column', byColumn['s:sub1:p:p1'].length === 2);
  check('excludes a cell that failed validation from its column', byColumn['s:sub2'].length === 1 && byColumn['s:sub2'][0].student_id === 'st1');
  check('a fully-excluded row still leaves other columns untouched', byColumn['s:sub1:p:p2'].length === 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
