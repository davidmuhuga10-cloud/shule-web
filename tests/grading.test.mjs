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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
