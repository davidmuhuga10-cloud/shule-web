import { esc, modal, closeModal, toast, confirmAction, options } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { STANDARD_CLASS_LEVELS } from '../lib/api/academics.mjs';

export async function viewClasses(root) {
  await render(root);
}

async function render(root) {
  const [res, staffRes] = await Promise.all([Db.classes.list(), Db.staff.list()]);
  const classes = res.ok ? res.data : [];
  const staff = staffRes.ok ? staffRes.data : [];
  const staffMap = {}; staff.forEach((s) => { staffMap[s.id] = s.full_name; });

  const rows = classes.length
    ? classes.map((c) => `<tr>
        <td>${esc(c.name)}</td>
        <td class="num">${c.stream_count}</td>
        <td class="num">${c.student_count}</td>
        <td>${esc(staffMap[c.class_teacher_staff_id] || '—')}</td>
        <td class="row-actions">
          <button class="icon-btn" data-edit="${c.id}">✏️</button>
          <button class="icon-btn danger" data-del="${c.id}">🗑️</button>
        </td></tr>`).join('')
    : '';

  root.innerHTML = `
    <div class="page-head"><div><h2>Classes &amp; Streams</h2><p>Choose from the standard class levels (Daycare through Grade 9) and add streams (class arms) for each.</p></div>
      <div class="spacer"></div><button class="btn" id="add-class">+ Add class</button></div>
    <div class="card">
      ${classes.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Class</th><th class="num">Streams</th><th class="num">Students</th><th>Class Teacher</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<div class="card-b"><div class="empty">
          <div class="e-ico">🏫</div><h3>No classes yet</h3>
          <p>Add your first class from the standard list (e.g. "Grade 7") — you can add its streams at the same time.</p>
          <button class="btn" id="empty-add-class">+ Add class</button>
        </div></div>`}
    </div>`;

  root.querySelector('#add-class').onclick = () => openClassModal(root, undefined, staff, classes);
  const emptyBtn = root.querySelector('#empty-add-class');
  if (emptyBtn) emptyBtn.onclick = () => openClassModal(root, undefined, staff, classes);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openClassModal(root, classes.find((c) => c.id === b.dataset.edit), staff, classes));
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction(
    'Delete this class? This also removes its streams.',
    async () => {
      const r = await Db.classes.remove(b.dataset.del);
      if (r.ok) { toast('Class deleted.', 'ok'); render(root); } else toast(r.message, 'err');
    },
    true
  ));
}

async function openClassModal(root, existing, staff, allClasses) {
  staff = staff || [];
  allClasses = allClasses || [];
  let streams = [];
  if (existing) {
    const sres = await Db.streams.list(existing.id);
    streams = sres.ok ? sres.data : [];
  }

  // Classes are chosen from the standard Daycare-through-Grade-9 list, not
  // typed freehand — this is what keeps every school's class names lining
  // up identically for reporting. Only levels not already added at this
  // school are offered when adding a new one; a class already added can't
  // be renamed (delete and re-add if it was a genuine mistake, since no
  // students should be enrolled in it yet if you're renaming it anyway).
  const usedNames = allClasses.map((c) => c.name.toLowerCase());
  const available = STANDARD_CLASS_LEVELS.filter((n) => usedNames.indexOf(n.toLowerCase()) === -1);

  renderModal(streams);

  function renderModal(currentStreams) {
    const nameField = existing
      ? `<input id="cl-name" value="${esc(existing.name)}" disabled>`
      : (available.length
          ? `<select id="cl-name">${options(available.map((n) => ({ id: n, name: n })), 'id', 'name', '', 'Choose a class')}</select>`
          : `<input id="cl-name" value="" disabled><p class="hint" style="color:var(--danger,#c0392b)">All standard classes (Daycare through Grade 9) have already been added.</p>`);

    modal({
      title: existing ? 'Edit class' : 'Add class',
      wide: true,
      body: `
        <div class="field"><label>Class</label>${nameField}</div>
        <div class="field"><label>Description (optional)</label><input id="cl-desc" value="${esc(existing ? existing.description || '' : '')}"></div>
        <div class="field">
          <label>Class teacher (optional)</label>
          <select id="cl-teacher">${options(staff.filter((s) => s.status === 'active'), 'id', 'full_name', existing ? existing.class_teacher_staff_id : '', 'None')}</select>
          <p class="hint">The class teacher can approve this class's submitted results in the publishing workflow.</p>
        </div>
        <div class="field">
          <label>Streams${existing ? ' (class arms)' : ''}</label>
          ${existing ? `<div class="chips" id="stream-chips" style="margin-bottom:10px">
            ${currentStreams.map((s) => `<span class="chip on" data-stream="${s.id}">${esc(s.name)} &times;</span>`).join('') || '<span class="muted" style="font-size:13px">No streams yet.</span>'}
          </div>` : ''}
          <input id="cl-streams" placeholder="Type stream names, comma-separated (e.g. North, South)">
          <p class="hint">${existing ? 'New names above are added; click an existing chip to remove it.' : 'Optional — you can also add streams later.'}</p>
        </div>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('cl-name').value;
        const description = document.getElementById('cl-desc').value;
        const class_teacher_staff_id = document.getElementById('cl-teacher').value || null;
        const newStreams = document.getElementById('cl-streams').value.split(',').map((s) => s.trim()).filter(Boolean);
        const res = await Db.classes.save({ id: existing ? existing.id : undefined, name, description, class_teacher_staff_id, streams: newStreams });
        if (!res.ok) { toast(res.message, 'err'); return; }
        if (res.streamsAdded) toast(`Class saved — ${res.streamsAdded} stream(s) added.`, 'ok');
        else toast('Class saved.', 'ok');
        closeModal();
        render(root);
      }
    });

    if (existing) {
      document.querySelectorAll('#stream-chips [data-stream]').forEach((chip) => {
        chip.onclick = () => confirmAction('Remove this stream?', async () => {
          const r = await Db.streams.remove(chip.dataset.stream);
          if (!r.ok) { toast(r.message, 'err'); return; }
          toast('Stream removed.', 'ok');
          const updated = currentStreams.filter((s) => s.id !== chip.dataset.stream);
          renderModal(updated);
        }, true);
      });
    }
  }
}
