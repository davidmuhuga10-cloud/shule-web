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
import { loginStaff, loginStaffByUsername, loginStudent, loginParent, splitLoginUsername, logout as authLogout, getCurrentProfile, changePassword, resolveSchoolByCode } from './lib/auth.js';
import { supabase } from './lib/supabaseClient.js';
import { Db } from './lib/api/index.mjs';

import { viewDashboard } from './views/dashboard.mjs';
import { viewAcademicCalendar } from './views/academicCalendar.mjs';
import { viewClasses } from './views/classes.mjs';
import { viewSubjects } from './views/subjects.mjs';
import { viewStudents } from './views/students.mjs';
import { viewBulkUpload } from './views/bulkUpload.mjs';
import { viewStaff } from './views/staff.mjs';
import { viewClassSubjects } from './views/classSubjects.mjs';
import { viewTeacherAssignments } from './views/teacherAssignments.mjs';
import { viewGrading } from './views/gradingScales.mjs';
import { viewExams } from './views/exams.mjs';
import { viewMarks } from './views/marksEntry.mjs';
import { viewPublishing } from './views/publishing.mjs';
import { viewBroadsheet } from './views/broadsheet.mjs';
import { viewReports } from './views/reportForms.mjs';
import { viewClassList } from './views/classList.mjs';
import { viewMeritList } from './views/meritList.mjs';
import { viewTranscript } from './views/transcript.mjs';
import { viewCertificates } from './views/certificates.mjs';
import { viewMyResults } from './views/myResults.mjs';
import { viewSettings } from './views/schoolSettings.mjs';
import { viewUsers } from './views/userAccounts.mjs';
import { viewAttendance } from './views/attendance.mjs';
import { viewMessaging } from './views/messaging.mjs';
import { viewParentAccounts } from './views/parentAccounts.mjs';
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
  if (opts.okLabel && opts.onOk) $('#modal-ok').onclick = opts.onOk;
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
let loginTab = 'staff';
let lastSchoolCode = ''; // persisted across tab switches / re-renders, same session only
let lastCombinedLogin = ''; // persisted "identifier@schoolcode" value across re-renders (staff/parent tabs)

// Staff/Admin and Parent both sign in with ONE combined field — "mercy@tumaini"
// or "0712345678@tumaini" — instead of a separate School Code box most people
// don't remember to fill in (Zeraki-style). The Student tab is deliberately
// left alone (frozen) with the original two-field School Code + Admission
// Number layout — see PRODUCT_ROADMAP.md's login-UX notes.
const COMBINED_TABS = { staff: true, parent: true };

export function renderAuth(errorMsg) {
  const name = (state.settings && state.settings.school_name) || (window.SHULE_CONFIG && window.SHULE_CONFIG.SCHOOL_BRAND_NAME) || 'Shule';
  const features = [
    ['🎒', 'Students', 'Classes, streams & enrollment'],
    ['📚', 'Subjects', 'Assign subjects & teachers'],
    ['📝', 'Exams', 'Marks with automatic grading'],
    ['🧾', 'Reports', 'Mark lists & report forms']
  ].map(([ico, title, sub]) => `<div class="feat-tile"><div class="ft-ico">${ico}</div>
    <div><div class="ft-title">${title}</div><div class="ft-sub">${sub}</div></div></div>`).join('');

  const combined = COMBINED_TABS[loginTab];
  const fieldsHtml = combined
    ? `<div class="field">
        <label>Username</label>
        <input id="login-username" autocomplete="username" value="${esc(lastCombinedLogin)}"
          placeholder="${loginTab === 'parent' ? 'e.g. 0712345678@tumaini' : 'e.g. mercy@tumaini'}" required>
        <div class="hint">Your ${loginTab === 'parent' ? 'phone number' : 'username or phone number'}, then @ and your school's code.</div>
      </div>`
    : `<div class="field">
        <label>School Code</label>
        <input id="login-code" autocomplete="off" placeholder="e.g. greenhill" value="${esc(lastSchoolCode)}" required>
        <div class="hint" id="school-preview" style="min-height:1.2em"></div>
      </div>
      <div class="field">
        <label>Admission Number</label>
        <input id="login-id" autocomplete="off" placeholder="e.g. 23" required>
      </div>`;

  $('#auth-screen').innerHTML = `<div class="auth">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>${esc(name)}</h1>
      <p>A clean, modern way to run your school — from enrollment to report forms.</p>
      <div class="feat-grid">${features}</div>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2>Welcome back 👋</h2>
      <div class="sub">Sign in to continue to ${esc(name)}</div>
      <div class="tabs">
        <button id="tab-staff" class="${loginTab === 'staff' ? 'active' : ''}">Staff / Admin</button>
        <button id="tab-student" class="${loginTab === 'student' ? 'active' : ''}">Student</button>
        <button id="tab-parent" class="${loginTab === 'parent' ? 'active' : ''}">Parent</button>
      </div>
      ${errorMsg ? `<div class="auth-err">${esc(errorMsg)}</div>` : ''}
      <form id="login-form">
        ${fieldsHtml}
        <div class="field">
          <label>Password</label>
          <input id="login-pw" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn block" type="submit" id="login-btn">Sign in</button>
      </form>
      <p class="hint" id="login-hint">${loginTab === 'student'
        ? 'Ask your school admin for your password if you don\'t have one yet.'
        : loginTab === 'parent'
        ? 'Ask your child\'s school admin for your password if you don\'t have one yet.'
        : 'First time here? Ask your admin to set up your account.'}</p>
      <p class="hint">New school? <a href="#" id="go-signup">Create your school's account</a></p>
    </div></div>
  </div>`;
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');

  $('#tab-staff').onclick = () => { loginTab = 'staff'; renderAuth(); };
  $('#tab-student').onclick = () => { loginTab = 'student'; renderAuth(); };
  $('#tab-parent').onclick = () => { loginTab = 'parent'; renderAuth(); };
  $('#login-form').onsubmit = doLogin;
  $('#go-signup').onclick = (e) => { e.preventDefault(); renderSignup(); };

  if (combined) {
    $('#login-username').oninput = (e) => { lastCombinedLogin = e.target.value; };
  } else {
    const codeInput = $('#login-code');
    codeInput.oninput = () => { lastSchoolCode = codeInput.value; };
    codeInput.onblur = async () => {
      const preview = $('#school-preview');
      if (!preview || !codeInput.value.trim()) { if (preview) preview.textContent = ''; return; }
      const res = await resolveSchoolByCode(codeInput.value);
      if (preview) preview.textContent = res.ok ? `✓ ${res.school.school_name}` : '';
    };
  }
}

async function doLogin(e) {
  e.preventDefault();
  const btn = $('#login-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
  const pw = $('#login-pw').value;

  let res;
  if (loginTab === 'student') {
    const code = $('#login-code').value;
    const id = $('#login-id').value;
    res = await loginStudent(id, pw, code);
    if (!res.ok) lastSchoolCode = code;
  } else {
    const combinedValue = $('#login-username').value;
    lastCombinedLogin = combinedValue;
    const { identifier, schoolCode } = splitLoginUsername(combinedValue);
    if (!schoolCode) {
      btn.disabled = false; btn.textContent = 'Sign in';
      renderAuth(`Include your school code after @ — e.g. "${identifier || 'yourname'}@yourschoolcode".`);
      return false;
    }
    res = loginTab === 'parent' ? await loginParent(identifier, pw, schoolCode) : await loginStaff(identifier, pw, schoolCode);
  }

  if (!res.ok) { renderAuth(res.message || 'Sign in failed.'); return; }
  await bootApp();
  return false;
}

/* ----------------------------------------------------------------------
 * SCHOOL SIGNUP (self-serve) — a new school creates its tenant + first
 * admin login here, then is signed straight in. Same visual language as
 * renderAuth (identical CSS classes) so the look/theme stays consistent.
 * -------------------------------------------------------------------- */
function renderSignup() {
  $('#auth-screen').innerHTML = `<div class="auth">
    <div class="promo"><div class="promo-inner">
      <div class="logo">🎓</div>
      <h1>Bring your school onto Shule</h1>
      <p>Set up your school's own space in a minute — classes, subjects, exams and report forms, ready to go.</p>
    </div></div>
    <div class="formside"><div class="formcard">
      <h2>Create your school's account</h2>
      <div class="sub">You'll be the first administrator.</div>
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
  </div>`;

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
    lastSchoolCode = result.school_code;
    loginTab = 'staff';
    const loginRes = await loginStaffByUsername(result.username, body.password, result.school_code);
    if (loginRes.ok) { await bootApp(); return false; }
    renderAuth(`School created! Sign in with School Code "${result.school_code}" to continue.`);
  } catch (err) {
    $('#signup-err').innerHTML = `<div class="auth-err">Something went wrong: ${esc(err.message || err)}</div>`;
    btn.disabled = false; btn.textContent = 'Create school account';
  }
  return false;
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
    { route: 'subjects', label: 'Subjects', ico: '📚' },
    { section: 'People' },
    { parent: 'Students', ico: '🎒', children: [
      { route: 'students', label: 'All Students' },
      { route: 'bulk-upload', label: 'Bulk Upload' }
    ] },
    { route: 'staff', label: 'Staff', ico: '👨‍🏫' },
    { section: 'Teaching' },
    { route: 'class-subjects', label: 'Class Subjects', ico: '🧩' },
    { route: 'teacher-assignments', label: 'Teacher Assignments', ico: '🔗' },
    { section: 'Assessment' },
    { parent: 'Exams', ico: '📝', children: [
      { route: 'exams', label: 'Exams' },
      { route: 'marks', label: 'Enter Marks' },
      { route: 'publishing', label: 'Publish Results' },
      { route: 'grading', label: 'Grading Scales' }
    ] },
    { parent: 'Reports', ico: '🧾', children: [
      { route: 'class-list', label: 'Class List' },
      { route: 'broadsheet', label: 'Mark List' },
      { route: 'reports', label: 'Report Forms' },
      { route: 'merit-list', label: 'Merit List' },
      { route: 'transcript', label: 'Transcript' },
      { route: 'certificates', label: 'Leaving Certificate' }
    ] },
    { section: 'Daily' },
    { route: 'attendance', label: 'Attendance', ico: '🗓️' },
    { route: 'messaging', label: 'Messaging', ico: '💬' },
    { section: 'Configuration' },
    { route: 'academic-calendar', label: 'Academic Calendar', ico: '📅' },
    { route: 'settings', label: 'School Settings', ico: '⚙️' },
    { route: 'users', label: 'User Accounts', ico: '🔐' },
    { route: 'parent-accounts', label: 'Parent Accounts', ico: '👨‍👩‍👧' }
  ],
  teacher: [
    { route: 'dashboard', label: 'Dashboard', ico: '🏠' },
    { section: 'People' },
    { parent: 'Students', ico: '🎒', children: [
      { route: 'students', label: 'All Students' },
      { route: 'bulk-upload', label: 'Bulk Upload' }
    ] },
    { section: 'Daily' },
    { route: 'attendance', label: 'Attendance', ico: '🗓️' },
    { route: 'messaging', label: 'Messaging', ico: '💬' },
    { section: 'Assessment' },
    { parent: 'Exams', ico: '📝', children: [
      { route: 'exams', label: 'Exams' },
      { route: 'marks', label: 'Enter Marks' },
      { route: 'publishing', label: 'Publish Results' }
    ] },
    { parent: 'Reports', ico: '🧾', children: [
      { route: 'class-list', label: 'Class List' },
      { route: 'broadsheet', label: 'Mark List' },
      { route: 'reports', label: 'Report Forms' },
      { route: 'merit-list', label: 'Merit List' },
      { route: 'transcript', label: 'Transcript' },
      { route: 'certificates', label: 'Leaving Certificate' }
    ] }
  ],
  student: [
    { route: 'my-results', label: 'My Results', ico: '🧾' }
  ],
  parent: [
    { route: 'my-children', label: 'My Children', ico: '👨‍👩‍👧' }
  ]
};

function allowedRoutes(role) {
  const set = {};
  (NAV[role] || []).forEach((it) => {
    if (it.route) set[it.route] = true;
    if (it.children) it.children.forEach((c) => { set[c.route] = true; });
  });
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
  'academic-calendar': viewAcademicCalendar,
  'classes': viewClasses,
  'subjects': viewSubjects,
  'students': viewStudents,
  'bulk-upload': viewBulkUpload,
  'staff': viewStaff,
  'class-subjects': viewClassSubjects,
  'teacher-assignments': viewTeacherAssignments,
  'grading': viewGrading,
  'exams': viewExams,
  'marks': viewMarks,
  'publishing': viewPublishing,
  'broadsheet': viewBroadsheet,
  'reports': viewReports,
  'class-list': viewClassList,
  'merit-list': viewMeritList,
  'transcript': viewTranscript,
  'certificates': viewCertificates,
  'my-results': viewMyResults,
  'settings': viewSettings,
  'users': viewUsers,
  'attendance': viewAttendance,
  'messaging': viewMessaging,
  'parent-accounts': viewParentAccounts,
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
