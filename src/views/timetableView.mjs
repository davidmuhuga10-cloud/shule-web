/**
 * timetableView.mjs — Round 2 §7: the Timetable module's "View" tab, split
 * out of what used to be one combined "Generate & View" tab (timetable.mjs,
 * now retired — see timetableGenerate.mjs for the other half). Shows the
 * saved timetable either by Class/Arm or by Teacher — printable in
 * portrait or landscape via the same shared print controls every other
 * report already uses — and is where manual per-cell editing lives.
 *
 * Manual editing (click a cell) is only offered in the By Class/Arm view —
 * an entry fundamentally belongs to one stream+slot, so that's where
 * editing it belongs; By Teacher is a read-only lens over the same
 * underlying entries, useful for seeing a teacher's own week at a glance.
 *
 * `preselect` (optional {year_id, term_id}) is how timetableGenerate.mjs's
 * auto-redirect hands off which term to land on — falls back to picking
 * the active year/term itself when not given (e.g. navigating to View
 * directly rather than via a redirect).
 */
import { esc, options, toast, loader, modal, closeModal, confirmAction, printOptionsHtml, wirePrintOptions, withBusy, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';
import { timetableGridPageHtml } from './_timetableGrid.mjs';

function pickDefaultYearTerm(years, termsByYear) {
  const activeYear = years.find((y) => y.status === 'active') || years[0];
  if (!activeYear) return { year_id: '', term_id: '' };
  const terms = termsByYear[activeYear.id] || [];
  const activeTerm = terms.find((t) => t.status === 'active') || terms[0];
  return { year_id: activeYear.id, term_id: activeTerm ? activeTerm.id : '' };
}

export async function viewTimetableView(root, preselect) {
  const [yearsRes, classesRes, staffRes, roomsRes, periodsRes, daysRes, settingsRes] = await Promise.all([
    Db.academicYears.list(), Db.classes.list(), Db.staff.list(), Db.timetable.rooms.list(), Db.timetable.periods.list(), Db.timetable.days.get(), Db.settings.get()
  ]);
  const years = yearsRes.ok ? yearsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  const staff = (staffRes.ok ? staffRes.data : []).filter((s) => s.status === 'active');
  const rooms = roomsRes.ok ? roomsRes.data : [];
  const periods = periodsRes.ok ? periodsRes.data : [];
  const days = daysRes.ok ? daysRes.data : [1, 2, 3, 4, 5];
  const settings = settingsRes.ok ? settingsRes.data : {};

  if (!years.length) { root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No academic years found</h3><p>Set up an academic year and term first (Settings → Academic Years &amp; Terms).</p></div></div></div>`; return; }
  if (!periods.length) { root.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>Set up your period grid first</h3><p>Go to the Setup tab and define your school's daily periods, then generate a timetable.</p></div></div></div>`; return; }

  const termsByYear = {};
  await Promise.all(years.map(async (y) => { const r = await Db.terms.list(y.id); termsByYear[y.id] = r.ok ? r.data : []; }));

  let def = pickDefaultYearTerm(years, termsByYear);
  if (preselect && preselect.year_id && (termsByYear[preselect.year_id] || []).length) {
    def = { year_id: preselect.year_id, term_id: preselect.term_id || (termsByYear[preselect.year_id] || [])[0]?.id || '' };
  }
  render(root, { years, termsByYear, classes, staff, rooms, periods, days, settings, sel: { year_id: def.year_id, term_id: def.term_id, mode: 'stream', class_id: '', stream_id: '', staff_id: '' } });
}

function render(root, state) {
  const { years, termsByYear, classes, staff, rooms, periods, days } = state;
  const sel = state.sel;
  const terms = termsByYear[sel.year_id] || [];

  root.innerHTML = `
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Academic Year</label><select id="tt-year">${options(years, 'id', 'name', sel.year_id, 'Choose a year')}</select></div>
        <div class="field"><label>Term</label><select id="tt-term">${options(terms, 'id', 'name', sel.term_id, 'Choose a term')}</select></div>
        <div class="field"></div>
      </div>
    </div>
    <div class="tabs" style="margin-bottom:16px">
      <button data-mode="stream" class="${sel.mode === 'stream' ? 'active' : ''}">By Class / Arm</button>
      <button data-mode="teacher" class="${sel.mode === 'teacher' ? 'active' : ''}">By Teacher</button>
    </div>
    <div class="card no-print" style="margin-bottom:16px" id="tt-picker"></div>
    <div id="tt-view"></div>
  `;

  const yearSel = root.querySelector('#tt-year'), termSel = root.querySelector('#tt-term');
  yearSel.onchange = () => { sel.year_id = yearSel.value; sel.term_id = (state.termsByYear[sel.year_id] || [])[0]?.id || ''; render(root, state); };
  termSel.onchange = () => { sel.term_id = termSel.value; loadView(); };

  root.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { sel.mode = b.dataset.mode; render(root, state); });

  renderPicker();
  loadView();

  function renderPicker() {
    const picker = root.querySelector('#tt-picker');
    if (sel.mode === 'stream') {
      picker.innerHTML = `<div class="card-b grid3">
        <div class="field"><label>Class</label><select id="tt-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Arm</label><select id="tt-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Choose an arm</option></select></div>
        <div class="field"><label>&nbsp;</label>${printOptionsHtml('tt', 'landscape')}</div>
      </div>`;
      const classSel = picker.querySelector('#tt-class'), streamSel = picker.querySelector('#tt-stream');
      const refreshStreams = async (cid, preselectStream) => {
        if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Choose a class first</option>'; return; }
        const r = await Db.streams.list(cid);
        streamSel.disabled = false;
        streamSel.innerHTML = options(r.ok ? r.data : [], 'id', 'name', preselectStream || '', 'Choose an arm');
      };
      classSel.onchange = async () => { sel.class_id = classSel.value; sel.stream_id = ''; await refreshStreams(sel.class_id); loadView(); };
      streamSel.onchange = () => { sel.stream_id = streamSel.value; loadView(); };
      if (sel.class_id) refreshStreams(sel.class_id, sel.stream_id);
      wirePrintOptions(picker, 'tt', 'Timetable');
    } else {
      picker.innerHTML = `<div class="card-b grid3">
        <div class="field"><label>Teacher</label><select id="tt-staff">${options(staff, 'id', 'full_name', sel.staff_id, 'Choose a teacher')}</select></div>
        <div class="field"></div>
        <div class="field"><label>&nbsp;</label>${printOptionsHtml('tt', 'landscape')}</div>
      </div>`;
      picker.querySelector('#tt-staff').onchange = (e) => { sel.staff_id = e.target.value; loadView(); };
      wirePrintOptions(picker, 'tt', 'Timetable');
    }
  }

  async function loadView() {
    const viewEl = root.querySelector('#tt-view');
    if (!sel.year_id || !sel.term_id) { viewEl.innerHTML = '<div class="card pad">Choose an academic year and term.</div>'; return; }
    if (sel.mode === 'stream' && !sel.stream_id) { viewEl.innerHTML = '<div class="card pad">Choose a class and arm to view its timetable.</div>'; return; }
    if (sel.mode === 'teacher' && !sel.staff_id) { viewEl.innerHTML = '<div class="card pad">Choose a teacher to view their timetable.</div>'; return; }

    viewEl.innerHTML = loader();
    if (!isContactInfoComplete(state.settings)) { renderMissingContactInfo(viewEl, () => go('settings')); return; }

    const filters = { academic_year_id: sel.year_id, term_id: sel.term_id };
    if (sel.mode === 'stream') filters.stream_id = sel.stream_id; else filters.staff_id = sel.staff_id;
    const res = await Db.timetable.entries.list(filters);
    if (!res.ok) { viewEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }

    if (!res.data.length) {
      viewEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">📅</div><h3>No timetable yet</h3><p>Generate one from the Generate tab, or add lessons manually once a timetable exists for this term.</p></div></div></div>`;
      return;
    }

    const cls = sel.mode === 'stream' ? classes.find((c) => c.id === sel.class_id) : null;
    const streamName = sel.mode === 'stream' ? (res.data[0] ? res.data[0].stream_name : '') : '';
    const teacherName = sel.mode === 'teacher' ? (staff.find((s) => s.id === sel.staff_id) || {}).full_name : '';
    const title = sel.mode === 'stream' ? `Timetable — ${cls ? cls.name : ''} ${streamName}` : `Timetable — ${teacherName}`;
    const editable = sel.mode === 'stream';

    viewEl.innerHTML = timetableGridPageHtml(state.settings, title, periods, days, res.data, sel.mode, editable);
    wirePrintOptions(root.querySelector('#tt-picker'), 'tt', title);

    if (editable) {
      const entryById = {}; res.data.forEach((e) => { entryById[e.id] = e; });
      viewEl.querySelectorAll('.tt-editable').forEach((td) => {
        td.onclick = () => openCellModal({
          day: Number(td.dataset.day), period: Number(td.dataset.period),
          entry: td.dataset.entryId ? entryById[td.dataset.entryId] : null
        });
      });
    }
  }

  function openCellModal({ day, period, entry }) {
    modal({
      title: entry ? 'Edit lesson' : 'Add lesson',
      body: `<div id="tt-modal-body">${loader()}</div>`,
      okLabel: 'Save',
      busyLabel: 'Saving…',
      onOk: async () => {
        const subjectId = document.getElementById('tt-cell-subject').value;
        if (!subjectId) { toast('Choose a subject.', 'err'); return; }
        const staffId = document.getElementById('tt-cell-staff').value;
        const roomId = document.getElementById('tt-cell-room').value;
        const res = await Db.timetable.entries.saveEntry({
          id: entry ? entry.id : undefined,
          academic_year_id: sel.year_id, term_id: sel.term_id, day_of_week: day, period_index: period,
          subject_id: subjectId, class_id: sel.class_id, stream_id: sel.stream_id,
          staff_id: staffId || null, room_id: roomId || null
        });
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast('Saved.', 'ok');
        closeModal();
        loadView();
      }
    });
    if (entry) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'btn danger';
      clearBtn.textContent = 'Clear this lesson';
      clearBtn.style.marginRight = 'auto';
      const footer = document.querySelector('.modal-f');
      if (footer) footer.prepend(clearBtn);
      clearBtn.onclick = () => withBusy(clearBtn, async () => {
        const res = await Db.timetable.entries.deleteEntry(entry.id);
        if (!res.ok) { toast(res.message, 'err'); return; }
        toast('Lesson cleared.', 'ok');
        closeModal();
        loadView();
      }, 'Clearing…');
    }
    Db.assignments.getStreamSubjects(sel.stream_id).then((subRes) => {
      const subjects = subRes.ok ? subRes.data : [];
      const body = document.getElementById('tt-modal-body');
      if (!body) return; // modal already closed
      body.innerHTML = `
        <div class="field"><label>Subject</label><select id="tt-cell-subject">${options(subjects, 'subject_id', 'name', entry ? entry.subject_id : '', 'Choose a subject')}</select></div>
        <div class="field"><label>Teacher (optional)</label><select id="tt-cell-staff">${options(staff, 'id', 'full_name', entry ? entry.staff_id || '' : '', 'No teacher yet')}</select></div>
        <div class="field"><label>Room (optional)</label><select id="tt-cell-room">${options(rooms, 'id', 'name', entry ? entry.room_id || '' : '', 'No room set')}</select></div>
        <p class="hint" style="margin:8px 0 0">Picking a subject with an assigned teacher fills the teacher in automatically — change it if this slot needs someone else.</p>
      `;
      const subjectSel = document.getElementById('tt-cell-subject');
      subjectSel.onchange = () => {
        const s = subjects.find((x) => x.subject_id === subjectSel.value);
        if (s && s.teacher_staff_id && !entry) document.getElementById('tt-cell-staff').value = s.teacher_staff_id;
      };
    });
  }
}
