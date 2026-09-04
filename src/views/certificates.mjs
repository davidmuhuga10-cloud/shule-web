import { esc, options, renderPrereq, renderPrereqOrConnectivity, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { LEAVING_REASON_LABELS } from '../lib/api/students.mjs';

/** Leaving/Transfer Certificate — pulls bio-data plus (if the student has
 *  already been archived from the Students screen) their leaving reason,
 *  date and notes straight from those fields. A still-active student can
 *  also have one printed ahead of time by filling the reason/date in here —
 *  that's for printing purposes only and isn't saved back to their record;
 *  archive them from the Students screen when it's official. */
export async function viewCertificates(root) {
  // Perf/UX fix: paint the page shell instantly instead of leaving the
  // router's bare spinner up for the full round trip — see examDesk.mjs's
  // viewExamDesk for the fuller explanation of why this matters.
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Leaving / Transfer Certificate</h2><p>Choose a student to generate a printable certificate.</p></div></div>
    <div class="card"><div class="card-b">
      <div class="skeleton" style="width:100%;height:60px;margin-bottom:12px"></div>
      <div class="skeleton" style="width:100%;height:60px"></div>
    </div></div>
  `;
  const classesRes = await Db.classes.list();
  // Round 6 §5 (recurring BUG): see examAnalysis.mjs for the full story.
  if (!classesRes.ok) { renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewCertificates(root) }); return; }
  const classes = classesRes.data;
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  render(root, classes);
}

function render(root, classes) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Leaving / Transfer Certificate</h2><p>Choose a student to generate a printable certificate.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Class</label><select id="ct-class">${options(classes, 'id', 'name', '', 'Choose a class')}</select></div>
        <div class="field"><label>Student</label><select id="ct-student" disabled><option value="">Choose a class first</option></select></div>
      </div>
    </div>
    <div id="ct-body"></div>
  `;

  root.querySelector('#ct-class').onchange = async (e) => {
    const cid = e.target.value;
    const studentSel = root.querySelector('#ct-student');
    root.querySelector('#ct-body').innerHTML = '';
    if (!cid) { studentSel.disabled = true; studentSel.innerHTML = '<option value="">Choose a class first</option>'; return; }
    const [activeRes, archivedRes] = await Promise.all([
      Db.students.list({ class_id: cid, status: 'active' }), Db.students.list({ class_id: cid, status: 'left' })
    ]);
    const students = [...(activeRes.ok ? activeRes.data : []), ...(archivedRes.ok ? archivedRes.data : [])];
    studentSel.disabled = false;
    studentSel.innerHTML = options(
      students.map((s) => ({ id: s.id, name: `${s.admission_no} — ${s.full_name}${s.status === 'left' ? ' (Left)' : ''}` })),
      'id', 'name', '', 'Choose a student'
    );
    studentSel.onchange = () => { if (studentSel.value) loadForm(root, studentSel.value); else root.querySelector('#ct-body').innerHTML = ''; };
  };
}

async function loadForm(root, studentId) {
  const bodyEl = root.querySelector('#ct-body');
  bodyEl.innerHTML = loader();
  const res = await Db.students.get(studentId);
  if (!res.ok) { bodyEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const student = res.data;
  const isArchived = student.status === 'left';
  const reasonChoices = Object.keys(LEAVING_REASON_LABELS).map((k) => ({ id: k, name: LEAVING_REASON_LABELS[k] }));

  bodyEl.innerHTML = `
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b">
        ${isArchived
          ? `<p class="hint">This student is already archived — using their recorded leaving details below.</p>`
          : `<p class="hint">This student is still active. Fill in a reason/date for printing purposes only — this won't change their record. Archive them from the Students screen once it's official.</p>`}
        <div class="grid3">
          <div class="field"><label>Reason</label><select id="ct-reason" ${isArchived ? 'disabled' : ''}>${options(reasonChoices, 'id', 'name', student.left_reason || 'transferred')}</select></div>
          <div class="field"><label>Date left</label><input id="ct-date" type="date" value="${esc(student.left_date || new Date().toISOString().slice(0, 10))}" ${isArchived ? 'disabled' : ''}></div>
          <div class="field"><label>Notes (optional)</label><input id="ct-notes" value="${esc(student.left_notes || '')}" ${isArchived ? 'disabled' : ''}></div>
        </div>
      </div>
    </div>
    <div id="ct-certificate"></div>
  `;

  const renderCert = async () => {
    const settingsRes = await Db.settings.get();
    const settings = settingsRes.ok ? settingsRes.data : {};
    const reason = document.getElementById('ct-reason').value;
    const dateLeft = document.getElementById('ct-date').value;
    const notes = document.getElementById('ct-notes').value;
    const logoHtml = settings.logo ? `<img class="logo-thumb" src="${esc(settings.logo)}">` : `<div class="logo-placeholder">🏫</div>`;

    document.getElementById('ct-certificate').innerHTML = `
      <div class="card">
        <div class="card-b" style="display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:16px">
          ${logoHtml}
          <div>
            <h3 style="font-size:18px">${esc(settings.school_name || 'School')}</h3>
            <div class="muted" style="font-size:12.5px">
              ${settings.po_box ? 'P.O. Box ' + esc(settings.po_box) + ' · ' : ''}${settings.phone ? esc(settings.phone) + ' · ' : ''}${esc(settings.email || '')}
            </div>
          </div>
          <div class="spacer"></div>
          <button class="btn secondary no-print" id="ct-print-btn">🖨️ Print</button>
        </div>
        <div class="card-b" style="max-width:640px;margin:0 auto;padding:32px 24px">
          <h2 style="text-align:center;letter-spacing:0.5px;margin-bottom:24px">CERTIFICATE OF LEAVING</h2>
          <p style="line-height:1.9">
            This is to certify that <b>${esc(student.full_name)}</b>
            ${student.gender ? `(${esc(student.gender)})` : ''}, Admission Number <b>${esc(student.admission_no)}</b>${student.date_of_birth ? `, born on <b>${esc(student.date_of_birth)}</b>,` : ','}
            was a bona fide student of this school in <b>${esc(student.class_name || '—')}</b>${student.stream_name ? ` (${esc(student.stream_name)})` : ''}${student.admission_date ? `, having been admitted on <b>${esc(student.admission_date)}</b>,` : ''}
            and left this school on <b>${esc(dateLeft || '—')}</b> due to: <b>${esc(LEAVING_REASON_LABELS[reason] || reason)}</b>.
          </p>
          ${notes ? `<p class="muted">Notes: ${esc(notes)}</p>` : ''}
          <p style="margin-top:32px">This certificate is issued at the request of the parent/guardian for the purpose of transfer to another institution, or as an official record of the student's departure from this school.</p>
          <div style="display:flex;justify-content:space-between;margin-top:64px">
            <div style="text-align:center"><div style="border-top:1px solid #333;width:180px;padding-top:6px">Head Teacher's Signature</div></div>
            <div style="text-align:center"><div style="border-top:1px solid #333;width:180px;padding-top:6px">Date Issued</div></div>
          </div>
          <div style="text-align:center;margin-top:32px" class="muted">(Official School Stamp)</div>
        </div>
      </div>
    `;
    // Security hardening pass: was a literal onclick="window.print()" HTML
    // attribute — inline event-handler attributes are exactly what a
    // strict script-src Content-Security-Policy blocks, so this (like the
    // other two print buttons in transcript.mjs/myResults.mjs) is now
    // wired the same way every other click handler in this codebase
    // already is.
    document.getElementById('ct-print-btn').onclick = () => window.print();
  };

  ['ct-reason', 'ct-date', 'ct-notes'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.disabled) el.onchange = renderCert;
  });
  renderCert();
}
