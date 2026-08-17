/**
 * financeDashboard.mjs — Finance module snapshot (brief §Dashboard): tiles
 * for fees collected, total payments, total students, plus a per-class %
 * collected breakdown, filterable by term/year.
 */
import { esc, options, toast, modal, closeModal, confirmAction, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';

function tile(label, value, sub) {
  return `<div class="stat"><div class="s-ico">💰</div><div><div class="s-val">${esc(value)}</div><div class="s-lab">${esc(label)}${sub ? ` · ${esc(sub)}` : ''}</div></div></div>`;
}

export async function viewFinanceDashboard(root, access) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  await load(root, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: '' }, access);
}

async function load(root, years, terms, sel, access) {
  root.innerHTML = `
    <div class="card">
      <div class="card-b" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="max-width:220px"><label>Academic Year</label>
          <select id="fd-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
        <div class="field" style="max-width:220px"><label>Term</label>
          <select id="fd-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      </div>
    </div>
    <div id="fd-body" style="margin-top:14px">Loading…</div>
  `;
  root.querySelector('#fd-year').onchange = (e) => load(root, years, terms, { academic_year_id: e.target.value, term_id: '' }, access);
  root.querySelector('#fd-term').onchange = (e) => load(root, years, terms, { ...sel, term_id: e.target.value }, access);

  const res = await Db.finance.reports.dashboard(sel.academic_year_id || null, sel.term_id || null);
  const body = root.querySelector('#fd-body');
  if (!res.ok) { body.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const d = res.data || {};
  body.innerHTML = `
    <div class="stats-desktop" style="max-width:none">
      ${tile('Total Collected', `KES ${Number(d.total_collected || 0).toLocaleString()}`)}
      ${tile('Total Payments', d.total_payments || 0)}
      ${tile('Total Students', d.total_students || 0)}
      ${tile('% of Expected Collected', `${d.pct_collected || 0}%`, `of KES ${Number(d.total_expected || 0).toLocaleString()} expected`)}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h3>Collections Per Class</h3></div>
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th>Class</th><th class="num">Expected</th><th class="num">Collected</th><th>% Collected</th></tr></thead>
        <tbody>${(d.per_class || []).map((c) => `<tr>
          <td>${esc(c.class_name)}</td>
          <td class="num">${Number(c.expected || 0).toLocaleString()}</td>
          <td class="num">${Number(c.collected || 0).toLocaleString()}</td>
          <td><div class="fin-progress"><div class="fin-progress-fill" style="width:${Math.min(100, c.pct || 0)}%"></div></div> ${c.pct || 0}%</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">No classes yet.</td></tr>'}</tbody>
      </table></div>
    </div>
    ${access && access.canManage ? `
    <div class="card pad" style="margin-top:16px">
      <h3 style="margin-top:0">Admin Tools</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn secondary sm" id="fd-opening">Bulk Opening Balances</button>
        <button class="btn secondary sm" id="fd-carry">Carry Forward Balances</button>
      </div>
    </div>` : ''}
  `;

  if (access && access.canManage) {
    root.querySelector('#fd-opening').onclick = () => openBulkOpeningModal(years, sel);
    root.querySelector('#fd-carry').onclick = () => openCarryForwardModal(years);
  }
}

/** Bulk opening-balances upload (brief scenario #9) — a school starting to
 *  use the system mid-year pastes "admission_no,amount" lines rather than
 *  setting each student's opening balance one at a time from their
 *  profile. Resolves admission numbers against the active student roster
 *  client-side (small/medium school rosters make this fine — same
 *  trade-off students.mjs's own search() already makes). */
function openBulkOpeningModal(years, sel) {
  const activeYear = years.find((y) => y.id === sel.academic_year_id) || years[0];
  modal({
    title: 'Bulk Opening Balances',
    wide: true,
    body: `
      <p class="hint" style="margin-top:0">For ${esc(activeYear ? activeYear.name : 'the selected year')}. Paste one student per line: <code>admission_no,amount</code> — e.g. <code>ADM0231,4500</code>. A positive amount is owed by the student; negative is a credit.</p>
      <div class="field"><textarea id="ob-csv" rows="10" style="width:100%;font-family:monospace" placeholder="ADM0231,4500
ADM0198,-200"></textarea></div>
      <div id="ob-status" class="hint"></div>
    `,
    okLabel: 'Upload',
    onOk: async () => {
      if (!activeYear) { toast('No academic year to set balances for.', 'err'); return; }
      const lines = document.getElementById('ob-csv').value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) { toast('Paste at least one row.', 'err'); return; }
      const studentsRes = await Db.students.list();
      const students = studentsRes.ok ? studentsRes.data : [];
      const byAdm = {}; students.forEach((s) => { byAdm[String(s.admission_no).toLowerCase()] = s; });
      const rows = []; const unmatched = [];
      lines.forEach((line) => {
        const [adm, amt] = line.split(',').map((p) => (p || '').trim());
        const student = byAdm[String(adm).toLowerCase()];
        if (!student || amt === '' || !Number.isFinite(Number(amt))) { unmatched.push(line); return; }
        rows.push({ student_id: student.id, amount: Number(amt) });
      });
      if (!rows.length) { toast('No rows matched a student — check the admission numbers.', 'err'); return; }
      const res = await Db.finance.students.bulkOpeningBalances(rows, activeYear.id);
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(`Saved ${rows.length} opening balance(s).${unmatched.length ? ` ${unmatched.length} row(s) skipped — no match.` : ''}`, unmatched.length ? 'warn' : 'ok');
    }
  });
}

/** Carry-forward (brief scenario #12) — an admin-triggered, once-a-year
 *  action, so no dedicated screen; a confirm dialog off the dashboard is
 *  proportionate. */
function openCarryForwardModal(years) {
  modal({
    title: 'Carry Forward Balances',
    body: `
      <p class="hint" style="margin-top:0">Copies every student's outstanding balance from one academic year into the next year's opening balance — run this once, at the start of a new year.</p>
      <div class="grid2">
        <div class="field"><label>From Year</label><select id="cf-from">${options(years, 'id', 'name', '')}</select></div>
        <div class="field"><label>To Year</label><select id="cf-to">${options(years, 'id', 'name', '')}</select></div>
      </div>
    `,
    okLabel: 'Carry Forward',
    onOk: async () => {
      const fromId = document.getElementById('cf-from').value;
      const toId = document.getElementById('cf-to').value;
      if (!fromId || !toId) { toast('Choose both years.', 'err'); return; }
      if (fromId === toId) { toast('Choose two different years.', 'err'); return; }
      closeModal();
      confirmAction('This will set every student\'s opening balance for the destination year. Continue?', async () => {
        const res = await Db.finance.carryForwardBalances(fromId, toId);
        toast(res.ok ? `Carried forward balances for ${res.data && res.data.count ? res.data.count : 'all'} student(s).` : res.message, res.ok ? 'ok' : 'err');
      });
    }
  });
}
