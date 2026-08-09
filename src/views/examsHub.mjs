/**
 * examsHub.mjs — "Exams" landing page (feature brief: "avoid so many
 * submodules just have them as icons after I click exams... we can just
 * have icons e.g. create exams, manage exams... Grading system etc."). A
 * flat sidebar entry lands here first; each tile is just a `go()` to an
 * existing, unchanged screen — nothing about how those screens work
 * changes, only how you get to them.
 *
 * System Fixes brief §14: Manage Exams, Enter Marks and Publish Results are
 * now ONE combined module, "Exam Desk" — no more separate tiles for those
 * three. Brief §8 adds Deleted Exams (admin-only, like Grading Scales).
 */
import { go, state } from '../app.js';

export async function viewExamsHub(root) {
  const isAdmin = state.profile && state.profile.role === 'admin';
  const tiles = [
    { ico: '🗂️', title: 'Exam Desk', desc: 'Create an exam, choose classes, enter marks, and publish results — everything in one place.', route: 'exam-desk' },
    ...(isAdmin ? [
      { ico: '🗑️', title: 'Deleted Exams', desc: 'Exams deleted in the last 30 days — restore one before it\'s permanently removed.', route: 'deleted-exams' },
      { ico: '🎯', title: 'Grading Scales', desc: 'The grade bands and points used to grade every score.', route: 'grading' }
    ] : [])
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
