/**
 * app.js — Shule SPA shell: auth screen, sidebar/topbar, hash router, modal
 * and toast helpers. Direct port of the Apps Script version's JavaScript.html
 * shell logic, with google.script.run/gcall/api() replaced by Supabase Auth
 * (src/lib/auth.js) and the Db data-access layer (src/lib/api/index.mjs).
 *
 * One structural improvement over the original: because this is loaded as a
 * real ES module graph (not concatenated <script> blocks), every view
 * function is imported directly — no more string-name ROUTES table working
 * around load order.
 */
import { loginStaff, loginStaffByUsername, loginParent, logout as authLogout, getCurrentProfile, changePassword, findLoginAccountsByPhone, getAccessToken } from './lib/auth.js';
import { supabase } from './lib/supabaseClient.js';
import { Db } from './lib/api/index.mjs';
import { DENIABLE_MODULES } from './lib/api/capabilities.mjs';

import { renderComingSoon } from './views/_comingSoon.mjs';

// Next Sprint 2 §3 (BUG: "very slow first load on a new/different device"):
// every one of the ~26 screens above used to be a static top-of-file import,
// so the FIRST page load (before the browser has anything cached) had to
// download and parse every view module up front — dashboard.mjs, exams,
// timetable, the ~900KB vendored xlsx library pulled in by bulk-upload and
// the broadsheet's Excel export, all of it — before the login screen could
// even render. None of that is needed until the admin actually visits that
// screen. ROUTE_LOADERS defers each one behind a dynamic import() that only
// fires the first time its route is opened; resolveRouteFn() below caches
// the resolved function per page-load so repeat visits to the same route
// don't re-await the (already-settled) import promise for no reason.
const ROUTE_LOADERS = {
  'dashboard': () => import('./views/dashboard.mjs').then((m) => m.viewDashboard),
  'classes': () => import('./views/classes.mjs').then((m) => m.viewClasses),
  'students': () => import('./views/students.mjs').then((m) => m.viewStudents),
  'bulk-upload': () => import('./views/bulkUpload.mjs').then((m) => m.viewBulkUpload),
  'staff-bulk-upload': () => import('./views/staffBulkUpload.mjs').then((m) => m.viewStaffBulkUpload),
  'staff-teachers': () => import('./views/staffTeachers.mjs').then((m) => m.viewStaffHub),
  'grading': () => import('./views/gradingScales.mjs').then((m) => m.viewGrading),
  'exams-hub': () => import('./views/examsHub.mjs').then((m) => m.viewExamsHub),
  'exam-desk': () => import('./views/examDesk.mjs').then((m) => m.viewExamDesk),
  'deleted-exams': () => import('./views/deletedExams.mjs').then((m) => m.viewDeletedExams),
  'reports-hub': () => import('./views/reportsHub.mjs').then((m) => m.viewReportsHub),
  'broadsheet': () => import('./views/broadsheet.mjs').then((m) => m.viewBroadsheet),
  'exam-analysis': () => import('./views/examAnalysis.mjs').then((m) => m.viewExamAnalysis),
  'score-sheet': () => import('./views/scoreSheet.mjs').then((m) => m.viewScoreSheet),
  'reports': () => import('./views/reportForms.mjs').then((m) => m.viewReports),
  'class-list': () => import('./views/classList.mjs').then((m) => m.viewClassList),
  'transcript': () => import('./views/transcript.mjs').then((m) => m.viewTranscript),
  'certificates': () => import('./views/certificates.mjs').then((m) => m.viewCertificates),
  'my-results': () => import('./views/myResults.mjs').then((m) => m.viewMyResults),
  'settings': () => import('./views/settings.mjs').then((m) => m.viewSettingsHub),
  'attendance': () => import('./views/attendance.mjs').then((m) => m.viewAttendance),
  'messaging': () => import('./views/messaging.mjs').then((m) => m.viewMessaging),
  'my-children': () => import('./views/myChildren.mjs').then((m) => m.viewMyChildren),
  'timetable': () => import('./views/timetableHub.mjs').then((m) => m.viewTimetableHub),
  'my-timetable': () => import('./views/myTimetable.mjs').then((m) => m.viewMyTimetable),
  'finance': () => import('./views/financeHub.mjs').then((m) => m.viewFinanceHub),
  'my-profile': () => import('./views/myProfile.mjs').then((m) => m.viewMyProfile)
};
const _routeFnCache = {};
async function resolveRouteFn(route) {
  if (_routeFnCache[route]) return _routeFnCache[route];
  const loader = ROUTE_LOADERS[route];
  if (!loader) return null;
  const fn = await loader();
  _routeFnCache[route] = fn;
  return fn;
}

/* ------------------------------ Shared state ----------------------------- */
export const state = { profile: null, settings: null, impersonation: null };

/* ------------------------------ DOM helpers ------------------------------ */
export function $(sel, root) { return (root || document).querySelector(sel); }
export function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 300); }, 3200);
}
export function loader() { return '<div class="loader"><div class="spin"></div></div>'; }
/** Perf/UX fix: in-view screen transitions that DON'T go through the router
 *  (e.g. Classes -> Streams -> Subjects, which all swap `root.innerHTML`
 *  directly rather than changing the URL hash) never got the router's
 *  built-in `loader()` treatment — the old row stayed on screen, unchanged,
 *  for however long the next screen's data fetch took, which read as "my
 *  click did nothing" and invited a second click. Call this SYNCHRONOUSLY,
 *  before the `await` that fetches the next screen's data, so there's
 *  visible feedback the instant something is clicked, and the old row's
 *  click targets are gone (can't double-click something that no longer
 *  exists in the DOM). */
export function renderLoading(root, message) {
  root.innerHTML = `<div class="loader"><div class="spin"></div><p class="loader-msg">${esc(message || 'Loading, please wait…')}</p></div>`;
}
/** Print a wide table (Mark List/broadsheet) in landscape. Relying on the
 *  CSS "page" property + a named @page rule to switch orientation turned out
 *  to be unreliable in practice (reported bug: printing the Mark List
 *  produced a blank page) — browser support for per-element named pages is
 *  spotty. This does the same job the boring, well-supported way: swap in a
 *  plain @page{size:landscape} override right before printing, then remove
 *  it again once the print dialog closes. */
export function printLandscape() {
  printWithOptions('landscape', 'A4');
}
/** Feature brief §2/§4: every printout should be "adjustable to different
 *  printing requirements: portrait, landscape, Letter, A4, and A5" — a
 *  generalized version of the old printLandscape() (kept above as a thin
 *  wrapper so its one existing caller keeps working unchanged) that swaps in
 *  a plain @page override for whichever orientation/paper size the admin
 *  picked, right before printing, and removes it again once the print
 *  dialog closes — same reasoning as the old landscape-only version: the CSS
 *  "page" property + a named @page rule is unreliable across browsers, this
 *  boring swap-in/swap-out approach is not. */
const PRINT_PAPER_SIZES = { A4: 'A4', A5: 'A5', Letter: 'letter' };
/** marginMm (optional) lets one specific screen ask for tighter page
 *  margins than the 10mm app-wide default — added for Next Sprint 2 §8 (the
 *  Mark List's own margins halved, ~5mm, to make room for a larger font
 *  within the same page width) without touching every other printable
 *  screen that shares this same function (Class List, Score Sheet, Report
 *  Form, Finance statements, etc.). */
export function printWithOptions(orientation, paperSize, marginMm) {
  const size = PRINT_PAPER_SIZES[paperSize] || 'A4';
  const orient = orientation === 'landscape' ? 'landscape' : 'portrait';
  const margin = Number.isFinite(marginMm) && marginMm > 0 ? marginMm : 10;
  const style = document.createElement('style');
  style.id = 'print-options-override';
  style.textContent = `@page{size:${size} ${orient};margin:${margin}mm}`;
  document.head.appendChild(style);
  const cleanup = () => { style.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Safety net: afterprint doesn't fire in every browser/print-preview flow
  // (e.g. cancelling before the dialog fully engages) — make sure the
  // override never lingers and affects the next, unrelated print.
  setTimeout(cleanup, 5000);
}
/** Shared "🖨️ Print" + paper-size/orientation controls, for every report
 *  view that lets the admin choose portrait/landscape and A4/A5/Letter
 *  before printing (feature brief §2/§4). idPrefix keeps element IDs unique
 *  per view when more than one of these could theoretically be on a page.
 *  Returns the HTML; call wirePrintOptions(root, idPrefix, onPrint) after
 *  inserting it to wire the Print button to printWithOptions() using
 *  whichever orientation/size is currently selected. */
/** opts.simple (design standard rollout round 2): some screens (Finance
 *  Reports, Fee Structures) don't want the Portrait/Landscape + A4/A5/
 *  Letter pickers cluttering the toolbar — just a Print button, using
 *  whichever orientation the screen already asked for as a fixed default.
 *  The orientation/size are still rendered as hidden inputs with the same
 *  ids wirePrintOptions() reads, so nothing else about how printing is
 *  wired needs to change. */
export function printOptionsHtml(idPrefix, defaultOrientation, opts) {
  const landscapeDefault = defaultOrientation === 'landscape';
  if (opts && opts.simple) {
    return `<div class="print-opts print-opts-simple no-print">
      <input type="hidden" id="${idPrefix}-orient" value="${landscapeDefault ? 'landscape' : 'portrait'}">
      <input type="hidden" id="${idPrefix}-size" value="A4">
      <button class="btn secondary" id="${idPrefix}-print-btn">🖨️ Print</button>
    </div>`;
  }
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
/** suggestedFilename (optional, feature brief §2: "suggest a clear file name
 *  e.g. 'Grade 10 Classlist'") is applied to document.title just before
 *  printing and restored right after — browsers' "Save as PDF" print target
 *  defaults its filename to the page title, so this is what actually makes
 *  that suggestion show up in the save dialog. */
export function wirePrintOptions(root, idPrefix, suggestedFilename, marginMm) {
  const btn = root.querySelector(`#${idPrefix}-print-btn`);
  if (!btn) return;
  btn.onclick = () => {
    const orient = root.querySelector(`#${idPrefix}-orient`).value;
    const size = root.querySelector(`#${idPrefix}-size`).value;
    if (suggestedFilename) {
      const prevTitle = document.title;
      document.title = suggestedFilename;
      const restore = () => { document.title = prevTitle; window.removeEventListener('afterprint', restore); };
      window.addEventListener('afterprint', restore);
      setTimeout(restore, 5000);
    }
    printWithOptions(orient, size, marginMm);
  };
}
export function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}
export function fmtDate(d) {
  if (!d) return '—';
  try { const dt = new Date(d); if (isNaN(dt)) return d; return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (e) { return d; }
}
export function emptyState(opts) {
  const cta = opts.cta ? `<button class="btn" id="empty-cta">${esc(opts.cta.label)}</button>` : '';
  const html = `<div class="empty ${opts.warn ? 'warn' : ''}">
    <div class="e-ico">${opts.icon || '📭'}</div>
    <h3>${esc(opts.title)}</h3>
    <p>${esc(opts.text)}</p>${cta}</div>`;
  return { html, wire: (root) => { if (opts.cta) { const b = $('#empty-cta', root); if (b) b.onclick = opts.cta.onclick; } } };
}
/** A guard block shown when a prerequisite is missing (e.g. "add classes first"). */
export function prereqHtml(title, text, route, label) {
  return { title, text, route, label };
}
export function renderPrereq(root, title, text, route, label) {
  root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn">
    <div class="e-ico">⚠️</div><h3>${esc(title)}</h3><p>${esc(text)}</p>
    ${route ? `<button class="btn" id="prereq-cta">${esc(label || 'Go there now')}</button>` : ''}
  </div></div></div>`;
  if (route) { const b = $('#prereq-cta', root); if (b) b.onclick = () => go(route); }
}

/** Round 5 §5 (BUG): a screen that gates on "academic year/term configured
 *  yet?" used to collapse two very different situations into one message —
 *  genuinely not configured, AND the check itself failing (almost always a
 *  lost/flaky internet connection when someone is actively using an
 *  already-configured school) — both showed "Academic calendar not set up",
 *  which is actively misleading during a connectivity drop.
 *
 *  Call this instead of renderPrereq() directly whenever the "empty" state
 *  being checked came from a Db.*.list()-style call: pass `ok` straight
 *  through from that result (or `ok1 && ok2` when checking more than one).
 *  When the fetch itself failed, this shows a connection-specific message
 *  with a "Try again" button (wired to `onRetry`) instead of the prereq
 *  text — the prereq message is only ever shown once we actually KNOW the
 *  request succeeded and the thing genuinely isn't set up. */
export function renderPrereqOrConnectivity(root, { ok, title, text, route, label, onRetry }) {
  if (!ok) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn">
      <div class="e-ico">📡</div>
      <h3>${offline ? "You're offline" : "Couldn't load — check your connection"}</h3>
      <p>${offline
        ? 'This device has no internet connection right now.'
        : "We couldn't reach the server just now — this is usually a lost or unstable internet connection, not a setup problem."} Try again once you're back online.</p>
      <button class="btn" id="prereq-retry">Try again</button>
    </div></div></div>`;
    const b = $('#prereq-retry', root);
    if (b) b.onclick = () => { if (onRetry) onRetry(); };
    return;
  }
  renderPrereq(root, title, text, route, label);
}
/** Next Sprint 2 §4: "show/hide password" toggle during login (and, since
 *  the same fix applies everywhere per the standing rule, every other
 *  password field in the app — forgot-password, signup, change-password).
 *  passwordFieldHtml() wraps a plain password <input> with a toggle button
 *  positioned over it; wirePasswordToggle(inputId) wires that button to
 *  flip the input's type between 'password' and 'text'. Two small helpers
 *  instead of one, because a couple of call sites (forgot-password's two
 *  fields) need the wrapper markup built with slightly different attributes
 *  than a plain call would give them — building the exact <input> string is
 *  left to the caller; this only wraps whatever they already have. */
// Plain-line SVG eye / eye-with-a-slash icons (24x24, currentColor stroke) —
// a professional icon pair instead of the 👁️/🙈 emoji this used to use,
// which read as a random monkey face rather than a password-visibility
// control, especially out of place on a login screen.
const ICON_EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a13.16 13.16 0 0 1-3.05 3.94M6.51 6.51C3.6 8.34 1 12 1 12s4 7 11 7a10.94 10.94 0 0 0 5.49-1.49"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// Per spec: hidden password -> slashed eye; visible password -> plain eye
// (the icon reflects the CURRENT state, not "what clicking it will do").
export function passwordFieldHtml(inputHtml) {
  return `<div class="pw-wrap">${inputHtml}<button type="button" class="pw-toggle" tabindex="-1" aria-label="Show password">${ICON_EYE_OFF}</button></div>`;
}
export function wirePasswordToggle(inputId) {
  const input = $('#' + inputId);
  if (!input) return;
  const btn = input.parentElement && input.parentElement.querySelector('.pw-toggle');
  if (!btn) return;
  btn.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? ICON_EYE : ICON_EYE_OFF;
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  };
}

export function options(list, valKey, labKey, selected, placeholder) {
  let html = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
  (list || []).forEach((it) => {
    const v = it[valKey], l = it[labKey];
    html += `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(l)}</option>`;
  });
  return html;
}

/* ------------------------------ Modal ------------------------------------ */
// System Fixes brief §2 (BUG): "Clicking 'Save Settings' doesn't give
// immediate feedback... users click it repeatedly, and multiple duplicate
// save actions go through." Fix, applied site-wide per the brief's own
// instruction ("this should be a general pattern used everywhere in the
// system, not just on the Save Settings button") — ANY button that fires a
// background action should freeze + show a busy label the instant it's
// clicked, and only re-enable on success/failure. modal()'s OK button
// already did exactly this inline (see below); this is that same logic
// pulled out so every OTHER standalone Save/action button in the app
// (schoolSettings.mjs, marksEntry.mjs, attendance.mjs, classes.mjs,
// gradingScales.mjs, messaging.mjs, ...) can use the identical one-line
// wrapper instead of hand-rolling it again per button.
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

export function modal(opts) {
  const wide = opts.wide ? ' wide' : '';
  const foot = opts.footer === false ? '' :
    `<div class="modal-f">
      <button class="btn secondary" id="modal-cancel">${esc(opts.cancelLabel || 'Cancel')}</button>
      ${opts.okLabel ? `<button class="btn" id="modal-ok">${esc(opts.okLabel)}</button>` : ''}
    </div>`;
  $('#modal-root').innerHTML = `<div class="modal-back" id="modal-back">
    <div class="modal${wide}">
      <div class="modal-h"><h3>${esc(opts.title)}</h3></div>
      <div class="modal-b">${opts.body}</div>${foot}
    </div></div>`;
  $('#modal-back').onclick = (e) => { if (e.target.id === 'modal-back') closeModal(); };
  const cancelBtn = $('#modal-cancel'); if (cancelBtn) cancelBtn.onclick = closeModal;
  // Every "Save"-style action in the app goes through this one modal()
  // helper, so this is the single place that fixes the "click Save twice
  // while it's still saving -> 'already exists' error" bug class for every
  // modal in the app, not just Add Class — see withBusy() above.
  if (opts.okLabel && opts.onOk) {
    const okBtn = $('#modal-ok');
    okBtn.onclick = () => withBusy(okBtn, opts.onOk, opts.busyLabel || 'Please wait…');
  }
  if (opts.onOpen) opts.onOpen();
}
export function closeModal() { $('#modal-root').innerHTML = ''; }
// Round 2 brief §3 (recurring BUG): "Delete Subject" — and, once actually
// audited site-wide as explicitly asked for, at least two dozen other
// delete/withdraw/publish/reset-type buttons across the app (classes,
// exams, grading, staff, students, publishing, marks entry...) — gave no
// feedback and could be clicked repeatedly. Every one of them goes through
// this ONE confirmAction() helper, and the actual bug lived here, not in
// each call site individually: the "Yes, continue" button closed the
// confirm dialog and fired the caller's async action WITHOUT awaiting it
// or showing any busy state — modal() already had a working withBusy()
// pattern for its OK button, but confirmAction()'s onOk short-circuited it
// by closing the modal (destroying that very button) before the real
// work even started. Fixed once, here, exactly as asked: await the actual
// action, let the existing withBusy() disable+relabel "Yes, continue"
// while it runs, and only close the dialog once it's done (success or
// failure — same end state every caller already expected, just with real
// feedback in between instead of none).
export function confirmAction(msg, onYes, danger) {
  modal({
    title: 'Please confirm', body: `<p style="margin:0">${esc(msg)}</p>`,
    okLabel: 'Yes, continue',
    onOk: async () => { try { await onYes(); } finally { closeModal(); } }
  });
  if (danger) { const b = $('#modal-ok'); if (b) b.className = 'btn danger'; }
}

/* ============================================================================
 * AUTH
 * ==========================================================================*/
let lastPhone = ''; // persisted across re-renders/errors, same session only

const ROLE_LABEL = { admin: 'Administrator', teacher: 'Teacher', parent: 'Parent' };

// Landing redesign brief A1/B1: the old 3-tab (Staff/Admin, Student, Parent)
// picker is gone — one phone-number field now covers admin, teacher AND
// parent sign-in, and the system figures out which (and which school, if the
// same number is registered at more than one) from the phone number alone.
// Students are frozen/unchanged but no longer reachable from this screen
// (brief: "Remove the Student Login tab — not needed at this stage") —
// loginStudent() itself is untouched for whenever that's revisited.
export function renderAuth(errorMsg) {
  const name = (state.settings && state.settings.school_name) || (window.SHULE_CONFIG && window.SHULE_CONFIG.SCHOOL_BRAND_NAME) || 'Shule';
  const features = [
    ['🎒', 'Students', 'Classes, streams & enrollment'],
    ['🧑‍🏫', 'Teachers', 'Subjects & teacher assignment'],
    ['📝', 'Exams', 'Marks with automatic grading'],
    ['🧾', 'Reports', 'Mark lists & report forms']
  ].map(([ico, title, sub]) => `<div class="feat-tile"><div class="ft-ico">${ico}</div>
    <div><div class="ft-title">${title}</div><div class="ft-sub">${sub}</div></div></div>`).join('');

  $('#auth-screen').innerHTML = `<div class="auth"><div class="auth-card">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>Shule</h1>
      <p>A clean, modern way to run your school — from enrollment to report forms.</p>
      <div class="feat-grid">${features}</div>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2 class="auth-center">Welcome back 👋</h2>
      <div class="sub auth-center">Sign in to continue to ${esc(name)}</div>
      ${errorMsg ? `<div class="auth-err">${esc(errorMsg)}</div>` : ''}
      <form id="login-form">
        <div class="field">
          <label>Phone number</label>
          <input id="login-phone" type="tel" autocomplete="username" inputmode="tel"
            value="${esc(lastPhone)}" placeholder="e.g. 0712345678" required>
          <div class="hint">Your username is your phone number.</div>
        </div>
        <div class="field">
          <label>Password</label>
          ${passwordFieldHtml('<input id="login-pw" type="password" autocomplete="current-password" required>')}
        </div>
        <button class="btn block" type="submit" id="login-btn">Sign in</button>
      </form>
      <p class="hint"><a href="#" id="go-forgot">Forgot password?</a></p>
      <p class="hint">First time here? <a href="#" id="go-first-time">Set your password</a></p>
      <p class="hint">New school? <a href="#" id="go-signup">Create your school's account</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  $('#login-phone').oninput = (e) => { lastPhone = e.target.value; };
  $('#login-form').onsubmit = doLogin;
  $('#go-signup').onclick = (e) => { e.preventDefault(); renderSignup(); };
  $('#go-forgot').onclick = (e) => { e.preventDefault(); renderForgotPassword(undefined, false); };
  // Round 2 (Item 2): reuses the same phone-verified reset flow as "Forgot
  // password?" — a brand-new teacher's account already exists (their admin
  // added it), it just has no password set yet, so "set a password" and
  // "reset a password" are the same operation under the hood. Only the
  // copy differs (isFirstTime), so this avoids any new backend/migration.
  $('#go-first-time').onclick = (e) => { e.preventDefault(); renderForgotPassword(undefined, true); };
  wirePasswordToggle('login-pw');
}

async function doLogin(e) {
  e.preventDefault();
  const btn = $('#login-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
  const phone = $('#login-phone').value;
  const pw = $('#login-pw').value;
  lastPhone = phone;

  const lookup = await findLoginAccountsByPhone(phone);
  if (!lookup.ok || !lookup.accounts.length) {
    renderAuth('We could not find an account with that phone number.');
    return false;
  }
  if (lookup.accounts.length === 1) {
    await finishLogin(lookup.accounts[0], phone, pw, btn);
  } else {
    // Brief B1: "If the phone number exists in TWO OR MORE schools... prompt
    // the user to select the correct account." Password was already typed
    // once — no need to ask again after they pick.
    renderAccountPicker(lookup.accounts, phone, pw, { onBack: () => renderAuth() });
  }
  return false;
}

async function finishLogin(account, phone, pw, btn) {
  const res = account.role === 'parent'
    ? await loginParent(phone, pw, account.school_code)
    : await loginStaff(phone, pw, account.school_code);
  if (!res.ok) {
    renderAuth(res.message || 'Sign in failed.');
    return;
  }
  await bootApp();
}

/** Shared by both the sign-in flow and the forgot-password flow — same
 *  "which of these accounts?" picker, just a different continuation once
 *  one is chosen (opts.onChoose). */
function renderAccountPicker(accounts, phone, pw, opts) {
  const rows = accounts.map((a, i) => `<label class="acct-pick">
      <input type="radio" name="acct-pick" value="${i}" ${i === 0 ? 'checked' : ''}>
      <div><div class="acct-school">${esc(a.school_name)}</div><div class="acct-role">${esc(ROLE_LABEL[a.role] || a.role)}</div></div>
    </label>`).join('');

  $('#auth-screen').innerHTML = `<div class="auth"><div class="auth-card">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>Shule</h1>
      <p>A clean, modern way to run your school — from enrollment to report forms.</p>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2 class="auth-center">Which account?</h2>
      <div class="sub auth-center">This phone number is linked to more than one account.</div>
      <div class="acct-list">${rows}</div>
      <button class="btn block" id="acct-continue">Continue</button>
      <p class="hint"><a href="#" id="acct-back">Back</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  $('#acct-back').onclick = (e) => { e.preventDefault(); opts.onBack(); };
  $('#acct-continue').onclick = async () => {
    const checked = document.querySelector('input[name="acct-pick"]:checked');
    const idx = checked ? Number(checked.value) : 0;
    const btn = $('#acct-continue'); btn.disabled = true; btn.textContent = 'Please wait…';
    (opts.onChoose || finishLogin)(accounts[idx], phone, pw, btn);
  };
}

/* ----------------------------------------------------------------------
 * PHONE OTP VERIFICATION — shared by both signup and forgot-password (see
 * their sections below). Security hardening: both flows used to trust a
 * bare phone-number claim; both now require the caller to actually receive
 * and enter a 6-digit code sent to that number before the account-affecting
 * action (create account / reset password) is allowed to run — enforced
 * server-side in school-signup.js/forgot-password.js via the token this
 * screen collects, not just gated here in the UI.
 * -------------------------------------------------------------------- */
async function requestOtp(phone, purpose) {
  try {
    const res = await fetch('/.netlify/functions/send-otp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, purpose })
    });
    return await res.json();
  } catch (err) {
    return { ok: false, message: 'Something went wrong: ' + (err.message || err) };
  }
}

async function submitOtpCode(phone, purpose, code) {
  try {
    const res = await fetch('/.netlify/functions/verify-otp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, purpose, code })
    });
    return await res.json();
  } catch (err) {
    return { ok: false, message: 'Something went wrong: ' + (err.message || err) };
  }
}

/** opts: { phone, purpose, title, sub, onVerified(token), onBack() }.
 *  Fires the initial send itself (the caller doesn't need to call
 *  requestOtp before showing this) and offers a 30s-cooldown Resend link
 *  after that, matching send-otp.js's own server-side cooldown. */
function renderOtpVerify(opts) {
  const RESEND_COOLDOWN_SEC = 30;
  $('#auth-screen').innerHTML = `<div class="auth"><div class="auth-card">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>Shule</h1>
      <p>A clean, modern way to run your school — from enrollment to report forms.</p>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2 class="auth-center">${esc(opts.title || 'Verify your phone')}</h2>
      <div class="sub auth-center">${esc(opts.sub || `Enter the 6-digit code sent to ${opts.phone}.`)}</div>
      <div id="otp-status" class="hint auth-center">Sending code…</div>
      <div id="otp-err"></div>
      <form id="otp-form">
        <div class="field"><label>Verification code</label>
          <input id="otp-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456" autocomplete="one-time-code" required>
        </div>
        <button class="btn block" type="submit" id="otp-verify-btn" disabled>Verify</button>
      </form>
      <p class="hint auth-center"><a href="#" id="otp-resend">Resend code</a></p>
      <p class="hint"><a href="#" id="otp-back">Back</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  const statusEl = $('#otp-status'), errEl = $('#otp-err'), verifyBtn = $('#otp-verify-btn'), resendLink = $('#otp-resend');
  let cooldownTimer = null;

  function startCooldown() {
    let remaining = RESEND_COOLDOWN_SEC;
    resendLink.textContent = `Resend code (${remaining}s)`;
    resendLink.classList.add('disabled-link');
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(cooldownTimer);
        resendLink.textContent = 'Resend code';
        resendLink.classList.remove('disabled-link');
      } else {
        resendLink.textContent = `Resend code (${remaining}s)`;
      }
    }, 1000);
  }

  async function send() {
    statusEl.textContent = 'Sending code…';
    errEl.innerHTML = '';
    verifyBtn.disabled = true;
    const res = await requestOtp(opts.phone, opts.purpose);
    if (!res.ok) {
      statusEl.textContent = '';
      errEl.innerHTML = `<div class="auth-err">${esc(res.message || 'Could not send a code.')}</div>`;
      return;
    }
    verifyBtn.disabled = false;
    statusEl.textContent = res.sent === false
      ? (res.message || 'Code recorded, but could not be delivered.')
      : `Code sent to ${opts.phone}.`;
    startCooldown();
  }

  send();

  $('#otp-back').onclick = (e) => { e.preventDefault(); clearInterval(cooldownTimer); opts.onBack(); };
  resendLink.onclick = (e) => {
    e.preventDefault();
    if (resendLink.classList.contains('disabled-link')) return;
    send();
  };
  $('#otp-form').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#otp-code').value.trim();
    if (!/^\d{6}$/.test(code)) { errEl.innerHTML = `<div class="auth-err">Enter the 6-digit code.</div>`; return false; }
    verifyBtn.disabled = true; verifyBtn.textContent = 'Verifying…';
    const res = await submitOtpCode(opts.phone, opts.purpose, code);
    if (!res.ok) {
      errEl.innerHTML = `<div class="auth-err">${esc(res.message || 'Incorrect code.')}</div>`;
      verifyBtn.disabled = false; verifyBtn.textContent = 'Verify';
      return false;
    }
    clearInterval(cooldownTimer);
    verifyBtn.textContent = 'Please wait…';
    opts.onVerified(res.verified_token);
    return false;
  };
}

/* ----------------------------------------------------------------------
 * FORGOT PASSWORD (brief B2) — upgraded from its original "no OTP/email
 * verification for now" ship (explicit ask at the time: "Authentication
 * required: NO... simple reset flow... for now", with a verified reset
 * flagged as a later sprint). That upgrade is renderOtpVerify() above: a
 * phone number alone no longer resets anything, the caller must actually
 * receive and enter the code first.
 * -------------------------------------------------------------------- */
function renderForgotPassword(errorMsg, isFirstTime) {
  const heading = isFirstTime ? 'Set your password' : 'Reset your password';
  const sub = isFirstTime
    ? 'Enter the phone number your admin added, and choose a password to finish setting up your account.'
    : 'Enter your phone number and choose a new password.';
  $('#auth-screen').innerHTML = `<div class="auth"><div class="auth-card">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>Shule</h1>
      <p>A clean, modern way to run your school — from enrollment to report forms.</p>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2 class="auth-center">${heading}</h2>
      <div class="sub auth-center">${sub}</div>
      ${errorMsg ? `<div class="auth-err">${esc(errorMsg)}</div>` : ''}
      <form id="forgot-form">
        <div class="field"><label>Phone number</label><input id="fp-phone" type="tel" placeholder="e.g. 0712345678" value="${esc(lastPhone)}" required></div>
        <div class="field"><label>${isFirstTime ? 'Choose a password' : 'New password'}</label>${passwordFieldHtml('<input id="fp-pw" type="password" autocomplete="new-password" required>')}</div>
        <div class="field"><label>Confirm password</label>${passwordFieldHtml('<input id="fp-pw2" type="password" autocomplete="new-password" required>')}</div>
        <button class="btn block" type="submit" id="forgot-btn">${isFirstTime ? 'Set password' : 'Reset password'}</button>
      </form>
      <p class="hint">🔒 We'll text a 6-digit code to this number to confirm it's really you before changing anything.</p>
      <p class="hint"><a href="#" id="forgot-back">Back to sign in</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  $('#forgot-back').onclick = (e) => { e.preventDefault(); renderAuth(); };
  $('#forgot-form').onsubmit = (e) => doForgotPassword(e, isFirstTime);
  wirePasswordToggle('fp-pw');
  wirePasswordToggle('fp-pw2');
}

async function doForgotPassword(e, isFirstTime) {
  e.preventDefault();
  const btn = $('#forgot-btn'); btn.disabled = true; btn.textContent = 'Checking…';
  const phone = $('#fp-phone').value;
  const pw = $('#fp-pw').value, pw2 = $('#fp-pw2').value;
  lastPhone = phone;

  if (pw.length < 6) { renderForgotPassword('New password must be at least 6 characters.', isFirstTime); return false; }
  if (pw !== pw2) { renderForgotPassword('Passwords do not match.', isFirstTime); return false; }

  const lookup = await findLoginAccountsByPhone(phone);
  if (!lookup.ok || !lookup.accounts.length) {
    renderForgotPassword('We could not find an account with that phone number.', isFirstTime);
    return false;
  }
  if (lookup.accounts.length === 1) {
    verifyThenReset(lookup.accounts[0], phone, pw, isFirstTime);
  } else {
    renderAccountPicker(lookup.accounts, phone, pw, {
      onBack: () => renderForgotPassword(undefined, isFirstTime),
      onChoose: (account, ph, newPw) => verifyThenReset(account, ph, newPw, isFirstTime)
    });
  }
  return false;
}

/** The OTP gate between "we found your account" and actually resetting the
 *  password — see renderOtpVerify() above. */
function verifyThenReset(account, phone, newPassword, isFirstTime) {
  renderOtpVerify({
    phone, purpose: 'password_reset',
    title: 'Confirm it\'s you',
    sub: `Enter the 6-digit code sent to ${phone} to finish resetting your password.`,
    onBack: () => renderForgotPassword(undefined, isFirstTime),
    onVerified: (token) => submitPasswordReset(account, phone, newPassword, isFirstTime, token)
  });
}

async function submitPasswordReset(account, phone, newPassword, isFirstTime, otpVerifiedToken) {
  try {
    const res = await fetch('/.netlify/functions/forgot-password', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, school_code: account.school_code, role: account.role, new_password: newPassword, otp_verified_token: otpVerifiedToken })
    });
    const result = await res.json();
    if (!result.ok) { renderForgotPassword(result.message || 'Could not reset that password.', isFirstTime); return; }
    renderAuth(isFirstTime ? 'Password set — sign in with your new password.' : 'Password reset — sign in with your new password.');
  } catch (err) {
    renderForgotPassword('Something went wrong: ' + (err.message || err), isFirstTime);
  }
}

/* ----------------------------------------------------------------------
 * SCHOOL SIGNUP (self-serve) — a new school creates its tenant + first
 * admin login here, then is signed straight in. Same visual language as
 * renderAuth (identical CSS classes) so the look/theme stays consistent.
 * Redesign brief A2/C1: cleaner flow, and creation is now optimistic — the
 * admin is in their dashboard before the slower "seed the school with
 * defaults" step even finishes (see showSetupToast below).
 * -------------------------------------------------------------------- */
function renderSignup(prefill) {
  prefill = prefill || {};
  $('#auth-screen').innerHTML = `<div class="auth"><div class="auth-card">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>Bring your school onto Shule</h1>
      <p>Set up your school's own space in under a minute — classes, subjects, exams and report forms, ready to go.</p>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2 class="auth-center">Create your school's account</h2>
      <div class="sub auth-center">You'll be the first administrator.</div>
      <div id="signup-err"></div>
      <form id="signup-form">
        <div class="field"><label>School name</label><input id="su-name" placeholder="e.g. Greenhill Academy" value="${esc(prefill.school_name || '')}" required></div>
        <div class="field">
          <label>School Code <span class="muted">(used to sign in — letters, numbers, hyphens)</span></label>
          <input id="su-code" placeholder="e.g. greenhill" value="${esc(prefill.school_code || '')}" required>
        </div>
        <div class="field">
          <label>School type</label>
          <select id="su-category" required>
            <option value="pri_jss" ${prefill.category !== 'senior' ? 'selected' : ''}>Pri &amp; Jss School (Pre-Primary through Grade 9)</option>
            <option value="senior" ${prefill.category === 'senior' ? 'selected' : ''}>Senior School (Grade 10-12, with optional Form 3/4)</option>
          </select>
          <p class="hint">This decides which class levels and subjects your account is set up with — you won't need to change it later.</p>
        </div>
        <div class="field"><label>Your full name</label><input id="su-admin-name" placeholder="e.g. Jane Wanjiru" value="${esc(prefill.admin_name || '')}" required></div>
        <div class="field"><label>Your phone number</label><input id="su-phone" type="tel" placeholder="e.g. 0712345678" value="${esc(prefill.admin_phone || '')}" required>
          <div id="su-phone-err" class="field-err"></div>
        </div>
        <div class="field"><label>Password</label>${passwordFieldHtml(`<input id="su-pw" type="password" autocomplete="new-password" value="${esc(prefill.password || '')}" required>`)}</div>
        <button class="btn block" type="submit" id="signup-btn">Create school account</button>
      </form>
      <p class="hint">Already have an account? <a href="#" id="go-login">Sign in instead</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  const nameInput = $('#su-name'), codeInput = $('#su-code');
  let codeTouched = !!prefill.school_code;
  codeInput.oninput = () => { codeTouched = true; };
  nameInput.oninput = () => {
    if (codeTouched) return;
    codeInput.value = nameInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  };

  // SignUp_Fixes §1 (BUG): the old flow only ever caught a bad phone number
  // at submit time, and even then the message was just the field's own
  // description restated ("Enter your (the admin's) phone number") — which
  // reads like nothing actually happened, not "this is wrong". Validate as
  // the person types instead: a real, specific "Enter a correct phone
  // number" appears the moment they leave the field with something
  // malformed in it, and disappears the instant they start correcting it —
  // never left lingering once they've begun fixing the problem.
  const phoneInput = $('#su-phone'), phoneErr = $('#su-phone-err');
  phoneInput.oninput = () => { phoneErr.textContent = ''; };
  phoneInput.onblur = () => {
    const v = phoneInput.value.trim();
    phoneErr.textContent = (v && !window.ShulePhone.isValidPhone(v)) ? 'Enter a correct phone number, e.g. 0712345678.' : '';
  };

  $('#go-login').onclick = (e) => { e.preventDefault(); renderAuth(); };
  $('#signup-form').onsubmit = doSignup;
  wirePasswordToggle('su-pw');
}

async function doSignup(e) {
  e.preventDefault();
  const phoneVal = $('#su-phone').value.trim();
  if (!window.ShulePhone.isValidPhone(phoneVal)) {
    $('#su-phone-err').textContent = 'Enter a correct phone number, e.g. 0712345678.';
    $('#su-phone').focus();
    return false;
  }
  const body = {
    school_name: $('#su-name').value,
    school_code: $('#su-code').value,
    category: $('#su-category').value,
    admin_name: $('#su-admin-name').value,
    admin_phone: $('#su-phone').value,
    password: $('#su-pw').value
  };
  // Security hardening: the account isn't actually created yet — first
  // prove admin_phone is real. renderOtpVerify() sends the code itself;
  // this just gates createSchoolAccount() behind it, same pattern as
  // verifyThenReset() does for forgot-password.
  renderOtpVerify({
    phone: body.admin_phone, purpose: 'signup',
    title: 'Verify your phone',
    sub: `Enter the 6-digit code sent to ${body.admin_phone} to finish creating your school's account.`,
    onBack: () => renderSignup(body),
    onVerified: (token) => createSchoolAccount(body, token)
  });
  return false;
}

async function createSchoolAccount(body, otpVerifiedToken) {
  try {
    const res = await fetch('/.netlify/functions/school-signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, otp_verified_token: otpVerifiedToken })
    });
    const result = await res.json();
    if (!result.ok) {
      renderSignup(body);
      $('#signup-err').innerHTML = `<div class="auth-err">${esc(result.message || 'Could not create your school.')}</div>`;
      return;
    }
    // Straight in — no need to make a brand-new admin re-type their own
    // credentials a second time.
    lastPhone = body.admin_phone;
    const loginRes = await loginStaffByUsername(result.username, body.password, result.school_code);
    if (loginRes.ok) {
      await bootApp();
      // Brief C1: the admin is already looking at their dashboard now —
      // seeding (subjects, grading scale, academic year/terms) finishes in
      // the background instead of making them wait on a progress screen.
      showSetupToast(result.school_id);
      return;
    }
    renderAuth(`School created! Sign in with your phone number to continue.`);
  } catch (err) {
    renderSignup(body);
    $('#signup-err').innerHTML = `<div class="auth-err">Something went wrong: ${esc(err.message || err)}</div>`;
  }
}

/** Dismissible, non-blocking "still setting up" notice — separate from the
 *  regular toast() helper above because that one always auto-hides after a
 *  fixed 3.2s; this one has to stay up for however long the background
 *  seeding fetch actually takes, and disappears the moment it resolves.
 *
 *  Round 2 brief §1 (BUG): this used to be pure fire-and-forget — on
 *  success it just vanished, leaving `state.settings`/the sidebar
 *  branding/the academic-year context exactly as they were at the moment
 *  the dashboard first rendered (i.e. still empty/unseeded), so a brand
 *  new admin who navigated to Exams right after signing in hit the "set up
 *  your academic calendar first" gate even though seeding had, by then,
 *  actually finished — it just was never reflected in the running app
 *  without a manual page refresh. On failure it silently swallowed the
 *  error, leaving the school permanently half-set-up with no subjects,
 *  grading scale or academic year, and no indication anything went wrong.
 *  Now: on success, refresh the branding + re-run the router so whichever
 *  screen the admin is looking at (or navigates to next) sees the real
 *  seeded data; on failure, say so and offer Retry (safe to retry —
 *  seed_school_defaults is idempotent). */
function showSetupToast(schoolId) {
  const t = document.createElement('div');
  t.className = 'toast setup-toast';
  t.innerHTML = '<span>Hold tight — your school is being set up…</span><button type="button" class="toast-close" aria-label="Dismiss">&times;</button>';
  $('#toasts').appendChild(t);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    t.style.opacity = '0'; t.style.transition = '.3s';
    setTimeout(() => t.remove(), 300);
  };
  t.querySelector('.toast-close').onclick = remove;

  if (!schoolId) { remove(); return; }
  runSeed();

  function runSeed() {
    fetch('/.netlify/functions/school-seed', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ school_id: schoolId })
    })
      .then(async (res) => {
        const result = await res.json().catch(() => ({ ok: false }));
        if (!result.ok) throw new Error(result.message || 'Setup did not finish.');
        remove();
        await refreshBrandingAndContext();
        if (state.profile) await router();
      })
      .catch(() => {
        t.innerHTML = `<span>Your school's setup didn't finish — some defaults (subjects, grading scale, academic year) may be missing.</span>
          <button type="button" class="btn ghost sm" id="setup-retry" style="margin-left:8px">Retry</button>
          <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>`;
        t.querySelector('.toast-close').onclick = remove;
        t.querySelector('#setup-retry').onclick = () => { t.querySelector('#setup-retry').textContent = 'Retrying…'; runSeed(); };
      });
  }
}

/** Re-fetches settings (brand name/logo) after the background seed above
 *  completes and unconditionally re-applies them to the sidebar — see
 *  bootApp()'s brand-name/logo block for why "unconditional" matters here. */
async function refreshBrandingAndContext() {
  try {
    const settingsRes = await Db.settings.get();
    state.settings = settingsRes.ok ? settingsRes.data : {};
  } catch (e) { state.settings = {}; }
  applyBranding();
  Db.dashboard.getActiveContext().then((active) => {
    $('#topctx').innerHTML = active.academic_year_name
      ? `Active: <b>${esc(active.academic_year_name)}</b> · <b>${esc(active.term_name || 'No term set')}</b>`
      : '<span class="muted">No active academic year set</span>';
  }).catch(() => {});
}

async function forceLogout(msg) {
  await authLogout();
  state.profile = null;
  state.settings = {};
  renderAuth(msg || 'Your session expired. Please sign in again.');
}

/* ============================================================================
 * NAV + ROUTER
 * ==========================================================================*/
const NAV = {
  admin: [
    { route: 'dashboard', label: 'Dashboard', ico: '🏠' },
    { section: 'Academics' },
    { route: 'classes', label: 'Classes & Streams', ico: '🏫' },
    { section: 'People' },
    { route: 'students', label: 'Students', ico: '🎒' },
    { route: 'staff-teachers', label: 'Teachers and Staff', ico: '👨‍🏫' },
    { section: 'Assessment' },
    { route: 'exams-hub', label: 'Exams', ico: '📝' },
    { route: 'reports-hub', label: 'Reports', ico: '🧾' },
    { section: 'Daily' },
    { route: 'attendance', label: 'Attendance', ico: '🗓️' },
    { route: 'messaging', label: 'Messaging', ico: '💬' },
    { section: 'Configuration' },
    { route: 'settings', label: 'Settings', ico: '⚙️' },
    { route: 'timetable', label: 'Timetable', ico: '📅' },
    // Sprint: Finance module — placed directly below Timetable per the
    // brief's own request. An admin always has full access (finance_can_
    // manage()/finance_can_collect() both bypass on is_admin() — see
    // migrations/0031_finance_module.sql); a teacher only sees this same
    // entry (below) once granted a finance capability.
    { route: 'finance', label: 'Finance', ico: '💰' }
  ],
  teacher: [
    { route: 'dashboard', label: 'Dashboard', ico: '🏠' },
    { route: 'my-timetable', label: 'My Timetable', ico: '📅' },
    // Finance is hidden here unless this teacher has been granted a
    // finance capability (e.g. as a bursar) — see viewFinanceHub()'s own
    // capability check for why it's still safe to leave this route
    // reachable in HIDDEN_ALLOWED_ROUTES even when the sidebar hides it.
    // Placed directly below (My) Timetable per the brief's own request,
    // same as the admin nav above.
    { route: 'finance', label: 'Finance', ico: '💰', hideUnless: 'financeAccess' },
    { section: 'People' },
    { route: 'students', label: 'Students', ico: '🎒' },
    { section: 'Daily' },
    { route: 'attendance', label: 'Attendance', ico: '🗓️' },
    { route: 'messaging', label: 'Messaging', ico: '💬' },
    { section: 'Assessment' },
    { route: 'exams-hub', label: 'Exams', ico: '📝' },
    { route: 'reports-hub', label: 'Reports', ico: '🧾' },
    // Next Sprint 2 §11: teacher self-service profile updates (phone,
    // gender, other personal details) — was admin-only before.
    { section: 'Account' },
    { route: 'my-profile', label: 'My Profile', ico: '🙍' }
  ],
  student: [
    { route: 'my-results', label: 'My Results', ico: '🧾' }
  ],
  parent: [
    { route: 'my-children', label: 'My Children', ico: '👨‍👩‍👧' }
  ]
};

// Routes reachable via a normal in-app action (e.g. "+ Add student" ->
// Bulk) but deliberately left off the sidebar — brief §5: "let's just have
// one submodule called All Students" (Bulk Upload is already one click away
// from there, so it doesn't need its own nav entry too).
// Routes reachable only via a `go()` from inside a hub/handoff screen, not
// directly listed in the sidebar (feature brief: "avoid so many submodules
// just have them as icons" — exams-hub/reports-hub/settings are the actual
// sidebar entries now; these are what their icon tiles/tabs link to).
const HIDDEN_ALLOWED_ROUTES = {
  admin: ['bulk-upload', 'staff-bulk-upload', 'exam-desk', 'deleted-exams', 'grading', 'class-list', 'broadsheet', 'reports', 'transcript', 'certificates', 'exam-analysis', 'score-sheet'],
  teacher: ['bulk-upload', 'exam-desk', 'class-list', 'broadsheet', 'reports', 'transcript', 'certificates', 'exam-analysis', 'score-sheet']
};

// SignUp_Fixes §5: maps a nav route back to its 'deny_<module>' capability
// key, if that route is deniable at all (most aren't — see DENIABLE_MODULES).
function routeDenyKey(route) {
  const m = DENIABLE_MODULES.find((d) => d.route === route);
  return m ? m.key : null;
}

function allowedRoutes(role) {
  const set = {};
  (NAV[role] || []).forEach((it) => {
    if (it.route) set[it.route] = true;
    if (it.children) it.children.forEach((c) => { set[c.route] = true; });
  });
  (HIDDEN_ALLOWED_ROUTES[role] || []).forEach((r) => { set[r] = true; });
  // SignUp_Fixes §5: a per-USER deny (see DENIABLE_MODULES/state.profile.
  // deniedModules, set at boot) removes a route that role would otherwise
  // always have — same mechanism as hideUnless above, opposite polarity.
  const denied = state.profile && state.profile.deniedModules;
  if (denied && denied.size) {
    DENIABLE_MODULES.forEach((m) => { if (denied.has(m.key)) delete set[m.route]; });
  }
  return set;
}

function buildNav() {
  const items = NAV[state.profile.role] || NAV.student;
  let html = '';
  items.forEach((it) => {
    // e.g. { hideUnless: 'financeAccess' } — a per-USER gate (not per-role,
    // which is all NAV normally checks), for a module a teacher only sees
    // once individually granted a capability. See bootApp()'s capability
    // fetch, which sets this flag on state.profile at login.
    if (it.hideUnless && !state.profile[it.hideUnless]) return;
    // SignUp_Fixes §5: the opposite direction — a module every teacher gets
    // by default, but THIS ONE has been explicitly blocked from via Access
    // Control (state.profile.deniedModules, set at boot).
    if (it.route && state.profile.deniedModules && state.profile.deniedModules.has(routeDenyKey(it.route))) return;
    if (it.section) {
      html += `<div class="group">${esc(it.section)}</div>`;
    } else if (it.parent) {
      const kids = it.children.map((c) => `<a class="subitem" data-route="${c.route}">${esc(c.label)}</a>`).join('');
      html += `<div class="navparent" data-parent="${esc(it.parent)}">
        <a class="parent-toggle"><span class="ico">${it.ico}</span>${esc(it.parent)}<span class="caret">▸</span></a>
        <div class="subnav">${kids}</div></div>`;
    } else {
      html += `<a data-route="${it.route}"><span class="ico">${it.ico}</span>${esc(it.label)}</a>`;
    }
  });
  $('#nav').innerHTML = html;
  $('#nav').querySelectorAll('a[data-route]').forEach((a) => {
    a.onclick = () => go(a.getAttribute('data-route'));
  });
  $('#nav').querySelectorAll('.parent-toggle').forEach((a) => {
    a.onclick = () => a.parentElement.classList.toggle('open');
  });
}
function setActiveNav(route) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('data-route') === route));
  document.querySelectorAll('#nav .navparent').forEach((p) => { if (p.querySelector('a.active')) p.classList.add('open'); });
}
export function go(route) {
  location.hash = '#/' + route;
  App.toggleSidebar(false);
}

async function router() {
  let route = (location.hash || '').replace(/^#\/?/, '') || defaultRoute();
  route = route.split('/')[0];
  const allowed = allowedRoutes(state.profile.role)[route] === true;
  if (!allowed) route = defaultRoute();
  setActiveNav(route);
  const view = $('#view');
  view.innerHTML = loader();
  try {
    const fn = await resolveRouteFn(route);
    if (typeof fn === 'function') {
      await fn(view);
    } else {
      renderComingSoon(view, (NAV[state.profile.role] || []).flatMap((it) => it.children ? it.children : [it]).find((r) => r.route === route)?.label || route);
    }
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card pad">⚠️ Something went wrong loading this page: ${esc(e.message || e)}</div>`;
  }
}
function defaultRoute() {
  if (state.profile.role === 'student') return 'my-results';
  if (state.profile.role === 'parent') return 'my-children';
  return 'dashboard';
}

/* ============================================================================
 * APP object (topbar / sidebar / boot)
 * ==========================================================================*/
window.App = {
  toggleSidebar(force) {
    const sb = $('#sidebar'), sc = $('#scrim');
    const open = typeof force === 'boolean' ? force : !sb.classList.contains('open');
    sb.classList.toggle('open', open); sc.classList.toggle('show', open);
  },
  toggleUserMenu() { $('#usermenu').classList.toggle('hidden'); },
  openChangePassword() {
    $('#usermenu').classList.add('hidden');
    modal({
      title: 'Change password',
      body: `<div class="field"><label>Current password</label>${passwordFieldHtml('<input id="cp-cur" type="password">')}</div>
        <div class="field"><label>New password</label>${passwordFieldHtml('<input id="cp-new" type="password">')}</div>
        <div class="field"><label>Confirm new password</label>${passwordFieldHtml('<input id="cp-conf" type="password">')}</div>`,
      okLabel: 'Update password',
      onOk: async () => {
        const cur = $('#cp-cur').value, nw = $('#cp-new').value, cf = $('#cp-conf').value;
        if (nw !== cf) { toast('New passwords do not match.', 'err'); return; }
        const r = await changePassword(cur, nw);
        if (r.ok) { toast('Password updated.', 'ok'); closeModal(); }
        else toast(r.message, 'err');
      },
      onOpen: () => { wirePasswordToggle('cp-cur'); wirePasswordToggle('cp-new'); wirePasswordToggle('cp-conf'); }
    });
  },
  async logout() {
    await authLogout();
    state.profile = null;
    state.settings = {};
    renderAuth();
  }
};

async function bootApp() {
  state.profile = await getCurrentProfile();
  if (!state.profile) { renderAuth('Could not load your account. Please sign in again.'); return; }

  // Settings are per-school and RLS-gated on being signed in, so they can
  // only be fetched now — not before login, the way the single-tenant
  // version did (there was only ever one school's settings to show, and
  // they were deliberately world-readable; now every school's are private
  // to its own members).
  try {
    const settingsRes = await Db.settings.get();
    state.settings = settingsRes.ok ? settingsRes.data : {};
  } catch (e) {
    state.settings = {};
  }

  // Finance module: a teacher's sidebar only shows "Finance" once they've
  // been granted one of the two finance capabilities (see staff.mjs's
  // staff-edit modal) — an admin always has full access regardless, so
  // this check is skipped for them. One cheap query at login, not on every
  // navigation.
  state.profile.financeAccess = state.profile.role === 'admin';
  // SignUp_Fixes §5: the reverse of financeAccess above — modules a teacher
  // gets by DEFAULT, but that this specific one has been explicitly blocked
  // from via Access Control (staff.mjs's staff-edit modal). Always empty for
  // an admin — the school creator/an admin always has full access, exactly
  // like financeAccess never being checked for them above.
  state.profile.deniedModules = new Set();
  if (state.profile.role === 'teacher' && state.profile.staff_id) {
    try {
      const capsRes = await Db.capabilities.listForStaff(state.profile.staff_id);
      const caps = capsRes.ok ? capsRes.data : [];
      state.profile.financeAccess = caps.indexOf('finance_manage_fees') !== -1 || caps.indexOf('finance_record_collections') !== -1;
      state.profile.deniedModules = new Set(caps.filter((c) => c.indexOf('deny_') === 0));
    } catch (e) {
      state.profile.financeAccess = false;
    }
  }

  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  buildNav();
  $('#avatar').textContent = initials(state.profile.name);
  $('#um-name').textContent = state.profile.name;
  $('#um-role').textContent = ({ admin: 'Administrator', teacher: 'Teacher / Staff', student: 'Student', parent: 'Parent' })[state.profile.role] || state.profile.role;
  applyBranding();

  Db.dashboard.getActiveContext().then((active) => {
    $('#topctx').innerHTML = active.academic_year_name
      ? `Active: <b>${esc(active.academic_year_name)}</b> · <b>${esc(active.term_name || 'No term set')}</b>`
      : '<span class="muted">No active academic year set</span>';
  }).catch(() => {});

  if (!location.hash) location.hash = '#/' + defaultRoute();
  router();
}

/** Round 2 brief §1 (BUG): this used to only ever SET the sidebar's brand
 *  name/logo when the new value was truthy ("if (settings.school_name)
 *  ...") and otherwise silently left whatever text/logo was already in
 *  that DOM element — harmless the very first time the app boots (the
 *  static index.html default, "Shule", is already there), but a real bug
 *  the moment a SECOND school's session shares the same page load: logging
 *  out of one school and straight into a brand-new, not-yet-seeded one
 *  (e.g. right after self-serve signup, before the background seed
 *  finishes — see showSetupToast) left the PREVIOUS school's real name and
 *  logo on screen, since the new (still-empty) settings never got a chance
 *  to overwrite them. Every call now unconditionally sets both, falling
 *  back to the same generic values a brand-new/unseeded school should
 *  show. */
function applyBranding() {
  $('#brand-school').textContent = (state.settings && state.settings.school_name) || 'Shule';
  const brandLogo = $('.sidebar .brand .logo');
  if (!brandLogo) return;
  brandLogo.innerHTML = state.settings && state.settings.logo
    ? `<img src="${state.settings.logo}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`
    : '🎓';
}

window.addEventListener('hashchange', () => { if (state.profile) router(); });
document.addEventListener('click', (e) => {
  const um = $('#usermenu');
  if (um && !um.classList.contains('hidden') && !e.target.closest('.usermenu')) um.classList.add('hidden');
});

/* ------------------------- Super Admin impersonation ---------------------
 * "Login as School" (Admin_Dashboard_Architecture3.docx). Opens in a NEW
 * TAB: the /admin mini-app (admin.js) mints a genuine, server-generated
 * magic-link token via netlify/functions/admin-impersonate.js and points
 * the new tab at /index.html?impersonate=1&impersonate_email=...&
 * impersonate_token=...&impersonate_school=...&impersonate_session=... —
 * the payload travels via URL params, not sessionStorage, because it has
 * to reach a DIFFERENT tab than the one that requested it.
 *
 * That new tab's Supabase client is configured (see supabaseClient.js) to
 * persist its session in sessionStorage instead of the default localStorage
 * specifically because ?impersonate=1 is present — this keeps the
 * impersonated sign-in completely isolated to this one tab, so it can never
 * leak into or clobber the Super Admin's own already-open /admin tab (or
 * vice versa). Because of that isolation, this tab never holds — and never
 * needs — the Super Admin's own credentials: there is no "restore my
 * session" step. The Super Admin simply switches back to their original
 * /admin tab, which was never touched, or clicks Exit here to end the
 * session and close this tab.
 * ------------------------------------------------------------------------- */
async function consumePendingImpersonation() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('impersonate') !== '1') return false;

  const email = params.get('impersonate_email');
  const tokenHash = params.get('impersonate_token');
  const schoolName = params.get('impersonate_school');
  const sessionId = params.get('impersonate_session');

  // Strip the one-time credentials from the URL immediately — regardless
  // of outcome — so they never linger in browser history or get shared if
  // the tab's URL is copied.
  const cleanUrl = window.location.pathname + window.location.hash;
  history.replaceState(null, '', cleanUrl);

  if (!email || !tokenHash) return false;

  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (error || !data || !data.session) {
    toast('Could not start "Login as School" — the link may have expired. Please try again from the Admin Dashboard.', 'err');
    return false;
  }
  state.impersonation = { school_name: schoolName || 'this school', session_id: sessionId || null };
  return true;
}

function renderImpersonationBanner() {
  if (!state.impersonation) return;
  if ($('#impersonation-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'impersonation-banner';
  bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#b91c1c;color:#fff;padding:8px 16px;display:flex;align-items:center;justify-content:center;gap:14px;font-weight:600;font-size:14px';
  bar.innerHTML = `<span>🔒 Viewing as <b>${esc(state.impersonation.school_name)}</b> — Admin Mode</span><button id="impersonation-exit" class="btn sm" style="background:#fff;color:#b91c1c">Exit &amp; close this tab</button>`;
  document.body.insertBefore(bar, document.body.firstChild);
  $('#impersonation-exit').onclick = exitImpersonation;
}

async function exitImpersonation() {
  const sessionId = state.impersonation && state.impersonation.session_id;

  if (sessionId) {
    try {
      // End the session with THIS tab's own (impersonated) token — this
      // tab never has the Super Admin's credentials to send instead. The
      // server accepts this because it checks that the caller IS the
      // profile the session was opened for (see admin-impersonate.js).
      const token = await getAccessToken();
      await fetch('/.netlify/functions/admin-impersonate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'end', session_id: sessionId })
      });
    } catch (e) { /* best-effort — the start was already audit-logged */ }
  }

  await supabase.auth.signOut();
  state.impersonation = null;

  // This tab only ever existed for the impersonation session — the Super
  // Admin's own /admin tab was never navigated away from, so closing this
  // one is the correct "return to the Super Admin dashboard" action. A
  // script can only close a tab it opened itself; if this tab wasn't
  // opened via window.open() (e.g. someone bookmarked/reloaded the URL),
  // window.close() is a silent no-op, so fall back to a clear message.
  window.close();
  setTimeout(() => {
    toast('You can now close this tab and return to the Admin Dashboard.', 'ok');
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font:15px system-ui;color:#374151">You have been signed out. You can close this tab and return to the Admin Dashboard.</div>';
  }, 300);
}

/* -------------------------- OFFLINE SUPPORT ------------------------------
 * Registers sw.js (see its own header comment for the full caching design:
 * static shell cached + auto-refreshing, real data never cached, no
 * offline write-queueing) and gives a clear, immediate signal when the
 * connection actually drops — rather than letting whatever's mid-request
 * fail with a generic error and leaving someone guessing why. Deliberately
 * doesn't try to be clever about it (no retry queue, no offline banner
 * that lingers) — just names the actual problem the moment it happens. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.error('Service worker registration failed', e));
  });
}
window.addEventListener('offline', () => toast("You're offline — actions like sending messages or saving marks won't go through until you're back online.", 'err'));
window.addEventListener('online', () => toast('Back online.', 'ok'));

/* ------------------------------- INIT ----------------------------------- */
(async function init() {
  state.settings = {}; // no school context yet — the auth screen shows generic platform branding until sign-in

  // Mobile UI fix: tapping the dimmed area behind an open nav drawer used to
  // do nothing — closing it required tapping a nav link (or the same module
  // again), an extra step when the person just wanted to dismiss the drawer
  // and keep doing whatever they were doing. #scrim already existed and
  // already gets shown/hidden in lockstep with the drawer (see
  // App.toggleSidebar) — it just had no click handler wired to it.
  $('#scrim').onclick = () => App.toggleSidebar(false);

  // Security hardening pass: these 4 used to be literal onclick="..."
  // attributes in index.html — inline event-handler attributes are exactly
  // what a strict script-src Content-Security-Policy has to block, so
  // they're wired here instead, the same way every other click handler in
  // this codebase already is.
  $('#menu-toggle-btn').onclick = () => App.toggleSidebar();
  $('#avatar').onclick = () => App.toggleUserMenu();
  $('#um-change-password').onclick = () => App.openChangePassword();
  $('#um-logout').onclick = () => App.logout();
  const yearEl = $('#year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  await consumePendingImpersonation();

  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const profile = await getCurrentProfile();
    if (profile) { state.profile = profile; await bootApp(); renderImpersonationBanner(); return; }
  }
  renderAuth();

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && state.profile) { state.profile = null; renderAuth(); }
  });
})();
