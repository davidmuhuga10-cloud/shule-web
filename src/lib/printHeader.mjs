/**
 * printHeader.mjs — shared printable-report header (feature brief §2/§4:
 * "Logo: far left. School name: centered, with the specific report name
 * shown just below it... Address/contact block: far right. Match the sample
 * below exactly... applies to every printout in the system"), plus the
 * mandatory-contact-info gate that goes with it (feature brief §3: "block
 * printing and show a message... if a school hasn't set this information
 * yet"). Kept dependency-free (own esc(), no app.js import) so it stays a
 * plain, unit-testable lib module — same convention as xlsxUtil.mjs/
 * csvExport.mjs — the caller wires up any click handlers.
 */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The structured address (feature brief §3: P.O. Box number, ZIP/postal
 *  code and Town as separate fields, instead of one free-text field) plus
 *  phone/email, is what "contact/address details" means for the mandatory-
 *  before-printing check below. Logo is deliberately NOT part of this check
 *  — it stays optional. */
export function isContactInfoComplete(settings) {
  settings = settings || {};
  return !!(String(settings.po_box || '').trim() && String(settings.postal_code || '').trim()
    && String(settings.town || '').trim() && String(settings.phone || '').trim());
}

/** Builds the printed address block's lines: "P.O. Box <n>-<zip> <town>"
 *  on one line (only the parts that are actually set), then phone, then
 *  email — same shape every report's header shows. */
export function addressLines(settings) {
  settings = settings || {};
  const lines = [];
  const boxBits = [];
  if (settings.po_box) boxBits.push('P.O. Box ' + settings.po_box + (settings.postal_code ? '-' + settings.postal_code : ''));
  else if (settings.postal_code) boxBits.push(settings.postal_code);
  if (settings.town) boxBits.push(settings.town);
  if (boxBits.length) lines.push(boxBits.join(', '));
  if (settings.phone) lines.push(settings.phone);
  if (settings.email) lines.push(settings.email);
  return lines;
}

/** The standard report header, Round 6 "Bold Letterhead Band" redesign
 *  (approved design: logo far left in a circular badge, school name
 *  centered in white/uppercase, address block far right in white — all on
 *  a solid brand-teal band, closed off by a doubled amber rule). Logo/
 *  school/address positions are unchanged from before; only the visual
 *  treatment (solid color band instead of plain white) changed. */
export function printHeaderHtml(settings) {
  settings = settings || {};
  const logoHtml = settings.logo
    ? `<img class="logo-thumb ph-logo-img" src="${esc(settings.logo)}">`
    : `<div class="logo-placeholder ph-logo-img">🏫</div>`;
  const lines = addressLines(settings);
  return `<div class="print-header">
    <div class="ph-logo">${logoHtml}</div>
    <div class="ph-center">
      <div class="ph-school">${esc(settings.school_name || 'School')}</div>
    </div>
    <div class="ph-address">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
  </div>`;
}

/** Round 6 redesign: the old solid brand-green "rectangle" bar is gone —
 *  replaced by a plain black-text row directly under the new letterhead
 *  band (see printHeaderHtml() above), which now carries the color. Two
 *  shapes are supported:
 *   - a single string (every report that only ever had one descriptive
 *     title) renders centered, bold black text — same spot, same content,
 *     just restyled to match the new letterhead.
 *   - an array of parts (the approved Mark List design: class name / exam
 *     name / report name spread across the full width) renders the first
 *     part flush left, the last part flush right and enlarged (it's the
 *     report's own name — "MARK LIST" in the approved design), and
 *     anything in between centered. Falsy parts are dropped, so a report
 *     that only has two of the three slots still lays out sensibly. */
export function reportTitleBarHtml(titleOrParts) {
  const parts = Array.isArray(titleOrParts) ? titleOrParts.filter((p) => p) : (titleOrParts ? [titleOrParts] : []);
  if (!parts.length) return '';
  if (parts.length === 1) {
    return `<div class="ph-title-bar"><span class="ph-title-solo">${esc(parts[0])}</span></div>`;
  }
  const left = parts[0];
  const right = parts[parts.length - 1];
  const center = parts.slice(1, -1).join(' — ');
  return `<div class="ph-title-bar">
    <span class="ph-title-left">${esc(left)}</span>
    <span class="ph-title-center">${esc(center)}</span>
    <span class="ph-title-right">${esc(right)}</span>
  </div>`;
}

/** The blocking message shown instead of a report when contact info isn't
 *  set yet. Returns HTML with a `[data-goto-settings]` button for the
 *  caller to wire up (kept decoupled from app.js's `go()` router). */
export function missingContactInfoHtml() {
  return `<div class="card"><div class="card-b"><div class="empty warn">
    <div class="e-ico">⚠️</div><h3>School contact details required</h3>
    <p>Before printing or downloading any report, please set your school's P.O. Box number, postal code, town and phone number in Settings.</p>
    <button class="btn" data-goto-settings>Go to Settings</button>
  </div></div></div>`;
}

/** Convenience: render the blocking message into `root` and wire its button
 *  to `goSettings` (pass app.js's `go` bound to the 'settings' route, e.g.
 *  `() => go('settings')`). */
export function renderMissingContactInfo(root, goSettings) {
  root.innerHTML = missingContactInfoHtml();
  const btn = root.querySelector('[data-goto-settings]');
  if (btn) btn.onclick = goSettings;
}
