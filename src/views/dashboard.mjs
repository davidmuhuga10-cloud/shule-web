import { esc, go, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { setNavIntent } from '../lib/navIntent.mjs';

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
function statTile(ico, val, lab, cls, route) {
  return `<div class="stat${route ? ' clickable' : ''}"${route ? ` data-route="${esc(route)}"` : ''}>
    <div class="s-ico ${cls}">${ico}</div>
    <div><div class="s-val">${val}</div><div class="s-lab">${lab}</div></div>
  </div>`;
}

function genderTile(gender) {
  return `<div class="stat gender-tile">
    <div class="s-ico t-blue">🚻</div>
    <div class="s-body">
      <div class="g-side"><div class="g-num" style="color:#2563eb">${gender.M || 0}</div><div class="g-lab">Boys</div></div>
      <div class="g-side"><div class="g-num" style="color:#db2777">${gender.F || 0}</div><div class="g-lab">Girls</div></div>
    </div>
  </div>`;
}

export async function viewDashboard(root) {
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
        <div class="g-side"><div class="g-num" style="color:#2563eb">${gender.M}</div><div class="g-lab">Boys</div></div>
        <div class="g-div"></div>
        <div class="g-side"><div class="g-num" style="color:#db2777">${gender.F}</div><div class="g-lab">Girls</div></div>
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
      <div class="card dash-gender-desktop">
        <div class="card-h"><h3>Students by gender</h3></div>
        ${genderBlock}
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Students per class</h3></div>
      <div class="card-b table-wrap">
        <table class="data"><thead><tr><th>Class</th><th class="num">Students</th></tr></thead>
        <tbody>${perClassRows}</tbody></table>
      </div>
    </div>
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
}
