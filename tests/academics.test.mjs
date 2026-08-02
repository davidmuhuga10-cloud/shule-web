import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createAcademicsApi, CBC_SUBJECTS } from '../src/lib/api/academics.mjs';

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
    const dup = await api.classes.save({ name: 'Grade 7' });
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
