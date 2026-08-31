import { esc, go, options, state } from '../app.js';
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

// Boys/Girls visual upgrade (design standard brief item 8, approved option
// A — reference: a horizontal proportional split-bar, blue for boys, pink
// for girls). Purely a visual addition in the space already there below
// the two counts — the counts/markup around it are otherwise unchanged.
function genderBarHtml(m, f) {
  const total = (m || 0) + (f || 0);
  const bPct = total ? (m / total * 100) : 50;
  const gPct = total ? (f / total * 100) : 50;
  return `<div class="gender-bar"><div class="gb-b" style="width:${bPct}%"></div><div class="gb-g" style="width:${gPct}%"></div></div>`;
}
function genderTile(gender) {
  return `<div class="stat stat-blue gender-tile">
    <div class="s-ico t-blue">🚻</div>
    <div class="s-body">
      <div class="g-side"><div class="g-num" style="color:#2563eb">${gender.M || 0}</div><div class="g-lab">Boys</div></div>
      <div class="g-side"><div class="g-num" style="color:#db2777">${gender.F || 0}</div><div class="g-lab">Girls</div></div>
    </div>
    ${genderBarHtml(gender.M, gender.F)}
  </div>`;
}

export async function viewDashboard(root) {
  // Phase 1: paint the shell immediately — header, tile skeletons (still
  // clickable, since routes are static), empty gender/per-class cards. No
  // await before this point.
  root.innerHTML = `
    <div class="page-head"><div><h2>${greetingWord()}, ${esc(firstName())}</h2><p>Here is what's happening at ${esc((state.settings && state.settings.school_name) || 'your school')}.</p></div></div>
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
      <div class="card side-accent tile-blue dash-gender-desktop">
        <div class="card-h"><h3>Students by gender</h3></div>
        <div class="card-b"><div class="skeleton" style="width:100%;height:48px"></div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Students per class</h3></div>
      <div class="card-b table-wrap">
        <table class="data"><thead><tr><th>Class</th><th class="num">Students</th></tr></thead>
        <tbody><tr><td colspan="2"><div class="skeleton" style="width:100%;height:16px"></div></td></tr></tbody></table>
      </div>
    </div>
  `;
  root.querySelectorAll('.stat.clickable[data-route]').forEach((tile) => {
    tile.onclick = () => go(tile.getAttribute('data-route'));
  });

  // Phase 2: fetch the real numbers and replace the skeleton with the full
  // render (same markup this view has always produced) once they arrive.
  const res = await Db.dashboard.get();
  if (!res.ok) { root.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
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
          <div class="g-div"></div>
          <div class="g-side"><div class="g-num" style="color:#db2777">${gender.F}</div><div class="g-lab">Girls</div></div>
        </div>
        ${genderBarHtml(gender.M, gender.F)}
      </div>`
    : `<div class="card-b"><p class="muted" style="margin:0">No active students yet.</p></div>`;

  const perClassRows = perClass.length
    ? perClass.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.count}</td></tr>`).join('')
    : `<tr><td colspan="2" class="muted center">No classes yet.</td></tr>`;

  // Academic year/term now live inside Settings' "Academic Years & Terms"
  // tab rather than their own route — data-tab tells the click handler
  // below which tab to open once there.
  const checklistHtml = checklist.map((c) => `
    <li class="${c.done ? 'done' : ''}" data-route="${c.route.replace('#/', '')}" ${c.key === 'academic_year' || c.key === 'term' ? 'data-tab="calendar"' : ''}>
      <div class="ck ${c.done ? 'done' : 'todo'}">${c.done ? '✓' : ''}</div>
      <div class="lab">${esc(c.label)}</div>
    </li>`).join('');

  root.innerHTML = `
    <div class="page-head"><div><h2>${greetingWord()}, ${esc(firstName())}</h2><p>Here is what's happening at ${esc((state.settings && state.settings.school_name) || 'your school')}.</p></div></div>
    <div class="stats-mobile">${mobileTiles}</div>
    <div class="dash-top-row">
      <div class="stats-desktop">${desktopTiles}</div>
      <div class="card side-accent tile-blue dash-gender-desktop">
        <div class="card-h"><h3>Students by gender</h3></div>
        ${genderBlock}
      </div>
    </div>
    <div class="card side-accent tile-blue">
      <div class="card-h"><h3>Students per class</h3></div>
      <div class="card-b table-wrap">
        <table class="data"><thead><tr><th>Class</th><th class="num">Students</th></tr></thead>
        <tbody>${perClassRows}</tbody></table>
      </div>
    </div>
    <div class="card" id="dash-examgraph" style="margin-top:20px"></div>
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
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  // listExams() already sorts newest-first, so [0] is the most recently
  // created exam — the best available stand-in for "last exam analyzed"
  // without a separate "last published/analyzed at" timestamp to sort by.
  if (!exams.length || !classes.length) {
    el.innerHTML = `<div class="card-h"><h3>Last Exam Analyzed</h3></div>
      <div class="card-b"><div class="empty"><div class="e-ico">📊</div><h3>No exams found</h3>
      <p>Once you create and publish an exam, subject performance shows up here.</p></div></div>`;
    return;
  }
  const exam = exams[0];
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
  await renderForClass(classes[0].id);
}
