import { esc, modal, closeModal, toast, confirmAction, options, renderPrereq, loader, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { EXAM_TYPE_LABELS } from '../lib/api/results.mjs';
import { setNavIntent } from '../lib/navIntent.mjs';

const EXAM_TYPE_CHOICES = Object.keys(EXAM_TYPE_LABELS).map((k) => ({ id: k, name: EXAM_TYPE_LABELS[k] }));

/** "Manage Exams" — one board covering the whole exam lifecycle (create ->
 *  enter marks -> review & publish -> print reports) instead of a plain
 *  list that then sends you off to three separate, unrelated-looking nav
 *  items. Creating an exam lands you right back here with a class picker
 *  ready to go — that picker IS the "Enter Marks" action for a brand new
 *  exam, since this schema doesn't restrict which classes may sit an exam
 *  (any class is always eligible; there's no per-exam class whitelist). */
export async function viewExams(root) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  if (!years.length || !terms.length) {
    renderPrereq(root, 'Academic calendar not set up', 'Please create an academic year and a term before adding exams.', 'academic-calendar', 'Go to Academic Calendar');
    return;
  }
  await render(root, years, terms);
}

async function render(root, years, terms) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];

  root.innerHTML = `
    <div class="page-head"><div><h2>Manage Exams</h2><p>Create an exam, then enter marks per class — everything from marks entry to publishing happens right here.</p></div>
      <div class="spacer"></div><button class="btn" id="add-exam">+ Add exam</button></div>
    <div id="exam-board">${exams.length ? '' : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">📝</div><h3>No exams yet</h3><p>Add your first exam (e.g. "Midterm Exam" or "End of Term 1 Exam").</p>
      <button class="btn" id="empty-add-exam">+ Add exam</button>
    </div></div></div>`}</div>`;

  root.querySelector('#add-exam').onclick = () => openExamModal(root, years, terms);
  const emptyBtn = root.querySelector('#empty-add-exam');
  if (emptyBtn) emptyBtn.onclick = () => openExamModal(root, years, terms);

  if (exams.length) await renderBoard(root, exams, classes, years, terms);
}

async function renderBoard(root, exams, classes, years, terms) {
  const board = root.querySelector('#exam-board');
  board.innerHTML = loader();
  const classRowsByExam = await Promise.all(exams.map((e) => Db.results.listExamClasses(e.id)));

  board.innerHTML = exams.map((e, i) => examCard(e, classRowsByExam[i].ok ? classRowsByExam[i].data : [], classes)).join('');

  exams.forEach((e) => {
    const card = board.querySelector(`[data-exam-card="${e.id}"]`);
    if (!card) return;
    card.querySelector('[data-edit-exam]').onclick = () => openExamModal(root, years, terms, e);
    card.querySelector('[data-del-exam]').onclick = () => confirmAction('Delete this exam? This also removes any marks recorded for it.', async () => {
      const r = await Db.results.deleteExam(e.id);
      if (r.ok) { toast('Exam deleted.', 'ok'); render(root, years, terms); } else toast(r.message, 'err');
    }, true);

    card.querySelectorAll('[data-continue]').forEach((b) => b.onclick = () => {
      setNavIntent('marks-entry', { exam_id: e.id, class_id: b.dataset.continue });
      go('marks');
    });
    card.querySelectorAll('[data-review]').forEach((b) => b.onclick = () => {
      setNavIntent('publishing', { exam_id: e.id, class_id: b.dataset.review });
      go('publishing');
    });
    card.querySelectorAll('[data-print]').forEach((b) => b.onclick = () => {
      setNavIntent('report-forms', { exam_id: e.id, class_id: b.dataset.print });
      go('reports');
    });

    const startBtn = card.querySelector('[data-start-btn]');
    if (startBtn) startBtn.onclick = () => {
      const classId = card.querySelector('[data-start-select]').value;
      if (!classId) { toast('Choose a class first.', 'err'); return; }
      setNavIntent('marks-entry', { exam_id: e.id, class_id: classId });
      go('marks');
    };
  });
}

const STATUS_META = {
  in_progress: { label: 'Marks incomplete', cls: 'amber' },
  ready_to_publish: { label: 'Ready to review', cls: 'blue' },
  published: { label: 'Published', cls: 'green' }
};

function examCard(exam, classRows, allClasses) {
  const startedIds = new Set(classRows.map((r) => r.class_id));
  const notStarted = allClasses.filter((c) => !startedIds.has(c.id));

  const rowsHtml = classRows.length ? `<div class="table-wrap"><table class="data">
    <thead><tr><th>Class</th><th>Subjects with marks</th><th>Status</th><th></th></tr></thead>
    <tbody>${classRows.map((r) => {
      const meta = STATUS_META[r.status] || { label: r.status, cls: 'grey' };
      let action = '';
      if (r.status === 'in_progress') action = `<button class="btn ghost sm" data-continue="${r.class_id}">📝 Continue marks entry</button>`;
      else if (r.status === 'ready_to_publish') action = `<button class="btn ghost sm" data-review="${r.class_id}">✅ Review &amp; Publish</button>`;
      else action = `<button class="btn ghost sm" data-print="${r.class_id}">🖨️ Print Reports</button>`;
      return `<tr>
        <td>${esc(r.class_name)}</td>
        <td>${r.subjects_with_marks}/${r.subjects_total || '?'}</td>
        <td><span class="badge ${meta.cls}">${esc(meta.label)}</span></td>
        <td class="row-actions">${action}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` : '';

  const startPicker = notStarted.length ? `
    <div class="card-b" style="${classRows.length ? 'border-top:1px solid var(--line)' : ''}">
      <div class="field" style="display:flex;align-items:flex-end;gap:10px;margin:0">
        <div style="flex:1"><label>${classRows.length ? 'Start marks entry for another class' : 'Start marks entry for a class'}</label>
          <select data-start-select>${options(notStarted, 'id', 'name', '', 'Choose a class')}</select></div>
        <button class="btn" data-start-btn>🎯 Enter Marks</button>
      </div>
    </div>` : '';

  return `<div class="card" style="margin-bottom:16px" data-exam-card="${exam.id}">
    <div class="card-h">
      <h3>${esc(exam.name)}</h3>
      <span class="badge grey">${esc(EXAM_TYPE_LABELS[exam.exam_type] || exam.exam_type || 'Summative')}</span>
      <span class="badge blue">${esc(exam.academic_year_name)} · ${esc(exam.term_name)}</span>
      <span class="badge grey">Out of ${exam.out_of}</span>
      <div class="spacer"></div>
      <button class="icon-btn" data-edit-exam>✏️</button>
      <button class="icon-btn danger" data-del-exam>🗑️</button>
    </div>
    ${rowsHtml}
    ${startPicker}
    ${!rowsHtml && !startPicker ? `<div class="card-b"><p class="muted center" style="margin:0">No classes yet — add a class first to start marks entry.</p></div>` : ''}
  </div>`;
}

function openExamModal(root, years, terms, existing) {
  modal({
    title: existing ? 'Edit exam' : 'Add exam',
    body: `
      <div class="field"><label>Exam name</label><input id="ex-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. End of Term 1 Exam"></div>
      <div class="grid2">
        <div class="field"><label>Academic year</label><select id="ex-year">${options(years, 'id', 'name', existing ? existing.academic_year_id : '', 'Choose a year')}</select></div>
        <div class="field"><label>Term</label><select id="ex-term">${options(terms, 'id', 'name', existing ? existing.term_id : '', 'Choose a term')}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Exam type</label><select id="ex-type">${options(EXAM_TYPE_CHOICES, 'id', 'name', existing ? existing.exam_type : 'summative')}</select></div>
        <div class="field"><label>Out of (max score)</label><input id="ex-outof" type="number" value="${existing ? existing.out_of : 100}"></div>
      </div>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const res = await Db.results.saveExam({
        id: existing ? existing.id : undefined,
        name: document.getElementById('ex-name').value,
        academic_year_id: document.getElementById('ex-year').value,
        term_id: document.getElementById('ex-term').value,
        exam_type: document.getElementById('ex-type').value,
        out_of: document.getElementById('ex-outof').value
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(existing ? 'Exam saved.' : 'Exam created — pick a class below to start entering marks.', 'ok');
      render(root, years, terms);
    }
  });
}
