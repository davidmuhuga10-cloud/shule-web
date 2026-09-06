/**
 * financeTransport.mjs — brief §Transport: Routes (name, pickup point,
 * one-way/two-way pricing), student route assignment, and invoicing.
 * Deliberately excludes fleet/vehicle management per the brief — a route
 * here is just a priced billing line, not a dispatch record.
 *
 * POST-BUILD FEEDBACK item 8 (BUG FIX): this used to be one flat screen —
 * a route list that you clicked INTO to see its roster and invoice it,
 * with no separate view of "who's invoiced vs not" anywhere, and no
 * standalone reporting. Split into three simple sub-tabs, same
 * SUB_TABS/`.fin-tabs`/show() pattern every other Finance module already
 * uses:
 *   - Routes: route setup only (add/edit name, pickup point, pricing) —
 *     "make any needed adjustments" per the review's own phrasing.
 *   - Invoicing: pick a route (+ year/term), see every assigned student
 *     with a real Invoiced/Not Invoiced badge per row — not just a bulk
 *     button and a guess — then invoice directly from there. Double-
 *     invoicing was already blocked server-side (finance_invoice_route,
 *     migrations/0032); this is what makes that visible BEFORE clicking,
 *     via the new finance_route_invoiced_students() read (migrations/0060).
 *   - Reports: one compact table, every route's assigned/invoiced/pending
 *     counts for the selected term — not nine screens, just the numbers
 *     that answer "did we invoice everyone yet."
 *
 * Route changes mid-term (§5.4/5.6, unchanged this pass): finance_assign_
 * route() always applies the NEW route/direction's charge going forward;
 * promptChargeAdjustment() below is the "or keep the old negotiated
 * charge" escape hatch. Nothing about a past invoice is ever rewritten —
 * only the assignment row (which route a student is currently on) changes,
 * so charges already billed under the old route stay exactly as invoiced.
 */
import { esc, options, toast, modal, closeModal, confirmAction, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const SUB_TABS = [
  { key: 'routes', label: 'Routes' },
  { key: 'invoicing', label: 'Invoicing' },
  { key: 'reports', label: 'Reports' }
];

export async function viewFinanceTransport(root, access) {
  let active = 'routes';
  root.innerHTML = `
    <div class="fin-tabs wrap-tabs">
      ${SUB_TABS.map((t) => `<button data-ttab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="ft-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#ft-body');
  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-ttab]').forEach((b) => b.classList.toggle('active', b.dataset.ttab === key));
    if (key === 'routes') renderRoutesTab(body, access);
    else if (key === 'invoicing') renderInvoicingTab(body, access);
    else renderReportsTab(body, access);
  };
  root.querySelectorAll('[data-ttab]').forEach((b) => b.onclick = () => show(b.dataset.ttab));
  show(active);
}

/* --------------------------------------------------------------- Routes */
async function renderRoutesTab(root, access) {
  root.innerHTML = loader();
  const res = await Db.finance.routes.list();
  const routes = res.ok ? res.data : [];
  root.innerHTML = `
    <div class="fin-toolbar no-print"><p class="hint" style="margin:0">Route setup and pricing. Assigning students and invoicing happens under the Invoicing tab.</p>
      <div class="spacer"></div>
      ${access.canManage ? '<button class="btn" id="ft-add">+ Add Route</button>' : ''}
    </div>
    <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data compact">
      <thead><tr><th>Route</th><th>Pickup Point</th><th class="num">One-way</th><th class="num">Two-way</th><th>Status</th><th></th></tr></thead>
      <tbody>${routes.map((r) => `<tr>
        <td>${esc(r.name)}</td><td>${esc(r.pickup_point || '—')}</td>
        <td class="num">${Number(r.one_way_amount || 0).toLocaleString()}</td><td class="num">${Number(r.two_way_amount || 0).toLocaleString()}</td>
        <td>${r.active === false ? '<span class="badge grey">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
        <td>${access.canManage ? `<button class="btn secondary sm" data-edit="${r.id}">Edit</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No routes yet — add one to start assigning and invoicing students.</td></tr>'}</tbody>
    </table></div></div>
  `;
  if (access.canManage) {
    root.querySelector('#ft-add').onclick = () => openRouteModal(routes, null, () => renderRoutesTab(root, access));
    root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openRouteModal(routes, routes.find((r) => r.id === b.dataset.edit), () => renderRoutesTab(root, access)));
  }
}

function openRouteModal(routes, existing, onSaved) {
  modal({
    title: existing ? 'Edit Route' : 'Add Route',
    body: `
      <div class="field"><label>Route Name</label><input id="rt-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Route A — Town"></div>
      <div class="field"><label>Pickup Point (optional)</label><input id="rt-pickup" value="${esc(existing ? existing.pickup_point || '' : '')}"></div>
      <div class="grid2">
        <div class="field"><label>One-way Amount (KES)</label><input id="rt-one" type="number" min="0" step="1" value="${existing ? existing.one_way_amount : ''}"></div>
        <div class="field"><label>Two-way Amount (KES)</label><input id="rt-two" type="number" min="0" step="1" value="${existing ? existing.two_way_amount : ''}"></div>
      </div>
      ${existing ? `<div class="field"><label class="chk"><input type="checkbox" id="rt-active" ${existing.active === false ? '' : 'checked'}> Active</label></div>` : ''}
    `,
    okLabel: 'Save',
    onOk: async () => {
      const name = document.getElementById('rt-name').value;
      if (!String(name || '').trim()) { toast('Route name is required.', 'err'); return; }
      const payload = {
        id: existing ? existing.id : undefined,
        name, pickup_point: document.getElementById('rt-pickup').value,
        one_way_amount: document.getElementById('rt-one').value, two_way_amount: document.getElementById('rt-two').value,
        active: existing ? document.getElementById('rt-active').checked : true
      };
      const res = await Db.finance.routes.save(payload);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Route saved.', 'ok');
      onSaved();
    }
  });
}

/* ------------------------------------------------------------ Invoicing */
async function renderInvoicingTab(root, access) {
  root.innerHTML = loader();
  const [routesRes, yearsRes, termsRes] = await Promise.all([Db.finance.routes.list(), Db.academicYears.list(), Db.terms.list()]);
  const routes = (routesRes.ok ? routesRes.data : []).filter((r) => r.active !== false);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  await loadInvoicing(root, access, routes, years, terms, {
    route_id: routes[0] ? routes[0].id : '', academic_year_id: activeYear ? activeYear.id : '', term_id: activeTerm ? activeTerm.id : ''
  });
}

async function loadInvoicing(root, access, routes, years, terms, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Route</label><select id="fti-route">${routes.length ? options(routes, 'id', 'name', sel.route_id) : '<option value="">No routes yet — add one under Routes</option>'}</select></div>
        <div class="field"><label>Academic Year</label><select id="fti-year">${options(years, 'id', 'name', sel.academic_year_id)}</select></div>
        <div class="field"><label>Term</label><select id="fti-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id)}</select></div>
      </div>
      <div class="spacer"></div>
      ${access.canManage && routes.length ? `<button class="btn secondary" id="fti-add-student">+ Add Student</button>
      <button class="btn" id="fti-invoice">Invoice this route</button>` : ''}
    </div>
    <div id="fti-roster">${loader()}</div>
  `;
  if (!routes.length) { root.querySelector('#fti-roster').innerHTML = ''; return; }
  root.querySelector('#fti-route').onchange = (e) => loadInvoicing(root, access, routes, years, terms, { ...sel, route_id: e.target.value });
  root.querySelector('#fti-year').onchange = (e) => loadInvoicing(root, access, routes, years, terms, { ...sel, academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#fti-term').onchange = (e) => loadInvoicing(root, access, routes, years, terms, { ...sel, term_id: e.target.value });

  const route = routes.find((r) => r.id === sel.route_id);
  const rosterEl = root.querySelector('#fti-roster');
  let lastRoster = [];
  let notInvoicedCount = 0;
  const refreshRoster = async () => {
    if (!route || !sel.academic_year_id || !sel.term_id) { rosterEl.innerHTML = '<div class="card pad muted">Choose a route, academic year and term.</div>'; lastRoster = []; return; }
    const [rosterRes, invoicedRes] = await Promise.all([
      Db.finance.routes.studentsOnRoute(route.id, sel.academic_year_id, sel.term_id),
      Db.finance.routes.invoicedStudentIds(route.id, sel.academic_year_id, sel.term_id)
    ]);
    const rows = rosterRes.ok ? rosterRes.data : [];
    const invoicedIds = new Set(invoicedRes.ok ? invoicedRes.data : []);
    lastRoster = rows;
    notInvoicedCount = rows.filter((r) => !invoicedIds.has(r.student_id)).length;
    // POST-BUILD FEEDBACK item 8: "can I, right now, look at a list and
    // tell which students have already been invoiced this term and which
    // haven't?" — this column is that answer, per student, not a guess.
    rosterEl.innerHTML = `
      <div class="fin-toolbar no-print" style="margin-bottom:8px"><span class="muted"><b>${rows.length}</b> assigned · <b>${rows.length - notInvoicedCount}</b> invoiced · <b>${notInvoicedCount}</b> not yet invoiced</span></div>
      <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data compact">
        <thead><tr><th>Student</th><th>Class</th><th>Direction</th><th>Invoiced This Term?</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.students ? r.students.full_name : '')} <span class="muted">${esc(r.students ? r.students.admission_no : '')}</span></td>
          <td>${esc(r.students && r.students.classes ? r.students.classes.name : '')}</td>
          <td>${r.direction === 'two_way' ? 'Two-way' : 'One-way'}</td>
          <td>${invoicedIds.has(r.student_id) ? '<span class="badge green">Invoiced</span>' : '<span class="badge amber">Not invoiced</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">No students assigned to this route for this term yet.</td></tr>'}</tbody>
      </table></div></div>
    `;
  };
  await refreshRoster();

  if (access.canManage && route) {
    root.querySelector('#fti-add-student').onclick = () => openAddStudentModal(route, routes, sel, async () => { await refreshRoster(); });
    // Finance Expansion §5.7/Phase 5 — "ask before invoicing" instead of
    // silently billing everyone the moment the button is clicked. The bulk
    // RPC already skips anyone already invoiced server-side (so a second
    // click can never double-charge); the roster above now also shows that
    // per-student, before anyone even reaches for the button.
    root.querySelector('#fti-invoice').onclick = () => {
      const term = terms.find((t) => t.id === sel.term_id);
      const termLabel = term ? term.name : 'the selected term';
      if (!notInvoicedCount) { toast('Everyone currently assigned to this route has already been invoiced for this term.', 'ok'); return; }
      confirmAction(
        `Invoice ${route.name} transport for ${termLabel} now? This adds a transport charge for the ${notInvoicedCount} student(s) above not yet invoiced. Anyone already invoiced is skipped automatically — this can't double-charge.`,
        async () => {
          const res = await Db.finance.routes.invoiceRoute(route.id, sel.academic_year_id, sel.term_id);
          if (!res.ok) { toast(res.message, 'err'); return; }
          toast(`Invoiced ${res.data.invoiced_count} student(s)${res.data.skipped_count ? `, skipped ${res.data.skipped_count} already invoiced` : ''}.`, 'ok');
          await refreshRoster();
        }
      );
    };
  }
}

function routeAmount(route, direction) {
  return Number((direction === 'two_way' ? route.two_way_amount : route.one_way_amount) || 0);
}

/**
 * Finance Expansion §5.4/5.6 (Phase 5) — "Students Changing Routes" /
 * negotiated charges. finance_assign_route() already auto-applies the new
 * route/direction's standard charge whenever a student is (re)assigned;
 * this is the missing "or keep the old charge on purpose" choice, asked
 * only when there's actually a decision to make (an existing assignment
 * this term whose charge would change). fnProceed(amountOverride) is
 * called with either a number (keep current charge) or null (apply the
 * new standard charge) — the caller does the actual save. A past invoice
 * is never touched either way — only which route/charge applies GOING
 * FORWARD changes.
 */
function promptChargeAdjustment(studentName, oldAmount, newAmount, fnProceed) {
  const verb = newAmount > oldAmount ? 'increase' : 'reduce';
  modal({
    title: 'Transport Charge Changed',
    body: `
      <p style="margin-top:0">${esc(studentName)}'s new route/direction changes their transport charge from <b>KES ${oldAmount.toLocaleString()}</b> to <b>KES ${newAmount.toLocaleString()}</b> (a ${verb}). Anything already invoiced under the old route is untouched — this only affects the charge applied going forward.</p>
      <div class="field">
        <label class="chk" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin:8px 0">
          <input type="radio" name="ars-charge" value="new" checked style="margin-top:3px">
          <span>Apply the new charge — KES ${newAmount.toLocaleString()} (the standard rate for this route/direction)</span>
        </label>
        <label class="chk" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin:8px 0">
          <input type="radio" name="ars-charge" value="keep" style="margin-top:3px">
          <span>Keep the current charge — KES ${oldAmount.toLocaleString()} (a negotiated/special-arrangement rate)</span>
        </label>
      </div>
    `,
    okLabel: 'Continue',
    onOk: async () => {
      const choice = document.querySelector('input[name="ars-charge"]:checked').value;
      await fnProceed(choice === 'keep' ? oldAmount : null);
    }
  });
}

function openAddStudentModal(route, routes, sel, onSaved) {
  if (!sel.academic_year_id || !sel.term_id) { toast('Choose an academic year and term first.', 'err'); return; }
  let selectedStudent = null;
  modal({
    title: `Add a Student to ${route.name}`,
    body: `
      <div class="field" style="position:relative"><label>Student</label>
        <input id="ars-q" placeholder="Type a name or admission no.…" autocomplete="off">
        <div id="ars-results" class="search-results"></div>
      </div>
      <div class="field"><label>Direction</label><select id="ars-direction">
        <option value="two_way">Two-way</option><option value="one_way">One-way</option>
      </select></div>
    `,
    okLabel: 'Add',
    onOk: async () => {
      if (!selectedStudent) { toast('Search for and select a student first.', 'err'); return; }
      const direction = document.getElementById('ars-direction').value;
      const doAssign = async (amountOverride) => {
        const res = await Db.finance.routes.assign(selectedStudent.id, route.id, direction, sel.academic_year_id, sel.term_id, amountOverride);
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        toast(`${selectedStudent.full_name} added to ${route.name}.`, 'ok');
        onSaved();
      };

      // Only worth asking when this is actually a CHANGE from an existing
      // assignment this term, and that change actually moves the charge —
      // a brand-new assignment or a same-charge switch (e.g. two routes
      // priced identically) just proceeds as before, no extra click.
      const existingRes = await Db.finance.routes.forStudent(selectedStudent.id, sel.academic_year_id, sel.term_id);
      const existing = existingRes.ok ? existingRes.data : null;
      if (existing && (existing.route_id !== route.id || existing.direction !== direction)) {
        const oldRoute = routes.find((r) => r.id === existing.route_id);
        if (oldRoute) {
          const oldAmount = routeAmount(oldRoute, existing.direction);
          const newAmount = routeAmount(route, direction);
          if (oldAmount !== newAmount) {
            promptChargeAdjustment(selectedStudent.full_name, oldAmount, newAmount, doAssign);
            return;
          }
        }
      }
      await doAssign(null);
    }
  });
  const qEl = document.getElementById('ars-q');
  const resultsEl = document.getElementById('ars-results');
  let t = null;
  qEl.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = qEl.value.trim();
      if (!q.length) { resultsEl.innerHTML = ''; return; }
      const r = await Db.finance.students.search(q);
      const list = r.ok ? r.data : [];
      resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('')
        + (list.length === 30 ? `<div class="muted" style="padding:6px;font-style:italic">Showing first 30 matches — type more of the name or admission number to narrow it down.</div>` : '')
        || `<div class="muted" style="padding:6px">No student found matching "${esc(q)}".</div>`;
      resultsEl.querySelectorAll('[data-id]').forEach((h) => h.onclick = () => {
        selectedStudent = list.find((s) => s.id === h.dataset.id);
        resultsEl.innerHTML = '';
        qEl.value = selectedStudent.full_name;
      });
    }, 250);
  };
}

/* -------------------------------------------------------------- Reports */
async function renderReportsTab(root, access) {
  root.innerHTML = loader();
  const [routesRes, yearsRes, termsRes] = await Promise.all([Db.finance.routes.list(), Db.academicYears.list(), Db.terms.list()]);
  const routes = routesRes.ok ? routesRes.data : [];
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  await loadReport(root, routes, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: activeTerm ? activeTerm.id : '' });
}

async function loadReport(root, routes, years, terms, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label><select id="ftr-year">${options(years, 'id', 'name', sel.academic_year_id)}</select></div>
        <div class="field"><label>Term</label><select id="ftr-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id)}</select></div>
      </div>
    </div>
    <div id="ftr-table">${loader()}</div>
  `;
  root.querySelector('#ftr-year').onchange = (e) => loadReport(root, routes, years, terms, { academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#ftr-term').onchange = (e) => loadReport(root, routes, years, terms, { ...sel, term_id: e.target.value });

  const tableEl = root.querySelector('#ftr-table');
  if (!sel.academic_year_id || !sel.term_id) { tableEl.innerHTML = '<div class="card pad muted">Choose an academic year and term.</div>'; return; }
  // Consolidates what would otherwise be several separate report screens
  // into one table — per-route assigned/invoiced/pending counts for the
  // selected term. Small schools rarely have more than a handful of
  // routes, so one request per route stays cheap; Promise.all keeps it to
  // a single round trip's worth of latency either way.
  const rows = await Promise.all(routes.map(async (r) => {
    const [rosterRes, invoicedRes] = await Promise.all([
      Db.finance.routes.studentsOnRoute(r.id, sel.academic_year_id, sel.term_id),
      Db.finance.routes.invoicedStudentIds(r.id, sel.academic_year_id, sel.term_id)
    ]);
    const assigned = rosterRes.ok ? rosterRes.data.length : 0;
    const invoiced = invoicedRes.ok ? invoicedRes.data.length : 0;
    return { route: r, assigned, invoiced, pending: Math.max(0, assigned - invoiced) };
  }));
  const totalPending = rows.reduce((a, r) => a + r.pending, 0);
  tableEl.innerHTML = `
    <div class="fin-toolbar no-print" style="margin-bottom:8px"><span class="muted">${totalPending ? `<b>${totalPending}</b> student(s) across all routes still need invoicing this term.` : 'Everyone currently assigned to a route has been invoiced this term.'}</span></div>
    <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data compact">
      <thead><tr><th>Route</th><th class="num">Assigned</th><th class="num">Invoiced</th><th class="num">Pending</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.route.name)}</td><td class="num">${r.assigned}</td><td class="num">${r.invoiced}</td>
        <td class="num">${r.pending ? `<span class="badge amber">${r.pending}</span>` : '<span class="badge green">0</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">No routes yet.</td></tr>'}</tbody>
    </table></div></div>
  `;
}
