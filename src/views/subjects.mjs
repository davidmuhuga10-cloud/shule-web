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
      ${existing ? '' : ''}
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
