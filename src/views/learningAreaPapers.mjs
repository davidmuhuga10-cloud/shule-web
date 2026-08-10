/**
 * learningAreaPapers.mjs — "Learning Area Papers" (Learning Area Papers
 * Feature brief). Reached from an exam's card in Exam Desk (examDesk.mjs),
 * scoped to ONE exam — lists every subject actually being examined in it
 * (Db.results.listExamSubjects) with its current paper setup for THIS exam
 * specifically (Db.subjectPapers.listForExam/setForSubject —
 * 0020_learning_area_papers.sql scopes subject_papers to an exam, not
 * permanently to a subject).
 *
 * Deliberately NOT a bulk "enable all" action (present in the Zeraki
 * reference screenshot but not in the brief's own text) — the brief is
 * explicit that turning on papers for one subject must never assume or
 * auto-apply the same structure to another ("some subjects may use 2
 * papers, others 3, others none at all"), and there's no sane default paper
 * split to bulk-apply across every subject at once without violating that.
 * Each subject's "Edit / Add Paper" is the only way in, by design.
 */
import { esc, toast, loader, modal, closeModal, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function renderLearningAreaPapersScreen(root, exam, onBack) {
  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn ghost sm" id="lap-back" style="margin-bottom:8px">← Back to Exam Desk</button>
        <h2>${esc(exam.name)} — Learning Area Papers</h2>
        <p>Decide, subject by subject, whether this exam scores it as multiple weighted papers or one combined mark. This is set fresh for every exam — nothing carries over automatically from a previous one, and turning papers on for one subject never affects any other.</p>
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
  const [subjectsRes, papersRes] = await Promise.all([
    Db.results.listExamSubjects(exam.id),
    Db.subjectPapers.listForExam(exam.id)
  ]);
  if (!subjectsRes.ok) { body.innerHTML = `<div class="card pad">⚠️ ${esc(subjectsRes.message)}</div>`; return; }
  const subjects = subjectsRes.data;
  if (!subjects.length) {
    body.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn">
      <div class="e-ico">⚠️</div><h3>No subjects found for this exam yet</h3>
      <p>Add classes to this exam (and make sure they have subjects assigned) first, then come back here.</p>
    </div></div></div>`;
    return;
  }
  const papersBySubject = {};
  (papersRes.ok ? papersRes.data : []).forEach((p) => { (papersBySubject[p.subject_id] = papersBySubject[p.subject_id] || []).push(p); });
  Object.values(papersBySubject).forEach((list) => list.sort((a, b) => a.paper_no - b.paper_no));

  body.innerHTML = `
    <div class="card">
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th style="width:36px">#</th><th>Name</th><th>Papers</th><th style="width:150px"></th></tr></thead>
        <tbody>${subjects.map((s, i) => subjectRowHtml(s, i, papersBySubject[s.id] || [])).join('')}</tbody>
      </table></div>
    </div>
  `;
  body.querySelectorAll('[data-edit-subject]').forEach((btn) => btn.onclick = () => {
    const subject = subjects.find((s) => s.id === btn.dataset.editSubject);
    openPapersModal(root, exam, subject, papersBySubject[subject.id] || []);
  });
}

function subjectRowHtml(subject, index, papers) {
  const papersTable = papers.length ? `
    <table class="data" style="margin:0">
      <thead><tr><th>Paper Name</th><th class="num">Out of</th><th class="num">Ratio</th></tr></thead>
      <tbody>${papers.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.out_of}</td><td class="num">${Math.round(Number(p.weight) * 100)}%</td></tr>`).join('')}</tbody>
    </table>` : `
    <table class="data" style="margin:0">
      <thead><tr><th>Paper Name</th><th class="num">Out of</th><th class="num">Ratio</th></tr></thead>
      <tbody><tr><td class="muted">Paper 1</td><td class="num muted">—</td><td class="num"><span class="badge grey">Single mark</span></td></tr></tbody>
    </table>`;
  return `<tr>
    <td>${index + 1}</td>
    <td>${esc(subject.name)}</td>
    <td style="max-width:420px">${papersTable}</td>
    <td><button class="btn secondary sm" data-edit-subject="${subject.id}">Edit / Add Paper</button></td>
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

function openPapersModal(root, exam, subject, existingPapers) {
  let papers = existingPapers.length
    ? existingPapers.map((p) => ({ id: p.id, name: p.name, out_of: p.out_of, ratio: Math.round(Number(p.weight) * 1000) / 10 }))
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
      const res = await Db.subjectPapers.setForSubject(exam.id, subject.id, papers);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(papers.length ? 'Papers saved.' : 'Reverted to a single combined mark.', 'ok');
      load(root, exam);
    }
  });

  function syncFromDom() {
    const body = document.getElementById('lap-modal-body');
    if (!body) return;
    papers = [...body.querySelectorAll('tbody tr')].map((tr, i) => ({
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
    body.innerHTML = `
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
