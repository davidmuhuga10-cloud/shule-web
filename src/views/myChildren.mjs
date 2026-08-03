/**
 * myChildren.mjs (view) — parent portal home: pick a linked child, see their
 * basic info, a recent attendance snapshot, and their report cards (reusing
 * the same renderReportCard component the student portal uses — the
 * get_report_card RPC already authorizes a parent for their own linked
 * children server-side, see schema.sql's v_authorized).
 */
import { esc, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { renderReportCard } from './_reportCard.mjs';

export async function viewMyChildren(root) {
  const res = await Db.parents.myChildren();
  const children = res.ok ? res.data : [];

  if (!res.ok) { root.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  if (!children.length) {
    root.innerHTML = `<div class="page-head"><div><h2>My Children</h2></div></div>
      <div class="card pad"><div class="empty"><div class="e-ico">👨‍👩‍👧</div><h3>No children linked yet</h3><p>Ask your school admin to link your account to your child's student record.</p></div></div>`;
    return;
  }

  render(root, children, children[0].id);
}

function render(root, children, selectedId) {
  const child = children.find((c) => c.id === selectedId) || children[0];

  root.innerHTML = `
    <div class="page-head"><div><h2>My Children</h2><p>${children.length > 1 ? 'Choose a child to view their details.' : ''}</p></div></div>
    ${children.length > 1 ? `<div class="card" style="margin-bottom:16px"><div class="card-b" style="max-width:320px">
      <div class="field"><label>Child</label><select id="mc-child">${children.map((c) => `<option value="${c.id}" ${c.id === child.id ? 'selected' : ''}>${esc(c.full_name)}</option>`).join('')}</select></div>
    </div></div>` : ''}
    <div class="card" style="margin-bottom:16px"><div class="card-b">
      <h3 style="margin:0 0 8px">${esc(child.full_name)}</h3>
      <div class="muted" style="font-size:13.5px">Admission No. ${esc(child.admission_no)} · ${esc(child.class_name || 'No class set')}${child.relationship ? ' · ' + esc(child.relationship) : ''}</div>
    </div></div>
    <div class="card" style="margin-bottom:16px"><div class="card-b"><h3 style="margin:0 0 12px">Recent attendance</h3><div id="mc-attendance">${loader()}</div></div></div>
    <div class="card no-print" style="margin-bottom:16px"><div class="card-b">
      <h3 style="margin:0 0 12px">Report cards</h3>
      <div id="mc-exam-picker">${loader()}</div>
    </div></div>
    <div id="mc-card"></div>
  `;

  if (children.length > 1) {
    root.querySelector('#mc-child').onchange = (e) => render(root, children, e.target.value);
  }

  loadAttendance(root, child.id);
  loadExamPicker(root, child.id);
}

async function loadAttendance(root, studentId) {
  const el = root.querySelector('#mc-attendance');
  const to = new Date();
  const from = new Date(); from.setDate(from.getDate() - 30);
  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const res = await Db.attendance.studentHistory({ student_id: studentId, from: fmt(from), to: fmt(to) });
  if (!el) return;
  if (!res.ok) { el.innerHTML = `<p class="muted">Attendance is not available right now.</p>`; return; }
  const rows = res.data || [];
  if (!rows.length) { el.innerHTML = `<p class="muted">No attendance recorded in the last 30 days.</p>`; return; }
  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  rows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status]++; });
  el.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap">
    <span class="badge green">${counts.present} present</span>
    <span class="badge red">${counts.absent} absent</span>
    <span class="badge amber">${counts.late} late</span>
    <span class="badge blue">${counts.excused} excused</span>
  </div><div class="muted" style="font-size:12.5px;margin-top:10px">Last 30 days</div>`;
}

async function loadExamPicker(root, studentId) {
  const pickerEl = root.querySelector('#mc-exam-picker');
  const cardEl = root.querySelector('#mc-card');
  const res = await Db.results.getStudentExams(studentId);
  const exams = res.ok ? res.data : [];
  if (!pickerEl) return;

  if (!exams.length) {
    pickerEl.innerHTML = `<p class="muted">No results have been entered yet.</p>`;
    return;
  }

  pickerEl.innerHTML = `<div class="field" style="max-width:360px">
    <select id="mc-exam"><option value="">Choose an exam</option>${exams.map((e) => `<option value="${e.id}">${esc(e.name)} (${esc(e.academic_year_name)} · ${esc(e.term_name)})</option>`).join('')}</select>
  </div>`;

  pickerEl.querySelector('#mc-exam').onchange = async (e) => {
    if (!e.target.value) { cardEl.innerHTML = ''; return; }
    cardEl.innerHTML = loader();
    const [cardRes, settingsRes, bands] = await Promise.all([Db.results.getReportCard(e.target.value, studentId), Db.settings.get(), Db.grading.defaultScaleBands()]);
    if (!cardRes.ok) { cardEl.innerHTML = `<div class="card pad">⚠️ ${esc(cardRes.message)}</div>`; return; }
    renderReportCard(cardEl, cardRes.data, { settings: settingsRes.ok ? settingsRes.data : {}, bands: bands || [] });
  };
}
