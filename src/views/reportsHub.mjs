/**
 * reportsHub.mjs — "Reports" landing page (feature brief: "avoid so many
 * submodules just have them as icons"). Same idea as examsHub.mjs — a flat
 * sidebar entry, icon tiles, each just a `go()` to an existing screen.
 */
import { go } from '../app.js';

const TILES = [
  { ico: '📋', title: 'Class List', desc: 'Print the list of students in a class.', route: 'class-list' },
  { ico: '📊', title: 'Mark List', desc: 'Students × subjects, with grades, points and position.', route: 'broadsheet' },
  { ico: '📈', title: 'Exam Analysis', desc: 'Top students and class-wide performance analysis for an exam.', route: 'exam-analysis' },
  { ico: '📝', title: 'Score Sheet', desc: 'A blank, printable scoring sheet for one class and learning area.', route: 'score-sheet' },
  { ico: '🧾', title: 'Report Forms', desc: "Print a student's or a whole class's report forms.", route: 'reports' },
  { ico: '📜', title: 'Transcript', desc: "A student's results across multiple exams/terms.", route: 'transcript' },
  { ico: '🎓', title: 'Leaving Certificate', desc: 'Print a certificate for a student who is leaving.', route: 'certificates' }
];

export async function viewReportsHub(root) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Reports</h2><p>Everything printable, in one place.</p></div></div>
    <div class="hub-grid">
      ${TILES.map((t) => `<button class="hub-tile" data-route="${t.route}">
        <div class="h-ico">${t.ico}</div>
        <div class="h-title">${t.title}</div>
        <div class="h-desc">${t.desc}</div>
      </button>`).join('')}
    </div>
  `;

  root.querySelectorAll('[data-route]').forEach((b) => b.onclick = () => go(b.dataset.route));
}
