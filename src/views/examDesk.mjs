/**
 * examDesk.mjs — "Exam Desk" (System Fixes & Exam Desk Redesign brief §14).
 *
 * Deliberately merges what used to be THREE separate nav items — Manage
 * Exams, Enter Marks, Publish Results — into one module and one screen flow.
 * The brief's own framing: "Publish Results is genuinely useful but rarely
 * used because admins live in Manage Exams... merge it directly in... call
 * it Exam Desk" (a name picked on purpose to be different from Zeraki's own
 * naming, per the brief).
 *
 * Flow:
 *   1. Board screen (renderBoardScreen) — same exam board as the old
 *      exams.mjs: create/edit exams, see every ticked class with its status.
 *   2. Detail screen (renderDetailScreen) — clicking a class's action drills
 *      into that exam+class with three in-page tabs, in order: "Review and
 *      Publish", "Marks Entry", "Bulk Upload" (Round 2 §8 — renamed/reordered
 *      from the old "Marks Entry" / "Publish & Review" pair, with Bulk Upload
 *      promoted out of a toggle inside Marks Entry into its own tab).
 *      renderPublishPanel/renderMarksPanel/renderMarksBulkPanel from
 *      publishing.mjs/marksEntry.mjs are embeddable panels for exactly this
 *      purpose. Switching tabs — even the "fix this subject"
 *      shortcut from the Publish tab — never leaves the page, matching the
 *      brief's literal "one place" requirement, not just a cosmetic rename.
 *
 * Deleted Exams (brief §8) is its own module (deletedExams.mjs) and its own
 * nav tile, not part of this file — see examsHub.mjs.
 */
import { esc, modal, closeModal, toast, confirmAction, options, renderPrereq, loader, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { EXAM_TYPE_LABELS } from '../lib/api/results.mjs';
import { setNavIntent } from '../lib/navIntent.mjs';
import { renderMarksPanel, renderMarksBulkPanel } from './marksEntry.mjs';
import { CBC_LEVELS, levelBucketForClassName } from '../lib/api/cbcDefaults.mjs';
import { renderPublishPanel } from './publishing.mjs';

const EXAM_TYPE_CHOICES = Object.keys(EXAM_TYPE_LABELS).map((k) => ({ id: k, name: EXAM_TYPE_LABELS[k] }));

export async function viewExamDesk(root) {
  const [yearsRes, termsRes] = await Promise.all([Db.academicYears.list(), Db.terms.list()]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const terms = termsRes.ok ? termsRes.data : [];
  if (!years.length || !terms.length) {
    renderPrereq(root, 'Academic calendar not set up', 'Please create an academic year and a term before adding exams.', 'settings', 'Go to Settings');
    return;
  }
  await renderBoardScreen(root, years, terms);
}

/* ============================================================================
 * Screen 1 — exam board (create exams, see every class's status)
 * ==========================================================================*/
async function renderBoardScreen(root, years, terms) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];

  root.innerHTML = `
    <div class="page-head"><div><h2>Exam Desk</h2><p>Create an exam, choose which classes are sitting it, then enter marks and publish — everything happens right here.</p></div>
      <div class="spacer"></div><button class="btn" id="add-exam">+ Add exam</button></div>
    <div id="exam-board">${exams.length ? '' : `<div class="card"><div class="card-b"><div class="empty">
      <div class="e-ico">📝</div><h3>No exams yet</h3><p>Add your first exam (e.g. "Midterm Exam" or "End of Term 1 Exam").</p>
      <button class="btn" id="empty-add-exam">+ Add exam</button>
    </div></div></div>`}</div>`;

  root.querySelector('#add-exam').onclick = () => openExamModal(root, years, terms, classes);
  const emptyBtn = root.querySelector('#empty-add-exam');
  if (emptyBtn) emptyBtn.onclick = () => openExamModal(root, years, terms, classes);

  if (exams.length) await renderBoard(root, exams, classes, years, terms);
}

async function renderBoard(root, exams, classes, years, terms) {
  const board = root.querySelector('#exam-board');
  board.innerHTML = loader();
  const classRowsByExam = await Promise.all(exams.map((e) => Db.results.listExamClasses(e.id)));
  const rowsByExamId = {};
  exams.forEach((e, i) => { rowsByExamId[e.id] = classRowsByExam[i].ok ? classRowsByExam[i].data : []; });

  board.innerHTML = exams.map((e) => examCard(e, rowsByExamId[e.id])).join('');

  exams.forEach((e) => {
    const card = board.querySelector(`[data-exam-card="${e.id}"]`);
    if (!card) return;
    const classRows = rowsByExamId[e.id];
    card.querySelector('[data-edit-exam]').onclick = () => openExamModal(root, years, terms, classes, e, classRows);
    card.querySelector('[data-add-classes]').onclick = () => openClassPickerModal(root, e, classRows, () => renderBoardScreen(root, years, terms));
    // Brief §8: Delete now soft-deletes (Deleted Exams submodule, 30-day
    // window) instead of the old immediate hard delete.
    card.querySelector('[data-del-exam]').onclick = () => confirmAction('Move this exam to Deleted Exams? It can be restored within 30 days, after which it (and any marks recorded for it) is permanently removed.', async () => {
      const r = await Db.results.softDeleteExam(e.id);
      if (r.ok) { toast('Exam moved to Deleted Exams.', 'ok'); renderBoardScreen(root, years, terms); } else toast(r.message, 'err');
    }, true);

    // Brief §14: these used to navigate away to separate Enter
    // Marks/Publish Results pages — now they open an in-page detail view
    // for this exam+class instead, with the matching tab pre-selected.
    // (Round 3 §9 removed the separate data-continue action — every
    // pre-publish state now shares this same data-review button.)
    card.querySelectorAll('[data-review]').forEach((b) => b.onclick = () => {
      renderDetailScreen(root, years, terms, e, b.dataset.review, { tab: 'publish' });
    });
    card.querySelectorAll('[data-print]').forEach((b) => b.onclick = () => {
      setNavIntent('report-forms', { exam_id: e.id, class_id: b.dataset.print });
      go('reports');
    });
    // Step 13 — post-publish admin actions.
    card.querySelectorAll('[data-analyze]').forEach((b) => b.onclick = () => {
      setNavIntent('exam-analysis', { exam_id: e.id, class_id: b.dataset.analyze });
      go('exam-analysis');
    });
    card.querySelectorAll('[data-send-results]').forEach((b) => b.onclick = () => confirmAction(
      'Send this class\'s results to parents now? This marks the class "Released" and takes you to Messaging to send.',
      async () => {
        const r = await Db.results.markReleased(e.id, b.dataset.sendResults);
        if (!r.ok) { toast(r.message, 'err'); return; }
        setNavIntent('messaging', { exam_id: e.id, class_id: b.dataset.sendResults, scope: 'exam_results' });
        go('messaging');
      }
    ));
    card.querySelectorAll('[data-withdraw]').forEach((b) => b.onclick = () => confirmAction(
      'Withdraw this class\'s published results? Every published subject goes back to "not submitted" — parents will no longer see them until you republish.',
      async () => {
        const r = await Db.results.withdrawExam(e.id, b.dataset.withdraw);
        if (!r.ok) { toast(r.message, 'err'); return; }
        toast(`Withdrew ${r.reopened} of ${r.total} subject(s).`, 'ok');
        renderBoard(root, exams, classes, years, terms);
      },
      true
    ));
  });
}

const STATUS_META = {
  no_students: { label: 'No students enrolled', cls: 'grey' },
  no_subjects: { label: 'No subjects assigned', cls: 'grey' },
  not_started: { label: 'Results Not Uploaded', cls: 'red' },
  // Round 3 §9: relabeled from "Marks incomplete" — at least one teacher
  // has actually started uploading marks at this point, so "in progress"
  // reads as the accurate, non-alarming description of where things stand,
  // rather than something sounding like a problem to fix.
  in_progress: { label: 'Marks entry in progress', cls: 'amber' },
  ready_to_publish: { label: 'Pending Publishing', cls: 'blue' },
  published: { label: 'Published', cls: 'green' },
  released: { label: 'Released', cls: 'green' }
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function examCard(exam, classRows) {
  const rowsHtml = classRows.length ? `<div class="table-wrap"><table class="data">
    <thead><tr><th>Class</th><th>Subjects with marks</th><th>Status</th><th>Last published</th><th></th></tr></thead>
    <tbody>${classRows.map((r) => {
      const meta = STATUS_META[r.status] || { label: r.status, cls: 'grey' };
      let action = '';
      // Brief §7's "classes dropped on save" bug: the real cause was this
      // board silently hiding zero-enrollment classes, not saveExam()
      // losing data. A ticked class with no students now stays visible with
      // an honest "No students enrolled" status and no action, instead of
      // vanishing from the board entirely.
      // Round 2 §8 + Round 3 §9: every actionable pre-publish state
      // (not_started, in_progress, ready_to_publish) now shares the exact
      // same "✅ Review and Publish" button, landing on the same first tab —
      // Round 3 §9 explicitly asked to stop introducing alternate wording
      // like "Continue to marks entry" at different states, since a
      // different label made it look like a different, unrelated action.
      // The Review and Publish tab already surfaces per-subject "Edit
      // Marks" shortcuts for anyone who just wants to jump straight into
      // entering marks for one subject.
      if (r.status === 'no_students') action = `<span class="muted" style="font-size:12px">Enrol students in this class first</span>`;
      else if (r.status === 'no_subjects') action = `<span class="muted" style="font-size:12px">Assign subjects to this class first</span>`;
      else if (r.status === 'not_started' || r.status === 'in_progress' || r.status === 'ready_to_publish') {
        action = `<button class="btn ghost sm" data-review="${r.class_id}">✅ Review and Publish</button>`;
      }
      else {
        // Step 13: published/released classes get the full set of
        // post-publish actions instead of just "Print Reports".
        action = `
          <button class="btn ghost sm" data-analyze="${r.class_id}">🔎 Analyze</button>
          <button class="btn ghost sm" data-send-results="${r.class_id}">📨 Send Results</button>
          <button class="btn ghost sm" data-print="${r.class_id}">🖨️ Print Reports</button>
          <button class="btn ghost sm" data-withdraw="${r.class_id}">↩️ Withdraw</button>`;
      }
      const lastPub = (r.status === 'published' || r.status === 'released') && r.last_published_at
        ? `${fmtDate(r.last_published_at)}${r.last_published_by ? ` by ${esc(r.last_published_by)}` : ''}` : '—';
      return `<tr>
        <td>${esc(r.class_name)}</td>
        <td>${r.subjects_with_marks}/${r.subjects_total || '0'}</td>
        <td><span class="badge ${meta.cls}">${esc(meta.label)}</span></td>
        <td class="muted" style="font-size:12px">${lastPub}</td>
        <td class="row-actions">${action}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` : `<div class="card-b"><p class="muted center" style="margin:0">No classes selected yet for this exam — click "+ Add classes" to choose which classes are sitting it.</p></div>`;

  return `<div class="card" style="margin-bottom:16px" data-exam-card="${exam.id}">
    <div class="card-h">
      <h3>${esc(exam.name)}</h3>
      <span class="badge grey">${esc(EXAM_TYPE_LABELS[exam.exam_type] || exam.exam_type || 'Normal Exam')}</span>
      <span class="badge blue">${esc(exam.academic_year_name)} · ${esc(exam.term_name)}</span>
      <div class="spacer"></div>
      <button class="btn ghost sm" data-add-classes>+ Add classes</button>
      <button class="btn sm secondary" data-edit-exam>Edit</button>
      <button class="btn sm danger" data-del-exam>Delete</button>
    </div>
    ${rowsHtml}
  </div>`;
}

/* ============================================================================
 * Screen 2 — exam+class detail (Review and Publish / Marks Entry / Bulk Upload tabs)
 * ==========================================================================*/
async function renderDetailScreen(root, years, terms, exam, classId, sel) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  const cls = classes.find((c) => String(c.id) === String(classId));

  root.innerHTML = `
    <div class="page-head">
      <div>
        <button class="btn ghost sm" id="ed-back" style="margin-bottom:8px">← Back to Exam Desk</button>
        <h2>${esc(exam.name)}${cls ? ` — ${esc(cls.name)}` : ''}</h2>
        <p>Enter marks, then review and publish — all in one place.</p>
      </div>
    </div>
    <div class="tabs" style="max-width:560px">
      <button data-tab="publish" class="${sel.tab === 'marks' || sel.tab === 'bulk' ? '' : 'active'}">✅ Review and Publish</button>
      <button data-tab="marks" class="${sel.tab === 'marks' ? 'active' : ''}">✍️ Marks Entry</button>
      <button data-tab="bulk" class="${sel.tab === 'bulk' ? 'active' : ''}">📥 Bulk Upload</button>
    </div>
    <div id="ed-panel"></div>
  `;

  root.querySelector('#ed-back').onclick = () => renderBoardScreen(root, years, terms);
  root.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => renderDetailScreen(root, years, terms, exam, classId, { tab: b.dataset.tab }));

  const panel = root.querySelector('#ed-panel');
  if (sel.tab === 'marks') {
    await renderMarksPanel(panel, { exam_id: exam.id, class_id: classId, subject_id: sel.subject_id || '' });
  } else if (sel.tab === 'bulk') {
    await renderMarksBulkPanel(panel, { exam_id: exam.id, class_id: classId });
  } else {
    // The "Edit Marks"/"Upload" shortcuts inside the Publish tab flip this
    // same screen back to the Marks Entry tab, pre-selected to that
    // subject, instead of navigating away — see publishing.mjs's
    // onEditSubject callback plumbing. Defaults here (no tab, or tab:
    // 'publish') land on "Review and Publish" — now the first tab.
    await renderPublishPanel(panel, { exam_id: exam.id, class_id: classId }, (subjectId) => {
      renderDetailScreen(root, years, terms, exam, classId, { tab: 'marks', subject_id: subjectId });
    });
  }
}

/** Brief §7.1 (unchanged from the old Manage Exams): creating (or editing)
 *  an exam prompts the admin to select which classes are sitting it — a
 *  class that already has recorded marks for this exam can't be unticked
 *  here (it's disabled, matching what saveExam's server-side guard already
 *  enforces).
 *
 *  Round 2 §7 (approved design — GATED task, mockup reviewed and signed off
 *  before this was built): the previous two redesign attempts were still a
 *  table of rows, and a fixed-width "min. learning areas" input squeezed
 *  next to the class name meant full names ("Grade 1") had no room and
 *  wrapped mid-word ("G" / "1"). Rebuilt as a card grid instead — each class
 *  is its own grid cell with no competing column, so a name always gets as
 *  much room as it needs; the "min. learning areas" field only appears
 *  INSIDE a card once it's selected, so most cards (the unselected ones)
 *  stay lightweight; classes are grouped by CBC level (levelBucketForClassName,
 *  the same bucketing cbcDefaults.mjs already provides), echoing the
 *  level-grouped chip layout Subjects already uses under Classes & Streams;
 *  a search box + Select all/Clear cover schools with many classes.
 *  Brief §6: "Supplementary Exam"/"Written Exam" renamed to "CAT"/"Normal
 *  Exam" (EXAM_TYPE_LABELS, results.mjs) and the "out of marks" field is
 *  gone entirely — exams are no longer created with a fixed max score. */
function groupClassesByLevel(classes) {
  const order = [...CBC_LEVELS, 'Other'];
  const byLevel = {};
  classes.forEach((c) => {
    const level = levelBucketForClassName(c.name) || 'Other';
    (byLevel[level] = byLevel[level] || []).push(c);
  });
  return order.filter((level) => byLevel[level] && byLevel[level].length).map((level) => ({ level, classes: byLevel[level] }));
}

function classCardHtml(c, selectedIds, lockedIds, minByClass) {
  const isSelected = selectedIds.has(c.id);
  const isLocked = lockedIds.has(c.id);
  const minVal = minByClass[c.id] === null || minByClass[c.id] === undefined ? '' : minByClass[c.id];
  return `
    <div class="ex-class-card${isSelected ? ' on' : ''}${isLocked ? ' locked' : ''}" data-class-card="${c.id}" data-class-name="${esc(c.name.toLowerCase())}">
      <div class="ex-class-top">
        <span class="ex-class-check">✓</span>
        <input type="checkbox" data-class-check value="${c.id}" ${isSelected ? 'checked' : ''} ${isLocked ? 'disabled' : ''} style="position:absolute;opacity:0;width:0;height:0">
        <span class="ex-class-name">${esc(c.name)}</span>
      </div>
      ${isLocked ? '<div class="ex-class-locked-note">🔒 Has marks recorded — can\'t be removed</div>' : ''}
      <div class="ex-class-min">
        <label>Min. learning areas</label>
        <input type="number" min="0" data-class-min="${c.id}" title="Minimum learning areas for ${esc(c.name)}" value="${minVal}" placeholder="—">
      </div>
    </div>`;
}

function openExamModal(root, years, terms, classes, existing, currentClassRows) {
  const selectedIds = new Set((currentClassRows || []).map((r) => r.class_id));
  const lockedIds = new Set((currentClassRows || []).filter((r) => r.subjects_with_marks > 0).map((r) => r.class_id));
  const minByClass = {};
  (currentClassRows || []).forEach((r) => { minByClass[r.class_id] = r.min_subjects; });
  const initialType = existing ? existing.exam_type : 'written';
  const groups = groupClassesByLevel(classes);

  modal({
    title: existing ? 'Edit exam' : 'Add exam',
    wide: true,
    body: `
      <div class="field"><label>Exam name</label><input id="ex-name" value="${esc(existing ? existing.name : '')}" placeholder="e.g. End of Term 1 Exam"></div>
      <div class="grid2">
        <div class="field"><label>Academic year</label><select id="ex-year">${options(years, 'id', 'name', existing ? existing.academic_year_id : '', 'Choose a year')}</select></div>
        <div class="field"><label>Term</label><select id="ex-term">${options(terms, 'id', 'name', existing ? existing.term_id : '', 'Choose a term')}</select></div>
      </div>
      <div class="field"><label>Exam type</label><select id="ex-type">${options(EXAM_TYPE_CHOICES, 'id', 'name', initialType)}</select></div>
      <p class="hint" id="ex-consolidated-note" style="display:${initialType === 'consolidated' ? '' : 'none'};color:var(--warn)">
        ⚠️ Combining two or more exams together isn't built yet — this creates a normal single exam for now; the merge behaviour is being scoped separately.
      </p>
      <div class="field">
        <label>Which grades are sitting this exam?</label>
        <p class="hint" style="margin-top:0">Tap a class to include it. Set a minimum number of learning areas per class if you want anyone who sat fewer marked "X" instead of skewing the class mean — leave blank to use the school-wide default. You can add more classes later from the exam card.</p>
        ${classes.length ? `
          <div class="ex-class-toolbar">
            <div class="field" style="flex:1;margin:0"><input type="text" id="ex-class-search" placeholder="Search classes…"></div>
            <button type="button" class="btn secondary sm" id="ex-select-all">Select all</button>
            <button type="button" class="btn secondary sm" id="ex-clear-all">Clear</button>
          </div>
          <div id="ex-class-groups" class="ex-class-scroll">
            ${groups.map((g) => `
              <div class="ex-class-group" data-class-group>
                <div class="ex-class-level-label">${esc(g.level)}</div>
                <div class="ex-class-grid">${g.classes.map((c) => classCardHtml(c, selectedIds, lockedIds, minByClass)).join('')}</div>
              </div>`).join('')}
          </div>
          <p class="hint" id="ex-class-count" style="margin:10px 0 0"></p>
        ` : '<p class="muted" style="margin:0">No classes yet — add a class first.</p>'}
      </div>
    `,
    okLabel: 'Save',
    onOpen: () => {
      document.getElementById('ex-type').onchange = (e) => {
        document.getElementById('ex-consolidated-note').style.display = e.target.value === 'consolidated' ? '' : 'none';
      };
      if (!classes.length) return;

      const countEl = document.getElementById('ex-class-count');
      const updateCount = () => {
        const checked = document.querySelectorAll('[data-class-check]:checked').length;
        countEl.textContent = `${checked} of ${classes.length} class(es) selected`;
      };
      const syncCardState = (card) => {
        const cb = card.querySelector('[data-class-check]');
        card.classList.toggle('on', cb.checked);
      };

      document.querySelectorAll('[data-class-card]').forEach((card) => {
        const cb = card.querySelector('[data-class-check]');
        cb.onchange = () => { syncCardState(card); updateCount(); };
        // Clicking anywhere on the card (except directly inside the min.
        // input, once it's showing) toggles it — locked cards ignore clicks
        // entirely since their checkbox is disabled.
        card.onclick = (e) => {
          if (cb.disabled || e.target.closest('.ex-class-min')) return;
          if (e.target.tagName === 'INPUT') return; // native checkbox click already toggles + fires onchange
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        };
      });

      document.getElementById('ex-select-all').onclick = () => {
        document.querySelectorAll('[data-class-check]:not(:disabled)').forEach((cb) => {
          const card = cb.closest('[data-class-card]');
          if (card.style.display === 'none') return; // respect the active search filter
          cb.checked = true;
          syncCardState(card);
        });
        updateCount();
      };
      document.getElementById('ex-clear-all').onclick = () => {
        document.querySelectorAll('[data-class-check]:not(:disabled)').forEach((cb) => {
          const card = cb.closest('[data-class-card]');
          if (card.style.display === 'none') return;
          cb.checked = false;
          syncCardState(card);
        });
        updateCount();
      };

      document.getElementById('ex-class-search').oninput = (e) => {
        const q = e.target.value.trim().toLowerCase();
        document.querySelectorAll('[data-class-card]').forEach((card) => {
          card.style.display = !q || card.dataset.className.indexOf(q) !== -1 ? '' : 'none';
        });
        document.querySelectorAll('[data-class-group]').forEach((group) => {
          const anyVisible = [...group.querySelectorAll('[data-class-card]')].some((card) => card.style.display !== 'none');
          group.style.display = anyVisible ? '' : 'none';
        });
      };

      updateCount();
    },
    onOk: async () => {
      const lockedButUnchecked = [...lockedIds]; // always resubmitted regardless of checkbox state (disabled inputs don't post)
      const ticked = [...document.querySelectorAll('[data-class-check]')].filter((cb) => cb.checked).map((cb) => cb.value);
      const classIds = [...new Set([...ticked, ...lockedButUnchecked])];
      const minSubjectsByClass = {};
      document.querySelectorAll('[data-class-min]').forEach((inp) => {
        if (classIds.indexOf(inp.dataset.classMin) === -1) return;
        minSubjectsByClass[inp.dataset.classMin] = inp.value === '' ? null : inp.value;
      });
      const res = await Db.results.saveExam({
        id: existing ? existing.id : undefined,
        name: document.getElementById('ex-name').value,
        academic_year_id: document.getElementById('ex-year').value,
        term_id: document.getElementById('ex-term').value,
        exam_type: document.getElementById('ex-type').value,
        class_ids: classIds,
        min_subjects_by_class: minSubjectsByClass
      });
      if (!res.ok) { toast(res.message, 'err'); return; }
      closeModal();
      toast(existing ? 'Exam saved.' : 'Exam created.', 'ok');
      renderBoardScreen(root, years, terms);
    }
  });
}

/** "+ Add classes" on an existing exam's card — the late-enrolling-class
 *  case, using listExamClassChoices so the picker only ever shows classes
 *  not already on this exam. */
function openClassPickerModal(root, exam, currentClassRows, onDone) {
  Db.results.listExamClassChoices(exam.id).then((res) => {
    const choices = res.ok ? res.data : [];
    if (!choices.length) { toast('Every class has already been added to this exam.', 'ok'); return; }
    modal({
      title: `Add classes to "${exam.name}"`,
      body: `
        <p class="hint" style="margin-top:0">Choose which additional classes are sitting this exam.</p>
        <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px">
          ${choices.map((c) => `<label style="display:flex;align-items:center;gap:8px;padding:4px 0">
            <input type="checkbox" data-add-class-check value="${c.id}"><span>${esc(c.name)}</span></label>`).join('')}
        </div>
      `,
      okLabel: 'Add selected',
      onOk: async () => {
        const toAdd = [...document.querySelectorAll('[data-add-class-check]')].filter((cb) => cb.checked).map((cb) => cb.value);
        if (!toAdd.length) { toast('Choose at least one class.', 'err'); return; }
        const existingIds = (currentClassRows || []).map((r) => r.class_id);
        const res2 = await Db.results.saveExam({
          id: exam.id, name: exam.name, academic_year_id: exam.academic_year_id, term_id: exam.term_id,
          exam_type: exam.exam_type, class_ids: [...existingIds, ...toAdd]
        });
        if (!res2.ok) { toast(res2.message, 'err'); return; }
        closeModal();
        toast('Classes added.', 'ok');
        onDone();
      }
    });
  });
}
