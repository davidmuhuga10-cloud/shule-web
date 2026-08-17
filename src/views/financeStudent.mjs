/**
 * financeStudent.mjs — brief §Student Search & Statement: search a student,
 * then Profile / Collections / Statement tabs, plus the entry points for
 * issuing a debit/credit note, assigning/correcting a transport route,
 * setting an opening balance, and sending an SMS reminder — all with the
 * student's own balance visible for context. Deliberately excludes Pocket
 * Money / Pledges per the brief.
 */
import { esc, options, toast, modal, closeModal, loader, printOptionsHtml, wirePrintOptions, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { buildStatement } from '../lib/finance/statement.mjs';
import { viewFinanceCollections } from './financeCollections.mjs';
import { renderIssueNoteModal } from './financeInvoicing.mjs';

export async function viewFinanceStudent(root, access) {
  root.innerHTML = `
    <div class="search-hero" style="position:relative">
      <input id="fst-q" placeholder="🔍 Search by admission no. or name…" autocomplete="off">
      <div id="fst-results" class="search-results"></div>
    </div>
    <div id="fst-body" style="margin-top:14px"></div>
  `;
  const qEl = root.querySelector('#fst-q');
  const resultsEl = root.querySelector('#fst-results');
  const body = root.querySelector('#fst-body');
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
        const student = list.find((s) => s.id === h.dataset.id);
        resultsEl.innerHTML = '';
        qEl.value = student.full_name;
        openStudent(body, access, student);
      });
    }, 250);
  };
}

async function openStudent(body, access, student) {
  body.innerHTML = loader();
  const [yearsRes, termsRes, balRes] = await Promise.all([Db.academicYears.list(), Db.terms.list(), Db.finance.students.balance(student.id)]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  const bal = balRes.ok ? balRes.data : {};

  const TABS = [
    { key: 'profile', label: 'Profile' },
    { key: 'collections', label: 'Collections' },
    { key: 'statement', label: 'Statement' }
  ];
  let active = 'profile';
  body.innerHTML = `
    <div class="card pad" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <h3 style="margin:0 0 2px">${esc(student.full_name)}</h3>
        <div class="muted">${esc(student.admission_no)} · ${esc(student.classes ? student.classes.name : '')}${student.streams ? ' ' + esc(student.streams.name) : ''}</div>
      </div>
      <div style="text-align:right"><div class="muted" style="font-size:12px">Balance</div>
        <div style="font-size:20px;font-weight:700;color:${Number(bal.balance || 0) > 0 ? 'var(--danger)' : 'var(--ok)'}">KES ${Number(bal.balance || 0).toLocaleString()}</div>
      </div>
    </div>
    <div class="fin-tabs no-print" style="margin-top:12px">
      ${TABS.map((t) => `<button data-stab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fst-tab-body" style="margin-top:12px"></div>
  `;
  const tabBody = body.querySelector('#fst-tab-body');
  const showTab = (key) => {
    active = key;
    body.querySelectorAll('[data-stab]').forEach((b) => b.classList.toggle('active', b.dataset.stab === key));
    if (key === 'profile') renderProfile(tabBody, access, student, { years, terms, activeYear, activeTerm });
    else if (key === 'collections') viewFinanceCollections(tabBody, access, { studentId: student.id, studentName: student.full_name });
    else renderStatement(tabBody, student, activeYear, activeTerm);
  };
  body.querySelectorAll('[data-stab]').forEach((b) => b.onclick = () => showTab(b.dataset.stab));
  showTab(active);
}

async function renderProfile(root, access, student, ctx) {
  root.innerHTML = loader();
  const [routeRes, obRes, invRes, voteHeadsRes, routesRes] = await Promise.all([
    ctx.activeYear && ctx.activeTerm ? Db.finance.routes.forStudent(student.id, ctx.activeYear.id, ctx.activeTerm.id) : Promise.resolve({ ok: true, data: null }),
    ctx.activeYear ? Db.finance.students.openingBalance(student.id, ctx.activeYear.id) : Promise.resolve({ ok: true, data: null }),
    Db.finance.invoices.forStudent(student.id),
    Db.finance.voteHeads.list(),
    Db.finance.routes.list()
  ]);
  const route = routeRes.ok ? routeRes.data : null;
  const routeName = route && routesRes.ok ? (routesRes.data.find((r) => r.id === route.route_id) || {}).name : null;
  const opening = obRes.ok ? obRes.data : null;
  const invoices = invRes.ok ? invRes.data : [];
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  const currentInvoice = invoices.find((i) => i.academic_year_id === (ctx.activeYear && ctx.activeYear.id) && i.term_id === (ctx.activeTerm && ctx.activeTerm.id));

  root.innerHTML = `
    <div class="grid2">
      <div class="card pad">
        <h3 style="margin-top:0">Guardian</h3>
        <p class="muted">${esc(student.guardian_name || '—')}<br>${esc(student.guardian_contact || '—')}</p>
        <h3>Transport</h3>
        <p class="muted">${routeName ? `${esc(routeName)} (${esc(route.direction === 'two_way' ? 'Two-way' : 'One-way')})` : 'No route assigned this term.'}</p>
        ${access.canManage ? '<button class="btn secondary sm" id="fst-route">Assign / Correct Route</button>' : ''}
      </div>
      <div class="card pad">
        <h3 style="margin-top:0">Opening Balance (${esc(ctx.activeYear ? ctx.activeYear.name : '')})</h3>
        <p class="muted">KES ${Number(opening ? opening.amount : 0).toLocaleString()}</p>
        ${access.canManage ? '<button class="btn secondary sm" id="fst-opening">Set Opening Balance</button>' : ''}
        <h3>SMS Reminder</h3>
        ${access.canCollect ? '<button class="btn secondary sm" id="fst-sms">Send Balance Reminder</button>' : '<p class="muted">—</p>'}
      </div>
    </div>
    ${access.canManage ? `<div class="card pad" style="margin-top:14px">
      <h3 style="margin-top:0">Debit / Credit Notes</h3>
      <button class="btn secondary sm" id="fst-debit">+ Issue Debit Note</button>
      <button class="btn secondary sm" id="fst-credit">+ Issue Credit Note</button>
    </div>` : ''}
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3>This Term's Invoice</h3></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Vote Head</th><th>Description</th><th class="num">Amount</th></tr></thead>
        <tbody>${((currentInvoice && currentInvoice.finance_invoice_items) || []).map((it) => `<tr>
          <td>${esc(it.finance_vote_heads ? it.finance_vote_heads.name : '')}</td><td>${esc(it.description || '')}</td><td class="num">${Number(it.amount || 0).toLocaleString()}</td>
        </tr>`).join('') || '<tr><td colspan="3" class="muted">No invoice for the current term yet.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;

  if (access.canManage) {
    root.querySelector('#fst-route').onclick = () => openRouteModal(root, access, student, ctx, routesRes.ok ? routesRes.data : [], route);
    root.querySelector('#fst-opening').onclick = () => openOpeningBalanceModal(root, access, student, ctx, opening);
    root.querySelector('#fst-debit').onclick = () => renderIssueNoteModal({
      kind: 'debit', student, voteHeads, academicYearId: ctx.activeYear && ctx.activeYear.id, termId: ctx.activeTerm && ctx.activeTerm.id,
      onSaved: () => renderProfile(root, access, student, ctx)
    });
    root.querySelector('#fst-credit').onclick = () => renderIssueNoteModal({
      kind: 'credit', student, voteHeads, academicYearId: ctx.activeYear && ctx.activeYear.id, termId: ctx.activeTerm && ctx.activeTerm.id,
      onSaved: () => renderProfile(root, access, student, ctx)
    });
  }
  const smsBtn = root.querySelector('#fst-sms');
  if (smsBtn) smsBtn.onclick = async () => {
    const balRes = await Db.finance.students.balance(student.id);
    const balance = balRes.ok ? Number(balRes.data.balance || 0) : 0;
    const body_ = `Dear parent, kindly note that ${student.full_name}'s current fee balance is KES ${balance.toLocaleString()}. Thank you.`;
    const res = await Db.messaging.send({ scope: 'individual_student', student_id: student.id, body: body_ });
    toast(res.ok ? 'Reminder sent.' : res.message, res.ok ? 'ok' : 'err');
  };
}

function openRouteModal(root, access, student, ctx, routes, existing) {
  modal({
    title: 'Assign / Correct Transport Route',
    body: `
      <div class="field"><label>Route</label><select id="rt-route">${options(routes.filter((r) => r.active !== false), 'id', 'name', existing ? existing.route_id : '')}</select></div>
      <div class="field"><label>Direction</label><select id="rt-direction">
        <option value="one_way" ${existing && existing.direction === 'one_way' ? 'selected' : ''}>One-way</option>
        <option value="two_way" ${!existing || existing.direction === 'two_way' ? 'selected' : ''}>Two-way</option>
      </select></div>
      <p class="hint">This updates the transport line on the student's current-term invoice — no new invoice document is created.</p>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const routeId = document.getElementById('rt-route').value;
      const direction = document.getElementById('rt-direction').value;
      if (!routeId) { toast('Choose a route.', 'err'); return; }
      const res = await Db.finance.routes.assign(student.id, routeId, direction, ctx.activeYear && ctx.activeYear.id, ctx.activeTerm && ctx.activeTerm.id);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Route assigned.', 'ok');
      renderProfile(root, access, student, ctx);
    }
  });
}

function openOpeningBalanceModal(root, access, student, ctx, existing) {
  modal({
    title: 'Set Opening Balance',
    body: `
      <p class="hint" style="margin-top:0">For ${esc(ctx.activeYear ? ctx.activeYear.name : '')}. A positive amount is owed by the student; a negative amount is a credit.</p>
      <div class="field"><label>Amount (KES)</label><input id="ob-amount" type="number" step="0.01" value="${existing ? existing.amount : ''}"></div>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const amount = document.getElementById('ob-amount').value;
      if (amount === '') { toast('Enter an amount.', 'err'); return; }
      const res = await Db.finance.students.bulkOpeningBalances([{ student_id: student.id, amount }], ctx.activeYear && ctx.activeYear.id);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Opening balance saved.', 'ok');
      renderProfile(root, access, student, ctx);
    }
  });
}

async function renderStatement(root, student, activeYear, activeTerm) {
  root.innerHTML = loader();
  const [invRes, dnRes, cnRes, colRes, obRes] = await Promise.all([
    Db.finance.invoices.forStudent(student.id),
    Db.finance.debitNotes.forStudent(student.id),
    Db.finance.creditNotes.forStudent(student.id),
    Db.finance.collections.list({ student_id: student.id, limit: 500 }),
    activeYear ? Db.finance.students.openingBalance(student.id, activeYear.id) : Promise.resolve({ ok: true, data: null })
  ]);
  const invoiceItems = (invRes.ok ? invRes.data : []).flatMap((inv) => inv.finance_invoice_items || []);
  const rows = buildStatement({
    openingBalance: obRes.ok ? obRes.data : null,
    invoiceItems, debitNotes: dnRes.ok ? dnRes.data : [], creditNotes: cnRes.ok ? cnRes.data : [], collections: colRes.ok ? colRes.data : []
  });
  const schoolName = (state.settings && state.settings.school_name) || 'Shule';
  root.innerHTML = `
    <div class="page-head no-print"><div></div>${printOptionsHtml('fss', 'portrait')}</div>
    <div class="card print-grid" id="fss-sheet">
      <div class="card-b">
        <h2 style="margin:0">${esc(schoolName)}</h2>
        <p style="margin:2px 0 12px">Statement of Account — ${esc(student.full_name)} (${esc(student.admission_no)})</p>
        <div class="fin-statement"><table>
          <thead><tr><th>Date</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${r.date ? new Date(r.date).toLocaleDateString() : ''}</td><td>${esc(r.description)}</td>
            <td class="num">${r.debit ? Number(r.debit).toLocaleString() : ''}</td><td class="num">${r.credit ? Number(r.credit).toLocaleString() : ''}</td>
            <td class="num">${Number(r.balance).toLocaleString()}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No transactions yet.</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>
  `;
  wirePrintOptions(root.querySelector('#fss-sheet'), 'fss', `Statement — ${student.full_name}`);
}
