/**
 * financeDashboard.mjs — Finance module snapshot (brief §Dashboard): tiles
 * for fees collected, total balances, total students, plus a per-class %
 * collected breakdown, filterable by term/year.
 *
 * Round 2 §2:
 *   - Admin Tools (Bulk Opening Balances / Carry Forward Balances) removed
 *     from here entirely — Bulk Opening Balances now lives under Reports
 *     as its own tab (financeReports.mjs, matching the brief's §11 Excel-
 *     template pattern), and Carry Forward Balances is no longer a manual
 *     action anywhere in the UI: it now fires automatically the moment an
 *     admin activates a new academic year (see the trigger on
 *     academic_years in migrations/0032_finance_round2.sql) — "shouldn't
 *     be a manual option someone has to remember to trigger."
 *   - Filter row widened to the same .fin-toolbar/.fin-filters pattern
 *     every other Finance screen's header now uses (§1).
 *   - "Total Payments" (a plain count) replaced with "Total Balances" (what's
 *     still owed overall) — clicking it jumps straight to Reports > Balances.
 */
import { esc, options } from '../app.js';
import { Db } from '../lib/api/index.mjs';

function tile(label, value, sub, marker) {
  return `<div class="stat"${marker ? ` data-tile="${marker}"` : ''}><div class="s-ico">💰</div><div><div class="s-val">${esc(value)}</div><div class="s-lab">${esc(label)}${sub ? ` · ${esc(sub)}` : ''}</div></div></div>`;
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
    <div class="fin-toolbar">
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label>
          <select id="fd-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
        <div class="field"><label>Term</label>
          <select id="fd-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
      </div>
      <div class="spacer"></div>
    </div>
    <div id="fd-body" style="margin-top:14px">Loading…</div>
  `;
  root.querySelector('#fd-year').onchange = (e) => load(root, years, terms, { academic_year_id: e.target.value, term_id: '' }, access);
  root.querySelector('#fd-term').onchange = (e) => load(root, years, terms, { ...sel, term_id: e.target.value }, access);

  const res = await Db.finance.reports.dashboard(sel.academic_year_id || null, sel.term_id || null);
  const body = root.querySelector('#fd-body');
  if (!res.ok) { body.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const d = res.data || {};
  const tilesHtml = [
    tile('Total Collected', `KES ${Number(d.total_collected || 0).toLocaleString()}`),
    tile('Total Balances', `KES ${Number(d.total_balance || 0).toLocaleString()}`, 'click to view Balances report', 'fd-tile-balances'),
    tile('Total Students', d.total_students || 0),
    tile('% of Expected Collected', `${d.pct_collected || 0}%`, `of KES ${Number(d.total_expected || 0).toLocaleString()} expected`)
  ].join('');
  // Mirrors dashboard.mjs's pattern: the app's mobile breakpoint (<960px,
  // see main.css) hides .stats-desktop and shows .stats-mobile instead —
  // this screen used to render only .stats-desktop, so on phones the tiles
  // (and the whole snapshot above the class table) just disappeared with
  // nothing to replace them. Rendering both, same as every other dashboard
  // screen, fixes that.
  body.innerHTML = `
    <div class="stats-mobile">${tilesHtml}</div>
    <div class="stats-desktop" style="max-width:none">${tilesHtml}</div>
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
  `;

  body.querySelectorAll('[data-tile="fd-tile-balances"]').forEach((balancesTile) => {
    balancesTile.style.cursor = 'pointer';
    balancesTile.title = 'View the Balances report';
    balancesTile.onclick = () => {
      const reportsTab = document.querySelector('[data-tab="reports"]');
      if (reportsTab) reportsTab.click();
    };
  });
}
