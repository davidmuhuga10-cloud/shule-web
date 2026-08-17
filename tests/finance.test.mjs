import { numberToWords, amountInWords } from '../src/lib/finance/amountInWords.mjs';
import { buildStatement } from '../src/lib/finance/statement.mjs';
import { buildBalancesAoa, buildVoteHeadCollectionsAoa, buildCashbookAoa, buildTrialBalanceAoa } from '../src/lib/finance/financeXlsx.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  // --- amountInWords ---
  check('numberToWords(0) is Zero', numberToWords(0) === 'Zero');
  check('numberToWords handles a plain number', numberToWords(12) === 'Twelve');
  check('numberToWords handles tens+ones with a hyphen', numberToWords(45) === 'Forty-Five');
  check('numberToWords handles hundreds', numberToWords(340) === 'Three Hundred Forty');
  check('numberToWords handles thousands', numberToWords(12450) === 'Twelve Thousand And Four Hundred Fifty');
  check('numberToWords handles an exact thousand with no remainder', numberToWords(2000) === 'Two Thousand');
  check('numberToWords rounds to the nearest whole shilling', numberToWords(99.6) === 'One Hundred');
  check('numberToWords treats a negative amount as its absolute value', numberToWords(-500) === 'Five Hundred');
  check('amountInWords appends the currency word and "Only"', amountInWords(2000) === 'Two Thousand Shillings Only');
  check('amountInWords accepts a custom currency word', amountInWords(100, 'Dollars') === 'One Hundred Dollars Only');

  // --- statement.buildStatement ---
  const opening = { amount: 500, created_at: '2026-01-01' };
  const invoiceItems = [{ created_at: '2026-01-05', amount: 4000, finance_vote_heads: { name: 'Tuition' } }];
  const debitNotes = [{ created_at: '2026-01-10', amount: 200, reason: 'Lost book', finance_vote_heads: { name: 'Books' } }];
  const creditNotes = [{ created_at: '2026-01-12', amount: 300, reason: 'Sibling discount', finance_vote_heads: { name: 'Tuition' } }];
  const collections = [
    { created_at: '2026-01-15', amount: 3000, mode: 'cash', receipt_no: 'RCT-000001', status: 'active' },
    { created_at: '2026-01-20', amount: 1000, mode: 'cash', receipt_no: 'RCT-000002', status: 'reversed' }
  ];
  const rows = buildStatement({ openingBalance: opening, invoiceItems, debitNotes, creditNotes, collections });
  check('buildStatement includes the opening balance row', rows[0].kind === 'opening_balance' && rows[0].debit === 500);
  check('buildStatement excludes a reversed collection entirely', !rows.some((r) => r.receipt_no === 'RCT-000002'));
  check('buildStatement orders rows chronologically', rows.every((r, i) => i === 0 || new Date(r.date) >= new Date(rows[i - 1].date)));
  check('buildStatement computes a running balance (500 + 4000 + 200 - 300 - 3000 = 1400)', rows[rows.length - 1].balance === 1400);
  check('buildStatement treats a debit note as a debit', rows.find((r) => r.kind === 'debit_note').debit === 200);
  check('buildStatement treats a credit note as a credit', rows.find((r) => r.kind === 'credit_note').credit === 300);
  check('buildStatement treats an active collection as a credit', rows.find((r) => r.kind === 'collection').credit === 3000);

  const noOpeningRows = buildStatement({ openingBalance: null, invoiceItems: [], debitNotes: [], creditNotes: [], collections: [] });
  check('buildStatement returns an empty list when there is nothing to show', noOpeningRows.length === 0);

  const zeroOpeningRows = buildStatement({ openingBalance: { amount: 0 }, invoiceItems: [], debitNotes: [], creditNotes: [], collections: [] });
  check('buildStatement omits a zero opening balance row', zeroOpeningRows.length === 0);

  const creditOpeningRows = buildStatement({ openingBalance: { amount: -150 }, invoiceItems: [], debitNotes: [], creditNotes: [], collections: [] });
  check('buildStatement treats a negative opening balance as a credit', creditOpeningRows[0].credit === 150 && creditOpeningRows[0].debit === 0);

  // --- financeXlsx AOA builders ---
  const settings = { school_name: 'Green Hills Academy' };
  const balancesAoa = buildBalancesAoa({ settings, title: 'Balances', rows: [{ admission_no: 'A1', full_name: 'Amos Otieno', class_name: 'Form 2', stream_name: 'East', expected: 5000, paid: 3000, credit_note: 0, balance: 2000 }] });
  check('buildBalancesAoa leads with the school name', balancesAoa[0][0] === 'Green Hills Academy');
  check('buildBalancesAoa has the expected header row', balancesAoa[3].join(',') === ['Adm. No.', 'Name', 'Class', 'Arm', 'Expected', 'Paid', 'Credit Note', 'Balance'].join(','));
  check('buildBalancesAoa carries the balance figure through as a number', balancesAoa[4][7] === 2000);

  const vhAoa = buildVoteHeadCollectionsAoa({ settings, rows: [{ vote_head_name: 'Tuition', collected: 12000 }] });
  check('buildVoteHeadCollectionsAoa has one data row per vote head', vhAoa[4][0] === 'Tuition' && vhAoa[4][1] === 12000);

  const cashbookAoa = buildCashbookAoa({ settings, from: '2026-01-01', to: '2026-01-31', rows: [{ collection_date: '2026-01-05', receipt_no: 'RCT-000001', student_name: 'Amos Otieno', admission_no: 'A1', mode: 'cash', amount: 3000 }] });
  check('buildCashbookAoa totals the amount column at the bottom', cashbookAoa[cashbookAoa.length - 1][5] === 3000);

  const trialAoa = buildTrialBalanceAoa({ settings, rows: [{ vote_head_name: 'Tuition', invoiced: 5000, collected: 3000 }] });
  check('buildTrialBalanceAoa totals both Dr and Cr columns', trialAoa[trialAoa.length - 1][1] === 5000 && trialAoa[trialAoa.length - 1][2] === 3000);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
