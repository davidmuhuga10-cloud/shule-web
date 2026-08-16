import { buildXlsxBuffer, parseXlsxBuffer, buildXlsxBufferAOA } from '../src/lib/xlsxUtil.mjs';
import { buildBroadsheetAoa } from '../src/lib/broadsheetXlsx.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  const cols = [{ key: 'admission_no', label: 'Admission No.' }, { key: 'full_name', label: 'Name' }, { key: 'gender', label: 'Gender' }];
  const rows = [
    { admission_no: '12', full_name: 'Amos Otieno', gender: 'Male' },
    { admission_no: '13', full_name: 'Jane, Wanjiru', gender: '' },
    { admission_no: '14', full_name: null, gender: undefined }
  ];

  const buf = buildXlsxBuffer(rows, cols, 'Students');
  check('buildXlsxBuffer returns a non-empty byte array', buf && buf.byteLength > 0);

  const parsed = parseXlsxBuffer(buf);
  check('parseXlsxBuffer round-trips the header row', parsed[0][0] === 'Admission No.' && parsed[0][1] === 'Name' && parsed[0][2] === 'Gender');
  check('parseXlsxBuffer round-trips a plain row', parsed[1][0] === '12' && parsed[1][1] === 'Amos Otieno' && parsed[1][2] === 'Male');
  check('parseXlsxBuffer preserves a comma inside a cell (no CSV-style escaping needed)', parsed[2][1] === 'Jane, Wanjiru');
  check('parseXlsxBuffer coerces a null/undefined cell to an empty string', parsed[3][1] === '' && parsed[3][2] === '');

  check('parseXlsxBuffer returns [] for an empty workbook (no sheets)', Array.isArray(parseXlsxBuffer(buildXlsxBuffer([], [], 'Empty'))) );

  // --- buildXlsxBufferAOA: raw array-of-arrays export (mark list, etc.) ---
  const aoaBuf = buildXlsxBufferAOA([['School Name'], ['Row 2'], [], ['A', 'B', 'C'], [1, 2, 3]], 'Sheet');
  check('buildXlsxBufferAOA returns a non-empty byte array', aoaBuf && aoaBuf.byteLength > 0);
  const aoaParsed = parseXlsxBuffer(aoaBuf);
  check('buildXlsxBufferAOA round-trips the first row as-is', aoaParsed[0][0] === 'School Name');
  check('buildXlsxBufferAOA preserves a blank row', aoaParsed[2].length === 0 || aoaParsed[2].every((c) => c === ''));
  check('buildXlsxBufferAOA round-trips a later data row', aoaParsed[4][0] === '1' && aoaParsed[4][1] === '2' && aoaParsed[4][2] === '3');

  // --- buildBroadsheetAoa: Mark List export layout (school details on top) ---
  const settings = { school_name: 'Green Hills Academy', po_box: '123', phone: '0700-000000', email: 'info@greenhills.ac.ke' };
  const exam = { name: 'Term 2 Mid-Term' };
  const cls = { name: 'Form 2' };
  const subjects = [{ id: 'sub-1', code: 'MAT' }, { id: 'sub-2', code: 'ENG' }];
  const students = [
    {
      admission_no: '101', full_name: 'Amos Otieno', stream_name: 'East',
      scores: { 'sub-1': 78, 'sub-2': null }, grades: { 'sub-1': { grade_label: 'A-' }, 'sub-2': null },
      subject_count: 1, total: 78, average: 78, overall_grade: 'A-',
      total_points: 10, mean_points: 10, deviation: 2.5, stream_position: 1, position: 3
    }
  ];
  const bsAoa = buildBroadsheetAoa({ settings, exam, cls, streamName: 'East', subjects, students, class_average: 65.4 });
  check('buildBroadsheetAoa puts the school name on row 1', bsAoa[0][0] === 'Green Hills Academy');
  check('buildBroadsheetAoa puts contact details on row 2', bsAoa[1][0].includes('123') && bsAoa[1][0].includes('0700-000000') && bsAoa[1][0].includes('info@greenhills.ac.ke'));
  check('buildBroadsheetAoa puts the exam/class/stream title on row 3', bsAoa[2][0] === 'Term 2 Mid-Term — Mark List — Form 2 (East)');
  check('buildBroadsheetAoa leaves row 4 blank as a spacer', bsAoa[3].length === 0);
  check('buildBroadsheetAoa row 5 is the table header with subject codes', bsAoa[4][0] === 'Adm. No.' && bsAoa[4].includes('MAT') && bsAoa[4].includes('ENG'));
  const studentRow = bsAoa[5];
  check('buildBroadsheetAoa student row starts with admission no, name, stream', studentRow[0] === '101' && studentRow[1] === 'Amos Otieno' && studentRow[2] === 'East');
  check('buildBroadsheetAoa combines score + grade into one cell', studentRow.includes('78 (A-)'));
  check('buildBroadsheetAoa shows an em-dash for a missing score', studentRow.includes('—'));
  // Sprint Review correction: Class average is a "Mean Marks" figure — an
  // exception to the whole-number rounding rule — so it keeps 2dp (65.4).
  check('buildBroadsheetAoa trailing row reports the class average to 2dp', bsAoa[bsAoa.length - 1][0] === 'Class average:' && bsAoa[bsAoa.length - 1][1] === 65.4);

  const bsAoaNoContact = buildBroadsheetAoa({ settings: { school_name: 'No Contact School' }, exam, cls: null, streamName: '', subjects: [], students: [], class_average: 0 });
  check('buildBroadsheetAoa omits the contact row when no contact fields are set', bsAoaNoContact[1][0] === 'Term 2 Mid-Term — Mark List — ');
  check('buildBroadsheetAoa handles a null class gracefully', bsAoaNoContact[1][0].includes('Mark List —'));

  // --- Round 5 §2: TOTAL/AVERAGE rows + combined-subject/Learning Area
  // Papers % rounded to whole numbers on the Excel export too ---
  {
    const comboSubjects = [
      { id: 'sub-1', code: 'MAT' },
      { id: 'combo:c1', name: 'SST/CRE Combined', is_combination: true },
      { id: 'sub-lap', code: 'ENG', papers: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }] }
    ];
    const multiStudents = [
      {
        admission_no: '101', full_name: 'Amos Otieno', stream_name: 'East',
        scores: { 'sub-1': 70, 'combo:c1': 61.4, 'sub-lap': 55 },
        grades: { 'sub-1': { grade_label: 'B' }, 'combo:c1': { grade_label: 'B' }, 'sub-lap': { grade_label: 'C+' } },
        paperScores: { 'sub-lap': { p1: 30, p2: 25 } },
        // Already whole numbers here, matching what results.mjs's
        // getBroadsheet() now hands this pure export builder (Round 5 §2
        // rounds subjectPct to a whole number at the source — see
        // results.test.mjs for that rounding itself) — this layer just
        // displays what it's given, same as it already did for `scores`.
        subjectPct: { 'sub-lap': 55 },
        subject_count: 3, total: 186.4, average: 62.13, overall_grade: 'B', total_points: 18, mean_points: 6, deviation: 1, stream_position: 1, position: 1
      },
      {
        admission_no: '102', full_name: 'Beatrice Wanjiru', stream_name: 'East',
        scores: { 'sub-1': 80, 'combo:c1': 68.6, 'sub-lap': 45 },
        grades: { 'sub-1': { grade_label: 'A-' }, 'combo:c1': { grade_label: 'B+' }, 'sub-lap': { grade_label: 'C' } },
        paperScores: { 'sub-lap': { p1: 20, p2: 25 } },
        subjectPct: { 'sub-lap': 45 },
        subject_count: 3, total: 193.6, average: 64.53, overall_grade: 'B+', total_points: 20, mean_points: 6.7, deviation: 3.4, stream_position: 2, position: 2
      }
    ];
    const aoa = buildBroadsheetAoa({ settings, exam, cls, streamName: 'East', subjects: comboSubjects, students: multiStudents, class_average: 63.3 });

    check('a combined subject\'s score is rounded to a whole number on the export (61.4 -> 61)', aoa[5].includes('61 (B)'));
    check('a combined subject\'s OTHER student score is rounded too (68.6 -> 69)', aoa[6].includes('69 (B+)'));
    check('a Learning Area Papers % (already rounded upstream) shows as a whole number on the export', aoa[5].includes('55 (C+)'));
    check('same for the other student', aoa[6].includes('45 (C)'));
    // Row order after the header (index 4): 2 student rows, then TOTAL, then AVERAGE, then a blank spacer, then Class average.
    const totalRow = aoa[7], avgRow = aoa[8];
    check('a TOTAL row is added right after the student rows, labelled in column 2', totalRow[1] === 'TOTAL');
    check('an AVERAGE row follows it, labelled in column 2', avgRow[1] === 'AVERAGE');
    // Sprint Review redo: the TOTAL row shows earned/possible ("sum/2*100",
    // 2 students * the exam's out_of, which defaults to 100 here) — the
    // AVERAGE row is unaffected (an average isn't a "total").
    check('TOTAL sums the plain subject column as earned/possible (70 + 80 = 150 / 200)', totalRow[3] === '150/200');
    check('AVERAGE averages the plain subject column (70 + 80)/2 = 75', avgRow[3] === 75);
    check('TOTAL sums the combined-subject column, rounded, as earned/possible (61.4 + 68.6 = 130 / 200)', totalRow[4] === '130/200');
    check('AVERAGE averages the combined-subject column, rounded ((61.4+68.6)/2 = 65)', avgRow[4] === 65);
    // sub-lap columns: P1, P2, then %.
    check('TOTAL sums a Learning Area Paper\'s own column as earned/possible (30 + 20 = 50 / 200)', totalRow[5] === '50/200');
    check('TOTAL sums the Learning Area Papers % column, rounded, as earned/possible (55.4 + 44.6 = 100 / 200)', totalRow[7] === '100/200');
    check('AVERAGE averages the Learning Area Papers % column, rounded ((55.4+44.6)/2 = 50)', avgRow[7] === 50);
    // Sprint Review correction: class average keeps 2dp (63.3), not rounded.
    check('the blank spacer and Class average row still follow immediately after', aoa[9].length === 0 && aoa[10][0] === 'Class average:' && aoa[10][1] === 63.3);

    // A totally empty class (no students) doesn't blow up — every column dashes out.
    const emptyAoa = buildBroadsheetAoa({ settings, exam, cls, streamName: 'East', subjects: comboSubjects, students: [], class_average: 0 });
    check('TOTAL/AVERAGE rows dash out every column when there are no students', emptyAoa[5].slice(3).every((c) => c === '—') && emptyAoa[6].slice(3).every((c) => c === '—'));

    // --- Sprint Review §8: "Show achievement levels on the Mark List" off — raw marks only, no grade letters ---
    const noLevelsAoa = buildBroadsheetAoa({ settings, exam, cls, streamName: 'East', subjects: comboSubjects, students: multiStudents, class_average: 63.3, showLevels: false });
    const rowNoLevels = noLevelsAoa[5];
    check('showLevels:false drops the grade letter from a combined-subject cell (just "61", no "(B)")', !rowNoLevels.includes('61 (B)') && rowNoLevels.includes('61'));
    check('showLevels:false drops the grade letter from a Learning Area Papers % cell too', !rowNoLevels.includes('55 (C+)') && rowNoLevels.includes('55'));
    check('showLevels:false still shows the PL column as a plain dash, not the grade', rowNoLevels[rowNoLevels.length - 6] === '—');
    // showLevels defaults to true (matches the on-screen default) when the caller omits it and settings has no explicit key either.
    check('buildBroadsheetAoa defaults showLevels to true when omitted', aoa[5].includes('61 (B)'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
