/**
 * timetableConstraints.mjs — the Timetable module's "Constraints" sub-tab
 * (see timetableSetup.mjs), where a school configures the 6 supported
 * scheduling preferences the placement engine (src/lib/timetable/
 * generate.mjs) tries to honor as SOFT constraints — see that file's header
 * comment for the full research behind the set and for exactly how/when
 * each one is relaxed if honoring it would otherwise leave a genuinely
 * placeable lesson unresolved.
 *
 * Round 5 §8 restyle: replaced the old wordy card-per-type layout (a full
 * card, an explanatory paragraph, and a separate "Save" button, for every
 * single constraint) with Zeraki's own approach — grouped, flat rows, each
 * just a short name, a one-line description, and a toggle that saves
 * instantly. A constraint that genuinely needs more than on/off (which
 * subjects count as "intensive", a max number, which subject pairs) gets a
 * small "⚙ Configure" link that expands an inline editor right under that
 * row instead of reverting to a whole separate card — the toggle itself
 * stays a one-click action for every constraint, configured or not.
 *
 * The brief's own "Fixed Constraints" section (system-enforced rules that
 * can't be turned off, e.g. a teacher can't be double-booked) is
 * deliberately NOT built as a screen here — the brief's own text gave
 * explicit permission to skip it ("BUILD THIS OR JUST IGNORE THEY CAN RUN
 * ON BACKGROUND AS ONE CANT CHANGE I THINK NO NEED TO SHOW THEM"). Those
 * rules already run unconditionally inside generate.mjs regardless of
 * whether any UI lists them.
 */
import { esc, options, toast, loader, confirmAction, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';

// Round 5 §8: short Zeraki-style name + a single-sentence description —
// deliberately NOT the old paragraph-length explanation every card used to
// carry. Grouped the same way Zeraki's own reference groups them (Subject
// constraints / Teacher constraints / Class constraints).
const GROUPS = [
  {
    title: 'Subject constraints',
    desc: 'Manage the constraints that affect the taught subjects.',
    types: [
      {
        type: 'avoid_consecutive_intensive',
        title: 'No Back-to-Back Mentally Intensive Subjects',
        desc: 'Prevents scheduling two mentally demanding subjects one after another for the same class/stream.',
        needsSubjects: true, minSubjects: 2, subjectsLabel: 'Which subjects count as mentally intensive?'
      },
      {
        type: 'pe_before_break',
        title: 'PE Lessons Before Break',
        desc: 'Schedules PE right before a break where possible, so students transition smoothly between activity and rest.',
        needsSubjects: true, minSubjects: 1, subjectsLabel: 'Which subject(s) are PE?'
      },
      {
        type: 'distribute_doubles',
        title: 'Spread Out Double Lessons',
        desc: "Avoids stacking double lessons directly back-to-back, so a class/stream's day isn't wall-to-wall doubles. On by default for every school."
      }
    ]
  },
  {
    title: 'Teacher constraints',
    desc: 'Manage the constraints that affect the teacher schedule.',
    types: [
      {
        type: 'teacher_no_immediate_after_out',
        title: "No Lesson Right After a Teacher Was Out",
        desc: 'Avoids giving a teacher a single lesson immediately after a period they were marked unavailable for (a double lesson is exempt).'
      },
      {
        type: 'max_consecutive_periods_teacher',
        title: 'Max Consecutive Periods for Teacher',
        desc: 'Limits how many periods in a row a teacher can teach without a break.',
        needsMax: true, maxLabel: 'Maximum consecutive periods (teacher)', maxHint: 'A commonly used guideline is around 3.'
      }
    ]
  },
  {
    title: 'Class constraints',
    desc: 'Manage the constraints that affect the class/stream schedule.',
    types: [
      {
        type: 'max_consecutive_periods_class',
        title: 'Max Consecutive Periods for Class',
        desc: 'Limits how many periods in a row a class/stream can sit without a break.',
        needsMax: true, maxLabel: 'Maximum consecutive periods (class)', maxHint: 'A commonly used guideline is around 4.'
      }
    ]
  }
];
const SINGLETON_TYPES = GROUPS.flatMap((g) => g.types);

export async function renderTimetableConstraints(root) {
  root.innerHTML = loader();
  const [constraintsRes, subjectsRes] = await Promise.all([Db.timetable.constraints.list(), Db.subjects.list()]);
  const constraints = constraintsRes.ok ? constraintsRes.data : [];
  const subjects = subjectsRes.ok ? subjectsRes.data : [];
  draw();

  function firstOfType(type) { return constraints.find((c) => c.type === type); }
  function subjectName(id) { return (subjects.find((s) => s.id === id) || {}).name || '(subject not found)'; }

  // Round 6 §8: withBusy (app.js) swaps a button's textContent, which
  // doesn't work for a toggle switch (checkbox + styled span, no text of
  // its own) — this is the equivalent "please wait" treatment for these
  // switches: disable the input and dim the wrapping .tt-switch label
  // while the save is in flight, exactly like every other Timetable button
  // now does in its own way.
  async function withSwitchBusy(labelEl, checkboxEl, fn) {
    if (checkboxEl.disabled) return;
    checkboxEl.disabled = true;
    labelEl.classList.add('busy');
    try {
      await fn();
    } finally {
      checkboxEl.disabled = false;
      labelEl.classList.remove('busy');
    }
  }

  function draw() {
    root.innerHTML = `
      ${GROUPS.map(groupHtml).join('')}
      ${subjectPairsCardHtml()}
    `;
    SINGLETON_TYPES.forEach(wireRow);
    wireSubjectPairs();
  }

  /* ------------------------------------------------------ toggle rows --- */
  function groupHtml(group) {
    return `<div class="card tt-constraint-group" style="margin-bottom:16px">
      <div class="card-h"><div><h3>${esc(group.title)}</h3><p class="hint" style="margin:2px 0 0">${esc(group.desc)}</p></div></div>
      <div class="tt-crow-list">${group.types.map(rowHtml).join('')}</div>
    </div>`;
  }

  function rowHtml(def) {
    const row = firstOfType(def.type);
    const enabled = row ? row.enabled : false;
    const config = (row && row.config) || {};
    const hasConfig = def.needsSubjects || def.needsMax;
    return `<div class="tt-crow" data-constraint-row="${def.type}">
      <div class="tt-crow-main">
        <div class="tt-crow-text">
          <div class="tt-crow-title">${esc(def.title)}</div>
          <div class="tt-crow-desc">${esc(def.desc)}</div>
        </div>
        <div class="tt-crow-actions">
          ${hasConfig ? `<button class="btn ghost sm tt-crow-configure" type="button">⚙ Configure</button>` : ''}
          <label class="tt-switch"><input type="checkbox" class="tt-crow-toggle" ${enabled ? 'checked' : ''}><span class="tt-switch-slider"></span></label>
        </div>
      </div>
      ${hasConfig ? `<div class="tt-crow-config" style="display:none">
        ${def.needsSubjects ? `<p class="hint" style="margin:0 0 8px">${esc(def.subjectsLabel)}</p>
          <div class="chips">${subjects.map((s) => `<label class="chip ${(config.subject_ids || []).includes(s.id) ? 'on' : ''}"><input type="checkbox" class="ct-subject" value="${s.id}" ${(config.subject_ids || []).includes(s.id) ? 'checked' : ''} style="display:none">${esc(s.name)}</label>`).join('') || '<span class="muted">No subjects added yet.</span>'}</div>` : ''}
        ${def.needsMax ? `<div class="field" style="max-width:260px"><label>${esc(def.maxLabel)}</label><input type="number" min="1" max="20" class="ct-max" value="${config.max === undefined ? '' : config.max}"><p class="hint" style="margin:4px 0 0">${esc(def.maxHint || '')}</p></div>` : ''}
        <div class="modal-f" style="border-top:1px solid var(--line);padding:12px 0 0;margin-top:12px"><button class="btn secondary sm tt-crow-apply" type="button">Apply</button></div>
      </div>` : ''}
    </div>`;
  }

  function wireRow(def) {
    const rowEl = root.querySelector(`[data-constraint-row="${def.type}"]`);
    if (!rowEl) return;
    const toggleEl = rowEl.querySelector('.tt-crow-toggle');
    const configEl = rowEl.querySelector('.tt-crow-config');
    const configureBtn = rowEl.querySelector('.tt-crow-configure');
    const hasConfig = def.needsSubjects || def.needsMax;

    rowEl.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = (e) => { e.preventDefault(); const cb = chip.querySelector('input'); cb.checked = !cb.checked; chip.classList.toggle('on', cb.checked); };
    });

    if (configureBtn) configureBtn.onclick = () => { configEl.style.display = configEl.style.display === 'none' ? '' : 'none'; };

    async function saveRow(enabled, config) {
      const existing = firstOfType(def.type);
      const res = await Db.timetable.constraints.save({ id: existing ? existing.id : undefined, type: def.type, enabled, config: config === undefined ? (existing ? existing.config : {}) : config });
      if (!res.ok) { toast(res.message, 'err'); return false; }
      if (existing) { existing.enabled = enabled; if (config !== undefined) existing.config = config; }
      else constraints.push(res.data && res.data.id ? res.data : { id: res.data, type: def.type, enabled, config: config || {} });
      return true;
    }

    function readConfig() {
      if (def.needsSubjects) return { subject_ids: [...rowEl.querySelectorAll('.ct-subject:checked')].map((el) => el.value) };
      if (def.needsMax) { const max = rowEl.querySelector('.ct-max').value; return { max: max ? Number(max) : null }; }
      return {};
    }

    toggleEl.onchange = async () => {
      const turningOn = toggleEl.checked;
      if (turningOn && hasConfig) {
        const config = readConfig();
        const missing = (def.needsSubjects && (config.subject_ids || []).length < def.minSubjects)
          || (def.needsMax && !(config.max > 0));
        if (missing) {
          // Not enough set up to actually turn this on yet — open the
          // editor so they can finish it, instead of silently enabling an
          // empty/meaningless constraint.
          toggleEl.checked = false;
          configEl.style.display = '';
          toast(def.needsSubjects ? `Pick at least ${def.minSubjects} subject${def.minSubjects === 1 ? '' : 's'} first.` : 'Enter a maximum of at least 1 period first.', 'err');
          return;
        }
      }
      await withSwitchBusy(toggleEl.closest('.tt-switch'), toggleEl, async () => {
        const ok = await saveRow(turningOn, hasConfig ? readConfig() : undefined);
        if (!ok) { toggleEl.checked = !turningOn; return; }
        toast(turningOn ? 'Enabled.' : 'Disabled.', 'ok');
      });
    };

    if (hasConfig) {
      rowEl.querySelector('.tt-crow-apply').onclick = (e) => withBusy(e.currentTarget, async () => {
        const config = readConfig();
        const missing = (def.needsSubjects && (config.subject_ids || []).length < def.minSubjects)
          || (def.needsMax && !(config.max > 0));
        if (missing) {
          toast(def.needsSubjects ? `Pick at least ${def.minSubjects} subject${def.minSubjects === 1 ? '' : 's'}.` : 'Enter a maximum of at least 1 period.', 'err');
          return;
        }
        const ok = await saveRow(true, config);
        if (!ok) return;
        toggleEl.checked = true;
        toast('Saved.', 'ok');
      }, 'Saving…');
    }
  }

  /* ------------------------------------------------- subject pairs list -- */
  function subjectPairsCardHtml() {
    const pairs = constraints.filter((c) => c.type === 'subject_pair_not_consecutive');
    return `<div class="card tt-constraint-group">
      <div class="card-h"><div><h3>Subject Pairs Kept Apart</h3><p class="hint" style="margin:2px 0 0">Prevents specific subject pairs from being scheduled back-to-back for the same class/stream.</p></div></div>
      <div class="card-b">
        ${subjects.length < 2 ? '<p class="hint" style="margin:0">Add at least 2 subjects to the school before configuring this.</p>' : `
        <div class="grid3">
          <div class="field"><label>Subject A</label><select id="pair-a">${options(subjects, 'id', 'name', '', 'Choose a subject')}</select></div>
          <div class="field"><label>Subject B</label><select id="pair-b">${options(subjects, 'id', 'name', '', 'Choose a subject')}</select></div>
          <div class="field"><label>&nbsp;</label><button class="btn secondary sm" id="pair-add">+ Add pair</button></div>
        </div>`}
      </div>
      ${pairs.length ? `<div class="tt-crow-list">${pairs.map((c) => `<div class="tt-crow" data-pair-id="${c.id}">
        <div class="tt-crow-main">
          <div class="tt-crow-text"><div class="tt-crow-title">${esc(subjectName(c.config.subject_a))} ↔ ${esc(subjectName(c.config.subject_b))}</div></div>
          <div class="tt-crow-actions">
            <button class="btn ghost sm pair-remove" type="button">Remove</button>
            <label class="tt-switch"><input type="checkbox" class="pair-enabled" ${c.enabled ? 'checked' : ''}><span class="tt-switch-slider"></span></label>
          </div>
        </div>
      </div>`).join('')}</div>` : ''}
    </div>`;
  }

  function wireSubjectPairs() {
    const addBtn = root.querySelector('#pair-add');
    if (addBtn) addBtn.onclick = (e) => withBusy(e.currentTarget, async () => {
      const a = root.querySelector('#pair-a').value, b = root.querySelector('#pair-b').value;
      if (!a || !b) { toast('Choose both subjects.', 'err'); return; }
      if (a === b) { toast('Choose two different subjects.', 'err'); return; }
      const res = await Db.timetable.constraints.save({ type: 'subject_pair_not_consecutive', enabled: true, config: { subject_a: a, subject_b: b } });
      if (!res.ok) { toast(res.message, 'err'); return; }
      constraints.push(res.data);
      toast('Pair added.', 'ok');
      draw();
    }, 'Adding…');

    root.querySelectorAll('.pair-enabled').forEach((chk) => chk.onchange = async () => {
      await withSwitchBusy(chk.closest('.tt-switch'), chk, async () => {
        const id = chk.closest('[data-pair-id]').dataset.pairId;
        const row = constraints.find((c) => c.id === id);
        const res = await Db.timetable.constraints.save({ id, type: row.type, enabled: chk.checked, config: row.config });
        if (!res.ok) { toast(res.message, 'err'); chk.checked = !chk.checked; return; }
        row.enabled = chk.checked;
        toast('Saved.', 'ok');
      });
    });
    root.querySelectorAll('.pair-remove').forEach((b) => b.onclick = () => {
      const id = b.closest('[data-pair-id]').dataset.pairId;
      confirmAction('Remove this pair?', async () => {
        await withBusy(b, async () => {
          const res = await Db.timetable.constraints.remove(id);
          if (!res.ok) { toast(res.message, 'err'); return; }
          const i = constraints.findIndex((c) => c.id === id);
          if (i > -1) constraints.splice(i, 1);
          toast('Removed.', 'ok');
          draw();
        }, 'Removing…');
      }, true);
    });
  }
}
