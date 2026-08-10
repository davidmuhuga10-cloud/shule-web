import { esc, modal, closeModal, toast, confirmAction, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { CBC_COMPETENCY_SCALE_NAME } from '../lib/api/grading.mjs';

// Which scale cards are expanded — module-level so it survives a re-render
// (e.g. after saving a band) but not a full page navigation away and back.
// Starts empty ("all collapsed") once there's more than one scale, so a
// school with several scales (e.g. a letter scale + the CBC scale) isn't
// confronted with every band table open at once; a single scale just opens
// itself automatically since there's nothing to declutter.
let expandedIds = null;

export async function viewGrading(root) {
  expandedIds = null;
  await render(root);
}

async function render(root) {
  const res = await Db.grading.listScales();
  const scales = res.ok ? res.data : [];
  if (expandedIds === null) expandedIds = new Set(scales.length <= 1 ? scales.map((sc) => sc.id) : []);

  // Round 3 §8: "replace the current 'Add' button with 'Activate,' so the
  // admin simply turns it on rather than building it from scratch" — the
  // CBC scale is now pre-seeded for every new school (present but never
  // auto-selected — "do not auto-set a grading scale for a school"), so the
  // action needed is either creating it (older schools that predate this)
  // or simply promoting it to default (new schools) — loadCbcCompetencyScale()
  // now does both in one click, so one "Activate" button/label covers it.
  const cbcScale = scales.find((sc) => sc.name === CBC_COMPETENCY_SCALE_NAME);
  const showActivateCbc = !cbcScale || !cbcScale.is_default;
  const hasAnyDefault = scales.some((sc) => sc.is_default);

  root.innerHTML = `
    <div class="page-head"><div><h2>Grading Scales</h2><p>Configure how raw scores map to letter grades. One scale is used as the default for grading — exams can't be published until one is active.</p></div>
      <div class="spacer"></div>
      ${showActivateCbc ? '<button class="btn secondary" id="load-cbc-scale">✅ Activate CBC competency scale</button>' : ''}
      <button class="btn" id="add-scale">+ Add scale</button></div>
    ${!hasAnyDefault && scales.length ? `<div class="card" style="margin-bottom:16px;border-color:var(--warn)"><div class="card-b">
      <p class="hint" style="margin:0"><b>⚠️ No grading scale is active yet.</b> Exams can't be published until one is — activate the CBC scale above, or click "Make default" on one of the scales below.</p>
    </div></div>` : ''}
    ${scales.length ? scales.map((sc) => scaleCard(sc, expandedIds.has(sc.id))).join('') : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">🎯</div><h3>No grading scales yet</h3><p>Activate the standard CBC competency scale below, or build your own from scratch.</p>
      <button class="btn secondary" id="empty-load-cbc-scale">✅ Activate CBC competency scale</button>
      <button class="btn" id="empty-add-scale">+ Add scale</button>
    </div></div></div>`}
  `;

  root.querySelectorAll('[data-toggle-scale]').forEach((b) => b.onclick = () => {
    const id = b.dataset.toggleScale;
    if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
    render(root);
  });
  root.querySelector('#add-scale').onclick = () => openScaleModal(root);
  const emptyBtn = root.querySelector('#empty-add-scale');
  if (emptyBtn) emptyBtn.onclick = () => openScaleModal(root);
  const doLoadCbcScale = async (btn) => withBusy(btn, async () => {
    const r = await Db.grading.loadCbcCompetencyScale();
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast(r.added ? 'CBC competency scale activated.' : 'CBC competency scale is now active.', 'ok');
    render(root);
  }, 'Activating…');
  const loadBtn = root.querySelector('#load-cbc-scale'), emptyLoadBtn = root.querySelector('#empty-load-cbc-scale');
  if (loadBtn) loadBtn.onclick = () => doLoadCbcScale(loadBtn);
  if (emptyLoadBtn) emptyLoadBtn.onclick = () => doLoadCbcScale(emptyLoadBtn);

  scales.forEach((sc) => {
    root.querySelector(`[data-edit-scale="${sc.id}"]`).onclick = () => openScaleModal(root, sc);
    const defaultBtn = root.querySelector(`[data-default-scale="${sc.id}"]`);
    defaultBtn?.addEventListener('click', () => withBusy(defaultBtn, async () => {
      const r = await Db.grading.setDefaultScale(sc.id);
      if (r.ok) { toast('Default scale updated.', 'ok'); render(root); } else toast(r.message, 'err');
    }, 'Setting…'));
    root.querySelector(`[data-del-scale="${sc.id}"]`).onclick = () => confirmAction('Delete this grading scale and all its bands?', async () => {
      const r = await Db.grading.deleteScale(sc.id);
      if (r.ok) { toast('Scale deleted.', 'ok'); render(root); } else toast(r.message, 'err');
    }, true);
    const addBandBtn = root.querySelector(`[data-add-band="${sc.id}"]`);
    if (addBandBtn) addBandBtn.onclick = () => openBandModal(root, sc);
    (sc.bands || []).forEach((b) => {
      const editBtn = root.querySelector(`[data-edit-band="${b.id}"]`);
      const delBtn = root.querySelector(`[data-del-band="${b.id}"]`);
      if (editBtn) editBtn.onclick = () => openBandModal(root, sc, b);
      if (delBtn) delBtn.onclick = () => confirmAction('Delete this band?', async () => {
        const r = await Db.grading.deleteBand(b.id);
        if (r.ok) { toast('Band deleted.', 'ok'); render(root); } else toast(r.message, 'err');
      }, true);
    });
  });
}

function scaleCard(sc, expanded) {
  const bandsRows = (sc.bands || []).length
    ? sc.bands.map((b) => `<tr>
        <td>${b.min_score}–${b.max_score}</td><td><b>${esc(b.grade_label)}</b></td><td>${b.points ?? '—'}</td><td>${esc(b.remark || '—')}</td>
        <td class="row-actions"><button class="btn sm secondary" data-edit-band="${b.id}">Edit</button><button class="btn sm danger" data-del-band="${b.id}">Delete</button></td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="muted center">No bands yet — add one below.</td></tr>`;

  return `<div class="card" style="margin-bottom:16px">
    <div class="card-h">
      <div data-toggle-scale="${sc.id}" style="display:flex;align-items:center;gap:12px;cursor:pointer;flex:1;min-width:0">
        <span style="font-size:12px;color:var(--muted);width:14px;display:inline-block">${expanded ? '▾' : '▸'}</span>
        <h3 style="margin:0">${esc(sc.name)}</h3>
        <span class="badge grey">${(sc.bands || []).length} band${(sc.bands || []).length === 1 ? '' : 's'}</span>
        ${sc.is_default ? '<span class="badge green">Default</span>' : ''}
      </div>
      ${sc.is_default ? '' : `<button class="btn ghost sm" data-default-scale="${sc.id}">Make default</button>`}
      <button class="btn sm secondary" data-edit-scale="${sc.id}">Edit</button>
      <button class="btn sm danger" data-del-scale="${sc.id}">Delete</button>
    </div>
    ${expanded ? `
    <div class="card-b table-wrap">
      <table class="data"><thead><tr><th>Range</th><th>Grade</th><th>Points</th><th>Remark</th><th></th></tr></thead>
      <tbody>${bandsRows}</tbody></table>
    </div>
    <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn sm" data-add-band="${sc.id}">+ Add band</button></div>` : ''}
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
