/**
 * Unit tests for netlify/functions/send-message.js against a mock Supabase
 * admin client (no live project needed). Mirrors the mockAdmin() pattern in
 * admin-provision.test.js, extended with the tables send-message.js reads
 * (classes, students, staff, message_logs).
 */
const { requireStaff } = require('../netlify/functions/_lib/supabaseAdmin.js');
const { sendMessage, resolveRecipients } = require('../netlify/functions/send-message.js');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

const SCHOOL_A = 'school-a';
const SCHOOL_B = 'school-b';

function mockAdmin(opts) {
  opts = opts || {};
  const tables = {
    profiles: [], classes: [], students: [], staff: [], message_logs: [],
    ...opts.tables
  };
  const authUsers = opts.authUsers || {};

  function builderFor(table) {
    return {
      _filters: [],
      select() { return this; },
      eq(col, val) { this._filters.push([col, val]); return this; },
      async maybeSingle() {
        const rows = tables[table] || [];
        const hit = rows.find((r) => this._filters.every(([c, v]) => String(r[c]) === String(v)));
        return { data: hit || null, error: null };
      },
      // Non-.maybeSingle() selects (e.g. lists of students) resolve here —
      // `await q.eq(...).eq(...)` needs the chain itself to be awaitable.
      then(resolve) {
        const rows = (tables[table] || []).filter((r) => this._filters.every(([c, v]) => String(r[c]) === String(v)));
        resolve({ data: rows, error: null });
      },
      async insert(rows) {
        if (opts.forceInsertError) return { error: { message: 'forced insert failure' } };
        tables[table] = tables[table] || [];
        tables[table].push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      }
    };
  }

  return {
    _tables: tables,
    from(table) { return builderFor(table); },
    // Stands in for the debit_sms_wallet() RPC (0041_sms_wallet_debit_rpc.sql)
    // send-message.js calls once a provider is configured — a test that
    // wants to exercise "not enough credit" passes opts.forceDebitError.
    async rpc(name, args) {
      if (name !== 'debit_sms_wallet') return { data: null, error: { message: `No mock handler for rpc ${name}` } };
      if (opts.forceDebitError) return { data: null, error: { message: opts.forceDebitError } };
      return { data: 0, error: null };
    },
    auth: {
      async getUser(token) {
        const user = authUsers[token];
        return user ? { data: { user }, error: null } : { data: null, error: { message: 'invalid token' } };
      }
    }
  };
}

(async () => {
  // ---- requireStaff (admin OR teacher) ------------------------------------
  {
    const admin = mockAdmin({
      authUsers: { 'teacher-token': { id: 'teacher-1' } },
      tables: { profiles: [{ id: 'teacher-1', role: 'teacher', status: 'active', school_id: SCHOOL_A, staff_id: 'staff-1' }] }
    });
    const res = await requireStaff({ headers: { authorization: 'Bearer teacher-token' } }, admin);
    check('requireStaff accepts a teacher (not just admin)', res.user.id === 'teacher-1');
  }
  {
    const admin = mockAdmin({
      authUsers: { 'student-token': { id: 'student-1' } },
      tables: { profiles: [{ id: 'student-1', role: 'student', status: 'active', school_id: SCHOOL_A }] }
    });
    let threw = false, code = null;
    try { await requireStaff({ headers: { authorization: 'Bearer student-token' } }, admin); }
    catch (e) { threw = true; code = e.statusCode; }
    check('requireStaff rejects a student (403)', threw && code === 403);
  }

  // ---- resolveRecipients: class scope --------------------------------------
  {
    const admin = mockAdmin({
      tables: {
        classes: [{ id: 'c1', name: 'Grade 7', school_id: SCHOOL_A }, { id: 'c-other', name: 'Grade 7', school_id: SCHOOL_B }],
        students: [
          { id: 's1', full_name: 'Amos', class_id: 'c1', school_id: SCHOOL_A, status: 'active', guardian_contact: '0700000001' },
          { id: 's2', full_name: 'No Phone', class_id: 'c1', school_id: SCHOOL_A, status: 'active', guardian_contact: '' },
          { id: 's3', full_name: 'Other School Kid', class_id: 'c-other', school_id: SCHOOL_B, status: 'active', guardian_contact: '0700000099' }
        ]
      }
    });
    const res = await resolveRecipients(admin, SCHOOL_A, { scope: 'class', class_id: 'c1' });
    check('resolveRecipients(class) only includes guardians with a phone on file', res.recipients.length === 1 && res.recipients[0].student_id === 's1');
    check('resolveRecipients(class) never reaches into another school\'s students', !res.recipients.some((r) => r.student_id === 's3'));
  }
  {
    const admin = mockAdmin({ tables: { classes: [{ id: 'c-other', name: 'X', school_id: SCHOOL_B }] } });
    const res = await resolveRecipients(admin, SCHOOL_A, { scope: 'class', class_id: 'c-other' });
    check('resolveRecipients(class) refuses a class belonging to a different school', !!res.error);
  }

  // ---- resolveRecipients: individual_student / individual_staff -------------
  {
    const admin = mockAdmin({
      tables: { students: [{ id: 's1', full_name: 'Amos', school_id: SCHOOL_A, guardian_contact: '0700000001' }] }
    });
    const res = await resolveRecipients(admin, SCHOOL_A, { scope: 'individual_student', student_id: 's1' });
    check('resolveRecipients(individual_student) resolves the one guardian', res.recipients.length === 1 && res.recipients[0].phone === '0700000001');
  }
  {
    const admin = mockAdmin({ tables: { students: [{ id: 's1', full_name: 'Amos', school_id: SCHOOL_A, guardian_contact: '' }] } });
    const res = await resolveRecipients(admin, SCHOOL_A, { scope: 'individual_student', student_id: 's1' });
    check('resolveRecipients(individual_student) errors when there is no guardian contact', !!res.error);
  }
  {
    const admin = mockAdmin({ tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }] } });
    const res = await resolveRecipients(admin, SCHOOL_A, { scope: 'individual_staff', staff_id: 'st1' });
    check('resolveRecipients(individual_staff) resolves the staff phone', res.recipients.length === 1 && res.recipients[0].staff_id === 'st1');
  }

  // ---- resolveRecipients: broadcast + unknown scope --------------------------
  {
    const admin = mockAdmin({
      tables: { students: [
        { id: 's1', full_name: 'Amos', school_id: SCHOOL_A, status: 'active', guardian_contact: '0700000001' },
        { id: 's2', full_name: 'Jane', school_id: SCHOOL_A, status: 'active', guardian_contact: '0700000002' }
      ] }
    });
    const res = await resolveRecipients(admin, SCHOOL_A, { scope: 'broadcast' });
    check('resolveRecipients(broadcast) reaches every guardian in the school', res.recipients.length === 2);
  }
  {
    const admin = mockAdmin();
    const res = await resolveRecipients(admin, SCHOOL_A, { scope: 'bogus' });
    check('resolveRecipients rejects an unknown scope', !!res.error);
  }

  // ---- sendMessage: end-to-end, no provider configured ------------------------
  {
    const admin = mockAdmin({
      tables: { students: [{ id: 's1', full_name: 'Amos', school_id: SCHOOL_A, status: 'active', guardian_contact: '0700000001' }] }
    });
    const res = await sendMessage(admin, { scope: 'broadcast', body: 'School closes early today' }, { school_id: SCHOOL_A, staff_id: 'staff-1' });
    check('sendMessage succeeds', res.ok === true);
    check('sendMessage reports delivered=false with no provider configured', res.delivered === false);
    check('sendMessage logs one row per recipient', admin._tables.message_logs.length === 1);
    check('sendMessage stamps every row with the batch_id it returns', admin._tables.message_logs[0].batch_id === res.batch_id);
    check('sendMessage status is "logged" (not "queued") with no provider', admin._tables.message_logs[0].status === 'logged');
    check('sendMessage stamps the caller\'s own school_id, not a client-supplied one', admin._tables.message_logs[0].school_id === SCHOOL_A);
  }
  {
    const admin = mockAdmin();
    const res = await sendMessage(admin, { scope: 'broadcast', body: '' }, { school_id: SCHOOL_A });
    check('sendMessage rejects an empty body', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await sendMessage(admin, { scope: 'broadcast', body: 'x'.repeat(1001) }, { school_id: SCHOOL_A });
    check('sendMessage rejects a body over 1000 characters', res.ok === false);
  }
  // ---- sendMessage: a real provider configured (Sender ID now live) ---------
  // smsProvider.js's sendSms() calls the global fetch — stubbed here so the
  // test never makes a real network call, same spirit as mockAdmin standing
  // in for supabase-js.
  const realFetch = global.fetch;
  function stubFetch(atResponse) {
    global.fetch = async () => ({ json: async () => atResponse, status: 200 });
  }
  {
    const admin = mockAdmin({
      tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }] }
    });
    process.env.SMS_PROVIDER_API_KEY = 'test-key';
    process.env.SMS_PROVIDER_USERNAME = 'test-user';
    stubFetch({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'AT-msg-1' }] } });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Staff meeting at 4pm' }, { school_id: SCHOOL_A });
    check('sendMessage marks a successfully-sent row "sent" once a provider is configured', admin._tables.message_logs[0].status === 'sent');
    check('sendMessage records the provider\'s own message id', admin._tables.message_logs[0].provider_response.indexOf('AT-msg-1') !== -1);
    check('sendMessage reports delivered=true once a provider is configured', res.delivered === true);
  }
  {
    // A provider that reports failure for the recipient (bad number, AT-side
    // rejection, etc.) — the row is marked "failed", not silently dropped,
    // and the send as a whole still reports ok (it was attempted).
    const admin = mockAdmin({
      tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }] }
    });
    stubFetch({ SMSMessageData: { Recipients: [{ status: 'InvalidPhoneNumber' }] } });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Hi' }, { school_id: SCHOOL_A });
    check('sendMessage marks a provider-rejected row "failed"', admin._tables.message_logs[0].status === 'failed');
    check('sendMessage still reports ok:true (it logged the attempt)', res.ok === true);
    check('sendMessage\'s summary message says how many of the batch actually sent', /Sent 0 of 1/.test(res.message));
  }
  {
    // Not enough SMS credit: debit_sms_wallet() raises, and NO messages
    // should be sent or logged at all — the whole batch stops up front.
    const admin = mockAdmin({
      forceDebitError: 'Not enough SMS credit — top up before sending.',
      tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }] }
    });
    stubFetch({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'should-not-be-used' }] } });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Hi' }, { school_id: SCHOOL_A });
    check('sendMessage refuses the whole batch when the wallet has insufficient credit', res.ok === false);
    check('sendMessage never logs a message when the debit is refused', admin._tables.message_logs.length === 0);
  }
  global.fetch = realFetch;
  delete process.env.SMS_PROVIDER_API_KEY;
  delete process.env.SMS_PROVIDER_USERNAME;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
