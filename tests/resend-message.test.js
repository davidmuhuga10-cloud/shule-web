/**
 * Unit tests for netlify/functions/resend-message.js (Messaging_Overhaul.docx
 * item 8 — "a resend option for anything that failed" in the SMS History
 * batch detail view). Uses the same generic mock Supabase admin pattern as
 * send-message.test.js.
 */
const { resendMessages } = require('../netlify/functions/resend-message.js');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

const SCHOOL_A = 'school-a';

function mockAdmin(opts) {
  opts = opts || {};
  const tables = { message_logs: [], ...opts.tables };

  function builderFor(table) {
    return {
      _filters: [],
      _mode: 'select',
      _patch: null,
      select() { this._mode = 'select'; return this; },
      update(patch) { this._mode = 'update'; this._patch = patch; return this; },
      eq(col, val) { this._filters.push(['eq', col, val]); return this; },
      in(col, vals) { this._filters.push(['in', col, vals || []]); return this; },
      _matches(r) {
        return this._filters.every(([kind, c, v]) =>
          kind === 'in' ? v.map(String).includes(String(r[c])) : String(r[c]) === String(v)
        );
      },
      then(resolve) {
        if (this._mode === 'update') {
          tables[table] = (tables[table] || []).map((r) => (this._matches(r) ? { ...r, ...this._patch } : r));
          resolve({ error: null });
          return;
        }
        const rows = (tables[table] || []).filter((r) => this._matches(r));
        resolve({ data: rows, error: null });
      }
    };
  }

  return { _tables: tables, from(table) { return builderFor(table); } };
}

(async () => {
  {
    const admin = mockAdmin({
      tables: { message_logs: [
        { id: 'm1', batch_id: 'b1', school_id: SCHOOL_A, status: 'failed' },
        { id: 'm2', batch_id: 'b1', school_id: SCHOOL_A, status: 'sent' }
      ] }
    });
    const triggered = [];
    const res = await resendMessages(admin, { ids: ['m1', 'm2'] }, { school_id: SCHOOL_A }, async (batchId) => triggered.push(batchId));
    check('resendMessages succeeds', res.ok === true);
    check('resendMessages only counts the failed row', res.resent === 1);
    check('resendMessages flips the failed row back to queued', admin._tables.message_logs.find((r) => r.id === 'm1').status === 'queued');
    check('resendMessages clears the old failure reason', admin._tables.message_logs.find((r) => r.id === 'm1').provider_response === null);
    check('resendMessages leaves an already-sent row untouched', admin._tables.message_logs.find((r) => r.id === 'm2').status === 'sent');
    check('resendMessages re-triggers delivery for the affected batch', triggered.length === 1 && triggered[0] === 'b1');
  }
  {
    // Two failed rows in the SAME batch should only trigger delivery once.
    const admin = mockAdmin({
      tables: { message_logs: [
        { id: 'm1', batch_id: 'b1', school_id: SCHOOL_A, status: 'failed' },
        { id: 'm2', batch_id: 'b1', school_id: SCHOOL_A, status: 'failed' }
      ] }
    });
    const triggered = [];
    await resendMessages(admin, { ids: ['m1', 'm2'] }, { school_id: SCHOOL_A }, async (batchId) => triggered.push(batchId));
    check('resendMessages de-duplicates the delivery trigger per batch', triggered.length === 1);
  }
  {
    const admin = mockAdmin({ tables: { message_logs: [{ id: 'm1', batch_id: 'b1', school_id: SCHOOL_A, status: 'sent' }] } });
    const res = await resendMessages(admin, { ids: ['m1'] }, { school_id: SCHOOL_A });
    check('resendMessages refuses when nothing selected has actually failed', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await resendMessages(admin, { ids: [] }, { school_id: SCHOOL_A });
    check('resendMessages requires at least one id', res.ok === false);
  }
  {
    // A row belonging to a different school must never be resendable just
    // because its id was guessed/passed in.
    const admin = mockAdmin({ tables: { message_logs: [{ id: 'm1', batch_id: 'b1', school_id: 'school-b', status: 'failed' }] } });
    const res = await resendMessages(admin, { ids: ['m1'] }, { school_id: SCHOOL_A });
    check('resendMessages never resends a row belonging to a different school', res.ok === false);
    check('resendMessages leaves the other school\'s row untouched', admin._tables.message_logs[0].status === 'failed');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
