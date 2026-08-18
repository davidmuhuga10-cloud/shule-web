/**
 * attendance.mjs (view) — daily marking for students (by class) and staff
 * (whole school), plus a simple per-class attendance-rate summary. Available
 * to both admin and teacher (see NAV in app.js) — Zeraki-style, marking
 * attendance is a day-to-day teacher action, not admin-only.
 */
import { esc, options, toast, renderPrereq, renderPrereqOrConnectivity, loader, state, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { computeAttendanceFlags } from '../lib/staffAttendance.mjs';

const STATUSES = [
  { key: 'present', label: 'Present', cls: 'green' },
  { key: 'absent', label: 'Absent', cls: 'red' },
  { key: 'late', label: 'Late', cls: 'amber' },
  { key: 'excused', label: 'Excused', cls: 'blue' }
];

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export async function viewAttendance(root) {
  const classesRes = await Db.classes.list();
  // Round 6 §5 (recurring BUG): see examAnalysis.mjs for the full story.
  if (!classesRes.ok) { renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewAttendance(root) }); return; }
  const classes = classesRes.data;
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class before marking attendance.', 'classes', 'Go to Classes'); return; }
  render(root, classes, { tab: 'mark-students', class_id: classes[0].id, date: todayStr() });
}

function render(root, classes, sel) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Attendance</h2><p>Mark daily attendance and review class summaries.</p></div></div>
    <div class="fin-tabs">
      <button data-tab="mark-students" class="${sel.tab === 'mark-students' ? 'active' : ''}">Mark Students</button>
      <button data-tab="mark-staff" class="${sel.tab === 'mark-staff' ? 'active' : ''}">Mark Staff</button>
      <button data-tab="staff-sign-in-out" class="${sel.tab === 'staff-sign-in-out' ? 'active' : ''}">Staff Sign In/Out</button>
      <button data-tab="summary" class="${sel.tab === 'summary' ? 'active' : ''}">Class Summary</button>
    </div>
    <div id="att-body"></div>
  `;
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => render(root, classes, { ...sel, tab: b.dataset.tab }));

  const body = root.querySelector('#att-body');
  if (sel.tab === 'mark-students') renderMarkStudents(body, classes, sel);
  else if (sel.tab === 'mark-staff') renderMarkStaff(body, sel);
  else if (sel.tab === 'staff-sign-in-out') renderStaffSignInOut(body, sel);
  else renderSummary(body, classes, sel);
}

async function renderMarkStudents(body, classes, sel) {
  body.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="card-b grid2">
      <div class="field"><label>Class</label><select id="att-class">${options(classes, 'id', 'name', sel.class_id)}</select></div>
      <div class="field"><label>Date</label><input id="att-date" type="date" value="${esc(sel.date)}"></div>
    </div></div>
    <div class="card"><div id="att-roster">${loader()}</div></div>
  `;
  body.querySelector('#att-class').onchange = (e) => renderMarkStudents(body, classes, { ...sel, class_id: e.target.value });
  body.querySelector('#att-date').onchange = (e) => renderMarkStudents(body, classes, { ...sel, date: e.target.value });

  const rosterEl = body.querySelector('#att-roster');
  const res = await Db.attendance.getRosterForDate({ class_id: sel.class_id, date: sel.date });
  const roster = res.ok ? res.data : [];
  if (!res.ok) { rosterEl.innerHTML = `<div class="card-b">⚠️ ${esc(res.message)}</div>`; return; }
  if (!roster.length) { rosterEl.innerHTML = `<div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students</h3><p>No active students in this class.</p></div></div>`; return; }

  const marks = {};
  roster.forEach((r) => { marks[r.student_id] = r.status || ''; });

  rosterEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Admission No.</th><th>Name</th><th colspan="4">Status</th></tr></thead>
    <tbody>${roster.map((r) => `<tr data-row="${r.student_id}">
      <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td>
      ${STATUSES.map((s) => `<td class="num"><button class="status-btn ${s.cls} ${marks[r.student_id] === s.key ? 'on' : ''}" data-student="${r.student_id}" data-status="${s.key}">${s.label}</button></td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div>
  <div class="card-b" style="display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line)">
    <button class="btn secondary" id="att-mark-all-present">Mark all Present</button>
    <button class="btn" id="att-save">Save attendance</button>
  </div>`;

  rosterEl.querySelectorAll('.status-btn').forEach((b) => b.onclick = () => {
    marks[b.dataset.student] = b.dataset.status;
    rosterEl.querySelectorAll(`[data-student="${b.dataset.student}"]`).forEach((x) => x.classList.toggle('on', x === b));
  });

  rosterEl.querySelector('#att-mark-all-present').onclick = () => {
    roster.forEach((r) => { marks[r.student_id] = 'present'; });
    rosterEl.querySelectorAll('.status-btn').forEach((b) => b.classList.toggle('on', b.dataset.status === 'present'));
  };

  const saveAttBtn = rosterEl.querySelector('#att-save');
  saveAttBtn.onclick = () => withBusy(saveAttBtn, async () => {
    const records = Object.keys(marks).filter((sid) => marks[sid]).map((sid) => ({ student_id: sid, status: marks[sid] }));
    if (!records.length) { toast('Mark at least one student first.', 'err'); return; }
    const r = await Db.attendance.saveStudentAttendance({ date: sel.date, class_id: sel.class_id, records, marked_by: state.profile.staff_id });
    if (r.ok) toast(`Attendance saved for ${r.saved} student(s).`, 'ok'); else toast(r.message, 'err');
  }, 'Saving…');
}

async function renderMarkStaff(body, sel) {
  body.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="card-b" style="max-width:280px">
      <div class="field"><label>Date</label><input id="att-staff-date" type="date" value="${esc(sel.date)}"></div>
    </div></div>
    <div class="card"><div id="att-staff-roster">${loader()}</div></div>
  `;
  body.querySelector('#att-staff-date').onchange = (e) => renderMarkStaff(body, { ...sel, date: e.target.value });

  const rosterEl = body.querySelector('#att-staff-roster');
  const res = await Db.attendance.getStaffRosterForDate({ date: sel.date });
  const roster = res.ok ? res.data : [];
  if (!res.ok) { rosterEl.innerHTML = `<div class="card-b">⚠️ ${esc(res.message)}</div>`; return; }
  if (!roster.length) { rosterEl.innerHTML = `<div class="card-b"><div class="empty"><div class="e-ico">👨‍🏫</div><h3>No staff</h3><p>No active staff members yet.</p></div></div>`; return; }

  const marks = {};
  roster.forEach((r) => { marks[r.staff_id] = r.status || ''; });

  rosterEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Name</th><th>Role</th><th colspan="4">Status</th></tr></thead>
    <tbody>${roster.map((r) => `<tr>
      <td>${esc(r.full_name)}</td><td>${esc(r.role || '—')}</td>
      ${STATUSES.map((s) => `<td class="num"><button class="status-btn ${s.cls} ${marks[r.staff_id] === s.key ? 'on' : ''}" data-staff="${r.staff_id}" data-status="${s.key}">${s.label}</button></td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div>
  <div class="card-b" style="display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line)">
    <button class="btn" id="att-staff-save">Save attendance</button>
  </div>`;

  rosterEl.querySelectorAll('.status-btn').forEach((b) => b.onclick = () => {
    marks[b.dataset.staff] = b.dataset.status;
    rosterEl.querySelectorAll(`[data-staff="${b.dataset.staff}"]`).forEach((x) => x.classList.toggle('on', x === b));
  });

  const saveStaffAttBtn = rosterEl.querySelector('#att-staff-save');
  saveStaffAttBtn.onclick = () => withBusy(saveStaffAttBtn, async () => {
    const records = Object.keys(marks).filter((sid) => marks[sid]).map((sid) => ({ staff_id: sid, status: marks[sid] }));
    if (!records.length) { toast('Mark at least one staff member first.', 'err'); return; }
    const r = await Db.attendance.saveStaffAttendance({ date: sel.date, records, marked_by: state.profile.staff_id });
    if (r.ok) toast(`Attendance saved for ${r.saved} staff member(s).`, 'ok'); else toast(r.message, 'err');
  }, 'Saving…');
}

/** Round 3 §19: "Add a new feature under the Attendance module for staff
 *  sign-in and sign-out, capturing the actual time of each... automatically
 *  flag staff who signed in late or left early, based on [admin-]set
 *  [expected] times." A separate tab from "Mark Staff" — that one is the
 *  existing coarse present/absent/late/excused status; this is the actual
 *  clock time each person arrived/left, with the late/early flag computed
 *  (not stored — see staffAttendance.mjs) against the two settings rows
 *  below. Settings are admin-only to CHANGE (the `settings` table's own
 *  RLS enforces that — see reportForms.mjs's term-dates card for the same
 *  pattern), but any staff member can read them and record times. */
async function renderStaffSignInOut(body, sel) {
  body.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="card-b" style="max-width:280px">
      <div class="field"><label>Date</label><input id="att-sio-date" type="date" value="${esc(sel.date)}"></div>
    </div></div>
    <div class="card" style="margin-bottom:16px"><div id="att-sio-expected">${loader()}</div></div>
    <div class="card"><div id="att-sio-roster">${loader()}</div></div>
  `;
  body.querySelector('#att-sio-date').onchange = (e) => renderStaffSignInOut(body, { ...sel, date: e.target.value });

  const settingsRes = await Db.settings.get();
  const settings = settingsRes.ok ? settingsRes.data : {};
  const expectedEl = body.querySelector('#att-sio-expected');
  expectedEl.innerHTML = `
    <div class="card-b">
      <p class="hint" style="margin:0 0 10px">Expected times — staff signing in after arrival or out before departure are flagged below.</p>
      <div class="grid2">
        <div class="field"><label>Expected arrival time</label><input id="att-sio-arrival" type="time" value="${esc(settings.staff_expected_arrival_time || '')}"></div>
        <div class="field"><label>Expected departure time</label><input id="att-sio-departure" type="time" value="${esc(settings.staff_expected_departure_time || '')}"></div>
      </div>
    </div>
    <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn secondary sm" id="att-sio-expected-save">Save expected times</button></div>
  `;
  expectedEl.querySelector('#att-sio-expected-save').onclick = (e) => withBusy(e.currentTarget, async () => {
    const payload = {
      staff_expected_arrival_time: expectedEl.querySelector('#att-sio-arrival').value,
      staff_expected_departure_time: expectedEl.querySelector('#att-sio-departure').value
    };
    const res = await Db.settings.save(payload);
    if (!res.ok) { toast(res.message, 'err'); return; }
    toast('Expected times saved.', 'ok');
    settings.staff_expected_arrival_time = payload.staff_expected_arrival_time;
    settings.staff_expected_departure_time = payload.staff_expected_departure_time;
    renderSignInOutRoster();
  }, 'Saving…');

  const rosterEl = body.querySelector('#att-sio-roster');
  const res = await Db.attendance.getStaffRosterForDate({ date: sel.date });
  const roster = res.ok ? res.data : [];
  if (!res.ok) { rosterEl.innerHTML = `<div class="card-b">⚠️ ${esc(res.message)}</div>`; return; }
  if (!roster.length) { rosterEl.innerHTML = `<div class="card-b"><div class="empty"><div class="e-ico">👨‍🏫</div><h3>No staff</h3><p>No active staff members yet.</p></div></div>`; return; }

  const expected = () => ({
    expected_arrival: expectedEl.querySelector('#att-sio-arrival').value,
    expected_departure: expectedEl.querySelector('#att-sio-departure').value
  });
  function flagHtml(signIn, signOut) {
    const { isLate, leftEarly } = computeAttendanceFlags({ sign_in_time: signIn, sign_out_time: signOut }, expected());
    const badges = [];
    if (isLate) badges.push('<span class="badge red">Late</span>');
    if (leftEarly) badges.push('<span class="badge amber">Left early</span>');
    if (!badges.length && (signIn || signOut)) badges.push('<span class="badge green">On time</span>');
    return badges.join(' ') || '<span class="muted">—</span>';
  }

  function renderSignInOutRoster() {
    rosterEl.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Role</th><th>Sign In</th><th>Sign Out</th><th>Flag</th></tr></thead>
      <tbody>${roster.map((r) => `<tr data-row="${r.staff_id}">
        <td>${esc(r.full_name)}</td><td>${esc(r.role || '—')}</td>
        <td><input type="time" data-signin="${r.staff_id}" value="${esc(r.sign_in_time || '')}" style="max-width:130px"></td>
        <td><input type="time" data-signout="${r.staff_id}" value="${esc(r.sign_out_time || '')}" style="max-width:130px"></td>
        <td class="flag-cell" data-flag="${r.staff_id}">${flagHtml(r.sign_in_time, r.sign_out_time)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="card-b" style="display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line)">
      <button class="btn" id="att-sio-save">Save sign-in/out times</button>
    </div>`;

    const refreshFlag = (staffId) => {
      const signIn = rosterEl.querySelector(`[data-signin="${staffId}"]`).value;
      const signOut = rosterEl.querySelector(`[data-signout="${staffId}"]`).value;
      rosterEl.querySelector(`[data-flag="${staffId}"]`).innerHTML = flagHtml(signIn, signOut);
    };
    rosterEl.querySelectorAll('[data-signin]').forEach((inp) => inp.onchange = () => refreshFlag(inp.dataset.signin));
    rosterEl.querySelectorAll('[data-signout]').forEach((inp) => inp.onchange = () => refreshFlag(inp.dataset.signout));

    const saveBtn = rosterEl.querySelector('#att-sio-save');
    saveBtn.onclick = () => withBusy(saveBtn, async () => {
      // Round 3 §19 / see saveStaffSignInOut's doc comment: every row
      // re-sends BOTH the sign-in and sign-out time currently showing in
      // its inputs (pre-filled from the roster load above), so leaving one
      // field untouched carries its existing value forward instead of
      // clearing it — required anyway since PostgREST's bulk upsert needs
      // a consistent column set across the whole batch.
      const records = roster.map((r) => ({
        staff_id: r.staff_id,
        sign_in_time: rosterEl.querySelector(`[data-signin="${r.staff_id}"]`).value,
        sign_out_time: rosterEl.querySelector(`[data-signout="${r.staff_id}"]`).value
      })).filter((r) => r.sign_in_time || r.sign_out_time);
      if (!records.length) { toast('Record at least one sign-in or sign-out time first.', 'err'); return; }
      const r = await Db.attendance.saveStaffSignInOut({ date: sel.date, records, marked_by: state.profile.staff_id });
      if (r.ok) toast(`Sign-in/out saved for ${r.saved} staff member(s).`, 'ok'); else toast(r.message, 'err');
    }, 'Saving…');
  }

  renderSignInOutRoster();
}

async function renderSummary(body, classes, sel) {
  const from = sel.from || firstOfMonth();
  const to = sel.to || todayStr();
  body.innerHTML = `
    <div class="card" style="margin-bottom:16px"><div class="card-b grid2">
      <div class="field"><label>Class</label><select id="att-sum-class">${options(classes, 'id', 'name', sel.class_id)}</select></div>
      <div></div>
      <div class="field"><label>From</label><input id="att-sum-from" type="date" value="${esc(from)}"></div>
      <div class="field"><label>To</label><input id="att-sum-to" type="date" value="${esc(to)}"></div>
    </div></div>
    <div class="card"><div id="att-sum-body">${loader()}</div></div>
  `;
  body.querySelector('#att-sum-class').onchange = (e) => renderSummary(body, classes, { ...sel, class_id: e.target.value, from, to });
  body.querySelector('#att-sum-from').onchange = (e) => renderSummary(body, classes, { ...sel, from: e.target.value, to });
  body.querySelector('#att-sum-to').onchange = (e) => renderSummary(body, classes, { ...sel, to: e.target.value, from });

  const sumEl = body.querySelector('#att-sum-body');
  const res = await Db.attendance.classSummary({ class_id: sel.class_id, from, to });
  const rows = res.ok ? res.data : [];
  if (!res.ok) { sumEl.innerHTML = `<div class="card-b">⚠️ ${esc(res.message)}</div>`; return; }
  if (!rows.length) { sumEl.innerHTML = `<div class="card-b"><div class="empty"><div class="e-ico">🗓️</div><h3>No attendance recorded</h3><p>No attendance has been marked for this class in this date range yet.</p></div></div>`; return; }

  sumEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Admission No.</th><th>Name</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Late</th><th class="num">Excused</th><th class="num">Rate</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td>
      <td class="num">${r.present}</td><td class="num">${r.absent}</td><td class="num">${r.late}</td><td class="num">${r.excused}</td>
      <td class="num">${r.rate === null ? '—' : `<span class="badge ${r.rate >= 90 ? 'green' : r.rate >= 75 ? 'amber' : 'red'}">${r.rate}%</span>`}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function firstOfMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
}
