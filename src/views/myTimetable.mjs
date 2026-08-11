/**
 * myTimetable.mjs — "My Timetable" (teacher role): a read-only view of the
 * signed-in teacher's own lessons across every class/arm they teach, for a
 * chosen academic year + term. Same underlying timetable_entries data the
 * admin Timetable screen's "By Teacher" view shows (RLS lets any signed-in
 * staff member read the whole school's timetable — see 0018_timetable.sql —
 * this just defaults straight to their own staff_id and drops the picker),
 * printable via the same shared print controls as everything else.
 */
import { esc, options, loader, printOptionsHtml, wirePrintOptions, state, go, renderPrereqOrConnectivity } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';
import { timetableGridPageHtml } from './_timetableGrid.mjs';

export async function viewMyTimetable(root) {
  const staffId = state.profile && state.profile.staff_id;
  if (!staffId) {
    root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No staff profile linked</h3><p>Your login isn't linked to a staff record, so there's no timetable to show. Ask an admin to check your account.</p></div></div></div>`;
    return;
  }
  const [yearsRes, periodsRes, daysRes, settingsRes] = await Promise.all([
    Db.academicYears.list(), Db.timetable.periods.list(), Db.timetable.days.get(), Db.settings.get()
  ]);
  // Round 5 §5 (BUG): don't conflate a failed fetch (usually a lost/flaky
  // connection) with "genuinely nothing set up yet".
  if (!yearsRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewMyTimetable(root) });
    return;
  }
  const years = yearsRes.data;
  const periods = periodsRes.ok ? periodsRes.data : [];
  const days = daysRes.ok ? daysRes.data : [1, 2, 3, 4, 5];
  const settings = settingsRes.ok ? settingsRes.data : {};

  if (!years.length) { root.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">📅</div><h3>No timetable yet</h3><p>Nothing has been set up yet — check back once your school's timetable is published.</p></div></div></div>`; return; }

  const termsByYear = {};
  await Promise.all(years.map(async (y) => { const r = await Db.terms.list(y.id); termsByYear[y.id] = r.ok ? r.data : []; }));
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  const activeTerms = termsByYear[activeYear.id] || [];
  const activeTerm = activeTerms.find((t) => t.status === 'active') || activeTerms[0];

  const sel = { year_id: activeYear.id, term_id: activeTerm ? activeTerm.id : '' };
  render();

  function render() {
    const terms = termsByYear[sel.year_id] || [];
    root.innerHTML = `
      <div class="page-head no-print"><div><h2>My Timetable</h2><p>Your own lessons across every class and arm you teach.</p></div></div>
      <div class="card no-print" style="margin-bottom:16px">
        <div class="card-b grid3">
          <div class="field"><label>Academic Year</label><select id="my-tt-year">${options(years, 'id', 'name', sel.year_id, 'Choose a year')}</select></div>
          <div class="field"><label>Term</label><select id="my-tt-term">${options(terms, 'id', 'name', sel.term_id, 'Choose a term')}</select></div>
          <div class="field"><label>&nbsp;</label>${printOptionsHtml('mtt', 'landscape')}</div>
        </div>
      </div>
      <div id="my-tt-view"></div>
    `;
    root.querySelector('#my-tt-year').onchange = (e) => { sel.year_id = e.target.value; sel.term_id = (termsByYear[sel.year_id] || [])[0]?.id || ''; render(); };
    root.querySelector('#my-tt-term').onchange = (e) => { sel.term_id = e.target.value; loadView(); };
    wirePrintOptions(root.querySelector('.card.no-print'), 'mtt', 'My Timetable');
    loadView();
  }

  async function loadView() {
    const viewEl = root.querySelector('#my-tt-view');
    if (!sel.year_id || !sel.term_id) { viewEl.innerHTML = '<div class="card pad">Choose an academic year and term.</div>'; return; }
    viewEl.innerHTML = loader();
    if (!isContactInfoComplete(settings)) { renderMissingContactInfo(viewEl, () => go('settings')); return; }
    const res = await Db.timetable.entries.list({ academic_year_id: sel.year_id, term_id: sel.term_id, staff_id: staffId });
    if (!res.ok) { viewEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
    if (!res.data.length) {
      viewEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">📅</div><h3>No lessons for this term yet</h3><p>Nothing's been generated or assigned to you for this academic year/term.</p></div></div></div>`;
      return;
    }
    viewEl.innerHTML = timetableGridPageHtml(settings, 'My Timetable', periods, days, res.data, 'teacher', false);
    wirePrintOptions(root.querySelector('.card.no-print'), 'mtt', `My Timetable — ${(years.find((y) => y.id === sel.year_id) || {}).name || ''}`);
  }
}
