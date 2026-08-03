/**
 * messaging.mjs (view) — compose a message to a class's guardians, a single
 * guardian, a single staff member, or every guardian in the school, plus a
 * history of past sends grouped by batch (see groupMessagesByBatch).
 */
import { esc, options, toast, renderPrereq, loader, fmtDate } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { groupMessagesByBatch } from '../lib/api/messaging.mjs';

const SCOPE_LABELS = {
  class: 'A whole class (guardians)',
  individual_student: 'One student\'s guardian',
  individual_staff: 'One staff member',
  broadcast: 'Every guardian in the school'
};

export async function viewMessaging(root) {
  const [classesRes, studentsRes, staffRes] = await Promise.all([
    Db.classes.list(), Db.students.list({}), Db.staff.list()
  ]);
  const classes = classesRes.ok ? classesRes.data : [];
  const students = studentsRes.ok ? studentsRes.data : [];
  const staff = staffRes.ok ? staffRes.data : [];
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  render(root, { classes, students, staff }, { tab: 'compose', scope: 'class', class_id: classes[0].id, body: '' });
}

function render(root, data, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Messaging</h2><p>Send SMS-style messages to guardians and staff, and review what's been sent.</p></div></div>
    <div class="tabs" style="max-width:320px">
      <button data-tab="compose" class="${sel.tab === 'compose' ? 'active' : ''}">Compose</button>
      <button data-tab="history" class="${sel.tab === 'history' ? 'active' : ''}">History</button>
    </div>
    <div id="msg-body"></div>
  `;
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => render(root, data, { ...sel, tab: b.dataset.tab }));

  const body = root.querySelector('#msg-body');
  if (sel.tab === 'compose') renderCompose(body, data, sel, root);
  else renderHistory(body);
}

function renderCompose(body, data, sel, root) {
  const { classes, students, staff } = data;
  body.innerHTML = `
    <div class="card">
      <div class="card-b">
        <div class="field">
          <label>Send to</label>
          <select id="msg-scope">${Object.entries(SCOPE_LABELS).map(([k, l]) => `<option value="${k}" ${sel.scope === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        </div>
        <div id="msg-target" class="field"></div>
        <div class="field">
          <label>Message</label>
          <textarea id="msg-body-text" rows="5" maxlength="1000" placeholder="Type your message…">${esc(sel.body)}</textarea>
          <div class="hint" id="msg-count">0 / 1000 characters</div>
        </div>
      </div>
      <div class="card-b" style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line)">
        <div class="muted" id="msg-preview" style="font-size:13px"></div>
        <button class="btn" id="msg-send">Send message</button>
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
    } else {
      const count = students.filter((s) => s.guardian_contact).length;
      previewEl.textContent = `Will reach ${count} guardian(s) across the whole school.`;
    }
  }

  body.querySelector('#msg-scope').onchange = (e) => { sel.scope = e.target.value; renderTarget(); updatePreview(); };
  renderTarget();
  updatePreview();

  const textEl = body.querySelector('#msg-body-text');
  const countEl = body.querySelector('#msg-count');
  const updateCount = () => { sel.body = textEl.value; countEl.textContent = `${textEl.value.length} / 1000 characters`; };
  textEl.oninput = updateCount;
  updateCount();

  body.querySelector('#msg-send').onclick = async () => {
    const btn = body.querySelector('#msg-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    const payload = { scope: sel.scope, body: textEl.value, class_id: sel.class_id, student_id: sel.student_id, staff_id: sel.staff_id };
    const r = await Db.messaging.send(payload);
    btn.disabled = false; btn.textContent = 'Send message';
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast(r.message || `Sent to ${r.recipients} recipient(s).`, r.delivered ? 'ok' : 'warn');
    sel.body = ''; textEl.value = ''; updateCount();
  };
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
