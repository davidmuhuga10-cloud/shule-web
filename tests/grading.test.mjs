import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createGradingApi } from '../src/lib/api/grading.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  {
    const sb = createMockSupabase({});
    const api = createGradingApi(sb);
    const first = await api.saveScale({ name: 'Default Scale' });
    check('the first scale created is automatically the default', first.data.is_default === true);
    const second = await api.saveScale({ name: 'Alternate Scale' });
    check('a subsequent scale is not automatically the default', second.data.is_default === false);

    await api.setDefaultScale(second.data.id);
    const listed = await api.listScales();
    const first_ = listed.data.find((s) => s.id === first.data.id);
    const second_ = listed.data.find((s) => s.id === second.data.id);
    check('setDefaultScale flips the default to the chosen scale', second_.is_default === true && first_.is_default === false);

    const guarded = await api.deleteScale(second.data.id);
    check('deleteScale refuses to delete the current default', guarded.ok === false);
    const allowed = await api.deleteScale(first.data.id);
    check('deleteScale allows deleting a non-default scale', allowed.ok === true);
  }

  // ---- bands --------------------------------------------------------------------
  {
    const sb = createMockSupabase({ grading_scales: [{ id: 'gs1', name: 'Default', is_default: true }] });
    const api = createGradingApi(sb);
    check('saveBand rejects a non-numeric range', (await api.saveBand({ grading_scale_id: 'gs1', min_score: 'x', max_score: 100, grade_label: 'A' })).ok === false);
    check('saveBand rejects min > max', (await api.saveBand({ grading_scale_id: 'gs1', min_score: 80, max_score: 70, grade_label: 'A' })).ok === false);
    check('saveBand requires a grade label', (await api.saveBand({ grading_scale_id: 'gs1', min_score: 0, max_score: 100 })).ok === false);

    await api.saveBand({ grading_scale_id: 'gs1', min_score: 80, max_score: 100, grade_label: 'A', points: 12 });
    await api.saveBand({ grading_scale_id: 'gs1', min_score: 0, max_score: 79, grade_label: 'B', points: 8 });
    const bands = await api.defaultScaleBands();
    check('defaultScaleBands returns the default scale\'s bands', bands.length === 2);

    check('gradeScore finds the right band for 85', api.gradeScore(85, bands).grade_label === 'A');
    check('gradeScore finds the right band for 40', api.gradeScore(40, bands).grade_label === 'B');
    check('gradeScore returns blank for an unbanded score', api.gradeScore(-5, bands).grade_label === '');

    const listed = await api.listScales();
    check('listScales returns bands sorted desc by min_score', listed.data[0].bands[0].grade_label === 'A');
  }

  // ---- CBC competency scale preset (CBC grading, no strands/rubrics) ------------
  {
    const sb = createMockSupabase({});
    const api = createGradingApi(sb);
    const first = await api.loadCbcCompetencyScale();
    check('loadCbcCompetencyScale succeeds', first.ok === true);
    check('loadCbcCompetencyScale reports it was added', first.added === true);

    const listed = await api.listScales();
    const cbc = listed.data.find((s) => s.name === 'CBC Competency Scale');
    check('the CBC scale was created', !!cbc);
    check('it becomes the default when it is the only scale', cbc.is_default === true);
    check('it has all 8 competency bands', cbc.bands.length === 8);
    check('the top band is EE1 with 8 points', cbc.bands[0].grade_label === 'EE1' && cbc.bands[0].points === 8);
    check('the bottom band is BE2 with 1 point', cbc.bands[cbc.bands.length - 1].grade_label === 'BE2' && cbc.bands[cbc.bands.length - 1].points === 1);
    check('gradeScore maps a score of 90 to EE1 on the CBC scale', api.gradeScore(90, cbc.bands).grade_label === 'EE1');
    check('gradeScore maps a score of 5 to BE2 on the CBC scale', api.gradeScore(5, cbc.bands).grade_label === 'BE2');

    const second = await api.loadCbcCompetencyScale();
    check('loading it again is a no-op, not a duplicate', second.ok === true && second.added === false);
    const listed2 = await api.listScales();
    check('no duplicate CBC scale was created', listed2.data.filter((s) => s.name === 'CBC Competency Scale').length === 1);
  }

  // ---- alongside an existing default letter-grade scale --------------------------
  {
    const sb = createMockSupabase({ grading_scales: [{ id: 'letter1', name: 'Default Grading Scale', is_default: true }] });
    const api = createGradingApi(sb);
    const res = await api.loadCbcCompetencyScale();
    check('loading the CBC scale succeeds alongside an existing scale', res.ok === true && res.added === true);
    const listed = await api.listScales();
    const letter = listed.data.find((s) => s.id === 'letter1');
    const cbc = listed.data.find((s) => s.name === 'CBC Competency Scale');
    check('the existing letter-grade scale stays the default', letter.is_default === true);
    check('the newly-loaded CBC scale is NOT auto-made default', cbc.is_default === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
