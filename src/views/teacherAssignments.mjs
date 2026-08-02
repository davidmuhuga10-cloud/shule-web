import { esc, toast, options, confirmAction, renderPrereq } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewTeacherAssignments(root) {
  const [staffRes, subjectsRes, classesRes] = await Promise.all([Db.staff.list(), Db.subjects.list(), Db.classes.list()]);
  const staff = staffRes.ok ? staffRes.data : [];
  const subjects = subjectsRes.ok ? subjectsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];

  if (!staff.length) { renderPrereq(root, 'No staff found', 'Please add a staff member before assigning them to teach.', 'staff', 'Go to Staff'); return; }
  if (!subjects.length) { renderPrereq(root, 'No subjects found', 'Please add subjects first.', 'subjects', 'Go to Subjects'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }

  await render(root, staff, subjects, classes);
}

async function render(root, staff, subjects, classes) {
  const res = await Db.assignments.listTeacherAssignments({});
  const rows = res.ok ? res.data : [];

  root.innerHTML = `
    <div class="page-head"><div><h2>Teacher Assignments</h2><p>Who teaches what, in which class/stream.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Add assignment</h3></div>
      <div class="card-b grid2">
        <div class="field"><label>Teacher</label><select id="ta-staff">${options(staff, 'id', 'full_name', '', 'Choose a teacher')}</select></div>
        <div class="field"><label>Subject</label><select id="ta-subject">${options(subjects, 'id', 'name', '', 'Choose a subject')}</select></div>
        <div class="field"><label>Class</label><select id="ta-class">${options(classes, 'id', 'name', '', 'Choose a class')}</select></div>
        <div class="field"><label>Stream (optional)</label><select id="ta-stream" disabled><option value="">Whole class</option></select></div>
      </div>
      <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn" id="ta-save">+ Add</button></div>
    </div>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Teacher</th><th>Subject</th><th>Class</th><th>Stream</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.staff_name)}</td><td>${esc(r.subject_name)}</td><td>${esc(r.class_name)}</td><td>${esc(r.stream_name || 'Whole class')}</td>
          <td class="row-actions"><button class="icon-btn danger" data-del="${r.id}">🗑️</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : `<div class="card-b"><p class="muted center" style="margin:20px 0">No teacher assignments yet.</p></div>`}
    </div>
  `;

  root.querySelector('#ta-class').onchange = async (e) => {
    const cid = e.target.value;
    const streamSel = root.querySelector('#ta-stream');
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Whole class</option>'; return; }
    const sres = await Db.streams.list(cid);
    const streams = sres.ok ? sres.data : [];
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Whole class</option>' + options(streams, 'id', 'name', '');
  };

  root.querySelector('#ta-save').onclick = async () => {
    const payload = {
      staff_id: root.querySelector('#ta-staff').value,
      subject_id: root.querySelector('#ta-subject').value,
      class_id: root.querySelector('#ta-class').value,
      stream_id: root.querySelector('#ta-stream').value || null
    };
    const res = await Db.assignments.saveTeacherAssignment(payload);
    if (!res.ok) { toast(res.message, 'err'); return; }
    toast('Assignment saved.', 'ok');
    render(root, staff, subjects, classes);
  };

  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction('Remove this assignment?', async () => {
    const r = await Db.assignments.deleteTeacherAssignment(b.dataset.del);
    if (r.ok) { toast('Assignment removed.', 'ok'); render(root, staff, subjects, classes); } else toast(r.message, 'err');
  }, true));
}
