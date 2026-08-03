import { esc, modal, closeModal, toast, confirmAction, options } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { CBC_LEVELS } from '../lib/api/academics.mjs';

export async function viewSubjects(root) {
  await render(root);
}

async function render(root) {
  const res = await Db.subjects.list();
  const subjects = res.ok ? res.data : [];
  const levels = (res.ok && res.levels) || CBC_LEVELS;

  const groups = [...levels, null];
  const groupHtml = groups.map((level) => {
    const rows = subjects.filter((s) => (s.level || null) === level);
    if (!rows.length && level !== null) return ''; // hide empty CBC level groups until loaded
    if (!rows.length) return '';
    const items = rows.map((s) => `<span class="chip on" data-edit="${s.id}">
        ${esc(s.name)}${s.code ? ' (' + esc(s.code) + ')' : ''}
      </span>`).join('');
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>${esc(level || 'Custom / other')}</h3></div>
      <div class="card-b"><div class="chips">${items}</div></div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-head"><div><h2>Subjects</h2><p>The official Kenyan CBC learning areas, or your own custom subjects.</p></div>
      <div class="spacer"></div>
      <button class="btn secondary" id="load-cbc">📥 Load CBC subjects</button>
      <button class="btn" id="add-subject">+ Add subject</button>
    </div>
    ${subjects.length ? groupHtml : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">📚</div><h3>No subjects yet</h3>
      <p>Load the official Kenyan CBC subject list to get started, or add your own custom subject.</p>
      <button class="btn" id="empty-load-cbc">📥 Load CBC subjects</button>
    </div></div></div>`}
    <p class="hint">Click a subject chip to edit or delete it.</p>
  `;

  root.querySelector('#add-subject').onclick = () => openSubjectModal(root, levels);
  const loadBtn = root.querySelector('#load-cbc'), emptyLoadBtn = root.querySelector('#empty-load-cbc');
  const doLoadCbc = async () => {
    const r = await Db.subjects.loadCbc();
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast(r.added > 0 ? `Added ${r.added} CBC subject(s).` : 'CBC subjects are already loaded.', 'ok');
    render(root);
  };
  if (loadBtn) loadBtn.onclick = doLoadCbc;
  if (emptyLoadBtn) emptyLoadBtn.onclick = doLoadCbc;

  root.querySelectorAll('[data-edit]').forEach((chip) => {
    chip.onclick = () => openSubjectModal(root, levels, subjects.find((s) => s.id === chip.dataset.edit));
  });
}

function openSubjectModal(root, levels, existing) {
  const levelChoices = levels.map((l) => ({ id: l, name: l }));
  modal({
    title: existing ? 'Edit subject' : 'Add subject',
    body: `
      <div class="field"><label>Subject name</label><input id="su-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Mathematics"></div>
      <div class="field"><label>Level</label><select id="su-level">${options(levelChoices, 'id', 'name', existing ? existing.level : '', 'Custom / not level-specific')}</select></div>
      <div class="grid2">
        <div class="field"><label>Code (optional)</label><input id="su-code" value="${esc(existing ? existing.code || '' : '')}"></div>
        <div class="field"><label>Description (optional)</label><input id="su-desc" value="${esc(existing ? existing.description || '' : '')}"></div>
      </div>
      ${existing ? '<p class="hint"><a href="#" id="su-papers-link">📄 Manage papers (Paper 1 / Paper 2 weighting) for this subject</a></p>' : ''}
    `,
    okLabel: 'Save',
    footer: true,
    onOpen: () => {
      if (existing) {
        // Add a delete option next to the modal footer's Cancel/Save buttons.
        const footer = document.querySelector('.modal-f');
        if (footer && !footer.querySelector('#su-delete')) {
          const delBtn = document.createElement('button');
          delBtn.className = 'btn danger'; delBtn.id = 'su-delete'; delBtn.textContent = 'Delete';
          delBtn.style.marginRight = 'auto';
          delBtn.onclick = () => confirmAction('Delete this subject? This also removes its class/teacher assignments.', async () => {
            const r = await Db.subjects.remove(existing.id);
            if (r.ok) { toast('Subject deleted.', 'ok'); closeModal(); render(root); } else toast(r.message, 'err');
          }, true);
          footer.insertBefore(delBtn, footer.firstChild);
        }
        const papersLink = document.getElementById('su-papers-link');
        if (papersLink) papersLink.onclick = (e) => { e.preventDefault(); openPapersModal(root, levels, existing); };
      }
    },
    onOk: async () => {
      const payload = {
        id: existing ? existing.id : undefined,
        name: document.getElementById('su-name').value,
        level: document.getElementById('su-level').value || null,
        code: document.getElementById('su-code').value,
        description: document.getElementById('su-desc').value
      };
      const res = await Db.subjects.save(payload);
      if (res.ok) { toast('Subject saved.', 'ok'); closeModal(); render(root); } else toast(res.message, 'err');
    }
  });
}

/** Paper 1 / Paper 2 weighting (Phase 2a) — a subject with no papers here
 *  keeps working exactly as before (one whole-subject mark). Papers'
 *  weights don't have to sum to 1, but should for the combined score to
 *  land on the exam's own out_of scale — that's on the admin setting them
 *  up, not enforced here. */
async function openPapersModal(root, levels, subject) {
  const res = await Db.subjectPapers.list(subject.id);
  const papers = res.ok ? res.data : [];
  renderPapersModal(papers);

  function renderPapersModal(currentPapers) {
    modal({
      title: `Papers — ${subject.name}`,
      wide: true,
      body: `
        ${currentPapers.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Paper</th><th class="num">#</th><th class="num">Weight</th><th class="num">Out of</th><th></th></tr></thead>
          <tbody>${currentPapers.map((p) => `<tr>
            <td>${esc(p.name)}</td><td class="num">${p.paper_no}</td><td class="num">${p.weight}</td><td class="num">${p.out_of}</td>
            <td class="row-actions">
              <button class="icon-btn" data-edit-paper="${p.id}">✏️</button>
              <button class="icon-btn danger" data-del-paper="${p.id}">🗑️</button>
            </td></tr>`).join('')}</tbody>
        </table></div>` : `<p class="muted" style="margin:12px 0">No papers configured — this subject uses one whole-subject mark.</p>`}
        <p class="hint" style="margin-top:10px">Weights should add up to 1 across a subject's papers (e.g. 0.6 + 0.4) so the combined score lands correctly on the exam's own "out of".</p>
      `,
      okLabel: 'Close',
      footer: true,
      onOpen: () => {
        const footer = document.querySelector('.modal-f');
        if (footer && !footer.querySelector('#pp-add')) {
          const addBtn = document.createElement('button');
          addBtn.className = 'btn secondary'; addBtn.id = 'pp-add'; addBtn.textContent = '+ Add paper';
          addBtn.style.marginRight = 'auto';
          addBtn.onclick = () => openPaperFieldsModal(root, subject, currentPapers);
          footer.insertBefore(addBtn, footer.firstChild);
        }
        document.querySelectorAll('[data-edit-paper]').forEach((b) => b.onclick = () => openPaperFieldsModal(root, subject, currentPapers, currentPapers.find((p) => p.id === b.dataset.editPaper)));
        document.querySelectorAll('[data-del-paper]').forEach((b) => b.onclick = () => confirmAction(
          'Delete this paper? Any marks entered against it are kept, but will no longer be included in the combined subject score.',
          async () => {
            const r = await Db.subjectPapers.remove(b.dataset.delPaper);
            if (!r.ok) { toast(r.message, 'err'); return; }
            toast('Paper deleted.', 'ok');
            renderPapersModal(currentPapers.filter((p) => p.id !== b.dataset.delPaper));
          }, true
        ));
      },
      onOk: () => closeModal()
    });
  }

  function openPaperFieldsModal(root, subject, currentPapers, existingPaper) {
    modal({
      title: existingPaper ? 'Edit paper' : 'Add paper',
      body: `
        <div class="grid2">
          <div class="field"><label>Paper name</label><input id="pp-name" value="${esc(existingPaper ? existingPaper.name : `Paper ${currentPapers.length + 1}`)}" placeholder="e.g. Paper 1"></div>
          <div class="field"><label>Paper number</label><input id="pp-no" type="number" min="1" value="${existingPaper ? existingPaper.paper_no : currentPapers.length + 1}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Weight (share of subject score)</label><input id="pp-weight" type="number" step="0.05" min="0" max="1" value="${existingPaper ? existingPaper.weight : (currentPapers.length ? '' : 1)}"></div>
          <div class="field"><label>Out of (max score for this paper)</label><input id="pp-outof" type="number" value="${existingPaper ? existingPaper.out_of : 100}"></div>
        </div>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const payload = {
          id: existingPaper ? existingPaper.id : undefined,
          subject_id: subject.id,
          name: document.getElementById('pp-name').value,
          paper_no: document.getElementById('pp-no').value,
          weight: document.getElementById('pp-weight').value,
          out_of: document.getElementById('pp-outof').value
        };
        const res = await Db.subjectPapers.save(payload);
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast('Paper saved.', 'ok');
        closeModal();
        openPapersModal(root, levels, subject);
      }
    });
  }
}
