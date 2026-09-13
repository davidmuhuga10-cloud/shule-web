import { esc, go, options, state, renderPrereqOrConnectivity } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { setNavIntent } from '../lib/navIntent.mjs';
import { buildExamAnalysis } from '../lib/examAnalysis.mjs';

/** First name + a time-of-day greeting (feature brief: "On login... pick
 *  the first name of user and greet him/her eg Good morning David"). */
function greetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function firstName() {
  return ((state.profile && state.profile.name) || '').trim().split(/\s+/)[0] || '';
}

// Dashboard hero band (design review round 5, approved): replaces the plain
// .page-head greeting with a teal band (matching the app's brand colour)
// plus three quick-action chips that jump straight to the screens an admin
// most often lands on the dashboard to reach. Static — doesn't depend on
// the dashboard's own data fetch — so it's identical in the Phase 1
// skeleton and the Phase 2 full render, same as the old .page-head was.
function heroHtml() {
  return `<div class="dash-hero">
    <div>
      <h2>${greetingWord()}, ${esc(firstName())}</h2>
      <p>Here is what's happening at ${esc((state.settings && state.settings.school_name) || 'your school')}.</p>
    </div>
    <div class="dash-hero-actions">
      <button type="button" class="hero-chip" data-hero-route="students">🎒 Add Student</button>
      <button type="button" class="hero-chip" data-hero-route="staff-teachers">👨‍🏫 Add a Teacher</button>
      <button type="button" class="hero-chip" data-hero-route="messaging">📢 Send Announcement</button>
    </div>
  </div>`;
}
function wireHeroActions(root) {
  root.querySelectorAll('.hero-chip[data-hero-route]').forEach((btn) => {
    btn.onclick = () => {
      const route = btn.getAttribute('data-hero-route');
      if (route === 'staff-teachers') setNavIntent('staff-teachers', { tab: 'teachers' });
      go(route);
    };
  });
}

// Phase 2f (brief §2/§3): the mobile and desktop dashboards intentionally show
// DIFFERENT tile sets — desktop is a clean 2×2 of the four core setup metrics,
// mobile fits 6 (adding Teachers, Bulk SMS Balance and a combined Gender tile)
// since a phone screen has more vertical room to scroll through a 3-row grid
// than a laptop has to spare above the fold. Both groups are rendered up
// front and toggled purely by CSS (@media max-width:960px in main.css) so
// there's no JS matchMedia/resize logic to keep in sync.
// route: brief D1 — "the first 4 dashboard tiles (Students, Classes,
// Streams, Teachers) must be clickable" and jump straight to that module.
// UI colour refresh (brief item 4, round 2): each tile's accent border
// reuses the exact same t-* hue its icon badge already uses — CAT_ACCENT
// maps the icon class to the border-only class (see main.css's .stat-*).
const CAT_ACCENT = { 't-blue': 'stat-blue', 't-green': 'stat-green', 't-amber': 'stat-amber', 't-purple': 'stat-purple', 't-teal': 'stat-teal', 't-rose': 'stat-rose' };
function statTile(ico, val, lab, cls, route) {
  const accent = CAT_ACCENT[cls] || '';
  return `<div class="stat ${accent}${route ? ' clickable' : ''}"${route ? ` data-route="${esc(route)}"` : ''}>
    <div class="s-ico ${cls}">${ico}</div>
    <div><div class="s-val">${val}</div><div class="s-lab">${lab}</div></div>
  </div>`;
}

// Desktop SMS tile (approved layout, round 2): icon on its own line, then
// the balance, then "Bulk SMS Balance" below it, all centered — distinct
// from the standard icon-beside-text stat tile used everywhere else, so
// its own modifier class (.stat-vertical) rather than changing statTile()
// itself and affecting every other tile on the dashboard.
function statTileVertical(ico, val, lab, cls) {
  const accent = CAT_ACCENT[cls] || '';
  return `<div class="stat stat-vertical ${accent}">
    <div class="s-ico ${cls}">${ico}</div>
    <div class="s-val">${val}</div>
    <div class="s-lab">${lab}</div>
  </div>`;
}
function statTileVerticalSkeleton(ico, lab, cls) {
  const accent = CAT_ACCENT[cls] || '';
  return `<div class="stat stat-vertical ${accent}">
    <div class="s-ico ${cls}">${ico}</div>
    <div class="skeleton" style="width:48px;height:26px;margin:0 auto 6px"></div>
    <div class="s-lab">${lab}</div>
  </div>`;
}

// Perf/UX fix: the dashboard used to await the whole (now-single-round-trip,
// but still non-zero-latency) data fetch before rendering ANY markup — a
// blank page under the router's generic spinner the whole time. Tiles,
// headers and nav are static (the tile labels/icons/routes don't depend on
// the fetch — only the numeric VALUES do), so this renders that shell with
// skeleton placeholders FIRST, wires up tile clicks immediately (a school's
// admin can navigate to Students/Classes/etc. before the dashboard's own
// numbers have even loaded), then fills in real numbers once the fetch
// resolves — instead of a blank screen, then everything at once.
function statTileSkeleton(ico, lab, cls, route) {
  const accent = CAT_ACCENT[cls] || '';
  return `<div class="stat ${accent}${route ? ' clickable' : ''}"${route ? ` data-route="${esc(route)}"` : ''}>
    <div class="s-ico ${cls}">${ico}</div>
    <div><div class="skeleton" style="width:38px;margin-bottom:6px"></div><div class="s-lab">${lab}</div></div>
  </div>`;
}

// "Students by gender" gauge (approved redesign): a downward-facing arc
// (like a speedometer dial) split proportionally between boys (blue) and
// girls (pink), placed inline between the two counts. Used both on the
// desktop panel (full size) and the mobile combined tile (smaller, via the
// `size` param) — replaces the older straight split-bar on both.
function polarPoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}
function arcPath(cx, cy, r, startAngle, endAngle) {
  const start = polarPoint(cx, cy, r, startAngle);
  const end = polarPoint(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}
function genderGaugeHtml(m, f, size) {
  const total = (m || 0) + (f || 0);
  const bPct = total ? m / total : 0.5;
  const cx = 110, cy = 100, r = 80, sw = 20;
  const gapDeg = total ? 3 : 0; // small visual separation between the two segments
  const split = -90 + bPct * 180;
  const boysEnd = total && f > 0 ? split - gapDeg / 2 : split;
  const girlsStart = total && m > 0 ? split + gapDeg / 2 : split;
  const boysArc = m > 0 ? `<path d="${arcPath(cx, cy, r, -90, boysEnd)}" fill="none" stroke="#2563eb" stroke-width="${sw}" stroke-linecap="round"/>` : '';
  const girlsArc = f > 0 ? `<path d="${arcPath(cx, cy, r, girlsStart, 90)}" fill="none" stroke="#db2777" stroke-width="${sw}" stroke-linecap="round"/>` : '';
  const pct = total ? Math.round(bPct * 100) : 50;
  const sizeAttr = size ? ` style="width:${size}px"` : '';
  return `<svg class="gender-gauge"${sizeAttr} viewBox="0 0 220 116" role="img" aria-label="${pct}% boys, ${100 - pct}% girls">
    <path d="${arcPath(cx, cy, r, -90, 90)}" fill="none" stroke="var(--line)" stroke-width="${sw}" stroke-linecap="round"/>
    ${boysArc}
    ${girlsArc}
  </svg>`;
}
// Mobile combined gender tile — now uses the same inline arc gauge as the
// desktop panel (design approved), sized down (60px) to fit the narrower
// tile, replacing the older straight split-bar (genderBarHtml, kept below
// only as dead code history/reference — no longer called here).
function genderTile(gender) {
  return `<div class="stat stat-blue gender-tile">
    <div class="s-ico t-blue">🚻</div>
    <div class="s-body">
      <div class="g-side"><div class="g-num" style="color:#2563eb">${gender.M || 0}</div><div class="g-lab">Boys</div></div>
      <div class="g-mid">${genderGaugeHtml(gender.M, gender.F, 60)}</div>
      <div class="g-side"><div class="g-num" style="color:#db2777">${gender.F || 0}</div><div class="g-lab">Girls</div></div>
    </div>
  </div>`;
}

// "Students per Class" (design review round 5, approved): a vertical bar
// per class with a real Y axis, replacing the old plain table. Same
// nice-step axis maths financeDashboard.mjs's own charts already use
// (budgetVsPaidChart et al.) so this reads as the same house style, just
// applied to headcounts instead of currency. Bar colour flags relative
// class size (teal = well filled, amber = mid, red = thin) rather than a
// fixed absolute cutoff, so this holds up for schools of any size.
function studentsPerClassChart(perClass) {
  if (!perClass.length) return '<div class="chart-empty muted">No classes yet.</div>';
  const W = 640, H = 220, padL = 34, padR = 12, padT = 20, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...perClass.map((c) => c.count || 0));
  const rawStep = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || mag * 10;
  const axisMax = niceStep * 4;
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const groupW = plotW / perClass.length;
  const barW = Math.min(34, groupW * 0.5);
  const gridlines = [0, 1, 2, 3, 4].map((i) => {
    const v = niceStep * i;
    const yy = y(v);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="chart-grid"/>
      <text x="${padL - 6}" y="${yy + 3}" class="chart-axis-label" text-anchor="end">${Math.round(v)}</text>`;
  }).join('');
  const bars = perClass.map((c, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const v = c.count || 0;
    const barH = plotH - (y(v) - padT);
    const ratio = v / maxVal;
    const fill = ratio >= 0.65 ? '#127a6b' : ratio >= 0.3 ? '#f5a623' : '#d64545';
    return `
      <rect x="${(cx - barW / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, barH).toFixed(1)}" rx="3" fill="${fill}"><title>${esc(c.name)}: ${v} students</title></rect>
      <text x="${cx.toFixed(1)}" y="${(y(v) - 6).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--ink)">${v}</text>
      <text x="${cx.toFixed(1)}" y="${H - padB + 16}" class="chart-axis-label" text-anchor="middle">${esc(truncateClassLabel(c.name))}</text>
    `;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Students per class">
    ${gridlines}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="chart-axis-line"/>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="chart-axis-line"/>
    ${bars}
  </svg>`;
}
function truncateClassLabel(name) {
  const s = String(name || '');
  return s.length > 9 ? s.slice(0, 8) + '…' : s;
}

// "Gender by Class" (design review round 5, approved): grouped boys/girls
// bars per class, same axis maths as above, blue/pink matching the
// existing gender gauge's colours.
function genderByClassChart(perClass) {
  if (!perClass.length) return '<div class="chart-empty muted">No classes yet.</div>';
  const W = 640, H = 220, padL = 34, padR = 12, padT = 20, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxVal = Math.max(1, ...perClass.map((c) => Math.max(c.M || 0, c.F || 0)));
  const rawStep = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
  const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || mag * 10;
  const axisMax = niceStep * 4;
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const groupW = plotW / perClass.length;
  const barW = Math.min(14, groupW * 0.22);
  const gap = Math.min(4, groupW * 0.06);
  const gridlines = [0, 1, 2, 3, 4].map((i) => {
    const v = niceStep * i;
    const yy = y(v);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="chart-grid"/>
      <text x="${padL - 6}" y="${yy + 3}" class="chart-axis-label" text-anchor="end">${Math.round(v)}</text>`;
  }).join('');
  const bars = perClass.map((c, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const m = c.M || 0, f = c.F || 0;
    const mH = plotH - (y(m) - padT), fH = plotH - (y(f) - padT);
    return `
      <rect x="${(cx - barW - gap / 2).toFixed(1)}" y="${y(m).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, mH).toFixed(1)}" rx="2.5" class="chart-bar-boys"><title>${esc(c.name)} — Boys: ${m}</title></rect>
      <rect x="${(cx + gap / 2).toFixed(1)}" y="${y(f).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, fH).toFixed(1)}" rx="2.5" class="chart-bar-girls"><title>${esc(c.name)} — Girls: ${f}</title></rect>
      <text x="${(cx - barW - gap / 2 + barW / 2).toFixed(1)}" y="${(y(m) - 6).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="var(--ink)">${m}</text>
      <text x="${(cx + gap / 2 + barW / 2).toFixed(1)}" y="${(y(f) - 6).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="var(--ink)">${f}</text>
      <text x="${cx.toFixed(1)}" y="${H - padB + 16}" class="chart-axis-label" text-anchor="middle">${esc(truncateClassLabel(c.name))}</text>
    `;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Gender split per class">
    ${gridlines}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="chart-axis-line"/>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="chart-axis-line"/>
    ${bars}
  </svg>
  <div class="chart-legend"><span><i class="chart-swatch chart-bar-boys"></i>Boys</span><span><i class="chart-swatch chart-bar-girls"></i>Girls</span></div>`;
}

export async function viewDashboard(root) {
  // Phase 1: paint the shell immediately — header, tile skeletons (still
  // clickable, since routes are static), empty gender/per-class cards. No
  // await before this point.
  root.innerHTML = `
    ${heroHtml()}
    <div class="stats-mobile">${[
      statTileSkeleton('🎒', 'Students', 't-blue', 'students'),
      statTileSkeleton('🏫', 'Classes', 't-amber', 'classes'),
      statTileSkeleton('🔀', 'Streams', 't-purple', 'classes'),
      statTileSkeleton('👨‍🏫', 'Teachers', 't-green', 'staff-teachers'),
      statTileSkeleton('💬', 'Bulk SMS Balance', 't-teal'),
      `<div class="stat stat-blue gender-tile"><div class="s-ico t-blue">🚻</div><div class="skeleton" style="width:100%;height:32px"></div></div>`
    ].join('')}</div>
    <div class="dash-top-row">
      <div class="stats-desktop">${[
        statTileSkeleton('🎒', 'Students', 't-blue', 'students'),
        statTileSkeleton('🏫', 'Classes', 't-amber', 'classes'),
        statTileSkeleton('🔀', 'Streams', 't-purple', 'classes'),
        statTileSkeleton('👨‍🏫', 'Teachers', 't-green', 'staff-teachers')
      ].join('')}</div>
      <div class="dash-sms-tile">${statTileVerticalSkeleton('💬', 'Bulk SMS Balance', 't-rose')}</div>
      <div class="card side-accent tile-blue dash-gender-desktop">
        <div class="card-h"><h3>Students by gender</h3></div>
        <div class="card-b"><div class="skeleton" style="width:100%;height:48px"></div></div>
      </div>
    </div>
    <div class="dash-chart-row">
      <div class="card side-accent tile-blue">
        <div class="card-h" style="justify-content:center"><h3>Students per Class</h3></div>
        <div class="card-b"><div class="skeleton" style="width:100%;height:210px"></div></div>
      </div>
      <div class="card side-accent tile-indigo">
        <div class="card-h" style="justify-content:center"><h3>Gender by Class</h3></div>
        <div class="card-b"><div class="skeleton" style="width:100%;height:210px"></div></div>
      </div>
    </div>
  `;
  root.querySelectorAll('.stat.clickable[data-route]').forEach((tile) => {
    tile.onclick = () => go(tile.getAttribute('data-route'));
  });
  wireHeroActions(root);

  // Phase 2: fetch the real numbers and replace the skeleton with the full
  // render (same markup this view has always produced) once they arrive.
  const res = await Db.dashboard.get();
  // BUG FIX (live report — Dashboard showed a plain generic error box while
  // offline instead of the shared "You're offline" screen every other
  // module now shows). Same connectivity-aware screen, with a working
  // "Try again" retry button, instead of a dead-end error line.
  if (!res.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewDashboard(root) });
    return;
  }
  const { counts, smsBalance, gender, perClass, checklist, setupComplete } = res;

  const desktopTiles = [
    statTile('🎒', counts.students, 'Students', 't-blue', 'students'),
    statTile('🏫', counts.classes, 'Classes', 't-amber', 'classes'),
    statTile('🔀', counts.streams, 'Streams', 't-purple', 'classes'),
    statTile('👨‍🏫', counts.teachers, 'Teachers', 't-green', 'staff-teachers')
  ].join('');

  const smsLabel = smsBalance === null || smsBalance === undefined || smsBalance === '' ? '—' : esc(String(smsBalance));
  const mobileTiles = [
    statTile('🎒', counts.students, 'Students', 't-blue', 'students'),
    statTile('🏫', counts.classes, 'Classes', 't-amber', 'classes'),
    statTile('🔀', counts.streams, 'Streams', 't-purple', 'classes'),
    statTile('👨‍🏫', counts.teachers, 'Teachers', 't-green', 'staff-teachers'),
    statTile('💬', smsLabel, 'Bulk SMS Balance', 't-teal'),
    genderTile(gender)
  ].join('');

  const totalStudents = (gender.M || 0) + (gender.F || 0);
  const genderBlock = totalStudents
    ? `<div class="card-b gender-panel">
        <div class="g-row">
          <div class="g-side"><div class="g-num" style="color:#2563eb">${gender.M}</div><div class="g-lab">Boys</div></div>
          <div class="g-mid">${genderGaugeHtml(gender.M, gender.F)}</div>
          <div class="g-side"><div class="g-num" style="color:#db2777">${gender.F}</div><div class="g-lab">Girls</div></div>
        </div>
      </div>`
    : `<div class="card-b"><p class="muted" style="margin:0">No active students yet.</p></div>`;

  // Academic year/term now live inside Settings' "Academic Years & Terms"
  // tab rather than their own route — data-tab tells the click handler
  // below which tab to open once there.
  const checklistHtml = checklist.map((c) => `
    <li class="${c.done ? 'done' : ''}" data-route="${c.route.replace('#/', '')}" ${c.key === 'academic_year' || c.key === 'term' ? 'data-tab="calendar"' : ''}>
      <div class="ck ${c.done ? 'done' : 'todo'}">${c.done ? '✓' : ''}</div>
      <div class="lab">${esc(c.label)}</div>
    </li>`).join('');

  root.innerHTML = `
    ${heroHtml()}
    <div class="stats-mobile">${mobileTiles}</div>
    <div class="dash-top-row">
      <div class="stats-desktop">${desktopTiles}</div>
      <div class="dash-sms-tile">${statTileVertical('💬', smsLabel, 'Bulk SMS Balance', 't-rose')}</div>
      <div class="card side-accent tile-blue dash-gender-desktop">
        <div class="card-h"><h3>Students by gender</h3></div>
        ${genderBlock}
      </div>
    </div>
    <div class="dash-chart-row">
      <div class="card side-accent tile-blue">
        <div class="card-h" style="justify-content:center"><h3>Students per Class</h3></div>
        <div class="card-b">${studentsPerClassChart(perClass)}</div>
      </div>
      <div class="card side-accent tile-indigo">
        <div class="card-h" style="justify-content:center"><h3>Gender by Class</h3></div>
        <div class="card-b">${genderByClassChart(perClass)}</div>
      </div>
    </div>
    <div class="card side-accent tile-teal" id="dash-examgraph" style="margin-top:20px"></div>
    ${!setupComplete ? `<div class="card" style="margin-top:20px">
      <div class="card-h"><h3>Getting set up</h3></div>
      <div class="card-b"><ul class="checklist" id="setup-checklist">${checklistHtml}</ul></div>
    </div>` : ''}
  `;

  const list = root.querySelector('#setup-checklist');
  if (list) list.querySelectorAll('li[data-route]').forEach((li) => {
    li.onclick = () => {
      const route = li.getAttribute('data-route');
      if (li.dataset.tab) setNavIntent(route, { tab: li.dataset.tab });
      go(route);
    };
  });

  root.querySelectorAll('.stat.clickable[data-route]').forEach((tile) => {
    tile.onclick = () => go(tile.getAttribute('data-route'));
  });
  wireHeroActions(root);

  // Phase 3 (brief item 5): "Last Exam Analyzed" — its own small fetch,
  // kicked off after the main dashboard has already painted rather than
  // holding up everything above it. Built entirely from data the app
  // already computes for the Exam Analysis screen (buildExamAnalysis over
  // getBroadsheet()) — no new RPC/table, just reused here for one number
  // per subject (mean_marks) instead of the full report.
  loadExamGraph(root.querySelector('#dash-examgraph'));
}

async function loadExamGraph(el) {
  if (!el) return;
  const [examsRes, classesRes, lastPublishedRes] = await Promise.all([
    Db.results.listExams(), Db.classes.list(), Db.results.lastPublishedExamClass()
  ]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  if (!exams.length || !classes.length) {
    el.innerHTML = `<div class="card-h"><h3>Last Exam Analyzed</h3></div>
      <div class="card-b"><div class="empty"><div class="e-ico">📊</div><h3>No exams found</h3>
      <p>Once you create and publish an exam, subject performance shows up here.</p></div></div>`;
    return;
  }
  // BUG FIX (see lastPublishedExamClass()'s own comment in results.mjs):
  // prefer the exam that ACTUALLY has the most recently published results
  // anywhere in the school, not just the most recently CREATED exam —
  // otherwise a brand-new, not-yet-published exam permanently shadows an
  // older exam's real, fully analyzed results. Falls back to the old
  // newest-exam guess only when nothing has ever been published at all.
  const lastPublished = lastPublishedRes.ok ? lastPublishedRes.data : null;
  const examForLastPublished = lastPublished && exams.find((e) => e.id === lastPublished.exam_id);
  const exam = examForLastPublished || exams[0];
  const defaultClassId = examForLastPublished ? lastPublished.class_id : await pickDefaultExamClassId(exam, classes);
  const renderForClass = async (classId) => {
    el.innerHTML = `
      <div class="card-h" style="justify-content:space-between">
        <h3>Last Exam Analyzed <span class="muted" style="font-weight:500">— ${esc(exam.name)}</span></h3>
        <select id="dash-eg-class" style="max-width:200px">${options(classes, 'id', 'name', classId)}</select>
      </div>
      <div class="card-b" id="dash-eg-body"><div class="skeleton" style="width:100%;height:16px"></div></div>
    `;
    el.querySelector('#dash-eg-class').onchange = (e) => renderForClass(e.target.value);
    const body = el.querySelector('#dash-eg-body');
    const bsRes = await Db.results.getBroadsheet({ exam_id: exam.id, class_id: classId });
    if (!bsRes.ok || !bsRes.students.length || !bsRes.subjects.length) {
      body.innerHTML = `<p class="muted" style="margin:0">No published results yet for this class in ${esc(exam.name)}.</p>`;
      return;
    }
    const analysis = buildExamAnalysis(bsRes, []);
    const bySubject = analysis.per_subject.slice().sort((a, b) => b.mean_marks - a.mean_marks);
    const maxMark = Math.max(1, ...bySubject.map((s) => s.mean_marks));
    body.innerHTML = bySubject.map((s) => `
      <div class="dash-eg-row">
        <div class="dash-eg-lab">${esc(s.subject_name)}</div>
        <div class="dash-eg-track"><div class="dash-eg-fill" style="width:${(s.mean_marks / maxMark * 100).toFixed(1)}%"></div></div>
        <div class="dash-eg-val">${s.mean_marks.toFixed(1)}</div>
      </div>`).join('');
  };
  await renderForClass(defaultClassId);
}

/** Which class should "Last Exam Analyzed" open on by default, for the ONE
 *  exam being shown? loadExamGraph() above now only calls this as a
 *  fallback for the specific exam it already picked (either the exam with
 *  the school's most recently published results overall, via
 *  lastPublishedExamClass(), or — only when NOTHING has ever been
 *  published anywhere — the most recently created exam). So step 1 here
 *  is mostly a defensive re-check for that one exam; steps 2/3 are the
 *  genuine "nothing published yet at all" guesses:
 *   1. A class actually assigned to this exam with published/released
 *      results — picking the most recently published if more than one
 *      qualifies (kept for exactly the still-published-but-exam-no-longer-
 *      listed edge case; normally already covered by the caller).
 *   2. A "Grade 6"-ish class (by name), a reasonable stand-in default
 *      for "the class most likely to have exams" even before anything's
 *      been published yet this term.
 *   3. The oldest class by level_order (the opposite end of the list
 *      from Daycare/Playgroup) — still not guaranteed to have results,
 *      but a far better blind guess than the youngest class. */
async function pickDefaultExamClassId(exam, classes) {
  const ecRes = await Db.results.listExamClasses(exam.id);
  if (ecRes.ok && ecRes.data.length) {
    const withResults = ecRes.data.filter((r) => r.status === 'published' || r.status === 'released');
    if (withResults.length) {
      withResults.sort((a, b) => String(b.last_published_at || '').localeCompare(String(a.last_published_at || '')));
      return withResults[0].class_id;
    }
  }
  const grade6 = classes.find((c) => /\b(grade|class|std)\s*6\b/i.test(c.name || ''));
  if (grade6) return grade6.id;
  return classes[classes.length - 1].id;
}
