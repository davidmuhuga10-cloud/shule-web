/**
 * mount.mjs — screenshot-harness entry point. Reads ?view=&route= from the
 * URL, renders a static (non-interactive) sidebar for visual context, then
 * dynamically imports and mounts the REAL, unmodified production view module
 * — the import map in harness.html redirects its `../app.js` / Db import to
 * the shims in this folder, so no live Supabase project is involved.
 */
const params = new URLSearchParams(location.search);
const view = params.get('view');
const route = params.get('route') || view;

const NAV = [
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
  { route: 'messaging', label: 'Messaging', ico: '💬' },
  { section: 'Configuration' },
  { route: 'settings', label: 'Settings', ico: '⚙️' }
];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildNav() {
  let html = '';
  NAV.forEach((it) => {
    if (it.section) { html += `<div class="group">${esc(it.section)}</div>`; }
    else {
      html += `<a${it.route === route ? ' class="active"' : ''}><span class="ico">${it.ico}</span>${esc(it.label)}</a>`;
    }
  });
  document.getElementById('nav').innerHTML = html;
}

async function mount() {
  buildNav();
  const root = document.getElementById('view');

  // ?missingContact=1 — screenshot QA for feature brief §3's "block printing
  // until contact/address details are set" gate: monkey-patch the shim Db's
  // settings.get() (same singleton the redirected '../lib/api/index.mjs'
  // import resolves to, per harness.html's import map) to return incomplete
  // contact info before the view mounts.
  if (params.get('missingContact')) {
    const { Db } = await import('/mockups/shim-db.mjs');
    Db.settings.get = async () => ({ ok: true, data: { school_name: 'Tumaini Junior School' } });
  }
  if (view === 'dashboard') {
    const { viewDashboard } = await import('/src/views/dashboard.mjs');
    await viewDashboard(root);
  } else if (view === 'classes') {
    const { viewClasses } = await import('/src/views/classes.mjs');
    await viewClasses(root);
  } else if (view === 'students') {
    const { viewStudents } = await import('/src/views/students.mjs');
    await viewStudents(root);
  } else if (view === 'teachers') {
    const { viewTeachers } = await import('/src/views/teachers.mjs');
    await viewTeachers(root);
  } else if (view === 'broadsheet') {
    const { viewBroadsheet } = await import('/src/views/broadsheet.mjs');
    await viewBroadsheet(root);
  } else if (view === 'classList') {
    const { viewClassList } = await import('/src/views/classList.mjs');
    await viewClassList(root);
  } else if (view === 'scoreSheet') {
    const { viewScoreSheet } = await import('/src/views/scoreSheet.mjs');
    await viewScoreSheet(root);
  } else if (view === 'examAnalysis') {
    const { viewExamAnalysis } = await import('/src/views/examAnalysis.mjs');
    await viewExamAnalysis(root);
  } else if (view === 'staff') {
    const { viewStaff } = await import('/src/views/staff.mjs');
    await viewStaff(root);
  } else if (view === 'reportForms') {
    const { viewReports } = await import('/src/views/reportForms.mjs');
    await viewReports(root);
  } else if (view === 'examsHub') {
    const { viewExamsHub } = await import('/src/views/examsHub.mjs');
    await viewExamsHub(root);
  } else if (view === 'reportsHub') {
    const { viewReportsHub } = await import('/src/views/reportsHub.mjs');
    await viewReportsHub(root);
  } else if (view === 'settings') {
    const { viewSettingsHub } = await import('/src/views/settings.mjs');
    await viewSettingsHub(root);
  } else if (view === 'staffTeachers') {
    const { viewStaffHub } = await import('/src/views/staffTeachers.mjs');
    await viewStaffHub(root);
  } else if (view === 'messaging') {
    const { viewMessaging } = await import('/src/views/messaging.mjs');
    await viewMessaging(root);
  } else if (view === 'examDesk') {
    const { viewExamDesk } = await import('/src/views/examDesk.mjs');
    await viewExamDesk(root);
  }
  window.__mockMounted = true;
}
mount();
