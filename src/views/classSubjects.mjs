import { esc, toast, options, renderPrereq } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewClassSubjects(root) {
  const [classesRes, subjectsRes] = await Promise.all([Db.classes.list(), Db.subjects.list()]);
  const classes = classesRes.ok ? classesRes.data : [];
  const subjects = subjectsRes.ok ? subjectsRes.data : [];
  if (!classes.length) {
    renderPrereq(root, 'No classes found', 'Please create a class before assigning subjects.', 'classes', 'Go to Classes');
    return;
  }
  if (!subjects.length) {
    renderPrereq(root, 'No subjects found', 'Please add subjects first (or load the CBC list).', 'subjects', 'Go to Subjects');
    return;
  }
  await render(root, classes, subjects, classes[0].id);
}

async function render(root, classes, subjects, classId) {
  const assignedRes = classId ? await Db.assignments.getClassSubjects(classId) : { ok: true, data: [] };
  const assignedIds = new Set((assignedRes.ok ? assignedRes.data : []).map((r) => String(r.subject_id)));

  const levels = [...new Set(subjects.map((s) => s.level || 'Custom / other'))];
  const groups = levels.map((level) => {
    const rows = subjects.filter((s) => (s.level || 'Custom / other') === level);
    const chips = rows.map((s) => `<span class="chip ${assignedIds.has(String(s.id)) ? 'on' : ''}" data-subject="${s.id}">${esc(s.name)}</span>`).join('');
    return `<div style="margin-bottom:16px"><div class="muted" style="font-weight:650;font-size:12.5px;text-transform:uppercase;margin-bottom:8px">${esc(level)}</div><div class="chips">${chips}</div></div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-head"><div><h2>Class Subjects</h2><p>Tick the subjects each class offers — every stream of that class inherits them automatically.</p></div></div>
    <div class="card side-accent tile-blue">
      <div class="card-h"><h3>Class</h3><div class="spacer"></div>
        <select id="cs-class" style="max-width:240px">${options(classes, 'id', 'name', classId)}</select>
      </div>
      <div class="card-b">${groups}</div>
      <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn" id="cs-save">Save</button></div>
    </div>
  `;

  root.querySelector('#cs-class').onchange = (e) => render(root, classes, subjects, e.target.value);
  root.querySelectorAll('[data-subject]').forEach((chip) => chip.onclick = () => chip.classList.toggle('on'));
  root.querySelector('#cs-save').onclick = async () => {
    const selected = [...root.querySelectorAll('[data-subject].on')].map((c) => c.dataset.subject);
    const res = await Db.assignments.setClassSubjects(classId, selected);
    if (!res.ok) { toast(res.message, 'err'); return; }
    const streamMsg = res.streamCount > 0 ? ` — auto-applied to ${res.streamCount} stream(s) of ${esc(res.className)}.` : '.';
    toast(`Saved ${res.count} subject(s)${streamMsg}`, 'ok');
  };
}
