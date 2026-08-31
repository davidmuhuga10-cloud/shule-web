/**
 * financeInvoicing.mjs — brief §Invoicing: Fee Structures (set up per term,
 * tagged to classes, showing amount invoiced so far), the resulting
 * Invoices (generated per fee structure), and Debit/Credit Notes.
 * Deliberately excludes Discounts and Templates sub-modules per the brief.
 */
import { esc, options, toast, modal, closeModal, confirmAction, loader, withBusy, printOptionsHtml, wirePrintOptions } from '../app.js';
import { Db } from '../lib/api/index.mjs';

/** Round 2 §7 — every vote-head <select> in Invoicing gets a trailing
 *  "+ Add a new vote head…" option instead of being locked to whatever the
 *  system shipped with (the brief's own bug callout: "don't force them to
 *  work only with whatever already exists"). voteHeadSelectHtml/
 *  wireVoteHeadSelect are shared by the fee-structure modal and the
 *  debit/credit note form below so the two never drift on how this works. */
function voteHeadSelectHtml(id, voteHeads, selected) {
  return `<select id="${id}">${options(voteHeads.filter((v) => v.active !== false), 'id', 'name', selected)}<option value="__new__">+ Add a new vote head…</option></select>`;
}
function wireVoteHeadSelect(selectEl, voteHeads, onCreated) {
  let lastValue = selectEl.value;
  selectEl.onchange = async () => {
    if (selectEl.value !== '__new__') { lastValue = selectEl.value; return; }
    const name = window.prompt('Name for the new vote head (e.g. "Activity Fee"):');
    if (!name || !name.trim()) { selectEl.value = lastValue; return; }
    const res = await Db.finance.voteHeads.save({ name: name.trim() });
    if (!res.ok) { toast(res.message, 'err'); selectEl.value = lastValue; return; }
    voteHeads.push(res.data);
    toast(`Vote head "${res.data.name}" added.`, 'ok');
    onCreated(res.data);
  };
}

// Design standard brief item 3: "Reports" is gone from here — reporting
// belongs in the dedicated Reports module, not duplicated under Invoicing
// too. renderInvoicingReports() itself is left defined below (unused for
// now) rather than deleted outright, in case any of its report logic is
// worth folding into the real Reports module later.
const SUB_TABS = [
  { key: 'structures', label: 'Fee Structures' },
  { key: 'debit', label: 'Debit Notes' },
  { key: 'credit', label: 'Credit Notes' }
];

export async function viewFinanceInvoicing(root, access) {
  let active = 'structures';
  root.innerHTML = `
    <div class="fin-tabs">
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
    <div class="fin-toolbar no-print"><p class="hint" style="margin:0">A fee structure carries a flat amount per vote head, applied uniformly to every class it's tagged to.</p>
      <div class="spacer"></div>
      <div class="fin-report-actions">${printOptionsHtml('fis', 'landscape')}</div>
      ${access.canManage ? '<button class="btn" id="fi-add-structure">+ Add Fee Structure</button>' : ''}
    </div>
    <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Year / Term</th><th>Classes</th><th class="num">Total / Class</th><th class="no-print"></th></tr></thead>
      <tbody>${structures.map((s) => {
        const total = (s.finance_fee_structure_items || []).reduce((a, it) => a + Number(it.amount || 0), 0);
        const classNames = (s.finance_fee_structure_classes || []).map((c) => classNameById[c.class_id] || '').join(', ');
        return `<tr>
          <td>${esc(s.name)}</td>
          <td>${esc(yearNameById[s.academic_year_id] || '')} / ${esc(termNameById[s.term_id] || '')}</td>
          <td>${esc(classNames)}</td>
          <td class="num">${total.toLocaleString()}</td>
          <td class="no-print">
            ${access.canManage ? `<button class="btn secondary sm" data-edit="${s.id}">Edit</button>
            <button class="btn secondary sm" data-generate="${s.id}">Invoice Now</button>
            <button class="btn secondary sm" data-uninvoice="${s.id}">Un-invoice</button>` : ''}
          </td>
        </tr>`;
      }).join('') || '<tr><td colspan="5" class="muted">No fee structures yet.</td></tr>'}</tbody>
    </table></div></div>
  `;
  wirePrintOptions(root, 'fis', 'Fee Structures');

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
    // Round 2 §10 (BUG fix) — until now there was no way back once a
    // structure had been invoiced by mistake. Safe to run even after
    // payments were recorded against it (see finance_uninvoice_structure's
    // own comment in migrations/0032 for why that doesn't corrupt anything).
    root.querySelectorAll('[data-uninvoice]').forEach((b) => b.onclick = () => {
      const s = structures.find((x) => x.id === b.dataset.uninvoice);
      confirmAction(`Remove "${s.name}"'s charges from every invoice they were added to? This does not affect payments already recorded.`, () => withBusy(b, async () => {
        const res = await Db.finance.feeStructures.uninvoice(b.dataset.uninvoice);
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(`Un-invoiced ${res.data.affected_students} student(s) (${res.data.removed_items} line item(s) removed).`, 'ok');
      }, 'Un-invoicing…'), true);
    });
  }
}

function openStructureModal(root, access, { years, terms, classes, voteHeads }, existing) {
  const selectedClassIds = existing ? (existing.finance_fee_structure_classes || []).map((c) => c.class_id) : [];
  const itemsByVoteHead = {};
  if (existing) (existing.finance_fee_structure_items || []).forEach((it) => { itemsByVoteHead[it.vote_head_id] = it.amount; });

  const renderItemsRows = () => voteHeads.filter((v) => v.active !== false).map((v) => `<tr>
    <td>${esc(v.name)}</td>
    <td class="num"><input type="number" min="0" step="1" class="fs-amount" data-vh="${v.id}" value="${itemsByVoteHead[v.id] || ''}" style="width:110px"></td>
  </tr>`).join('');

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
          <tbody id="fs-items-body">${renderItemsRows()}</tbody>
        </table></div>
        <button type="button" class="btn secondary sm" id="fs-add-votehead" style="margin-top:8px">+ Add a new vote head</button>
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

  // Round 2 §7 — a fee structure isn't limited to whatever vote heads the
  // system shipped with; this creates a real finance_vote_heads row (same
  // as Settings would) and drops a new amount row in for it immediately.
  document.getElementById('fs-add-votehead').onclick = async () => {
    const name = window.prompt('Name for the new vote head (e.g. "Activity Fee"):');
    if (!name || !name.trim()) return;
    const res = await Db.finance.voteHeads.save({ name: name.trim() });
    if (!res.ok) { toast(res.message, 'err'); return; }
    voteHeads.push(res.data);
    toast(`Vote head "${res.data.name}" added.`, 'ok');
    document.getElementById('fs-items-body').innerHTML = renderItemsRows();
  };
}

/* --------------------------------------------------------- debit/credit notes --- */
/** Round 2 §3 (BUG fix) — this used to redirect the admin to Student Search
 *  entirely, breaking the flow. Rebuilt as one inline screen with live
 *  type-ahead: as the admin types, matches filter live; clicking one
 *  selects it and shows their current balance right there, no navigation.
 *  Target type is Zeraki-inspired (Active Student / Class / Stream) minus
 *  "Graduated Student" (not needed) and minus Group/Upload Excel/Transport
 *  Routes — those don't map onto a single-vote-head-per-note RPC without
 *  real new complexity the brief didn't ask this bug fix to take on; Class/
 *  Stream cover the realistic "apply the same note to everyone in X" case
 *  by looping the same one-student RPC brief §Invoicing already defines. */
const NOTE_TARGETS = [
  { key: 'student', label: 'Active Student' },
  { key: 'class', label: 'Class' },
  { key: 'stream', label: 'Stream' }
];

async function renderNotes(root, access, kind) {
  root.innerHTML = loader();
  const [yearsRes, termsRes, voteHeadsRes, classesRes] = await Promise.all([
    Db.academicYears.list(), Db.terms.list(), Db.finance.voteHeads.list(), Db.classes.list()
  ]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];

  if (!access.canManage) {
    root.innerHTML = `<div class="card pad">You don't have permission to issue notes — ask your school admin for Finance access.</div>`;
    return;
  }

  await loadNotes(root, kind, { years, terms, voteHeads, classes }, {
    target: 'student', academic_year_id: activeYear ? activeYear.id : '', term_id: activeTerm ? activeTerm.id : '',
    student: null, class_id: '', stream_id: ''
  });
}

async function loadNotes(root, kind, ctx, sel) {
  const isDebit = kind === 'debit';
  const { years, terms, voteHeads, classes } = ctx;

  root.innerHTML = `
    <div class="card pad">
      <p class="hint" style="margin-top:0">${isDebit
        ? 'Increase fees (e.g. an added charge) without changing the fee structure for the rest of the class.'
        : 'Reduce fees (e.g. a correction or a sibling discount) without changing the fee structure for the rest of the class.'}</p>

      <div class="field"><label>Apply to</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px">
          ${NOTE_TARGETS.map((t) => `<label class="chk" style="display:flex;align-items:center;gap:6px;margin:0">
            <input type="radio" name="fn-target" value="${t.key}" ${sel.target === t.key ? 'checked' : ''}> ${t.label}
          </label>`).join('')}
        </div>
      </div>

      <div class="grid2">
        <div class="field"><label>Academic Year *</label><select id="fn-year">${options(years, 'id', 'name', sel.academic_year_id)}</select></div>
        <div class="field"><label>Term *</label><select id="fn-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id)}</select></div>
      </div>

      <div id="fn-target-body"></div>

      <div class="grid2" style="margin-top:10px">
        <div class="field"><label>Vote Head</label>${voteHeadSelectHtml('fn-vh', voteHeads, '')}</div>
        <div class="field"><label>Amount (KES)</label><input id="fn-amount" type="number" min="0.01" step="0.01"></div>
      </div>
      <div class="field"><label>Reason</label><input id="fn-reason" placeholder="${isDebit ? 'e.g. Lost textbook' : 'e.g. Sibling discount'}"></div>

      <button class="btn" id="fn-submit" style="margin-top:6px">${isDebit ? 'Issue Debit Note' : 'Issue Credit Note'}</button>
      <div id="fn-status" class="hint" style="margin-top:8px"></div>
    </div>
  `;

  function onNoteVoteHeadCreated(created) {
    root.querySelector('#fn-vh').outerHTML = voteHeadSelectHtml('fn-vh', voteHeads, created.id);
    wireVoteHeadSelect(root.querySelector('#fn-vh'), voteHeads, onNoteVoteHeadCreated);
  }
  wireVoteHeadSelect(root.querySelector('#fn-vh'), voteHeads, onNoteVoteHeadCreated);

  root.querySelectorAll('[name="fn-target"]').forEach((r) => r.onchange = () => loadNotes(root, kind, ctx, { ...sel, target: r.value }));
  root.querySelector('#fn-year').onchange = (e) => loadNotes(root, kind, ctx, { ...sel, academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#fn-term').onchange = (e) => loadNotes(root, kind, ctx, { ...sel, term_id: e.target.value });

  const targetBody = root.querySelector('#fn-target-body');
  if (sel.target === 'student') {
    targetBody.innerHTML = `
      <div class="field" style="position:relative"><label>Student</label>
        <input id="fn-student-q" placeholder="Type a name or admission no.…" autocomplete="off" value="${sel.student ? esc(sel.student.full_name) : ''}">
        <div id="fn-student-results" class="search-results"></div>
      </div>
      <div id="fn-student-balance"></div>
    `;
    const qEl = targetBody.querySelector('#fn-student-q');
    const resultsEl = targetBody.querySelector('#fn-student-results');
    let t = null;
    qEl.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = qEl.value.trim();
        if (!q.length) { resultsEl.innerHTML = ''; return; }
        const r = await Db.finance.students.search(q);
        const list = r.ok ? r.data : [];
        resultsEl.innerHTML = list.map((s) => `<div class="search-hit" data-id="${s.id}">${esc(s.full_name)} <span class="muted">${esc(s.admission_no)} · ${esc(s.classes ? s.classes.name : '')}</span></div>`).join('') || `<div class="muted" style="padding:6px">No student found matching "${esc(q)}".</div>`;
        resultsEl.querySelectorAll('[data-id]').forEach((h) => h.onclick = async () => {
          const student = list.find((s) => s.id === h.dataset.id);
          resultsEl.innerHTML = '';
          qEl.value = student.full_name;
          const balBody = targetBody.querySelector('#fn-student-balance');
          balBody.innerHTML = loader();
          const balRes = await Db.finance.students.balance(student.id);
          const balance = balRes.ok ? Number(balRes.data.balance || 0) : 0;
          balBody.innerHTML = `<div class="hint">Current balance for <b>${esc(student.full_name)}</b> (${esc(student.admission_no)}): <b>KES ${balance.toLocaleString()}</b></div>`;
          sel.student = student;
        });
      }, 250);
    };
    if (sel.student) {
      const balRes = await Db.finance.students.balance(sel.student.id);
      const balance = balRes.ok ? Number(balRes.data.balance || 0) : 0;
      targetBody.querySelector('#fn-student-balance').innerHTML = `<div class="hint">Current balance for <b>${esc(sel.student.full_name)}</b>: <b>KES ${balance.toLocaleString()}</b></div>`;
    }
  } else if (sel.target === 'class') {
    targetBody.innerHTML = `<div class="field"><label>Class</label><select id="fn-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
      <p class="hint">The same note is issued to every active student in this class.</p>`;
    targetBody.querySelector('#fn-class').onchange = (e) => { sel.class_id = e.target.value; };
  } else {
    targetBody.innerHTML = `<div class="field"><label>Class</label><select id="fn-class-for-stream">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
      <div class="field"><label>Stream</label><select id="fn-stream" disabled><option value="">Choose a class first</option></select></div>
      <p class="hint">The same note is issued to every active student in this stream.</p>`;
    const wireStreams = async (classId) => {
      const streamSelect = targetBody.querySelector('#fn-stream');
      if (!classId) { streamSelect.innerHTML = '<option value="">Choose a class first</option>'; streamSelect.disabled = true; return; }
      const sres = await Db.streams.list(classId);
      const streams = sres.ok ? sres.data : [];
      streamSelect.innerHTML = options(streams, 'id', 'name', sel.stream_id, 'Choose a stream');
      streamSelect.disabled = false;
      streamSelect.onchange = (e) => { sel.stream_id = e.target.value; };
    };
    targetBody.querySelector('#fn-class-for-stream').onchange = (e) => { sel.class_id = e.target.value; sel.stream_id = ''; wireStreams(e.target.value); };
    if (sel.class_id) await wireStreams(sel.class_id);
  }

  const statusEl = root.querySelector('#fn-status');
  root.querySelector('#fn-submit').onclick = async () => {
    const voteHeadId = root.querySelector('#fn-vh').value;
    const amount = root.querySelector('#fn-amount').value;
    const reason = root.querySelector('#fn-reason').value;
    const academicYearId = root.querySelector('#fn-year').value;
    const termId = root.querySelector('#fn-term').value;
    if (voteHeadId === '__new__' || !voteHeadId) { toast('Choose a vote head.', 'err'); return; }
    if (!amount || Number(amount) <= 0) { toast('Enter an amount greater than zero.', 'err'); return; }
    if (!academicYearId || !termId) { toast('Choose an academic year and term.', 'err'); return; }

    const issueOne = (studentId) => isDebit
      ? Db.finance.debitNotes.issue(studentId, voteHeadId, amount, reason, academicYearId, termId)
      : Db.finance.creditNotes.issue(studentId, voteHeadId, amount, reason, academicYearId, termId);

    const btn = root.querySelector('#fn-submit');
    btn.disabled = true;
    try {
      if (sel.target === 'student') {
        if (!sel.student) { toast('Search for and select a student first.', 'err'); return; }
        const res = await issueOne(sel.student.id);
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(`${isDebit ? 'Debit' : 'Credit'} note issued to ${sel.student.full_name}.`, 'ok');
      } else {
        const classId = sel.class_id;
        if (!classId) { toast('Choose a class.', 'err'); return; }
        const filters = { class_id: classId };
        if (sel.target === 'stream') {
          if (!sel.stream_id) { toast('Choose a stream.', 'err'); return; }
          filters.stream_id = sel.stream_id;
        }
        const studentsRes = await Db.students.list(filters);
        const students = studentsRes.ok ? studentsRes.data : [];
        if (!students.length) { toast('No active students match that selection.', 'err'); return; }
        statusEl.textContent = `Issuing to ${students.length} student(s)…`;
        let okCount = 0;
        for (const s of students) { const r = await issueOne(s.id); if (r.ok) okCount++; }
        toast(`${isDebit ? 'Debit' : 'Credit'} note issued to ${okCount}/${students.length} student(s).`, okCount === students.length ? 'ok' : 'warn');
      }
      root.querySelector('#fn-amount').value = '';
      root.querySelector('#fn-reason').value = '';
      statusEl.textContent = '';
    } finally {
      btn.disabled = false;
    }
  };
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
      <div class="field"><label>Vote Head</label>${voteHeadSelectHtml('note-vh', voteHeads, '')}</div>
      <div class="field"><label>Amount (KES)</label><input id="note-amount" type="number" min="0.01" step="0.01"></div>
      <div class="field"><label>Reason</label><input id="note-reason" placeholder="${isDebit ? 'e.g. Lost textbook' : 'e.g. Sibling discount'}"></div>
    `,
    okLabel: 'Issue',
    onOk: async () => {
      const voteHeadId = document.getElementById('note-vh').value;
      const amount = document.getElementById('note-amount').value;
      const reason = document.getElementById('note-reason').value;
      if (!voteHeadId || voteHeadId === '__new__') { toast('Choose a vote head.', 'err'); return; }
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
  function onNoteVoteHeadCreated(created) {
    document.getElementById('note-vh').outerHTML = voteHeadSelectHtml('note-vh', voteHeads, created.id);
    wireVoteHeadSelect(document.getElementById('note-vh'), voteHeads, onNoteVoteHeadCreated);
  }
  wireVoteHeadSelect(document.getElementById('note-vh'), voteHeads, onNoteVoteHeadCreated);
}

/* --------------------------------------------------------- invoicing reports --- */
/** Round 2 §9 — two of the sub-reports the brief names as examples:
 *  "students who haven't cleared Transport specifically" (any vote head
 *  works via finance_vote_head_student_balances, Transport is just the
 *  first one selected by default) and a printable class list showing each
 *  student's assigned transport route. */
const INVOICING_REPORT_KEYS = [
  { key: 'unpaid_votehead', label: "Who hasn't cleared a vote head" },
  { key: 'route_assignments', label: 'Class list — transport routes' }
];

async function renderInvoicingReports(root) {
  const [voteHeadsRes, yearsRes, termsRes] = await Promise.all([Db.finance.voteHeads.list(), Db.academicYears.list(), Db.terms.list()]);
  const voteHeads = voteHeadsRes.ok ? voteHeadsRes.data : [];
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  const transportVoteHead = voteHeads.find((v) => v.is_transport);

  root.innerHTML = `
    <div class="fin-tabs">${INVOICING_REPORT_KEYS.map((r, i) => `<button data-irtab="${r.key}" class="${i === 0 ? 'active' : ''}">${esc(r.label)}</button>`).join('')}</div>
    <div id="ir-body" style="margin-top:12px"></div>
  `;
  const body = root.querySelector('#ir-body');
  const show = (key) => {
    root.querySelectorAll('[data-irtab]').forEach((b) => b.classList.toggle('active', b.dataset.irtab === key));
    if (key === 'unpaid_votehead') renderUnpaidVoteHead(body, voteHeads, years, terms, { vote_head_id: transportVoteHead ? transportVoteHead.id : (voteHeads[0] ? voteHeads[0].id : ''), academic_year_id: activeYear ? activeYear.id : '', term_id: activeTerm ? activeTerm.id : '' });
    else renderRouteAssignments(body, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: activeTerm ? activeTerm.id : '' });
  };
  root.querySelectorAll('[data-irtab]').forEach((b) => b.onclick = () => show(b.dataset.irtab));
  show('unpaid_votehead');
}

async function renderUnpaidVoteHead(root, voteHeads, years, terms, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Vote Head</label><select id="ir-vh">${options(voteHeads, 'id', 'name', sel.vote_head_id)}</select></div>
        <div class="field"><label>Academic Year</label><select id="ir-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
        <div class="field"><label>Term</label><select id="ir-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      </div>
      <div class="spacer"></div>
    </div>
    <div id="ir-table" style="margin-top:8px">${loader()}</div>
  `;
  root.querySelector('#ir-vh').onchange = (e) => renderUnpaidVoteHead(root, voteHeads, years, terms, { ...sel, vote_head_id: e.target.value });
  root.querySelector('#ir-year').onchange = (e) => renderUnpaidVoteHead(root, voteHeads, years, terms, { ...sel, academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#ir-term').onchange = (e) => renderUnpaidVoteHead(root, voteHeads, years, terms, { ...sel, term_id: e.target.value });

  if (!sel.vote_head_id) { root.querySelector('#ir-table').innerHTML = '<div class="card pad muted">No vote heads set up yet.</div>'; return; }
  const res = await Db.finance.reports.voteHeadStudentBalances(sel.vote_head_id, sel.academic_year_id || null, sel.term_id || null);
  const rows = (res.ok ? res.data : []).filter((r) => Number(r.balance) > 0);
  root.querySelector('#ir-table').innerHTML = `
    <div class="card side-accent tile-teal"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Adm. No.</th><th>Name</th><th>Class</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td>${esc(r.class_name)}${r.stream_name ? ' ' + esc(r.stream_name) : ''}</td>
        <td class="num">${Number(r.expected || 0).toLocaleString()}</td><td class="num">${Number(r.paid || 0).toLocaleString()}</td><td class="num">${Number(r.balance || 0).toLocaleString()}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Everyone has cleared this vote head.</td></tr>'}</tbody>
    </table></div></div>
  `;
}

async function renderRouteAssignments(root, years, terms, sel) {
  root.innerHTML = `
    <div class="fin-toolbar no-print">
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label><select id="ira-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
        <div class="field"><label>Term</label><select id="ira-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      </div>
      <div class="spacer"></div>
      ${printOptionsHtml('ira', 'portrait')}
    </div>
    <div id="ira-table" style="margin-top:8px">${loader()}</div>
  `;
  root.querySelector('#ira-year').onchange = (e) => renderRouteAssignments(root, years, terms, { academic_year_id: e.target.value, term_id: '' });
  root.querySelector('#ira-term').onchange = (e) => renderRouteAssignments(root, years, terms, { ...sel, term_id: e.target.value });

  const res = await Db.finance.routes.classAssignments(sel.academic_year_id || null, sel.term_id || null);
  const rows = res.ok ? res.data : [];
  rows.sort((a, b) => {
    const ca = (a.students && a.students.classes && a.students.classes.name) || '';
    const cb = (b.students && b.students.classes && b.students.classes.name) || '';
    return ca.localeCompare(cb) || ((a.students ? a.students.full_name : '').localeCompare(b.students ? b.students.full_name : ''));
  });
  root.querySelector('#ira-table').innerHTML = `
    <div class="card print-grid" id="ira-sheet"><div class="card-b table-wrap"><table class="data">
      <thead><tr><th>Class</th><th>Student</th><th>Adm. No.</th><th>Route</th><th>Direction</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.students && r.students.classes ? r.students.classes.name : '')}</td>
        <td>${esc(r.students ? r.students.full_name : '')}</td><td>${esc(r.students ? r.students.admission_no : '')}</td>
        <td>${esc(r.finance_routes ? r.finance_routes.name : '')}</td><td>${r.direction === 'two_way' ? 'Two-way' : 'One-way'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No transport assignments for this term yet.</td></tr>'}</tbody>
    </table></div></div>
  `;
  wirePrintOptions(root, 'ira', 'Transport Route Assignments');
}
