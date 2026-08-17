/**
 * financeInvoicing.mjs — brief §Invoicing: Fee Structures (set up per term,
 * tagged to classes, showing amount invoiced so far), the resulting
 * Invoices (generated per fee structure), and Debit/Credit Notes.
 * Deliberately excludes Discounts and Templates sub-modules per the brief.
 */
import { esc, options, toast, modal, closeModal, confirmAction, loader, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const SUB_TABS = [
  { key: 'structures', label: 'Fee Structures' },
  { key: 'debit', label: 'Debit Notes' },
  { key: 'credit', label: 'Credit Notes' }
];

export async function viewFinanceInvoicing(root, access) {
  let active = 'structures';
  root.innerHTML = `
    <div class="tabs" style="max-width:460px">
      ${SUB_TABS.map((t) => `<button data-subtab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="fi-body" style="margin-top:12px">${loader()}</div>
  `;
  const body = root.querySelector('#fi-body');
  const show = (key) => {
    active = key;
    root.querySelectorAll('[data-subtab]').forEach((b) => b.classList.toggle('active', b.dataset.subtab === key));
    if (key === 'structures') renderStructures(body, access);
    else renderNotes(body, access, key);
  };
  root.querySelectorAll('[data-subtab]').forEach((b) => b.onclick = () => show(b.dataset.subtab));
  show(active);
}

/* --------------------------------------------------------- fee structures --- */
async function renderStructures(root, access) {
  root.innerHTML = loader();
  const [structRes, yearsRes, termsRes, classesRes, voteHeadsRes] = await Promise.all([
    Db.finance.feeStructures.list(), Db.academicYears.list(), Db.terms.list(), Db.classes.list(), Db.finance.voteHeads.list()
  ]);
  const structures = structRes.ok ? structRes.data : [];
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  const classNameById = {}; classes.forEach((c) => { classNameById[c.id] = c.name; });
  const yearNameById = {}; years.forEach((y) => { yearNameById[y.id] = y.name; });
  const termNameById = {}; terms.forEach((t) => { termNameById[t.id] = t.name; });

  root.innerHTML = `
    <div class="page-head"><div><p class="hint" style="margin:0">A fee structure carries a flat amount per vote head, applied uniformly to every class it's tagged to.</p></div>
      ${access.canManage ? '<button class="btn" id="fi-add-structure">+ Add Fee Structure</button>' : ''}
    </div>
    <div class="card"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Year / Term</th><th>Classes</th><th class="num">Total / Class</th><th></th></tr></thead>
      <tbody>${structures.map((s) => {
        const total = (s.finance_fee_structure_items || []).reduce((a, it) => a + Number(it.amount || 0), 0);
        const classNames = (s.finance_fee_structure_classes || []).map((c) => classNameById[c.class_id] || '').join(', ');
        return `<tr>
          <td>${esc(s.name)}</td>
          <td>${esc(yearNameById[s.academic_year_id] || '')} / ${esc(termNameById[s.term_id] || '')}</td>
          <td>${esc(classNames)}</td>
          <td class="num">${total.toLocaleString()}</td>
          <td>
            ${access.canManage ? `<button class="btn secondary sm" data-edit="${s.id}">Edit</button>
            <button class="btn secondary sm" data-generate="${s.id}">Invoice Now</button>` : ''}
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="5" class="muted">No fee structures yet.</td></tr>'}</tbody>
    </table></div></div>
  `;

  if (access.canManage) {
    root.querySelector('#fi-add-structure').onclick = () => openStructureModal(root, access, { years, terms, classes, voteHeads });
    root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
      const s = structures.find((x) => x.id === b.dataset.edit);
      openStructureModal(root, access, { years, terms, classes, voteHeads }, s);
    });
    root.querySelectorAll('[data-generate]').forEach((b) => b.onclick = () => withBusy(b, async () => {
      const res = await Db.finance.feeStructures.generateInvoices(b.dataset.generate);
      if (res.ok) toast(`Invoiced ${res.data.invoiced_count} student(s).`, 'ok');
      else toast(res.message, 'err');
    }, 'Invoicing…'));
  }
}

function openStructureModal(root, access, { years, terms, classes, voteHeads }, existing) {
  const selectedClassIds = existing ? (existing.finance_fee_structure_classes || []).map((c) => c.class_id) : [];
  const itemsByVoteHead = {};
  if (existing) (existing.finance_fee_structure_items || []).forEach((it) => { itemsByVoteHead[it.vote_head_id] = it.amount; });

  modal({
    title: existing ? 'Edit Fee Structure' : 'Add Fee Structure',
    wide: true,
    body: `
      <div class="field"><label>Name</label><input id="fs-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Grade 1 & 2 Term 1"></div>
      <div class="grid2">
        <div class="field"><label>Academic Year</label><select id="fs-year">${options(years, 'id', 'name', existing ? existing.academic_year_id : '')}</select></div>
        <div class="field"><label>Term</label><select id="fs-term">${options(terms, 'id', 'name', existing ? existing.term_id : '')}</select></div>
      </div>
      <div class="field"><label>Applies to which classes?</label>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">
          ${classes.map((c) => `<label class="chk" style="display:flex;align-items:center;gap:6px;margin:0">
            <input type="checkbox" class="fs-class" value="${c.id}" ${selectedClassIds.indexOf(c.id) !== -1 ? 'checked' : ''}> ${esc(c.name)}
          </label>`).join('')}
        </div>
      </div>
      <div class="field"><label>Amount per vote head</label>
        <div class="table-wrap"><table class="data"><thead><tr><th>Vote Head</th><th class="num">Amount</th></tr></thead>
          <tbody>${voteHeads.filter((v) => v.active !== false).map((v) => `<tr>
            <td>${esc(v.name)}</td>
            <td class="num"><input type="number" min="0" step="1" class="fs-amount" data-vh="${v.id}" value="${itemsByVoteHead[v.id] || ''}" style="width:110px"></td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
    `,
    okLabel: 'Save',
    onOk: async () => {
      const classIds = [...document.querySelectorAll('.fs-class:checked')].map((c) => c.value);
      const items = [...document.querySelectorAll('.fs-amount')].map((i) => ({ vote_head_id: i.dataset.vh, amount: i.value })).filter((it) => it.amount !== '');
      const res = await Db.finance.feeStructures.save({
        id: existing ? existing.id : undefined,
        name: document.getElementById('fs-name').value,
        academic_year_id: document.getElementById('fs-year').value,
        term_id: document.getElementById('fs-term').value,
        class_ids: classIds, items
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast('Fee structure saved.', 'ok');
      renderStructures(root, access);
    }
  });
}

/* --------------------------------------------------------- debit/credit notes --- */
async function renderNotes(root, access, kind) {
  root.innerHTML = loader();
  const [yearsRes, termsRes, voteHeadsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list(), Db.finance.voteHeads.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  const isDebit = kind === 'debit';

  root.innerHTML = `
    <div class="page-head"><div><p class="hint" style="margin:0">${isDebit
      ? 'Increase a specific student\'s fees (e.g. an added charge) without changing the fee structure for the rest of the class.'
      : 'Reduce a specific student\'s fees (e.g. a correction or a sibling discount) without changing the fee structure for the rest of the class.'}</p></div>
      ${access.canManage ? `<button class="btn" id="fn-add">+ ${isDebit ? 'Issue Debit Note' : 'Issue Credit Note'}</button>` : ''}
    </div>
    <div class="card pad">
      <p class="hint">Search for the student under <b>Student Search</b> to issue a note against them directly from their profile — this is the quicker path when you already know who it's for.</p>
    </div>
  `;

  if (access.canManage) {
    root.querySelector('#fn-add').onclick = () => {
      modal({
        title: isDebit ? 'Issue Debit Note' : 'Issue Credit Note',
        body: `
          <p class="hint" style="margin-top:0">Search for the student under <b>Student Search</b> instead — this opens the same form from their profile, where their current balance is already visible for context.</p>
        `,
        footer: false
      });
    };
  }
  // Keep a reference so financeStudent.mjs's issue-note flow (invoked from
  // a student's profile) reuses this exact pair of RPC calls — see
  // renderIssueNoteModal exported below.
  void voteHeads; void activeYear; void activeTerm;
}

/** Shared modal used by financeStudent.mjs's profile screen to issue a
 *  debit/credit note against ONE specific student — kept here so the
 *  Invoicing tab and the Student profile never diverge on how a note gets
 *  created. */
export function renderIssueNoteModal({ kind, student, voteHeads, academicYearId, termId, onSaved }) {
  const isDebit = kind === 'debit';
  modal({
    title: `${isDebit ? 'Issue Debit Note' : 'Issue Credit Note'} — ${student.full_name}`,
    body: `
      <div class="field"><label>Vote Head</label><select id="note-vh">${options(voteHeads, 'id', 'name', '')}</select></div>
      <div class="field"><label>Amount (KES)</label><input id="note-amount" type="number" min="0.01" step="0.01"></div>
      <div class="field"><label>Reason</label><input id="note-reason" placeholder="${isDebit ? 'e.g. Lost textbook' : 'e.g. Sibling discount'}"></div>
    `,
    okLabel: 'Issue',
    onOk: async () => {
      const voteHeadId = document.getElementById('note-vh').value;
      const amount = document.getElementById('note-amount').value;
      const reason = document.getElementById('note-reason').value;
      if (!voteHeadId) { toast('Choose a vote head.', 'err'); return; }
      if (!amount || Number(amount) <= 0) { toast('Enter an amount greater than zero.', 'err'); return; }
      const res = isDebit
        ? await Db.finance.debitNotes.issue(student.id, voteHeadId, amount, reason, academicYearId, termId)
        : await Db.finance.creditNotes.issue(student.id, voteHeadId, amount, reason, academicYearId, termId);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`${isDebit ? 'Debit' : 'Credit'} note issued.`, 'ok');
      if (onSaved) onSaved();
    }
  });
}
