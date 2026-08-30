/**
 * financeHub.mjs — "Finance" module landing (Finance_Module_Brief.docx).
 * Same tab-bar convention timetableHub.mjs established: one flat sidebar
 * entry, switched via the `.tabs` segmented control rather than more
 * sidebar submodules.
 *
 * Capability gate: an admin always has full access; a teacher only reaches
 * this screen at all if the sidebar showed "Finance" (state.profile.
 * financeAccess, set at login — see app.js's bootApp()), but this still
 * re-checks directly (in case that flag is stale, or the route was reached
 * by typing the URL) and shows a clear, friendly "no access" screen rather
 * than a confusing wall of failed requests. Within the module, screens that
 * change money vs. just record collections use `canManage`/`canCollect`
 * (threaded down as `access`) to show/hide the actions each capability
 * doesn't cover — the RPCs enforce this for real either way (migrations/
 * 0031_finance_module.sql), this is just so the UI doesn't invite a click
 * that's just going to be rejected.
 */
import { renderLoading, renderPrereq, esc, state, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { viewFinanceDashboard } from './financeDashboard.mjs';
import { viewFinanceInvoicing } from './financeInvoicing.mjs';
import { viewFinanceCollections } from './financeCollections.mjs';
import { openStudentProfile } from './financeStudent.mjs';
import { viewFinanceReports } from './financeReports.mjs';
import { viewFinanceTransport } from './financeTransport.mjs';

// Next Sprint 2 §14: "Search Student" is no longer its own tab — it moved
// up here, to the top-right of the Finance page header (same line as the
// "Finance" title), large and prominent, and stays visible no matter which
// tab below is open. See the header markup + wiring at the bottom of
// viewFinanceHub() below.
// Design standard brief item 4: Collections now comes right after
// Dashboard in the nav order (was 3rd).
const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'collections', label: 'Collections' },
  { key: 'invoicing', label: 'Invoicing' },
  { key: 'reports', label: 'Reports' },
  { key: 'transport', label: 'Transport' }
];

export async function viewFinanceHub(root) {
  renderLoading(root, 'Loading Finance…');

  const isAdmin = state.profile.role === 'admin';
  let access = { canManage: isAdmin, canCollect: isAdmin };
  if (!isAdmin) {
    const capsRes = await Db.capabilities.listForStaff(state.profile.staff_id);
    const caps = capsRes.ok ? capsRes.data : [];
    access = {
      canManage: caps.indexOf('finance_manage_fees') !== -1,
      canCollect: caps.indexOf('finance_manage_fees') !== -1 || caps.indexOf('finance_record_collections') !== -1
    };
  }
  if (!access.canCollect) {
    renderPrereq(root, 'No Finance access',
      'You have not been granted access to the Finance module yet. Ask your school admin to grant you Finance access under Teachers and Staff.',
      'dashboard', 'Go to Dashboard');
    return;
  }

  // Idempotent — creates the "Balance B/F" and "Transport" vote heads on
  // first use only, no-op every time after (see migrations/0031's
  // finance_bootstrap()).
  await Db.finance.bootstrap();

  let active = TABS[0].key;
  root.innerHTML = `
    <div class="page-head fin-page-head no-print" style="align-items:flex-start;gap:20px">
      <div style="display:flex;align-items:center;gap:8px">
        <button class="icon-btn fin-side-toggle" id="fin-menu-toggle" title="Menu">☰</button>
        <h2 style="margin:0">Finance</h2>
      </div>
      <div style="position:relative;flex:1;max-width:640px">
        <input id="fin-search-q" class="fin-search-prominent" placeholder="🔍 Search student — admission no. or name…" autocomplete="off">
        <div id="fin-search-results" class="search-results"></div>
      </div>
    </div>
    <div class="fin-shell">
      <div class="scrim no-print" id="fin-scrim"></div>
      <nav class="fin-side-nav no-print" id="fin-side-nav">
        <div class="fin-rail-arrow">▸</div>
        ${TABS.map((t) => `<a data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</a>`).join('')}
        <a class="fin-nav-msg" data-msg="1">💬 Messages</a>
      </nav>
      <div class="fin-side-body">
        <div id="fin-hub-body"></div>
      </div>
    </div>
  `;
  const body = root.querySelector('#fin-hub-body');
  const sideNav = root.querySelector('#fin-side-nav');
  const finScrim = root.querySelector('#fin-scrim');

  // Same open/close/scrim pattern as the main app sidebar (App.toggleSidebar
  // in app.js), scoped to this module's own side-nav — Finance's nav is only
  // ever shown while inside Finance, never on the main shell. On mobile this
  // toggles the slide-in drawer (.open); on desktop the same function
  // toggles the fixed rail's expanded/collapsed state (.expanded) instead —
  // "fixed, floats over content, collapses to a slim arrow-only rail" per
  // the design standard brief item 1.
  const isDesktop = () => window.innerWidth > 960;
  const toggleFinNav = (force) => {
    const cls = isDesktop() ? 'expanded' : 'open';
    const open = typeof force === 'boolean' ? force : !sideNav.classList.contains(cls);
    sideNav.classList.toggle(cls, open);
    if (!isDesktop()) finScrim.classList.toggle('show', open);
  };
  root.querySelector('#fin-menu-toggle').onclick = () => toggleFinNav();
  finScrim.onclick = () => toggleFinNav(false);
  // Desktop: clicking the collapsed rail itself expands it (no separate
  // hamburger button on desktop — the rail IS the toggle); clicking
  // anywhere outside it while expanded collapses it again.
  sideNav.onclick = (e) => {
    if (isDesktop() && !sideNav.classList.contains('expanded')) toggleFinNav(true);
  };
  // BUG FIX: this view re-runs its whole render every time Finance is
  // opened, so a plain `document.addEventListener` here would pile up a new
  // listener (referencing an already-discarded sideNav) on every visit —
  // remove the previous instance's listener first, same one-listener
  // discipline the rest of the app already follows for cross-render leaks.
  if (window.__finNavOutsideClick) document.removeEventListener('click', window.__finNavOutsideClick);
  window.__finNavOutsideClick = (e) => {
    if (isDesktop() && sideNav.classList.contains('expanded') && !sideNav.contains(e.target)) toggleFinNav(false);
  };
  document.addEventListener('click', window.__finNavOutsideClick);

  const showTab = (key) => {
    active = key;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    toggleFinNav(false);
    renderLoading(body, 'Loading, please wait…');
    if (key === 'dashboard') viewFinanceDashboard(body, access);
    else if (key === 'invoicing') viewFinanceInvoicing(body, access);
    else if (key === 'collections') viewFinanceCollections(body, access);
    else if (key === 'reports') viewFinanceReports(body, access);
    else viewFinanceTransport(body, access);
  };
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); showTab(b.dataset.tab); });
  root.querySelector('[data-msg]').onclick = (e) => { e.stopPropagation(); go('messaging'); };
  showTab(active);

  // Next Sprint 2 §14: picking a search result opens that student's profile
  // right in the tab body (same screen the old "Student Search" tab used —
  // see openStudentProfile() in financeStudent.mjs) and deselects every tab
  // button, since the profile isn't any one of them. The search box itself
  // stays put in the header, so searching again from the profile screen (or
  // from any other tab) always works the same way.
  const qEl = root.querySelector('#fin-search-q');
  const resultsEl = root.querySelector('#fin-search-results');
  let searchTimer = null;
  qEl.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = qEl.value.trim();
      // BUG FIX: this is THE search box shown on the main Finance screen
      // (Finance > search > Dashboard/Invoicing/Collections/Reports/
      // Transport tabs) — a separate, duplicated copy of the same search
      // logic that used to live in financeStudent.mjs's own search screen.
      // That copy was already fixed to search from the first character and
      // show a clear "no student found" message, but this one — the one
      // actually shown here — still required 2+ characters and went
      // silently blank instead. Same fix, applied here too.
      if (!q.length) { resultsEl.innerHTML = ''; return; }
      const r = await Db.finance.students.search(q);
      const list = r.ok ? r.data : [];
      resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('') || `<div class="muted" style="padding:6px">No student found matching "${esc(q)}".</div>`;
      resultsEl.querySelectorAll('[data-id]').forEach((h) => h.onclick = () => {
        const student = list.find((s) => s.id === h.dataset.id);
        resultsEl.innerHTML = '';
        qEl.value = student.full_name;
        root.querySelectorAll('[data-tab]').forEach((b) => b.classList.remove('active'));
        openStudentProfile(body, access, student);
      });
    }, 250);
  };
}
