import { toCsv } from '../src/lib/csvExport.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  const cols = [{ key: 'admission_no', label: 'Admission No.' }, { key: 'full_name', label: 'Name' }];
  const csv = toCsv([{ admission_no: '12', full_name: 'Amos Otieno' }, { admission_no: '13', full_name: 'Jane, Wanjiru' }], cols);
  const lines = csv.split('\n');
  check('toCsv writes the header row from column labels', lines[0] === 'Admission No.,Name');
  check('toCsv writes a plain row unquoted', lines[1] === '12,Amos Otieno');
  check('toCsv quotes a value containing a comma', lines[2] === '13,"Jane, Wanjiru"');

  const withQuotesAndNewlines = toCsv([{ admission_no: '1', full_name: 'Say "hi"\nnext line' }], cols);
  check('toCsv escapes embedded quotes by doubling them and wraps in quotes', withQuotesAndNewlines.indexOf('"Say ""hi""\nnext line"') !== -1);

  check('toCsv handles null/undefined as an empty cell', toCsv([{ admission_no: null, full_name: undefined }], cols).split('\n')[1] === ',');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
