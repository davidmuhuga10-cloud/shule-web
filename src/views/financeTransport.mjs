/**
 * financeTransport.mjs — brief §Transport: Routes (name, pickup point,
 * one-way/two-way pricing) and student route assignment. Deliberately
 * excludes fleet/vehicle management per the brief — a route here is just a
 * priced billing line, not a dispatch record.
 *
 * Round 2 §8 — clicking into a route now opens its own detail screen: the
 * roster of students currently assigned to it for a term, a way to add
 * more students directly (rather than only from a student's own profile),
 * and a bulk "Invoice" button that invoices everyone on the route not yet
 * invoiced for that term — skipping anyone already invoiced is enforced
 * server-side (finance_invoice_route in migrations/0032), not just hidden
 * client-side.
 */
import { esc, options, toast, modal, closeModal, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewFinanceTransport(root, access) {
  root.innerHTML = loader();
  const res = await Db.finance.routes.list();
  const routes = res.ok ? res.data : [];
  renderRoutesList(root, access, routes);
}

function renderRoutesList(root, access, routes) {
  root.innerHTML = `
    <div class="fin-toolbar"><p class="hint" style="margin:0">Click a route to see who's assigned to it and invoice them in bulk.</p>
      <div class="spacer"></div>
      ${access.canManage ? '<button class="btn" id="ft-add">+ Add Route</button>' : ''}
    </div>
    <div class="card"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Route</th><th>Pickup Point</th><th class="num">One-way</th><th class="num">Two-way</th><th>Status</th><th></th></tr></thead>
      <tbody>${routes.map((r) => `<tr>
        <td><a href="javascript:void(0)" data-open="${r.id}">${esc(r.name)}</a></td><td>${esc(r.pickup_point || '')}</td>
        <td class="num">${Number(r.one_way_amount || 0).toLocaleString()}</td><td class="num">${Number(r.two_way_amount || 0).toLocaleString()}</td>
        <td>${r.active === false ? '<span class="badge grey">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
        <td>
          <button class="btn secondary sm" data-open="${r.id}">View</button>
          ${access.canManage ? `<button class="btn secondary sm" data-edit="${r.id}">Edit</button>` : ''}
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No routes yet.</td></tr>'}</tbody>
    </table></div></div>
  `;

  root.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => {
    const r = routes.find((x) => x.id === b.dataset.open);
    viewRouteDetail(root, access, r, routes);
  });
  if (access.canManage) {
    root.querySelector('#ft-add').onclick = () => openRouteModal(root, access, routes, null, () => viewFinanceTransport(root, access));
    root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const r = routes.find((x) => x.id === b.dataset.edit);
      openRouteModal(root, access, routes, r, () => viewFinanceTransport(root, access));
    });
  }
}

function openRouteModal(root, access, routes, existing, onSaved) {
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

/* --------------------------------------------------------- route detail --- */
async function viewRouteDetail(root, access, route, routes) {
  root.innerHTML = loader();
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  await loadRouteDetail(root, access, route, routes, years, terms, {
    academic_year_id: activeYear ? activeYear.id : '', term_id: activeTerm ? activeTerm.id : ''
  });
}

async function loadRouteDetail(root, access, route, routes, years, terms, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div><a href="javascript:void(0)" id="ft-back" class="back-link">← All routes</a></div>
      <div class="spacer"></div>
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label><select id="ftd-year">${options(years, 'id', 'name', sel.academic_year_id)}</select></div>
        <div class="field"><label>Term</label><select id="ftd-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id)}</select></div>
      </div>
    </div>
    <div class="card pad">
      <h2 style="margin:0 0 4px">${esc(route.name)}</h2>
      <p class="muted" style="margin:0">${esc(route.pickup_point || 'No pickup point set')} · One-way KES ${Number(route.one_way_amount || 0).toLocaleString()} · Two-way KES ${Number(route.two_way_amount || 0).toLocaleString()}</p>
    </div>
    <div class="fin-toolbar" style="margin-top:14px">
      <p class="hint" style="margin:0">Students below are assigned to this route for the selected term.</p>
      <div class="spacer"></div>
      ${access.canManage ? `<button class="btn secondary" id="ftd-add-student">+ Add Student</button>
      <button class="btn" id="ftd-invoice">Invoice this route</button>` : ''}
    </div>
    <div id="ftd-roster">${loader()}</div>
  `;

  root.querySelector('#ft-back').onclick = () => renderRoutesList(root, access, routes);
  root.querySelector('#ftd-year').onchange = (e) => loadRouteDetail(root, access, route, routes, years, terms, { academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#ftd-term').onchange = (e) => loadRouteDetail(root, access, route, routes, years, terms, { ...sel, term_id: e.target.value });

  const rosterEl = root.querySelector('#ftd-roster');
  const refreshRoster = async () => {
    if (!sel.academic_year_id || !sel.term_id) { rosterEl.innerHTML = '<div class="card pad muted">Choose an academic year and term.</div>'; return []; }
    const res = await Db.finance.routes.studentsOnRoute(route.id, sel.academic_year_id, sel.term_id);
    const rows = res.ok ? res.data : [];
    rosterEl.innerHTML = `
      <div class="card"><div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Student</th><th>Class</th><th>Direction</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.students ? r.students.full_name : '')} <span class="muted">${esc(r.students ? r.students.admission_no : '')}</span></td>
          <td>${esc(r.students && r.students.classes ? r.students.classes.name : '')}</td>
          <td>${r.direction === 'two_way' ? 'Two-way' : 'One-way'}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">No students assigned to this route for this term yet.</td></tr>'}</tbody>
      </table></div></div>
    `;
    return rows;
  };
  await refreshRoster();

  if (access.canManage) {
    root.querySelector('#ftd-add-student').onclick = () => openAddStudentModal(route, sel, async () => { await refreshRoster(); });
    root.querySelector('#ftd-invoice').onclick = async () => {
      if (!sel.academic_year_id || !sel.term_id) { toast('Choose an academic year and term first.', 'err'); return; }
      const btn = root.querySelector('#ftd-invoice');
      btn.disabled = true; const label = btn.textContent; btn.textContent = 'Invoicing…';
      const res = await Db.finance.routes.invoiceRoute(route.id, sel.academic_year_id, sel.term_id);
      btn.disabled = false; btn.textContent = label;
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast(`Invoiced ${res.data.invoiced_count} student(s)${res.data.skipped_count ? `, skipped ${res.data.skipped_count} already invoiced` : ''}.`, 'ok');
    };
  }
}

function openAddStudentModal(route, sel, onSaved) {
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
      const res = await Db.finance.routes.assign(selectedStudent.id, route.id, direction, sel.academic_year_id, sel.term_id);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`${selectedStudent.full_name} added to ${route.name}.`, 'ok');
      onSaved();
    }
  });
  const qEl = document.getElementById('ars-q');
  const resultsEl = document.getElementById('ars-results');
  let t = null;
  qEl.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = qEl.value.trim();
      if (q.length < 2) { resultsEl.innerHTML = ''; return; }
      const r = await Db.finance.students.search(q);
      const list = r.ok ? r.data : [];
      resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('') || '<div class="muted" style="padding:6px">No matches.</div>';
      resultsEl.querySelectorAll('[data-id]').forEach((h) => h.onclick = () => {
        selectedStudent = list.find((s) => s.id === h.dataset.id);
        resultsEl.innerHTML = '';
        qEl.value = selectedStudent.full_name;
      });
    }, 250);
  };
}
