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
 *
 * Round 2 §6: "Change the three Exams sub-modules from horizontal cards to
 * a vertical stack, in this fixed order: Exam Desk first, Grading Scales
 * second, Deleted Exams last — Deleted Exams should always stay last, even
 * as more sub-modules are added over time. Each item should occupy at
 * least half the page width when stacked." `tiles` below is written in
 * exactly that fixed order already (not sorted/computed), and `.hub-grid`
 * gets a `stack` modifier (main.css) that switches it to one column — a
 * single-column card is always the full content width, comfortably over
 * half, without needing a hardcoded width value that could clash with a
 * narrower viewport. Deleted Exams is pushed to the very end of the array
 * construction itself (appended last, after every admin-only tile that
 * comes before it) so a FUTURE sub-module added to this list without
 * re-reading this comment still can't accidentally land after it.
 */
import { go, state } from '../app.js';

export async function viewExamsHub(root) {
  const isAdmin = state.profile && state.profile.role === 'admin';
  // Design standard brief item 2: Exams tiles now carry the same coloured
  // accent border as the Reports hub tiles (reportsHub.mjs), the new
  // site-wide reference look.
  const tiles = [
    { ico: '🗂️', title: 'Exam Desk', desc: 'Create an exam, choose classes, enter marks, and publish results — everything in one place.', route: 'exam-desk', accent: 'tile-blue' },
    ...(isAdmin ? [
      { ico: '🎯', title: 'Grading Scales', desc: 'The grade bands and points used to grade every score.', route: 'grading', accent: 'tile-purple' }
    ] : []),
    // Deleted Exams ALWAYS stays last, no matter what's added above.
    ...(isAdmin ? [
      { ico: '🗑️', title: 'Deleted Exams', desc: 'Exams deleted in the last 30 days — restore one before it\'s permanently removed.', route: 'deleted-exams', accent: 'tile-rose' }
    ] : [])
  ];

  root.innerHTML = `
    <div class="page-head"><div><h2>Exams</h2><p>Everything to do with exams, in one place.</p></div></div>
    <div class="hub-grid stack">
      ${tiles.map((t) => `<button class="hub-tile ${t.accent}" data-route="${t.route}">
        <div class="h-ico">${t.ico}</div>
        <div class="h-title">${t.title}</div>
        <div class="h-desc">${t.desc}</div>
      </button>`).join('')}
    </div>
  `;

  root.querySelectorAll('[data-route]').forEach((b) => b.onclick = () => go(b.dataset.route));
}
