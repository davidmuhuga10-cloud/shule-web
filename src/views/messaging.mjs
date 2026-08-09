/**
 * messaging.mjs (view) — compose a message to a class's guardians, a single
 * guardian, a single staff member, every guardian in the school, or (brief
 * G1) exam/term results per guardian; a history of past sends grouped by
 * batch (see groupMessagesByBatch); and (brief G2) a placeholder "Buy Bulk
 * SMS" tab since the real Africa's Talking billing integration is a later
 * sprint.
 */
import { esc, options, toast, renderPrereq, loader, fmtDate } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { groupMessagesByBatch } from '../lib/api/messaging.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';

const SCOPE_LABELS = {
  class: 'A whole class (guardians)',
  individual_student: 'One student\'s guardian',
  individual_staff: 'One staff member',
  broadcast: 'Every guardian in the school',
  exam_results: 'Exam/term results (per guardian)'
};

// Placeholder-only credit "packages" for the Buy Bulk SMS tab (brief G2) —
// there's no real payment/billing provider wired up yet (Africa's Talking is
// a later sprint per the brief), so these just top up the same manually-
// tracked sms_credit_balance settings key that used to be hand-edited in
// Settings, with an honest "demo" label rather than pretending real money
// changed hands.
const SMS_PACKAGES = [
  { credits: 1000, label: '1,000 credits' },
  { credits: 5000, label: '5,000 credits' },
  { credits: 10000, label: '10,000 credits' }
];

export async function viewMessaging(root) {
  const [classesRes, studentsRes, staffRes, examsRes] = await Promise.all([
    Db.classes.list(), Db.students.list({}), Db.staff.list(), Db.results.listExams()
  ]);
  const classes = classesRes.ok ? classesRes.data : [];
  const students = studentsRes.ok ? studentsRes.data : [];
  const staff = staffRes.ok ? staffRes.data : [];
  const exams = examsRes.ok ? examsRes.data : [];
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  // A "📨 Send Results" click from the Manage Exams board (brief Step 13)
  // hands off straight to the exam_results scope, pre-filled with exactly
  // which exam+class to send — see navIntent.mjs.
  const intent = takeNavIntent('messaging') || {};
  render(root, { classes, students, staff, exams }, {
    tab: 'compose',
    scope: intent.scope || 'class',
    class_id: intent.class_id || classes[0].id,
    exam_id: intent.exam_id || (exams[0] ? exams[0].id : ''),
    body: ''
  });
}

function render(root, data, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Messaging</h2><p>Send SMS-style messages to guardians and staff, and review what's been sent.</p></div></div>
    <div class="tabs" style="max-width:460px">
      <button data-tab="compose" class="${sel.tab === 'compose' ? 'active' : ''}">Compose</button>
      <button data-tab="history" class="${sel.tab === 'history' ? 'active' : ''}">History</button>
      <button data-tab="buy-sms" class="${sel.tab === 'buy-sms' ? 'active' : ''}">Buy Bulk SMS</button>
    </div>
    <div id="msg-body"></div>
  `;
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => render(root, data, { ...sel, tab: b.dataset.tab }));

  const body = root.querySelector('#msg-body');
  if (sel.tab === 'compose') renderCompose(body, data, sel, root);
  else if (sel.tab === 'buy-sms') renderBuySms(body);
  else renderHistory(body);
}

function renderCompose(body, data, sel, root) {
  const { classes, students, staff, exams } = data;
  const isResults = sel.scope === 'exam_results';
  body.innerHTML = `
    <div class="card">
      <div class="card-b">
        <div class="field">
          <label>Send to</label>
          <select id="msg-scope">${Object.entries(SCOPE_LABELS).map(([k, l]) => `<option value="${k}" ${sel.scope === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        </div>
        <div id="msg-target" class="field"></div>
        ${isResults ? '' : `<div class="field">
          <label>Message</label>
          <textarea id="msg-body-text" rows="5" maxlength="1000" placeholder="Type your message…">${esc(sel.body)}</textarea>
          <div class="hint" id="msg-count">0 / 1000 characters</div>
        </div>`}
      </div>
      <div class="card-b" style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line)">
        <div class="muted" id="msg-preview" style="font-size:13px"></div>
        <button class="btn" id="msg-send">${isResults ? 'Send results' : 'Send message'}</button>
      </div>
    </div>
  `;

  function renderTarget() {
    const targetEl = body.querySelector('#msg-target');
    if (sel.scope === 'class') {
      targetEl.innerHTML = `<label>Class</label><select id="msg-class">${options(classes, 'id', 'name', sel.class_id)}</select>`;
      targetEl.querySelector('#msg-class').onchange = (e) => { sel.class_id = e.target.value; updatePreview(); };
    } else if (sel.scope === 'individual_student') {
      targetEl.innerHTML = `<label>Student</label><select id="msg-student">${options(students, 'id', 'full_name', sel.student_id, 'Choose a student')}</select>`;
      targetEl.querySelector('#msg-student').onchange = (e) => { sel.student_id = e.target.value; updatePreview(); };
    } else if (sel.scope === 'individual_staff') {
      targetEl.innerHTML = `<label>Staff member</label><select id="msg-staff">${options(staff, 'id', 'full_name', sel.staff_id, 'Choose a staff member')}</select>`;
      targetEl.querySelector('#msg-staff').onchange = (e) => { sel.staff_id = e.target.value; updatePreview(); };
    } else if (sel.scope === 'exam_results') {
      if (!exams.length) {
        targetEl.innerHTML = `<div class="hint">No exams found — create one under Exams first.</div>`;
        return;
      }
      targetEl.innerHTML = `
        <label>Exam</label><select id="msg-exam">${options(exams, 'id', 'name', sel.exam_id)}</select>
        <label style="margin-top:10px;display:block">Class</label><select id="msg-class">${options(classes, 'id', 'name', sel.class_id)}</select>
        <p class="hint">Each guardian gets their own child's total, average, grade and position — not a shared message.</p>`;
      targetEl.querySelector('#msg-exam').onchange = (e) => { sel.exam_id = e.target.value; updatePreview(); };
      targetEl.querySelector('#msg-class').onchange = (e) => { sel.class_id = e.target.value; updatePreview(); };
    } else {
      targetEl.innerHTML = `<div class="hint">This will message every guardian phone number on file across the whole school.</div>`;
    }
  }

  function updatePreview() {
    const previewEl = body.querySelector('#msg-preview');
    if (sel.scope === 'class') {
      const cls = classes.find((c) => c.id === sel.class_id);
      const count = students.filter((s) => s.class_id === sel.class_id && s.guardian_contact).length;
      previewEl.textContent = cls ? `Will reach ${count} guardian(s) in ${cls.name}.` : '';
    } else if (sel.scope === 'individual_student') {
      const s = students.find((x) => x.id === sel.student_id);
      previewEl.textContent = s ? (s.guardian_contact ? `Will reach ${s.full_name}'s guardian.` : `${s.full_name} has no guardian contact on file.`) : '';
    } else if (sel.scope === 'individual_staff') {
      const s = staff.find((x) => x.id === sel.staff_id);
      previewEl.textContent = s ? (s.phone ? `Will reach ${s.full_name}.` : `${s.full_name} has no phone on file.`) : '';
    } else if (sel.scope === 'exam_results') {
      const cls = classes.find((c) => c.id === sel.class_id);
      const count = students.filter((s) => s.class_id === sel.class_id && s.guardian_contact).length;
      previewEl.textContent = cls ? `Up to ${count} guardian(s) in ${cls.name} with a phone number on file.` : '';
    } else {
      const count = students.filter((s) => s.guardian_contact).length;
      previewEl.textContent = `Will reach ${count} guardian(s) across the whole school.`;
    }
  }

  body.querySelector('#msg-scope').onchange = (e) => { sel.scope = e.target.value; renderCompose(body, data, sel, root); };
  renderTarget();
  updatePreview();

  const textEl = body.querySelector('#msg-body-text');
  if (textEl) {
    const countEl = body.querySelector('#msg-count');
    const updateCount = () => { sel.body = textEl.value; countEl.textContent = `${textEl.value.length} / 1000 characters`; };
    textEl.oninput = updateCount;
    updateCount();
  }

  body.querySelector('#msg-send').onclick = async () => {
    const btn = body.querySelector('#msg-send');
    btn.disabled = true;
    if (sel.scope === 'exam_results') {
      btn.textContent = 'Sending…';
      const r = await sendExamResults(sel.exam_id, sel.class_id, classes, students);
      btn.disabled = false; btn.textContent = 'Send results';
      if (!r.ok) { toast(r.message, 'err'); return; }
      toast(`Sent results to ${r.sent} of ${r.eligible} guardian(s).${r.failed ? ` ${r.failed} failed.` : ''}`, r.failed ? 'warn' : 'ok');
      return;
    }
    btn.textContent = 'Sending…';
    const payload = { scope: sel.scope, body: textEl.value, class_id: sel.class_id, student_id: sel.student_id, staff_id: sel.staff_id };
    const r = await Db.messaging.send(payload);
    btn.disabled = false; btn.textContent = 'Send message';
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast(r.message || `Sent to ${r.recipients} recipient(s).`, r.delivered ? 'ok' : 'warn');
    sel.body = ''; textEl.value = ''; updateCount();
  };
}

/** Brief G1: "Add an option to send exam/term results directly through the
 *  messaging module." Each guardian gets a PERSONALIZED summary for their
 *  own child — total, average, grade, position — built from the same
 *  aggregated numbers the Mark List/Report Form already show (getBroadsheet)
 *  joined against the students already loaded for this screen (for
 *  guardian_contact/name). Sent as individual per-student messages through
 *  the existing send-message pipeline — no schema or backend changes needed
 *  — rather than one shared broadcast body. */
async function sendExamResults(examId, classId, classes, students) {
  if (!examId) return { ok: false, message: 'Choose an exam.' };
  if (!classId) return { ok: false, message: 'Choose a class.' };
  const bsRes = await Db.results.getBroadsheet({ exam_id: examId, class_id: classId });
  if (!bsRes.ok) return { ok: false, message: bsRes.message };

  const cls = classes.find((c) => c.id === classId);
  const examName = bsRes.data.exam.name;
  const totalInClass = bsRes.data.students.length;
  const withScores = bsRes.data.students.filter((r) => r.counted > 0);

  let attempted = 0, sent = 0, failed = 0;
  for (const r of withScores) {
    const student = students.find((s) => s.id === r.student_id);
    if (!student || !student.guardian_contact) continue;
    attempted++;
    const posLabel = r.position ? `${r.position} of ${totalInClass}` : 'not ranked';
    const messageBody = `${examName} RESULTS for ${r.full_name}${cls ? ` (${cls.name})` : ''}: `
      + `Total ${r.total}, Average ${r.average}%, Grade ${r.overall_grade || '—'}, Position ${posLabel}.`;
    const res = await Db.messaging.send({ scope: 'individual_student', student_id: r.student_id, body: messageBody });
    if (res.ok) sent++; else failed++;
  }
  return { ok: true, sent, failed, eligible: attempted };
}

/** Brief G2: "Buy Bulk SMS" tab — Africa's Talking billing isn't wired up
 *  yet, so this is an honest placeholder: it shows the current balance
 *  (same sms_credit_balance settings key the old Settings screen used to
 *  expose) and lets an admin top it up on the spot, clearly labelled as a
 *  demo top-up rather than a real purchase. */
async function renderBuySms(body) {
  body.innerHTML = `<div class="card"><div class="card-b">${loader()}</div></div>`;
  const res = await Db.settings.get();
  const settings = res.ok ? res.data : {};
  const balance = settings.sms_credit_balance;
  const balanceLabel = balance === null || balance === undefined || balance === '' ? '0' : String(balance);

  body.innerHTML = `
    <div class="card">
      <div class="card-b">
        <p class="hint" style="margin-top:0">⚠️ Billing isn't connected yet (Africa's Talking integration is planned for a later update) — top-ups here just adjust the balance shown on your dashboard, no real payment is taken.</p>
        <div style="display:flex;align-items:baseline;gap:8px;margin:10px 0 18px">
          <div style="font-size:28px;font-weight:750">${esc(balanceLabel)}</div>
          <div class="muted">current balance</div>
        </div>
        <label style="font-weight:600;font-size:13px;display:block;margin-bottom:10px">Top up</label>
        <div class="chips" id="sms-packages">
          ${SMS_PACKAGES.map((p) => `<div class="chip" data-credits="${p.credits}">${esc(p.label)}</div>`).join('')}
        </div>
      </div>
    </div>
  `;

  body.querySelectorAll('#sms-packages [data-credits]').forEach((chip) => {
    chip.onclick = async () => {
      const credits = Number(chip.dataset.credits) || 0;
      const current = Number(balance) || 0;
      const r = await Db.settings.save({ sms_credit_balance: String(current + credits) });
      if (!r.ok) { toast(r.message, 'err'); return; }
      toast(`Added ${credits.toLocaleString()} credits (demo — no real billing yet).`, 'ok');
      renderBuySms(body);
    };
  });
}

async function renderHistory(body) {
  body.innerHTML = `<div class="card"><div id="msg-hist-list">${loader()}</div></div>`;
  const listEl = body.querySelector('#msg-hist-list');
  const res = await Db.messaging.history(200);
  if (!res.ok) { listEl.innerHTML = `<div class="card-b">⚠️ ${esc(res.message)}</div>`; return; }
  const batches = groupMessagesByBatch(res.data);
  if (!batches.length) { listEl.innerHTML = `<div class="card-b"><div class="empty"><div class="e-ico">💬</div><h3>No messages sent yet</h3><p>Sends will show up here once you compose one.</p></div></div>`; return; }

  listEl.innerHTML = batches.map((b) => `
    <div class="card-b" style="border-bottom:1px solid var(--line)">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
        <div>
          <div style="font-weight:650">${esc(b.scope_label || b.recipient_scope)}</div>
          <div class="muted" style="font-size:12.5px;margin-top:2px">${fmtDate(b.created_at)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          ${b.counts.sent ? `<span class="badge green">${b.counts.sent} sent</span>` : ''}
          ${b.counts.queued ? `<span class="badge blue">${b.counts.queued} queued</span>` : ''}
          ${b.counts.logged ? `<span class="badge grey">${b.counts.logged} logged only</span>` : ''}
          ${b.counts.failed ? `<span class="badge red">${b.counts.failed} failed</span>` : ''}
        </div>
      </div>
      <p style="margin:10px 0 0;font-size:13.5px">${esc(b.body)}</p>
    </div>
  `).join('');
}
