import { esc, modal, closeModal, toast, confirmAction, options, renderPrereq } from '../app.js';
import { Db } from '../lib/api/index.mjs';

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
  const res = await Db.results.listExams();
  const exams = res.ok ? res.data : [];

  root.innerHTML = `
    <div class="page-head"><div><h2>Exams</h2><p>Assessment events — set one up, then enter marks per subject.</p></div>
      <div class="spacer"></div><button class="btn" id="add-exam">+ Add exam</button></div>
    <div class="card">
      ${exams.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Exam</th><th>Year</th><th>Term</th><th class="num">Out of</th><th>Status</th><th></th></tr></thead>
        <tbody>${exams.map((e) => `<tr>
          <td>${esc(e.name)}</td><td>${esc(e.academic_year_name)}</td><td>${esc(e.term_name)}</td><td class="num">${e.out_of}</td>
          <td><span class="badge blue">${esc(e.status)}</span></td>
          <td class="row-actions">
            <button class="icon-btn" data-edit="${e.id}">✏️</button>
            <button class="icon-btn danger" data-del="${e.id}">🗑️</button>
          </td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="card-b"><div class="empty">
        <div class="e-ico">📝</div><h3>No exams yet</h3><p>Add your first exam (e.g. "Midterm Exam" or "End of Term 1 Exam").</p>
        <button class="btn" id="empty-add-exam">+ Add exam</button>
      </div></div>`}
    </div>`;

  root.querySelector('#add-exam').onclick = () => openExamModal(root, years, terms);
  const emptyBtn = root.querySelector('#empty-add-exam');
  if (emptyBtn) emptyBtn.onclick = () => openExamModal(root, years, terms);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openExamModal(root, years, terms, exams.find((e) => e.id === b.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction('Delete this exam? This also removes any marks recorded for it.', async () => {
    const r = await Db.results.deleteExam(b.dataset.del);
    if (r.ok) { toast('Exam deleted.', 'ok'); render(root, years, terms); } else toast(r.message, 'err');
  }, true));
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
      <div class="field"><label>Out of (max score)</label><input id="ex-outof" type="number" value="${existing ? existing.out_of : 100}"></div>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const res = await Db.results.saveExam({
        id: existing ? existing.id : undefined,
        name: document.getElementById('ex-name').value,
        academic_year_id: document.getElementById('ex-year').value,
        term_id: document.getElementById('ex-term').value,
        out_of: document.getElementById('ex-outof').value
      });
      if (res.ok) { toast('Exam saved.', 'ok'); closeModal(); render(root, years, terms); } else toast(res.message, 'err');
    }
  });
}
