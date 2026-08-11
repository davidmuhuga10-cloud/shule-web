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

  root.innerHTML = `
    <div class="page-head"><div><h2>Timetable</h2><p>Generate a conflict-free school timetable, view it by class or by teacher, and print it.</p></div></div>
    <div class="tabs settings-tabs">
      ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="tt-hub-body"></div>
  `;
  const body = root.querySelector('#tt-hub-body');
  const showTab = (key) => {
    active = key;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
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
