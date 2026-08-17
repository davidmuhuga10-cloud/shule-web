/**
 * statement.mjs — pure builder for a student's printable running-balance
 * Statement (brief §Student Search & Statement: "a printable running
 * statement of invoices and payments, with a balance"). Takes the raw rows
 * the finance API layer already fetches (invoice items, debit/credit
 * notes, collections, opening balance) and produces one flat,
 * chronologically-ordered, running-balance list — kept separate from the
 * view/DOM layer so it's directly unit-testable, same split as
 * broadsheetSummary.mjs.
 *
 * A charge (invoice item, debit note) is a DEBIT (increases what's owed);
 * a payment (an active collection) or a credit note is a CREDIT (reduces
 * it). A reversed/transferred collection is excluded entirely — it never
 * happened as far as the student's own balance is concerned (brief: a
 * reversal "restores" the balance, so it shouldn't leave a footprint that
 * still needs a second corresponding entry to cancel out).
 */
export function buildStatement({ openingBalance, invoiceItems, debitNotes, creditNotes, collections }) {
  const rows = [];

  if (openingBalance && Number(openingBalance.amount)) {
    rows.push({
      date: openingBalance.created_at || null, description: 'Balance Brought Forward',
      debit: Number(openingBalance.amount) > 0 ? Number(openingBalance.amount) : 0,
      credit: Number(openingBalance.amount) < 0 ? -Number(openingBalance.amount) : 0,
      kind: 'opening_balance'
    });
  }

  (invoiceItems || []).forEach((it) => {
    const voteHeadName = (it.finance_vote_heads && it.finance_vote_heads.name) || it.vote_head_name || 'Fee';
    rows.push({
      date: it.created_at, description: it.description ? `${voteHeadName} — ${it.description}` : voteHeadName,
      debit: Number(it.amount) || 0, credit: 0, kind: 'invoice_item'
    });
  });

  (debitNotes || []).forEach((dn) => {
    const voteHeadName = (dn.finance_vote_heads && dn.finance_vote_heads.name) || dn.vote_head_name || 'Adjustment';
    rows.push({
      date: dn.created_at, description: `Debit Note — ${voteHeadName}${dn.reason ? ' (' + dn.reason + ')' : ''}`,
      debit: Number(dn.amount) || 0, credit: 0, kind: 'debit_note'
    });
  });

  (creditNotes || []).forEach((cn) => {
    const voteHeadName = (cn.finance_vote_heads && cn.finance_vote_heads.name) || cn.vote_head_name || 'Adjustment';
    rows.push({
      date: cn.created_at, description: `Credit Note — ${voteHeadName}${cn.reason ? ' (' + cn.reason + ')' : ''}`,
      debit: 0, credit: Number(cn.amount) || 0, kind: 'credit_note'
    });
  });

  (collections || []).forEach((c) => {
    if (c.status !== 'active') return;
    rows.push({
      date: c.created_at, description: `Payment Received — Receipt ${c.receipt_no} (${modeLabel(c.mode)})`,
      debit: 0, credit: Number(c.amount) || 0, kind: 'collection', receipt_no: c.receipt_no
    });
  });

  rows.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

  let running = 0;
  return rows.map((r) => {
    running += r.debit - r.credit;
    return { ...r, balance: running };
  });
}

function modeLabel(mode) {
  return { cash: 'Cash', paybill: 'Paybill', bank: 'Bank', other: 'Other' }[mode] || mode || '';
}
