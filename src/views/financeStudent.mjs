/**
 * financeStudent.mjs — brief §Student Search & Statement: search a student,
 * then Profile / Collections / Statement tabs, plus the entry points for
 * issuing a debit/credit note, assigning/correcting a transport route,
 * setting an opening balance, and sending an SMS reminder — all with the
 * student's own balance visible for context. Deliberately excludes Pocket
 * Money / Pledges per the brief.
 */
import { esc, options, toast, modal, closeModal, loader, printOptionsHtml, wirePrintOptions, state, confirmAction } from '../app.js';
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
        openStudentProfile(body, access, student);
      });
    }, 250);
  };
}

export async function openStudentProfile(body, access, student) {
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
      <div style="text-align:right">
        <div class="muted" style="font-size:12px">Balance</div>
        <div style="font-size:20px;font-weight:700;color:${Number(bal.balance || 0) > 0 ? 'var(--danger)' : 'var(--ok)'}">KES ${Number(bal.balance || 0).toLocaleString()}</div>
        ${access.canManage && Number(bal.balance || 0) < 0 ? '<button class="btn ghost sm" id="fst-transfer-ovp" style="margin-top:4px">↔️ Transfer Overpayment</button>' : ''}
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

  const transferBtn = body.querySelector('#fst-transfer-ovp');
  if (transferBtn) transferBtn.onclick = () => openTransferOverpaymentModal(student, bal, { years, terms, activeYear, activeTerm }, () => openStudentProfile(body, access, student));
}

/**
 * Next Sprint 2 §13: move a chosen amount of this student's CURRENT
 * overpayment/credit to another student (e.g. siblings) — only shown when
 * the balance is already negative (i.e. there's something to move). The
 * destination student is picked via the same search-as-you-type pattern
 * used on the main Finance search screen. Amount is capped client-side to
 * the visible overpayment as a convenience — the RPC re-checks it
 * server-side regardless, since the balance can change between opening
 * this modal and clicking Save.
 */
function openTransferOverpaymentModal(student, bal, ctx, onDone) {
  const overpayment = Math.abs(Number(bal.balance || 0));
  let toStudent = null;
  modal({
    title: 'Transfer Overpayment',
    body: `
      <p class="hint" style="margin-top:0">${esc(student.full_name)} currently has an overpayment of <strong>KES ${overpayment.toLocaleString()}</strong>. Move some or all of it to another student's balance (e.g. a sibling).</p>
      <div class="field"><label>Transfer to</label>
        <input id="tovp-q" placeholder="🔍 Search by admission no. or name…" autocomplete="off">
        <div id="tovp-results" class="search-results"></div>
        <div id="tovp-selected" class="muted" style="margin-top:6px"></div>
      </div>
      <div class="field"><label>Amount (KES)</label><input id="tovp-amount" type="number" step="0.01" max="${overpayment}" value="${overpayment}"></div>
      <div class="field"><label>Reason (optional)</label><input id="tovp-reason" placeholder="e.g. sibling top-up"></div>
    `,
    okLabel: 'Transfer',
    onOk: async () => {
      if (!toStudent) { toast('Search for and select the student to transfer to.', 'err'); return; }
      const amount = document.getElementById('tovp-amount').value;
      if (!amount || Number(amount) <= 0) { toast('Enter a valid amount.', 'err'); return; }
      if (Number(amount) > overpayment) { toast(`Only KES ${overpayment.toLocaleString()} is available to transfer.`, 'err'); return; }
      const reason = document.getElementById('tovp-reason').value.trim();
      const res = await Db.finance.students.transferOverpayment(
        student.id, toStudent.id, amount, ctx.activeYear && ctx.activeYear.id, ctx.activeTerm && ctx.activeTerm.id, reason
      );
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`KES ${Number(amount).toLocaleString()} transferred to ${toStudent.full_name}.`, 'ok');
      onDone();
    },
    onOpen: () => {
      const qEl = document.getElementById('tovp-q');
      const resultsEl = document.getElementById('tovp-results');
      const selectedEl = document.getElementById('tovp-selected');
      let t = null;
      qEl.oninput = () => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const q = qEl.value.trim();
          if (q.length < 2) { resultsEl.innerHTML = ''; return; }
          const r = await Db.finance.students.search(q);
          const list = (r.ok ? r.data : []).filter((s) => s.id !== student.id);
          resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('') || '<div class="muted" style="padding:6px">No matches.</div>';
          resultsEl.querySelectorAll('[data-id]').forEach((h) => h.onclick = () => {
            toStudent = list.find((s) => s.id === h.dataset.id);
            resultsEl.innerHTML = '';
            qEl.value = '';
            selectedEl.textContent = `Selected: ${toStudent.full_name} (${toStudent.admission_no})`;
          });
        }, 250);
      };
    }
  });
}

async function renderProfile(root, access, student, ctx) {
  root.innerHTML = loader();
  const [routeRes, obRes, invRes, voteHeadsRes, routesRes, dnRes, cnRes] = await Promise.all([
    ctx.activeYear && ctx.activeTerm ? Db.finance.routes.forStudent(student.id, ctx.activeYear.id, ctx.activeTerm.id) : Promise.resolve({ ok: true, data: null }),
    ctx.activeYear ? Db.finance.students.openingBalance(student.id, ctx.activeYear.id) : Promise.resolve({ ok: true, data: null }),
    Db.finance.invoices.forStudent(student.id),
    Db.finance.voteHeads.list(),
    Db.finance.routes.list(),
    // Next Sprint 2 §12: these existed in the database all along (each note
    // has its own created_at/created_by) — the actual gap was that nothing
    // on this screen ever showed them. See the table rendered below.
    Db.finance.debitNotes.forStudent(student.id),
    Db.finance.creditNotes.forStudent(student.id)
  ]);
  const route = routeRes.ok ? routeRes.data : null;
  const routeName = route && routesRes.ok ? (routesRes.data.find((r) => r.id === route.route_id) || {}).name : null;
  const opening = obRes.ok ? obRes.data : null;
  const invoices = invRes.ok ? invRes.data : [];
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  const notesRows = [
    ...(dnRes.ok ? dnRes.data : []).map((n) => ({ ...n, kind: 'debit' })),
    ...(cnRes.ok ? cnRes.data : []).map((n) => ({ ...n, kind: 'credit' }))
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
    ${access.canManage ? `<div class="card" style="margin-top:14px">
      <div class="card-h">
        <h3>Debit / Credit Notes</h3>
        <div class="spacer"></div>
        <button class="btn secondary sm" id="fst-debit">+ Issue Debit Note</button>
        <button class="btn secondary sm" id="fst-credit">+ Issue Credit Note</button>
      </div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Type</th><th>Vote Head</th><th>Reason</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${notesRows.map((n) => `<tr${n.reversed_at ? ' style="opacity:.55"' : ''}>
          <td>${n.created_at ? new Date(n.created_at).toLocaleDateString() : ''}</td>
          <td><span class="badge ${n.kind === 'debit' ? 'red' : 'green'}">${n.kind === 'debit' ? 'Debit' : 'Credit'}</span></td>
          <td>${esc(n.finance_vote_heads ? n.finance_vote_heads.name : '')}</td>
          <td>${esc(n.reason || '—')}</td>
          <td class="num">${Number(n.amount || 0).toLocaleString()}</td>
          <td>${n.reversed_at
            ? '<span class="muted" style="font-size:12px">↩️ Reversed</span>'
            : (n.reverses_debit_note_id || n.reverses_credit_note_id)
              ? ''
              : `<button class="btn ghost sm" data-reverse-note="${n.id}" data-reverse-kind="${n.kind}">↩️ Reverse</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="muted">No debit or credit notes yet.</td></tr>'}</tbody>
      </table></div>
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
    // Next Sprint 2 §12: reverse a wrongly-entered note. Inserts a new,
    // equal-and-opposite note rather than deleting anything — see
    // finance.mjs's reverse() and the migration it calls for why. Goes
    // through confirmAction(), same as every other reverse/delete-style
    // action in the app — its modal's own OK button already shows "please
    // wait" while this runs (see withBusy() in app.js), so no separate
    // busy-state wrapper is needed here.
    root.querySelectorAll('[data-reverse-note]').forEach((b) => b.onclick = () => confirmAction(
      'Reverse this note? This adds a matching opposite entry to correct the balance — the original stays on record, marked as reversed.',
      async () => {
        const api = b.dataset.reverseKind === 'debit' ? Db.finance.debitNotes : Db.finance.creditNotes;
        const res = await api.reverse(b.dataset.reverseNote);
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast('Note reversed.', 'ok');
        renderProfile(root, access, student, ctx);
      }
    ));
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
