/**
 * messaging.mjs (view) — Messaging_Overhaul.docx rewrite of Compose, exam
 * results sending, and SMS History. Compose recipient selection (item 5) is
 * now a single grid of tappable cards instead of a dropdown + checkbox
 * wizard — no "Next" step, nothing hidden behind a menu. Recipient details
 * and the message text sit in their own bordered cards (item 10), not one
 * mixed block. Exam results (items 3 & 6) support sending to a whole class
 * OR one student, build the brief's exact template client-side (the
 * school-name-in-caps line itself is added server-side, once, for every
 * message this app sends — see send-message.js item 2), and confirm
 * "Processed" the instant the batch is queued rather than waiting for
 * delivery. History (items 7 & 8) is a scannable table with a per-recipient
 * detail view and a resend action for anything that failed.
 *
 * Compose review round (design review, following the SMS Credits and SMS
 * History redesign passes): no emoji on the "To" cards — plain text label,
 * each with its own permanent accent border color (not just on selection —
 * a color per recipient type, same hues used elsewhere in the app) so
 * selection is shown by a heavier border only, never a fill/text change.
 * No filler explanation text under "To" or under the message box. Real
 * SMS-segment counting (160 chars/segment, the auto-added school-name
 * header counted in) instead of a flat 1000-character cap.
 */
import { esc, options, toast, renderPrereq, renderPrereqOrConnectivity, loader, fmtDate, modal, closeModal, withBusy, state, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { groupMessagesByBatch } from '../lib/api/messaging.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';
import { renderSmsCredits } from './smsCredits.mjs';

// Item 5: one option per card — no "message type" vs "scope" split, no
// dropdown. Exam Results lives here too (doc item 6, closing line: "Under
// sms include also an option to send results from that point"). `color`
// is a permanent border accent (not an emoji stand-in) — same hues the
// rest of the app already uses for .tile-blue/green/amber/purple/teal.
const RECIPIENT_TYPES = [
  { scope: 'broadcast', label: 'All Guardians', color: '#127a6b' },
  { scope: 'class', label: 'A Class', color: '#2563eb' },
  { scope: 'individual_student', label: 'One Student Guardian', color: '#2f9e6f' },
  { scope: 'individual_staff', label: 'Staff Member', color: '#c9860a' },
  { scope: 'exam_results', label: 'Exam Results', color: '#7c3aed' }
];
const STATUS_BADGE = { sent: 'green', queued: 'blue', logged: 'grey', failed: 'red' };

/** Real SMS-segment count (160 chars/segment), counting the school-name
 *  header line that send-message.js adds automatically — an admin should
 *  see the actual number of SMS units a message will cost, not a flat
 *  1000-character textarea limit that has nothing to do with what Africa's
 *  Talking actually bills per segment. */
function smsCount(bodyText) {
  const schoolName = (state.settings && state.settings.school_name) || 'YOUR SCHOOL';
  const header = `${schoolName.toUpperCase()}\n\n`;
  const total = (header + (bodyText || '')).length;
  const segments = Math.max(1, Math.ceil(total / 160));
  return { total, budget: segments * 160, segments };
}

export async function viewMessaging(root) {
  const [classesRes, studentsRes, staffRes, examsRes] = await Promise.all([
    Db.classes.list(), Db.students.list({}), Db.staff.list(), Db.results.listExams()
  ]);
  if (!classesRes.ok || !studentsRes.ok || !staffRes.ok || !examsRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewMessaging(root) });
    return;
  }
  const classes = classesRes.data;
  const students = studentsRes.data;
  const staff = staffRes.data;
  const exams = examsRes.data;
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  // A "📨 Send Results" click from the Manage Exams board hands off straight
  // to the exam_results scope, pre-filled with exactly which exam+class.
  const intent = takeNavIntent('messaging') || {};
  render(root, { classes, students, staff, exams }, {
    tab: 'compose',
    scope: intent.scope || 'broadcast',
    class_id: intent.class_id || classes[0].id,
    exam_id: intent.exam_id || (exams[0] ? exams[0].id : ''),
    resultsMode: 'class',
    body: '',
    customNote: '',
    ccEnabled: false,
    ccStaffIds: []
  });
}

function render(root, data, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Messaging</h2></div></div>
    <div class="fin-tabs">
      <button data-tab="compose" class="${sel.tab === 'compose' ? 'active' : ''}">Compose</button>
      <button data-tab="history" class="${sel.tab === 'history' ? 'active' : ''}">History</button>
      <button data-tab="sms-credits" class="${sel.tab === 'sms-credits' ? 'active' : ''}">SMS Credits</button>
    </div>
    <div id="msg-body"></div>
  `;
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => render(root, data, { ...sel, tab: b.dataset.tab }));

  const body = root.querySelector('#msg-body');
  if (sel.tab === 'compose') renderCompose(body, data, sel, root);
  else if (sel.tab === 'sms-credits') renderSmsCredits(body);
  else renderHistory(body, data);
}

// ===========================================================================
// COMPOSE (items 5 & 10)
// ===========================================================================
function renderCompose(body, data, sel, root) {
  const { classes, students, staff, exams } = data;
  const isResults = sel.scope === 'exam_results';

  body.innerHTML = `
    <div class="card side-accent tile-indigo compose-block">
      <div class="card-b">
        <h4>To</h4>
        <div class="rp-grid">
          ${RECIPIENT_TYPES.map((t) => `<div class="rp-opt${sel.scope === t.scope ? ' sel' : ''}" data-scope="${t.scope}" style="--c:${t.color}">
            <span class="lab">${esc(t.label)}</span>
          </div>`).join('')}
        </div>
        <div id="msg-target" class="rp-inline"></div>
      </div>
    </div>
    <div id="msg-second-block"></div>
  `;

  body.querySelectorAll('[data-scope]').forEach((el) => {
    el.onclick = () => {
      if (sel.scope === el.dataset.scope) return;
      renderCompose(body, data, { ...sel, scope: el.dataset.scope }, root);
    };
  });

  const targetEl = body.querySelector('#msg-target');
  const secondBlock = body.querySelector('#msg-second-block');

  if (isResults) {
    renderResultsTarget(targetEl, data, sel, root, body);
    if (exams.length) renderResultsSendCard(secondBlock, data, sel, root, body);
    else secondBlock.innerHTML = '';
    return;
  }

  renderPlainTarget(targetEl, data, sel, () => updatePreview());
  secondBlock.innerHTML = `
    <div class="card side-accent tile-indigo compose-block">
      <div class="card-b">
        <h4>Message</h4>
        <textarea id="msg-body-text" rows="5" placeholder="Type your message…">${esc(sel.body)}</textarea>
        <div class="charcount" id="msg-count"></div>
        <p class="hint" id="msg-preview" style="margin-top:6px"></p>
      </div>
      <div class="card-b send-row" style="border-top:1px solid var(--line)">
        <div class="copy-to-wrap">
          <div class="copy-to-top">
            <input type="checkbox" id="msg-cc-check"${sel.ccEnabled ? ' checked' : ''}>
            <label for="msg-cc-check">Send a copy to</label>
            <select id="msg-cc-add"${sel.ccEnabled ? '' : ' disabled'}>
              <option value="">+ Add someone…</option>
              ${staff.map((s) => `<option value="${esc(s.id)}">${esc(s.full_name)}${s.phone ? '' : ' (no phone on file)'}</option>`).join('')}
            </select>
          </div>
          <div class="chips" id="msg-cc-chips"></div>
        </div>
        <button class="btn" id="msg-send">Send message</button>
      </div>
    </div>
  `;

  // "Send a copy to" reuses the 'personalized' scope as a SECOND, separate
  // batch fired after the main one — a real SMS to each picked staff
  // member (their own message_logs rows, own SMS-credit cost), not a
  // silent bcc. Picking a name ADDS them; each chip removes only itself,
  // so a second pick never drops the first one by mistake.
  const ccChipsEl = body.querySelector('#msg-cc-chips');
  function renderCcChips() {
    ccChipsEl.innerHTML = sel.ccStaffIds.map((id) => {
      const s = staff.find((x) => x.id === id);
      return `<span class="chip">${esc(s ? s.full_name : 'Unknown')}<button type="button" data-cc-id="${esc(id)}" title="Remove">×</button></span>`;
    }).join('');
    ccChipsEl.querySelectorAll('button').forEach((b) => b.onclick = () => {
      sel.ccStaffIds = sel.ccStaffIds.filter((id) => id !== b.dataset.ccId);
      renderCcChips();
    });
  }
  renderCcChips();
  body.querySelector('#msg-cc-check').onchange = (e) => {
    sel.ccEnabled = e.target.checked;
    body.querySelector('#msg-cc-add').disabled = !sel.ccEnabled;
  };
  body.querySelector('#msg-cc-add').onchange = (e) => {
    if (e.target.value && !sel.ccStaffIds.includes(e.target.value)) { sel.ccStaffIds.push(e.target.value); renderCcChips(); }
    e.target.value = '';
  };

  // Only ever shows an actual problem (no contact on file) or an unmade
  // choice — never a plain restating of what the "To" selection already
  // says (e.g. "will reach N guardians"), which was unneeded explanation.
  function updatePreview() {
    const previewEl = body.querySelector('#msg-preview');
    if (!previewEl) return;
    if (sel.scope === 'individual_student') {
      const s = students.find((x) => x.id === sel.student_id);
      previewEl.textContent = s ? (s.guardian_contact ? '' : `${s.full_name} has no guardian contact on file.`) : 'Choose a student.';
    } else if (sel.scope === 'individual_staff') {
      const s = staff.find((x) => x.id === sel.staff_id);
      previewEl.textContent = s ? (s.phone ? '' : `${s.full_name} has no phone on file.`) : 'Choose a staff member.';
    } else {
      previewEl.textContent = '';
    }
  }
  updatePreview();

  const textEl = body.querySelector('#msg-body-text');
  const countEl = body.querySelector('#msg-count');
  const updateCount = () => {
    sel.body = textEl.value;
    const { total, budget, segments } = smsCount(textEl.value);
    countEl.classList.toggle('over', segments > 1);
    countEl.innerHTML = `Count ${segments} SMS (<b>${total}</b>/${budget} characters)`;
  };
  textEl.oninput = updateCount;
  updateCount();

  // A misclick sends real SMS at real cost — 14 sent by mistake was the
  // report that prompted this. "Send message" now only OPENS a confirm
  // dialog naming exactly who's about to get it; the actual send only
  // happens once that's explicitly accepted.
  function describeSendTarget() {
    if (sel.scope === 'broadcast') {
      const count = students.filter((s) => s.guardian_contact).length;
      return `all ${count} guardian(s) with a phone number on file`;
    }
    if (sel.scope === 'class') {
      const cls = classes.find((c) => c.id === sel.class_id);
      if (!cls) { toast('Choose a class first.', 'err'); return null; }
      const count = students.filter((s) => s.class_id === sel.class_id && s.guardian_contact).length;
      return `${count} guardian(s) in ${cls.name}`;
    }
    if (sel.scope === 'individual_student') {
      const s = students.find((x) => x.id === sel.student_id);
      if (!s) { toast('Choose a student first.', 'err'); return null; }
      if (!s.guardian_contact) { toast(`${s.full_name} has no guardian contact on file.`, 'err'); return null; }
      return `${s.full_name}'s guardian`;
    }
    if (sel.scope === 'individual_staff') {
      const s = staff.find((x) => x.id === sel.staff_id);
      if (!s) { toast('Choose a staff member first.', 'err'); return null; }
      if (!s.phone) { toast(`${s.full_name} has no phone on file.`, 'err'); return null; }
      return s.full_name;
    }
    return null;
  }

  body.querySelector('#msg-send').onclick = () => {
    const bodyText = textEl.value.trim();
    if (!bodyText) { toast('Message cannot be empty.', 'err'); return; }
    const who = describeSendTarget();
    if (!who) return; // describeSendTarget already toasted why
    const { segments } = smsCount(bodyText);
    const ccNote = (sel.ccEnabled && sel.ccStaffIds.length) ? ` A copy also goes to ${sel.ccStaffIds.length} staff member(s).` : '';
    confirmAction(
      `Send this message (${segments} SMS segment${segments > 1 ? 's' : ''} each) to ${who}?${ccNote}`,
      async () => {
        const payload = { scope: sel.scope, body: bodyText, class_id: sel.class_id, student_id: sel.student_id, staff_id: sel.staff_id };
        const r = await Db.messaging.send(payload);

        let ccResult = null;
        if (r.ok && sel.ccEnabled && sel.ccStaffIds.length) {
          const ccRecipients = sel.ccStaffIds
            .map((id) => staff.find((s) => s.id === id))
            .filter((s) => s && s.phone)
            .map((s) => ({ staff_id: s.id, phone: s.phone, body: bodyText }));
          if (ccRecipients.length) {
            ccResult = await Db.messaging.send({ scope: 'personalized', scope_label: 'Copy of a message', recipients: ccRecipients });
          }
        }

        if (!r.ok) { toast(r.message, 'err'); return; }
        let msg = r.message || `Sent to ${r.recipients} recipient(s).`;
        if (ccResult) msg += ccResult.ok ? ` Copy sent to ${sel.ccStaffIds.length} staff.` : ` (Copy failed: ${ccResult.message})`;
        toast(msg, r.delivered ? 'ok' : 'warn');
        sel.body = ''; sel.ccEnabled = false; sel.ccStaffIds = [];
        renderCompose(body, data, sel, root);
      }
    );
  };
}

function renderPlainTarget(targetEl, data, sel, onChange) {
  const { classes, students, staff } = data;
  if (sel.scope === 'class') {
    targetEl.innerHTML = `<label class="f-lab">Class</label><select id="msg-class">${options(classes, 'id', 'name', sel.class_id)}</select>`;
    targetEl.querySelector('#msg-class').onchange = (e) => { sel.class_id = e.target.value; onChange(); };
  } else if (sel.scope === 'individual_student') {
    targetEl.innerHTML = `<label class="f-lab">Student</label><select id="msg-student">${options(students, 'id', 'full_name', sel.student_id, 'Choose a student')}</select>`;
    targetEl.querySelector('#msg-student').onchange = (e) => { sel.student_id = e.target.value; onChange(); };
  } else if (sel.scope === 'individual_staff') {
    targetEl.innerHTML = `<label class="f-lab">Staff member</label><select id="msg-staff">${options(staff, 'id', 'full_name', sel.staff_id, 'Choose a staff member')}</select>`;
    targetEl.querySelector('#msg-staff').onchange = (e) => { sel.staff_id = e.target.value; onChange(); };
  } else {
    // Broadcast needs no target picker — and no explanation either, per
    // direct feedback that the old restating-the-obvious hint here
    // ("This will message every guardian...") wasn't needed.
    targetEl.innerHTML = '';
  }
}

// ===========================================================================
// EXAM RESULTS (items 2, 3 & 6) — the standard template, an optional custom
// note, whole-class OR one-student sending, and an instant "Processed"
// confirmation with no navigation away and no waiting on real delivery.
// ===========================================================================
function renderResultsTarget(targetEl, data, sel, root, body) {
  const { classes, exams } = data;
  if (!exams.length) {
    targetEl.innerHTML = `<p class="hint" style="margin:0">No exams found — create one under Exams first.</p>`;
    return;
  }
  targetEl.innerHTML = `
    <label class="f-lab">Exam</label><select id="msg-exam">${options(exams, 'id', 'name', sel.exam_id)}</select>
    <label class="f-lab" style="margin-top:10px;display:block">Class</label><select id="msg-class">${options(classes, 'id', 'name', sel.class_id)}</select>
    <label class="f-lab" style="margin-top:10px;display:block">Send to</label>
    <div class="mode-toggle">
      <button data-mode="class" class="${sel.resultsMode !== 'student' ? 'on' : ''}">Whole class</button>
      <button data-mode="student" class="${sel.resultsMode === 'student' ? 'on' : ''}">One student</button>
    </div>
    <div id="msg-results-student" style="margin-top:10px"></div>
  `;
  targetEl.querySelector('#msg-exam').onchange = (e) => { sel.exam_id = e.target.value; renderCompose(body, data, sel, root); };
  targetEl.querySelector('#msg-class').onchange = (e) => { sel.class_id = e.target.value; sel.resultsStudentId = ''; renderCompose(body, data, sel, root); };
  targetEl.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
    sel.resultsMode = b.dataset.mode;
    renderCompose(body, data, sel, root);
  });

  const studentEl = targetEl.querySelector('#msg-results-student');
  if (sel.resultsMode === 'student') {
    const classStudents = data.students.filter((s) => s.class_id === sel.class_id);
    studentEl.innerHTML = `<select id="msg-results-student-sel">${options(classStudents, 'id', 'full_name', sel.resultsStudentId, 'Choose a student')}</select>`;
    studentEl.querySelector('#msg-results-student-sel').onchange = (e) => { sel.resultsStudentId = e.target.value; renderResultsSendCard(body.querySelector('#msg-second-block'), data, sel, root, body); };
  }
}

/** Builds the exact per-student template from Messaging_Overhaul.docx item
 *  3, from one getBroadsheet() row — everything BUT the school-name header
 *  line (send-message.js adds that itself, once, for every message — item
 *  2). `customNote` is appended as its own trailing line when given. */
function buildResultsMessage(bs, row, examLabel, className, customNote) {
  const posLabel = row.position ? `${row.position} of ${bs.students.length}` : 'not ranked';
  const totalPossible = (Number(bs.exam.out_of) || 100) * (row.counted || 0);
  const lines = [
    'Dear Parent,',
    '',
    examLabel,
    '',
    `NAME: ${row.full_name}`,
    `FORM: ${className}`,
    `GRADE: ${row.overall_grade || '—'}`,
    `MN MKS: ${row.average}`,
    `TT MKS: ${Math.round(row.total)} / ${totalPossible}`,
    ''
  ];
  bs.subjects.forEach((s) => {
    const score = row.scores[s.id];
    if (score === null || score === undefined) return;
    const g = row.grades[s.id];
    lines.push(`${(s.code || s.name).toUpperCase()}: ${Math.round(score)} ${(g && g.grade_label) || ''}`.trim());
  });
  if (String(customNote || '').trim()) { lines.push(''); lines.push(String(customNote).trim()); }
  // Position isn't part of the brief's field list verbatim, but it's the
  // one thing the OLD per-guardian summary had that's genuinely worth
  // keeping — tacked on as its own trailing context line, after the note.
  lines.push('', `Position: ${posLabel}.`);
  return lines.join('\n');
}

function renderResultsSendCard(el, data, sel, root, body) {
  el.innerHTML = `
    <div class="card side-accent tile-indigo compose-block">
      <div class="card-b" id="msg-results-preview-box">${loader()}</div>
      <div class="card-b" style="border-top:1px solid var(--line)">
        <label class="f-lab">Optional message <span class="muted" style="text-transform:none;font-weight:500">(added to every message in this batch)</span></label>
        <textarea id="msg-results-note" rows="2" placeholder="e.g. Opening date 14th, please come accompanied by your parent.">${esc(sel.customNote || '')}</textarea>
      </div>
      <div class="card-b" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line)">
        <div class="muted" style="font-size:13px" id="msg-results-count"></div>
        <button class="btn" id="msg-results-send">Send results</button>
      </div>
      <div id="msg-results-processed"></div>
    </div>
  `;
  el.querySelector('#msg-results-note').oninput = (e) => { sel.customNote = e.target.value; };

  const cls = data.classes.find((c) => c.id === sel.class_id);
  const exam = data.exams.find((e) => e.id === sel.exam_id);
  if (!exam || !cls) {
    // Previously just `return` here, leaving the loader spinner from the
    // markup above on screen forever with no way out — an admin picking an
    // exam/class combo that doesn't resolve (e.g. stale selection) saw an
    // endless spinner and no error at all.
    el.querySelector('#msg-results-preview-box').innerHTML = `⚠️ Couldn't find that exam/class — pick them again above.`;
    return;
  }
  const examLabel = `${exam.name}${exam.term_name ? `, ${exam.term_name}` : ''}${exam.academic_year_name ? ` ${exam.academic_year_name}` : ''}`;

  Db.results.getBroadsheet({ exam_id: sel.exam_id, class_id: sel.class_id }).then((bsRes) => {
    const previewBox = el.querySelector('#msg-results-preview-box');
    const countEl = el.querySelector('#msg-results-count');
    if (!bsRes.ok) { previewBox.innerHTML = `⚠️ ${esc(bsRes.message)}`; return; }
    const bs = bsRes.data;
    let rows = bs.students.filter((r) => r.counted > 0);
    if (sel.resultsMode === 'student') rows = rows.filter((r) => r.student_id === sel.resultsStudentId);
    const withPhone = rows.filter((r) => {
      const s = data.students.find((x) => x.id === r.student_id);
      return s && s.guardian_contact;
    });

    if (!rows.length) {
      previewBox.innerHTML = sel.resultsMode === 'student'
        ? `<p class="hint" style="margin:0">Choose a student above — this one has no marks recorded for this exam yet.</p>`
        : `<p class="hint" style="margin:0">No students in this class have marks recorded for this exam yet.</p>`;
      countEl.textContent = '';
      el.querySelector('#msg-results-send').disabled = true;
      return;
    }

    const previewRow = rows[0];
    const previewMsg = buildResultsMessage(bs, previewRow, examLabel, cls.name, sel.customNote);
    const schoolName = (state.settings && state.settings.school_name) || 'Your School';
    previewBox.innerHTML = `
      <label class="f-lab">Preview — ${esc(previewRow.full_name)}</label>
      <div class="sms-preview"><b>${esc(schoolName.toUpperCase())}</b>\n\n${esc(previewMsg)}</div>
    `;
    countEl.textContent = `${withPhone.length} of ${rows.length} ${sel.resultsMode === 'student' ? 'student' : 'students'} with a guardian number on file will be sent.`;

    el.querySelector('#msg-results-send').onclick = () => {
      const who = sel.resultsMode === 'student' ? previewRow.full_name + "'s guardian" : `${withPhone.length} guardian(s) in ${cls.name}`;
      confirmAction(`Send exam results to ${who}?`, async () => {
        const recipients = withPhone.map((r) => {
          const s = data.students.find((x) => x.id === r.student_id);
          return { student_id: r.student_id, phone: s.guardian_contact, body: buildResultsMessage(bs, r, examLabel, cls.name, sel.customNote) };
        });
        const res = await Db.messaging.send({
          scope: 'personalized',
          scope_label: `${exam.name} Results — ${cls.name}`,
          recipients
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        const skipped = rows.length - withPhone.length;
        el.querySelector('#msg-results-processed').innerHTML = `
          <div class="card-b processed-toast"><span class="ico">✓</span>
            Processed — ${withPhone.length} of ${rows.length} queued for sending${skipped ? ` (${skipped} have no guardian number on file)` : ''}. Check SMS History for delivery.
          </div>`;
      });
    };
  }).catch((e) => {
    // A network hiccup, or a genuine bug in the block above, used to leave
    // the loader spinner from the markup at the top of this function
    // spinning forever with nothing in the console an admin could report
    // back — this at least turns it into a visible, actionable error.
    console.error('renderResultsSendCard: failed to load results for messaging', e);
    const previewBox = el.querySelector('#msg-results-preview-box');
    if (previewBox) previewBox.innerHTML = `⚠️ Something went wrong loading results for this class. Try again — if it keeps happening, note the exam and class and let support know.`;
  });
}

// ===========================================================================
// SMS HISTORY (items 7 & 8) — a scannable table, and a per-recipient batch
// detail view with a resend action for anything that failed.
// ===========================================================================
async function renderHistory(body, data) {
  body.innerHTML = `<div class="card side-accent tile-indigo"><div id="msg-hist-list">${loader()}</div></div>`;
  const listEl = body.querySelector('#msg-hist-list');
  const res = await Db.messaging.history(200);
  if (!res.ok) { listEl.innerHTML = `<div class="card-b">⚠️ ${esc(res.message)}</div>`; return; }
  const batches = groupMessagesByBatch(res.data);
  if (!batches.length) { listEl.innerHTML = `<div class="card-b"><div class="empty"><div class="e-ico">💬</div><h3>No messages sent yet</h3><p>Sends will show up here once you compose one.</p></div></div>`; return; }

  const staffById = {}; (data.staff || []).forEach((s) => { staffById[s.id] = s.full_name; });
  const senderOf = (b) => staffById[b.sent_by] || '—';
  const typeLabelOf = (b) => (b.recipient_scope === 'personalized' ? 'Personalized' : 'SMS');

  listEl.innerHTML = `
    <div class="mh-desktop-view"><div class="table-wrap"><table class="data compact">
      <thead><tr><th>Title</th><th>Sender</th><th>Type</th><th class="num">Recipients</th><th class="num">Delivered</th><th class="num">Failed</th><th class="num">Credits</th><th>Date</th><th></th></tr></thead>
      <tbody>${batches.map((b, i) => `<tr>
        <td>${esc(b.scope_label || b.recipient_scope)}</td>
        <td class="muted">${esc(senderOf(b))}</td>
        <td><span class="badge blue">${esc(typeLabelOf(b))}</span></td>
        <td class="num">${b.recipients.length}</td>
        <td class="num">${b.counts.sent}</td>
        <td class="num">${b.counts.failed ? `<span style="color:var(--danger);font-weight:650">${b.counts.failed}</span>` : '0'}</td>
        <td class="num">${b.credits}</td>
        <td class="muted" style="font-size:12px;white-space:nowrap">${fmtDate(b.created_at)}</td>
        <td><button class="btn ghost sm" data-view="${i}">View</button></td>
      </tr>`).join('')}</tbody>
    </table></div></div>
    <div class="mh-mobile-view">${batches.map((b, i) => `
      <div class="mh-card" data-view="${i}">
        <div class="mh-card-top">
          <div>
            <div style="font-weight:650">${esc(b.scope_label || b.recipient_scope)}</div>
            <div class="muted" style="font-size:12px;margin-top:2px">${esc(senderOf(b))} · ${fmtDate(b.created_at)}</div>
          </div>
          <span class="badge blue">${esc(typeLabelOf(b))}</span>
        </div>
        <div class="mh-card-stats">
          <div><b>${b.recipients.length}</b><span>Recipients</span></div>
          <div><b style="color:var(--ok)">${b.counts.sent}</b><span>Delivered</span></div>
          <div><b style="color:${b.counts.failed ? 'var(--danger)' : 'var(--muted)'}">${b.counts.failed}</b><span>Failed</span></div>
          <div><b>${b.credits}</b><span>Credits</span></div>
        </div>
      </div>`).join('')}
    </div>
  `;
  listEl.querySelectorAll('[data-view]').forEach((el) => el.onclick = () => openBatchDetail(batches[Number(el.dataset.view)], body, data));
}

/** Item 8 — clicking View opens this: individual delivery status, credits
 *  per message, delivery info, and a resend option for anything failed. */
function openBatchDetail(batch, body, data) {
  // provider_response is already plain English by the time it reaches here
  // (see smsProvider.js's friendlyDeliveryText) — no ids, no raw JSON. A
  // failed delivery's reason is shown in red so it reads as a problem at a
  // glance, not just more grey text next to everything that succeeded.
  const rowHtml = (r) => `<tr data-row-id="${esc(r.id)}">
      <td style="white-space:nowrap">${esc(r.phone || '—')}</td>
      <td><span class="badge ${STATUS_BADGE[r.status] || 'grey'}">${esc(r.status)}</span></td>
      <td class="num">${esc(String(r.credits ?? 1))}</td>
      <td style="font-size:12.5px;max-width:260px${r.status === 'failed' ? ';color:var(--danger);font-weight:600' : ''}" class="${r.status === 'failed' ? '' : 'muted'}">${esc(r.provider_response || (r.status === 'queued' ? 'Waiting to send…' : '—'))}</td>
      <td>${r.status === 'failed' ? `<button class="btn ghost sm" data-resend="${esc(r.id)}">Resend</button>` : ''}</td>
    </tr>`;

  modal({
    title: batch.scope_label || batch.recipient_scope,
    wide: true,
    footer: false,
    body: `
      <div class="mh-detail-meta">
        <div><span class="muted">Recipients</span><b>${batch.recipients.length}</b></div>
        <div><span class="muted">Delivered</span><b style="color:var(--ok)">${batch.counts.sent}</b></div>
        <div><span class="muted">Failed</span><b style="color:${batch.counts.failed ? 'var(--danger)' : 'var(--ink)'}">${batch.counts.failed}</b></div>
        <div><span class="muted">Credits used</span><b>${batch.credits}</b></div>
      </div>
      ${batch.counts.failed ? `<div style="text-align:right;margin-bottom:10px"><button class="btn sm" id="mh-resend-all">Resend all failed (${batch.counts.failed})</button></div>` : ''}
      <div class="table-wrap"><table class="data compact">
        <thead><tr><th>Phone</th><th>Status</th><th class="num">Credits</th><th>Delivery info</th><th></th></tr></thead>
        <tbody>${batch.recipients.map(rowHtml).join('')}</tbody>
      </table></div>
    `
  });

  const doResend = async (ids, btn) => {
    await withBusy(btn, async () => {
      const res = await Db.messaging.resend(ids);
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast(`Resent ${res.resent} message(s) — check back shortly for the outcome.`, 'ok');
      closeModal();
      renderHistory(body, data);
    }, 'Resending…');
  };
  document.querySelectorAll('[data-resend]').forEach((btn) => btn.onclick = () => doResend([btn.dataset.resend], btn));
  const resendAll = document.getElementById('mh-resend-all');
  if (resendAll) resendAll.onclick = () => doResend(batch.recipients.filter((r) => r.status === 'failed').map((r) => r.id), resendAll);
}
