/**
 * subjectCombination.mjs — "Subject Combination" (Round 2 §3). Reached from
 * an exam's card in Exam Desk (examDesk.mjs), same entry pattern as
 * Learning Area Papers ("working similarly to Learning Area Papers" per the
 * brief) — scoped to ONE exam.
 *
 * The opposite direction from Learning Area Papers: instead of splitting
 * one subject into several papers, this combines two or more EXISTING
 * subjects into a single named, weighted result (e.g. Social Studies + CRE
 * -> "SST/CRE Combined"). Marks are still entered per underlying subject in
 * Marks Entry exactly as before — this screen only decides how those
 * already-entered subject scores get folded together on the Mark List
 * (Db.results.getBroadsheet does the actual folding; see results.mjs).
 *
 * A subject can only belong to ONE combination per exam — the "available"
 * list below excludes subjects already claimed by a DIFFERENT combination,
 * and setCombination() (academics.mjs) refuses the save server-side too as
 * a defense-in-depth backstop, not just a UI nicety.
 */
import { esc, toast, loader, modal, closeModal, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function renderSubjectCombinationScreen(root, exam, onBack) {
  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn ghost sm" id="sc-back" style="margin-bottom:8px">← Back to Exam Desk</button>
        <h2>${esc(exam.name)} — Subject Combination</h2>
        <p>Combine two or more subjects into one named, weighted result for this exam — e.g. Social Studies + CRE as "SST/CRE Combined". Marks are still entered per subject as usual; this only changes how they're shown and totalled on the Mark List.</p>
      </div>
    </div>
    <div id="sc-body"></div>
  `;
  root.querySelector('#sc-back').onclick = onBack;
  await load(root, exam);
}

async function load(root, exam) {
  const body = root.querySelector('#sc-body');
  body.innerHTML = loader();
  const [subjectsRes, combosRes] = await Promise.all([
    Db.results.listExamSubjects(exam.id),
    Db.subjectCombinations.listForExam(exam.id)
  ]);
  if (!subjectsRes.ok) { body.innerHTML = `<div class="card pad">⚠️ ${esc(subjectsRes.message)}</div>`; return; }
  const subjects = subjectsRes.data;
  const combos = combosRes.ok ? combosRes.data : [];
  const subjectById = {}; subjects.forEach((s) => { subjectById[s.id] = s; });

  const usedSubjectIds = new Set(combos.flatMap((c) => c.members.map((m) => m.subject_id)));

  body.innerHTML = `
    <div class="page-head no-print"><div></div><div class="spacer"></div><button class="btn" id="sc-add">+ New combination</button></div>
    ${combos.length ? `<div class="card"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Combination</th><th>Subjects &amp; ratios</th><th style="width:150px"></th></tr></thead>
      <tbody>${combos.map((c) => comboRowHtml(c, subjectById)).join('')}</tbody>
    </table></div></div>` : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">🧩</div><h3>No combinations yet</h3>
      <p>${subjects.length < 2 ? 'This exam needs at least 2 subjects assigned before any can be combined.' : 'Click "+ New combination" to combine two or more subjects into one result.'}</p>
    </div></div></div>`}
  `;

  body.querySelector('#sc-add').onclick = () => openComboModal(root, exam, subjects, usedSubjectIds, null, () => load(root, exam));
  body.querySelectorAll('[data-edit-combo]').forEach((btn) => btn.onclick = () => {
    const combo = combos.find((c) => c.id === btn.dataset.editCombo);
    // Editing: this combo's OWN members don't count as "used by someone
    // else" — only every OTHER combo's members are excluded.
    const usedByOthers = new Set(combos.filter((c) => c.id !== combo.id).flatMap((c) => c.members.map((m) => m.subject_id)));
    openComboModal(root, exam, subjects, usedByOthers, combo, () => load(root, exam));
  });
  body.querySelectorAll('[data-del-combo]').forEach((btn) => btn.onclick = () => confirmAction(
    'Delete this combination? Its subjects go back to showing separately on the Mark List — no marks are affected.',
    async () => {
      const r = await Db.subjectCombinations.remove(btn.dataset.delCombo);
      if (r.ok) { toast('Combination deleted.', 'ok'); load(root, exam); } else toast(r.message, 'err');
    },
    true
  ));
}

function comboRowHtml(combo, subjectById) {
  const memberText = combo.members
    .slice().sort((a, b) => b.weight - a.weight)
    .map((m) => `${esc((subjectById[m.subject_id] || {}).name || '(subject not found)')} (${Math.round(Number(m.weight) * 100)}%)`)
    .join(' + ');
  return `<tr>
    <td><b>${esc(combo.name)}</b></td>
    <td>${memberText}</td>
    <td><button class="btn ghost sm" data-edit-combo="${combo.id}">Edit</button> <button class="btn ghost sm" data-del-combo="${combo.id}">Delete</button></td>
  </tr>`;
}

function memberRowHtml(subject, checked, ratio) {
  return `<tr data-subject="${subject.id}">
    <td><label class="chk" style="display:flex;align-items:center;gap:8px;margin:0"><input type="checkbox" class="sc-pick" ${checked ? 'checked' : ''}> ${esc(subject.name)}</label></td>
    <td>${checked ? `<input type="number" min="0" max="100" step="0.1" class="sc-ratio" style="width:90px" value="${ratio === undefined || ratio === null ? '' : ratio}">` : ''}</td>
  </tr>`;
}

/** `usedElsewhere`: subject ids already claimed by a DIFFERENT combination
 *  in this exam — offered in the picker but disabled, with an explanation,
 *  rather than silently omitted (so it's clear WHY a subject is missing,
 *  not just that it is). `existing`: the combo being edited, or null for a
 *  brand-new one. */
function openComboModal(root, exam, subjects, usedElsewhere, existing, onSaved) {
  let name = existing ? existing.name : '';
  // picked: subject_id -> ratio (0-100). Seeded from the combo being
  // edited, if any.
  const picked = {};
  if (existing) existing.members.forEach((m) => { picked[m.subject_id] = Math.round(Number(m.weight) * 1000) / 10; });

  modal({
    title: existing ? `Edit "${existing.name}"` : 'New Subject Combination',
    wide: true,
    body: `<div id="sc-modal-body"></div>`,
    okLabel: 'Save',
    busyLabel: 'Saving…',
    onOpen: () => draw(),
    onOk: async () => {
      syncFromDom();
      const members = Object.keys(picked).map((subject_id) => ({ subject_id, ratio: picked[subject_id] }));
      const r = await Db.subjectCombinations.setCombination(exam.id, { id: existing ? existing.id : undefined, name, members });
      if (!r.ok) { toast(r.message, 'err'); return; }
      closeModal();
      toast(existing ? 'Combination updated.' : 'Combination created.', 'ok');
      onSaved();
    }
  });

  function syncFromDom() {
    const body = document.getElementById('sc-modal-body');
    if (!body) return;
    name = body.querySelector('#sc-name').value;
    // Reset picked from the current DOM state (checked + ratio values) —
    // simpler and less error-prone than trying to incrementally patch it.
    Object.keys(picked).forEach((k) => delete picked[k]);
    body.querySelectorAll('#sc-member-table tbody tr').forEach((tr) => {
      const checked = tr.querySelector('.sc-pick').checked;
      if (!checked) return;
      const ratioInput = tr.querySelector('.sc-ratio');
      picked[tr.dataset.subject] = ratioInput ? ratioInput.value : 0;
    });
  }

  function draw() {
    const body = document.getElementById('sc-modal-body');
    if (!body) return;
    const pickedCount = Object.keys(picked).length;
    const ratioTotal = pickedCount ? Math.round(Object.values(picked).reduce((a, v) => a + (Number(v) || 0), 0) * 10) / 10 : 0;
    body.innerHTML = `
      <div class="field"><label>Combination name</label><input id="sc-name" placeholder="e.g. SST/CRE Combined" value="${esc(name)}"></div>
      <p class="hint" style="margin:10px 0 6px"><b>Pick the subjects to combine</b> and set each one's Ratio (must add up to 100%). A subject already used in another combination for this exam is shown but can't be picked here — remove it from that combination first.</p>
      <div class="table-wrap"><table class="data" id="sc-member-table">
        <thead><tr><th>Subject</th><th class="num">Ratio</th></tr></thead>
        <tbody>${subjects.map((s) => {
          if (usedElsewhere.has(s.id) && !(s.id in picked)) {
            return `<tr><td class="muted">${esc(s.name)} <span class="badge grey">already combined elsewhere</span></td><td class="num muted">—</td></tr>`;
          }
          return memberRowHtml(s, s.id in picked, picked[s.id]);
        }).join('')}</tbody>
      </table></div>
      <p class="hint" id="sc-ratio-total" style="margin-top:10px;${pickedCount >= 2 && ratioTotal !== 100 ? 'color:var(--danger);font-weight:700' : ''}">
        ${pickedCount < 2 ? 'Pick at least 2 subjects to combine.' : `Ratio total: ${ratioTotal}%${ratioTotal === 100 ? ' ✓' : ' — must add up to 100%'}`}
      </p>
    `;

    body.querySelectorAll('.sc-pick').forEach((chk) => chk.onchange = () => { syncFromDom(); draw(); });
    body.querySelectorAll('.sc-ratio').forEach((inp) => inp.oninput = () => {
      const total = [...body.querySelectorAll('#sc-member-table tbody tr')].reduce((a, tr) => {
        if (!tr.querySelector('.sc-pick') || !tr.querySelector('.sc-pick').checked) return a;
        return a + (Number(tr.querySelector('.sc-ratio').value) || 0);
      }, 0);
      const totalEl = body.querySelector('#sc-ratio-total');
      const rounded = Math.round(total * 10) / 10;
      if (totalEl) {
        totalEl.textContent = `Ratio total: ${rounded}%${rounded === 100 ? ' ✓' : ' — must add up to 100%'}`;
        totalEl.style.color = rounded === 100 ? '' : 'var(--danger)';
        totalEl.style.fontWeight = rounded === 100 ? '' : '700';
      }
    });
  }
}
