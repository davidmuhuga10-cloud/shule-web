/**
 * statement.mjs — pure builder for a student's printable Statement (brief
 * §Student Search & Statement: "a printable running statement of invoices
 * and payments, with a balance"). Takes the raw rows the finance API layer
 * already fetches (invoice items, debit/credit notes, collections, opening
 * balance) and produces one flat, chronologically-ordered, running-balance
 * list — kept separate from the view/DOM layer so it's directly
 * unit-testable, same split as broadsheetSummary.mjs.
 *
 * A charge (invoice item, debit note) is a DEBIT (increases what's owed);
 * a payment (an active collection) or a credit note is a CREDIT (reduces
 * it). A reversed/transferred collection is excluded entirely — it never
 * happened as far as the student's own balance is concerned (brief: a
 * reversal "restores" the balance, so it shouldn't leave a footprint that
 * still needs a second corresponding entry to cancel out).
 *
 * Next Sprint §Finance "Redesign the Student Statement": the flat list
 * above is still exactly what buildStatement() returns (unchanged contract
 * — existing callers/tests keep working), but every row now also carries
 * `academic_year_id`/`term_id` (read straight off the source record, which
 * already has both — finance_invoices, finance_debit_notes,
 * finance_credit_notes and finance_collections all do; see schema.sql).
 * groupByTerm() below is the new layer that buckets those tagged rows into
 * one box per term — Date | Receipt No | Description | Bal BF | Budget |
 * Paid | Balance, per the reference statement in the brief — each box
 * ending with its own "Student Balance at the close of: <TERM>" line
 * before the next term's box begins.
 */
export function buildStatement({ openingBalance, invoiceItems, debitNotes, creditNotes, collections }) {
  const rows = [];

  // openingBalance is usually one record (the active year's), but a
  // multi-year statement (see groupByTerm() below) needs one per year it
  // covers — accept either shape without changing the single-record
  // contract existing callers/tests already rely on.
  const openingBalances = Array.isArray(openingBalance) ? openingBalance : (openingBalance ? [openingBalance] : []);
  openingBalances.forEach((ob) => {
    if (!ob || !Number(ob.amount)) return;
    rows.push({
      date: ob.created_at || null, description: 'Balance Brought Forward',
      debit: Number(ob.amount) > 0 ? Number(ob.amount) : 0,
      credit: Number(ob.amount) < 0 ? -Number(ob.amount) : 0,
      academic_year_id: ob.academic_year_id || null, term_id: null,
      kind: 'opening_balance'
    });
  });

  (invoiceItems || []).forEach((it) => {
    const voteHeadName = (it.finance_vote_heads && it.finance_vote_heads.name) || it.vote_head_name || 'Fee';
    rows.push({
      date: it.created_at, description: it.description ? `${voteHeadName} — ${it.description}` : voteHeadName,
      debit: Number(it.amount) || 0, credit: 0,
      academic_year_id: it.academic_year_id || null, term_id: it.term_id || null,
      kind: 'invoice_item'
    });
  });

  (debitNotes || []).forEach((dn) => {
    const voteHeadName = (dn.finance_vote_heads && dn.finance_vote_heads.name) || dn.vote_head_name || 'Adjustment';
    rows.push({
      date: dn.created_at, description: `Debit Note — ${voteHeadName}${dn.reason ? ' (' + dn.reason + ')' : ''}`,
      debit: Number(dn.amount) || 0, credit: 0,
      academic_year_id: dn.academic_year_id || null, term_id: dn.term_id || null,
      kind: 'debit_note'
    });
  });

  (creditNotes || []).forEach((cn) => {
    const voteHeadName = (cn.finance_vote_heads && cn.finance_vote_heads.name) || cn.vote_head_name || 'Adjustment';
    rows.push({
      date: cn.created_at, description: `Credit Note — ${voteHeadName}${cn.reason ? ' (' + cn.reason + ')' : ''}`,
      debit: 0, credit: Number(cn.amount) || 0,
      academic_year_id: cn.academic_year_id || null, term_id: cn.term_id || null,
      kind: 'credit_note'
    });
  });

  (collections || []).forEach((c) => {
    if (c.status !== 'active') return;
    rows.push({
      date: c.created_at, description: `Payment Received (${modeLabel(c.mode)})`,
      debit: 0, credit: Number(c.amount) || 0,
      academic_year_id: c.academic_year_id || null, term_id: c.term_id || null,
      kind: 'collection', receipt_no: c.receipt_no
    });
  });

  rows.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

  let running = 0;
  return rows.map((r) => {
    const balBf = running;
    running += r.debit - r.credit;
    return { ...r, balBf, balance: running };
  });
}

/**
 * groupByTerm() — takes the flat, running-balance rows buildStatement()
 * produces (each already tagged with academic_year_id/term_id) and buckets
 * them into one box per term, in chronological order, each ending with a
 * "Student Balance at the close of: <TERM>" row. `terms`/`academicYears`
 * are the plain lists the view already loads (Db.terms.list() /
 * Db.academicYears.list()) — used only to order the terms and build each
 * box's "TERM:YYYY/N" label; the running balance itself is untouched, it's
 * exactly what buildStatement() already computed per row.
 *
 * A term with no rows of its own is skipped — an empty box with nothing in
 * it but a repeated closing balance would just be noise. The one exception
 * is a school's very first term ever (see below): if the year-level
 * opening-balance row didn't land in any term because none has started yet
 * chronologically, it's still surfaced as a lone leading "Uncategorised"
 * box rather than silently dropped, since it represents real money the
 * student owes/is owed.
 */
export function groupByTerm(rows, { terms = [], academicYears = [] } = {}) {
  const yearById = new Map((academicYears || []).map((y) => [y.id, y]));
  const sortedTerms = [...(terms || [])].sort((a, b) => {
    const ad = a.start_date || a.created_at || 0, bd = b.start_date || b.created_at || 0;
    return new Date(ad) - new Date(bd);
  });

  // The year-level opening balance (term_id null, only academic_year_id
  // set) doesn't belong to any one term by itself — it lands in whichever
  // term of that year comes chronologically first, so it reads as the
  // first line of that year's first box rather than a floating orphan.
  const firstTermOfYear = new Map();
  sortedTerms.forEach((t) => {
    if (!firstTermOfYear.has(t.academic_year_id)) firstTermOfYear.set(t.academic_year_id, t.id);
  });

  const byTerm = new Map();
  const uncategorised = [];
  (rows || []).forEach((r) => {
    let termId = r.term_id;
    if (!termId && r.academic_year_id && firstTermOfYear.has(r.academic_year_id)) {
      termId = firstTermOfYear.get(r.academic_year_id);
    }
    if (termId && sortedTerms.some((t) => t.id === termId)) {
      if (!byTerm.has(termId)) byTerm.set(termId, []);
      byTerm.get(termId).push(r);
    } else {
      uncategorised.push(r);
    }
  });

  const groups = [];
  if (uncategorised.length) {
    groups.push(makeGroup('Prior / Uncategorised', null, null, uncategorised));
  }
  sortedTerms.forEach((term) => {
    const termRows = byTerm.get(term.id);
    if (!termRows || !termRows.length) return;
    const year = yearById.get(term.academic_year_id);
    const num = (String(term.name || '').match(/\d+/) || [])[0] || term.name || '';
    const label = year ? `TERM:${year.name}/${num}` : (term.name || 'Term');
    groups.push(makeGroup(label, term.academic_year_id || null, term.id, termRows));
  });
  return groups;

  function makeGroup(label, academicYearId, termId, termRows) {
    const closingBalance = termRows[termRows.length - 1].balance;
    return { label, academicYearId, termId, rows: termRows, closingBalance };
  }
}

function modeLabel(mode) {
  return { cash: 'Cash', paybill: 'Paybill', bank: 'Bank', other: 'Other' }[mode] || mode || '';
}
