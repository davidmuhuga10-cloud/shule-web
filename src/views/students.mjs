import { esc, modal, closeModal, toast, confirmAction, options, renderPrereq, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

function genderBadge(g) {
  return `<span class="badge ${g === 'Female' ? 'red' : 'blue'}">${esc(g)}</span>`;
}

export async function viewStudents(root) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  if (!classes.length) {
    renderPrereq(root, 'No classes found', 'Please create a class before adding students.', 'classes', 'Go to Classes');
    return;
  }
  await render(root, classes, { class_id: '', stream_id: '' });
}

async function render(root, classes, filters) {
  let streams = [];
  if (filters.class_id) {
    const sres = await Db.streams.list(filters.class_id);
    streams = sres.ok ? sres.data : [];
  }

  root.innerHTML = `
    <div class="page-head"><div><h2>Students</h2><p>All enrolled students, ranked by admission number.</p></div>
      <div class="spacer"></div><button class="btn" id="add-student">+ Add student</button></div>
    <div class="toolbar">
      <select id="f-class" class="grow"><option value="">All classes</option>${options(classes, 'id', 'name', filters.class_id)}</select>
      <select id="f-stream" ${filters.class_id ? '' : 'disabled'}><option value="">All streams</option>${options(streams, 'id', 'name', filters.stream_id)}</select>
    </div>
    <div class="card"><div id="student-list">${loader()}</div></div>
  `;

  root.querySelector('#f-class').onchange = (e) => render(root, classes, { class_id: e.target.value, stream_id: '' });
  root.querySelector('#f-stream').onchange = (e) => render(root, classes, { ...filters, stream_id: e.target.value });
  root.querySelector('#add-student').onclick = () => openStudentModal(root, classes, filters);

  const listEl = root.querySelector('#student-list');
  const res = await Db.students.list({ class_id: filters.class_id || undefined, stream_id: filters.stream_id || undefined });
  const list = res.ok ? res.data : [];

  if (!list.length) {
    listEl.innerHTML = `<div class="card-b"><div class="empty">
      <div class="e-ico">🎒</div><h3>No students found</h3>
      <p>${filters.class_id ? 'No students match this filter yet.' : 'Please add students first.'}</p>
      <button class="btn" id="empty-add-student">+ Add student</button>
    </div></div>`;
    const b = listEl.querySelector('#empty-add-student');
    if (b) b.onclick = () => openStudentModal(root, classes, filters);
    return;
  }

  listEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th class="num">#</th><th>Admission No.</th><th>Name</th><th>Gender</th><th>Class</th><th>Stream</th><th></th></tr></thead>
    <tbody>${list.map((s, i) => `<tr>
      <td class="num">${i + 1}</td><td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td>
      <td>${genderBadge(s.gender)}</td><td>${esc(s.class_name)}</td><td>${esc(s.stream_name || '—')}</td>
      <td class="row-actions">
        <button class="icon-btn" data-edit="${s.id}">✏️</button>
        <button class="icon-btn danger" data-del="${s.id}">🗑️</button>
      </td></tr>`).join('')}</tbody>
  </table></div>`;

  listEl.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openStudentModal(root, classes, filters, list.find((s) => s.id === b.dataset.edit)));
  listEl.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction('Delete this student? This also removes their results.', async () => {
    const r = await Db.students.remove(b.dataset.del);
    if (r.ok) { toast('Student deleted.', 'ok'); render(root, classes, filters); } else toast(r.message, 'err');
  }, true));
}

async function openStudentModal(root, classes, filters, existing) {
  let streams = existing ? (await Db.streams.list(existing.class_id)).data || [] : [];
  renderModal(streams, existing ? existing.class_id : filters.class_id || '');

  function renderModal(currentStreams, selectedClass) {
    modal({
      title: existing ? 'Edit student' : 'Add student',
      body: `
        <div class="grid2">
          <div class="field"><label>Admission Number</label><input id="st-adm" value="${esc(existing ? existing.admission_no : '')}"></div>
          <div class="field"><label>Gender</label><select id="st-gender">${options([{ id: 'Male', name: 'Male' }, { id: 'Female', name: 'Female' }], 'id', 'name', existing ? existing.gender : '', 'Choose gender')}</select></div>
        </div>
        <div class="field"><label>Student Name</label><input id="st-name" value="${esc(existing ? existing.full_name : '')}"></div>
        <div class="grid2">
          <div class="field"><label>Class</label><select id="st-class">${options(classes, 'id', 'name', selectedClass, 'Choose a class')}</select></div>
          <div class="field"><label>Stream (optional)</label><select id="st-stream">${options(currentStreams, 'id', 'name', existing ? existing.stream_id : '', 'No stream')}</select></div>
        </div>
        <div class="field"><label>Parent/Guardian Name or Contact</label><input id="st-guardian" value="${esc(existing ? existing.guardian_name || existing.guardian_contact || '' : '')}" placeholder="Name or phone number"></div>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const payload = {
          id: existing ? existing.id : undefined,
          admission_no: document.getElementById('st-adm').value,
          full_name: document.getElementById('st-name').value,
          gender: document.getElementById('st-gender').value,
          class_id: document.getElementById('st-class').value,
          stream_id: document.getElementById('st-stream').value || null,
          guardian_name: document.getElementById('st-guardian').value,
          guardian_contact: document.getElementById('st-guardian').value
        };
        const res = await Db.students.save(payload);
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        if (!existing) {
          const prov = await Db.users.provisionStudentLogin({ student_id: res.data.id, admission_no: res.data.admission_no, full_name: res.data.full_name });
          if (prov && prov.ok && prov.defaultPassword) {
            toast(`Student saved. Login created — default password: ${prov.defaultPassword}`, 'ok');
          } else {
            toast('Student saved. (Login provisioning will be available once the Netlify function is deployed.)', 'warn');
          }
        } else {
          toast('Student saved.', 'ok');
        }
        render(root, classes, filters);
      }
    });

    document.getElementById('st-class').onchange = async (e) => {
      const cid = e.target.value;
      const sres = cid ? await Db.streams.list(cid) : { ok: true, data: [] };
      renderModal(sres.ok ? sres.data : [], cid);
    };
  }
}
