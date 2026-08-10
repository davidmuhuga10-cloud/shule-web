import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createAcademicsApi, CBC_SUBJECTS, STANDARD_CLASS_LEVELS } from '../src/lib/api/academics.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- academicYears -------------------------------------------------------
  {
    const sb = createMockSupabase({ academic_years: [{ id: 'y1', name: '2025', status: 'archived' }] });
    const api = createAcademicsApi(sb);

    const dupRes = await api.academicYears.save({ name: '2025' });
    check('academicYears.save rejects duplicate name', dupRes.ok === false);

    const created = await api.academicYears.save({ name: '2026', status: 'active' });
    check('academicYears.save creates a new year', created.ok === true && created.data.name === '2026');

    const listed = await api.academicYears.list();
    check('academicYears.list returns years sorted desc by name', listed.data[0].name === '2026' && listed.data[1].name === '2025');

    const y2025 = listed.data.find((y) => y.name === '2025');
    check('academicYears.save(active) archives the previously-active year (none were active here, stays archived)', y2025.status === 'archived');
  }
  {
    const sb = createMockSupabase({
      academic_years: [{ id: 'y1', name: '2025', status: 'active' }, { id: 'y2', name: '2026', status: 'upcoming' }]
    });
    const api = createAcademicsApi(sb);
    await api.academicYears.save({ id: 'y2', name: '2026', status: 'active' });
    const listed = await api.academicYears.list();
    const y1 = listed.data.find((y) => y.id === 'y1');
    const y2 = listed.data.find((y) => y.id === 'y2');
    check('academicYears.save(active) archives the OTHER previously-active year', y1.status === 'archived' && y2.status === 'active');
  }
  {
    const sb = createMockSupabase({ academic_years: [{ id: 'y1', name: '2025' }], terms: [{ id: 't1', academic_year_id: 'y1' }] });
    const api = createAcademicsApi(sb);
    const res = await api.academicYears.remove('y1');
    check('academicYears.remove is blocked when terms are linked', res.ok === false);
  }

  // ---- terms ----------------------------------------------------------------
  {
    const sb = createMockSupabase({ academic_years: [{ id: 'y1', name: '2026' }] });
    const api = createAcademicsApi(sb);
    const missingYear = await api.terms.save({ name: 'Term 1' });
    check('terms.save requires an academic year', missingYear.ok === false);

    const saved = await api.terms.save({ academic_year_id: 'y1', name: 'Term 1', status: 'active' });
    check('terms.save creates a term', saved.ok === true);

    const dup = await api.terms.save({ academic_year_id: 'y1', name: 'Term 1' });
    check('terms.save rejects a duplicate term for the same year', dup.ok === false);

    const listed = await api.terms.list('y1');
    check('terms.list joins the academic year name', listed.data[0].academic_year_name === '2026');
  }
  {
    const sb = createMockSupabase({
      academic_years: [{ id: 'y1', name: '2026' }],
      terms: [{ id: 't1', academic_year_id: 'y1', name: 'Term 1', status: 'active' }]
    });
    const api = createAcademicsApi(sb);
    await api.terms.save({ academic_year_id: 'y1', name: 'Term 2', status: 'active' });
    const listed = await api.terms.list('y1');
    const t1 = listed.data.find((t) => t.id === 't1');
    check('terms.save(active) archives the previously-active term', t1.status === 'archived');
  }

  // ---- classes + inline streams ----------------------------------------------
  {
    const sb = createMockSupabase({});
    const api = createAcademicsApi(sb);
    const saved = await api.classes.save({ name: 'Grade 7', level_order: 7, streams: ['North', 'north', 'South'] });
    check('classes.save creates the class', saved.ok === true);
    check('classes.save dedupes case-insensitive stream names, adding only 2', saved.streamsAdded === 2);

    const streams = await api.academicYearsStreamsHelper?.(); // no-op guard, streams tested via streams.list below
    const streamList = await api.streams.list(saved.data.id);
    check('classes.save actually created the streams', streamList.data.length === 2);
  }
  {
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7', level_order: 7 }] });
    const api = createAcademicsApi(sb);
    const dup = await api.classes.save({ name: 'Grade 7', streams: ['Main'] });
    check('classes.save rejects a duplicate class name', dup.ok === false);
  }
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7', level_order: 7 }],
      students: [{ id: 's1', class_id: 'c1' }]
    });
    const api = createAcademicsApi(sb);
    const res = await api.classes.remove('c1');
    check('classes.remove is blocked when students are enrolled', res.ok === false);
  }
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7', level_order: 7 }, { id: 'c2', name: 'Grade 1', level_order: 1 }]
    });
    const api = createAcademicsApi(sb);
    const listed = await api.classes.list();
    check('classes.list sorts by level_order', listed.data[0].id === 'c2' && listed.data[1].id === 'c1');
  }
  {
    // Perf fix: stream_count/student_count used to be computed with one
    // sequential round trip PER class; now it's a single batched fetch —
    // this checks the per-class counts still land on the right class.
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7', level_order: 7 }, { id: 'c2', name: 'Grade 1', level_order: 1 }],
      streams: [{ id: 'st1', class_id: 'c1' }, { id: 'st2', class_id: 'c1' }, { id: 'st3', class_id: 'c2' }],
      students: [{ id: 's1', class_id: 'c1' }, { id: 's2', class_id: 'c1' }, { id: 's3', class_id: 'c1' }, { id: 's4', class_id: 'c2' }]
    });
    const api = createAcademicsApi(sb);
    const listed = await api.classes.list();
    const c1 = listed.data.find((c) => c.id === 'c1');
    const c2 = listed.data.find((c) => c.id === 'c2');
    check('classes.list batches stream_count correctly per class', c1.stream_count === 2 && c2.stream_count === 1);
    check('classes.list batches student_count correctly per class', c1.student_count === 3 && c2.student_count === 1);
  }
  {
    // A class with zero streams/students must not error and must show 0, not undefined.
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7', level_order: 7 }] });
    const api = createAcademicsApi(sb);
    const listed = await api.classes.list();
    check('classes.list defaults counts to 0 for a class with no streams/students', listed.data[0].stream_count === 0 && listed.data[0].student_count === 0);
  }
  {
    // No classes at all -> empty list, no error from the batched follow-up queries.
    const sb = createMockSupabase({});
    const api = createAcademicsApi(sb);
    const listed = await api.classes.list();
    check('classes.list handles zero classes without error', listed.ok === true && listed.data.length === 0);
  }

  // ---- streams ----------------------------------------------------------------
  {
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7' }], streams: [{ id: 'st1', class_id: 'c1', name: 'North' }] });
    const api = createAcademicsApi(sb);
    const dup = await api.streams.save({ class_id: 'c1', name: 'North' });
    check('streams.save rejects a duplicate stream for the same class', dup.ok === false);
    const ok2 = await api.streams.save({ class_id: 'c1', name: 'South' });
    check('streams.save allows a new stream name', ok2.ok === true);
  }
  {
    const sb = createMockSupabase({ streams: [{ id: 'st1', class_id: 'c1', name: 'North' }], students: [{ id: 's1', stream_id: 'st1' }] });
    const api = createAcademicsApi(sb);
    const res = await api.streams.remove('st1');
    check('streams.remove is blocked when students are assigned', res.ok === false);
  }

  // ---- Round 3 §17: a class must always have at least one stream (arm) ------------
  {
    const sb = createMockSupabase({});
    const api = createAcademicsApi(sb);
    const noStreams = await api.classes.save({ name: 'Grade 7' });
    check('classes.save rejects a brand-new class with no streams at all', noStreams.ok === false && /at least one arm/i.test(noStreams.message));
    const blankOnly = await api.classes.save({ name: 'Grade 7', streams: ['   ', ''] });
    check('classes.save treats blank/whitespace-only stream names as none given', blankOnly.ok === false);
    const withOne = await api.classes.save({ name: 'Grade 7', streams: ['Main'] });
    check('classes.save succeeds once at least one real stream name is given', withOne.ok === true && withOne.streamsAdded === 1);
  }
  {
    // Editing an EXISTING class never requires re-supplying streams — the
    // ones it already has are untouched either way.
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7' }], streams: [{ id: 'st1', class_id: 'c1', name: 'North' }] });
    const api = createAcademicsApi(sb);
    const edited = await api.classes.save({ id: 'c1', name: 'Grade 7', description: 'updated' });
    check('classes.save on an EXISTING class does not require streams to be re-supplied', edited.ok === true);
  }
  {
    // A class's only stream can never be deleted down to zero — the exact
    // "no class should ever exist without at least one stream" invariant,
    // independent of the student-assignment check above.
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      streams: [{ id: 'st1', class_id: 'c1', name: 'North' }]
    });
    const api = createAcademicsApi(sb);
    const blocked = await api.streams.remove('st1');
    check('streams.remove refuses to delete a class\'s LAST remaining stream', blocked.ok === false && /at least one arm/i.test(blocked.message));
  }
  {
    // With a sibling stream present, deleting one is fine — the class still
    // ends up with at least one afterwards.
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      streams: [{ id: 'st1', class_id: 'c1', name: 'North' }, { id: 'st2', class_id: 'c1', name: 'South' }]
    });
    const api = createAcademicsApi(sb);
    const allowed = await api.streams.remove('st1');
    check('streams.remove still allows deleting one of SEVERAL streams', allowed.ok === true);
  }
  // Round 2 §2 (BUG): a stream name like "Blue,Red" was accepted with no
  // validation. Round 2 §4: renaming an existing stream reuses save().
  {
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7' }], streams: [{ id: 'st1', class_id: 'c1', name: 'North' }, { id: 'st2', class_id: 'c1', name: 'South' }] });
    const api = createAcademicsApi(sb);

    const withComma = await api.streams.save({ class_id: 'c1', name: 'Blue,Red' });
    check('streams.save rejects a name with a comma', withComma.ok === false);
    check('the rejection message explains why (special characters)', /special character/i.test(withComma.message));

    const withSlash = await api.streams.save({ class_id: 'c1', name: 'Blue/Red' });
    check('streams.save rejects a name with a slash', withSlash.ok === false);

    const plain = await api.streams.save({ class_id: 'c1', name: 'Blue Team 2' });
    check('streams.save accepts letters, digits and spaces', plain.ok === true);

    const renamed = await api.streams.save({ id: 'st1', class_id: 'c1', name: 'Northeast' });
    check('streams.save renames an existing stream', renamed.ok === true && renamed.data.name === 'Northeast');

    const renameToComma = await api.streams.save({ id: 'st1', class_id: 'c1', name: 'North,East' });
    check('renaming to a name with special characters is rejected too, not just on create', renameToComma.ok === false);

    const renameToOwnName = await api.streams.save({ id: 'st1', class_id: 'c1', name: 'Northeast' });
    check('renaming a stream to its own current name is allowed (not flagged as a duplicate of itself)', renameToOwnName.ok === true);

    const renameToOtherStreamsName = await api.streams.save({ id: 'st1', class_id: 'c1', name: 'South' });
    check('renaming a stream to collide with a DIFFERENT existing stream in the same class is rejected', renameToOtherStreamsName.ok === false);
  }

  // ---- classes: standardized levels (Phase 2b) -----------------------------------
  {
    check('STANDARD_CLASS_LEVELS spans Daycare through Grade 9 (12 levels)',
      STANDARD_CLASS_LEVELS.length === 12 && STANDARD_CLASS_LEVELS[0] === 'Daycare' && STANDARD_CLASS_LEVELS[11] === 'Grade 9');

    const sb = createMockSupabase({});
    const api = createAcademicsApi(sb);
    const g1 = await api.classes.save({ name: 'Grade 1', streams: ['Main'] });
    check('classes.save auto-derives level_order for a standard class name', g1.data.level_order === 4);
    const daycare = await api.classes.save({ name: 'daycare', streams: ['Main'] });
    check('classes.save matches standard names case-insensitively', daycare.data.level_order === 1);
    const g9 = await api.classes.save({ name: 'Grade 9', streams: ['Main'] });
    check('classes.save orders the last standard level correctly', g9.data.level_order === 12);
  }
  {
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Custom Class', level_order: 99 }] });
    const api = createAcademicsApi(sb);
    const updated = await api.classes.save({ id: 'c1', name: 'Custom Class', description: 'updated' });
    check('classes.save preserves level_order for a non-standard (legacy) class when none is given', updated.ok === true && updated.data.level_order === 99);
  }

  // ---- classes: class teacher designation (Phase 2a) ---------------------------
  {
    const sb = createMockSupabase({ staff: [{ id: 'st1', full_name: 'Mr. Otieno' }] });
    const api = createAcademicsApi(sb);
    const saved = await api.classes.save({ name: 'Grade 7', class_teacher_staff_id: 'st1', streams: ['Main'] });
    check('classes.save persists a class_teacher_staff_id', saved.data.class_teacher_staff_id === 'st1');
    const cleared = await api.classes.save({ id: saved.data.id, name: 'Grade 7' });
    check('classes.save clears class_teacher_staff_id when omitted', cleared.data.class_teacher_staff_id === null);
  }

  // ---- subject papers (Learning Area Papers — exam-scoped, not permanent) ------
  {
    const sb = createMockSupabase({
      subjects: [{ id: 'su1', name: 'English' }],
      exams: [{ id: 'ex1', name: 'Term 1 Exam' }, { id: 'ex2', name: 'Term 2 Exam' }]
    });
    const api = createAcademicsApi(sb);

    check('subjectPapers.setForSubject requires an exam', (await api.subjectPapers.setForSubject(null, 'su1', [])).ok === false);
    check('subjectPapers.setForSubject requires a subject', (await api.subjectPapers.setForSubject('ex1', null, [])).ok === false);

    // Zero papers = single combined mark — the default state, and always a
    // valid save (the "revert to a single mark" escape hatch).
    const zero = await api.subjectPapers.setForSubject('ex1', 'su1', []);
    check('setForSubject accepts an empty paper list (single-mark mode)', zero.ok === true);
    check('list() is empty for a subject with no papers configured', (await api.subjectPapers.list('ex1', 'su1')).data.length === 0);

    // Ratios that don't add up to 100% are rejected outright, never silently saved.
    const badRatio = await api.subjectPapers.setForSubject('ex1', 'su1', [
      { name: 'Paper 1', out_of: 60, ratio: 60 }, { name: 'Paper 2', out_of: 40, ratio: 30 }
    ]);
    check('setForSubject rejects ratios that do not sum to 100%', badRatio.ok === false && /100%/.test(badRatio.message));

    const saved = await api.subjectPapers.setForSubject('ex1', 'su1', [
      { name: 'Paper 1', out_of: 60, ratio: 60 }, { name: 'Paper 2', out_of: 40, ratio: 40 }
    ]);
    check('setForSubject saves a valid 2-paper split', saved.ok === true && saved.count === 2);

    const listed = await api.subjectPapers.list('ex1', 'su1');
    check('list() returns both papers in order, weight converted from the 0-100 ratio', listed.data.length === 2
      && listed.data[0].name === 'Paper 1' && listed.data[0].weight === 0.6
      && listed.data[1].name === 'Paper 2' && listed.data[1].weight === 0.4);

    // A single paper's ratio is always locked to 100%, regardless of what's sent.
    const single = await api.subjectPapers.setForSubject('ex1', 'su1', [{ id: listed.data[0].id, name: 'Paper 1', out_of: 100, ratio: 37 }]);
    check('setForSubject with just one paper locks its ratio to 100% (no combining needed)', single.ok === true);
    const afterSingle = await api.subjectPapers.list('ex1', 'su1');
    check('single remaining paper has weight 1 regardless of the ratio sent', afterSingle.data.length === 1 && afterSingle.data[0].weight === 1);
    check('setForSubject with one paper removed the other (replace-all, not append)', afterSingle.data.every((p) => p.name === 'Paper 1'));

    // Reverting to zero papers again — the "use single mark instead" path.
    const reverted = await api.subjectPapers.setForSubject('ex1', 'su1', []);
    check('setForSubject([]) reverts a configured subject back to single-mark mode', reverted.ok === true);
    check('no papers remain after reverting', (await api.subjectPapers.list('ex1', 'su1')).data.length === 0);

    // THE critical requirement: the exact same subject has a completely
    // independent paper setup in a DIFFERENT exam — nothing carries over,
    // nothing is remembered from ex1.
    const otherExam = await api.subjectPapers.setForSubject('ex2', 'su1', [
      { name: 'Paper 1', out_of: 100, ratio: 100 }
    ]);
    check('the same subject can have a totally different paper setup in a different exam', otherExam.ok === true);
    check('exam 1 is unaffected by exam 2\'s paper setup for the same subject', (await api.subjectPapers.list('ex1', 'su1')).data.length === 0);
    check('exam 2 has its own independent paper', (await api.subjectPapers.list('ex2', 'su1')).data.length === 1);

    check('listForExam returns every paper across every subject for one exam', (await api.subjectPapers.listForExam('ex2')).data.length === 1);
    check('setForSubject rejects a paper with no positive out_of', (await api.subjectPapers.setForSubject('ex1', 'su1', [{ name: 'Paper 1', out_of: 0, ratio: 100 }])).ok === false);
  }

  // ---- subjects + CBC ----------------------------------------------------------
  {
    const sb = createMockSupabase({
      subjects: [{ id: 'su1', name: 'Mathematics', level: 'Upper Primary' }, { id: 'su2', name: 'Art', level: 'Pre-Primary' }]
    });
    const api = createAcademicsApi(sb);
    const listed = await api.subjects.list();
    check('subjects.list orders Pre-Primary before Upper Primary', listed.data[0].level === 'Pre-Primary');

    const dup = await api.subjects.save({ name: 'Mathematics', level: 'Upper Primary' });
    check('subjects.save rejects a duplicate (name, level)', dup.ok === false);

    const sameNameOtherLevel = await api.subjects.save({ name: 'Mathematics', level: 'Junior Secondary' });
    check('subjects.save allows the same name at a different level', sameNameOtherLevel.ok === true);
  }
  {
    const sb = createMockSupabase({});
    const api = createAcademicsApi(sb);
    const first = await api.subjects.loadCbc();
    check('subjects.loadCbc adds all CBC subjects on first run', first.added === CBC_SUBJECTS.length);
    const second = await api.subjects.loadCbc();
    check('subjects.loadCbc is idempotent (0 added on re-run)', second.added === 0);
    const listed = await api.subjects.list();
    check('subjects.list reflects the seeded CBC subjects', listed.data.length === CBC_SUBJECTS.length);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
