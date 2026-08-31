/**
 * timetableHub.mjs — "Timetable" module landing (admin). Same tab-bar
 * convention settings.mjs already established: one flat sidebar entry,
 * switched via the existing `.tabs` segmented control rather than more
 * sidebar submodules.
 *
 * Round 2 §7: what used to be one combined "Generate & View" tab
 * (timetable.mjs) is now split into two — Generate (timetableGenerate.mjs)
 * and View (timetableView.mjs) — per the brief. A successful, fully-placed
 * generate auto-redirects here into View, carrying the just-generated
 * (year, term) along so View opens straight on the right scope instead of
 * defaulting back to whatever the active year/term happens to be.
 */
import { viewTimetableView } from './timetableView.mjs';
import { viewTimetableGenerate } from './timetableGenerate.mjs';
import { viewTimetableSetup } from './timetableSetup.mjs';
import { renderLoading } from '../app.js';

// Setup comes first — a school needs a period grid, subjects, and teachers
// configured before Generate does anything meaningful, so that's what they
// should land on and work through first.
const TABS = [
  { key: 'setup', label: 'Setup' },
  { key: 'generate', label: 'Generate' },
  { key: 'view', label: 'View' }
];

export async function viewTimetableHub(root) {
  let active = TABS[0].key;
  // Set by a successful Generate right before it redirects here — consumed
  // (and cleared) the next time View actually renders, so it never lingers
  // and silently overrides a later, unrelated visit to View.
  let handoff = null;

  // Round 6 (BUG): this hub's own title band and Setup/Generate/View tab
  // bar were missing no-print, so window.print() from the View tab picked
  // them up in the printed output along with the actual timetable — only
  // elements explicitly marked no-print are excluded (see main.css's
  // `.sidebar,.topbar,.no-print{display:none!important}` print rule).
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Timetable</h2></div></div>
    <div class="dev-notice no-print"><span class="dev-notice-ico">🚧</span><div><strong>This module is still under development.</strong> Some features may change or behave unexpectedly.</div></div>
    <div class="fin-tabs no-print">
      ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="tt-hub-body"></div>
  `;
  const body = root.querySelector('#tt-hub-body');
  // Sprint Review §3 (STILL BROKEN, reported previously): clicking
  // Setup/Generate/View gave no sign a click had registered — each of
  // those three view functions fetches its own data (sometimes several
  // requests) BEFORE touching the DOM at all, so the PREVIOUS tab's
  // content just sat there unchanged for however long that took. Same
  // fix as app.js's renderLoading() doc comment prescribes: call it
  // SYNCHRONOUSLY, before the tab-switch's `await`, so there's visible
  // "please wait" feedback the instant the tab is clicked, on every tab,
  // regardless of how slow (or fast) that tab's own fetch turns out to be.
  const showTab = (key) => {
    active = key;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    renderLoading(body, 'Loading, please wait…');
    if (key === 'setup') viewTimetableSetup(body);
    else if (key === 'generate') viewTimetableGenerate(body, (yearId, termId) => { handoff = { year_id: yearId, term_id: termId }; showTab('view'); });
    else {
      const preselect = handoff; handoff = null;
      viewTimetableView(body, preselect);
    }
  };
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  showTab(active);
}
