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
 */
import { esc, toast } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewPermissions(root) {
  const res = await Db.settings.get();
  const settings = res.ok ? res.data : {};
  render(root, settings);
}

function render(root, settings) {
  const showAll = String(settings.teachers_see_all_reports) === 'true';
  const showPathways = String(settings.show_pathway_summary) === 'true';
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
    <div class="card">
      <div class="card-h"><h3>Report Forms</h3></div>
      <div class="card-b">
        <label style="display:flex;align-items:center;gap:12px;cursor:pointer">
          <input type="checkbox" id="perm-show-pathways" ${showPathways ? 'checked' : ''}>
          <span><b>Show a STEM / Social Sciences / Arts &amp; Sport Science pathway summary on Report Forms</b><br>
          <span class="hint" style="margin:0">CBC "pathways" are a Senior School (Grade 10-12) concept — leave this off for schools/classes that don't use them yet. Off by default; tick it if your school wants that row added to the Report Form.</span></span>
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
}
