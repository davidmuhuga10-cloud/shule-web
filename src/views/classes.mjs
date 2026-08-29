/**
 * classes.mjs — "Classes & Streams" (Phase 2g / brief §4, the "most
 * significant change" of the feature brief).
 *
 * Three drill-down screens, all rendered into the same `root` on the one
 * '#/classes' route (same convention as exams.mjs/marksEntry.mjs's internal
 * panels — no new router path needed):
 *   1. renderList        — every class, click a row to open it
 *   2. renderClassDetail — that class's streams, click one to open it
 *   3. renderStreamSubjects — that stream's subjects + assigned teachers
 *
 * §4.1: Add Class no longer has a "description" field, and streams are
 * added via a clear "+ Add a stream" button/prompt instead of a
 * comma-separated free-text box.
 * §4.2/§4.3: subjects (and their teacher) are now assigned per STREAM, not
 * per class, and the standalone "Subjects" / "Class Subjects" nav items are
 * gone — creating a brand-new subject now happens inline from the stream's
 * "+ Add subject" picker.
 */
import { esc, modal, closeModal, toast, confirmAction, options, renderLoading, withBusy, state } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { STANDARD_CLASS_LEVELS, classLevelsForCategory, levelBucketForClassName, PATHWAYS } from '../lib/api/academics.mjs';
import { plainNameError } from '../lib/validators.mjs';

/** Next Sprint 3 §1.2: which class-level list this school's admin should be
 *  offered when adding a class, based on schools.category — see
 *  cbcDefaults.mjs's classLevelsForCategory() header comment for why this
 *  is a UI convenience, not an enforcement boundary. Falls back to
 *  'pri_jss' the same way the column itself defaults, so a profile loaded
 *  before this feature shipped (or mid-request, before state.profile is
 *  populated) behaves exactly as it always has. */
function schoolCategory() {
  return (state.profile && state.profile.schools && state.profile.schools.category) || 'pri_jss';
}

function categoryRangeLabel(category) {
  return category === 'senior' ? 'Grade 10 through Form 4' : 'Daycare through Grade 9';
}

export async function viewClasses(root) {
  await renderList(root);
}

/* ============================================================================
 * Screen 1 — all classes
 * ==========================================================================*/
async function renderList(root) {
  const [res, staffRes] = await Promise.all([Db.classes.list(), Db.staff.list()]);
  const classes = res.ok ? res.data : [];
  const staff = staffRes.ok ? staffRes.data : [];
  const staffMap = {}; staff.forEach((s) => { staffMap[s.id] = s.full_name; });

  const rows = classes.length
    ? classes.map((c) => `<tr class="clickable-row" data-open="${c.id}">
        <td>${esc(c.name)}</td>
        <td class="num">${c.stream_count}</td>
        <td class="num">${c.student_count}</td>
        <td>${esc(staffMap[c.class_teacher_staff_id] || '—')}</td>
        <td class="row-actions">
          <button class="btn sm secondary" data-manage="${c.id}">📂 Manage Class</button>
          <button class="btn sm secondary" data-edit="${c.id}">Edit</button>
          <button class="btn sm danger" data-del="${c.id}">Delete</button>
        </td></tr>`).join('')
    : '';

  root.innerHTML = `
    <div class="page-head"><div><h2>Classes &amp; Arms</h2><p>Click a class to manage its arms, subjects and teachers.</p></div>
      <div class="spacer"></div>
      <button class="btn secondary" id="bulk-add-classes">+ Bulk Add Classes</button>
      <button class="btn" id="add-class">+ Add class</button></div>
    <div class="card">
      ${classes.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Class</th><th class="num">Arms</th><th class="num">Students</th><th>Class Teacher</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<div class="card-b"><div class="empty">
          <div class="e-ico">🏫</div><h3>No classes yet</h3>
          <p>Add your first class from the standard list (e.g. "Grade 7") — you can add its arms next.</p>
          <button class="btn" id="empty-add-class">+ Add class</button>
        </div></div>`}
    </div>`;

  root.querySelector('#add-class').onclick = () => openClassModal(root, undefined, staff, classes);
  // Next Sprint 2 §2: bulk-add several classes at once, each with its own
  // (possibly multi-stream) arm list — the existing single-class flow above
  // is untouched, this is a separate, additional entry point.
  root.querySelector('#bulk-add-classes').onclick = () => openBulkAddClassesModal(root, classes);
  const emptyBtn = root.querySelector('#empty-add-class');
  if (emptyBtn) emptyBtn.onclick = () => openClassModal(root, undefined, staff, classes);
  root.querySelectorAll('[data-open]').forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest('[data-edit],[data-del],[data-manage]')) return;
    renderLoading(root, 'Loading arms, please wait…');
    renderClassDetail(root, classes.find((c) => c.id === tr.dataset.open), staff);
  });
  // Next Sprint 2 §1: the row itself was already clickable to drill into a
  // class's arms/subjects/teachers, but that wasn't obvious at a glance —
  // this button makes the same action explicit, sitting before Edit.
  root.querySelectorAll('[data-manage]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    renderLoading(root, 'Loading arms, please wait…');
    renderClassDetail(root, classes.find((c) => c.id === b.dataset.manage), staff);
  });
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    openClassModal(root, classes.find((c) => c.id === b.dataset.edit), staff, classes);
  });
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    confirmAction('Delete this class? This also removes its arms.', async () => {
      const r = await Db.classes.remove(b.dataset.del);
      if (r.ok) { toast('Class deleted.', 'ok'); renderList(root); } else toast(r.message, 'err');
    }, true);
  });
}

/**
 * Next Sprint 2 §2: "Bulk Add Classes — tick boxes to pick several classes
 * at once, type streams for each, support multiple streams per class." One
 * row per still-available standard class level; ticking a row reveals a
 * text input for that class's arm names (comma-separated, so "Blue, Red"
 * gives it two arms in one go). Goes through Db.classes.bulkSave() —
 * per-class save() calls under the hood, same validation as the existing
 * single-class flow, just looped — and reports a summary of what saved vs.
 * what didn't (e.g. a duplicate slipped in) rather than silently dropping
 * failures.
 */
function openBulkAddClassesModal(root, allClasses) {
  const category = schoolCategory();
  const usedNames = allClasses.map((c) => c.name.toLowerCase());
  // Next Sprint 3 §1.3: a Grade 10-12 arm MUST have a pathway chosen for it
  // (its default subjects depend on it), and bulk-add's one-arms-textbox-
  // per-class shape has no room to ask that per arm — so pathway-based
  // classes are deliberately left out of this picker; add them one at a
  // time from "+ Add class" instead, where promptAddStream asks for each
  // arm's pathway individually. Form 3/4 have no pathway concept at all
  // (brief §1.4) so they stay available here same as any Pri/Jss class.
  const available = classLevelsForCategory(category)
    .filter((n) => usedNames.indexOf(n.toLowerCase()) === -1)
    .filter((n) => levelBucketForClassName(n) !== 'Senior Secondary');
  if (!available.length) {
    modal({
      title: 'Bulk Add Classes',
      body: `<p class="hint" style="margin-top:0">All standard classes (${esc(categoryRangeLabel(category))}) have already been added.${category === 'senior' ? ' Grade 10-12 classes are added one at a time from "+ Add class" instead, since each arm needs its own pathway chosen.' : ''}</p>`,
      okLabel: 'Close',
      onOk: () => closeModal()
    });
    return;
  }
  const checked = new Set();
  modal({
    title: 'Bulk Add Classes',
    wide: true,
    body: `
      <p class="hint" style="margin-top:0">Tick every class you want to add, then type its arm names (comma-separated — e.g. "Blue, Red") before saving.</p>
      <table class="data"><thead><tr><th style="width:36px"></th><th>Class</th><th>Arms</th></tr></thead>
      <tbody>${available.map((n) => `<tr>
        <td><input type="checkbox" data-bulk-pick="${esc(n)}"></td>
        <td>${esc(n)}</td>
        <td><input type="text" data-bulk-streams="${esc(n)}" placeholder="e.g. Blue, Red" disabled></td>
      </tr>`).join('')}</tbody></table>
    `,
    okLabel: 'Save selected classes',
    busyLabel: 'Adding classes, please wait…',
    onOk: async () => {
      const items = [...checked].map((n) => {
        const input = document.querySelector(`[data-bulk-streams="${CSS.escape(n)}"]`);
        const streams = (input ? input.value : '').split(',').map((s) => s.trim()).filter(Boolean);
        return { name: n, streams };
      });
      if (!items.length) { toast('Tick at least one class.', 'err'); return; }
      const missingStreams = items.find((it) => !it.streams.length);
      if (missingStreams) { toast(`Add at least one arm for ${missingStreams.name}.`, 'err'); return; }
      const res = await Db.classes.bulkSave(items);
      if (!res.ok) { toast(res.message, 'err'); return; }
      const { created, total, failed } = res.data;
      closeModal();
      if (failed && failed.length) {
        toast(`Added ${created} of ${total} classes. Failed: ${failed.map((f) => f.name).join(', ')}.`, created ? 'ok' : 'err');
      } else {
        toast(`Added ${created} class(es).`, 'ok');
      }
      renderList(root);
    },
    onOpen: () => {
      document.querySelectorAll('[data-bulk-pick]').forEach((cb) => cb.onchange = () => {
        const name = cb.dataset.bulkPick;
        const streamInput = document.querySelector(`[data-bulk-streams="${CSS.escape(name)}"]`);
        if (cb.checked) { checked.add(name); if (streamInput) streamInput.disabled = false; }
        else { checked.delete(name); if (streamInput) { streamInput.disabled = true; streamInput.value = ''; } }
      });
    }
  });
}

function openClassModal(root, existing, staff, allClasses) {
  staff = staff || [];
  allClasses = allClasses || [];
  const category = schoolCategory();
  const usedNames = allClasses.map((c) => c.name.toLowerCase());
  const available = classLevelsForCategory(category).filter((n) => usedNames.indexOf(n.toLowerCase()) === -1);
  let pendingStreams = []; // only used when adding a brand-new class — [{ name, pathway }]
  // Bug fix (surfaced by Next Sprint 3's interactive test, but pre-existing
  // and unrelated to Senior School itself): renderModal() rebuilds this
  // whole modal's HTML from scratch every time an arm is queued (or
  // un-queued), including a BRAND-NEW <select id="cl-name">. Without
  // remembering the previously chosen class name here and re-selecting it
  // on each render, choosing a class, then adding even one arm, silently
  // reset the class picker back to blank — "Please choose a class." on
  // Save, after the admin had already picked one and added its arms.
  let chosenClassName = '';

  renderModal();

  function renderModal() {
    const nameField = existing
      ? `<input id="cl-name" value="${esc(existing.name)}" disabled>`
      : (available.length
          ? `<select id="cl-name">${options(available.map((n) => ({ id: n, name: n })), 'id', 'name', chosenClassName, 'Choose a class')}</select>`
          : `<input id="cl-name" value="" disabled><p class="hint" style="color:var(--danger,#c0392b)">All standard classes (${esc(categoryRangeLabel(category))}) have already been added.</p>`);

    const pendingChips = pendingStreams.map((s, i) => `<span class="chip on" data-pending="${i}">${esc(s.name)}${s.pathway ? ' · ' + esc(s.pathway) : ''} &times;</span>`).join('');

    modal({
      title: existing ? 'Edit class' : 'Add class',
      body: `
        <div class="field"><label>Class</label>${nameField}</div>
        <div class="field">
          <label>Class teacher (optional)</label>
          <select id="cl-teacher">${options(staff.filter((s) => s.status === 'active'), 'id', 'full_name', existing ? existing.class_teacher_staff_id : '', 'None')}</select>
          <p class="hint">The class teacher can approve this class's submitted results in the publishing workflow.</p>
        </div>
        ${!existing ? `
        <div class="field">
          <label>Arms<span style="color:var(--danger)"> *</span></label>
          <div class="chips" id="pending-chips" style="margin-bottom:10px">${pendingChips || '<span class="muted" style="font-size:13px">No arms added yet — add at least one to continue.</span>'}</div>
          <button type="button" class="btn ghost sm" id="cl-add-stream">+ Add an arm</button>
          <p class="hint">Every class needs at least one arm — if this class only has one group, add a single arm for it (e.g. "Main"). You can add more later from the class page.</p>
        </div>` : `<p class="hint">Manage this class's arms, subjects and teachers from its page after saving.</p>`}
      `,
      okLabel: 'Save',
      busyLabel: existing ? 'Saving changes, please wait…' : 'Adding class, please wait…',
      onOk: async () => {
        const name = document.getElementById('cl-name').value;
        const class_teacher_staff_id = document.getElementById('cl-teacher').value || null;
        // Round 3 §17: caught here for immediate feedback (no round trip) —
        // academics.mjs's classes.save() enforces the same rule server-side
        // regardless, since the client-side check alone is never trusted.
        if (!existing && !pendingStreams.length) { toast('Add at least one arm before saving — e.g. "Main" if this class only has one group.', 'err'); return; }
        const res = await Db.classes.save({ id: existing ? existing.id : undefined, name, class_teacher_staff_id, streams: pendingStreams });
        if (!res.ok) { toast(res.message, 'err'); return; }
        if (res.streamsAdded) toast(`Class saved — ${res.streamsAdded} arm(s) added.`, 'ok');
        else toast('Class saved.', 'ok');
        closeModal();
        renderList(root);
      }
    });

    if (!existing) {
      const nameSelect = document.getElementById('cl-name');
      if (nameSelect) {
        chosenClassName = nameSelect.value; // in case the browser restored a value on its own
        nameSelect.onchange = () => { chosenClassName = nameSelect.value; };
      }
      document.getElementById('cl-add-stream').onclick = () => {
        // Next Sprint 3 §1.3: use the remembered chosenClassName, not a
        // fresh DOM read — see the header comment above on why the select
        // itself can't be trusted to still hold it after a re-render, and
        // why this needs to reflect whatever was chosen most recently
        // regardless (a Grade 10-12 choice needs its arms to ask for a
        // pathway).
        const requirePathway = levelBucketForClassName(chosenClassName) === 'Senior Secondary';
        promptAddStream((nm, pathway) => {
          pendingStreams.push({ name: nm, pathway: pathway || null });
          renderModal();
        }, undefined, { requirePathway });
      };
      document.querySelectorAll('#pending-chips [data-pending]').forEach((chip) => {
        chip.onclick = () => { pendingStreams.splice(Number(chip.dataset.pending), 1); renderModal(); };
      });
    }
  }
}

/** A tiny, focused "type one stream name" prompt — the "+" button's popup
 *  (brief §4.1: a clear "click to add a stream" affordance instead of a
 *  comma-separated free-text field). Shared by the Add Class modal (queues
 *  streams before the class exists), the Class Detail screen (adds a
 *  stream to an already-saved class immediately), and now (Round 2 §4)
 *  renaming an existing stream — pass `existingName` to switch the modal
 *  into rename mode (pre-filled input, "Rename"/"Save" wording).
 *
 *  Round 2 §2 (BUG): "Blue,Red" used to be accepted with no validation at
 *  all — this now rejects anything but letters/digits/spaces client-side,
 *  same rule academics.mjs's streams.save() enforces server-side (never
 *  trust the client-side check alone), so the person gets an immediate,
 *  specific "no commas or special characters" message instead of a
 *  silently-accepted bad value or, at best, a generic server error.
 *
 *  Next Sprint 3 §1.3: pass `{ requirePathway: true }` for a Grade 10-12
 *  arm — adds a required Pathway dropdown to the same modal, and `onAdd`
 *  is then called as `onAdd(name, pathway)` instead of just `onAdd(name)`.
 *  Never shown for a rename (a stream's pathway isn't editable this way —
 *  see academics.mjs's streams.save() comment on why). */
function promptAddStream(onAdd, existingName, opts) {
  opts = opts || {};
  const requirePathway = !!opts.requirePathway && existingName === undefined;
  const isRename = existingName !== undefined && existingName !== null;
  modal({
    title: isRename ? 'Rename arm' : 'Add an arm',
    body: `
      <div class="field"><label>Arm name</label><input id="stream-name-input" value="${esc(isRename ? existingName : '')}" placeholder="e.g. North, East, Blue"></div>
      ${requirePathway ? `
      <div class="field">
        <label>Pathway<span style="color:var(--danger)"> *</span></label>
        <select id="stream-pathway-input">${options(PATHWAYS.map((p) => ({ id: p, name: p })), 'id', 'name', '', 'Choose a pathway')}</select>
        <p class="hint">Every Grade 10-12 arm needs a pathway — its subjects (core + the pathway's own specialised ones) depend on it.</p>
      </div>` : ''}
    `,
    okLabel: isRename ? 'Save' : 'Add',
    onOk: () => {
      const val = document.getElementById('stream-name-input').value.trim();
      const error = plainNameError(val, 'Arm name');
      if (error) { toast(error, 'err'); return; }
      let pathway = null;
      if (requirePathway) {
        const pwEl = document.getElementById('stream-pathway-input');
        pathway = pwEl ? pwEl.value : '';
        if (!pathway) { toast('Choose this arm\'s pathway.', 'err'); return; }
      }
      closeModal();
      onAdd(val, pathway);
    }
  });
  const input = document.getElementById('stream-name-input');
  if (input) { input.focus(); input.select(); }
}

/* ============================================================================
 * Screen 2 — one class's streams
 * ==========================================================================*/
async function renderClassDetail(root, cls, staff) {
  const sres = await Db.streams.list(cls.id);
  const streams = sres.ok ? sres.data : [];

  const rows = streams.length
    ? streams.map((s) => `
      <div class="card" style="margin-bottom:10px">
        <div class="card-b stream-row clickable-row" data-open-stream="${s.id}">
          <div class="stream-info">
            <div style="font-weight:650">${esc(s.name)}${s.pathway ? ` <span class="badge blue" style="font-weight:500">${esc(s.pathway)}</span>` : ''}</div>
            <div class="muted" style="font-size:12.5px">${s.student_count} student(s)</div>
          </div>
          <button class="btn manage-btn">Manage Subjects &amp; Teachers →</button>
          <button class="btn sm secondary" data-rename-stream="${s.id}">Rename</button>
          <button class="btn sm danger stream-del" data-del-stream="${s.id}">Delete</button>
        </div>
      </div>`).join('')
    : `<div class="card"><div class="card-b"><div class="empty">
        <div class="e-ico">🔀</div><h3>No arms yet</h3>
        <p>Add this class's first arm to start assigning subjects and teachers.</p>
      </div></div></div>`;

  root.innerHTML = `
    <div class="page-head">
      <div><a class="back-link" id="back-to-classes">← All classes</a><h2>${esc(cls.name)}</h2><p>Arms for this class — click one to manage its subjects and teachers.</p></div>
      <div class="spacer"></div><button class="btn" id="add-stream">+ Add an arm</button>
    </div>
    ${rows}
  `;

  root.querySelector('#back-to-classes').onclick = () => { renderLoading(root, 'Loading classes, please wait…'); renderList(root); };
  root.querySelector('#add-stream').onclick = () => {
    const requirePathway = levelBucketForClassName(cls.name) === 'Senior Secondary';
    promptAddStream(async (name, pathway) => {
      const res = await Db.streams.save({ class_id: cls.id, name, pathway });
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast('Arm added.', 'ok');
      renderClassDetail(root, cls, staff);
    }, undefined, { requirePathway });
  };
  root.querySelectorAll('[data-open-stream]').forEach((el) => el.onclick = (e) => {
    if (e.target.closest('[data-del-stream]') || e.target.closest('[data-rename-stream]')) return;
    renderLoading(root, 'Loading subjects & teachers, please wait…');
    renderStreamSubjects(root, cls, streams.find((s) => s.id === el.dataset.openStream), staff);
  });
  // Round 2 §4: there was previously no way to rename an existing stream.
  root.querySelectorAll('[data-rename-stream]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const stream = streams.find((s) => s.id === b.dataset.renameStream);
    promptAddStream(async (name) => {
      const res = await Db.streams.save({ id: stream.id, class_id: cls.id, name });
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast('Arm renamed.', 'ok');
      renderClassDetail(root, cls, staff);
    }, stream.name);
  });
  root.querySelectorAll('[data-del-stream]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    confirmAction('Delete this arm?', async () => {
      const r = await Db.streams.remove(b.dataset.delStream);
      if (!r.ok) { toast(r.message, 'err'); return; }
      toast('Arm deleted.', 'ok');
      renderClassDetail(root, cls, staff);
    }, true);
  });
}

/* ============================================================================
 * Screen 3 — one stream's subjects + teachers
 * ==========================================================================*/
async function renderStreamSubjects(root, cls, stream, staff) {
  const res = await Db.assignments.getStreamSubjects(stream.id);
  const rows = res.ok ? res.data : [];
  const inherited = res.ok ? !!res.inherited : false;
  const activeStaff = (staff || []).filter((s) => s.status === 'active');

  const subjectRows = rows.length ? rows.map((r) => `
    <tr>
      <td>${esc(r.name)}</td>
      <td><select data-teacher-for="${r.subject_id}" style="max-width:220px">${options(activeStaff, 'id', 'full_name', r.teacher_staff_id || '', 'No teacher assigned')}</select></td>
      <td class="row-actions"><button class="btn sm danger" data-remove-subject="${r.subject_id}">Delete</button></td>
    </tr>`).join('') : `<tr><td colspan="3" class="muted center">No subjects assigned yet — click "+ Add subject" to get started.</td></tr>`;

  root.innerHTML = `
    <div class="page-head">
      <div><a class="back-link" id="back-to-class">← ${esc(cls.name)}</a><h2>${esc(stream.name)} — Subjects &amp; Teachers</h2>
      <p>${rows.length ? (inherited ? 'Currently using the class-wide default set — customizing here only changes this arm.' : 'Only these subjects appear in marks entry for this arm.') : 'This is exactly what teachers will see in marks entry for this arm.'}</p></div>
      <div class="spacer"></div><button class="btn" id="add-subject">+ Add subject</button>
    </div>
    <div class="card"><div class="table-wrap"><table class="data">
      <thead><tr><th>Subject</th><th>Teacher</th><th></th></tr></thead>
      <tbody>${subjectRows}</tbody>
    </table></div></div>
  `;

  root.querySelector('#back-to-class').onclick = () => { renderLoading(root, 'Loading arms, please wait…'); renderClassDetail(root, cls, staff); };
  root.querySelector('#add-subject').onclick = () => openAddSubjectModal(root, cls, stream, staff, rows.map((r) => r.subject_id));
  root.querySelectorAll('[data-teacher-for]').forEach((sel) => sel.onchange = async () => {
    const r2 = await Db.assignments.setStreamSubjectTeacher({ stream_id: stream.id, class_id: cls.id, subject_id: sel.dataset.teacherFor, staff_id: sel.value || null });
    if (!r2.ok) { toast(r2.message, 'err'); return; }
    toast('Teacher updated.', 'ok');
  });
  root.querySelectorAll('[data-remove-subject]').forEach((b) => b.onclick = () => confirmAction('Remove this subject from the arm?', async () => {
    const r = await Db.assignments.removeStreamSubject(stream.id, b.dataset.removeSubject);
    if (!r.ok) { toast(r.message, 'err'); return; }
    toast('Subject removed.', 'ok');
    renderStreamSubjects(root, cls, stream, staff);
  }, true));
}

/** Tick-list modal over the FULL subject catalog, grouped by CBC level, with
 *  an inline "+ new subject" mini-form — this is Section 4.3's "add a
 *  subject via an option that opens the full subject list to tick from"
 *  plus what used to be the standalone Subjects module's create action,
 *  folded in here since that module no longer has its own nav entry. */
async function openAddSubjectModal(root, cls, stream, staff, alreadyAssignedIds) {
  const subjectsRes = await Db.subjects.list();
  let subjects = subjectsRes.ok ? subjectsRes.data : [];
  const selected = new Set(alreadyAssignedIds.map(String));

  renderModal();

  function renderModal() {
    const levels = [...new Set(subjects.map((s) => s.level || 'Custom / other'))];
    const groups = levels.map((level) => {
      const inLevel = subjects.filter((s) => (s.level || 'Custom / other') === level);
      const chips = inLevel.map((s) => `<span class="chip ${selected.has(String(s.id)) ? 'on' : ''}" data-subject="${s.id}">${esc(s.name)}</span>`).join('');
      return `<div style="margin-bottom:14px"><div class="muted" style="font-weight:650;font-size:12px;text-transform:uppercase;margin-bottom:6px">${esc(level)}</div><div class="chips">${chips}</div></div>`;
    }).join('');

    modal({
      title: `Add subjects — ${stream.name}`,
      wide: true,
      body: `
        ${groups || '<p class="muted">No subjects in the system yet — add one below.</p>'}
        <div class="field" style="margin-top:6px;border-top:1px solid var(--line);padding-top:14px">
          <label>Add a new subject to the system (optional)</label>
          <div style="display:flex;gap:8px">
            <input id="new-subject-name" placeholder="e.g. French" style="flex:1">
            <button type="button" class="btn ghost sm" id="new-subject-add">+ Add</button>
          </div>
        </div>
      `,
      okLabel: 'Save selection',
      onOk: async () => {
        const res = await Db.assignments.setStreamSubjects(stream.id, cls.id, [...selected]);
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast(`Saved ${res.count} subject(s) for ${stream.name}.`, 'ok');
        closeModal();
        renderStreamSubjects(root, cls, stream, staff);
      }
    });

    document.querySelectorAll('[data-subject]').forEach((chip) => chip.onclick = () => {
      const id = String(chip.dataset.subject);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      chip.classList.toggle('on');
    });
    const addBtn = document.getElementById('new-subject-add');
    if (addBtn) addBtn.onclick = () => withBusy(addBtn, async () => {
      const nameInput = document.getElementById('new-subject-name');
      const name = nameInput.value.trim();
      if (!name) return;
      const res = await Db.subjects.save({ name });
      if (!res.ok) { toast(res.message, 'err'); return; }
      subjects = [...subjects, res.data];
      selected.add(String(res.data.id));
      toast('Subject added.', 'ok');
      renderModal();
    }, 'Adding…');
  }
}
