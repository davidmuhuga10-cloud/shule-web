import { esc, modal, closeModal, toast, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { CBC_COMPETENCY_SCALE_NAME } from '../lib/api/grading.mjs';

export async function viewGrading(root) {
  await render(root);
}

async function render(root) {
  const res = await Db.grading.listScales();
  const scales = res.ok ? res.data : [];

  const hasCbcScale = scales.some((sc) => sc.name === CBC_COMPETENCY_SCALE_NAME);

  root.innerHTML = `
    <div class="page-head"><div><h2>Grading Scales</h2><p>Configure how raw scores map to letter grades. One scale is used as the default for grading.</p></div>
      <div class="spacer"></div>
      ${hasCbcScale ? '' : '<button class="btn secondary" id="load-cbc-scale">📥 Load CBC competency scale</button>'}
      <button class="btn" id="add-scale">+ Add scale</button></div>
    ${scales.length ? scales.map((sc) => scaleCard(sc)).join('') : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">🎯</div><h3>No grading scales yet</h3><p>Add one to start grading exam results, or load the standard CBC competency scale below.</p>
      <button class="btn secondary" id="empty-load-cbc-scale">📥 Load CBC competency scale</button>
      <button class="btn" id="empty-add-scale">+ Add scale</button>
    </div></div></div>`}
  `;

  root.querySelector('#add-scale').onclick = () => openScaleModal(root);
  const emptyBtn = root.querySelector('#empty-add-scale');
  if (emptyBtn) emptyBtn.onclick = () => openScaleModal(root);
  const doLoadCbcScale = async () => {
    const r = await Db.grading.loadCbcCompetencyScale();
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast(r.added ? 'CBC competency scale loaded.' : 'The CBC competency scale is already loaded.', 'ok');
    render(root);
  };
  const loadBtn = root.querySelector('#load-cbc-scale'), emptyLoadBtn = root.querySelector('#empty-load-cbc-scale');
  if (loadBtn) loadBtn.onclick = doLoadCbcScale;
  if (emptyLoadBtn) emptyLoadBtn.onclick = doLoadCbcScale;

  scales.forEach((sc) => {
    root.querySelector(`[data-edit-scale="${sc.id}"]`).onclick = () => openScaleModal(root, sc);
    root.querySelector(`[data-default-scale="${sc.id}"]`)?.addEventListener('click', async () => {
      const r = await Db.grading.setDefaultScale(sc.id);
      if (r.ok) { toast('Default scale updated.', 'ok'); render(root); } else toast(r.message, 'err');
    });
    root.querySelector(`[data-del-scale="${sc.id}"]`).onclick = () => confirmAction('Delete this grading scale and all its bands?', async () => {
      const r = await Db.grading.deleteScale(sc.id);
      if (r.ok) { toast('Scale deleted.', 'ok'); render(root); } else toast(r.message, 'err');
    }, true);
    root.querySelector(`[data-add-band="${sc.id}"]`).onclick = () => openBandModal(root, sc);
    (sc.bands || []).forEach((b) => {
      root.querySelector(`[data-edit-band="${b.id}"]`).onclick = () => openBandModal(root, sc, b);
      root.querySelector(`[data-del-band="${b.id}"]`).onclick = () => confirmAction('Delete this band?', async () => {
        const r = await Db.grading.deleteBand(b.id);
        if (r.ok) { toast('Band deleted.', 'ok'); render(root); } else toast(r.message, 'err');
      }, true);
    });
  });
}

function scaleCard(sc) {
  const bandsRows = (sc.bands || []).length
    ? sc.bands.map((b) => `<tr>
        <td>${b.min_score}–${b.max_score}</td><td><b>${esc(b.grade_label)}</b></td><td>${b.points ?? '—'}</td><td>${esc(b.remark || '—')}</td>
        <td class="row-actions"><button class="icon-btn" data-edit-band="${b.id}">✏️</button><button class="icon-btn danger" data-del-band="${b.id}">🗑️</button></td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="muted center">No bands yet — add one below.</td></tr>`;

  return `<div class="card" style="margin-bottom:16px">
    <div class="card-h">
      <h3>${esc(sc.name)}</h3>
      ${sc.is_default ? '<span class="badge green">Default</span>' : `<button class="btn ghost sm" data-default-scale="${sc.id}">Make default</button>`}
      <div class="spacer"></div>
      <button class="icon-btn" data-edit-scale="${sc.id}">✏️</button>
      <button class="icon-btn danger" data-del-scale="${sc.id}">🗑️</button>
    </div>
    <div class="card-b table-wrap">
      <table class="data"><thead><tr><th>Range</th><th>Grade</th><th>Points</th><th>Remark</th><th></th></tr></thead>
      <tbody>${bandsRows}</tbody></table>
    </div>
    <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn sm" data-add-band="${sc.id}">+ Add band</button></div>
  </div>`;
}

function openScaleModal(root, existing) {
  modal({
    title: existing ? 'Edit scale' : 'Add grading scale',
    body: `
      <div class="field"><label>Name</label><input id="gs-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Default Grading Scale"></div>
      <div class="field"><label>Description (optional)</label><input id="gs-desc" value="${esc(existing ? existing.description || '' : '')}"></div>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const res = await Db.grading.saveScale({ id: existing ? existing.id : undefined, name: document.getElementById('gs-name').value, description: document.getElementById('gs-desc').value });
      if (res.ok) { toast('Scale saved.', 'ok'); closeModal(); render(root); } else toast(res.message, 'err');
    }
  });
}

function openBandModal(root, scale, existing) {
  modal({
    title: existing ? 'Edit band' : 'Add band',
    body: `
      <div class="grid2">
        <div class="field"><label>Min score</label><input id="gb-min" type="number" value="${existing ? existing.min_score : ''}"></div>
        <div class="field"><label>Max score</label><input id="gb-max" type="number" value="${existing ? existing.max_score : ''}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Grade label</label><input id="gb-label" value="${esc(existing ? existing.grade_label : '')}" placeholder="e.g. A"></div>
        <div class="field"><label>Points (optional)</label><input id="gb-points" type="number" value="${existing && existing.points != null ? existing.points : ''}"></div>
      </div>
      <div class="field"><label>Remark (optional)</label><input id="gb-remark" value="${esc(existing ? existing.remark || '' : '')}" placeholder="e.g. Excellent"></div>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const res = await Db.grading.saveBand({
        id: existing ? existing.id : undefined, grading_scale_id: scale.id,
        min_score: document.getElementById('gb-min').value, max_score: document.getElementById('gb-max').value,
        grade_label: document.getElementById('gb-label').value, points: document.getElementById('gb-points').value || null,
        remark: document.getElementById('gb-remark').value
      });
      if (res.ok) { toast('Band saved.', 'ok'); closeModal(); render(root); } else toast(res.message, 'err');
    }
  });
}
