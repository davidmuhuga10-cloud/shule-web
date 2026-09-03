import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createMessagingApi, groupMessagesByBatch } from '../src/lib/api/messaging.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- classRecipients ---------------------------------------------------------
  {
    const sb = createMockSupabase({
      students: [
        { id: 's1', full_name: 'Amos', class_id: 'c1', status: 'active', guardian_name: 'Mrs A', guardian_contact: '0700000001' },
        { id: 's2', full_name: 'Jane', class_id: 'c1', status: 'active', guardian_name: '', guardian_contact: '' }
      ]
    });
    const api = createMessagingApi(sb, async () => ({ ok: true }));
    const res = await api.classRecipients('c1');
    check('classRecipients succeeds', res.ok === true && res.data.length === 2);
  }
  {
    const sb = createMockSupabase({});
    const api = createMessagingApi(sb, async () => ({ ok: true }));
    check('classRecipients requires a class', (await api.classRecipients()).ok === false);
  }

  // ---- history ------------------------------------------------------------------
  {
    const sb = createMockSupabase({
      message_logs: [
        { id: 'm1', batch_id: 'b1', created_at: '2026-08-01T10:00:00Z', body: 'Hi', status: 'logged' },
        { id: 'm2', batch_id: 'b1', created_at: '2026-08-01T10:00:00Z', body: 'Hi', status: 'logged' }
      ]
    });
    const api = createMessagingApi(sb, async () => ({ ok: true }));
    const res = await api.history();
    check('history returns raw per-recipient rows', res.ok === true && res.data.length === 2);
  }

  // ---- send: validation before delegating to the injected sender --------------
  {
    let called = false;
    const sb = createMockSupabase({});
    const api = createMessagingApi(sb, async () => { called = true; return { ok: true }; });
    check('send rejects an empty body', (await api.send({ scope: 'class', class_id: 'c1', body: '  ' })).ok === false);
    check('send rejects a missing scope', (await api.send({ body: 'Hi' })).ok === false);
    check('send rejects scope=class without a class_id', (await api.send({ scope: 'class', body: 'Hi' })).ok === false);
    check('send rejects scope=individual_student without a student_id', (await api.send({ scope: 'individual_student', body: 'Hi' })).ok === false);
    check('send rejects scope=individual_staff without a staff_id', (await api.send({ scope: 'individual_staff', body: 'Hi' })).ok === false);
    check('none of the invalid payloads reached the injected sender', called === false);

    const good = await api.send({ scope: 'broadcast', body: 'Hello everyone' });
    check('a valid payload delegates to the injected sender', good.ok === true && called === true);
  }

  // ---- send: scope 'personalized' (Messaging_Overhaul.docx items 4 & 6) -------
  {
    let called = false;
    const sb = createMockSupabase({});
    const api = createMessagingApi(sb, async () => { called = true; return { ok: true }; });
    check('send(personalized) rejects an empty/missing recipients array', (await api.send({ scope: 'personalized' })).ok === false);
    check('send(personalized) rejects an empty recipients array', (await api.send({ scope: 'personalized', recipients: [] })).ok === false);
    check('none of the invalid personalized payloads reached the injected sender', called === false);
    const good = await api.send({ scope: 'personalized', recipients: [{ phone: '0700000001', body: 'Hi Amos' }] });
    check('a valid personalized payload delegates to the injected sender', good.ok === true && called === true);
  }

  // ---- resend (Messaging_Overhaul.docx item 8) ---------------------------------
  {
    let resendPayload = null;
    const sb = createMockSupabase({});
    const api = createMessagingApi(sb, async () => ({ ok: true }), async (payload) => { resendPayload = payload; return { ok: true, resent: 1 }; });
    check('resend requires at least one id', (await api.resend([])).ok === false);
    const res = await api.resend('m1');
    check('resend wraps a single id into an array for the function call', resendPayload && Array.isArray(resendPayload.ids) && resendPayload.ids[0] === 'm1');
    check('resend succeeds and passes through the count', res.ok === true && res.resent === 1);
  }

  // ---- groupMessagesByBatch: pure grouping function ----------------------------
  {
    const rows = [
      { batch_id: 'b1', scope_label: 'Grade 7', recipient_scope: 'class', body: 'Reminder', channel: 'sms', created_at: 't1', status: 'sent', credits: 1, sent_by: 'staff-1' },
      { batch_id: 'b1', scope_label: 'Grade 7', recipient_scope: 'class', body: 'Reminder', channel: 'sms', created_at: 't1', status: 'failed', credits: 1, sent_by: 'staff-1' },
      { batch_id: 'b2', scope_label: 'Amos', recipient_scope: 'individual_student', body: 'Fees due', channel: 'sms', created_at: 't2', status: 'logged', credits: 2 }
    ];
    const batches = groupMessagesByBatch(rows);
    check('groupMessagesByBatch groups by batch_id', batches.length === 2);
    check('groupMessagesByBatch keeps the newest-first insertion order given', batches[0].batch_id === 'b1');
    check('groupMessagesByBatch attaches every recipient row to its batch', batches[0].recipients.length === 2);
    check('groupMessagesByBatch tallies status counts per batch', batches[0].counts.sent === 1 && batches[0].counts.failed === 1);
    check('groupMessagesByBatch handles a single-recipient batch', batches[1].recipients.length === 1 && batches[1].counts.logged === 1);
    check('groupMessagesByBatch totals credits used across the batch', batches[0].credits === 2 && batches[1].credits === 2);
    check('groupMessagesByBatch keeps who sent it', batches[0].sent_by === 'staff-1');
  }
  {
    check('groupMessagesByBatch handles an empty/undefined input', groupMessagesByBatch(undefined).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
