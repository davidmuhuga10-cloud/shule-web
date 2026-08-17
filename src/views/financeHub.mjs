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
import { renderLoading, renderPrereq, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { viewFinanceDashboard } from './financeDashboard.mjs';
import { viewFinanceInvoicing } from './financeInvoicing.mjs';
import { viewFinanceCollections } from './financeCollections.mjs';
import { viewFinanceStudent } from './financeStudent.mjs';
import { viewFinanceReports } from './financeReports.mjs';
import { viewFinanceTransport } from './financeTransport.mjs';

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'invoicing', label: 'Invoicing' },
  { key: 'collections', label: 'Collections' },
  { key: 'student', label: 'Student Search' },
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
    <div class="page-head no-print"><div><h2>Finance</h2><p>Fees, invoicing, collections, transport billing and basic bookkeeping reports.</p></div></div>
    <div class="tabs settings-tabs no-print">
      ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fin-hub-body"></div>
  `;
  const body = root.querySelector('#fin-hub-body');

  const showTab = (key) => {
    active = key;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    renderLoading(body, 'Loading, please wait…');
    if (key === 'dashboard') viewFinanceDashboard(body, access);
    else if (key === 'invoicing') viewFinanceInvoicing(body, access);
    else if (key === 'collections') viewFinanceCollections(body, access);
    else if (key === 'student') viewFinanceStudent(body, access);
    else if (key === 'reports') viewFinanceReports(body, access);
    else viewFinanceTransport(body, access);
  };
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  showTab(active);
}
