/**
 * timetableSetup.mjs — Round 4 §7: the Timetable module's "Setup" tab (see
 * timetableHub.mjs). Four short, independent sub-sections — a school
 * usually visits each once and rarely comes back:
 *   1. Teaching Days + Period Grid — the daily template every generated
 *      timetable is built from (see 0018_timetable.sql's design note on why
 *      this is ONE template repeated across the week, not a grid per day).
 *   2. Rooms — entirely optional; skip it and the generator just never
 *      checks for room clashes.
 *   3. Subject Periods & Double Lessons — how many periods/week each
 *      subject needs per class/arm, reusing the exact same effective-
 *      subjects precedence Classes > Arm > Subjects already resolves
 *      (assignments.mjs's getStreamSubjects).
 *   4. Teacher Availability — click to block a teacher out of specific
 *      slots (part-time hours, other commitments); empty by default.
 */
import { esc, options, toast, loader, withBusy, confirmAction } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { DAY_LABELS, DEFAULT_PERIODS_PER_WEEK } from '../lib/timetable/generate.mjs';
import { generatePeriods, cascadeTimes } from '../lib/timetable/scheduleGrid.mjs';
import { renderTimetableConstraints } from './timetableConstraints.mjs';

const SUB_TABS = [
  { key: 'grid', label: 'Teaching Days & Periods' },
  { key: 'rooms', label: 'Rooms (optional)' },
  { key: 'requirements', label: 'Subject Periods & Double Lessons' },
  { key: 'availability', label: 'Teacher Availability' },
  // Round 2 §7: the new Constraints module — a school's own scheduling
  // preferences, fed into the generator as soft constraints. Lives here
  // rather than as its own top-level Timetable tab since, like every other
  // sub-tab in Setup, it's one-time configuration a school works through
  // before generating rather than something visited every time.
  { key: 'constraints', label: 'Constraints' }
];

export async function viewTimetableSetup(root) {
  render(root, 'grid');
}

function render(root, activeSub) {
  root.innerHTML = `
    <div class="fin-tabs">
      ${SUB_TABS.map((t) => `<button data-sub="${t.key}" class="${t.key === activeSub ? 'active' : ''}">${t.label}</button>`).join('')}
    </div>
    <div id="tt-setup-body"></div>
  `;
  root.querySelectorAll('[data-sub]').forEach((b) => b.onclick = () => render(root, b.dataset.sub));
  const body = root.querySelector('#tt-setup-body');
  if (activeSub === 'grid') renderGrid(body);
  else if (activeSub === 'rooms') renderRooms(body);
  else if (activeSub === 'requirements') renderRequirements(body);
  else if (activeSub === 'availability') renderAvailability(body);
  else renderTimetableConstraints(body);
}

/* ---------------------------------------------------------------- grid --- */
async function renderGrid(root) {
  root.innerHTML = loader();
  const [daysRes, periodsRes] = await Promise.all([Db.timetable.days.get(), Db.timetable.periods.list()]);
  const activeDays = new Set(daysRes.ok ? daysRes.data : [1, 2, 3, 4, 5]);
  let rows = (periodsRes.ok ? periodsRes.data : []).map((p) => ({ start_time: p.start_time, end_time: p.end_time, is_break: p.is_break, label: p.label || '' }));
  if (!rows.length) rows = [{ start_time: '08:00', end_time: '08:40', is_break: false, label: '' }];

  function rowHtml(r, i) {
    return `<tr data-row="${i}">
      <td>${i + 1}</td>
      <td><input type="time" class="p-start" value="${esc(r.start_time || '')}"></td>
      <td><input type="time" class="p-end" value="${esc(r.end_time || '')}"></td>
      <td style="text-align:center"><input type="checkbox" class="p-break" ${r.is_break ? 'checked' : ''}></td>
      <td><input type="text" class="p-label" placeholder="e.g. Period ${i + 1} / Break / Lunch" value="${esc(r.label || '')}"></td>
      <td><button class="btn ghost sm p-remove" type="button">✕</button></td>
    </tr>`;
  }

  function draw() {
    root.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-h"><h3>Teaching Days</h3></div>
        <div class="card-b" style="display:flex;gap:18px;flex-wrap:wrap">
          ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<label class="chk"><input type="checkbox" class="tt-day" value="${d}" ${activeDays.has(d) ? 'checked' : ''}> ${DAY_LABELS[d]}</label>`).join('')}
        </div>
        <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn secondary sm" id="tt-days-save">Save teaching days</button></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-h"><h3>Quick Generate</h3></div>
        <div class="card-b">
          <p class="hint" style="margin:0 0 10px">The fast way to start a period grid: say how many lessons your day has and how long each one is, and every row below gets filled in for you — still fully editable afterward (add breaks, rename periods, adjust times) rather than locking anything in.</p>
          <div class="grid3">
            <div class="field"><label>Start time</label><input type="time" id="qg-start" value="08:00"></div>
            <div class="field"><label>Number of lessons</label><input type="number" id="qg-count" min="1" max="20" placeholder="e.g. 8"></div>
            <div class="field"><label>Lesson duration (minutes)</label><input type="number" id="qg-duration" min="1" max="240" placeholder="e.g. 40"></div>
          </div>
        </div>
        <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn secondary sm" id="qg-generate" type="button">⚡ Generate Timeslots</button></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Daily Period Grid</h3></div>
        <div class="card-b"><p class="hint" style="margin:0 0 10px">This same set of periods repeats on every teaching day above — most schools run the same times every day. Add a "Break"/"Lunch" row wherever your school actually has one; the generator never schedules a lesson into a row ticked "Break". Editing a start or end time shifts every row after it to keep following on, each keeping its own length — you only ever have to retype one time, not the whole rest of the day.</p></div>
        <div class="card-b table-wrap"><table class="data" id="tt-period-table">
          <thead><tr><th>#</th><th>Start</th><th>End</th><th>Break?</th><th>Label (optional)</th><th></th></tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table></div>
        <div class="card-b" style="display:flex;gap:10px;padding-top:0">
          <button class="btn ghost sm" id="tt-period-add" type="button">+ Add period</button>
        </div>
        <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn" id="tt-period-save">Save period grid</button></div>
      </div>
    `;

    root.querySelector('#qg-generate').onclick = () => {
      const startTime = root.querySelector('#qg-start').value;
      const lessonsPerDay = root.querySelector('#qg-count').value;
      const lessonDuration = root.querySelector('#qg-duration').value;
      if (!lessonsPerDay || !lessonDuration) { toast('Enter both the number of lessons and the lesson duration.', 'err'); return; }
      const doGenerate = () => {
        rows = generatePeriods({ startTime, lessonsPerDay, lessonDuration });
        draw();
        toast(`Generated ${rows.length} periods — add any breaks and adjust times below, then save.`, 'ok');
      };
      // Only ask for confirmation when there's real existing work to lose —
      // the single default blank row a fresh setup starts with isn't worth
      // an extra click to confirm away.
      const hasRealRows = rows.some((r) => r.start_time || r.end_time || r.label);
      if (hasRealRows) {
        confirmAction('Replace the current period grid with freshly generated timeslots? Any breaks or custom labels you already added here will be lost — you can still add them back afterward.', doGenerate);
      } else {
        doGenerate();
      }
    };

    root.querySelectorAll('.p-start, .p-end').forEach((inp) => {
      inp.onchange = () => {
        const i = Number(inp.closest('tr').dataset.row);
        // Round 5 §7: cascade — capture whatever's in the table right now
        // (including the edit that just fired this event) before
        // recomputing every later row from it, same "sync before mutating"
        // reasoning the existing add/remove handlers already use above.
        syncRowsFromDom();
        rows = cascadeTimes(rows, i);
        draw();
      };
    });

    root.querySelector('#tt-days-save').onclick = (e) => withBusy(e.currentTarget, async () => {
      const days = [...root.querySelectorAll('.tt-day:checked')].map((el) => Number(el.value));
      const res = await Db.timetable.days.save(days);
      if (!res.ok) { toast(res.message, 'err'); return; }
      activeDays.clear(); days.forEach((d) => activeDays.add(d));
      toast('Teaching days saved.', 'ok');
    }, 'Saving…');

    root.querySelector('#tt-period-add').onclick = () => {
      // Capture whatever's currently in the on-screen rows FIRST — the new
      // blank row isn't in the DOM yet, so syncing after the push would
      // read a table that doesn't have it and silently drop it again (the
      // reported "Add period doesn't work" bug: push, then sync, then
      // draw — sync overwrote the array with the still-old DOM before the
      // new row ever got rendered).
      syncRowsFromDom();
      rows.push({ start_time: '', end_time: '', is_break: false, label: '' });
      draw();
    };
    root.querySelectorAll('.p-remove').forEach((b) => b.onclick = () => {
      syncRowsFromDom();
      rows.splice(Number(b.closest('tr').dataset.row), 1);
      if (!rows.length) rows.push({ start_time: '08:00', end_time: '08:40', is_break: false, label: '' });
      draw();
    });

    root.querySelector('#tt-period-save').onclick = (e) => withBusy(e.currentTarget, async () => {
      syncRowsFromDom();
      const res = await Db.timetable.periods.saveGrid(rows);
      if (!res.ok) { toast(res.message, 'err'); return; }
      toast('Period grid saved.', 'ok');
    }, 'Saving…');
  }

  function syncRowsFromDom() {
    rows = [...root.querySelectorAll('#tt-period-table tbody tr')].map((tr) => ({
      start_time: tr.querySelector('.p-start').value,
      end_time: tr.querySelector('.p-end').value,
      is_break: tr.querySelector('.p-break').checked,
      label: tr.querySelector('.p-label').value.trim()
    }));
  }

  draw();
}

/* --------------------------------------------------------------- rooms --- */
async function renderRooms(root) {
  root.innerHTML = loader();
  const res = await Db.timetable.rooms.list();
  const rooms = res.ok ? res.data : [];
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Rooms</h3></div>
      <div class="card-b"><p class="hint" style="margin:0 0 10px">Optional — only add rooms if you want the generator/manual editor to warn about a room being double-booked. Skip this entirely and everything else still works.</p>
        <div class="grid3">
          <div class="field"><label>Room name</label><input id="room-name" placeholder="e.g. Lab 1"></div>
          <div class="field"><label>Capacity (optional)</label><input id="room-capacity" type="number" min="0"></div>
          <div class="field"><label>&nbsp;</label><button class="btn" id="room-add">+ Add room</button></div>
        </div>
      </div>
      <div class="card-b table-wrap">
        ${rooms.length ? `<table class="data"><thead><tr><th>Name</th><th>Capacity</th><th></th></tr></thead><tbody>
          ${rooms.map((r) => `<tr data-id="${r.id}"><td>${esc(r.name)}</td><td>${r.capacity === null ? '—' : r.capacity}</td><td><button class="btn ghost sm room-remove">Remove</button></td></tr>`).join('')}
        </tbody></table>` : '<p class="hint" style="margin:0">No rooms added yet.</p>'}
      </div>
    </div>
  `;

  root.querySelector('#room-add').onclick = (e) => withBusy(e.currentTarget, async () => {
    const name = root.querySelector('#room-name').value;
    const capacity = root.querySelector('#room-capacity').value;
    const res2 = await Db.timetable.rooms.save({ name, capacity });
    if (!res2.ok) { toast(res2.message, 'err'); return; }
    toast('Room added.', 'ok');
    renderRooms(root);
  }, 'Adding…');

  root.querySelectorAll('.room-remove').forEach((b) => b.onclick = () => withBusy(b, async () => {
    const id = b.closest('tr').dataset.id;
    const res2 = await Db.timetable.rooms.remove(id);
    if (!res2.ok) { toast(res2.message, 'err'); return; }
    toast('Room removed.', 'ok');
    renderRooms(root);
  }, 'Removing…'));
}

/* --------------------------------------------------------- requirements --- */
async function renderRequirements(root) {
  // Sprint Review §3: same fix as timetableHub.mjs's showTab() — show
  // "please wait" the instant this sub-tab is opened, before the awaited
  // fetches below, instead of leaving the PREVIOUS sub-tab's content on
  // screen with no visible change while this one loads.
  root.innerHTML = loader();
  const [classesRes, daysRes, periodsRes] = await Promise.all([Db.classes.list(), Db.timetable.days.get(), Db.timetable.periods.list()]);
  const classes = classesRes.ok ? classesRes.data : [];
  // Round 6 §6: how many teaching slots a class/arm's week actually holds —
  // teaching days × non-break periods per day — so the running total below
  // has something real to compare against. Falls back to the same 5-day
  // default renderGrid/renderAvailability already assume when nothing's
  // been saved yet.
  const days = daysRes.ok ? daysRes.data : [1, 2, 3, 4, 5];
  const teachablePeriods = (periodsRes.ok ? periodsRes.data : []).filter((p) => !p.is_break);
  const weeklyCapacity = days.length * teachablePeriods.length;
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Subject Periods & Double Lessons</h3></div>
      <div class="card-b"><p class="hint" style="margin:0 0 10px">How many periods a week each subject needs, and how many of those should be scheduled as double lessons (e.g. Math might get 3 doubles a week and the rest as singles). Leave "Periods/week" blank to use the default (5), and "Doubles/week" blank or 0 for no doubles — you don't have to configure every subject before generating a timetable.</p>
        <div class="grid2">
          <div class="field"><label>Class</label><select id="req-class">${options(classes, 'id', 'name', '', 'Choose a class')}</select></div>
          <div class="field"><label>Stream</label><select id="req-stream" disabled><option value="">Choose a class first</option></select></div>
        </div>
      </div>
      <div class="card-b table-wrap" id="req-table"></div>
    </div>
  `;
  const classSel = root.querySelector('#req-class'), streamSel = root.querySelector('#req-stream');
  classSel.onchange = async () => {
    const cid = classSel.value;
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Choose a class first</option>'; root.querySelector('#req-table').innerHTML = ''; return; }
    const r = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = options(r.ok ? r.data : [], 'id', 'name', '', 'Choose a stream');
    root.querySelector('#req-table').innerHTML = '';
  };
  streamSel.onchange = () => loadStreamSubjects(streamSel.value);

  async function loadStreamSubjects(streamId) {
    const table = root.querySelector('#req-table');
    if (!streamId) { table.innerHTML = ''; return; }
    table.innerHTML = loader();
    const res = await Db.assignments.getStreamSubjects(streamId);
    if (!res.ok) { table.innerHTML = `<p class="hint">${esc(res.message)}</p>`; return; }
    const rows = res.data;
    if (!rows.length) { table.innerHTML = '<p class="hint" style="margin:0">This stream has no subjects assigned yet — add subjects under Classes &amp; Streams first.</p>'; return; }
    table.innerHTML = `
      ${res.inherited ? '<p class="hint" style="margin:0 0 10px">Showing this class\'s default subjects (not yet customized for this stream specifically) — editing here changes the class-wide default.</p>' : ''}
      <table class="data"><thead><tr><th>Subject</th><th>Teacher</th><th>Periods/week</th><th>Doubles/week</th></tr></thead><tbody>
        ${rows.map((r) => `<tr data-assignment="${r.assignment_id || ''}">
          <td>${esc(r.name)}</td>
          <td>${esc(r.teacher_name || '—')}</td>
          <td><input type="number" min="0" max="20" class="req-periods" style="width:80px" placeholder="5" value="${r.periods_per_week === null ? '' : r.periods_per_week}" data-saved="${r.periods_per_week === null ? '' : r.periods_per_week}" ${r.assignment_id ? '' : 'disabled'}></td>
          <td><input type="number" min="0" max="10" class="req-double" style="width:80px" placeholder="0" value="${r.double_periods_per_week ? r.double_periods_per_week : ''}" ${r.assignment_id ? '' : 'disabled'}></td>
        </tr>`).join('')}
      </tbody></table>
      <!-- Sprint Review §2: "the running total was implemented, but too
           subtly — easy to miss entirely." Redesigned from a single hint
           line into two always-visible, large live tiles (Expected /
           Scheduled) plus a separate status banner that turns red and
           states outright once the week is full or over, instead of a
           small paragraph a school could easily scroll past. -->
      <div id="req-cap-tiles" class="tt-cap-tiles">
        <div class="tt-cap-tile">
          <div class="tt-cap-label">EXPECTED</div>
          <div class="tt-cap-value" id="req-expected-val">${weeklyCapacity || '—'}</div>
          <div class="tt-cap-sub">timeslots this class/stream's week has</div>
        </div>
        <div class="tt-cap-tile" id="req-scheduled-tile">
          <div class="tt-cap-label">SCHEDULED</div>
          <div class="tt-cap-value" id="req-scheduled-val">0</div>
          <div class="tt-cap-sub">periods/week configured so far</div>
        </div>
      </div>
      <p id="req-total-msg" class="hint" style="margin:10px 0 0;font-weight:700"></p>
    `;

    // Round 6 §6 / Sprint Review §2: a live running total of periods/week
    // configured so far against how many teaching slots the week's grid
    // actually holds (weeklyCapacity, computed once above from Teaching
    // Days & Periods) — recomputed on every keystroke, not just on
    // blur/change, so the tiles/message update as the school types rather
    // than only after they tab away. Doubles/week isn't added separately:
    // buildUnits() in generate.mjs carves doubles OUT of periods_per_week
    // (a "3 doubles" subject with periods_per_week=6 uses exactly 6 slots,
    // not 6+3), so only the Periods/week column counts toward the total.
    function recomputeTotal() {
      let total = 0;
      table.querySelectorAll('tr[data-assignment] .req-periods').forEach((inp) => {
        const raw = inp.value.trim();
        const n = raw === '' ? DEFAULT_PERIODS_PER_WEEK : Number(raw);
        if (Number.isFinite(n) && n > 0) total += n;
      });
      const atOrOverMax = weeklyCapacity > 0 && total >= weeklyCapacity;
      const over = weeklyCapacity > 0 && total > weeklyCapacity;

      const scheduledVal = table.querySelector('#req-scheduled-val');
      const scheduledTile = table.querySelector('#req-scheduled-tile');
      const msgEl = table.querySelector('#req-total-msg');
      if (scheduledVal) scheduledVal.textContent = String(total);
      // Bullet 1: "a permanent red message/tile once the maximum is
      // reached" — this fires at exactly-full too, not just over-budget.
      if (scheduledTile) scheduledTile.classList.toggle('over', atOrOverMax);
      if (msgEl) {
        if (!weeklyCapacity) {
          msgEl.innerHTML = `Scheduled so far: <b>${total}</b> — set up the period grid under Teaching Days &amp; Periods to see how much room this class/stream's week has.`;
          msgEl.classList.remove('danger');
        } else if (over) {
          msgEl.innerHTML = `⛔ <b>Maximum timeslots reached</b> — ${total}/${weeklyCapacity}, ${total - weeklyCapacity} too many. Reduce a subject's periods/week, or add more periods under Teaching Days &amp; Periods.`;
          msgEl.classList.add('danger');
        } else if (atOrOverMax) {
          msgEl.innerHTML = `⛔ <b>Maximum timeslots reached</b> — ${total}/${weeklyCapacity}, this class/stream's week is completely full. Add more periods under Teaching Days &amp; Periods for any more.`;
          msgEl.classList.add('danger');
        } else {
          msgEl.innerHTML = `✓ ${total}/${weeklyCapacity} used — ${weeklyCapacity - total} free.`;
          msgEl.classList.remove('danger');
        }
      }
      return { total, over, atOrOverMax };
    }
    recomputeTotal();
    table.querySelectorAll('.req-periods').forEach((inp) => inp.oninput = recomputeTotal);

    table.querySelectorAll('tr[data-assignment]').forEach((tr) => {
      const assignmentId = tr.dataset.assignment;
      if (!assignmentId) return;
      const periodsInp = tr.querySelector('.req-periods');
      const doublesInp = tr.querySelector('.req-double');
      const save = async () => {
        const { over } = recomputeTotal();
        if (over && weeklyCapacity > 0) {
          // Round 6 §6: refuse to save a configuration that would ask the
          // generator for more periods than the week's grid can physically
          // hold — revert this field to its last-saved value rather than
          // leaving an unsaved, over-budget number sitting on screen.
          toast(`Lessons exceed the number of periods set for this class/stream's week. Reduce this subject's periods/week, or add more periods to the grid under Teaching Days & Periods.`, 'err');
          periodsInp.value = periodsInp.dataset.saved;
          recomputeTotal();
          return;
        }
        const periods = periodsInp.value;
        const doubles = doublesInp.value;
        // Round 6 §8: these two fields auto-save on blur with no separate
        // "Save" button to show a busy state on — disabling them for the
        // brief moment the request is in flight is this row's equivalent
        // "please wait" feedback.
        periodsInp.disabled = true; doublesInp.disabled = true;
        try {
          const r = await Db.timetable.requirements.save(assignmentId, periods, doubles);
          if (!r.ok) { toast(r.message, 'err'); return; }
          periodsInp.dataset.saved = periodsInp.value;
        } finally {
          periodsInp.disabled = false; doublesInp.disabled = false;
        }
      };
      periodsInp.onchange = save;
      doublesInp.onchange = save;
    });
  }
}

/* --------------------------------------------------------- availability --- */
async function renderAvailability(root) {
  // Sprint Review §3: same fix as renderRequirements() above and
  // timetableHub.mjs's showTab() — show "please wait" before the awaited
  // fetch, not after.
  root.innerHTML = loader();
  const staffRes = await Db.staff.list();
  const staff = (staffRes.ok ? staffRes.data : []).filter((s) => s.status === 'active');
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>Teacher Availability</h3></div>
      <div class="card-b"><p class="hint" style="margin:0 0 10px">Everyone is fully available by default. Pick a teacher and click a slot to block it out (e.g. part-time hours, another commitment) — the generator will never place a lesson there.</p>
        <div class="field" style="max-width:360px"><label>Teacher</label><select id="avail-staff">${options(staff, 'id', 'full_name', '', 'Choose a teacher')}</select></div>
      </div>
      <div class="card-b table-wrap" id="avail-grid"></div>
    </div>
  `;
  root.querySelector('#avail-staff').onchange = (e) => loadAvailability(e.target.value);

  async function loadAvailability(staffId) {
    const gridEl = root.querySelector('#avail-grid');
    if (!staffId) { gridEl.innerHTML = ''; return; }
    gridEl.innerHTML = loader();
    const [periodsRes, daysRes, availRes] = await Promise.all([Db.timetable.periods.list(), Db.timetable.days.get(), Db.timetable.availability.listForStaff(staffId)]);
    const periods = (periodsRes.ok ? periodsRes.data : []).filter((p) => !p.is_break);
    const days = daysRes.ok ? daysRes.data : [1, 2, 3, 4, 5];
    if (!periods.length) { gridEl.innerHTML = '<p class="hint" style="margin:0">Set up the period grid first (Teaching Days &amp; Periods tab).</p>'; return; }
    const blocked = new Set((availRes.ok ? availRes.data : []).map((b) => `${b.day_of_week}|${b.period_index}`));

    function draw() {
      gridEl.innerHTML = `<table class="data tt-avail-grid"><thead><tr><th>Period</th>${days.map((d) => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr></thead><tbody>
        ${periods.map((p) => `<tr><td><b>${esc(p.label || 'Period ' + p.period_index)}</b></td>${days.map((d) => {
          const key = `${d}|${p.period_index}`;
          const isBlocked = blocked.has(key);
          return `<td class="tt-avail-cell ${isBlocked ? 'blocked' : ''}" data-day="${d}" data-period="${p.period_index}">${isBlocked ? '✕ Blocked' : '✓ Free'}</td>`;
        }).join('')}</tr>`).join('')}
      </tbody></table>`;
      gridEl.querySelectorAll('.tt-avail-cell').forEach((td) => td.onclick = async () => {
        const key = `${td.dataset.day}|${td.dataset.period}`;
        if (blocked.has(key)) blocked.delete(key); else blocked.add(key);
        draw();
        const blocks = [...blocked].map((k) => { const [d, p] = k.split('|'); return { day_of_week: Number(d), period_index: Number(p) }; });
        const res = await Db.timetable.availability.saveForStaff(staffId, blocks);
        if (!res.ok) toast(res.message, 'err');
      });
    }
    draw();
  }
}
