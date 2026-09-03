/**
 * Unit tests for netlify/functions/sms-credit-notify.js against a bespoke
 * mock Supabase admin client. No sms_platform_config row is seeded in these
 * tests, so isConfigured() sees an empty config — these tests check the
 * "log every attempt, never actually send, never fail the request"
 * behaviour that unconfigured state requires, plus that a school can never
 * notify on another school's request.
 */
const { notifyAdmin } = require('../netlify/functions/sms-credit-notify.js');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function mockAdmin(opts) {
  opts = opts || {};
  const tables = { sms_credit_requests: [], admin_audit_log: [], ...opts.tables };

  function builderFor(table) {
    return {
      _filters: [],
      select() { return this; },
      eq(col, val) { this._filters.push([col, val]); return this; },
      async maybeSingle() {
        const rows = (tables[table] || []).filter((r) => this._filters.every(([c, v]) => String(r[c]) === String(v)));
        return { data: rows[0] || null, error: null };
      },
      async insert(row) { tables[table] = tables[table] || []; tables[table].push(row); return { error: null }; }
    };
  }

  return { _tables: tables, from(table) { return builderFor(table); } };
}

const REQ = { id: 'req-1', school_id: 'school-1', requested_credits: 500, schools: { name: 'Green Hill Academy' } };

(async () => {
  {
    const admin = mockAdmin({ tables: { sms_credit_requests: [REQ] } });
    const res = await notifyAdmin(admin, { request_id: 'req-1' }, { school_id: 'school-1' });
    check('notifyAdmin succeeds even with no provider configured', res.ok === true);
    check('notifyAdmin reports not actually delivered when no provider is configured', res.delivered === false);
    check('notifyAdmin still says what would have been sent, without a real send', typeof res.message === 'string' && res.message.indexOf('0705041512') !== -1);
  }

  {
    const admin = mockAdmin({ tables: { sms_credit_requests: [REQ] } });
    await notifyAdmin(admin, { request_id: 'req-1' }, { school_id: 'school-1' });
    const logged = admin._tables.admin_audit_log[0];
    check('notifyAdmin logs the attempt to the audit trail', logged && logged.action === 'sms_credit_request_notification');
    check('the logged attempt names the requesting school', logged && logged.details.message.indexOf('Green Hill Academy') !== -1);
  }

  {
    // "should tell me the school name and amount" — when the school also
    // recorded how much they paid, the text to 0705041512 includes it too,
    // not just the credit count.
    const REQ_WITH_AMOUNT = { ...REQ, id: 'req-2', amount_paid: 1000 };
    const admin = mockAdmin({ tables: { sms_credit_requests: [REQ_WITH_AMOUNT] } });
    await notifyAdmin(admin, { request_id: 'req-2' }, { school_id: 'school-1' });
    const logged = admin._tables.admin_audit_log[0];
    check('the notification includes the amount paid when the school recorded one', logged && logged.details.message.indexOf('KES 1000') !== -1);
  }

  {
    // A different school's staff token must never be able to trigger a
    // notification for a request that isn't theirs (defence in depth on
    // top of RLS, same shape as send-message.js's per-school scoping).
    const admin = mockAdmin({ tables: { sms_credit_requests: [REQ] } });
    const res = await notifyAdmin(admin, { request_id: 'req-1' }, { school_id: 'a-different-school' });
    check('notifyAdmin refuses a request that does not belong to the caller\'s school', res.ok === false);
  }

  {
    const admin = mockAdmin();
    const res = await notifyAdmin(admin, {}, { school_id: 'school-1' });
    check('notifyAdmin requires a request_id', res.ok === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
