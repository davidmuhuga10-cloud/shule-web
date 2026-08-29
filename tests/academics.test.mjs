import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createAcademicsApi, CBC_SUBJECTS, STANDARD_CLASS_LEVELS, PRI_JSS_CLASS_LEVELS, SENIOR_CLASS_LEVELS, classLevelsForCategory, levelBucketForClassName, PATHWAYS } from '../src/lib/api/academics.mjs';

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
    check('classes.save rejects a brand-new class with no streams at all', noStreams.ok === false && /at least one stream/i.test(noStreams.message));
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
    check('streams.remove refuses to delete a class\'s LAST remaining stream', blocked.ok === false && /at least one stream/i.test(blocked.message));
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
    // Next Sprint 3 §1: Senior School (Grade 10-12) + Form 3/4 are now
    // APPENDED to the same list, not a separate 12-entry list — see
    // cbcDefaults.mjs's header comment on why (level_order for every
    // existing Daycare-Grade9 school must stay exactly as it was).
    check('STANDARD_CLASS_LEVELS spans Daycare through Form 4 (17 levels)',
      STANDARD_CLASS_LEVELS.length === 17 && STANDARD_CLASS_LEVELS[0] === 'Daycare' && STANDARD_CLASS_LEVELS[11] === 'Grade 9' && STANDARD_CLASS_LEVELS[16] === 'Form 4');
    check('PRI_JSS_CLASS_LEVELS is exactly the original 12 (Daycare..Grade 9)',
      PRI_JSS_CLASS_LEVELS.length === 12 && PRI_JSS_CLASS_LEVELS[11] === 'Grade 9');
    check('SENIOR_CLASS_LEVELS is exactly the 5 new ones (Grade 10-12, Form 3-4)',
      SENIOR_CLASS_LEVELS.length === 5 && SENIOR_CLASS_LEVELS[0] === 'Grade 10' && SENIOR_CLASS_LEVELS[4] === 'Form 4');
    check('classLevelsForCategory falls back to pri_jss for an unrecognised/missing category',
      classLevelsForCategory(undefined) === PRI_JSS_CLASS_LEVELS && classLevelsForCategory('bogus') === PRI_JSS_CLASS_LEVELS);
    check('classLevelsForCategory returns the senior list for category "senior"',
      classLevelsForCategory('senior') === SENIOR_CLASS_LEVELS);
    check('levelBucketForClassName resolves Grade 10-12 to Senior Secondary and Form 3/4 to Form 3-4',
      levelBucketForClassName('Grade 11') === 'Senior Secondary' && levelBucketForClassName('Form 3') === 'Form 3-4');
    check('PATHWAYS is the fixed 3-pathway list', PATHWAYS.length === 3 && PATHWAYS.indexOf('STEM') !== -1);

    const sb = createMockSupabase({});
    const api = createAcademicsApi(sb);
    const g1 = await api.classes.save({ name: 'Grade 1', streams: ['Main'] });
    check('classes.save auto-derives level_order for a standard class name', g1.data.level_order === 4);
    const daycare = await api.classes.save({ name: 'daycare', streams: ['Main'] });
    check('classes.save matches standard names case-insensitively', daycare.data.level_order === 1);
    const grade10 = await api.classes.save({ name: 'Grade 10', streams: [{ name: 'STEM A', pathway: 'STEM' }] });
    check('classes.save auto-derives level_order for Grade 10 (13th standard level)', grade10.data.level_order === 13);
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

  // ---- subject papers (Learning Area Papers — exam-scoped AND class-scoped, not permanent) ------
  {
    const sb = createMockSupabase({
      subjects: [{ id: 'su1', name: 'English' }],
      exams: [{ id: 'ex1', name: 'Term 1 Exam' }, { id: 'ex2', name: 'Term 2 Exam' }],
      classes: [{ id: 'c1', name: 'Grade 1' }, { id: 'c8', name: 'Grade 8' }]
    });
    const api = createAcademicsApi(sb);

    check('subjectPapers.setForSubject requires an exam', (await api.subjectPapers.setForSubject(null, 'su1', 'c1', [])).ok === false);
    check('subjectPapers.setForSubject requires a subject', (await api.subjectPapers.setForSubject('ex1', null, 'c1', [])).ok === false);
    check('subjectPapers.setForSubject requires a class', (await api.subjectPapers.setForSubject('ex1', 'su1', null, [])).ok === false);

    // Zero papers = single combined mark — the default state, and always a
    // valid save (the "revert to a single mark" escape hatch).
    const zero = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', []);
    check('setForSubject accepts an empty paper list (single-mark mode)', zero.ok === true);
    check('list() is empty for a subject with no papers configured', (await api.subjectPapers.list('ex1', 'su1', 'c1')).data.length === 0);

    // Ratios that don't add up to 100% are rejected outright, never silently saved.
    const badRatio = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { name: 'Paper 1', out_of: 60, ratio: 60 }, { name: 'Paper 2', out_of: 40, ratio: 30 }
    ]);
    check('setForSubject rejects ratios that do not sum to 100%', badRatio.ok === false && /100%/.test(badRatio.message));

    const saved = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { name: 'Paper 1', out_of: 60, ratio: 60 }, { name: 'Paper 2', out_of: 40, ratio: 40 }
    ]);
    check('setForSubject saves a valid 2-paper split', saved.ok === true && saved.count === 2);

    const listed = await api.subjectPapers.list('ex1', 'su1', 'c1');
    check('list() returns both papers in order, weight converted from the 0-100 ratio', listed.data.length === 2
      && listed.data[0].name === 'Paper 1' && listed.data[0].weight === 0.6
      && listed.data[1].name === 'Paper 2' && listed.data[1].weight === 0.4);

    // A single paper's ratio is always locked to 100%, regardless of what's sent.
    const single = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [{ id: listed.data[0].id, name: 'Paper 1', out_of: 100, ratio: 37 }]);
    check('setForSubject with just one paper locks its ratio to 100% (no combining needed)', single.ok === true);
    const afterSingle = await api.subjectPapers.list('ex1', 'su1', 'c1');
    check('single remaining paper has weight 1 regardless of the ratio sent', afterSingle.data.length === 1 && afterSingle.data[0].weight === 1);
    check('setForSubject with one paper removed the other (replace-all, not append)', afterSingle.data.every((p) => p.name === 'Paper 1'));

    // Reverting to zero papers again — the "use single mark instead" path.
    const reverted = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', []);
    check('setForSubject([]) reverts a configured subject back to single-mark mode', reverted.ok === true);
    check('no papers remain after reverting', (await api.subjectPapers.list('ex1', 'su1', 'c1')).data.length === 0);

    // THE critical requirement: the exact same subject has a completely
    // independent paper setup in a DIFFERENT exam — nothing carries over,
    // nothing is remembered from ex1.
    const otherExam = await api.subjectPapers.setForSubject('ex2', 'su1', 'c1', [
      { name: 'Paper 1', out_of: 100, ratio: 100 }
    ]);
    check('the same subject can have a totally different paper setup in a different exam', otherExam.ok === true);
    check('exam 1 is unaffected by exam 2\'s paper setup for the same subject', (await api.subjectPapers.list('ex1', 'su1', 'c1')).data.length === 0);
    check('exam 2 has its own independent paper', (await api.subjectPapers.list('ex2', 'su1', 'c1')).data.length === 1);

    check('listForExam returns every paper across every subject for one exam', (await api.subjectPapers.listForExam('ex2')).data.length === 1);
    check('setForSubject rejects a paper with no positive out_of', (await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [{ name: 'Paper 1', out_of: 0, ratio: 100 }])).ok === false);

    // Round 2 §5 correction: the SAME subject, SAME exam, has a completely
    // independent paper setup PER CLASS — Grade 1 sits it as a single mark
    // while Grade 8 sits it as 3 papers, and configuring one never touches
    // the other.
    const g1 = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', []);
    const g8 = await api.subjectPapers.setForSubject('ex1', 'su1', 'c8', [
      { name: 'Paper 1', out_of: 40, ratio: 40 }, { name: 'Paper 2', out_of: 30, ratio: 30 }, { name: 'Paper 3', out_of: 30, ratio: 30 }
    ]);
    check('Grade 1 saves as single-mark for this subject/exam', g1.ok === true);
    check('Grade 8 saves as 3 papers for the SAME subject/exam', g8.ok === true && g8.count === 3);
    check('Grade 1 still has zero papers — Grade 8\'s setup did not leak across', (await api.subjectPapers.list('ex1', 'su1', 'c1')).data.length === 0);
    check('Grade 8 has its own independent 3-paper setup', (await api.subjectPapers.list('ex1', 'su1', 'c8')).data.length === 3);
    check('listForExam sees both classes\' rows together (caller groups by class)', (await api.subjectPapers.listForExam('ex1')).data.length === 3);

    // Defense in depth: applying the same `papers` array (same .id's) to a
    // SECOND class must never steal/overwrite the first class's rows just
    // because the ids match something that exists for a DIFFERENT class.
    const g8Papers = (await api.subjectPapers.list('ex1', 'su1', 'c8')).data;
    const stolen = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', g8Papers.map((p) => ({ id: p.id, name: p.name, out_of: p.out_of, ratio: Math.round(p.weight * 100) })));
    check('reusing another class\'s paper ids for a different class still succeeds (treated as new rows)', stolen.ok === true);
    const g8After = await api.subjectPapers.list('ex1', 'su1', 'c8');
    check('Grade 8\'s original 3 papers are untouched by Grade 1\'s save using the same ids', g8After.data.length === 3 && g8After.data.every((p) => g8Papers.some((op) => op.id === p.id)));
    const g1After = await api.subjectPapers.list('ex1', 'su1', 'c1');
    check('Grade 1 got its OWN new rows, not a reassignment of Grade 8\'s', g1After.data.length === 3 && g1After.data.every((p) => !g8Papers.some((op) => op.id === p.id)));
  }

  // ---- subject papers: Round 5 §6 (allow editing out_of/ratio after marks
  // are uploaded, gated on publish status, and validated against
  // already-recorded marks) --------------------------------------------------
  {
    const sb = createMockSupabase({
      subjects: [{ id: 'su1', name: 'English' }],
      exams: [{ id: 'ex1', name: 'Term 1 Exam' }],
      classes: [{ id: 'c1', name: 'Grade 1' }],
      result_submissions: [],
      results: []
    });
    const api = createAcademicsApi(sb);

    const initial = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { name: 'Paper 1', out_of: 60, ratio: 60 }, { name: 'Paper 2', out_of: 40, ratio: 40 }
    ]);
    check('Round 5 §6 setup: initial 2-paper split saves', initial.ok === true);
    const papers0 = (await api.subjectPapers.list('ex1', 'su1', 'c1')).data;
    const p1 = papers0.find((p) => p.name === 'Paper 1'), p2 = papers0.find((p) => p.name === 'Paper 2');

    // No marks recorded yet and no submission row at all — free to edit.
    const freeEdit = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { id: p1.id, name: 'Paper 1', out_of: 50, ratio: 50 }, { id: p2.id, name: 'Paper 2', out_of: 50, ratio: 50 }
    ]);
    check('Round 5 §6: editing out_of/ratio with no marks and no submission row succeeds', freeEdit.ok === true);

    // A mark gets recorded against Paper 1 (score 45, within its out_of of 50).
    sb._tables.results.push({ id: 'r1', exam_id: 'ex1', subject_id: 'su1', class_id: 'c1', paper_id: p1.id, student_id: 's1', score: 45 });

    // Submission status is 'draft' (not published yet) — editing is still allowed, even with marks already entered.
    sb._tables.result_submissions.push({ id: 'sub1', exam_id: 'ex1', class_id: 'c1', subject_id: 'su1', status: 'draft' });
    const draftEdit = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { id: p1.id, name: 'Paper 1', out_of: 55, ratio: 50 }, { id: p2.id, name: 'Paper 2', out_of: 50, ratio: 50 }
    ]);
    check('Round 5 §6: editing while unpublished (draft) succeeds even with marks already entered', draftEdit.ok === true);

    // Once published, paper setup is locked — must unpublish first.
    sb._tables.result_submissions.find((r) => r.id === 'sub1').status = 'published';
    const blockedByPublish = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { id: p1.id, name: 'Paper 1', out_of: 55, ratio: 50 }, { id: p2.id, name: 'Paper 2', out_of: 50, ratio: 50 }
    ]);
    check('Round 5 §6: editing paper setup is blocked once results are published', blockedByPublish.ok === false && /published/i.test(blockedByPublish.message));

    // Unpublish (back to draft) so the remaining marks-safety scenarios can be exercised.
    sb._tables.result_submissions.find((r) => r.id === 'sub1').status = 'draft';

    // Shrinking a paper's out_of below an already-recorded mark must be rejected with a clear reason.
    const shrinkBlocked = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { id: p1.id, name: 'Paper 1', out_of: 40, ratio: 50 }, { id: p2.id, name: 'Paper 2', out_of: 50, ratio: 50 }
    ]);
    check('Round 5 §6: shrinking a paper\'s out_of below an already-recorded mark is rejected', shrinkBlocked.ok === false && /out of/i.test(shrinkBlocked.message));
    check('the rejected shrink did not change anything', (await api.subjectPapers.list('ex1', 'su1', 'c1')).data.find((p) => p.name === 'Paper 1').out_of === 55);

    // Removing a paper that already has marks recorded must be rejected too.
    const removeBlocked = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { id: p2.id, name: 'Paper 2', out_of: 100, ratio: 100 }
    ]);
    check('Round 5 §6: removing a paper that already has marks recorded is rejected', removeBlocked.ok === false && /already has marks recorded/i.test(removeBlocked.message));
    check('the rejected removal left both papers in place', (await api.subjectPapers.list('ex1', 'su1', 'c1')).data.length === 2);

    // A non-conflicting edit (raising out_of, re-splitting ratio) still succeeds with marks already present.
    const okEdit = await api.subjectPapers.setForSubject('ex1', 'su1', 'c1', [
      { id: p1.id, name: 'Paper 1', out_of: 70, ratio: 60 }, { id: p2.id, name: 'Paper 2', out_of: 30, ratio: 40 }
    ]);
    check('Round 5 §6: a non-conflicting edit (raising out_of) succeeds even with marks already entered', okEdit.ok === true);
    check('the accepted edit actually applied', (await api.subjectPapers.list('ex1', 'su1', 'c1')).data.find((p) => p.name === 'Paper 1').out_of === 70);
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

  // ---- subject combinations (Round 2 §3 — the opposite of Learning Area Papers) ----
  {
    const sb = createMockSupabase({
      subjects: [{ id: 'su1', name: 'Social Studies' }, { id: 'su2', name: 'CRE' }, { id: 'su3', name: 'Mathematics' }],
      exams: [{ id: 'ex1', name: 'Term 1 Exam' }],
      subject_combinations: [],
      subject_combination_members: []
    });
    const api = createAcademicsApi(sb);

    const noExam = await api.subjectCombinations.setCombination(null, { name: 'X', members: [{ subject_id: 'su1', ratio: 50 }, { subject_id: 'su2', ratio: 50 }] });
    check('setCombination requires an exam', noExam.ok === false);

    const noName = await api.subjectCombinations.setCombination('ex1', { members: [{ subject_id: 'su1', ratio: 50 }, { subject_id: 'su2', ratio: 50 }] });
    check('setCombination requires a name', noName.ok === false);

    const tooFew = await api.subjectCombinations.setCombination('ex1', { name: 'Just one', members: [{ subject_id: 'su1', ratio: 100 }] });
    check('setCombination refuses a combination with fewer than 2 subjects', tooFew.ok === false && /at least 2/i.test(tooFew.message));

    const badRatio = await api.subjectCombinations.setCombination('ex1', { name: 'SST/CRE', members: [{ subject_id: 'su1', ratio: 60 }, { subject_id: 'su2', ratio: 30 }] });
    check('setCombination rejects ratios that do not sum to 100%', badRatio.ok === false && /100%/.test(badRatio.message));

    const saved = await api.subjectCombinations.setCombination('ex1', { name: 'SST/CRE Combined', members: [{ subject_id: 'su1', ratio: 60 }, { subject_id: 'su2', ratio: 40 }] });
    check('setCombination saves a valid 2-subject combination', saved.ok === true && !!saved.id);

    const listed = await api.subjectCombinations.listForExam('ex1');
    check('listForExam returns the combination with its members nested', listed.data.length === 1 && listed.data[0].members.length === 2);
    check('member weights are converted from the 0-100 ratio', listed.data[0].members.find((m) => m.subject_id === 'su1').weight === 0.6);

    // A subject already used by this combo cannot ALSO be used by a different one.
    const clash = await api.subjectCombinations.setCombination('ex1', { name: 'Math/SST', members: [{ subject_id: 'su1', ratio: 50 }, { subject_id: 'su3', ratio: 50 }] });
    check('setCombination refuses to double-claim a subject already in another combination', clash.ok === false && /already part of/i.test(clash.message));

    // Editing the SAME combination (passing its own id) is allowed to keep its own members.
    const editSame = await api.subjectCombinations.setCombination('ex1', { id: listed.data[0].id, name: 'SST/CRE Combined (renamed)', members: [{ subject_id: 'su1', ratio: 70 }, { subject_id: 'su2', ratio: 30 }] });
    check('editing a combination can keep its own existing members without a false clash', editSame.ok === true);
    const afterEdit = await api.subjectCombinations.listForExam('ex1');
    check('the edit actually changed the name and ratios', afterEdit.data[0].name === 'SST/CRE Combined (renamed)' && afterEdit.data[0].members.find((m) => m.subject_id === 'su1').weight === 0.7);

    // Now that su1/su2 are free again (after deleting), a new combo using them succeeds.
    const del = await api.subjectCombinations.remove(afterEdit.data[0].id);
    check('remove() deletes the combination', del.ok === true);
    check('listForExam is empty after deletion', (await api.subjectCombinations.listForExam('ex1')).data.length === 0);
    const reuse = await api.subjectCombinations.setCombination('ex1', { name: 'Math/SST', members: [{ subject_id: 'su1', ratio: 50 }, { subject_id: 'su3', ratio: 50 }] });
    check('subjects freed up by deleting a combination can be reused in a new one', reuse.ok === true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
