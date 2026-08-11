/**
 * learningAreaPapers.mjs — "Learning Area Papers" (Learning Area Papers
 * Feature brief, corrected by Round 2 §5). Reached from an exam's card in
 * Exam Desk (examDesk.mjs), scoped to ONE exam — lists every subject
 * actually being examined in it (Db.results.listExamSubjects) with its
 * current paper setup PER CLASS for THIS exam specifically
 * (Db.subjectPapers.listForExam/setForSubject —
 * 0020_learning_area_papers.sql scopes subject_papers to an exam, not
 * permanently to a subject; 0021_learning_area_papers_per_class.sql then
 * scopes it further to a specific CLASS within that exam too).
 *
 * Round 2 §5, verbatim: "Papers set up for a subject should apply to
 * specific classes, not be assumed to apply across the whole school. For
 * example, Grade 1 might sit English as a single paper, while Grade 8 sits
 * it as 3 separate papers, within the same exam. Fix: when configuring
 * papers for a subject, ask which classes this specific paper setup
 * applies to — don't assume it's school-wide." That "ask which classes"
 * step is openPapersModal()'s class checklist below, always shown (never
 * skipped, never pre-assumed) before the paper table.
 *
 * Deliberately NOT a bulk "enable all" action (present in the Zeraki
 * reference screenshot but not in the brief's own text) — the brief is
 * explicit that turning on papers for one subject must never assume or
 * auto-apply the same structure to another ("some subjects may use 2
 * papers, others 3, others none at all"), and there's no sane default paper
 * split to bulk-apply across every subject at once without violating that.
 * "Configure" is the only way in, by design — and per Round 2 §5, the same
 * logic now applies one level deeper: configuring one CLASS's papers never
 * assumes or auto-applies to another class either, unless the admin
 * explicitly ticks it in the class picker.
 */
import { esc, toast, loader, modal, closeModal } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function renderLearningAreaPapersScreen(root, exam, onBack) {
  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn ghost sm" id="lap-back" style="margin-bottom:8px">← Back to Exam Desk</button>
        <h2>${esc(exam.name)} — Learning Area Papers</h2>
        <p>Decide, subject by subject and class by class, whether this exam scores it as multiple weighted papers or one combined mark. This is set fresh for every exam — nothing carries over automatically from a previous one, and configuring papers for one subject (or one class) never affects any other.</p>
      </div>
    </div>
    <div id="lap-body"></div>
  `;
  root.querySelector('#lap-back').onclick = onBack;
  await load(root, exam);
}

async function load(root, exam) {
  const body = root.querySelector('#lap-body');
  body.innerHTML = loader();
  const [subjectsRes, classesRes, papersRes] = await Promise.all([
    Db.results.listExamSubjects(exam.id),
    Db.results.listExamClassNames(exam.id),
    Db.subjectPapers.listForExam(exam.id)
  ]);
  if (!subjectsRes.ok) { body.innerHTML = `<div class="card pad">⚠️ ${esc(subjectsRes.message)}</div>`; return; }
  if (!classesRes.ok) { body.innerHTML = `<div class="card pad">⚠️ ${esc(classesRes.message)}</div>`; return; }
  const subjects = subjectsRes.data;
  const classes = classesRes.data;
  if (!subjects.length || !classes.length) {
    body.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn">
      <div class="e-ico">⚠️</div><h3>No subjects found for this exam yet</h3>
      <p>Add classes to this exam (and make sure they have subjects assigned) first, then come back here.</p>
    </div></div></div>`;
    return;
  }
  // Group every paper row by subject, then by class — a subject's papers
  // for Grade 1 are a completely separate list from its papers for Grade 8,
  // even within this one exam.
  const papersBySubjectClass = {};
  (papersRes.ok ? papersRes.data : []).forEach((p) => {
    const key = `${p.subject_id}|${p.class_id}`;
    (papersBySubjectClass[key] = papersBySubjectClass[key] || []).push(p);
  });
  Object.values(papersBySubjectClass).forEach((list) => list.sort((a, b) => a.paper_no - b.paper_no));

  body.innerHTML = `
    <div class="card">
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th style="width:36px">#</th><th>Subject</th><th>Class</th><th>Papers</th><th style="width:110px"></th></tr></thead>
        <tbody>${subjects.map((s, i) => classes.map((c, ci) => subjectClassRowHtml(s, c, i, ci, papersBySubjectClass[`${s.id}|${c.id}`] || [])).join('')).join('')}</tbody>
      </table></div>
    </div>
  `;
  body.querySelectorAll('[data-edit-subject]').forEach((btn) => btn.onclick = () => {
    const subject = subjects.find((s) => s.id === btn.dataset.editSubject);
    const preselectClassId = btn.dataset.editClass || '';
    openPapersModal(root, exam, subject, classes, papersBySubjectClass, preselectClassId, () => load(root, exam));
  });
}

function subjectClassRowHtml(subject, cls, subjectIndex, classIndex, papers) {
  const summary = papers.length
    ? papers.map((p) => `${esc(p.name)} (out of ${p.out_of}, ${Math.round(Number(p.weight) * 100)}%)`).join(' + ')
    : `<span class="badge grey">Single mark</span>`;
  // Only print the subject name/# on that subject's first class row — the
  // rest of its class rows read as a continuation of the same subject
  // block, same "don't repeat the group label every row" convention as
  // other grouped tables in this app.
  return `<tr${classIndex === 0 ? ' style="border-top:2px solid var(--line)"' : ''}>
    ${classIndex === 0 ? `<td>${subjectIndex + 1}</td><td>${esc(subject.name)}</td>` : `<td></td><td></td>`}
    <td>${esc(cls.name)}</td>
    <td>${summary}</td>
    <td><button class="btn ghost sm" data-edit-subject="${subject.id}" data-edit-class="${cls.id}">${papers.length ? 'Edit' : 'Configure'}</button></td>
  </tr>`;
}

function paperRowHtml(p, i, showRatio) {
  return `<tr data-row="${i}">
    <td><input type="text" class="lap-name" placeholder="Paper ${i + 1}" value="${esc(p.name || '')}"></td>
    <td><input type="number" min="1" class="lap-outof" style="width:90px" value="${p.out_of === undefined || p.out_of === null ? '' : p.out_of}"></td>
    <td>${showRatio ? `<input type="number" min="0" max="100" step="0.1" class="lap-ratio" style="width:90px" value="${p.ratio === undefined || p.ratio === null ? '' : p.ratio}">` : '<span class="muted">100% (only paper)</span>'}</td>
    <td><button class="btn ghost sm lap-remove" type="button">✕</button></td>
  </tr>`;
}

/** Opens the "which classes does this apply to?" + paper-editor modal for
 *  one subject. `preselectClassId`: opened from a specific class's own
 *  Edit/Configure button — that one class starts ticked, and (if it
 *  already has papers) the table pre-fills from ITS papers specifically.
 *  Ticking additional classes applies the SAME paper structure to all of
 *  them at once — exactly the "ask which classes this applies to" flow the
 *  brief asks for, never assumed, always an explicit choice made right
 *  here. */
function openPapersModal(root, exam, subject, classes, papersBySubjectClass, preselectClassId, onSaved) {
  const selectedClassIds = new Set(preselectClassId ? [preselectClassId] : []);
  const seedPapers = preselectClassId ? (papersBySubjectClass[`${subject.id}|${preselectClassId}`] || []) : [];
  let papers = seedPapers.length
    ? seedPapers.map((p) => ({ id: p.id, name: p.name, out_of: p.out_of, ratio: Math.round(Number(p.weight) * 1000) / 10 }))
    : [{ name: 'Paper 1', out_of: exam.out_of || 100, ratio: 100 }];

  modal({
    title: `${subject.name} — Papers for "${exam.name}"`,
    wide: true,
    body: `<div id="lap-modal-body"></div>`,
    okLabel: 'Save',
    busyLabel: 'Saving…',
    onOpen: () => draw(),
    onOk: async () => {
      syncFromDom();
      if (!selectedClassIds.size) { toast('Choose at least one class this paper setup applies to.', 'err'); return; }
      // One call per selected class — each class's rows stay completely
      // independent afterward (Round 2 §5: never school-wide, never even
      // "linked" across classes just because they started out identical).
      const results = await Promise.all([...selectedClassIds].map((classId) => Db.subjectPapers.setForSubject(exam.id, subject.id, classId, papers)));
      const failed = results.find((r) => !r.ok);
      if (failed) { toast(failed.message, 'err'); return; }
      closeModal();
      toast(papers.length ? `Papers saved for ${selectedClassIds.size} class(es).` : 'Reverted to a single combined mark.', 'ok');
      onSaved();
    }
  });

  function syncFromDom() {
    const body = document.getElementById('lap-modal-body');
    if (!body) return;
    papers = [...body.querySelectorAll('#lap-paper-table tbody tr')].map((tr, i) => ({
      id: papers[Number(tr.dataset.row)] ? papers[Number(tr.dataset.row)].id : undefined,
      name: tr.querySelector('.lap-name').value,
      out_of: tr.querySelector('.lap-outof').value,
      ratio: papers.length === 1 ? 100 : (tr.querySelector('.lap-ratio') ? tr.querySelector('.lap-ratio').value : 100)
    }));
  }

  function draw() {
    const body = document.getElementById('lap-modal-body');
    if (!body) return;
    const showRatio = papers.length > 1;
    const ratioTotal = showRatio ? Math.round(papers.reduce((a, p) => a + (Number(p.ratio) || 0), 0) * 10) / 10 : 100;
    const classChips = classes.map((c) => `<label class="chk" style="display:inline-flex;align-items:center;gap:6px;margin:0 14px 6px 0">
      <input type="checkbox" class="lap-class" value="${c.id}" ${selectedClassIds.has(c.id) ? 'checked' : ''}> ${esc(c.name)}
    </label>`).join('');
    body.innerHTML = `
      <p class="hint" style="margin-top:0"><b>Which classes does this paper setup apply to?</b> Papers are never school-wide — tick every class you want this exact setup applied to (usually just one). Each ticked class keeps its own independent copy, editable separately afterward.</p>
      <div style="margin-bottom:14px">${classChips}</div>
      <p class="hint" style="margin-top:0">Give this subject one or more papers just for this exam — each with its own "out of" and a Ratio (its share of the combined subject score). Remove every paper to go back to a single combined mark instead.</p>
      <div class="table-wrap"><table class="data" id="lap-paper-table">
        <thead><tr><th>Paper Name</th><th class="num">Out of</th><th class="num">Ratio</th><th></th></tr></thead>
        <tbody>${papers.map((p, i) => paperRowHtml(p, i, showRatio)).join('')}</tbody>
      </table></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
        <button class="btn ghost sm" id="lap-add-paper" type="button">+ Add paper</button>
        ${showRatio ? `<span class="hint" id="lap-ratio-total" style="margin:0;${ratioTotal === 100 ? '' : 'color:var(--danger);font-weight:700'}">Ratio total: ${ratioTotal}%${ratioTotal === 100 ? ' ✓' : ' — must add up to 100%'}</span>` : ''}
      </div>
    `;

    body.querySelectorAll('.lap-class').forEach((chk) => chk.onchange = () => {
      if (chk.checked) selectedClassIds.add(chk.value); else selectedClassIds.delete(chk.value);
    });

    body.querySelector('#lap-add-paper').onclick = () => {
      syncFromDom();
      papers.push({ name: `Paper ${papers.length + 1}`, out_of: exam.out_of || 100, ratio: 0 });
      draw();
    };
    body.querySelectorAll('.lap-remove').forEach((b) => b.onclick = () => {
      syncFromDom();
      papers.splice(Number(b.closest('tr').dataset.row), 1);
      draw();
    });
    if (showRatio) {
      body.querySelectorAll('.lap-ratio').forEach((inp) => inp.oninput = () => {
        const total = [...body.querySelectorAll('.lap-ratio')].reduce((a, el) => a + (Number(el.value) || 0), 0);
        const totalEl = body.querySelector('#lap-ratio-total');
        const rounded = Math.round(total * 10) / 10;
        if (totalEl) {
          totalEl.textContent = `Ratio total: ${rounded}%${rounded === 100 ? ' ✓' : ' — must add up to 100%'}`;
          totalEl.style.color = rounded === 100 ? '' : 'var(--danger)';
          totalEl.style.fontWeight = rounded === 100 ? '' : '700';
        }
      });
    }
  }
}
