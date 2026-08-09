/**
 * settings.mjs — consolidated "Settings" module (feature brief: "Let us
 * combine all these modules and submodules and call them settings... there
 * should be some navigations at the top... these should not show as
 * submodules, they should just be icons under settings").
 *
 * One flat sidebar entry ('settings') now covers what used to be three
 * separate nav items — School Settings, User Accounts, and Academic
 * Calendar — switched via a top tab bar instead of the sidebar, the same
 * `.tabs` segmented control Students/Attendance/Messaging already use (not
 * a new visual element — the brief's "icons at the top" idea, built with
 * Shule's own existing look rather than introducing a new one).
 */
import { viewSettings as renderSchoolProfile } from './schoolSettings.mjs';
import { viewUsers as renderUserAccounts } from './userAccounts.mjs';
import { viewAcademicCalendar as renderAcademicCalendar } from './academicCalendar.mjs';
import { viewPermissions as renderPermissions } from './permissionsSettings.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';

const TABS = [
  { key: 'profile', label: 'School Settings', render: renderSchoolProfile },
  { key: 'users', label: 'User Accounts', render: renderUserAccounts },
  { key: 'calendar', label: 'Academic Years & Terms', render: renderAcademicCalendar },
  { key: 'permissions', label: 'Permissions', render: renderPermissions }
];

export async function viewSettingsHub(root) {
  // A "Go to Settings" handoff (e.g. the Dashboard's "Getting set up"
  // checklist) can ask for a specific tab — same navIntent mechanism
  // reportForms.mjs etc. already use for this kind of "take me straight
  // there" handoff.
  const intent = takeNavIntent('settings') || {};
  let active = TABS.some((t) => t.key === intent.tab) ? intent.tab : TABS[0].key;

  root.innerHTML = `
    <div class="page-head"><div><h2>Settings</h2><p>School profile, admin access, and the academic calendar — all in one place.</p></div></div>
    <div class="tabs settings-tabs">
      ${TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="settings-tab-body"></div>
  `;

  const body = root.querySelector('#settings-tab-body');
  const showTab = (key) => {
    active = key;
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    const tab = TABS.find((t) => t.key === key);
    tab.render(body);
  };
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  showTab(active);
}
