/**
 * permissionsSettings.mjs — Settings > Permissions tab (feature brief §12
 * "New setting to add... a 'Permissions' module with a toggle 'Show all
 * school reports to all teachers'"). A school decides here whether a
 * teacher only sees their own subject's marks-entry/performance, or every
 * subject school-wide — read by marksEntry.mjs's Step 4 subject-tab
 * filtering (the primary enforcement point right now; broader report-by-
 * report enforcement, e.g. filtering which classes a teacher can pick on
 * Mark List/Exam Analysis, is a documented follow-up, not yet built).
 *
 * Round 4 §6: "The 'Show a STEM / Social Sciences / Arts & Sport Science
 * pathway summary on Report Forms' toggle should be removed from its
 * current location [School Settings] and moved under the Permissions
 * module instead, alongside other report/visibility-related settings."
 * Same `show_pathway_summary` settings key as before (schoolSettings.mjs
 * used to own this field — see _reportCard.mjs's clusterSummaryHtml(),
 * which is unchanged and still reads this exact key) — only where it's
 * edited has moved, not the data underneath it.
 *
 * Round 2 §1/§2 add a "Mark List" card: §1's "Show subject papers
 * separately on Merit List" toggle (settings.mjs's show_papers_separately —
 * read by broadsheet.mjs's showPapersSeparately()), and §2's custom subject
 * ordering (use_custom_subject_order + subject_order — read by
 * broadsheet.mjs's orderSubjects()). The reorder list only renders once the
 * toggle is on, since there's nothing to order otherwise.
 */
import { esc, toast } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewPermissions(root) {
  const [settingsRes, subjectsRes] = await Promise.all([Db.settings.get(), Db.subjects.list()]);
  const settings = settingsRes.ok ? settingsRes.data : {};
  const subjects = subjectsRes.ok ? subjectsRes.data : [];
  render(root, settings, subjects);
}

/** subject_order is stored as a JSON array of subject ids. Any subject not
 *  in the saved order (new since it was last set, or never touched) is
 *  appended at the end, in its normal list order — never silently dropped
 *  from the reorder UI. */
function orderedSubjectList(settings, subjects) {
  let order = [];
  try { order = JSON.parse(settings.subject_order || '[]'); } catch (e) { order = []; }
  const byId = {}; subjects.forEach((s) => { byId[s.id] = s; });
  const ordered = order.map((id) => byId[id]).filter(Boolean);
  const seen = new Set(ordered.map((s) => s.id));
  subjects.forEach((s) => { if (!seen.has(s.id)) ordered.push(s); });
  return ordered;
}

function render(root, settings, subjects) {
  const showAll = String(settings.teachers_see_all_reports) === 'true';
  const showPathways = String(settings.show_pathway_summary) === 'true';
  // UNLIKE every other toggle on this screen, this one defaults to ON when
  // the key is genuinely absent (an existing school from before this
  // setting existed, or a race with the backfill migration) — see the
  // comment on this key in settings.mjs.
  const showPapersSeparately = settings.show_papers_separately === undefined ? true : String(settings.show_papers_separately) === 'true';
  const useCustomOrder = String(settings.use_custom_subject_order) === 'true';
  // Sprint Review §8: same "missing key means true" rule as
  // show_papers_separately just above — ticked yes by default.
  const showAchievementLevels = settings.show_achievement_levels === undefined ? true : String(settings.show_achievement_levels) === 'true';
  let orderList = orderedSubjectList(settings, subjects);

  root.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Teacher visibility</h3></div>
      <div class="card-b">
        <label style="display:flex;align-items:center;gap:12px;cursor:pointer">
          <input type="checkbox" id="perm-show-all" ${showAll ? 'checked' : ''}>
          <span><b>Show all school reports to all teachers</b><br>
          <span class="hint" style="margin:0">When off (default), a teacher's Enter Marks screen and subject/exam performance only shows subjects assigned specifically to them. When on, every teacher can see every subject and class school-wide.</span></span>
        </label>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>Report Forms</h3></div>
      <div class="card-b">
        <label style="display:flex;align-items:center;gap:12px;cursor:pointer">
          <input type="checkbox" id="perm-show-pathways" ${showPathways ? 'checked' : ''}>
          <span><b>Show a STEM / Social Sciences / Arts &amp; Sport Science pathway summary on Report Forms</b><br>
          <span class="hint" style="margin:0">CBC "pathways" are a Senior School (Grade 10-12) concept — leave this off for schools/classes that don't use them yet. Off by default; tick it if your school wants that row added to the Report Form.</span></span>
        </label>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>Mark List</h3></div>
      <div class="card-b">
        <label style="display:flex;align-items:center;gap:12px;cursor:pointer">
          <input type="checkbox" id="perm-show-papers" ${showPapersSeparately ? 'checked' : ''}>
          <span><b>Show subject papers separately on the Mark List</b><br>
          <span class="hint" style="margin:0">On by default. When on, a subject set up with Learning Area Papers (Exams &gt; an exam &gt; Learning Area Papers) shows one column per paper plus a combined % column. When off, that subject shows as a single combined column instead, same as any other subject.</span></span>
        </label>
      </div>
      <div class="card-b" style="border-top:1px solid var(--line)">
        <label style="display:flex;align-items:center;gap:12px;cursor:pointer">
          <input type="checkbox" id="perm-custom-order" ${useCustomOrder ? 'checked' : ''}>
          <span><b>Use a custom subject order on the Mark List</b><br>
          <span class="hint" style="margin:0">Off by default (subjects appear in the system's normal order). Turn this on to choose exactly which order subjects appear in — e.g. Mathematics first, English last.</span></span>
        </label>
        <div id="perm-order-list" style="margin-top:14px${useCustomOrder ? '' : ';display:none'}"></div>
      </div>
      <div class="card-b" style="border-top:1px solid var(--line)">
        <label style="display:flex;align-items:center;gap:12px;cursor:pointer">
          <input type="checkbox" id="perm-show-levels" ${showAchievementLevels ? 'checked' : ''}>
          <span><b>Show achievement levels on the Mark List</b><br>
          <span class="hint" style="margin:0">On by default. When on, the Mark List shows each mark's grade/achievement-level letter (e.g. EE1, A-), the PL column, and the grade-breakdown tables at the bottom. Turn this off for a school that wants raw marks only, with none of that — the Mark List (on screen, printed, and its Excel export) then shows just the numbers.</span></span>
        </label>
      </div>
    </div>
  `;

  root.querySelector('#perm-show-all').onchange = async (e) => {
    const val = e.target.checked;
    const r = await Db.settings.save({ teachers_see_all_reports: String(val) });
    if (!r.ok) { toast(r.message, 'err'); e.target.checked = !val; return; }
    toast(val ? 'Teachers can now see all school reports.' : 'Teachers now see only their own assigned subjects.', 'ok');
  };

  root.querySelector('#perm-show-pathways').onchange = async (e) => {
    const val = e.target.checked;
    const r = await Db.settings.save({ show_pathway_summary: String(val) });
    if (!r.ok) { toast(r.message, 'err'); e.target.checked = !val; return; }
    toast(val ? 'Pathway summary will now show on Report Forms.' : 'Pathway summary removed from Report Forms.', 'ok');
  };

  root.querySelector('#perm-show-papers').onchange = async (e) => {
    const val = e.target.checked;
    const r = await Db.settings.save({ show_papers_separately: String(val) });
    if (!r.ok) { toast(r.message, 'err'); e.target.checked = !val; return; }
    toast(val ? 'The Mark List will now show papers as separate columns.' : 'The Mark List will now combine papers into one column.', 'ok');
  };

  const orderListEl = root.querySelector('#perm-order-list');
  function drawOrderList() {
    if (!subjects.length) { orderListEl.innerHTML = '<p class="hint" style="margin:0">No subjects yet.</p>'; return; }
    orderListEl.innerHTML = `
      <p class="hint" style="margin:0 0 8px">Drag isn't needed — use the arrows to move a subject up or down.</p>
      <div class="table-wrap"><table class="data" style="margin:0">
        <tbody>${orderList.map((s, i) => `<tr data-id="${s.id}">
          <td style="width:36px">${i + 1}</td>
          <td>${esc(s.name)}${s.level ? ` <span class="muted">(${esc(s.level)})</span>` : ''}</td>
          <td style="width:80px;text-align:right">
            <button class="icon-btn" data-up="${s.id}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
            <button class="icon-btn" data-down="${s.id}" ${i === orderList.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div style="margin-top:10px"><button class="btn sm" id="perm-order-save">Save order</button></div>
    `;
    orderListEl.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => moveSubject(b.dataset.up, -1));
    orderListEl.querySelectorAll('[data-down]').forEach((b) => b.onclick = () => moveSubject(b.dataset.down, 1));
    orderListEl.querySelector('#perm-order-save').onclick = async (e2) => {
      const r = await Db.settings.save({ subject_order: JSON.stringify(orderList.map((s) => s.id)) });
      if (!r.ok) { toast(r.message, 'err'); return; }
      toast('Subject order saved.', 'ok');
    };
  }
  function moveSubject(id, dir) {
    const idx = orderList.findIndex((s) => s.id === id);
    const swapWith = idx + dir;
    if (idx === -1 || swapWith < 0 || swapWith >= orderList.length) return;
    [orderList[idx], orderList[swapWith]] = [orderList[swapWith], orderList[idx]];
    drawOrderList();
  }
  if (useCustomOrder) drawOrderList();

  root.querySelector('#perm-show-levels').onchange = async (e) => {
    const val = e.target.checked;
    const r = await Db.settings.save({ show_achievement_levels: String(val) });
    if (!r.ok) { toast(r.message, 'err'); e.target.checked = !val; return; }
    toast(val ? 'The Mark List will now show achievement-level letters again.' : 'The Mark List will now show raw marks only, with no achievement levels.', 'ok');
  };

  root.querySelector('#perm-custom-order').onchange = async (e) => {
    const val = e.target.checked;
    const r = await Db.settings.save({ use_custom_subject_order: String(val) });
    if (!r.ok) { toast(r.message, 'err'); e.target.checked = !val; return; }
    orderListEl.style.display = val ? '' : 'none';
    if (val) drawOrderList();
    toast(val ? 'Custom subject order enabled — set the order below.' : 'Mark List subjects will use the normal system order again.', 'ok');
  };
}
