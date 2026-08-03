/**
 * examsHub.mjs — "Exams" landing page (feature brief: "avoid so many
 * submodules just have them as icons after I click exams... we can just
 * have icons e.g. create exams, manage exams... Grading system etc."). A
 * flat sidebar entry lands here first; each tile is just a `go()` to an
 * existing, unchanged screen — nothing about how those screens work
 * changes, only how you get to them.
 */
import { go, state } from '../app.js';

export async function viewExamsHub(root) {
  const isAdmin = state.profile && state.profile.role === 'admin';
  const tiles = [
    { ico: '📝', title: 'Manage Exams', desc: 'Create an exam, choose classes, and track marks entry through to publishing.', route: 'exams' },
    { ico: '✍️', title: 'Enter Marks', desc: "Record a class's marks for a subject.", route: 'marks' },
    { ico: '✅', title: 'Publish Results', desc: 'Review and publish marks so students and parents can see them.', route: 'publishing' },
    ...(isAdmin ? [{ ico: '🎯', title: 'Grading Scales', desc: 'The grade bands and points used to grade every score.', route: 'grading' }] : [])
  ];

  root.innerHTML = `
    <div class="page-head"><div><h2>Exams</h2><p>Everything to do with exams, in one place.</p></div></div>
    <div class="hub-grid">
      ${tiles.map((t) => `<button class="hub-tile" data-route="${t.route}">
        <div class="h-ico">${t.ico}</div>
        <div class="h-title">${t.title}</div>
        <div class="h-desc">${t.desc}</div>
      </button>`).join('')}
    </div>
  `;

  root.querySelectorAll('[data-route]').forEach((b) => b.onclick = () => go(b.dataset.route));
}
