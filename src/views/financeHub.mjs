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
import { viewFinanceAccounting } from './financeAccounting.mjs';
import { viewFinanceMessaging } from './financeMessaging.mjs';
import { viewFinanceExpenses } from './financeExpenses.mjs';
import { viewFinancePayroll } from './financePayroll.mjs';
import { viewFinanceInventory } from './financeInventory.mjs';
import { viewFinanceTransport } from './financeTransport.mjs';
// Finance Expansion brief item 1.1 ("Student Module Under Finance"): reuse
// the EXACT existing Students screen — same search, add/edit/move, class
// drill-down, bulk upload entry point — as one more tab here, rather than
// building a second, parallel students UI. viewStudents(root) is already
// fully self-contained (it doesn't assume it's mounted at the app's own
// top-level #view), so this is a tab-wiring change, not a new screen.
// Known, accepted trade-off: a few of its secondary actions (Message
// Students, Class List print view, Bulk Upload, its own "Reports" link)
// call the app's normal go('messaging')/go('bulk-upload')/etc., which
// navigates OUT of Finance to that screen on the main sidebar — fine for
// an admin/bursar (those routes are already on their sidebar), but a
// Finance Clerk (see app.js's NAV.financeOnly) doesn't have those routes
// and would bounce straight back to Finance. Rebuilding students.mjs's
// internal navigation to stay "Finance-aware" for that one edge case was
// judged not worth it: the actual ask here (search/add/edit/move
// students) works identically for everyone.
import { viewStudents } from './students.mjs';
// Finance Expansion brief item 1.2's "Preferences or Customization" tab
// ("almost the same as what we have as Permissions in the Exams system").
import { viewFinancePreferences } from './financePreferences.mjs';

// Next Sprint 2 §14: "Search Student" is no longer its own tab — it moved
// up here, to the top-right of the Finance page header (same line as the
// "Finance" title), large and prominent, and stays visible no matter which
// tab below is open. See the header markup + wiring at the bottom of
// viewFinanceHub() below.
// Design standard brief item 4: Collections now comes right after
// Dashboard in the nav order (was 3rd).
const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'students', label: 'Students' },
  { key: 'collections', label: 'Collections' },
  { key: 'invoicing', label: 'Invoicing' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'reports', label: 'Reports' },
  { key: 'transport', label: 'Transport' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'preferences', label: 'Preferences' }
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
    // Finance Clerk (Kodi-comparison follow-up): this person's ENTIRE
    // sidebar is Finance — there is no Dashboard route for the usual
    // "Go to Dashboard" button to send them to (app.js's allowedRoutes()
    // only allows finance/my-profile for them), so a misconfigured clerk
    // (finance_clerk granted without also granting finance_manage_fees/
    // finance_record_collections) gets a message that actually matches
    // their situation instead of a dead-end button.
    if (state.profile.financeOnly) {
      renderPrereq(root, 'No Finance access yet',
        'Your account is set up as a Finance Clerk, but hasn\'t been given Finance permissions yet. Ask your school admin to grant "Finance: record collections" or "Finance: manage fees" under Teachers and Staff.');
    } else {
      renderPrereq(root, 'No Finance access',
        'You have not been granted access to the Finance module yet. Ask your school admin to grant you Finance access under Teachers and Staff.',
        'dashboard', 'Go to Dashboard');
    }
    return;
  }

  // Idempotent — creates the "Balance B/F" and "Transport" vote heads on
  // first use only, no-op every time after (see migrations/0031's
  // finance_bootstrap()).
  await Db.finance.bootstrap();

  let active = TABS[0].key;
  // POST-BUILD AUDIT (Sidebar_Performance_Login_Audit_Fixes.docx item 3,
  // BUG: "look like two different systems bolted together"): Finance opens
  // as its own standalone tab (app.js's finance-only-shell hides the outer
  // app chrome entirely for it — see applyFinanceOnlyShell()), which meant
  // it never carried the same "Active: Year · Term" strip + school logo/
  // name the rest of the app's topbar/sidebar always show. Added here so
  // Finance reads as the same product, not a bolted-on second app.
  const settings = state.settings || {};
  // Sized/styled to match .brand .logo exactly (38x38, 10px radius, orange
  // gradient) — the outer app sidebar's own logo tile — so Finance's nav
  // reads as a literal replica, not a smaller lookalike (post-build audit,
  // "should have been same size just a replica").
  const logoHtml = settings.logo
    ? `<img src="${esc(settings.logo)}" style="width:38px;height:38px;border-radius:10px;object-fit:cover;flex-shrink:0">`
    : `<div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--accent),#e8890b);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🎓</div>`;
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
      <div class="muted" id="fin-active-ctx" style="font-size:13px;white-space:nowrap;align-self:center">Active: <span class="skeleton" style="display:inline-block;width:70px;height:12px;vertical-align:middle"></span></div>
    </div>
    <div class="fin-shell">
      <div class="scrim no-print" id="fin-scrim"></div>
      <nav class="fin-side-nav no-print" id="fin-side-nav">
        <div class="fin-brand">${logoHtml}<div><div class="fin-brand-name">${esc(settings.school_name || 'ShuleTop')}</div><small>Finance</small></div></div>
        <div class="fin-nav-scroll">
          ${TABS.map((t) => `<a data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</a>`).join('')}
          <a class="fin-nav-msg" data-msg="1">💬 Messages</a>
          ${!state.profile.financeOnly ? `<a class="fin-nav-msg" data-back-academic="1">🎓 Back to Academic</a>` : ''}
        </div>
        <div class="fin-side-foot">ShuleTop &copy; 2026</div>
      </nav>
      <div class="fin-side-body">
        <div id="fin-hub-body"></div>
      </div>
    </div>
  `;
  // Non-blocking — the shell above is already fully interactive; this just
  // fills in the "Active: Year · Term" text once it resolves, same
  // fire-and-forget pattern app.js's own topbar uses for the identical text.
  try {
    Promise.resolve(Db.dashboard.getActiveContext()).then((ctx) => {
      const el = root.querySelector('#fin-active-ctx');
      if (!el) return;
      el.innerHTML = ctx.academic_year_name
        ? `Active: <b>${esc(ctx.academic_year_name)}</b> · <b>${esc(ctx.term_name || 'No term set')}</b>`
        : '<span class="muted">No active academic year set</span>';
    }).catch(() => {});
  } catch (e) { /* best-effort — the "Active: Year · Term" strip just stays blank */ }
  const body = root.querySelector('#fin-hub-body');
  const sideNav = root.querySelector('#fin-side-nav');
  const finScrim = root.querySelector('#fin-scrim');

  // POST-BUILD FEEDBACK items 1/3 (BUG FIX): Finance's nav is now a plain
  // static column fixed to the left edge — same as the main app's own
  // .sidebar — with no desktop expand/collapse state at all (that floating,
  // collapsible-rail behavior was the "centered floating over content" bug
  // this review flagged; see main.css's Finance Nav B comment for the full
  // story). The only thing left to toggle is the MOBILE slide-in drawer,
  // same open/close/scrim pattern as the main app sidebar's own
  // App.toggleSidebar.
  const toggleFinNav = (force) => {
    const open = typeof force === 'boolean' ? force : !sideNav.classList.contains('open');
    sideNav.classList.toggle('open', open);
    finScrim.classList.toggle('show', open);
  };
  root.querySelector('#fin-menu-toggle').onclick = () => toggleFinNav();
  finScrim.onclick = () => toggleFinNav(false);

  const showTab = (key) => {
    active = key;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    toggleFinNav(false);
    renderLoading(body, 'Loading, please wait…');
    if (key === 'dashboard') viewFinanceDashboard(body, access);
    else if (key === 'students') viewStudents(body);
    else if (key === 'invoicing') viewFinanceInvoicing(body, access);
    else if (key === 'accounting') viewFinanceAccounting(body, access);
    else if (key === 'expenses') viewFinanceExpenses(body, access);
    else if (key === 'payroll') viewFinancePayroll(body, access);
    else if (key === 'inventory') viewFinanceInventory(body, access);
    else if (key === 'collections') viewFinanceCollections(body, access);
    else if (key === 'reports') viewFinanceReports(body, access);
    else if (key === 'preferences') viewFinancePreferences(body, access);
    else if (key === 'reminders') viewFinanceMessaging(body, access);
    else viewFinanceTransport(body, access);
  };
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); showTab(b.dataset.tab); });
  root.querySelector('[data-msg]').onclick = (e) => { e.stopPropagation(); go('messaging'); };
  // BUG FIX (live report — an admin who ends up in Finance with no OTHER
  // tab open, e.g. straight after school signup, had no obvious way back
  // to the Academic side at all: Finance opens as its own standalone shell
  // with the outer app sidebar hidden, and "💬 Messages" was the only exit,
  // which doesn't read as "go back to Academics" to someone who's never
  // used it before. Mirrors the Academic sidebar's own explicit "Finance ↗"
  // link, just in the other direction — go('dashboard') navigates this same
  // tab to a normal route, which drops the standalone-shell class (see
  // app.js's applyFinanceOnlyShell — it only stays on for financeOnly
  // accounts or while still on the 'finance' route) and brings the full
  // Academic sidebar right back, Finance included as a link back in.
  const backLink = root.querySelector('[data-back-academic]');
  if (backLink) backLink.onclick = (e) => { e.stopPropagation(); go('dashboard'); };
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
      // POST-BUILD AUDIT (Task #49): the search is capped at 30 matches
      // server-side (finance.mjs students.search) — a common surname at a
      // 500+ student school could exceed that with no indication the list
      // was cut off. Say so rather than letting the 31st+ match silently
      // never appear.
      resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('')
        + (list.length === 30 ? `<div class="muted" style="padding:6px;font-style:italic">Showing first 30 matches — type more of the name or admission number to narrow it down.</div>` : '')
        || `<div class="muted" style="padding:6px">No student found matching "${esc(q)}".</div>`;
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
