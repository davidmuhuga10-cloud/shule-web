import { esc, toast, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { isContactInfoComplete } from '../lib/printHeader.mjs';

// Round 3 §4: "School Closed On"/"Next Term Begins On" used to live here —
// moved out entirely, into the Report Forms module itself (reportForms.mjs),
// inline with report generation, per direct follow-up feedback that
// acknowledging Settings as the wrong place wasn't enough; they needed to
// actually move. Both are still plain `settings` rows (school_closed_on /
// next_term_begins_on, read by _reportCard.mjs's termDatesHtml()) — only
// WHERE they're edited changed, not the underlying data model.
const MAX_DIM = 160;
const MAX_LEN = 45000;
// System Fixes brief §1: "Reduce the accepted maximum logo size from 5MB to
// 1MB" — checked on the ORIGINAL file before any processing, a fast reject
// for anything clearly too big, on top of (not instead of) the existing
// shrink-to-fit compression below which still handles anything under this
// limit down to a small stored thumbnail.
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024; // 1 MB
// Brief §1's "the previous file must be deleted completely from the
// database — not left behind" is already true structurally: the logo lives
// as a single `settings` row (key='logo'), and Db.settings.save() always
// UPDATEs that one row in place — there's no history table, no separate
// storage object, nothing versioned. Saving a new logo (or removing one)
// necessarily overwrites/clears the only copy that ever existed; there is
// no leftover to clean up. Documented here since it's easy to assume a
// base64-in-a-text-column design needs an explicit delete step — it doesn't.

export async function viewSettings(root) {
  const res = await Db.settings.get();
  const settings = res.ok ? res.data : {};
  render(root, settings);
}

function render(root, settings) {
  const logoPreview = settings.logo
    ? `<img class="logo-thumb" id="set-logo-preview" src="${esc(settings.logo)}">`
    : `<div class="logo-placeholder" id="set-logo-preview">🏫</div>`;

  // Feature brief §3: contact/address details are compulsory before
  // anything can be printed (the logo stays optional) — a visible reminder
  // right here, on the screen where an admin would actually fix it, rather
  // than only surfacing it as a dead end on some report screen later.
  const contactWarning = isContactInfoComplete(settings) ? '' : `
    <div class="empty warn" style="margin-bottom:16px">
      <div class="e-ico">⚠️</div><h3>Contact details required before printing</h3>
      <p>P.O. Box number, postal code, town and phone are required — no report can be printed or downloaded until these are set.</p>
    </div>`;

  // System Fixes brief §3: "Mark every mandatory field with a red asterisk
  // so it's clear at a glance what's missing." Same 4 fields
  // isContactInfoComplete() already enforces before printing — the
  // asterisk and the block-on-save check below both key off that exact
  // same list, so there's only one definition of "required" anywhere.
  const req = ' <span style="color:var(--danger)">*</span>';

  root.innerHTML = `
    <div class="page-head"><div><h2>School Settings</h2><p>Shown on report forms, class lists and the login screen.</p></div></div>
    ${contactWarning}
    <div class="card">
      <div class="card-b">
        <div class="field"><label>School name</label><input id="set-name" value="${esc(settings.school_name || '')}" placeholder="e.g. Riverside Academy"></div>
        <div class="field"><label>Motto (optional)</label><input id="set-motto" value="${esc(settings.school_motto || '')}" placeholder="e.g. Excellence Through Discipline"></div>
        <p class="hint" style="margin:14px 0 4px">Address / contact details (required before printing any report)</p>
        <div class="grid3">
          <div class="field"><label>P.O. Box number${req}</label><input id="set-pobox" value="${esc(settings.po_box || '')}" placeholder="e.g. 100"></div>
          <div class="field"><label>Postal / ZIP code${req}</label><input id="set-postal" value="${esc(settings.postal_code || '')}" placeholder="e.g. 00100"></div>
          <div class="field"><label>Town${req}</label><input id="set-town" value="${esc(settings.town || '')}" placeholder="e.g. Nairobi"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Phone${req}</label><input id="set-phone" value="${esc(settings.phone || '')}" placeholder="e.g. 0712 345 678"></div>
          <div class="field"><label>Email (optional)</label><input id="set-email" type="email" value="${esc(settings.email || '')}" placeholder="e.g. info@yourschool.ac.ke"></div>
        </div>
        <div class="field">
          <label>Logo (optional)</label>
          <div style="display:flex;align-items:center;gap:14px">
            ${logoPreview}
            <div>
              <input id="set-logo-file" type="file" accept="image/*">
              ${settings.logo ? '<button class="btn ghost sm" id="set-logo-remove" style="margin-top:6px">Remove logo</button>' : ''}
            </div>
          </div>
          <p class="hint">Automatically shrunk to a small thumbnail for fast loading on report forms and class lists. Files over 1 MB are rejected outright — compress your image and try again.</p>
        </div>
      </div>
      <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn" id="set-save">Save settings</button></div>
    </div>
  `;

  let pendingLogo = settings.logo || '';

  root.querySelector('#set-logo-file').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      // Brief §1: "Show a clear warning... tell the user directly to
      // compress their image to under 1MB and try again."
      toast(`That image is too large (${Math.round(file.size / 1024 / 1024 * 10) / 10} MB) — please compress it to under 1 MB and try again.`, 'err');
      e.target.value = '';
      return;
    }
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

  const saveBtn = root.querySelector('#set-save');
  saveBtn.onclick = async () => {
    const payload = {
      school_name: root.querySelector('#set-name').value,
      school_motto: root.querySelector('#set-motto').value,
      po_box: root.querySelector('#set-pobox').value,
      postal_code: root.querySelector('#set-postal').value,
      town: root.querySelector('#set-town').value,
      phone: root.querySelector('#set-phone').value,
      email: root.querySelector('#set-email').value,
      logo: pendingLogo
    };
    // Brief §3: "Block saving of changes until all mandatory fields are
    // filled in" — same 4 fields the red asterisks above flag, checked with
    // the exact same helper printHeader.mjs/report screens already use, so
    // "required" means one consistent thing everywhere in the app.
    if (!isContactInfoComplete(payload)) {
      toast('P.O. Box number, postal code, town and phone are all required before settings can be saved.', 'err');
      return;
    }
    // Brief §2 (BUG): "Save Settings doesn't give immediate feedback... users
    // click it repeatedly." See withBusy() in app.js — same one-line fix
    // applied to every other standalone Save/action button in the app.
    await withBusy(saveBtn, async () => {
      const res = await Db.settings.save(payload);
      if (res.ok) { toast('Settings saved.', 'ok'); render(root, payload); } else toast(res.message, 'err');
    }, 'Saving…');
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
