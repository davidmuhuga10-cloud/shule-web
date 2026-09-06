/**
 * financeInventory.mjs — Finance Expansion brief item 4 ("Inventory
 * Management Module"). Five sub-tabs: Dashboard, Items (setup + the four
 * stock-movement actions per item), Movements (the shared history/report
 * ledger, filterable), Reports (current stock, valuation, low/out of
 * stock), and Setup (categories/units — brief §4.1's "configurable rather
 * than hard-coded").
 *
 * Reports are deliberately consolidated into a couple of filterable
 * screens rather than the brief's full list of ~9 named report types
 * (current stock, valuation, received, issued, movement, low-stock,
 * out-of-stock, stocktaking, adjustments) — every one of those is a
 * different filter/slice over the same two tables (inventory_items,
 * inventory_transactions), so Movements' own type/date/item filters and
 * Reports' stock/valuation view already cover all of them in combination,
 * without nine near-identical screens to maintain.
 *
 * Manage-only, same as Expenses/Payroll (migrations/0056's header comment
 * on why this reuses finance_can_manage() instead of a new capability).
 */
import { esc, options, toast, modal, closeModal, confirmAction, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const SUB_TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'items', label: 'Items' },
  { key: 'movements', label: 'Movements' },
  { key: 'reports', label: 'Reports' },
  { key: 'setup', label: 'Setup' }
];

const TYPE_LABEL = { receive: 'Received', issue: 'Issued', adjustment: 'Adjustment', stocktake: 'Stock Take' };
const TYPE_BADGE = {
  receive: '<span class="badge green">Received</span>', issue: '<span class="badge blue">Issued</span>',
  adjustment: '<span class="badge amber">Adjustment</span>', stocktake: '<span class="badge purple">Stock Take</span>'
};

function num(n) { return Number(n || 0).toLocaleString(); }
function isLow(item) { return Number(item.reorder_level) > 0 && Number(item.quantity) <= Number(item.reorder_level); }
function isOut(item) { return Number(item.quantity) <= 0; }

export async function viewFinanceInventory(root, access) {
  if (!access || !access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to manage Inventory — ask your school admin for full Finance access.</div>`;
    return;
  }
  await Db.inventory.bootstrap();
  let active = 'dashboard';
  root.innerHTML = `
    <div class="fin-tabs wrap-tabs">
      ${SUB_TABS.map((t) => `<button data-itab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="finv-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#finv-body');
  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-itab]').forEach((b) => b.classList.toggle('active', b.dataset.itab === key));
    if (key === 'dashboard') renderDashboard(body);
    else if (key === 'items') renderItems(body);
    else if (key === 'movements') renderMovements(body);
    else if (key === 'reports') renderReports(body);
    else renderSetup(body);
  };
  root.querySelectorAll('[data-itab]').forEach((b) => b.onclick = () => show(b.dataset.itab));
  show(active);
}

/* --------------------------------------------------------------- Dashboard */
async function renderDashboard(root) {
  root.innerHTML = loader();
  const [itemsRes, txRes] = await Promise.all([Db.inventory.items.list(), Db.inventory.transactions.list({})]);
  const items = itemsRes.ok ? itemsRes.data : [];
  const tx = (txRes.ok ? txRes.data : []).slice(0, 8);
  const active = items.filter((i) => i.active !== false);
  const inStock = active.filter((i) => Number(i.quantity) > 0).length;
  const low = active.filter(isLow).length;
  const out = active.filter(isOut).length;
  const value = active.reduce((a, i) => a + Number(i.quantity) * Number(i.unit_cost || 0), 0);

  root.innerHTML = `
    <!-- POST-BUILD FEEDBACK item 7 (BUG FIX): "Running Low"/"Out of Stock"
         had the app's bordered side-accent card style; the other three
         tiles were plain, unbordered .card pad divs — inconsistent. Every
         tile now carries the same side-accent treatment. -->
    <div class="fin-summary-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px">
      <div class="card pad side-accent tile-teal"><div class="muted" style="font-size:12px">Total Items</div><div style="font-size:20px;font-weight:700">${active.length}</div></div>
      <div class="card pad side-accent tile-blue"><div class="muted" style="font-size:12px">In Stock</div><div style="font-size:20px;font-weight:700">${inStock}</div></div>
      <div class="card pad side-accent tile-amber"><div class="muted" style="font-size:12px">Running Low</div><div style="font-size:20px;font-weight:700">${low}</div></div>
      <div class="card pad side-accent tile-rose"><div class="muted" style="font-size:12px">Out of Stock</div><div style="font-size:20px;font-weight:700">${out}</div></div>
      <div class="card pad side-accent tile-green"><div class="muted" style="font-size:12px">Estimated Stock Value</div><div style="font-size:20px;font-weight:700">KES ${num(value)}</div></div>
    </div>
    <div class="fin-two-col">
      <div class="card">
        <div class="card-h"><h3>Needs Attention</h3></div>
        <div class="card-b table-wrap"><table class="data">
          <thead><tr><th>Item</th><th>Quantity</th><th>Reorder Level</th></tr></thead>
          <tbody>${active.filter((i) => isLow(i) || isOut(i)).map((i) => `<tr>
            <td>${esc(i.name)}</td><td>${num(i.quantity)} ${esc(i.inventory_units ? i.inventory_units.name : '')}</td><td>${num(i.reorder_level)}</td>
          </tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing running low.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Recent Activity</h3></div>
        <div class="card-b table-wrap"><table class="data">
          <thead><tr><th>Date</th><th>Item</th><th>Type</th><th>Qty</th></tr></thead>
          <tbody>${tx.map((t) => `<tr>
            <td>${esc(String(t.created_at).slice(0, 10))}</td><td>${esc(t.inventory_items ? t.inventory_items.name : '')}</td>
            <td>${TYPE_BADGE[t.type] || esc(t.type)}</td>
            <td style="color:${Number(t.quantity) >= 0 ? 'var(--ok)' : 'var(--danger,#c0392b)'}">${Number(t.quantity) >= 0 ? '+' : ''}${num(t.quantity)}</td>
          </tr>`).join('') || '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------- Items */
async function renderItems(root) {
  root.innerHTML = loader();
  const [itemsRes, categoriesRes, unitsRes, suppliersRes] = await Promise.all([
    Db.inventory.items.list(), Db.inventory.categories.list(), Db.inventory.units.list(), Db.finance.suppliers.list()
  ]);
  const items = itemsRes.ok ? itemsRes.data : [];
  const categories = categoriesRes.ok ? categoriesRes.data : [];
  const units = unitsRes.ok ? unitsRes.data : [];
  const suppliers = suppliersRes.ok ? suppliersRes.data : [];

  root.innerHTML = `
    <div class="fin-toolbar no-print"><div class="spacer"></div><button class="btn" id="fiv-add">+ Add Item</button></div>
    <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Item</th><th>SKU</th><th>Category</th><th>Quantity</th><th>Reorder Lvl</th><th>Unit Cost</th><th>Value</th><th>Supplier</th><th>Location</th><th></th></tr></thead>
      <tbody>${items.map((i) => `<tr${isOut(i) ? ' style="background:rgba(219,39,119,.06)"' : isLow(i) ? ' style="background:rgba(217,164,6,.08)"' : ''}>
        <td>${esc(i.name)}${i.active === false ? ' <span class="badge">Inactive</span>' : ''}</td>
        <td>${esc(i.sku || '—')}</td><td>${esc(i.inventory_categories ? i.inventory_categories.name : '—')}</td>
        <td>${num(i.quantity)} ${esc(i.inventory_units ? i.inventory_units.name : '')}${isOut(i) ? ' <span class="badge amber">Out</span>' : isLow(i) ? ' <span class="badge amber">Low</span>' : ''}</td>
        <td>${num(i.reorder_level)}</td><td>KES ${num(i.unit_cost)}</td><td>KES ${num(Number(i.quantity) * Number(i.unit_cost || 0))}</td>
        <td>${esc(i.finance_suppliers ? i.finance_suppliers.name : '—')}</td><td>${esc(i.storage_location || '—')}</td>
        <td style="white-space:nowrap">
          <button class="btn secondary sm" data-receive="${i.id}">Receive</button>
          <button class="btn secondary sm" data-issue="${i.id}">Issue</button>
          <button class="btn secondary sm" data-adjust="${i.id}">Adjust</button>
          <button class="btn secondary sm" data-stocktake="${i.id}">Count</button>
          <button class="btn secondary sm" data-edit="${i.id}">Edit</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="10" class="muted">No inventory items yet.</td></tr>'}</tbody>
    </table></div></div>
  `;

  const refresh = () => renderItems(root);
  root.querySelector('#fiv-add').onclick = () => openItemModal(null, categories, units, suppliers, refresh);
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openItemModal(items.find((i) => i.id === b.dataset.edit), categories, units, suppliers, refresh));
  root.querySelectorAll('[data-receive]').forEach((b) => b.onclick = () => openReceiveModal(items.find((i) => i.id === b.dataset.receive), suppliers, refresh));
  root.querySelectorAll('[data-issue]').forEach((b) => b.onclick = () => openIssueModal(items.find((i) => i.id === b.dataset.issue), refresh));
  root.querySelectorAll('[data-adjust]').forEach((b) => b.onclick = () => openAdjustModal(items.find((i) => i.id === b.dataset.adjust), refresh));
  root.querySelectorAll('[data-stocktake]').forEach((b) => b.onclick = () => openStocktakeModal(items.find((i) => i.id === b.dataset.stocktake), refresh));
}

function openItemModal(existing, categories, units, suppliers, onSaved) {
  modal({
    title: existing ? 'Edit Item' : 'Add Item',
    body: `
      <div class="field"><label>Item Name</label><input id="fiv-name" value="${esc(existing ? existing.name : '')}"></div>
      <div class="grid2">
        <div class="field"><label>SKU / Code (optional)</label><input id="fiv-sku" value="${esc(existing ? existing.sku || '' : '')}"></div>
        <div class="field"><label>Category (optional)</label><select id="fiv-cat"><option value="">—</option>${options(categories.filter((c) => c.active !== false), 'id', 'name', existing ? existing.category_id : '')}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Unit of Measurement (optional)</label><select id="fiv-unit"><option value="">—</option>${options(units.filter((u) => u.active !== false), 'id', 'name', existing ? existing.unit_id : '')}</select></div>
        <div class="field"><label>Reorder Level</label><input id="fiv-reorder" type="number" min="0" step="0.01" value="${existing ? existing.reorder_level : 0}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Unit Cost (KES)</label><input id="fiv-cost" type="number" min="0" step="0.01" value="${existing ? existing.unit_cost : 0}"></div>
        <div class="field"><label>Preferred Supplier (optional)</label><select id="fiv-supplier"><option value="">—</option>${options(suppliers.filter((s) => s.active !== false), 'id', 'name', existing ? existing.supplier_id : '')}</select></div>
      </div>
      <div class="field"><label>Storage Location (optional)</label><input id="fiv-loc" value="${esc(existing ? existing.storage_location || '' : '')}"></div>
      ${existing ? `<label class="chk" style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-top:6px"><input type="checkbox" id="fiv-active" ${existing.active !== false ? 'checked' : ''}><span>Active</span></label>` : `<p class="hint">New items start at zero stock — use "Receive" afterwards to record what's actually on hand.</p>`}
    `,
    okLabel: 'Save',
    onOk: async () => {
      const name = document.getElementById('fiv-name').value.trim();
      if (!name) { toast('Enter an item name.', 'err'); return; }
      const res = await Db.inventory.items.save({
        id: existing ? existing.id : undefined, name,
        sku: document.getElementById('fiv-sku').value, category_id: document.getElementById('fiv-cat').value,
        unit_id: document.getElementById('fiv-unit').value, reorder_level: document.getElementById('fiv-reorder').value,
        unit_cost: document.getElementById('fiv-cost').value, supplier_id: document.getElementById('fiv-supplier').value,
        storage_location: document.getElementById('fiv-loc').value,
        active: existing ? document.getElementById('fiv-active').checked : true
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Item saved.', 'ok');
      onSaved();
    }
  });
}

function openReceiveModal(item, suppliers, onSaved) {
  modal({
    title: `Receive Stock — ${item.name}`,
    body: `
      <div class="grid2">
        <div class="field"><label>Quantity Received</label><input id="frv-qty" type="number" min="0.01" step="0.01"></div>
        <div class="field"><label>Unit Cost (KES)</label><input id="frv-cost" type="number" min="0" step="0.01" value="${item.unit_cost || ''}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Supplier (optional)</label><select id="frv-supplier"><option value="">—</option>${options(suppliers.filter((s) => s.active !== false), 'id', 'name', item.supplier_id)}</select></div>
        <div class="field"><label>Reference / Invoice No. (optional)</label><input id="frv-ref"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Storage Location</label><input id="frv-loc" value="${esc(item.storage_location || '')}"></div>
        <div class="field"><label>Date</label><input id="frv-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label>Notes (optional)</label><input id="frv-notes"></div>
    `,
    okLabel: 'Record Receipt',
    onOk: async () => {
      const quantity = Number(document.getElementById('frv-qty').value);
      if (!(quantity > 0)) { toast('Enter a quantity greater than zero.', 'err'); return; }
      const res = await Db.inventory.receive({
        item_id: item.id, quantity, unit_cost: document.getElementById('frv-cost').value,
        supplier_id: document.getElementById('frv-supplier').value, reference: document.getElementById('frv-ref').value,
        location: document.getElementById('frv-loc').value, date: document.getElementById('frv-date').value, notes: document.getElementById('frv-notes').value
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`Stock received — now ${num(res.data.new_quantity)} on hand.`, 'ok');
      onSaved();
    }
  });
}

function openIssueModal(item, onSaved) {
  modal({
    title: `Issue Stock — ${item.name}`,
    body: `
      <p class="muted" style="margin-top:0">Currently in stock: ${num(item.quantity)} ${esc(item.inventory_units ? item.inventory_units.name : '')}</p>
      <div class="grid2">
        <div class="field"><label>Quantity to Issue</label><input id="fis-qty" type="number" min="0.01" step="0.01" max="${item.quantity}"></div>
        <div class="field"><label>Date</label><input id="fis-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Issued To (department/destination)</label><input id="fis-dest" placeholder="e.g. Kitchen, Grade 4, Admin Office"></div>
        <div class="field"><label>Received By (person, optional)</label><input id="fis-person"></div>
      </div>
      <div class="field"><label>Reason / Purpose (optional)</label><input id="fis-reason"></div>
      <div class="field"><label>Notes (optional)</label><input id="fis-notes"></div>
    `,
    okLabel: 'Record Issue',
    onOk: async () => {
      const quantity = Number(document.getElementById('fis-qty').value);
      if (!(quantity > 0)) { toast('Enter a quantity greater than zero.', 'err'); return; }
      const res = await Db.inventory.issue({
        item_id: item.id, quantity, destination: document.getElementById('fis-dest').value,
        person: document.getElementById('fis-person').value, reason: document.getElementById('fis-reason').value,
        notes: document.getElementById('fis-notes').value, date: document.getElementById('fis-date').value
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`Stock issued — ${num(res.data.new_quantity)} remaining.`, 'ok');
      onSaved();
    }
  });
}

const ADJUST_REASONS = ['Damaged', 'Expired', 'Lost', 'Stock Count Correction', 'Returned Item', 'Other'];

function openAdjustModal(item, onSaved) {
  modal({
    title: `Adjust Stock — ${item.name}`,
    body: `
      <p class="muted" style="margin-top:0">Currently in stock: ${num(item.quantity)} ${esc(item.inventory_units ? item.inventory_units.name : '')}</p>
      <div class="grid2">
        <div class="field"><label>Direction</label><select id="fad-dir"><option value="decrease">Decrease (damaged, lost, expired…)</option><option value="increase">Increase (found, correction…)</option></select></div>
        <div class="field"><label>Quantity</label><input id="fad-qty" type="number" min="0.01" step="0.01"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Reason</label><select id="fad-reason">${ADJUST_REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></div>
        <div class="field"><label>Date</label><input id="fad-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label>Notes (optional)</label><input id="fad-notes"></div>
    `,
    okLabel: 'Record Adjustment',
    onOk: async () => {
      const qty = Number(document.getElementById('fad-qty').value);
      if (!(qty > 0)) { toast('Enter a quantity greater than zero.', 'err'); return; }
      const dir = document.getElementById('fad-dir').value;
      const res = await Db.inventory.adjust({
        item_id: item.id, quantity_delta: dir === 'increase' ? qty : -qty,
        reason: document.getElementById('fad-reason').value, notes: document.getElementById('fad-notes').value, date: document.getElementById('fad-date').value
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`Adjustment recorded — now ${num(res.data.new_quantity)} on hand.`, 'ok');
      onSaved();
    }
  });
}

function openStocktakeModal(item, onSaved) {
  modal({
    title: `Physical Stock Count — ${item.name}`,
    body: `
      <p class="muted" style="margin-top:0">System quantity: <b>${num(item.quantity)} ${esc(item.inventory_units ? item.inventory_units.name : '')}</b></p>
      <div class="grid2">
        <div class="field"><label>Physical Quantity Counted</label><input id="fst-qty" type="number" min="0" step="0.01" value="${item.quantity}"></div>
        <div class="field"><label>Date</label><input id="fst-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label>Reason / Notes (optional)</label><input id="fst-notes" placeholder="e.g. Term-end stock take"></div>
    `,
    okLabel: 'Confirm Count',
    onOk: async () => {
      const physical = document.getElementById('fst-qty').value;
      if (physical === '' || Number(physical) < 0) { toast('Enter the counted quantity.', 'err'); return; }
      const res = await Db.inventory.stocktake({
        item_id: item.id, physical_quantity: physical, reason: document.getElementById('fst-notes').value, date: document.getElementById('fst-date').value
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      if (!res.data.recorded) toast('No difference found — stock confirmed correct.', 'ok');
      else toast(`Difference of ${res.data.difference > 0 ? '+' : ''}${num(res.data.difference)} recorded.`, 'ok');
      onSaved();
    }
  });
}

/* -------------------------------------------------------------- Movements */
async function renderMovements(root) {
  root.innerHTML = loader();
  const itemsRes = await Db.inventory.items.list();
  const items = itemsRes.ok ? itemsRes.data : [];
  await loadMovements(root, items, { item_id: '', type: '', from: '', to: '' });
}

async function loadMovements(root, items, filters) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Item</label><select id="fmv-item"><option value="">All</option>${options(items, 'id', 'name', filters.item_id)}</select></div>
        <div class="field"><label>Type</label><select id="fmv-type">
          <option value="">All</option>
          ${Object.keys(TYPE_LABEL).map((k) => `<option value="${k}" ${filters.type === k ? 'selected' : ''}>${TYPE_LABEL[k]}</option>`).join('')}
        </select></div>
        <div class="field"><label>From</label><input id="fmv-from" type="date" value="${filters.from}"></div>
        <div class="field"><label>To</label><input id="fmv-to" type="date" value="${filters.to}"></div>
      </div>
    </div>
    <div id="fmv-list">${loader()}</div>
  `;
  const refresh = async () => {
    const f = {
      item_id: root.querySelector('#fmv-item').value, type: root.querySelector('#fmv-type').value,
      from: root.querySelector('#fmv-from').value, to: root.querySelector('#fmv-to').value
    };
    const listEl = root.querySelector('#fmv-list');
    listEl.innerHTML = loader();
    const res = await Db.inventory.transactions.list(f);
    const rows = res.ok ? res.data : [];
    listEl.innerHTML = `
      <div class="card pad" style="margin-bottom:10px"><b>${rows.length}</b> movement(s) shown</div>
      <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Item</th><th>Type</th><th>Qty</th><th>Details</th><th>Recorded By</th></tr></thead>
        <tbody>${rows.map((t) => `<tr>
          <td>${esc(String(t.created_at).slice(0, 10))}</td>
          <td>${esc(t.inventory_items ? t.inventory_items.name : '')}</td>
          <td>${TYPE_BADGE[t.type] || esc(t.type)}</td>
          <td style="color:${Number(t.quantity) >= 0 ? 'var(--ok)' : 'var(--danger,#c0392b)'}">${Number(t.quantity) >= 0 ? '+' : ''}${num(t.quantity)}</td>
          <td>${esc(t.reference || t.destination || t.reason || t.notes || '—')}${t.person ? ` — ${esc(t.person)}` : ''}</td>
          <td>${esc(t.staff ? t.staff.full_name : '—')}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">No movements match these filters.</td></tr>'}</tbody>
      </table></div></div>
    `;
  };
  root.querySelector('#fmv-item').onchange = refresh;
  root.querySelector('#fmv-type').onchange = refresh;
  root.querySelector('#fmv-from').onchange = refresh;
  root.querySelector('#fmv-to').onchange = refresh;
  await refresh();
}

/* ---------------------------------------------------------------- Reports */
async function renderReports(root) {
  root.innerHTML = loader();
  const [itemsRes, categoriesRes] = await Promise.all([Db.inventory.items.list(), Db.inventory.categories.list()]);
  const items = itemsRes.ok ? itemsRes.data : [];
  const categories = categoriesRes.ok ? categoriesRes.data : [];
  await loadStockReport(root, items, categories, { category_id: '', low_only: false });
}

async function loadStockReport(root, items, categories, sel) {
  const filtered = items.filter((i) => (!sel.category_id || i.category_id === sel.category_id) && (!sel.low_only || isLow(i) || isOut(i)));
  const totalValue = filtered.reduce((a, i) => a + Number(i.quantity) * Number(i.unit_cost || 0), 0);
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Category</label><select id="frp-cat"><option value="">All</option>${options(categories, 'id', 'name', sel.category_id)}</select></div>
        <label class="chk" style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:18px"><input type="checkbox" id="frp-low" ${sel.low_only ? 'checked' : ''}><span>Low/out of stock only</span></label>
      </div>
    </div>
    <div class="card pad" style="margin-bottom:10px">${filtered.length} item(s) · Total stock value: <b>KES ${num(totalValue)}</b></div>
    <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Item</th><th>Category</th><th>Quantity</th><th>Unit Cost</th><th>Value</th><th>Status</th></tr></thead>
      <tbody>${filtered.map((i) => `<tr>
        <td>${esc(i.name)}</td><td>${esc(i.inventory_categories ? i.inventory_categories.name : '—')}</td>
        <td>${num(i.quantity)} ${esc(i.inventory_units ? i.inventory_units.name : '')}</td><td>KES ${num(i.unit_cost)}</td><td>KES ${num(Number(i.quantity) * Number(i.unit_cost || 0))}</td>
        <td>${isOut(i) ? '<span class="badge amber">Out of Stock</span>' : isLow(i) ? '<span class="badge amber">Low</span>' : '<span class="badge green">OK</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No items match these filters.</td></tr>'}</tbody>
    </table></div></div>
  `;
  root.querySelector('#frp-cat').onchange = (e) => loadStockReport(root, items, categories, { ...sel, category_id: e.target.value });
  root.querySelector('#frp-low').onchange = (e) => loadStockReport(root, items, categories, { ...sel, low_only: e.target.checked });
}

/* ------------------------------------------------------------------ Setup */
async function renderSetup(root) {
  root.innerHTML = loader();
  const [categoriesRes, unitsRes] = await Promise.all([Db.inventory.categories.list(), Db.inventory.units.list()]);
  const categories = categoriesRes.ok ? categoriesRes.data : [];
  const units = unitsRes.ok ? unitsRes.data : [];
  // POST-BUILD FEEDBACK item 7: "if a school doesn't use certain categories
  // or units, can they actually delete them, or is this secretly a fixed
  // list?" Every row here can now be edited, deactivated (hides it from new
  // Item pickers without touching items already using it), or genuinely
  // deleted (migrations/0058 + the API's remove() — blocked with a clear
  // message, not a raw DB error, if anything still uses it). This includes
  // the 8 default units / 10 default categories inventory_bootstrap() seeds
  // on first use — those are starting suggestions, not permanent fixtures.
  root.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Categories</h3><button class="btn sm" id="fset-add-cat" style="margin-left:auto">+ Add Category</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
        <tbody>${categories.map((c) => `<tr>
          <td>${esc(c.name)}</td><td>${c.active === false ? '<span class="badge amber">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
          <td class="row-actions">
            <button class="btn sm ghost" data-cat-edit="${c.id}">Edit</button>
            <button class="btn sm ghost" data-cat-toggle="${c.id}" data-active="${c.active !== false}">${c.active === false ? 'Activate' : 'Deactivate'}</button>
            <button class="btn sm ghost" data-cat-delete="${c.id}">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">No categories yet.</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Units of Measurement</h3><button class="btn sm" id="fset-add-unit" style="margin-left:auto">+ Add Unit</button></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
        <tbody>${units.map((u) => `<tr>
          <td>${esc(u.name)}</td><td>${u.active === false ? '<span class="badge amber">Inactive</span>' : '<span class="badge green">Active</span>'}</td>
          <td class="row-actions">
            <button class="btn sm ghost" data-unit-edit="${u.id}">Edit</button>
            <button class="btn sm ghost" data-unit-toggle="${u.id}" data-active="${u.active !== false}">${u.active === false ? 'Activate' : 'Deactivate'}</button>
            <button class="btn sm ghost" data-unit-delete="${u.id}">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">No units yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;
  const openCatModal = (existing) => {
    modal({
      title: existing ? 'Edit Category' : 'Add Category',
      body: `<div class="field"><label>Name</label><input id="fset-cat-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Uniforms"></div>`,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fset-cat-name').value.trim();
        if (!name) { toast('Enter a name.', 'err'); return; }
        const res = await Db.inventory.categories.save({ id: existing ? existing.id : undefined, name, active: existing ? existing.active : true });
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        toast(existing ? 'Category updated.' : 'Category added.', 'ok');
        await renderSetup(root);
      }
    });
  };
  const openUnitModal = (existing) => {
    modal({
      title: existing ? 'Edit Unit' : 'Add Unit',
      body: `<div class="field"><label>Name</label><input id="fset-unit-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Dozens"></div>`,
      okLabel: 'Save',
      onOk: async () => {
        const name = document.getElementById('fset-unit-name').value.trim();
        if (!name) { toast('Enter a name.', 'err'); return; }
        const res = await Db.inventory.units.save({ id: existing ? existing.id : undefined, name, active: existing ? existing.active : true });
        if (!res.ok) { toast(res.message, 'err'); return; }
        closeModal();
        toast(existing ? 'Unit updated.' : 'Unit added.', 'ok');
        await renderSetup(root);
      }
    });
  };
  root.querySelector('#fset-add-cat').onclick = () => openCatModal(null);
  root.querySelector('#fset-add-unit').onclick = () => openUnitModal(null);
  root.querySelectorAll('[data-cat-edit]').forEach((b) => b.onclick = () => openCatModal(categories.find((c) => c.id === b.dataset.catEdit)));
  root.querySelectorAll('[data-unit-edit]').forEach((b) => b.onclick = () => openUnitModal(units.find((u) => u.id === b.dataset.unitEdit)));
  root.querySelectorAll('[data-cat-toggle]').forEach((b) => b.onclick = () => {
    const c = categories.find((x) => x.id === b.dataset.catToggle);
    const willActivate = b.dataset.active === 'false';
    confirmAction(
      willActivate ? `"${c.name}" will be selectable again when adding items.` : `"${c.name}" will no longer be selectable for NEW items. Items already using it are untouched.`,
      async () => {
        const res = await Db.inventory.categories.save({ id: c.id, name: c.name, active: willActivate });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(willActivate ? 'Category activated.' : 'Category deactivated.', 'ok');
        await renderSetup(root);
      }
    );
  });
  root.querySelectorAll('[data-unit-toggle]').forEach((b) => b.onclick = () => {
    const u = units.find((x) => x.id === b.dataset.unitToggle);
    const willActivate = b.dataset.active === 'false';
    confirmAction(
      willActivate ? `"${u.name}" will be selectable again when adding items.` : `"${u.name}" will no longer be selectable for NEW items. Items already using it are untouched.`,
      async () => {
        const res = await Db.inventory.units.save({ id: u.id, name: u.name, active: willActivate });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(willActivate ? 'Unit activated.' : 'Unit deactivated.', 'ok');
        await renderSetup(root);
      }
    );
  });
  root.querySelectorAll('[data-cat-delete]').forEach((b) => b.onclick = () => {
    const c = categories.find((x) => x.id === b.dataset.catDelete);
    confirmAction(`Delete category "${c.name}"? This cannot be undone. If any item still uses it, deletion will be blocked instead.`, async () => {
      const res = await Db.inventory.categories.remove(c.id);
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast('Category deleted.', 'ok');
      await renderSetup(root);
    }, true);
  });
  root.querySelectorAll('[data-unit-delete]').forEach((b) => b.onclick = () => {
    const u = units.find((x) => x.id === b.dataset.unitDelete);
    confirmAction(`Delete unit "${u.name}"? This cannot be undone. If any item still uses it, deletion will be blocked instead.`, async () => {
      const res = await Db.inventory.units.remove(u.id);
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast('Unit deleted.', 'ok');
      await renderSetup(root);
    }, true);
  });
}
