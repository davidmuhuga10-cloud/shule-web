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
  // Live feedback: "Class vs Budget graph is too big, reduce its size by
  // half from top to bottom" — same width (640), viewBox height halved
  // (260→130) with its top/bottom padding trimmed proportionally so the
  // bars/gridlines/axis labels still have breathing room at the new size.
  const W = 640, H = 130, padL = 46, padR = 12, padT = 8, padB = 22;
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

// "Income vs Expenses" — live feedback ("also add a 3rd graphic showing
// income vs expenses"): a 6-month trend, income from finance_collections
// (via the existing finance_cashbook RPC, already scoped to
// finance_can_collect() school-side) and expenses from finance_expenses
// (excluding 'void' ones — a voided expense never happened). Both fetched
// and bucketed by month in load() below, then handed here already summed.
//
// "Some schools don't track expenses" (live feedback): finance_expenses is
// opt-in — a school that's never logged one would otherwise see a chart
// half full of real income bars next to a flat row of invisible
// zero-height red bars, reading as broken rather than "not used." Detect
// the all-zero case and fall back to incomeOnlyChart() instead.
function incomeExpenseChart(rows) {
  const totalExpense = (rows || []).reduce((s, r) => s + (r.expense || 0), 0);
  if (!totalExpense) return incomeOnlyChart(rows);
  const W = 640, H = 250, padL = 46, padR = 12, padT = 14, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...rows.map((r) => Math.max(r.income || 0, r.expense || 0)));
  const rawStep = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || mag * 10;
  const axisMax = niceStep * 4;
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const groupW = plotW / rows.length;
  const barW = Math.min(22, groupW * 0.32);
  const gridlines = [0, 1, 2, 3, 4].map((i) => {
    const v = niceStep * i;
    const yy = y(v);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="chart-grid"/>
      <text x="${padL - 6}" y="${yy + 3}" class="chart-axis-label" text-anchor="end">KSh ${fmtKes(v)}</text>`;
  }).join('');
  const bars = rows.map((r, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const incH = plotH - (y(r.income || 0) - padT);
    const expH = plotH - (y(r.expense || 0) - padT);
    return `
      <rect x="${(cx - barW - 3).toFixed(1)}" y="${y(r.income || 0).toFixed(1)}" width="${barW}" height="${Math.max(0, incH).toFixed(1)}" class="chart-bar chart-bar-income"><title>${esc(r.dateLabel || r.label)} — Income: KES ${Number(r.income || 0).toLocaleString()}</title></rect>
      <rect x="${(cx + 3).toFixed(1)}" y="${y(r.expense || 0).toFixed(1)}" width="${barW}" height="${Math.max(0, expH).toFixed(1)}" class="chart-bar chart-bar-expense"><title>${esc(r.dateLabel || r.label)} — Expenses: KES ${Number(r.expense || 0).toLocaleString()}</title></rect>
      <text x="${cx.toFixed(1)}" y="${H - padB + 16}" class="chart-axis-label" text-anchor="middle">${esc(r.label)}</text>
    `;
  }).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Income versus expenses, last 6 months">
      ${gridlines}
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="chart-axis-line"/>
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="chart-axis-line"/>
      ${bars}
    </svg>
    <div class="chart-legend"><span><i class="chart-swatch chart-bar-income"></i>Income</span><span><i class="chart-swatch chart-bar-expense"></i>Expenses</span></div>
  `;
}

function incomeOnlyChart(rows) {
  const W = 640, H = 250, padL = 46, padR = 12, padT = 14, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...(rows || []).map((r) => r.income || 0));
  const rawStep = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || mag * 10;
  const axisMax = niceStep * 4;
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const groupW = plotW / rows.length;
  const barW = Math.min(32, groupW * 0.44);
  const gridlines = [0, 1, 2, 3, 4].map((i) => {
    const v = niceStep * i;
    const yy = y(v);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="chart-grid"/>
      <text x="${padL - 6}" y="${yy + 3}" class="chart-axis-label" text-anchor="end">KSh ${fmtKes(v)}</text>`;
  }).join('');
  const bars = rows.map((r, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const incH = plotH - (y(r.income || 0) - padT);
    return `
      <rect x="${(cx - barW / 2).toFixed(1)}" y="${y(r.income || 0).toFixed(1)}" width="${barW}" height="${Math.max(0, incH).toFixed(1)}" class="chart-bar chart-bar-income"><title>${esc(r.dateLabel || r.label)} — Income: KES ${Number(r.income || 0).toLocaleString()}</title></rect>
      <text x="${cx.toFixed(1)}" y="${H - padB + 16}" class="chart-axis-label" text-anchor="middle">${esc(r.label)}</text>
    `;
  }).join('');
  return `
    <div class="muted" style="font-size:11.5px;margin-bottom:6px">💡 Expenses aren't tracked for this school yet — showing income (collections) only.</div>
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Income, last 6 months — expenses not tracked">
      ${gridlines}
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="chart-axis-line"/>
      <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="chart-axis-line"/>
      ${bars}
    </svg>
    <div class="chart-legend"><span><i class="chart-swatch chart-bar-income"></i>Income</span></div>
  `;
}

// Buckets the last 6 calendar months (oldest→newest, current month last) —
// used as the Income vs Expenses trend's fallback window whenever a chosen
// Period can't be resolved to real dates yet (see resolvePeriodRange below).
function last6MonthKeys() {
  const out = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en', { month: 'short' }), from: d, to: new Date(d.getFullYear(), d.getMonth() + 1, 0) });
  }
  return out;
}

// Live feedback: "allow filtration by This Term / This Month / This Week /
// Today / Date Range / Academic Year" (Dashboard). This only ever drives the
// Income vs Expenses trend below — the per-class Expected/Collected numbers
// (tiles, Budget vs Paid, the Balances pie, Collections Per Class) all come
// from the finance_dashboard() RPC, which only understands
// academic_year_id/term_id and has no concept of "today" or "this week", so
// those stay scoped to the Year/Term filters exactly as they always have.
// Income vs Expenses is the one chart already built on genuinely
// date-filterable APIs (finance_cashbook + finance_expenses.list), so it's
// the one that can honor an arbitrary period.
const PERIODS = [
  { key: 'this_term', label: 'This Term' },
  { key: 'this_month', label: 'This Month' },
  { key: 'this_week', label: 'This Week' },
  { key: 'today', label: 'Today' },
  { key: 'date_range', label: 'Date Range' },
  { key: 'academic_year', label: 'Academic Year' }
];

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun..6=Sat
  x.setDate(x.getDate() - (day === 0 ? 6 : day - 1)); // Monday start
  return x;
}
function endOfWeek(d) {
  const s = startOfWeek(d);
  return endOfDay(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6));
}

// Resolves the Period selector into a concrete {from, to} range. "This
// Term"/"Academic Year" deliberately reuse whatever the Year/Term filters
// above are already set to, falling back to the active one when a filter is
// on "All" — the two filter rows describe the same dashboard, so they
// should never disagree about what "this term" means. Anything that can't
// be resolved (e.g. a term/year with no start_date on file, or "Date Range"
// before both dates are picked) falls back to the same last-6-months window
// the Dashboard always showed before Period filtering existed, so the chart
// never just goes blank.
function resolvePeriodRange(period, sel, years, terms) {
  const now = new Date();
  if (period === 'today') return { from: startOfDay(now), to: endOfDay(now) };
  if (period === 'this_week') return { from: startOfWeek(now), to: endOfWeek(now) };
  if (period === 'this_month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  }
  if (period === 'date_range' && sel.rangeFrom && sel.rangeTo) {
    return { from: startOfDay(new Date(sel.rangeFrom)), to: endOfDay(new Date(sel.rangeTo)) };
  }
  if (period === 'this_term') {
    const term = terms.find((t) => t.id === sel.term_id) || terms.find((t) => t.status === 'active');
    if (term && term.start_date) return { from: startOfDay(new Date(term.start_date)), to: endOfDay(new Date(term.end_date || term.start_date)) };
  }
  if (period === 'this_term' || period === 'academic_year') {
    const year = years.find((y) => y.id === sel.academic_year_id) || years.find((y) => y.status === 'active');
    if (year && year.start_date) return { from: startOfDay(new Date(year.start_date)), to: endOfDay(new Date(year.end_date || year.start_date)) };
  }
  const months = last6MonthKeys();
  return { from: months[0].from, to: months[months.length - 1].to };
}

// One line under the Income vs Expenses card naming exactly what range is
// plotted — "Last 6 months" used to be a lie the moment Period existed.
// `meta` describes WHY the plotted window differs from the raw period:
//   trimmedEmpty — leading months with zero income AND zero expenses were
//     dropped so the chart starts at the school's first real transaction
//     instead of opening with blank bars.
//   capped — on top of that (or instead of it, for a long-running school
//     with no leading gap), the window was also capped to the most recent
//     4 months for readability.
function periodSubtitle(period, range, meta) {
  const fmt = (d) => d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
  const { trimmedEmpty, capped } = meta || {};
  if (trimmedEmpty && capped) {
    return `Last 4 months with activity (${fmt(range.from)} – ${fmt(range.to)})`;
  }
  if (trimmedEmpty) {
    return `${fmt(range.from)} – ${fmt(range.to)} — starts at your first recorded transaction`;
  }
  // Long history, no leading gap, but still too many months to plot
  // readably — same "Last 4 months of..." framing as before.
  if (capped) {
    const label = period === 'this_term' ? 'this term' : period === 'academic_year' ? 'the academic year' : 'the selected period';
    return `Last 4 months of ${label} (${fmt(range.from)} – ${fmt(range.to)})`;
  }
  if (period === 'today') return `Today (${fmt(range.from)})`;
  if (period === 'this_week') return `This week (${fmt(range.from)} – ${fmt(range.to)})`;
  if (period === 'this_month') return `This month (${fmt(range.from)} – ${fmt(range.to)})`;
  if (period === 'date_range') return `${fmt(range.from)} – ${fmt(range.to)}`;
  if (period === 'this_term') return `This term (${fmt(range.from)} – ${fmt(range.to)})`;
  if (period === 'academic_year') return `This academic year (${fmt(range.from)} – ${fmt(range.to)})`;
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}

// Buckets an arbitrary {from,to} range into chart-ready points. By calendar
// month once the range spans more than ~6 weeks (a term/year plotted by day
// would be an unreadable wall of bars); by day otherwise, since Today/This
// Week/a short Date Range are far more useful broken down daily than
// squashed into one lone monthly bar. Returned alongside the granularity so
// callers know whether to match rows on a "YYYY-MM" or full "YYYY-MM-DD" key.
function bucketRange(from, to) {
  const spanDays = Math.max(1, Math.round((to - from) / 86400000));
  if (spanDays > 45) {
    const buckets = [];
    let d = new Date(from.getFullYear(), from.getMonth(), 1);
    const last = new Date(to.getFullYear(), to.getMonth(), 1);
    while (d <= last) {
      buckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en', { month: 'short' }) });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    // Live feedback (round 1): "income vs expenses show only four months" —
    // an Academic Year or a long custom Date Range could otherwise stretch
    // this to 12+ monthly bars, so the display window is still capped to 4
    // for readability. BUT that capping used to always count backward from
    // the END of the range, which for a school whose year starts long
    // before it actually opened (or before any money had been recorded)
    // meant the chart's first bars were just empty months — e.g. an academic
    // year starting Jan 1 with the school's first real transaction in
    // August showed Jun/Jul as two blank leading bars instead of Aug's real
    // numbers. The cap-to-4 decision now happens later in load(), AFTER the
    // actual cashbook/expense rows are known, so it can anchor on the first
    // month that has real activity instead of blindly counting from the
    // end. This function just returns every month in the range uncapped;
    // load() decides what subset to actually display.
    return { granularity: 'month', buckets, displayFrom: from, capped: false };
  }
  const buckets = [];
  let d = startOfDay(from);
  const end = startOfDay(to);
  while (d <= end) {
    buckets.push({ key: d.toISOString().slice(0, 10), label: d.toLocaleString('en', { day: 'numeric', month: 'short' }) });
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return { granularity: 'day', buckets, displayFrom: from, capped: false };
}

// Live feedback: the % Collected bar used to be red-vs-teal-agnostic — every
// class got the exact same color regardless of whether it was 30% or 95%
// collected, so a class in real trouble didn't stand out at all. Thresholds
// reuse the app's existing --danger/--warn/--ok tokens rather than inventing
// new colors (same ones badges/status pills already use elsewhere).
function progressColorClass(pct) {
  if (pct < 50) return 'prog-low';
  if (pct < 80) return 'prog-mid';
  return 'prog-high';
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
  // Live feedback: "the first thing to see should be [the greeting]...
  // currently sitting in between things" — this used to be a small muted
  // one-liner, easy to skim past between Finance's own title bar above and
  // the year/term filters below. Upgraded to the same .page-head h2+p shape
  // dashboard.mjs's own Academic dashboard greeting uses, so it reads as
  // the unmistakable start of the page's content, the same way it does on
  // the Academic side, rather than a small aside.
  // Live feedback: "a lot of space to the right top of the dashboard...
  // include some quick access icons" — the greeting's h2+p never filled the
  // .page-head row's own width, leaving a wide dead strip to its right on
  // anything wider than a phone. A row of the 3 things an admin/bursar most
  // often comes to this screen to DO (not just look at) fills that space
  // usefully instead of padding it out cosmetically. Same .icon-chip
  // pattern Exam Desk's own action buttons use elsewhere in the app.
  // "Add Collection" is gated behind access.canCollect the same way every
  // other money-moving action on this screen already is (financeHub.mjs's
  // own access object) — a viewer who can't record collections doesn't get
  // a button that would just be rejected server-side.
  const quickActionsHtml = `
    <div class="fin-quick-actions no-print">
      <button class="icon-chip qa-chip-amber" id="fd-qa-reminder">🔔 Send Reminder</button>
      ${access.canCollect ? '<button class="icon-chip qa-chip-teal" id="fd-qa-collect">➕ Add Collection</button>' : ''}
      <button class="icon-chip qa-chip-rose" id="fd-qa-balances">👛 View Balances</button>
    </div>
  `;
  // Defaults to "Academic Year" — the Dashboard already opens scoped to the
  // active academic year, so the Income vs Expenses trend agreeing with
  // that by default (rather than a disconnected "last 6 months") is the
  // least surprising starting point; every other option is one click away.
  const period = sel.period || 'academic_year';
  root.innerHTML = `
    <div class="page-head" style="margin-bottom:14px">
      <div><h2>${greetingWord()}, ${esc(firstName())}</h2><p>Here's your Finance snapshot.</p></div>
      <div class="spacer"></div>
      ${quickActionsHtml}
    </div>
    <div class="fin-toolbar">
      <div class="fin-filters">
        <div class="field"><label>Academic Year</label>
          <select id="fd-year">${options(years, 'id', 'name', sel.academic_year_id, 'All years')}</select></div>
        <div class="field"><label>Term</label>
          <select id="fd-term">${options(terms.filter((t) => !sel.academic_year_id || t.academic_year_id === sel.academic_year_id), 'id', 'name', sel.term_id, 'All terms')}</select></div>
        <div class="field"><label>Period</label>
          <select id="fd-period">${options(PERIODS, 'key', 'label', period)}</select></div>
        ${period === 'date_range' ? `
          <div class="field"><label>From</label><input type="date" id="fd-range-from" value="${esc(sel.rangeFrom || '')}"></div>
          <div class="field"><label>To</label><input type="date" id="fd-range-to" value="${esc(sel.rangeTo || '')}"></div>
        ` : ''}
      </div>
      <div class="spacer"></div>
    </div>
    <div id="fd-body" style="margin-top:14px">Loading…</div>
  `;
  root.querySelector('#fd-year').onchange = (e) => load(root, years, terms, { ...sel, academic_year_id: e.target.value, term_id: '' }, access);
  root.querySelector('#fd-term').onchange = (e) => load(root, years, terms, { ...sel, term_id: e.target.value }, access);
  root.querySelector('#fd-period').onchange = (e) => load(root, years, terms, { ...sel, period: e.target.value }, access);
  const rangeFromEl = root.querySelector('#fd-range-from');
  const rangeToEl = root.querySelector('#fd-range-to');
  if (rangeFromEl) rangeFromEl.onchange = (e) => load(root, years, terms, { ...sel, rangeFrom: e.target.value }, access);
  if (rangeToEl) rangeToEl.onchange = (e) => load(root, years, terms, { ...sel, rangeTo: e.target.value }, access);

  // Quick actions just switch Finance's own tab bar — same clickTab()
  // trick fd-tile-balances already used below, so these stay consistent
  // with how every other cross-tab jump on this screen works.
  const clickTab = (key) => { const t = document.querySelector(`[data-tab="${key}"]`); if (t) t.click(); };
  const qaReminder = root.querySelector('#fd-qa-reminder');
  if (qaReminder) qaReminder.onclick = () => clickTab('reminders');
  const qaCollect = root.querySelector('#fd-qa-collect');
  if (qaCollect) qaCollect.onclick = () => clickTab('collections');
  const qaBalances = root.querySelector('#fd-qa-balances');
  if (qaBalances) qaBalances.onclick = () => clickTab('reports');

  const range = resolvePeriodRange(period, sel, years, terms);
  // bucketRange no longer caps or trims anything itself (see its own
  // comment) — it just lays out every month/day in the raw range. The
  // actual "what window do we show" decision happens below, once we know
  // which buckets have real activity.
  const { granularity, buckets, displayFrom } = bucketRange(range.from, range.to);
  const displayRange = { from: displayFrom, to: range.to };
  const rangeFrom = range.from.toISOString().slice(0, 10);
  const rangeTo = range.to.toISOString().slice(0, 10);
  const [res, cashbookRes, expensesRes] = await Promise.all([
    Db.finance.reports.dashboard(sel.academic_year_id || null, sel.term_id || null),
    Db.finance.reports.cashbook(rangeFrom, rangeTo),
    Db.finance.expenses.list({ from: rangeFrom, to: rangeTo })
  ]);
  const body = root.querySelector('#fd-body');
  if (!res.ok) { body.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const d = res.data || {};
  // Income vs Expenses: bucket the cashbook's individual receipts and the
  // expenses list's individual records into the same day/month keys the
  // selected Period resolved to — both best-effort (".ok ? .data : []") so a
  // report RPC hiccup degrades to an empty trend rather than breaking the
  // whole Dashboard tab. matchKey compares on the granularity bucketRange()
  // picked: "YYYY-MM-DD" for a day-level period (Today/This Week/a short
  // Date Range), "YYYY-MM" for a month-level one (This Term/This Month
  // spanning weeks/Academic Year/a long Date Range).
  const cashbookRows = cashbookRes.ok ? cashbookRes.data : [];
  const expenseRows = (expensesRes.ok ? expensesRes.data : []).filter((e) => e.status !== 'void');
  const keyLen = granularity === 'day' ? 10 : 7;
  const monthlyRows = buckets.map((b) => {
    const income = cashbookRows
      .filter((r) => String(r.collection_date || '').slice(0, keyLen) === b.key)
      .reduce((s, r) => s + Number(r.amount || 0), 0);
    const expense = expenseRows
      .filter((e) => String(e.expense_date || '').slice(0, keyLen) === b.key)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    // dateLabel keeps the full date for the bar's hover tooltip even when
    // the on-axis `label` below gets thinned out for space. `key` is kept
    // too (not used for rendering) so the month-anchoring logic below can
    // turn "first bucket with real activity" back into an actual Date.
    return { key: b.key, label: b.label, dateLabel: b.label, income, expense };
  });
  // A day-granularity range longer than ~2 weeks (This Month, a longer
  // Date Range) still draws one bar per day — that's the useful part — but
  // printing a date under every single bar produces the exact unreadable
  // run-together text main.css's own Collections Per Class fix already
  // dealt with once this session. Thin the on-axis labels to ~8 evenly
  // spaced ones (always including the last day) instead; the full date is
  // still there on hover via dateLabel above.
  if (granularity === 'day' && monthlyRows.length > 10) {
    const stride = Math.ceil(monthlyRows.length / 8);
    const lastIdx = monthlyRows.length - 1;
    const lastStridedIdx = Math.floor(lastIdx / stride) * stride;
    monthlyRows.forEach((r, i) => {
      const isStrided = i % stride === 0;
      // The final day always gets a label EXCEPT when it would land right
      // next to the last regular strided one (e.g. stride=6 landing on day
      // 42 with only 45 days total) — closer than half a stride apart, two
      // dates would collide into unreadable overlapping text.
      const isLast = i === lastIdx && (lastIdx - lastStridedIdx > stride / 2 || lastIdx === 0);
      if (!isStrided && !isLast) r.label = '';
    });
  }
  // Live feedback: "if a school is created, the first month should be when
  // it's created or when transactions start to be recorded" — a school
  // whose academic year began months before it actually started using
  // ShuleTop (or before its first fee payment) was showing 1-2 completely
  // blank leading bars (e.g. Jun/Jul empty, Aug the real first month) on
  // every month-granularity view. Anchor the display window on the first
  // bucket that actually has income or an expense instead of blindly
  // trusting the period's raw start date, then apply the existing 4-month
  // readability cap (see bucketRange's comment) on TOP of that trimmed
  // window rather than before it, so it still counts from the right end —
  // "cap the tail" for a long-running school, never "reintroduce the
  // blank head" for a new one. Day-granularity views (Today/This
  // Week/short Date Range) are left untouched — they're too short to ever
  // hit this, and the thinning above already handles their own labels.
  let displayRows = monthlyRows;
  let trimmedEmpty = false;
  let capped = false;
  if (granularity === 'month') {
    const MAX_MONTHS = 4;
    const firstActiveIdx = monthlyRows.findIndex((r) => r.income > 0 || r.expense > 0);
    if (firstActiveIdx > 0) {
      displayRows = monthlyRows.slice(firstActiveIdx);
      trimmedEmpty = true;
    }
    // No activity anywhere in the whole range (brand-new school, nothing
    // recorded yet) — nothing to anchor on, so fall back to the original
    // "most recent N months" window rather than showing the entire year of
    // zeros.
    if (displayRows.length > MAX_MONTHS) {
      displayRows = displayRows.slice(displayRows.length - MAX_MONTHS);
      capped = true;
    }
    if (displayRows.length) {
      // Mutates the same Date object displayRange.from already points at,
      // so the subtitle below reflects the trimmed/capped window too.
      const [fy, fm] = displayRows[0].key.split('-').map(Number);
      displayFrom.setFullYear(fy, fm - 1, 1);
    }
  }
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
    <div class="fin-chart-feature">
      <div class="card side-accent tile-indigo">
        <!-- Live feedback: centered title, "Comparison across classes"
             subtitle dropped as redundant, and the card-h's usual
             border-bottom removed here specifically (border:none inline) —
             all three only for this card, not a sitewide card-h change. -->
        <div class="card-h" style="justify-content:center;border-bottom:none;padding-bottom:6px"><h3 style="text-align:center">Class Budget vs Paid</h3></div>
        <div class="card-b" style="padding-top:0">${budgetVsPaidChart(d.per_class)}</div>
      </div>
      <div class="fin-two-col">
        <div class="card side-accent tile-rose">
          <div class="card-h" style="flex-direction:column;align-items:flex-start;gap:2px"><h3>Class Balances Distribution</h3><span class="muted" style="font-size:12px">Outstanding balances by class</span></div>
          <div class="card-b">${classBalancesPie(d.per_class)}</div>
        </div>
        <div class="card side-accent tile-blue">
          <div class="card-h" style="flex-direction:column;align-items:flex-start;gap:2px"><h3>Income vs Expenses</h3><span class="muted" style="font-size:12px">${esc(periodSubtitle(period, displayRange, { trimmedEmpty, capped }))}</span></div>
          <div class="card-b">${incomeExpenseChart(displayRows)}</div>
        </div>
      </div>
    </div>
    <div class="card side-accent tile-amber" style="margin-top:16px">
      <div class="card-h"><h3>Collections Per Class</h3></div>
      <div class="card-b table-wrap"><table class="data fin-collections-table">
        <thead><tr><th>Class</th><th class="num">Expected</th><th class="num">Collected</th><th>% Collected</th></tr></thead>
        <tbody>${(d.per_class || []).map((c) => `<tr>
          <td>${esc(c.class_name)}</td>
          <td class="num">${Number(c.expected || 0).toLocaleString()}</td>
          <td class="num">${Number(c.collected || 0).toLocaleString()}</td>
          <td><div class="fin-progress-row"><div class="fin-progress"><div class="fin-progress-fill ${progressColorClass(c.pct || 0)}" style="width:${Math.min(100, c.pct || 0)}%"></div></div><span class="fin-progress-pct">${c.pct || 0}%</span></div></td>
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
