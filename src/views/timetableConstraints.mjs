/**
 * timetableConstraints.mjs — Round 2 §7: the Timetable module's
 * "Constraints" sub-tab (see timetableSetup.mjs), where a school configures
 * the 6 supported scheduling preferences the placement engine
 * (src/lib/timetable/generate.mjs) tries to honor as SOFT constraints —
 * see that file's header comment for the full research behind the set and
 * for exactly how/when each one is relaxed if honoring it would otherwise
 * leave a genuinely placeable lesson unresolved.
 *
 * `subject_pair_not_consecutive` is the one type a school can have several
 * of (several forbidden pairs) — rendered as a small list + add-row form.
 * The other 5 types are each managed as ONE row (this screen always
 * upserts "the existing row of that type, or a new one if there isn't
 * one yet" — see saveSingleton()) since each is naturally a single
 * school-wide on/off + its own config, not a list.
 */
import { esc, options, toast, loader, confirmAction, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const SINGLETON_TYPES = [
  {
    type: 'teacher_no_immediate_after_out',
    title: "Don't schedule a teacher right after they were \"out\"",
    desc: 'If a teacher was marked unavailable (Teacher Availability tab) for a period, avoid giving them a single lesson in the very next period — a double lesson is exempt, since it\'s already a deliberate block of time.'
  },
  {
    type: 'avoid_consecutive_intensive',
    title: 'Avoid back-to-back mentally-intensive subjects',
    desc: 'Pick the subjects you consider mentally demanding — the generator will try not to place two of them back-to-back for the same class/arm.',
    needsSubjects: true, minSubjects: 2
  },
  {
    type: 'pe_before_break',
    title: 'Prefer PE right before a break',
    desc: 'Pick the subject(s) you consider PE/physical education — the generator will try to place them in the period immediately before a break, where possible.',
    needsSubjects: true, minSubjects: 1
  },
  {
    type: 'max_consecutive_periods_class',
    title: 'Max consecutive periods per class/arm',
    desc: "Try not to let a class/arm sit more than this many periods in a row without a break (a commonly used school-timetabling guideline is around 4).",
    needsMax: true
  },
  {
    type: 'max_consecutive_periods_teacher',
    title: 'Max consecutive periods per teacher',
    desc: 'Try not to let a teacher teach more than this many periods in a row without a break (a commonly used school-timetabling guideline is around 3).',
    needsMax: true
  }
];

export async function renderTimetableConstraints(root) {
  root.innerHTML = loader();
  const [constraintsRes, subjectsRes] = await Promise.all([Db.timetable.constraints.list(), Db.subjects.list()]);
  const constraints = constraintsRes.ok ? constraintsRes.data : [];
  const subjects = subjectsRes.ok ? subjectsRes.data : [];
  draw();

  function firstOfType(type) { return constraints.find((c) => c.type === type); }

  function draw() {
    const pairs = constraints.filter((c) => c.type === 'subject_pair_not_consecutive');
    root.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-h"><h3>Subject pairs to avoid back-to-back</h3></div>
        <div class="card-b"><p class="hint" style="margin:0 0 10px">Prevent specific subject pairs from being scheduled immediately after each other for the same class/arm (e.g. two heavy science subjects). Add as many pairs as you need.</p>
          ${subjects.length < 2 ? '<p class="hint" style="margin:0">Add at least 2 subjects to the school before configuring this.</p>' : `
          <div class="grid3">
            <div class="field"><label>Subject A</label><select id="pair-a">${options(subjects, 'id', 'name', '', 'Choose a subject')}</select></div>
            <div class="field"><label>Subject B</label><select id="pair-b">${options(subjects, 'id', 'name', '', 'Choose a subject')}</select></div>
            <div class="field"><label>&nbsp;</label><button class="btn" id="pair-add">+ Add pair</button></div>
          </div>`}
        </div>
        ${pairs.length ? `<div class="card-b table-wrap"><table class="data"><thead><tr><th>Pair</th><th>Enabled</th><th></th></tr></thead><tbody>
          ${pairs.map((c) => `<tr data-id="${c.id}">
            <td>${esc(subjectName(c.config.subject_a))} ↔ ${esc(subjectName(c.config.subject_b))}</td>
            <td><label class="chk"><input type="checkbox" class="pair-enabled" ${c.enabled ? 'checked' : ''}></label></td>
            <td><button class="btn ghost sm pair-remove">Remove</button></td>
          </tr>`).join('')}
        </tbody></table></div>` : ''}
      </div>
      ${SINGLETON_TYPES.map(singletonCardHtml).join('')}
    `;

    if (subjects.length >= 2) {
      root.querySelector('#pair-add').onclick = (e) => withBusy(e.currentTarget, async () => {
        const a = root.querySelector('#pair-a').value, b = root.querySelector('#pair-b').value;
        if (!a || !b) { toast('Choose both subjects.', 'err'); return; }
        const res = await Db.timetable.constraints.save({ type: 'subject_pair_not_consecutive', enabled: true, config: { subject_a: a, subject_b: b } });
        if (!res.ok) { toast(res.message, 'err'); return; }
        constraints.push(res.data);
        toast('Pair added.', 'ok');
        draw();
      }, 'Adding…');
    }
    root.querySelectorAll('.pair-enabled').forEach((chk) => chk.onchange = async () => {
      const id = chk.closest('tr').dataset.id;
      const row = constraints.find((c) => c.id === id);
      const res = await Db.timetable.constraints.save({ id, type: row.type, enabled: chk.checked, config: row.config });
      if (!res.ok) { toast(res.message, 'err'); chk.checked = !chk.checked; return; }
      row.enabled = chk.checked;
      toast('Saved.', 'ok');
    });
    root.querySelectorAll('.pair-remove').forEach((b) => b.onclick = () => {
      const id = b.closest('tr').dataset.id;
      confirmAction('Remove this pair?', async () => {
        const res = await Db.timetable.constraints.remove(id);
        if (!res.ok) { toast(res.message, 'err'); return; }
        const i = constraints.findIndex((c) => c.id === id);
        if (i > -1) constraints.splice(i, 1);
        toast('Removed.', 'ok');
        draw();
      }, true);
    });

    SINGLETON_TYPES.forEach((def) => wireSingletonCard(def));
  }

  function subjectName(id) { return (subjects.find((s) => s.id === id) || {}).name || '(subject not found)'; }

  function singletonCardHtml(def) {
    const row = firstOfType(def.type);
    const enabled = row ? row.enabled : false;
    const config = (row && row.config) || {};
    return `<div class="card" style="margin-bottom:16px" data-constraint-card="${def.type}">
      <div class="card-h"><h3>${esc(def.title)}</h3></div>
      <div class="card-b">
        <p class="hint" style="margin:0 0 10px">${esc(def.desc)}</p>
        <label class="chk" style="margin-bottom:${def.needsSubjects || def.needsMax ? '10px' : '0'}"><input type="checkbox" class="ct-enabled" ${enabled ? 'checked' : ''}> Enabled</label>
        ${def.needsSubjects ? `<div class="table-wrap"><table class="data"><tbody>
          ${subjects.map((s) => `<tr><td style="width:24px"><input type="checkbox" class="ct-subject" value="${s.id}" ${(config.subject_ids || []).includes(s.id) ? 'checked' : ''}></td><td>${esc(s.name)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
        ${def.needsMax ? `<div class="field" style="max-width:200px"><label>Maximum consecutive periods</label><input type="number" min="1" max="20" class="ct-max" value="${config.max === undefined ? '' : config.max}"></div>` : ''}
      </div>
      <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn secondary sm ct-save">Save</button></div>
    </div>`;
  }

  function wireSingletonCard(def) {
    const card = root.querySelector(`[data-constraint-card="${def.type}"]`);
    if (!card) return;
    card.querySelector('.ct-save').onclick = (e) => withBusy(e.currentTarget, async () => {
      const existing = firstOfType(def.type);
      const enabled = card.querySelector('.ct-enabled').checked;
      let config = {};
      if (def.needsSubjects) {
        const ids = [...card.querySelectorAll('.ct-subject:checked')].map((el) => el.value);
        if (enabled && ids.length < def.minSubjects) {
          toast(`Pick at least ${def.minSubjects} subject${def.minSubjects === 1 ? '' : 's'}, or untick Enabled.`, 'err');
          return;
        }
        config = { subject_ids: ids };
      } else if (def.needsMax) {
        const max = card.querySelector('.ct-max').value;
        if (enabled && (!max || Number(max) < 1)) { toast('Enter a maximum of at least 1 period, or untick Enabled.', 'err'); return; }
        config = { max: max ? Number(max) : 1 };
      }
      const res = await Db.timetable.constraints.save({ id: existing ? existing.id : undefined, type: def.type, enabled, config });
      if (!res.ok) { toast(res.message, 'err'); return; }
      if (existing) { existing.enabled = enabled; existing.config = config; }
      else constraints.push(res.data && res.data.id ? res.data : { id: res.data, type: def.type, enabled, config });
      toast('Saved.', 'ok');
    }, 'Saving…');
  }
}
