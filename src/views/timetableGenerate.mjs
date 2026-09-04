/**
 * timetableGenerate.mjs — Round 2 §7: the Timetable module's "Generate" tab,
 * split out of what used to be one combined "Generate & View" tab
 * (timetable.mjs, now retired — see timetableView.mjs for the other half).
 * Picks an academic year + term and one-click generates a full school
 * timetable (src/lib/timetable/generate.mjs via Db.timetable.generate).
 *
 * On a successful generate, this hands off to the View tab automatically
 * (`onGenerated(yearId, termId)`, wired by timetableHub.mjs) — "split the
 * combined Generate/View tab into two, with an automatic redirect from
 * Generate to View after generating" per the brief, rather than leaving the
 * person on a screen with nothing left to do once generation finishes.
 * Generating with unresolved items still redirects — View is where you go
 * to actually look at what a partial timetable is missing, exactly as
 * before.
 */
import { options, toast, withBusy, confirmAction, esc, renderPrereqOrConnectivity } from '../app.js';
import { Db } from '../lib/api/index.mjs';

function pickDefaultYearTerm(years, termsByYear) {
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  if (!activeYear) return { year_id: '', term_id: '' };
  const terms = termsByYear[activeYear.id] || [];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  return { year_id: activeYear.id, term_id: activeTerm ? activeTerm.id : '' };
}

export async function viewTimetableGenerate(root, onGenerated) {
  // Sprint Review §2: "The Timetable should refuse to generate at all while
  // the configuration is over the limit" — generate() has always refused
  // server-side once clicked; checkCapacityStatus() (same check, read-only)
  // is fetched up front here too so the button is disabled and the reason
  // is visible BEFORE that click, not just after a round trip. A failed
  // fetch here fails open (button stays enabled) — generate() itself is
  // still the authoritative check either way, so nothing unsafe can slip
  // through if this particular request happens to be offline.
  // Perf/UX fix: paint something immediately instead of leaving the
  // Timetable tab-switch spinner up for this extra round trip too — see
  // examDesk.mjs's viewExamDesk for the fuller explanation.
  root.innerHTML = `
    <div class="card"><div class="card-b">
      <div class="skeleton" style="width:100%;height:60px;margin-bottom:12px"></div>
      <div class="skeleton" style="width:100%;height:60px"></div>
    </div></div>
  `;
  const [yearsRes, periodsRes, capacityRes] = await Promise.all([Db.academicYears.list(), Db.timetable.periods.list(), Db.timetable.checkCapacityStatus()]);
  // Round 5 §5 (BUG): don't conflate a failed fetch (usually a lost/flaky
  // connection) with "genuinely not configured yet".
  if (!yearsRes.ok || !periodsRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewTimetableGenerate(root, onGenerated) });
    return;
  }
  const years = yearsRes.data;
  const periods = periodsRes.data;
  const capacity = capacityRes.ok ? capacityRes.data : null;
  const overCapacity = !!(capacity && !capacity.ok);

  if (!years.length) { root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No academic years found</h3><p>Set up an academic year and term first (Settings → Academic Years &amp; Terms).</p></div></div></div>`; return; }
  if (!periods.length) { root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>Set up your period grid first</h3><p>Go to the Setup tab and define your school's daily periods before generating a timetable.</p></div></div></div>`; return; }

  const termsByYear = {};
  await Promise.all(years.map(async (y) => { const r = await Db.terms.list(y.id); termsByYear[y.id] = r.ok ? r.data : []; }));

  const def = pickDefaultYearTerm(years, termsByYear);
  const sel = { year_id: def.year_id, term_id: def.term_id };
  render();

  function render() {
    const terms = termsByYear[sel.year_id] || [];
    root.innerHTML = `
      ${overCapacity ? `
      <div class="card no-print" style="margin-bottom:16px;border-color:var(--danger)">
        <div class="card-b" style="display:flex;gap:12px;align-items:flex-start">
          <div style="font-size:22px;line-height:1">⛔</div>
          <div>
            <div style="font-weight:750;color:var(--danger)">Maximum timeslots reached — can't generate yet</div>
            <p class="hint" style="margin:4px 0 0">${capacity.overloaded.length} class/stream${capacity.overloaded.length === 1 ? '' : 's'} ${capacity.overloaded.length === 1 ? 'needs' : 'need'} more periods/week than the daily grid has room for:</p>
            <ul style="margin:6px 0 0;padding-left:20px">
              ${capacity.overloaded.map((o) => `<li><b>${esc(`${o.class_name} ${o.stream_name}`.trim() || 'A class/stream')}</b>: needs ${o.required}, but the week only has ${o.available} <span style="color:var(--danger);font-weight:700">(${o.required - o.available} over)</span></li>`).join('')}
            </ul>
            <p class="hint" style="margin:8px 0 0">Fix this under Setup → Subject Periods &amp; Double Lessons (reduce a subject's periods/week) or Setup → Teaching Days &amp; Periods (add more periods to the grid), then come back here.</p>
          </div>
        </div>
      </div>` : ''}
      <div class="card" style="margin-bottom:16px">
        <div class="card-b grid4">
          <div class="field"><label>Academic Year</label><select id="tt-year">${options(years, 'id', 'name', sel.year_id, 'Choose a year')}</select></div>
          <div class="field"><label>Term</label><select id="tt-term">${options(terms, 'id', 'name', sel.term_id, 'Choose a term')}</select></div>
          <div class="field"><label>&nbsp;</label><button class="btn" id="tt-generate" ${overCapacity ? 'disabled title="Can\'t generate while a class/stream is over its weekly period limit — see the warning above."' : ''}>🔄 Generate Timetable</button></div>
          <div class="field"><label>&nbsp;</label><p class="hint" style="margin:0">Regenerating replaces this term's active timetable — the last 3 versions are kept, so you can switch back on the View tab if this one turns out worse. Once done, you'll be taken straight there.</p></div>
        </div>
      </div>
      <div id="tt-gen-result"></div>
    `;

    const yearSel = root.querySelector('#tt-year'), termSel = root.querySelector('#tt-term');
    yearSel.onchange = () => { sel.year_id = yearSel.value; sel.term_id = (termsByYear[sel.year_id] || [])[0]?.id || ''; render(); };
    termSel.onchange = () => { sel.term_id = termSel.value; };

    if (overCapacity) return; // nothing left to wire — the button is disabled.
    root.querySelector('#tt-generate').onclick = () => {
      if (!sel.year_id || !sel.term_id) { toast('Choose an academic year and term first.', 'err'); return; }
      confirmAction('Generate a fresh timetable for this term? This becomes the active one everyone sees — the current version is kept and can be switched back to from the View tab if needed.', async () => {
        await withBusy(root.querySelector('#tt-generate'), async () => {
          const res = await Db.timetable.generate(sel.year_id, sel.term_id);
          if (!res.ok) {
            // Round 2 §7 capacity check: generate() now fails clearly BEFORE
            // touching any existing timetable when the week simply doesn't
            // have room for what's being asked (see generate.mjs's
            // checkCapacity()) — shown here exactly like any other error,
            // but nothing was cleared, so the school's current timetable
            // (if any) is untouched and still visible on the View tab.
            toast(res.message, 'err');
            root.querySelector('#tt-gen-result').innerHTML = `<div class="card no-print"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>Couldn't generate</h3><p>${esc(res.message)}</p></div></div></div>`;
            return;
          }
          if (res.data.unresolved.length) {
            // A partial result needs the person's attention right here
            // (what couldn't be placed, and why) before they move on — the
            // auto-redirect is for the clean case; a partial one shows the
            // list and offers an explicit "Continue to View" instead of
            // whisking it away unread.
            toast(`Placed ${res.data.placed} periods — ${res.data.unresolved.length} couldn't be scheduled (see details below).`, 'warn');
            showUnresolved(res.data.unresolved, sel.year_id, sel.term_id);
          } else {
            toast(`Timetable generated — all ${res.data.placed} periods placed with no conflicts.`, 'ok');
            // Auto-redirect to View — nothing left to do or read on
            // Generate once every period placed cleanly.
            if (onGenerated) onGenerated(sel.year_id, sel.term_id);
          }
        }, 'Generating…');
      });
    };
  }

  function showUnresolved(unresolved, yearId, termId) {
    const rows = unresolved.map((u) => `<tr><td>${esc(u.class_name)} ${esc(u.stream_name)}</td><td>${esc(u.subject_name)}</td><td>${u.type === 'double' ? 'Double lesson' : 'Single lesson'}</td><td>${esc(u.reason)}</td></tr>`).join('');
    const body = document.createElement('div');
    body.className = 'card no-print';
    body.style.marginBottom = '16px';
    body.innerHTML = `<div class="card-h"><h3>⚠️ Couldn't be scheduled (${unresolved.length})</h3></div>
      <div class="card-b table-wrap"><table class="data"><thead><tr><th>Class/Stream</th><th>Subject</th><th>Type</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="card-b"><p class="hint" style="margin:0">Usually means a teacher is stretched across more lessons than the week has room for, or the period grid is too tight for everything configured. Free up a slot (fewer periods/week for that subject, another teacher, or a bigger period grid in Setup) and generate again.</p></div>
      <div class="card-b" style="padding-top:0"><button class="btn secondary sm" id="tt-gen-continue">Continue to View →</button></div>`;
    root.querySelector('#tt-gen-result').prepend(body);
    body.querySelector('#tt-gen-continue').onclick = () => { if (onGenerated) onGenerated(yearId, termId); };
  }
}
