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
  check('buildBroadsheetAoa trailing row reports the class average', bsAoa[bsAoa.length - 1][0] === 'Class average:' && bsAoa[bsAoa.length - 1][1] === 65.4);

  const bsAoaNoContact = buildBroadsheetAoa({ settings: { school_name: 'No Contact School' }, exam, cls: null, streamName: '', subjects: [], students: [], class_average: 0 });
  check('buildBroadsheetAoa omits the contact row when no contact fields are set', bsAoaNoContact[1][0] === 'Term 2 Mid-Term — Mark List — ');
  check('buildBroadsheetAoa handles a null class gracefully', bsAoaNoContact[1][0].includes('Mark List —'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
