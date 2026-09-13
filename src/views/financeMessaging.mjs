/**
 * financeMessaging.mjs — Finance Expansion brief item 6 ("Finance-specific
 * Messaging customization"). Explicitly NOT a new messaging system: it
 * calls the exact same Db.messaging.send() the main Messaging module uses
 * (same Netlify function, same message_logs table, same SMS balance/
 * credits — none of that is touched here), just with fee-flavored
 * templates and Finance's own context (a student's real balance, or every
 * student in a class who currently has one) pre-filled in, so a bursar
 * doesn't have to go copy a balance figure from Reports into a blank
 * message on the general Messaging screen by hand.
 *
 * Two built-in templates (Fee Reminder / Arrears Notice) — editable per
 * send, not persisted as a new setting; Preferences already owns the one
 * persisted template (the receipt SMS) and this phase doesn't need a
 * second one to be useful.
 */
import { esc, options, toast, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { fillTemplate } from './financePreferences.mjs';

const TEMPLATES = {
  reminder: {
    label: 'Fee Reminder',
    body: "Dear parent/guardian, this is a reminder that {student}'s school fees balance currently stands at KES {balance}. Kindly clear this balance at your earliest convenience. Thank you - {school}."
  },
  arrears: {
    label: 'Arrears Notice',
    body: 'Dear parent/guardian, {student} has outstanding fee arrears of KES {balance}. Please settle this balance as soon as possible to avoid any disruption to learning. Thank you - {school}.'
  }
};

export async function viewFinanceMessaging(root, access) {
  root.innerHTML = loader();
  const [classesRes, settingsRes] = await Promise.all([Db.classes.list(), Db.settings.get()]);
  const classes = classesRes.ok ? classesRes.data : [];
  const schoolName = (settingsRes.ok && settingsRes.data.school_name) || '';
  render(root, access, classes, schoolName, { template: 'reminder', mode: 'student', class_id: '' });
}

function render(root, access, classes, schoolName, sel) {
  const tpl = TEMPLATES[sel.template];
  root.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>1. Choose a template</h3></div>
      <div class="card-b">
        <div class="fin-filters" style="margin-bottom:10px">
          ${Object.keys(TEMPLATES).map((k) => `<button class="btn ${k === sel.template ? '' : 'secondary'} sm" data-tpl="${k}">${esc(TEMPLATES[k].label)}</button>`).join('')}
        </div>
        <div class="field">
          <label>Message (editable — {student}, {balance} and {school} are filled in per recipient)</label>
          <textarea id="fm-body" rows="4">${esc(tpl.body)}</textarea>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>2. Who should get it?</h3></div>
      <div class="card-b">
        <div class="fin-filters" style="margin-bottom:10px">
          <button class="btn ${sel.mode === 'student' ? '' : 'secondary'} sm" data-mode="student">One Student</button>
          <button class="btn ${sel.mode === 'class' ? '' : 'secondary'} sm" data-mode="class">A Class — everyone with a balance</button>
        </div>
        <div id="fm-target"></div>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-tpl]').forEach((b) => b.onclick = () => render(root, access, classes, schoolName, { ...sel, template: b.dataset.tpl }));
  root.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => render(root, access, classes, schoolName, { ...sel, mode: b.dataset.mode }));

  const bodyEl = root.querySelector('#fm-body');
  const targetEl = root.querySelector('#fm-target');

  if (sel.mode === 'student') {
    renderStudentTarget(targetEl, bodyEl, schoolName);
  } else {
    renderClassTarget(targetEl, bodyEl, classes, schoolName, sel);
  }
}

function renderStudentTarget(targetEl, bodyEl, schoolName) {
  let selected = null;
  targetEl.innerHTML = `
    <div class="field" style="position:relative;max-width:420px"><label>Student</label>
      <input id="fm-q" placeholder="Type a name or admission no.…" autocomplete="off">
      <div id="fm-results" class="search-results"></div>
    </div>
    <div id="fm-preview"></div>
  `;
  const qEl = targetEl.querySelector('#fm-q');
  const resultsEl = targetEl.querySelector('#fm-results');
  const previewEl = targetEl.querySelector('#fm-preview');
  let t = null;
  qEl.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = qEl.value.trim();
      if (!q.length) { resultsEl.innerHTML = ''; return; }
      const r = await Db.finance.students.search(q);
      const list = r.ok ? r.data : [];
      resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('')
        + (list.length === 30 ? `<div class="muted" style="padding:6px;font-style:italic">Showing first 30 matches — type more of the name or admission number to narrow it down.</div>` : '')
        || `<div class="muted" style="padding:6px">No student found matching "${esc(q)}".</div>`;
      resultsEl.querySelectorAll('[data-id]').forEach((h) => h.onclick = async () => {
        selected = list.find((s) => s.id === h.dataset.id);
        resultsEl.innerHTML = '';
        qEl.value = selected.full_name;
        await showPreview();
      });
    }, 250);
  };

  const showPreview = async () => {
    if (!selected) { previewEl.innerHTML = ''; return; }
    previewEl.innerHTML = loader();
    const balRes = await Db.finance.students.balance(selected.id);
    const balance = balRes.ok ? Number(balRes.data.balance || 0) : 0;
    if (!selected.guardian_contact) {
      previewEl.innerHTML = `<div class="card pad" style="margin-top:10px"><p class="muted" style="margin:0">${esc(selected.full_name)} has no guardian contact on file — add one in Students first.</p></div>`;
      return;
    }
    const message = fillTemplate(bodyEl.value, { student: selected.full_name, balance: balance.toLocaleString(), school: schoolName });
    previewEl.innerHTML = `
      <div class="card side-accent tile-teal" style="margin-top:10px"><div class="card-b">
        <p style="margin:0 0 6px"><b>${esc(selected.full_name)}</b> — Balance: KES ${balance.toLocaleString()}</p>
        <p class="muted" style="margin:0 0 10px;white-space:pre-wrap">${esc(message)}</p>
        <button class="btn" id="fm-send-one">Send SMS</button>
      </div></div>
    `;
    previewEl.querySelector('#fm-send-one').onclick = async () => {
      const btn = previewEl.querySelector('#fm-send-one');
      btn.disabled = true; btn.textContent = 'Sending…';
      const res = await Db.messaging.send({ scope: 'individual_student', student_id: selected.id, body: fillTemplate(bodyEl.value, { student: selected.full_name, balance: balance.toLocaleString(), school: schoolName }) });
      btn.disabled = false; btn.textContent = 'Send SMS';
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast(`Sent to ${selected.full_name}'s guardian.`, 'ok');
    };
  };

  // Re-render the preview whenever the template text itself is edited,
  // so what's shown always matches what Send will actually deliver.
  bodyEl.oninput = () => { if (selected) showPreview(); };
}

function renderClassTarget(targetEl, bodyEl, classes, schoolName, sel) {
  targetEl.innerHTML = `
    <div class="field" style="max-width:320px"><label>Class</label>
      <select id="fm-class">${options(classes, 'id', 'name', sel.class_id)}</select>
    </div>
    <div id="fm-class-preview"></div>
  `;
  const classSel = targetEl.querySelector('#fm-class');
  const previewEl = targetEl.querySelector('#fm-class-preview');

  // POST-BUILD AUDIT (Task #49): switching classes fast (or editing the
  // template while a fetch for the previous class was still in flight)
  // could let a slower, stale response land AFTER a newer one and overwrite
  // the preview — showing class A's recipients under a Send button that's
  // now labeled for class B. This generation counter makes a stale response
  // a no-op instead of a silent data mismatch.
  let loadGeneration = 0;
  const load = async () => {
    const classId = classSel.value;
    const myGen = ++loadGeneration;
    if (!classId) { previewEl.innerHTML = ''; return; }
    previewEl.innerHTML = loader();
    const [balancesRes, studentsRes] = await Promise.all([
      Db.finance.reports.classBalances(classId, 0),
      Db.students.list({ class_id: classId })
    ]);
    if (myGen !== loadGeneration) return; // a newer load has since started — discard this stale result
    const owing = balancesRes.ok ? balancesRes.data : [];
    const contactById = new Map((studentsRes.ok ? studentsRes.data : []).map((s) => [s.id, s.guardian_contact]));
    const recipients = owing
      .map((r) => ({ ...r, guardian_contact: contactById.get(r.student_id) }))
      .filter((r) => r.guardian_contact);
    const skippedNoContact = owing.length - recipients.length;

    if (!owing.length) {
      previewEl.innerHTML = `<div class="card pad" style="margin-top:10px"><p class="muted" style="margin:0">Nobody in this class currently has an outstanding balance.</p></div>`;
      return;
    }
    previewEl.innerHTML = `
      <div class="card side-accent tile-amber" style="margin-top:10px"><div class="card-b">
        <p style="margin:0 0 10px">${recipients.length} student(s) in this class have an outstanding balance and a guardian contact on file${skippedNoContact ? ` (${skippedNoContact} more have a balance but no contact on file, so they'll be skipped)` : ''}.</p>
        <div class="table-wrap" style="max-height:260px;overflow:auto;margin-bottom:10px"><table class="data">
          <thead><tr><th>Student</th><th>Balance</th></tr></thead>
          <tbody>${recipients.map((r) => `<tr><td>${esc(r.full_name)}</td><td>KES ${Number(r.balance).toLocaleString()}</td></tr>`).join('')}</tbody>
        </table></div>
        <button class="btn" id="fm-send-class" ${recipients.length ? '' : 'disabled'}>Send to ${recipients.length} Guardian(s)</button>
      </div></div>
    `;
    previewEl.querySelector('#fm-send-class').onclick = async () => {
      const btn = previewEl.querySelector('#fm-send-class');
      btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
      const classObj = classes.find((c) => c.id === classId);
      const messageRecipients = recipients.map((r) => ({
        student_id: r.student_id, phone: r.guardian_contact,
        body: fillTemplate(bodyEl.value, { student: r.full_name, balance: Number(r.balance).toLocaleString(), school: schoolName })
      }));
      const res = await Db.messaging.send({ scope: 'personalized', scope_label: `Fee reminder — ${classObj ? classObj.name : 'Class'}`, recipients: messageRecipients });
      btn.disabled = false; btn.textContent = label;
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast(`Sent to ${messageRecipients.length} guardian(s).`, 'ok');
    };
  };

  classSel.onchange = load;
  bodyEl.oninput = () => { if (classSel.value) load(); };
  if (sel.class_id) load();
}
