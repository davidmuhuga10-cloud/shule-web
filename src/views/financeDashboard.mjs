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
import { esc, options, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';

// POST-BUILD AUDIT (Sidebar_Performance_Login_Audit_Fixes.docx item 3:
// "a greeting at the dashboard to the user") — same time-of-day + first-
// name greeting the main app Dashboard already shows (dashboard.mjs), kept
// as its own tiny copy here rather than exporting/importing it: it's two
// one-line helpers, not worth coupling Finance's dashboard to the general
// one just to share them.
function greetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function firstName() {
  return ((state.profile && state.profile.name) || '').trim().split(/\s+/)[0] || '';
}

// Finance Expansion brief item 0 ("Dashboard — Inspiration From Competitor
// SAMIS"): the director specifically called out two charts from a
// competitor's dashboard — a per-class "Budget vs Paid" bar chart and a
// "Class Balances Distribution" pie chart. Both are pure presentation of
// data this screen ALREADY fetches (d.per_class, from the existing
// finance_dashboard() RPC) — no new backend, no new query, nothing to
// integrate. Hand-rolled inline SVG rather than a charting library: this
// app has zero chart/graphics dependencies today, and pulling one in for
// two fairly simple shapes would undo the exact bundle-size work this
// project just did elsewhere. Kept in ShuleTop's own palette (--primary
// teal / --accent amber, the categorical set below) rather than copying
// the competitor's blue/purple — the ask was "these KINDS of graphs", not
// "this exact color scheme", and every other screen in this app uses the
// existing brand tokens.
//
// A small, fixed-order categorical palette for the pie's per-class slices
// (dataviz best practice: assign hue by position, never regenerate/cycle
// per render) — 10 visually distinct hues spanning the wheel, spaced so
// adjacent slices don't sit next to a easily-confused pair (e.g. the two
// closest reds are kept apart). A school with more than 10 classes reuses
// the palette from the top rather than inventing new hues on the fly.
const CLASS_PALETTE = ['#127a6b', '#f5a623', '#3b6ea5', '#c0447b', '#7a5cc9', '#2f9e6f', '#c9860a', '#4fb3bf', '#a8475b', '#6b8e23'];

function fmtKes(n) {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  if (abs >= 1000000) return `${(n / 1000000).toFixed(abs % 1000000 === 0 ? 0 : 1)}M`;
  if (abs >= 1000) return `${(n / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}K`;
  return String(Math.round(n));
}

// "Class Budget vs Paid" — a grouped bar chart, two bars (Expected/Paid)
// per class, drawn to a shared scale with gridlines and axis labels. Pure
// SVG, no library: each bar/gridline/label is computed from perClass and
// written directly as SVG markup.
function budgetVsPaidChart(perClass) {
  const classes = (perClass || []).filter((c) => (c.expected || 0) > 0 || (c.collected || 0) > 0);
  if (!classes.length) return '<div class="chart-empty muted">No invoiced classes yet for this term.</div>';
  const W = 640, H = 260, padL = 46, padR = 12, padT = 14, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...classes.map((c) => Math.max(c.expected || 0, c.collected || 0)));
  // Round the axis ceiling up to a "nice" step (1/2/5 x 10^n) so gridline
  // labels read like KSh 200K/400K/... instead of an arbitrary max.
  const rawStep = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || mag * 10;
  const axisMax = niceStep * 4;
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const groupW = plotW / classes.length;
  const barW = Math.min(22, groupW * 0.32);
  const gridlines = [0, 1, 2, 3, 4].map((i) => {
    const v = niceStep * i;
    const yy = y(v);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="chart-grid"/>
      <text x="${padL - 6}" y="${yy + 3}" class="chart-axis-label" text-anchor="end">KSh ${fmtKes(v)}</text>`;
  }).join('');
  const bars = classes.map((c, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const expH = plotH - (y(c.expected || 0) - padT);
    const colH = plotH - (y(c.collected || 0) - padT);
    return `
      <rect x="${(cx - barW - 3).toFixed(1)}" y="${y(c.expected || 0).toFixed(1)}" width="${barW}" height="${Math.max(0, expH).toFixed(1)}" class="chart-bar chart-bar-budget"><title>${esc(c.class_name)} — Budget: KES ${Number(c.expected || 0).toLocaleString()}</title></rect>
      <rect x="${(cx + 3).toFixed(1)}" y="${y(c.collected || 0).toFixed(1)}" width="${barW}" height="${Math.max(0, colH).toFixed(1)}" class="chart-bar chart-bar-paid"><title>${esc(c.class_name)} — Paid: KES ${Number(c.collected || 0).toLocaleString()}</title></rect>
      <text x="${cx.toFixed(1)}" y="${H - padB + 16}" class="chart-axis-label" text-anchor="middle">${esc(truncateLabel(c.class_name))}</text>
    `;
  }).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Budget versus amount paid, per class">
      ${gridlines}
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="chart-axis-line"/>
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="chart-axis-line"/>
      ${bars}
    </svg>
    <div class="chart-legend"><span><i class="chart-swatch chart-bar-budget"></i>Budget (expected)</span><span><i class="chart-swatch chart-bar-paid"></i>Paid (collected)</span></div>
  `;
}

function truncateLabel(s) {
  s = String(s || '');
  return s.length > 10 ? s.slice(0, 9) + '…' : s;
}

// "Class Balances Distribution" — one pie slice per class, sized by that
// class's outstanding balance (expected - collected, floored at 0 so an
// overpaid class contributes nothing rather than a negative wedge). The
// brief explicitly asked for this exact chart shape (matching the
// competitor screenshot), so a pie is used here deliberately even though
// a bar chart is usually the safer default for comparing magnitudes.
function classBalancesPie(perClass) {
  const rows = (perClass || [])
    .map((c) => ({ name: c.class_name, balance: Math.max(0, (c.expected || 0) - (c.collected || 0)) }))
    .filter((r) => r.balance > 0);
  const total = rows.reduce((s, r) => s + r.balance, 0);
  if (!total) return '<div class="chart-empty muted">No outstanding class balances — fully collected. 🎉</div>';
  const cx = 110, cy = 110, r = 100;
  let angle = -Math.PI / 2; // start at 12 o'clock, same convention the reference screenshot uses
  const slices = rows.map((row, i) => {
    const frac = row.balance / total;
    const sweep = frac * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    const color = CLASS_PALETTE[i % CLASS_PALETTE.length];
    const path = `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
    return { path, color, name: row.name, balance: row.balance, pct: Math.round(frac * 100) };
  });
  const paths = slices.map((s) => `<path d="${s.path}" fill="${s.color}" stroke="var(--surface)" stroke-width="2"><title>${esc(s.name)} — KES ${s.balance.toLocaleString()} (${s.pct}%)</title></path>`).join('');
  const legend = slices.map((s) => `<span><i class="chart-swatch" style="background:${s.color}"></i>${esc(s.name)} <b>${s.pct}%</b></span>`).join('');
  return `
    <svg viewBox="0 0 220 220" class="chart-svg chart-pie" role="img" aria-label="Outstanding balance distribution by class">${paths}</svg>
    <div class="chart-legend chart-legend-pie">${legend}</div>
  `;
}

// Mobile dashboard redesign (approved, revised — no icons/emoji): each tile
// is just the value on its own first line with its label directly below,
// still colour-accented via .stat-* (site-wide pattern, see dashboard.mjs).
// `title` carries any extra detail (e.g. "of KES X expected") as a hover
// tooltip rather than cluttering the tile with a second line of text.
function tile(label, value, colorKey, marker, title) {
  return `<div class="stat stat-${colorKey} no-ico"${marker ? ` data-tile="${marker}"` : ''}${title ? ` title="${esc(title)}"` : ''}><div><div class="s-val">${esc(value)}</div><div class="s-lab">${esc(label)}</div></div></div>`;
}

// Short money form for tile headline values, e.g. 1200000 -> "1.2M",
// 240000 -> "240K" — approved as the first line on each money tile
// instead of the full "KES 1,200,000".
function fmtMoney(n) {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  if (abs >= 1000000) { const v = n / 1000000; return `${Number.isInteger(v) ? v : v.toFixed(1)}M`; }
  if (abs >= 1000) { const v = n / 1000; return `${Number.isInteger(v) ? v : v.toFixed(1)}K`; }
  return String(Math.round(n));
}

export async function viewFinanceDashboard(root, access) {
  // Perf/UX fix: paint something immediately instead of leaving Finance's
  // generic tab-switch spinner up for this extra round trip too — see
  // examDesk.mjs's viewExamDesk for the fuller explanation.
  root.innerHTML = `
    <div class="card"><div class="card-b">
      <div class="skeleton" style="width:100%;height:60px;margin-bottom:12px"></div>
      <div class="skeleton" style="width:100%;height:60px"></div>
    </div></div>
  `;
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  await load(root, years, terms, { academic_year_id: activeYear ? activeYear.id : '', term_id: '' }, access);
}

async function load(root, years, terms, sel, access) {
  root.innerHTML = `
    <p class="muted" style="margin:0 0 12px;font-size:14.5px"><b>${greetingWord()}, ${esc(firstName())}</b> — here's your Finance snapshot.</p>
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
    tile('Total Collected', fmtMoney(d.total_collected || 0), 'green', null, `KES ${Number(d.total_collected || 0).toLocaleString()}`),
    tile('Balances', fmtMoney(d.total_balance || 0), 'rose', 'fd-tile-balances', `KES ${Number(d.total_balance || 0).toLocaleString()}`),
    tile('Students', d.total_students || 0, 'blue'),
    tile('Of Expected', `${d.pct_collected || 0}%`, 'teal', null, `of KES ${Number(d.total_expected || 0).toLocaleString()} expected`)
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
    <div class="fin-chart-row">
      <div class="card side-accent tile-rose">
        <div class="card-h" style="flex-direction:column;align-items:flex-start;gap:2px"><h3>Class Balances Distribution</h3><span class="muted" style="font-size:12px">Outstanding balances by class</span></div>
        <div class="card-b">${classBalancesPie(d.per_class)}</div>
      </div>
      <div class="card side-accent tile-teal">
        <div class="card-h" style="flex-direction:column;align-items:flex-start;gap:2px"><h3>Class Budget vs Paid</h3><span class="muted" style="font-size:12px">Comparison across classes</span></div>
        <div class="card-b">${budgetVsPaidChart(d.per_class)}</div>
      </div>
    </div>
    <div class="card side-accent tile-teal" style="margin-top:16px">
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
    balancesTile.onclick = () => {
      const reportsTab = document.querySelector('[data-tab="reports"]');
      if (reportsTab) reportsTab.click();
    };
  });
}
