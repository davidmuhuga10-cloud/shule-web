/**
 * staffTeachers.mjs — consolidated "Staff" module (landing redesign brief
 * §E1: "Combine the separate 'Teachers' and 'Staff' modules into a single
 * unified module... Icon to use: Staff emoji... Internal layout: two tabs —
 * Teachers (default) and Staff. Switching between tabs should be smooth —
 * no page reload required.").
 *
 * Same top-tab-bar pattern as settings.mjs (reuses the existing `.tabs`
 * component rather than introducing a new one) — Teachers and Staff keep
 * their own separate render functions/files (unchanged) and are just
 * mounted as tab bodies here, switched client-side with no route change.
 */
import { viewTeachers as renderTeachers } from './teachers.mjs';
import { viewStaff as renderStaff } from './staff.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';

const TABS = [
  { key: 'teachers', label: 'Teachers', render: renderTeachers },
  { key: 'staff', label: 'Staff', render: renderStaff }
];

export async function viewStaffHub(root) {
  const intent = takeNavIntent('staff-teachers') || {};
  let active = TABS.some((t) => t.key === intent.tab) ? intent.tab : TABS[0].key;

  root.innerHTML = `
    <div class="page-head"><div><h2>Teachers and Staff</h2><p>Teachers and other staff members, in one place.</p></div></div>
    <div class="tabs staff-teachers-tabs">
      ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="staff-teachers-tab-body"></div>
  `;

  const body = root.querySelector('#staff-teachers-tab-body');
  const showTab = (key) => {
    active = key;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    const tab = TABS.find((t) => t.key === key);
    tab.render(body);
  };
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  showTab(active);
}
