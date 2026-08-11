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

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
