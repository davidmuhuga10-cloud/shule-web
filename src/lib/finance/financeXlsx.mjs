/**
 * financeXlsx.mjs — pure AOA builders for the Finance module's "Download
 * Excel" buttons (brief scenario #7: "export the current balances to
 * Excel"; §Reports more generally). Same split as broadsheetXlsx.mjs/
 * examAnalysisXlsx.mjs — kept dependency-free so it's directly testable,
 * the view layer just calls downloadXlsxAOA with whatever this returns.
 */
export function buildBalancesAoa({ settings, rows, title }) {
  settings = settings || {};
  const aoa = [];
  aoa.push([settings.school_name || 'School']);
  aoa.push([title || 'Balances']);
  aoa.push([]);
  aoa.push(['Adm. No.', 'Name', 'Class', 'Arm', 'Expected', 'Paid', 'Credit Note', 'Balance']);
  (rows || []).forEach((r) => {
    aoa.push([r.admission_no, r.full_name, r.class_name || '', r.stream_name || '',
      Number(r.expected || 0), Number(r.paid || 0), Number(r.credit_note || 0), Number(r.balance || 0)]);
  });
  return aoa;
}

export function buildVoteHeadCollectionsAoa({ settings, rows, title }) {
  settings = settings || {};
  const aoa = [];
  aoa.push([settings.school_name || 'School']);
  aoa.push([title || 'Collections Per Vote Head']);
  aoa.push([]);
  aoa.push(['Vote Head', 'Collected']);
  (rows || []).forEach((r) => aoa.push([r.vote_head_name, Number(r.collected || 0)]));
  return aoa;
}

export function buildCashbookAoa({ settings, rows, from, to }) {
  settings = settings || {};
  const aoa = [];
  aoa.push([settings.school_name || 'School']);
  aoa.push([`Cashbook — ${from} to ${to}`]);
  aoa.push([]);
  aoa.push(['Date', 'Receipt No', 'Student', 'Adm. No.', 'Mode', 'Amount']);
  let total = 0;
  (rows || []).forEach((r) => {
    aoa.push([r.collection_date, r.receipt_no, r.student_name, r.admission_no, r.mode, Number(r.amount || 0)]);
    total += Number(r.amount || 0);
  });
  aoa.push([]);
  aoa.push(['', '', '', '', 'Total', total]);
  return aoa;
}

export function buildTrialBalanceAoa({ settings, rows }) {
  settings = settings || {};
  const aoa = [];
  aoa.push([settings.school_name || 'School']);
  aoa.push(['Trial Balance']);
  aoa.push([]);
  aoa.push(['Vote Head', 'Invoiced (Dr)', 'Collected (Cr)']);
  let dr = 0, cr = 0;
  (rows || []).forEach((r) => {
    aoa.push([r.vote_head_name, Number(r.invoiced || 0), Number(r.collected || 0)]);
    dr += Number(r.invoiced || 0); cr += Number(r.collected || 0);
  });
  aoa.push([]);
  aoa.push(['Total', dr, cr]);
  return aoa;
}
