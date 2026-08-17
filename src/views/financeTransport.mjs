/**
 * financeTransport.mjs — brief §Transport: Routes (name, pickup point,
 * one-way/two-way pricing) and student route assignment. Deliberately
 * excludes fleet/vehicle management per the brief — a route here is just a
 * priced billing line, not a dispatch record.
 */
import { esc, toast, modal, closeModal, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewFinanceTransport(root, access) {
  root.innerHTML = loader();
  const res = await Db.finance.routes.list();
  const routes = res.ok ? res.data : [];

  root.innerHTML = `
    <div class="page-head"><div><p class="hint" style="margin:0">Routes are used when assigning transport to a student from their profile under Student Search.</p></div>
      ${access.canManage ? '<button class="btn" id="ft-add">+ Add Route</button>' : ''}
    </div>
    <div class="card"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Route</th><th>Pickup Point</th><th class="num">One-way</th><th class="num">Two-way</th><th>Status</th><th></th></tr></thead>
      <tbody>${routes.map((r) => `<tr>
        <td>${esc(r.name)}</td><td>${esc(r.pickup_point || '')}</td>
        <td class="num">${Number(r.one_way_amount || 0).toLocaleString()}</td><td class="num">${Number(r.two_way_amount || 0).toLocaleString()}</td>
        <td>${r.active === false ? '<span class="badge grey">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
        <td>${access.canManage ? `<button class="btn secondary sm" data-edit="${r.id}">Edit</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No routes yet.</td></tr>'}</tbody>
    </table></div></div>
    <p class="hint" style="margin-top:10px">To assign a student to a route, search for them under <b>Student Search</b> and use "Assign / Correct Route" on their Profile tab.</p>
  `;

  if (access.canManage) {
    root.querySelector('#ft-add').onclick = () => openRouteModal(root, access, routes);
    root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
      const r = routes.find((x) => x.id === b.dataset.edit);
      openRouteModal(root, access, routes, r);
    });
  }
}

function openRouteModal(root, access, routes, existing) {
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
      viewFinanceTransport(root, access);
    }
  });
}
