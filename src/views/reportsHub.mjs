/**
 * reportsHub.mjs — "Reports" landing page (feature brief: "avoid so many
 * submodules just have them as icons"). Same idea as examsHub.mjs — a flat
 * sidebar entry, icon tiles, each just a `go()` to an existing screen.
 */
import { go } from '../app.js';

// UI colour refresh (brief item 7, round 2 — approved option 2): a light
// accent border, one hue per tile, reusing the same .tile-* classes/hex
// values as the Dashboard's stat tiles for visual consistency across the
// two screens the brief singled out.
const TILES = [
  { ico: '📋', title: 'Class List', desc: 'Print the list of students in a class.', route: 'class-list', accent: 'tile-blue' },
  { ico: '📊', title: 'Mark List', desc: 'Students × subjects, with grades, points and position.', route: 'broadsheet', accent: 'tile-green' },
  { ico: '📈', title: 'Exam Analysis', desc: 'Top students and class-wide performance analysis for an exam.', route: 'exam-analysis', accent: 'tile-purple' },
  { ico: '📝', title: 'Score Sheet', desc: 'A blank, printable scoring sheet for one class and learning area.', route: 'score-sheet', accent: 'tile-amber' },
  { ico: '🧾', title: 'Report Forms', desc: "Print a student's or a whole class's report forms.", route: 'reports', accent: 'tile-teal' },
  { ico: '📜', title: 'Transcript', desc: "A student's results across multiple exams/terms.", route: 'transcript', accent: 'tile-rose' },
  { ico: '🎓', title: 'Leaving Certificate', desc: 'Print a certificate for a student who is leaving.', route: 'certificates', accent: 'tile-indigo' }
];

export async function viewReportsHub(root) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Reports</h2><p>Everything printable, in one place.</p></div></div>
    <div class="hub-grid">
      ${TILES.map((t) => `<button class="hub-tile ${t.accent}" data-route="${t.route}">
        <div class="h-ico">${t.ico}</div>
        <div class="h-title">${t.title}</div>
        <div class="h-desc">${t.desc}</div>
      </button>`).join('')}
    </div>
  `;

  root.querySelectorAll('[data-route]').forEach((b) => b.onclick = () => go(b.dataset.route));
}
