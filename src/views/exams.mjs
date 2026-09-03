import { esc, modal, closeModal, toast, confirmAction, options, renderPrereq, loader, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { EXAM_TYPE_LABELS } from '../lib/api/results.mjs';
import { setNavIntent } from '../lib/navIntent.mjs';

const EXAM_TYPE_CHOICES = Object.keys(EXAM_TYPE_LABELS).map((k) => ({ id: k, name: EXAM_TYPE_LABELS[k] }));

/** "Manage Exams" — one board covering the whole exam lifecycle (create ->
 *  choose classes -> enter marks -> review & publish -> print reports)
 *  instead of a plain list that then sends you off to three separate,
 *  unrelated-looking nav items. Brief §7.1: creating (or editing) an exam
 *  prompts the admin to tick which classes are sitting it; every ticked
 *  class then shows up directly on the exam's card with its own status and
 *  publish info — no "start marks entry for a class" dropdown, since every
 *  eligible class is already right there in the table. */
export async function viewExams(root) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  if (!years.length || !terms.length) {
    renderPrereq(root, 'Academic calendar not set up', 'Please create an academic year and a term before adding exams.', 'settings', 'Go to Settings');
    return;
  }
  await render(root, years, terms);
}

async function render(root, years, terms) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];

  root.innerHTML = `
    <div class="page-head"><div><h2>Manage Exams</h2><p>Create an exam and choose which classes are sitting it, then enter marks per class — everything from marks entry to publishing happens right here.</p></div>
      <div class="spacer"></div><button class="btn" id="add-exam">+ Add exam</button></div>
    <div id="exam-board">${exams.length ? '' : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">📝</div><h3>No exams yet</h3><p>Add your first exam (e.g. "Midterm Exam" or "End of Term 1 Exam").</p>
      <button class="btn" id="empty-add-exam">+ Add exam</button>
    </div></div></div>`}</div>`;

  root.querySelector('#add-exam').onclick = () => openExamModal(root, years, terms, classes);
  const emptyBtn = root.querySelector('#empty-add-exam');
  if (emptyBtn) emptyBtn.onclick = () => openExamModal(root, years, terms, classes);

  if (exams.length) await renderBoard(root, exams, classes, years, terms);
}

async function renderBoard(root, exams, classes, years, terms) {
  const board = root.querySelector('#exam-board');
  board.innerHTML = loader();
  const classRowsByExam = await Promise.all(exams.map((e) => Db.results.listExamClasses(e.id)));
  const rowsByExamId = {};
  exams.forEach((e, i) => { rowsByExamId[e.id] = classRowsByExam[i].ok ? classRowsByExam[i].data : []; });

  board.innerHTML = exams.map((e) => examCard(e, rowsByExamId[e.id])).join('');

  exams.forEach((e) => {
    const card = board.querySelector(`[data-exam-card="${e.id}"]`);
    if (!card) return;
    const classRows = rowsByExamId[e.id];
    card.querySelector('[data-edit-exam]').onclick = () => openExamModal(root, years, terms, classes, e, classRows);
    card.querySelector('[data-add-classes]').onclick = () => openClassPickerModal(root, e, classRows, () => render(root, years, terms));
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
    // Step 13 — post-publish admin actions.
    card.querySelectorAll('[data-analyze]').forEach((b) => b.onclick = () => {
      setNavIntent('exam-analysis', { exam_id: e.id, class_id: b.dataset.analyze });
      go('exam-analysis');
    });
    card.querySelectorAll('[data-send-results]').forEach((b) => b.onclick = () => confirmAction(
      'Send this class\'s results to parents now? This marks the class "Released" and takes you to Messaging to send.',
      async () => {
        const r = await Db.results.markReleased(e.id, b.dataset.sendResults);
        if (!r.ok) { toast(r.message, 'err'); return; }
        setNavIntent('messaging', { exam_id: e.id, class_id: b.dataset.sendResults, scope: 'exam_results' });
        go('messaging');
      }
    ));
    card.querySelectorAll('[data-withdraw]').forEach((b) => b.onclick = () => confirmAction(
      'Withdraw this class\'s published results? Every published subject goes back to "not submitted" — parents will no longer see them until you republish.',
      async () => {
        const r = await Db.results.withdrawExam(e.id, b.dataset.withdraw);
        if (!r.ok) { toast(r.message, 'err'); return; }
        toast(`Withdrew ${r.reopened} of ${r.total} subject(s).`, 'ok');
        renderBoard(root, exams, classes, years, terms);
      },
      true
    ));
  });
}

const STATUS_META = {
  no_subjects: { label: 'No subjects assigned', cls: 'grey' },
  not_started: { label: 'Results Not Uploaded', cls: 'red' },
  in_progress: { label: 'Marks incomplete', cls: 'amber' },
  ready_to_publish: { label: 'Pending Publishing', cls: 'blue' },
  published: { label: 'Published', cls: 'green' },
  released: { label: 'Released', cls: 'green' }
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function examCard(exam, classRows) {
  const rowsHtml = classRows.length ? `<div class="table-wrap"><table class="data">
    <thead><tr><th>Class</th><th>Subjects with marks</th><th>Status</th><th>Last published</th><th></th></tr></thead>
    <tbody>${classRows.map((r) => {
      const meta = STATUS_META[r.status] || { label: r.status, cls: 'grey' };
      let action = '';
      if (r.status === 'no_subjects') action = `<span class="muted" style="font-size:12px">Assign subjects to this class first</span>`;
      else if (r.status === 'not_started') action = `<button class="btn ghost sm" data-continue="${r.class_id}">📝 Enter Marks</button>`;
      else if (r.status === 'in_progress') action = `<button class="btn ghost sm" data-continue="${r.class_id}">📝 Continue marks entry</button>`;
      else if (r.status === 'ready_to_publish') action = `<button class="btn ghost sm" data-review="${r.class_id}">✅ Review &amp; Publish</button>`;
      else {
        // Step 13: published/released classes get the full set of
        // post-publish actions instead of just "Print Reports".
        action = `
          <button class="btn ghost sm" data-analyze="${r.class_id}">🔎 Analyze</button>
          <button class="btn ghost sm" data-send-results="${r.class_id}">📨 Send Results</button>
          <button class="btn ghost sm" data-print="${r.class_id}">🖨️ Print Reports</button>
          <button class="btn ghost sm" data-withdraw="${r.class_id}">↩️ Withdraw</button>`;
      }
      const lastPub = (r.status === 'published' || r.status === 'released') && r.last_published_at
        ? `${fmtDate(r.last_published_at)}${r.last_published_by ? ` by ${esc(r.last_published_by)}` : ''}` : '—';
      return `<tr>
        <td>${esc(r.class_name)}</td>
        <td>${r.subjects_with_marks}/${r.subjects_total || '0'}</td>
        <td><span class="badge ${meta.cls}">${esc(meta.label)}</span></td>
        <td class="muted" style="font-size:12px">${lastPub}</td>
        <td class="row-actions">${action}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` : `<div class="card-b"><p class="muted center" style="margin:0">No classes selected yet for this exam — click "+ Add classes" to choose which classes are sitting it.</p></div>`;

  return `<div class="card" style="margin-bottom:16px" data-exam-card="${exam.id}">
    <div class="card-h">
      <h3>${esc(exam.name)}</h3>
      <span class="badge grey">${esc(EXAM_TYPE_LABELS[exam.exam_type] || exam.exam_type || 'Written Test')}</span>
      <span class="badge blue">${esc(exam.academic_year_name)} · ${esc(exam.term_name)}</span>
      <span class="badge grey">Out of ${exam.out_of}</span>
      <div class="spacer"></div>
      <button class="btn ghost sm" data-add-classes>+ Add classes</button>
      <button class="btn sm secondary" data-edit-exam>Edit</button>
      <button class="btn sm danger" data-del-exam>Delete</button>
    </div>
    ${rowsHtml}
  </div>`;
}

/** Brief §7.1: creating (or editing) an exam prompts the admin to select
 *  which classes are sitting it, via a plain tick-list — a class that
 *  already has recorded marks for this exam can't be unticked here (it's
 *  disabled, matching what saveExam's server-side guard already enforces),
 *  so the checklist never lets an admin accidentally hide marks that
 *  already exist. */
function openExamModal(root, years, terms, classes, existing, currentClassRows) {
  const selectedIds = new Set((currentClassRows || []).map((r) => r.class_id));
  const lockedIds = new Set((currentClassRows || []).filter((r) => r.subjects_with_marks > 0).map((r) => r.class_id));
  const minByClass = {};
  (currentClassRows || []).forEach((r) => { minByClass[r.class_id] = r.min_subjects; });
  const initialType = existing ? existing.exam_type : 'written';

  modal({
    title: existing ? 'Edit exam' : 'Add exam',
    wide: true,
    body: `
      <div class="field"><label>Exam name</label><input id="ex-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. End of Term 1 Exam"></div>
      <div class="grid2">
        <div class="field"><label>Academic year</label><select id="ex-year">${options(years, 'id', 'name', existing ? existing.academic_year_id : '', 'Choose a year')}</select></div>
        <div class="field"><label>Term</label><select id="ex-term">${options(terms, 'id', 'name', existing ? existing.term_id : '', 'Choose a term')}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Exam type</label><select id="ex-type">${options(EXAM_TYPE_CHOICES, 'id', 'name', initialType)}</select></div>
        <div class="field"><label>Out of (max score)</label><input id="ex-outof" type="number" value="${existing ? existing.out_of : 100}"></div>
      </div>
      <p class="hint" id="ex-consolidated-note" style="display:${initialType === 'consolidated' ? '' : 'none'};color:var(--warn)">
        ⚠️ Combining two or more exams together isn't built yet — this creates a normal single exam for now; the merge behaviour is being scoped separately.
      </p>
      <div class="field">
        <label>Which grades are sitting this exam?</label>
        <p class="hint" style="margin-top:0">Tick every class that will sit this exam, and optionally set a minimum number of learning areas a student must have taken to be ranked — anyone who sat fewer is shown as "X" instead of skewing the class mean. Leave blank to use the school-wide default. You can add more classes later from the exam card.</p>
        <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px">
          ${classes.length ? classes.map((c) => `
            <div style="display:flex;align-items:center;gap:8px;padding:5px 0">
              <label style="display:flex;align-items:center;gap:8px;flex:1;margin:0">
                <input type="checkbox" data-class-check value="${c.id}" ${selectedIds.has(c.id) ? 'checked' : ''} ${lockedIds.has(c.id) ? 'disabled' : ''}>
                <span>${esc(c.name)}</span>
                ${lockedIds.has(c.id) ? '<span class="muted" style="font-size:11px">(has marks recorded — can\'t remove)</span>' : ''}
              </label>
              <input type="number" min="0" data-class-min="${c.id}" placeholder="Min. learning areas" title="Minimum learning areas for ${esc(c.name)}" style="width:150px" value="${minByClass[c.id] === null || minByClass[c.id] === undefined ? '' : minByClass[c.id]}">
            </div>`).join('') : '<p class="muted" style="margin:0">No classes yet — add a class first.</p>'}
        </div>
      </div>
    `,
    okLabel: 'Save',
    onOpen: () => {
      document.getElementById('ex-type').onchange = (e) => {
        document.getElementById('ex-consolidated-note').style.display = e.target.value === 'consolidated' ? '' : 'none';
      };
    },
    onOk: async () => {
      const lockedButUnchecked = [...lockedIds]; // always resubmitted regardless of checkbox state (disabled inputs don't post)
      const ticked = [...document.querySelectorAll('[data-class-check]')].filter((cb) => cb.checked).map((cb) => cb.value);
      const classIds = [...new Set([...ticked, ...lockedButUnchecked])];
      const minSubjectsByClass = {};
      document.querySelectorAll('[data-class-min]').forEach((inp) => {
        if (classIds.indexOf(inp.dataset.classMin) === -1) return;
        minSubjectsByClass[inp.dataset.classMin] = inp.value === '' ? null : inp.value;
      });
      const res = await Db.results.saveExam({
        id: existing ? existing.id : undefined,
        name: document.getElementById('ex-name').value,
        academic_year_id: document.getElementById('ex-year').value,
        term_id: document.getElementById('ex-term').value,
        exam_type: document.getElementById('ex-type').value,
        out_of: document.getElementById('ex-outof').value,
        class_ids: classIds,
        min_subjects_by_class: minSubjectsByClass
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(existing ? 'Exam saved.' : 'Exam created.', 'ok');
      render(root, years, terms);
    }
  });
}

/** "+ Add classes" on an existing exam's card — brief §7.1's implicit
 *  "add a late-enrolling class later" case, using listExamClassChoices so
 *  the picker only ever shows classes not already on this exam. */
function openClassPickerModal(root, exam, currentClassRows, onDone) {
  Db.results.listExamClassChoices(exam.id).then((res) => {
    const choices = res.ok ? res.data : [];
    if (!choices.length) { toast('Every class has already been added to this exam.', 'ok'); return; }
    modal({
      title: `Add classes to "${exam.name}"`,
      body: `
        <p class="hint" style="margin-top:0">Choose which additional classes are sitting this exam.</p>
        <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px">
          ${choices.map((c) => `<label style="display:flex;align-items:center;gap:8px;padding:4px 0">
            <input type="checkbox" data-add-class-check value="${c.id}"><span>${esc(c.name)}</span></label>`).join('')}
        </div>
      `,
      okLabel: 'Add selected',
      onOk: async () => {
        const toAdd = [...document.querySelectorAll('[data-add-class-check]')].filter((cb) => cb.checked).map((cb) => cb.value);
        if (!toAdd.length) { toast('Choose at least one class.', 'err'); return; }
        const existingIds = (currentClassRows || []).map((r) => r.class_id);
        const res2 = await Db.results.saveExam({
          id: exam.id, name: exam.name, academic_year_id: exam.academic_year_id, term_id: exam.term_id,
          exam_type: exam.exam_type, out_of: exam.out_of, class_ids: [...existingIds, ...toAdd]
        });
        if (!res2.ok) { toast(res2.message, 'err'); return; }
        closeModal();
        toast('Classes added.', 'ok');
        onDone();
      }
    });
  }).catch((e) => {
    console.error('openClassPickerModal: failed to load class choices', e);
    toast(`Couldn't load classes to add${e && e.message ? ` (${e.message})` : ''}.`, 'err');
  });
}
