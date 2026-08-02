import { esc, modal, closeModal, toast, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewClasses(root) {
  await render(root);
}

async function render(root) {
  const res = await Db.classes.list();
  const classes = res.ok ? res.data : [];

  const rows = classes.length
    ? classes.map((c) => `<tr>
        <td>${esc(c.name)}</td>
        <td class="num">${c.level_order || 0}</td>
        <td class="num">${c.stream_count}</td>
        <td class="num">${c.student_count}</td>
        <td class="row-actions">
          <button class="icon-btn" data-edit="${c.id}">✏️</button>
          <button class="icon-btn danger" data-del="${c.id}">🗑️</button>
        </td></tr>`).join('')
    : '';

  root.innerHTML = `
    <div class="page-head"><div><h2>Classes &amp; Streams</h2><p>Set up your classes, and add streams (class arms) inline.</p></div>
      <div class="spacer"></div><button class="btn" id="add-class">+ Add class</button></div>
    <div class="card">
      ${classes.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Class</th><th class="num">Order</th><th class="num">Streams</th><th class="num">Students</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<div class="card-b"><div class="empty">
          <div class="e-ico">🏫</div><h3>No classes yet</h3>
          <p>Add your first class (e.g. "Grade 7" or "Form 1") — you can add its streams at the same time.</p>
          <button class="btn" id="empty-add-class">+ Add class</button>
        </div></div>`}
    </div>`;

  root.querySelector('#add-class').onclick = () => openClassModal(root);
  const emptyBtn = root.querySelector('#empty-add-class');
  if (emptyBtn) emptyBtn.onclick = () => openClassModal(root);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openClassModal(root, classes.find((c) => c.id === b.dataset.edit)));
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmAction(
    'Delete this class? This also removes its streams.',
    async () => {
      const r = await Db.classes.remove(b.dataset.del);
      if (r.ok) { toast('Class deleted.', 'ok'); render(root); } else toast(r.message, 'err');
    },
    true
  ));
}

async function openClassModal(root, existing) {
  let streams = [];
  if (existing) {
    const sres = await Db.streams.list(existing.id);
    streams = sres.ok ? sres.data : [];
  }
  renderModal(streams);

  function renderModal(currentStreams) {
    modal({
      title: existing ? 'Edit class' : 'Add class',
      wide: true,
      body: `
        <div class="field"><label>Class name</label><input id="cl-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Grade 7"></div>
        <div class="grid2">
          <div class="field"><label>Order (for sorting, lower first)</label><input id="cl-order" type="number" value="${existing ? existing.level_order || 0 : 0}"></div>
          <div class="field"><label>Description (optional)</label><input id="cl-desc" value="${esc(existing ? existing.description || '' : '')}"></div>
        </div>
        <div class="field">
          <label>Streams${existing ? ' (class arms)' : ''}</label>
          ${existing ? `<div class="chips" id="stream-chips" style="margin-bottom:10px">
            ${currentStreams.map((s) => `<span class="chip on" data-stream="${s.id}">${esc(s.name)} &times;</span>`).join('') || '<span class="muted" style="font-size:13px">No streams yet.</span>'}
          </div>` : ''}
          <input id="cl-streams" placeholder="Add stream names, comma-separated (e.g. North, South)">
          <p class="hint">${existing ? 'New names above are added; click an existing chip to remove it.' : 'Optional — you can also add streams later.'}</p>
        </div>
      `,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('cl-name').value;
        const level_order = Number(document.getElementById('cl-order').value) || 0;
        const description = document.getElementById('cl-desc').value;
        const newStreams = document.getElementById('cl-streams').value.split(',').map((s) => s.trim()).filter(Boolean);
        const res = await Db.classes.save({ id: existing ? existing.id : undefined, name, level_order, description, streams: newStreams });
        if (!res.ok) { toast(res.message, 'err'); return; }
        if (res.streamsAdded) toast(`Class saved — ${res.streamsAdded} stream(s) added.`, 'ok');
        else toast('Class saved.', 'ok');
        closeModal();
        render(root);
      }
    });

    if (existing) {
      document.querySelectorAll('#stream-chips [data-stream]').forEach((chip) => {
        chip.onclick = () => confirmAction('Remove this stream?', async () => {
          const r = await Db.streams.remove(chip.dataset.stream);
          if (!r.ok) { toast(r.message, 'err'); return; }
          toast('Stream removed.', 'ok');
          const updated = currentStreams.filter((s) => s.id !== chip.dataset.stream);
          renderModal(updated);
        }, true);
      });
    }
  }
}
