/**
 * timetableHub.mjs — "Timetable" module landing (admin). Same tab-bar
 * convention settings.mjs already established: one flat sidebar entry,
 * switched via the existing `.tabs` segmented control rather than more
 * sidebar submodules.
 */
import { viewTimetable } from './timetable.mjs';
import { viewTimetableSetup } from './timetableSetup.mjs';

const TABS = [
  { key: 'view', label: 'Generate & View', render: viewTimetable },
  { key: 'setup', label: 'Setup', render: viewTimetableSetup }
];

export async function viewTimetableHub(root) {
  let active = TABS[0].key;
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
    TABS.find((t) => t.key === key).render(body);
  };
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  showTab(active);
}
