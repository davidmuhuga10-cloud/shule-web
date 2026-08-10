/**
 * shim-app.mjs — screenshot-harness stand-in for src/app.js.
 *
 * This is NOT a copy of app.js's view templates (those come from the real
 * production view modules, imported unmodified) — it only reimplements the
 * handful of small, dependency-free DOM helpers those views import from
 * app.js (esc/initials/options/loader/renderPrereq/modal/etc.), byte-for-byte
 * matching their real implementations, so the real view files can be loaded
 * in a bare page without pulling in the live app shell (auth, Supabase
 * client, router) that app.js's own module-scope init() would otherwise
 * kick off. An import map in each mockup HTML page redirects every view's
 * `from '../app.js'` to this file.
 */
export function $(sel, root) { return (root || document).querySelector(sel); }

export function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

export function loader() { return '<div class="loader"><div class="spin"></div></div>'; }

export function renderLoading(root, message) {
  root.innerHTML = `<div class="loader"><div class="spin"></div><p class="loader-msg">${esc(message || 'Loading, please wait…')}</p></div>`;
}

export function fmtDate(d) {
  if (!d) return '—';
  try { const dt = new Date(d); if (isNaN(dt)) return d; return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (e) { return d; }
}

export function toast(msg) { console.log('[toast]', msg); }

export function go(route) { console.log('[go]', route); }

export function printLandscape() { /* no-op in the screenshot harness */ }
export function printWithOptions() { /* no-op in the screenshot harness */ }

// Mirrors app.js's real printOptionsHtml()/wirePrintOptions() so the
// harness can verify these controls render correctly — actual printing is
// a no-op here, same as printLandscape() above.
export function printOptionsHtml(idPrefix, defaultOrientation) {
  const landscapeDefault = defaultOrientation === 'landscape';
  return `<div class="print-opts no-print">
    <select id="${idPrefix}-orient" title="Orientation">
      <option value="portrait" ${landscapeDefault ? '' : 'selected'}>Portrait</option>
      <option value="landscape" ${landscapeDefault ? 'selected' : ''}>Landscape</option>
    </select>
    <select id="${idPrefix}-size" title="Paper size">
      <option value="A4" selected>A4</option>
      <option value="A5">A5</option>
      <option value="Letter">Letter</option>
    </select>
    <button class="btn secondary" id="${idPrefix}-print-btn">🖨️ Print</button>
  </div>`;
}
export function wirePrintOptions(root, idPrefix) {
  const btn = root.querySelector(`#${idPrefix}-print-btn`);
  if (btn) btn.onclick = () => {};
}

export function renderPrereq(root, title, text, route, label) {
  root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn">
    <div class="e-ico">⚠️</div><h3>${esc(title)}</h3><p>${esc(text)}</p>
    ${route ? `<button class="btn" id="prereq-cta">${esc(label || 'Go there now')}</button>` : ''}
  </div></div></div>`;
}

export function options(list, valKey, labKey, selected, placeholder) {
  let html = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
  (list || []).forEach((it) => {
    const v = it[valKey], l = it[labKey];
    html += `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(l)}</option>`;
  });
  return html;
}

export function modal(opts) {
  const wide = opts.wide ? ' wide' : '';
  const foot = opts.footer === false ? '' :
    `<div class="modal-f">
      <button class="btn secondary" id="modal-cancel">${esc(opts.cancelLabel || 'Cancel')}</button>
      ${opts.okLabel ? `<button class="btn" id="modal-ok">${esc(opts.okLabel)}</button>` : ''}
    </div>`;
  const root = $('#modal-root');
  if (!root) return;
  root.innerHTML = `<div class="modal-back" id="modal-back">
    <div class="modal${wide}">
      <div class="modal-h"><h3>${esc(opts.title)}</h3></div>
      <div class="modal-b">${opts.body}</div>${foot}
    </div></div>`;
  // Mirrors app.js's real modal() busy-button behavior (disable + busy
  // label while opts.onOk is in flight) so this harness can verify it —
  // see app.js for the full explanation.
  if (opts.okLabel && opts.onOk) {
    const okBtn = $('#modal-ok');
    const originalLabel = okBtn.textContent;
    okBtn.onclick = async () => {
      if (okBtn.disabled) return;
      okBtn.disabled = true;
      okBtn.textContent = opts.busyLabel || 'Please wait…';
      try {
        await opts.onOk();
      } finally {
        if (document.body.contains(okBtn)) {
          okBtn.disabled = false;
          okBtn.textContent = originalLabel;
        }
      }
    };
  }
  if (opts.onOpen) opts.onOpen();
}

export function closeModal() { const r = $('#modal-root'); if (r) r.innerHTML = ''; }

// Mirrors app.js's real withBusy() — used directly by marksEntry.mjs's
// "Save marks" button (Exam Desk's Marks Entry tab).
export async function withBusy(btn, fn, busyLabel) {
  if (!btn || btn.disabled) return;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel || 'Please wait…';
  try {
    await fn();
  } finally {
    if (document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }
}

export function confirmAction(msg, onYes) {
  modal({ title: 'Please confirm', body: `<p style="margin:0">${esc(msg)}</p>`, okLabel: 'Yes, continue', onOk: () => { closeModal(); onYes(); } });
}

export const state = {
  profile: { name: 'David Kinyua', role: 'admin' },
  settings: { school_name: 'Tumaini Junior School' }
};
