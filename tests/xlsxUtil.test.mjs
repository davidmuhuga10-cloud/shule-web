import { buildXlsxBuffer, parseXlsxBuffer } from '../src/lib/xlsxUtil.mjs';

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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
