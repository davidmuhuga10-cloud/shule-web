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
import { loginStaff, loginStaffByUsername, loginParent, logout as authLogout, getCurrentProfile, changePassword, findLoginAccountsByPhone } from './lib/auth.js';
import { supabase } from './lib/supabaseClient.js';
import { Db } from './lib/api/index.mjs';

import { viewDashboard } from './views/dashboard.mjs';
import { viewClasses } from './views/classes.mjs';
import { viewStudents } from './views/students.mjs';
import { viewBulkUpload } from './views/bulkUpload.mjs';
import { viewStaffHub } from './views/staffTeachers.mjs';
import { viewGrading } from './views/gradingScales.mjs';
import { viewExamsHub } from './views/examsHub.mjs';
import { viewExamDesk } from './views/examDesk.mjs';
import { viewDeletedExams } from './views/deletedExams.mjs';
import { viewReportsHub } from './views/reportsHub.mjs';
import { viewBroadsheet } from './views/broadsheet.mjs';
import { viewExamAnalysis } from './views/examAnalysis.mjs';
import { viewScoreSheet } from './views/scoreSheet.mjs';
import { viewReports } from './views/reportForms.mjs';
import { viewClassList } from './views/classList.mjs';
import { viewTranscript } from './views/transcript.mjs';
import { viewCertificates } from './views/certificates.mjs';
import { viewMyResults } from './views/myResults.mjs';
import { viewSettingsHub } from './views/settings.mjs';
import { viewAttendance } from './views/attendance.mjs';
import { viewMessaging } from './views/messaging.mjs';
import { viewMyChildren } from './views/myChildren.mjs';
import { renderComingSoon } from './views/_comingSoon.mjs';

/* ------------------------------ Shared state ----------------------------- */
export const state = { profile: null, settings: null };

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
export function printWithOptions(orientation, paperSize) {
  const size = PRINT_PAPER_SIZES[paperSize] || 'A4';
  const orient = orientation === 'landscape' ? 'landscape' : 'portrait';
  const style = document.createElement('style');
  style.id = 'print-options-override';
  style.textContent = `@page{size:${size} ${orient};margin:10mm}`;
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
/** suggestedFilename (optional, feature brief §2: "suggest a clear file name
 *  e.g. 'Grade 10 Classlist'") is applied to document.title just before
 *  printing and restored right after — browsers' "Save as PDF" print target
 *  defaults its filename to the page title, so this is what actually makes
 *  that suggestion show up in the save dialog. */
export function wirePrintOptions(root, idPrefix, suggestedFilename) {
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
    printWithOptions(orient, size);
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
export function confirmAction(msg, onYes, danger) {
  modal({
    title: 'Please confirm', body: `<p style="margin:0">${esc(msg)}</p>`,
    okLabel: 'Yes, continue', onOk: () => { closeModal(); onYes(); }
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
      <h1>${esc(name)}</h1>
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
          <input id="login-pw" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn block" type="submit" id="login-btn">Sign in</button>
      </form>
      <p class="hint"><a href="#" id="go-forgot">Forgot password?</a></p>
      <p class="hint">First time here? Ask your admin to set up your account.</p>
      <p class="hint">New school? <a href="#" id="go-signup">Create your school's account</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  $('#login-phone').oninput = (e) => { lastPhone = e.target.value; };
  $('#login-form').onsubmit = doLogin;
  $('#go-signup').onclick = (e) => { e.preventDefault(); renderSignup(); };
  $('#go-forgot').onclick = (e) => { e.preventDefault(); renderForgotPassword(); };
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
      <h1>${esc((state.settings && state.settings.school_name) || 'Shule')}</h1>
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
 * FORGOT PASSWORD (brief B2) — deliberately no OTP/email verification for
 * now (explicit ask: "Authentication required: NO... simple reset flow...
 * for now", with an upgrade to a verified reset noted as a later sprint).
 * Concretely: knowing an account's phone number is enough to set a new
 * password for it. That's a real, acknowledged tradeoff, not an oversight —
 * flagged again in the delivery notes, not just here.
 * -------------------------------------------------------------------- */
function renderForgotPassword(errorMsg) {
  $('#auth-screen').innerHTML = `<div class="auth"><div class="auth-card">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>${esc((state.settings && state.settings.school_name) || 'Shule')}</h1>
      <p>A clean, modern way to run your school — from enrollment to report forms.</p>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2 class="auth-center">Reset your password</h2>
      <div class="sub auth-center">Enter your phone number and choose a new password.</div>
      ${errorMsg ? `<div class="auth-err">${esc(errorMsg)}</div>` : ''}
      <form id="forgot-form">
        <div class="field"><label>Phone number</label><input id="fp-phone" type="tel" placeholder="e.g. 0712345678" value="${esc(lastPhone)}" required></div>
        <div class="field"><label>New password</label><input id="fp-pw" type="password" autocomplete="new-password" required></div>
        <div class="field"><label>Confirm new password</label><input id="fp-pw2" type="password" autocomplete="new-password" required></div>
        <button class="btn block" type="submit" id="forgot-btn">Reset password</button>
      </form>
      <p class="hint">⚠️ This doesn't verify it's really you yet — anyone who knows this phone number could reset this password. A verified (OTP) reset is planned for a later update.</p>
      <p class="hint"><a href="#" id="forgot-back">Back to sign in</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  $('#forgot-back').onclick = (e) => { e.preventDefault(); renderAuth(); };
  $('#forgot-form').onsubmit = doForgotPassword;
}

async function doForgotPassword(e) {
  e.preventDefault();
  const btn = $('#forgot-btn'); btn.disabled = true; btn.textContent = 'Checking…';
  const phone = $('#fp-phone').value;
  const pw = $('#fp-pw').value, pw2 = $('#fp-pw2').value;
  lastPhone = phone;

  if (pw.length < 6) { renderForgotPassword('New password must be at least 6 characters.'); return false; }
  if (pw !== pw2) { renderForgotPassword('Passwords do not match.'); return false; }

  const lookup = await findLoginAccountsByPhone(phone);
  if (!lookup.ok || !lookup.accounts.length) {
    renderForgotPassword('We could not find an account with that phone number.');
    return false;
  }
  if (lookup.accounts.length === 1) {
    await submitPasswordReset(lookup.accounts[0], phone, pw);
  } else {
    renderAccountPicker(lookup.accounts, phone, pw, {
      onBack: () => renderForgotPassword(),
      onChoose: (account, ph, newPw) => submitPasswordReset(account, ph, newPw)
    });
  }
  return false;
}

async function submitPasswordReset(account, phone, newPassword) {
  try {
    const res = await fetch('/.netlify/functions/forgot-password', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, school_code: account.school_code, role: account.role, new_password: newPassword })
    });
    const result = await res.json();
    if (!result.ok) { renderForgotPassword(result.message || 'Could not reset that password.'); return; }
    renderAuth('Password reset — sign in with your new password.');
  } catch (err) {
    renderForgotPassword('Something went wrong: ' + (err.message || err));
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
function renderSignup() {
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
        <div class="field"><label>School name</label><input id="su-name" placeholder="e.g. Greenhill Academy" required></div>
        <div class="field">
          <label>School Code <span class="muted">(used to sign in — letters, numbers, hyphens)</span></label>
          <input id="su-code" placeholder="e.g. greenhill" required>
        </div>
        <div class="field"><label>Your full name</label><input id="su-admin-name" placeholder="e.g. Jane Wanjiru" required></div>
        <div class="field"><label>Your phone number</label><input id="su-phone" type="tel" placeholder="e.g. 0712345678" required></div>
        <div class="field"><label>Password</label><input id="su-pw" type="password" autocomplete="new-password" required></div>
        <button class="btn block" type="submit" id="signup-btn">Create school account</button>
      </form>
      <p class="hint">Already have an account? <a href="#" id="go-login">Sign in instead</a></p>
    </div></div>
  </div></div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  const nameInput = $('#su-name'), codeInput = $('#su-code');
  let codeTouched = false;
  codeInput.oninput = () => { codeTouched = true; };
  nameInput.oninput = () => {
    if (codeTouched) return;
    codeInput.value = nameInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  };

  $('#go-login').onclick = (e) => { e.preventDefault(); renderAuth(); };
  $('#signup-form').onsubmit = doSignup;
}

async function doSignup(e) {
  e.preventDefault();
  const btn = $('#signup-btn'); btn.disabled = true; btn.textContent = 'Creating…';
  const body = {
    school_name: $('#su-name').value,
    school_code: $('#su-code').value,
    admin_name: $('#su-admin-name').value,
    admin_phone: $('#su-phone').value,
    password: $('#su-pw').value
  };
  try {
    const res = await fetch('/.netlify/functions/school-signup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await res.json();
    if (!result.ok) {
      $('#signup-err').innerHTML = `<div class="auth-err">${esc(result.message || 'Could not create your school.')}</div>`;
      btn.disabled = false; btn.textContent = 'Create school account';
      return false;
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
      return false;
    }
    renderAuth(`School created! Sign in with your phone number to continue.`);
  } catch (err) {
    $('#signup-err').innerHTML = `<div class="auth-err">Something went wrong: ${esc(err.message || err)}</div>`;
    btn.disabled = false; btn.textContent = 'Create school account';
  }
  return false;
}

/** Dismissible, non-blocking "still setting up" notice — separate from the
 *  regular toast() helper above because that one always auto-hides after a
 *  fixed 3.2s; this one has to stay up for however long the background
 *  seeding fetch actually takes, and disappears the moment it resolves. */
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
  fetch('/.netlify/functions/school-seed', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ school_id: schoolId })
  }).catch(() => {}).finally(remove);
}

async function forceLogout(msg) {
  await authLogout();
  state.profile = null;
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
    { route: 'settings', label: 'Settings', ico: '⚙️' }
  ],
  teacher: [
    { route: 'dashboard', label: 'Dashboard', ico: '🏠' },
    { section: 'People' },
    { route: 'students', label: 'Students', ico: '🎒' },
    { section: 'Daily' },
    { route: 'attendance', label: 'Attendance', ico: '🗓️' },
    { route: 'messaging', label: 'Messaging', ico: '💬' },
    { section: 'Assessment' },
    { route: 'exams-hub', label: 'Exams', ico: '📝' },
    { route: 'reports-hub', label: 'Reports', ico: '🧾' }
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
  admin: ['bulk-upload', 'exam-desk', 'deleted-exams', 'grading', 'class-list', 'broadsheet', 'reports', 'transcript', 'certificates', 'exam-analysis', 'score-sheet'],
  teacher: ['bulk-upload', 'exam-desk', 'class-list', 'broadsheet', 'reports', 'transcript', 'certificates', 'exam-analysis', 'score-sheet']
};

function allowedRoutes(role) {
  const set = {};
  (NAV[role] || []).forEach((it) => {
    if (it.route) set[it.route] = true;
    if (it.children) it.children.forEach((c) => { set[c.route] = true; });
  });
  (HIDDEN_ALLOWED_ROUTES[role] || []).forEach((r) => { set[r] = true; });
  return set;
}

function buildNav() {
  const items = NAV[state.profile.role] || NAV.student;
  let html = '';
  items.forEach((it) => {
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

// Routes implemented so far. Anything in NAV but not listed here renders a
// friendly "coming soon" placeholder instead of crashing — the next phase of
// the migration fills these in one by one.
const ROUTES = {
  'dashboard': viewDashboard,
  'classes': viewClasses,
  'students': viewStudents,
  'bulk-upload': viewBulkUpload,
  'staff-teachers': viewStaffHub,
  'grading': viewGrading,
  'exams-hub': viewExamsHub,
  'exam-desk': viewExamDesk,
  'deleted-exams': viewDeletedExams,
  'reports-hub': viewReportsHub,
  'broadsheet': viewBroadsheet,
  'exam-analysis': viewExamAnalysis,
  'score-sheet': viewScoreSheet,
  'reports': viewReports,
  'class-list': viewClassList,
  'transcript': viewTranscript,
  'certificates': viewCertificates,
  'my-results': viewMyResults,
  'settings': viewSettingsHub,
  'attendance': viewAttendance,
  'messaging': viewMessaging,
  'my-children': viewMyChildren
};

async function router() {
  let route = (location.hash || '').replace(/^#\/?/, '') || defaultRoute();
  route = route.split('/')[0];
  const allowed = allowedRoutes(state.profile.role)[route] === true;
  const fn = ROUTES[route];
  if (!allowed) route = defaultRoute();
  setActiveNav(route);
  const view = $('#view');
  view.innerHTML = loader();
  try {
    if (typeof (ROUTES[route]) === 'function') {
      await ROUTES[route](view);
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
      body: `<div class="field"><label>Current password</label><input id="cp-cur" type="password"></div>
        <div class="field"><label>New password</label><input id="cp-new" type="password"></div>
        <div class="field"><label>Confirm new password</label><input id="cp-conf" type="password"></div>`,
      okLabel: 'Update password',
      onOk: async () => {
        const cur = $('#cp-cur').value, nw = $('#cp-new').value, cf = $('#cp-conf').value;
        if (nw !== cf) { toast('New passwords do not match.', 'err'); return; }
        const r = await changePassword(cur, nw);
        if (r.ok) { toast('Password updated.', 'ok'); closeModal(); }
        else toast(r.message, 'err');
      }
    });
  },
  async logout() {
    await authLogout();
    state.profile = null;
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

  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  buildNav();
  $('#avatar').textContent = initials(state.profile.name);
  $('#um-name').textContent = state.profile.name;
  $('#um-role').textContent = ({ admin: 'Administrator', teacher: 'Teacher / Staff', student: 'Student', parent: 'Parent' })[state.profile.role] || state.profile.role;
  if (state.settings && state.settings.school_name) $('#brand-school').textContent = state.settings.school_name;
  // Feature brief §1: "On login, display the logo next to the school name,
  // if the school has one set. If not, show what's currently there" — the
  // sidebar brand box always keeps its size (set in CSS), so swapping its
  // content for an <img> here never shifts the layout even before this
  // resolves; the generic 🎓 mark stays exactly as it was for any school
  // that hasn't uploaded a logo.
  const brandLogo = $('.sidebar .brand .logo');
  if (brandLogo && state.settings && state.settings.logo) {
    brandLogo.innerHTML = `<img src="${state.settings.logo}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`;
  }

  Db.dashboard.getActiveContext().then((active) => {
    $('#topctx').innerHTML = active.academic_year_name
      ? `Active: <b>${esc(active.academic_year_name)}</b> · <b>${esc(active.term_name || 'No term set')}</b>`
      : '<span class="muted">No active academic year set</span>';
  }).catch(() => {});

  if (!location.hash) location.hash = '#/' + defaultRoute();
  router();
}

window.addEventListener('hashchange', () => { if (state.profile) router(); });
document.addEventListener('click', (e) => {
  const um = $('#usermenu');
  if (um && !um.classList.contains('hidden') && !e.target.closest('.usermenu')) um.classList.add('hidden');
});

/* ------------------------------- INIT ----------------------------------- */
(async function init() {
  state.settings = {}; // no school context yet — the auth screen shows generic platform branding until sign-in

  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    const profile = await getCurrentProfile();
    if (profile) { state.profile = profile; await bootApp(); return; }
  }
  renderAuth();

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && state.profile) { state.profile = null; renderAuth(); }
  });
})();
