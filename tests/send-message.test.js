/**
 * Unit tests for netlify/functions/send-message.js against a mock Supabase
 * admin client (no live project needed). Mirrors the mockAdmin() pattern in
 * admin-provision.test.js, extended with the tables send-message.js reads
 * (classes, students, staff, message_logs).
 */
const { requireStaff } = require('../netlify/functions/_lib/supabaseAdmin.js');
const { sendMessage, resolveRecipients } = require('../netlify/functions/send-message.js');
const { deliverBatch } = require('../netlify/functions/deliver-sms-background.js');

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
      _mode: 'select',
      _patch: null,
      select() { this._mode = 'select'; return this; },
      // deliver-sms-background.js updates message_logs rows by batch_id+status
      // (bulk) and by id (one row at a time) — both are just "apply _patch to
      // every row matching every accumulated .eq() filter" once awaited.
      update(patch) { this._mode = 'update'; this._patch = patch; return this; },
      eq(col, val) { this._filters.push(['eq', col, val]); return this; },
      // .in('id', [...]) — used to validate a personalized batch's
      // student_id/staff_id list against the caller's own school in one
      // round trip rather than one .eq() per id.
      in(col, vals) { this._filters.push(['in', col, vals || []]); return this; },
      _matches(r) {
        return this._filters.every(([kind, c, v]) =>
          kind === 'in' ? v.map(String).includes(String(r[c])) : String(r[c]) === String(v)
        );
      },
      async maybeSingle() {
        const rows = tables[table] || [];
        const hit = rows.find((r) => this._matches(r));
        return { data: hit || null, error: null };
      },
      // Non-.maybeSingle() selects (e.g. lists of students) and updates both
      // resolve here — `await q.eq(...).eq(...)` needs the chain itself to
      // be awaitable.
      then(resolve) {
        if (this._mode === 'update') {
          tables[table] = (tables[table] || []).map((r) => (this._matches(r) ? { ...r, ...this._patch } : r));
          resolve({ error: null });
          return;
        }
        const rows = (tables[table] || []).filter((r) => this._matches(r));
        resolve({ data: rows, error: null });
      },
      async insert(rows) {
        if (opts.forceInsertError) return { error: { message: 'forced insert failure' } };
        tables[table] = tables[table] || [];
        // Real Postgres assigns each row its own id via DEFAULT
        // gen_random_uuid() — deliverBatch's per-row .update().eq('id', ...)
        // depends on that uniqueness, so the mock must too, or every row
        // missing an explicit id would look like the same row to .eq('id',
        // undefined) and updates would clobber each other.
        const withIds = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: `${table}-${tables[table].length + Math.random().toString(36).slice(2)}`, ...r }));
        tables[table].push(...withIds);
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
    // Messaging_Overhaul.docx item 2: standing rule — every message, of
    // every kind, opens with the school's own name in caps on its own line.
    check('sendMessage prepends the school name in caps as line one', /^[A-Z ]+\n\nSchool closes early today$/.test(admin._tables.message_logs[0].body));
  }
  {
    const admin = mockAdmin({ tables: { schools: [{ id: SCHOOL_A, name: 'Green Hill Academy' }] } });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Staff meeting' },
      { school_id: SCHOOL_A });
    check('rejects unknown staff before touching the school name lookup (sanity: no crash on missing staff row)', res.ok === false);
  }
  {
    const admin = mockAdmin({
      tables: {
        schools: [{ id: SCHOOL_A, name: 'Green Hill Academy' }],
        staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }]
      }
    });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Staff meeting at 4pm' }, { school_id: SCHOOL_A });
    check('sendMessage looks up the real school name when one exists', res.ok === true && admin._tables.message_logs[0].body.startsWith('GREEN HILL ACADEMY\n\n'));
    check('the caller\'s own body text follows the header, untouched', admin._tables.message_logs[0].body.endsWith('\n\nStaff meeting at 4pm'));
  }
  {
    const admin = mockAdmin();
    const res = await sendMessage(admin, { scope: 'broadcast', body: '' }, { school_id: SCHOOL_A });
    check('sendMessage rejects an empty body', res.ok === false);
  }

  // ---- sendMessage: scope 'personalized' (exam results, fee balances) --------
  {
    const admin = mockAdmin({
      tables: {
        students: [
          { id: 's1', full_name: 'Amos', school_id: SCHOOL_A },
          { id: 's2', full_name: 'Jane', school_id: SCHOOL_A }
        ]
      }
    });
    const res = await sendMessage(admin, {
      scope: 'personalized', scope_label: 'Exam Results — Form 3 East',
      recipients: [
        { student_id: 's1', phone: '0700000001', body: 'Dear Parent, Amos scored 342/500.' },
        { student_id: 's2', phone: '0700000002', body: 'Dear Parent, Jane scored 410/500.' }
      ]
    }, { school_id: SCHOOL_A, staff_id: 'staff-1' });
    check('sendMessage(personalized) succeeds', res.ok === true);
    check('sendMessage(personalized) logs one row per recipient, not one shared row', admin._tables.message_logs.length === 2);
    const bodies = admin._tables.message_logs.map((r) => r.body);
    check('each personalized row keeps its OWN text, not a shared one', bodies.some((b) => b.indexOf('Amos scored 342') !== -1) && bodies.some((b) => b.indexOf('Jane scored 410') !== -1));
    check('every personalized row still gets the school-name header', bodies.every((b) => /^[A-Z ]+\n\n/.test(b)));
    check('sendMessage(personalized) uses the given scope_label', admin._tables.message_logs[0].scope_label === 'Exam Results — Form 3 East');
    check('sendMessage(personalized) stamps recipient_scope as personalized', admin._tables.message_logs[0].recipient_scope === 'personalized');
  }
  {
    // Recipients missing a phone or body are dropped, not sent as blanks —
    // and the batch still goes out for whoever's left.
    const admin = mockAdmin({ tables: { students: [{ id: 's1', full_name: 'Amos', school_id: SCHOOL_A }] } });
    const res = await sendMessage(admin, {
      scope: 'personalized',
      recipients: [
        { student_id: 's1', phone: '0700000001', body: 'Real message' },
        { student_id: 's1', phone: '', body: 'No phone on this one' }
      ]
    }, { school_id: SCHOOL_A });
    check('sendMessage(personalized) skips a recipient with no phone', res.ok === true && admin._tables.message_logs.length === 1);
  }
  {
    const admin = mockAdmin();
    const res = await sendMessage(admin, { scope: 'personalized', recipients: [] }, { school_id: SCHOOL_A });
    check('sendMessage(personalized) rejects an empty recipient list', res.ok === false);
  }
  {
    // A student that belongs to a DIFFERENT school must never sneak into a
    // personalized batch, even if the client sent it.
    const admin = mockAdmin({ tables: { students: [{ id: 's-other', full_name: 'Someone Else', school_id: SCHOOL_B }] } });
    const res = await sendMessage(admin, {
      scope: 'personalized',
      recipients: [{ student_id: 's-other', phone: '0700000009', body: 'Hi' }]
    }, { school_id: SCHOOL_A });
    check('sendMessage(personalized) refuses a student belonging to a different school', res.ok === false);
    check('sendMessage(personalized) never logs the cross-school attempt', admin._tables.message_logs.length === 0);
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
  // Credentials now live in sms_platform_config (see smsProvider.js's own
  // header for why it moved off env vars) — seeded directly into the mock's
  // tables rather than via process.env.
  const CONFIGURED_SMS_ROW = { id: 1, api_key: 'test-key', username: 'test-user', sender_id: 'TEST' };
  // sendMessage no longer sends anything itself once a provider is
  // configured — it hands the batch to a background function instead and
  // returns right away. A no-op stand-in for that trigger is enough to
  // exercise sendMessage's own behaviour; a separate block below exercises
  // deliverBatch (the background function's real work) directly.
  let triggeredBatches;
  async function recordingTrigger(batchId) { triggeredBatches.push(batchId); }
  {
    triggeredBatches = [];
    const admin = mockAdmin({
      tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }], sms_platform_config: [CONFIGURED_SMS_ROW] }
    });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Staff meeting at 4pm' }, { school_id: SCHOOL_A }, recordingTrigger);
    check('sendMessage queues a row immediately once a provider is configured, without sending it', admin._tables.message_logs[0].status === 'queued');
    check('sendMessage reports delivered=true (accepted for delivery) as soon as it queues', res.delivered === true);
    check('sendMessage\'s response never waits on the actual send — no per-recipient outcome yet', /Sent to 1 recipient/.test(res.message));
    check('sendMessage hands the batch to the delivery trigger exactly once', triggeredBatches.length === 1 && triggeredBatches[0] === res.batch_id);
  }
  {
    // The actual Africa's Talking round trip and per-row status update now
    // happen in deliver-sms-background.js's deliverBatch(), against the
    // 'queued' rows sendMessage already wrote.
    triggeredBatches = [];
    const admin = mockAdmin({
      tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }], sms_platform_config: [CONFIGURED_SMS_ROW] }
    });
    stubFetch({ SMSMessageData: { Recipients: [{ number: '+254711111111', status: 'Success', messageId: 'AT-msg-1' }] } });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Staff meeting at 4pm' }, { school_id: SCHOOL_A }, recordingTrigger);
    await deliverBatch(admin, res.batch_id);
    check('deliverBatch marks a successfully-sent row "sent"', admin._tables.message_logs[0].status === 'sent');
    // SMS History (Messaging_Overhaul.docx item 8) shows provider_response
    // straight to an admin/teacher — it must read as plain English, never
    // a provider message id or raw JSON (see smsProvider.js's
    // friendlyDeliveryText).
    check('deliverBatch stores a plain-English delivery message, not a provider id', admin._tables.message_logs[0].provider_response === 'Delivered successfully.');
    check('deliverBatch never leaks the provider\'s internal message id into what a person sees', admin._tables.message_logs[0].provider_response.indexOf('AT-msg-1') === -1);
  }
  {
    // A provider that reports failure for the recipient (bad number, AT-side
    // rejection, etc.) — deliverBatch marks the row "failed", not silently
    // dropped — this is exactly what SMS History is for.
    triggeredBatches = [];
    const admin = mockAdmin({
      tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }], sms_platform_config: [CONFIGURED_SMS_ROW] }
    });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Hi' }, { school_id: SCHOOL_A }, recordingTrigger);
    stubFetch({ SMSMessageData: { Recipients: [{ number: '+254711111111', status: 'InvalidPhoneNumber' }] } });
    await deliverBatch(admin, res.batch_id);
    check('deliverBatch marks a provider-rejected row "failed"', admin._tables.message_logs[0].status === 'failed');
  }
  {
    // Messaging_Overhaul.docx items 4/6 — a 'personalized' batch has a
    // DIFFERENT body per recipient, so Africa's Talking's one-message-per-
    // call bulk endpoint can't cover the whole batch in one request.
    // deliverBatch must group by body and call out once per distinct text,
    // still matching each response back to the right row.
    triggeredBatches = [];
    const admin = mockAdmin({
      tables: {
        students: [{ id: 's1', full_name: 'Amos', school_id: SCHOOL_A }, { id: 's2', full_name: 'Jane', school_id: SCHOOL_A }],
        sms_platform_config: [CONFIGURED_SMS_ROW]
      }
    });
    const res = await sendMessage(admin, {
      scope: 'personalized',
      recipients: [
        { student_id: 's1', phone: '0700000001', body: 'Amos scored 342/500.' },
        { student_id: 's2', phone: '0700000002', body: 'Jane scored 410/500.' }
      ]
    }, { school_id: SCHOOL_A }, recordingTrigger);
    let fetchCalls = 0;
    global.fetch = async (url, init) => {
      fetchCalls++;
      const form = new URLSearchParams(init.body);
      const numbers = form.get('to').split(',');
      // Give the two groups DIFFERENT outcomes (rather than both 'Success')
      // so a mixed-up match between Amos's and Jane's rows would actually
      // show up as a wrong result, not just a coincidentally-right one.
      return { json: async () => ({ SMSMessageData: { Recipients: numbers.map((n) => ({ number: n, status: n.endsWith('01') ? 'Success' : 'InvalidPhoneNumber', messageId: 'AT-' + n })) } }), status: 200 };
    };
    await deliverBatch(admin, res.batch_id);
    check('deliverBatch makes one Africa\'s Talking call PER DISTINCT personalized body', fetchCalls === 2);
    const amosRow = admin._tables.message_logs.find((r) => r.student_id === 's1');
    const janeRow = admin._tables.message_logs.find((r) => r.student_id === 's2');
    check('deliverBatch marks Amos\'s row "sent" via its own group\'s result', amosRow.status === 'sent');
    check('deliverBatch marks Jane\'s row "failed" via its own group\'s result, not mixed up with Amos\'s', janeRow.status === 'failed');
    // SMS History (Messaging_Overhaul.docx item 8) shows provider_response
    // straight to a non-technical admin/teacher — plain English, never a
    // provider message id — and this also proves per-row matching stayed
    // correct across the two separate Africa's Talking calls.
    check('each row is matched back to ITS OWN plain-English result, not a mixed-up one', amosRow.provider_response === 'Delivered successfully.' && janeRow.provider_response === 'This phone number is invalid.');
    check('sendMessage still reported ok:true up front (it queued the attempt)', res.ok === true);
  }
  {
    // Not enough SMS credit: debit_sms_wallet() raises, and NO messages
    // should be sent or logged at all — the whole batch stops up front.
    const admin = mockAdmin({
      forceDebitError: 'Not enough SMS credit — top up before sending.',
      tables: { staff: [{ id: 'st1', full_name: 'Mr T', school_id: SCHOOL_A, phone: '0711111111' }], sms_platform_config: [CONFIGURED_SMS_ROW] }
    });
    stubFetch({ SMSMessageData: { Recipients: [{ number: '+254711111111', status: 'Success', messageId: 'should-not-be-used' }] } });
    const res = await sendMessage(admin, { scope: 'individual_staff', staff_id: 'st1', body: 'Hi' }, { school_id: SCHOOL_A });
    check('sendMessage refuses the whole batch when the wallet has insufficient credit', res.ok === false);
    check('sendMessage never logs a message when the debit is refused', admin._tables.message_logs.length === 0);
  }
  global.fetch = realFetch;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
