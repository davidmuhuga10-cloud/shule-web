import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createSettingsApi } from '../src/lib/api/settings.mjs';
import { createTimetableApi } from '../src/lib/api/timetable.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

const BASE_TABLES = {
  schools: [{ id: 'sch1', name: 'Test School' }],
  academic_years: [{ id: 'y1', name: '2026' }],
  terms: [{ id: 't1', academic_year_id: 'y1', name: 'Term 1' }],
  classes: [{ id: 'c1', name: 'Grade 7' }],
  streams: [{ id: 'str1', class_id: 'c1', name: 'Blue' }, { id: 'str2', class_id: 'c1', name: 'Red' }],
  staff: [{ id: 'staffA', full_name: 'Mrs A' }, { id: 'staffB', full_name: 'Mr B' }],
  subjects: [{ id: 'math', name: 'Mathematics' }, { id: 'eng', name: 'English' }],
  subject_class_assignments: [
    { id: 'sca1', subject_id: 'math', class_id: 'c1', stream_id: 'str1', periods_per_week: 5, double_periods_per_week: 0 },
    { id: 'sca2', subject_id: 'eng', class_id: 'c1', stream_id: 'str1', periods_per_week: 4, double_periods_per_week: 0 },
    { id: 'sca3', subject_id: 'math', class_id: 'c1', stream_id: 'str2', periods_per_week: 5, double_periods_per_week: 0 },
    { id: 'sca4', subject_id: 'eng', class_id: 'c1', stream_id: 'str2', periods_per_week: 4, double_periods_per_week: 0 }
  ],
  subject_teacher_assignments: [
    { subject_id: 'math', class_id: 'c1', stream_id: 'str1', staff_id: 'staffA' },
    { subject_id: 'math', class_id: 'c1', stream_id: 'str2', staff_id: 'staffA' },
    { subject_id: 'eng', class_id: 'c1', stream_id: 'str1', staff_id: 'staffB' },
    { subject_id: 'eng', class_id: 'c1', stream_id: 'str2', staff_id: 'staffB' }
  ],
  timetable_constraints: []
};

function freshApis(extraTables) {
  const sb = createMockSupabase(JSON.parse(JSON.stringify(Object.assign({}, BASE_TABLES, extraTables || {}))));
  const settings = createSettingsApi(sb);
  const timetable = createTimetableApi(sb, settings);
  return { sb, timetable, settings };
}

async function run() {
  // ---- rooms ----------------------------------------------------------------
  {
    const { timetable } = freshApis();
    check('rooms.save requires a name', (await timetable.rooms.save({})).ok === false);
    const saved = await timetable.rooms.save({ name: 'Lab 1', capacity: 30 });
    check('rooms.save succeeds', saved.ok === true && saved.data.name === 'Lab 1');
    const list = await timetable.rooms.list();
    check('rooms.list returns the saved room', list.ok === true && list.data.length === 1);
    const removed = await timetable.rooms.remove(saved.data.id);
    check('rooms.remove succeeds', removed.ok === true);
    const listAfter = await timetable.rooms.list();
    check('room is gone after remove', listAfter.data.length === 0);
  }

  // ---- periods (period grid) -------------------------------------------------
  {
    const { timetable } = freshApis();
    const bad = await timetable.periods.saveGrid([{ start_time: '08:00', end_time: '07:00' }]);
    check('periods.saveGrid rejects an end time before the start time', bad.ok === false);
    const grid = await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40', is_break: false, label: 'Period 1' },
      { start_time: '08:40', end_time: '09:00', is_break: true, label: 'Break' },
      { start_time: '09:00', end_time: '09:40', is_break: false, label: 'Period 2' }
    ]);
    check('periods.saveGrid succeeds and assigns sequential period_index', grid.ok === true);
    const list = await timetable.periods.list();
    check('periods.list returns them in order', list.data.map((p) => p.period_index).join(',') === '1,2,3');
    check('is_break carried through correctly', list.data[1].is_break === true && list.data[0].is_break === false);

    // Replace-all: saving a shorter grid drops the old rows entirely.
    await timetable.periods.saveGrid([{ start_time: '08:00', end_time: '08:40' }]);
    const after = await timetable.periods.list();
    check('periods.saveGrid replaces the whole grid, not just appends', after.data.length === 1);
  }

  // ---- days (teaching weekdays, stored via settings) -------------------------
  {
    const { timetable } = freshApis();
    const def = await timetable.days.get();
    check('days.get defaults to Mon-Fri when never configured', def.ok === true && def.data.join(',') === '1,2,3,4,5');
    const saved = await timetable.days.save([1, 2, 3, 4, 5, 6]);
    check('days.save accepts Mon-Sat', saved.ok === true);
    const after = await timetable.days.get();
    check('days.get reflects the saved 6-day week', after.data.join(',') === '1,2,3,4,5,6');
    const savedSun = await timetable.days.save([1, 2, 3, 4, 5, 6, 7]);
    check('days.save accepts Sunday too (some schools teach 7 days)', savedSun.ok === true);
    const afterSun = await timetable.days.get();
    check('days.get reflects the saved 7-day week including Sunday', afterSun.data.join(',') === '1,2,3,4,5,6,7');
    const rejected = await timetable.days.save([]);
    check('days.save rejects an empty selection', rejected.ok === false);
  }

  // ---- teacher availability ---------------------------------------------------
  {
    const { timetable } = freshApis();
    const empty = await timetable.availability.listForStaff('staffA');
    check('availability.listForStaff starts empty (fully available by default)', empty.ok === true && empty.data.length === 0);
    const saved = await timetable.availability.saveForStaff('staffA', [{ day_of_week: 1, period_index: 1 }, { day_of_week: 1, period_index: 2 }]);
    check('availability.saveForStaff succeeds', saved.ok === true);
    const after = await timetable.availability.listForStaff('staffA');
    check('availability.listForStaff reflects the saved blocks', after.data.length === 2);
    // Replace-all semantics.
    await timetable.availability.saveForStaff('staffA', [{ day_of_week: 2, period_index: 1 }]);
    const replaced = await timetable.availability.listForStaff('staffA');
    check('availability.saveForStaff replaces rather than appends', replaced.data.length === 1 && replaced.data[0].day_of_week === 2);
  }

  // ---- requirements (periods/week + a double-lesson COUNT on subject_class_assignments) --
  {
    const { timetable, sb } = freshApis();
    const res = await timetable.requirements.save('sca1', 6, 3);
    check('requirements.save succeeds', res.ok === true);
    const row = sb._tables.subject_class_assignments.find((r) => r.id === 'sca1');
    check('requirements.save updates periods_per_week and double_periods_per_week on the right row', row.periods_per_week === 6 && row.double_periods_per_week === 3);
    check('requirements.save requires an assignment id', (await timetable.requirements.save(null, 5, 0)).ok === false);
    // The whole point of the "choose a number, not just yes/no" fix: a
    // school can ask for exactly 3 doubles out of 6 periods (leaving 0
    // singles), but asking for MORE doubles than periods_per_week can
    // physically hold (3 doubles need 6 periods minimum) must be rejected
    // with a clear reason, not silently saved or silently clamped.
    const tooMany = await timetable.requirements.save('sca2', 4, 3);
    check('requirements.save rejects a double count that needs more periods than configured', tooMany.ok === false && /double/i.test(tooMany.message));
  }

  // ---- constraints (Round 2 §7 Constraints module) ----------------------------
  {
    const { timetable } = freshApis();
    check('constraints.list starts empty', (await timetable.constraints.list()).data.length === 0);
    check('constraints.save rejects an unknown type', (await timetable.constraints.save({ type: 'not-a-real-type', config: {} })).ok === false);

    // subject_pair_not_consecutive: needs both subjects, and two DIFFERENT ones.
    const missingB = await timetable.constraints.save({ type: 'subject_pair_not_consecutive', config: { subject_a: 'math' } });
    check('subject_pair_not_consecutive rejects a missing second subject when enabling', missingB.ok === false);
    const sameSubject = await timetable.constraints.save({ type: 'subject_pair_not_consecutive', config: { subject_a: 'math', subject_b: 'math' } });
    check('subject_pair_not_consecutive rejects the same subject twice', sameSubject.ok === false);
    const pairSaved = await timetable.constraints.save({ type: 'subject_pair_not_consecutive', config: { subject_a: 'math', subject_b: 'eng' } });
    check('subject_pair_not_consecutive saves a valid pair', pairSaved.ok === true && pairSaved.data.config.subject_a === 'math' && pairSaved.data.config.subject_b === 'eng');
    check('a saved constraint defaults to enabled', pairSaved.data.enabled === true);

    // A school can have MULTIPLE pairs.
    const pair2 = await timetable.constraints.save({ type: 'subject_pair_not_consecutive', config: { subject_a: 'eng', subject_b: 'math' } });
    check('a second, independent pair can be added', pair2.ok === true);
    const afterTwoPairs = await timetable.constraints.list();
    check('constraints.list reflects both pairs', afterTwoPairs.data.filter((c) => c.type === 'subject_pair_not_consecutive').length === 2);

    // avoid_consecutive_intensive: needs at least 2 subjects when enabling.
    const oneIntensive = await timetable.constraints.save({ type: 'avoid_consecutive_intensive', config: { subject_ids: ['math'] } });
    check('avoid_consecutive_intensive rejects fewer than 2 subjects when enabling', oneIntensive.ok === false);
    const twoIntensive = await timetable.constraints.save({ type: 'avoid_consecutive_intensive', config: { subject_ids: ['math', 'eng'] } });
    check('avoid_consecutive_intensive saves with 2+ subjects', twoIntensive.ok === true);

    // pe_before_break: needs at least 1 subject when enabling.
    const noPe = await timetable.constraints.save({ type: 'pe_before_break', config: { subject_ids: [] } });
    check('pe_before_break rejects zero subjects when enabling', noPe.ok === false);
    const pe = await timetable.constraints.save({ type: 'pe_before_break', config: { subject_ids: ['math'] } });
    check('pe_before_break saves with 1+ subject', pe.ok === true);

    // A DISABLED row is allowed to be incomplete — a school can save "off,
    // not configured yet" without filling in every field first.
    const disabledIncomplete = await timetable.constraints.save({ type: 'avoid_consecutive_intensive', enabled: false, config: {} });
    check('a DISABLED constraint row is allowed to have incomplete config', disabledIncomplete.ok === true && disabledIncomplete.data.enabled === false);

    // max_consecutive_periods_class / _teacher: need a positive max when enabling.
    const badMax = await timetable.constraints.save({ type: 'max_consecutive_periods_class', config: { max: 0 } });
    check('max_consecutive_periods_class rejects a non-positive max when enabling', badMax.ok === false);
    const goodMax = await timetable.constraints.save({ type: 'max_consecutive_periods_teacher', config: { max: 3 } });
    check('max_consecutive_periods_teacher saves a valid max', goodMax.ok === true && goodMax.data.config.max === 3);

    // teacher_no_immediate_after_out: no config needed at all.
    const toggleOnly = await timetable.constraints.save({ type: 'teacher_no_immediate_after_out', enabled: true });
    check('teacher_no_immediate_after_out saves with no extra config', toggleOnly.ok === true);

    // Editing in place (passing an id) updates rather than duplicating.
    const edited = await timetable.constraints.save({ id: pairSaved.data.id, type: 'subject_pair_not_consecutive', enabled: false, config: { subject_a: 'math', subject_b: 'eng' } });
    check('editing an existing constraint by id succeeds', edited.ok === true);
    const afterEdit = await timetable.constraints.list();
    const editedRow = afterEdit.data.find((c) => c.id === pairSaved.data.id);
    check('the edit actually took (now disabled)', editedRow.enabled === false);
    check('editing in place did not create a duplicate row', afterEdit.data.length === 7);

    const removed = await timetable.constraints.remove(pairSaved.data.id);
    check('constraints.remove succeeds', removed.ok === true);
    const afterRemove = await timetable.constraints.list();
    check('the removed row is gone', afterRemove.data.length === 6 && !afterRemove.data.some((c) => c.id === pairSaved.data.id));
    check('constraints.remove requires an id', (await timetable.constraints.remove(null)).ok === false);
  }

  // ---- entries.saveEntry: conflict pre-checks ---------------------------------
  {
    const { timetable } = freshApis();
    const first = await timetable.entries.saveEntry({
      academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
      subject_id: 'math', class_id: 'c1', stream_id: 'str1', staff_id: 'staffA'
    });
    check('entries.saveEntry creates a first entry', first.ok === true);

    const streamClash = await timetable.entries.saveEntry({
      academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
      subject_id: 'eng', class_id: 'c1', stream_id: 'str1', staff_id: 'staffB'
    });
    check('entries.saveEntry blocks a second lesson for the same stream in the same slot', streamClash.ok === false && /stream/i.test(streamClash.message));

    const teacherClash = await timetable.entries.saveEntry({
      academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
      subject_id: 'eng', class_id: 'c1', stream_id: 'str2', staff_id: 'staffA'
    });
    check('entries.saveEntry blocks the same teacher double-booked in the same slot (different stream)', teacherClash.ok === false && /teacher/i.test(teacherClash.message));

    const fine = await timetable.entries.saveEntry({
      academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
      subject_id: 'eng', class_id: 'c1', stream_id: 'str2', staff_id: 'staffB'
    });
    check('a genuinely non-conflicting entry in the same slot (different stream+teacher) is allowed', fine.ok === true);

    const list = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('entries.list enriches with names', list.ok === true && list.data.every((e) => e.subject_name && e.stream_name && e.class_name));

    const cleared = await timetable.entries.clearScope('y1', 't1');
    check('entries.clearScope wipes only this scope', cleared.ok === true);
    const afterClear = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('scope is empty after clearScope', afterClear.data.length === 0);
  }

  // ---- full generate() orchestration ------------------------------------------
  {
    const { timetable } = freshApis();
    await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40' }, { start_time: '08:40', end_time: '09:20' },
      { start_time: '09:20', end_time: '09:40', is_break: true }, { start_time: '09:40', end_time: '10:20' },
      { start_time: '10:20', end_time: '11:00' }, { start_time: '11:00', end_time: '11:40' }
    ]);
    await timetable.days.save([1, 2, 3, 4, 5]);

    const res = await timetable.generate('y1', 't1');
    check('generate() succeeds end to end', res.ok === true);
    check('generate() places the full 5+4 = 9 periods/week for BOTH streams (18 total)', res.data.placed === 18);
    check('generate() leaves nothing unresolved for this easily-satisfiable input', res.data.unresolved.length === 0);

    const entries = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('generate() actually persisted the entries', entries.data.length === 18);

    // Zero collisions, verified directly against the persisted rows.
    const streamKeys = new Set(); let streamClash = false;
    const staffKeys = new Set(); let staffClash = false;
    entries.data.forEach((e) => {
      const sk = `${e.stream_id}|${e.day_of_week}|${e.period_index}`;
      if (streamKeys.has(sk)) streamClash = true; else streamKeys.add(sk);
      if (e.staff_id) {
        const tk = `${e.staff_id}|${e.day_of_week}|${e.period_index}`;
        if (staffKeys.has(tk)) staffClash = true; else staffKeys.add(tk);
      }
    });
    check('generate(): zero stream collisions in the persisted timetable', !streamClash);
    check('generate(): zero teacher collisions in the persisted timetable (staffA teaches both streams\' Math)', !staffClash);

    // Regenerating replaces rather than duplicates.
    const res2 = await timetable.generate('y1', 't1');
    check('re-running generate() succeeds', res2.ok === true);
    const entriesAfter = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('re-running generate() replaces the scope instead of duplicating it', entriesAfter.data.length === 18);

    // Round 6 §3 (BUG: "regenerate produces nearly identical output"):
    // Db.timetable.generate() now feeds the engine a `seed` derived from
    // the next version_number (Round 5 §10), so two back-to-back
    // regenerates of the exact same input genuinely reshuffle instead of
    // converging on the same layout — verified here end to end through
    // the API layer, not just the pure engine function.
    const layout = (rows) => rows.map((e) => `${e.subject_id}:${e.stream_id}:${e.day_of_week}:${e.period_index}`).sort().join(',');
    check('Round 6 §3: regenerating the exact same input produces a genuinely different layout, not the same one every time', layout(entries.data) !== layout(entriesAfter.data));
  }

  // ---- generate(): Round 2 §7 upfront capacity check ---------------------------
  {
    const { timetable } = freshApis();
    await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40' }, { start_time: '08:40', end_time: '09:20' }
    ]); // only 2 teachable periods/day
    await timetable.days.save([1]); // and only 1 teaching day = 2 slots/week total

    // BASE_TABLES asks for 5+4=9 periods/week per stream — way more than
    // the 2 slots/week this tiny grid offers.
    const res = await timetable.generate('y1', 't1');
    check('generate() rejects up front when a stream needs more periods/week than the grid offers', res.ok === false);
    check('the rejection message names what is required vs available, not just a generic failure', /periods\/week/i.test(res.message));

    // Nothing should have been cleared or written — the school's existing
    // (empty, in this case) timetable is left exactly as it was.
    const entries = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('generate() touches nothing when it fails the capacity check up front', entries.data.length === 0);
  }

  // ---- checkCapacityStatus(): Sprint Review §2 — same check as generate(), read-only, callable before clicking Generate ----
  {
    const { timetable } = freshApis();
    await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40' }, { start_time: '08:40', end_time: '09:20' }
    ]); // only 2 teachable periods/day
    await timetable.days.save([1]); // and only 1 teaching day = 2 slots/week total

    const status = await timetable.checkCapacityStatus();
    check('checkCapacityStatus() succeeds (ok:true means the CALL succeeded, not that capacity is fine)', status.ok === true);
    check('...reports capacity as NOT ok when a stream needs more than the grid offers', status.data.ok === false);
    check('...names the overloaded class/arm with required vs available, same numbers generate() itself rejects on', status.data.overloaded.length > 0 && status.data.overloaded[0].required > status.data.overloaded[0].available);
    check('...reports the teachable-slots-per-week figure the Setup screen can show as "Expected"', status.data.teachableSlotsPerWeek === 2);

    // Nothing written — this is read-only, unlike generate().
    const entries = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('checkCapacityStatus() never writes/clears anything', entries.data.length === 0);

    // Widen the grid so the same configured load now fits — capacity flips to ok.
    await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40' }, { start_time: '08:40', end_time: '09:20' },
      { start_time: '09:20', end_time: '10:00' }, { start_time: '10:00', end_time: '10:40' },
      { start_time: '10:40', end_time: '11:20' }, { start_time: '11:20', end_time: '12:00' },
      { start_time: '12:00', end_time: '12:40' }, { start_time: '12:40', end_time: '13:20' },
      { start_time: '13:20', end_time: '14:00' }
    ]);
    const status2 = await timetable.checkCapacityStatus();
    check('checkCapacityStatus() reports ok:true once the grid has enough room', status2.data.ok === true && status2.data.overloaded.length === 0);
  }

  // ---- generate(): a school-configured Constraint actually reaches the engine --
  {
    const { timetable, sb } = freshApis();
    await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40' }, { start_time: '08:40', end_time: '09:20' }, { start_time: '09:20', end_time: '10:00' }
    ]);
    await timetable.days.save([1]);
    // A single stream with two single-period subjects that WOULD land
    // adjacent by default — same shape as generate.mjs's own unit test for
    // this constraint, just exercised end-to-end through the API layer
    // this time (fetch constraints -> hand to generateTimetable).
    sb._tables.streams = [{ id: 'strOnly', class_id: 'c1', name: 'Only' }];
    sb._tables.subject_class_assignments = [
      { id: 'p1', subject_id: 'math', class_id: 'c1', stream_id: 'strOnly', periods_per_week: 1, double_periods_per_week: 0 },
      { id: 'p2', subject_id: 'eng', class_id: 'c1', stream_id: 'strOnly', periods_per_week: 1, double_periods_per_week: 0 }
    ];
    sb._tables.subject_teacher_assignments = [];
    await timetable.constraints.save({ type: 'subject_pair_not_consecutive', config: { subject_a: 'math', subject_b: 'eng' } });

    const res = await timetable.generate('y1', 't1');
    check('generate() succeeds with a Constraint configured', res.ok === true);
    const entries = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    const mathEntry = entries.data.find((e) => e.subject_id === 'math');
    const engEntry = entries.data.find((e) => e.subject_id === 'eng');
    check('the configured pair constraint actually reached the engine — math and eng do not land adjacent', Math.abs(mathEntry.period_index - engEntry.period_index) !== 1);
  }

  // ---- perf: generate() batches subject_class_assignments into O(1) queries ---
  // Previously fetched stream-specific + class-wide subject_class_assignments
  // rows with TWO queries PER STREAM (2N total) — on a big school with 30-40
  // streams that meant 60-80 round trips, most of them queued behind the
  // browser's per-host connection limit, which is what actually made
  // "Generate" feel slow. Fixed to two queries total, however many streams
  // exist. Verified here by counting how many times .from('subject_class_
  // assignments') is actually called for a school with many streams.
  {
    const manyStreams = {};
    manyStreams.classes = [{ id: 'bigc', name: 'Grade 8' }];
    manyStreams.streams = Array.from({ length: 12 }, (_, i) => ({ id: `bs${i}`, class_id: 'bigc', name: `Stream ${i}` }));
    manyStreams.subject_class_assignments = manyStreams.streams.map((s, i) => ({
      id: `bsca${i}`, subject_id: 'math', class_id: 'bigc', stream_id: s.id, periods_per_week: 3, double_periods_per_week: 0
    }));
    manyStreams.subjects = [{ id: 'math', name: 'Mathematics' }];
    manyStreams.subject_teacher_assignments = [];

    const { timetable, sb } = freshApis(manyStreams);
    await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40' }, { start_time: '08:40', end_time: '09:20' }, { start_time: '09:20', end_time: '10:00' }
    ]);
    await timetable.days.save([1, 2, 3, 4, 5]);

    let scaCalls = 0;
    const originalFrom = sb.from.bind(sb);
    sb.from = (table) => { if (table === 'subject_class_assignments') scaCalls++; return originalFrom(table); };

    const res = await timetable.generate('y1', 't1');
    check('generate() still succeeds with many streams', res.ok === true);
    check('generate() queries subject_class_assignments a CONSTANT number of times (2), not once per stream (12 streams here)', scaCalls === 2);
  }

  // ---- Round 5 §10: version history — entries.list/listVersions/reactivateVersion --
  // Seeded directly rather than through generate(), so the scenario is
  // fully controlled: version 1 (deactivated) has a Math lesson AND staffA
  // busy in slot day1/period1; version 2 (active) has a different subject
  // in that same slot, with staffA free. This is exactly the situation
  // generate() produces on a regenerate, minus the placement engine.
  {
    const { timetable, sb } = freshApis();
    sb._tables.timetable_entries = [
      { id: 'e-v1', school_id: 'sch1', academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
        subject_id: 'math', class_id: 'c1', stream_id: 'str1', staff_id: 'staffA', room_id: null,
        version_number: 1, is_active: false, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'e-v2', school_id: 'sch1', academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
        subject_id: 'eng', class_id: 'c1', stream_id: 'str1', staff_id: null, room_id: null,
        version_number: 2, is_active: true, created_at: '2026-01-02T00:00:00.000Z' }
    ];

    const activeList = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('entries.list with no version_number defaults to the ACTIVE version only', activeList.ok === true && activeList.data.length === 1 && activeList.data[0].id === 'e-v2');

    const oldList = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1', version_number: 1 });
    check('entries.list can preview a specific (deactivated) older version by number', oldList.data.length === 1 && oldList.data[0].id === 'e-v1');

    const versions = await timetable.entries.listVersions('y1', 't1');
    check('listVersions returns both kept versions, newest first', versions.ok === true && versions.data.map((v) => v.version_number).join(',') === '2,1');
    check('listVersions correctly flags which one is active', versions.data.find((v) => v.version_number === 2).is_active === true && versions.data.find((v) => v.version_number === 1).is_active === false);
    check('listVersions requires an academic year/term', (await timetable.entries.listVersions(null, 't1')).ok === false);

    // The whole point of Round 5 §10's clash-check fix: staffA is busy in
    // the DEACTIVATED version 1 at day1/period1, but that no longer
    // "occupies" the slot as far as the current (active) timetable is
    // concerned — a manual edit placing staffA in that same slot on a
    // DIFFERENT stream must be allowed.
    const noClash = await timetable.entries.saveEntry({
      academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
      subject_id: 'math', class_id: 'c1', stream_id: 'str2', staff_id: 'staffA'
    });
    check('saveEntry only checks clashes against the ACTIVE version, not deactivated older ones', noClash.ok === true);
    const newRow = sb._tables.timetable_entries.find((r) => r.stream_id === 'str2');
    check('a new manual entry lands on the currently-active version_number', newRow.version_number === 2 && newRow.is_active === true);

    // A genuine clash WITHIN the active version is still blocked (eng in
    // version 2 already occupies str1/day1/period1).
    const realClash = await timetable.entries.saveEntry({
      academic_year_id: 'y1', term_id: 't1', day_of_week: 1, period_index: 1,
      subject_id: 'math', class_id: 'c1', stream_id: 'str1', staff_id: 'staffB'
    });
    check('saveEntry still blocks a genuine clash within the active version', realClash.ok === false && /stream/i.test(realClash.message));

    const badReactivate = await timetable.entries.reactivateVersion('y1', 't1', 99);
    check('reactivateVersion rejects a version number that does not exist for this scope', badReactivate.ok === false);

    const reactivated = await timetable.entries.reactivateVersion('y1', 't1', 1);
    check('reactivateVersion succeeds for a version that does exist', reactivated.ok === true);
    const afterReactivate = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('after reactivating version 1, the default (active-only) list now returns version 1\'s entry', afterReactivate.data.length === 1 && afterReactivate.data[0].id === 'e-v1');
    const versionsAfter = await timetable.entries.listVersions('y1', 't1');
    check('reactivateVersion flips is_active — version 1 now active, version 2 now inactive', versionsAfter.data.find((v) => v.version_number === 1).is_active === true && versionsAfter.data.find((v) => v.version_number === 2).is_active === false);

    // A fresh manual entry after reactivating lands on the NEW active version.
    const afterReactivateInsert = await timetable.entries.saveEntry({
      academic_year_id: 'y1', term_id: 't1', day_of_week: 2, period_index: 1,
      subject_id: 'eng', class_id: 'c1', stream_id: 'str1', staff_id: null
    });
    check('saveEntry after a reactivation lands on the now-active version', afterReactivateInsert.ok === true);
    const latestRow = sb._tables.timetable_entries.find((r) => r.day_of_week === 2);
    check('...specifically version_number 1, not the previously-active 2', latestRow.version_number === 1);
  }

  // ---- Round 5 §10: generate() keeps the last 3 versions and prunes older ones --
  {
    const { timetable } = freshApis();
    await timetable.periods.saveGrid([
      { start_time: '08:00', end_time: '08:40' }, { start_time: '08:40', end_time: '09:20' },
      { start_time: '09:20', end_time: '09:40', is_break: true }, { start_time: '09:40', end_time: '10:20' },
      { start_time: '10:20', end_time: '11:00' }, { start_time: '11:00', end_time: '11:40' }
    ]);
    await timetable.days.save([1, 2, 3, 4, 5]);

    for (let i = 0; i < 4; i++) {
      const res = await timetable.generate('y1', 't1');
      check(`generate() call #${i + 1} succeeds`, res.ok === true);
    }

    const versions = await timetable.entries.listVersions('y1', 't1');
    check('generate() keeps only the last 3 versions after 4 regenerates', versions.ok === true && versions.data.length === 3);
    check('the 3 kept versions are the 3 most recent (2, 3, 4) — version 1 was pruned', versions.data.map((v) => v.version_number).sort((a, b) => a - b).join(',') === '2,3,4');
    check('the most recent version (4) is the active one', versions.data.find((v) => v.version_number === 4).is_active === true);

    const active = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('the active version still has the full 18 placed entries', active.data.length === 18);

    // Reactivating an older (but still-kept) version works end to end.
    const reactivated = await timetable.entries.reactivateVersion('y1', 't1', 2);
    check('reactivateVersion succeeds for a version generate() kept', reactivated.ok === true);
    const afterReactivate = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('the active (default) list now reflects version 2', afterReactivate.data.length === 18 && afterReactivate.data.every((e) => e.version_number === 2));

    // The pruned version 1 is genuinely gone, not just deactivated.
    const prunedPreview = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1', version_number: 1 });
    check('a pruned version\'s rows are actually deleted, not just hidden', prunedPreview.data.length === 0);
  }

  // ---- Round 5 §10: a total placement failure leaves the existing timetable untouched --
  {
    const { timetable, sb } = freshApis({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      streams: [{ id: 'strOnly', class_id: 'c1', name: 'Only' }],
      subjects: [{ id: 'math', name: 'Mathematics' }],
      subject_class_assignments: [
        { id: 'p1', subject_id: 'math', class_id: 'c1', stream_id: 'strOnly', periods_per_week: 1, double_periods_per_week: 0 }
      ],
      subject_teacher_assignments: [{ subject_id: 'math', class_id: 'c1', stream_id: 'strOnly', staff_id: 'staffA' }],
      teacher_unavailability: []
    });
    // Exactly one teachable slot in the whole week — just enough capacity
    // for the 1 period/week this stream needs.
    await timetable.periods.saveGrid([{ start_time: '08:00', end_time: '08:40' }]);
    await timetable.days.save([1]);

    const first = await timetable.generate('y1', 't1');
    check('first generate() succeeds and places the one lesson', first.ok === true && first.data.placed === 1);

    // Now block the only teachable slot for the only teacher who can teach
    // this subject — capacity still says "1 required, 1 available" (the
    // upfront check doesn't know about per-teacher unavailability), but the
    // placement engine will genuinely be unable to place anything.
    sb._tables.teacher_unavailability = [{ staff_id: 'staffA', day_of_week: 1, period_index: 1 }];

    const second = await timetable.generate('y1', 't1');
    check('a regenerate that can place NOTHING is rejected rather than wiping the existing timetable', second.ok === false);
    check('the rejection message reassures that the existing timetable was not touched', /existing timetable/i.test(second.message));

    const stillThere = await timetable.entries.list({ academic_year_id: 'y1', term_id: 't1' });
    check('the original successful timetable is still there, untouched, after the failed regenerate', stillThere.data.length === 1 && stillThere.data[0].subject_id === 'math');
    const versions = await timetable.entries.listVersions('y1', 't1');
    check('no new (empty) version was created by the failed regenerate', versions.data.length === 1 && versions.data[0].version_number === 1);
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
