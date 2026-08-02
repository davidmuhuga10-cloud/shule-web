import { esc, toast } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const MAX_DIM = 160;
const MAX_LEN = 45000;

export async function viewSettings(root) {
  const res = await Db.settings.get();
  const settings = res.ok ? res.data : {};
  render(root, settings);
}

function render(root, settings) {
  const logoPreview = settings.logo
    ? `<img class="logo-thumb" id="set-logo-preview" src="${settings.logo}">`
    : `<div class="logo-placeholder" id="set-logo-preview">🏫</div>`;

  root.innerHTML = `
    <div class="page-head"><div><h2>School Settings</h2><p>Shown on report forms, class lists and the login screen.</p></div></div>
    <div class="card">
      <div class="card-b">
        <div class="field"><label>School name</label><input id="set-name" value="${esc(settings.school_name || '')}" placeholder="e.g. Riverside Academy"></div>
        <div class="field"><label>Motto (optional)</label><input id="set-motto" value="${esc(settings.school_motto || '')}" placeholder="e.g. Excellence Through Discipline"></div>
        <div class="grid2">
          <div class="field"><label>P.O. Box</label><input id="set-pobox" value="${esc(settings.po_box || '')}" placeholder="e.g. 100–00100, Nairobi"></div>
          <div class="field"><label>Phone</label><input id="set-phone" value="${esc(settings.phone || '')}" placeholder="e.g. 0712 345 678"></div>
        </div>
        <div class="field"><label>Email</label><input id="set-email" type="email" value="${esc(settings.email || '')}" placeholder="e.g. info@yourschool.ac.ke"></div>
        <div class="field">
          <label>Logo</label>
          <div style="display:flex;align-items:center;gap:14px">
            ${logoPreview}
            <div>
              <input id="set-logo-file" type="file" accept="image/*">
              ${settings.logo ? '<button class="btn ghost sm" id="set-logo-remove" style="margin-top:6px">Remove logo</button>' : ''}
            </div>
          </div>
          <p class="hint">Automatically shrunk to a small thumbnail for fast loading on report forms and class lists.</p>
        </div>
      </div>
      <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn" id="set-save">Save settings</button></div>
    </div>
  `;

  let pendingLogo = settings.logo || '';

  root.querySelector('#set-logo-file').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    shrinkImage(file, (dataUrl) => {
      pendingLogo = dataUrl;
      const preview = document.getElementById('set-logo-preview');
      preview.outerHTML = `<img class="logo-thumb" id="set-logo-preview" src="${dataUrl}">`;
      toast('Logo ready — click "Save settings" to apply.', 'ok');
    }, () => toast('Could not process that image. Try a smaller file.', 'err'));
  };

  const removeBtn = root.querySelector('#set-logo-remove');
  if (removeBtn) removeBtn.onclick = () => {
    pendingLogo = '';
    document.getElementById('set-logo-preview').outerHTML = `<div class="logo-placeholder" id="set-logo-preview">🏫</div>`;
    toast('Logo will be removed on save.', 'warn');
  };

  root.querySelector('#set-save').onclick = async () => {
    const payload = {
      school_name: root.querySelector('#set-name').value,
      school_motto: root.querySelector('#set-motto').value,
      po_box: root.querySelector('#set-pobox').value,
      phone: root.querySelector('#set-phone').value,
      email: root.querySelector('#set-email').value,
      logo: pendingLogo
    };
    const res = await Db.settings.save(payload);
    if (res.ok) { toast('Settings saved.', 'ok'); render(root, payload); } else toast(res.message, 'err');
  };
}

/** Client-side resize via Canvas — keeps the stored value small since it lives in a text column. */
function shrinkImage(file, onDone, onError) {
  const img = new Image();
  const reader = new FileReader();
  reader.onload = (e) => {
    img.onload = () => {
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      let dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length > MAX_LEN) {
        // Fall back to JPEG with decreasing quality until it fits.
        for (let q = 0.8; q >= 0.3 && dataUrl.length > MAX_LEN; q -= 0.1) {
          dataUrl = canvas.toDataURL('image/jpeg', q);
        }
      }
      if (dataUrl.length > MAX_LEN) { onError(); return; }
      onDone(dataUrl);
    };
    img.onerror = onError;
    img.src = e.target.result;
  };
  reader.onerror = onError;
  reader.readAsDataURL(file);
}
