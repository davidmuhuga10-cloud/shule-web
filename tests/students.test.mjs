import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createStudentsApi } from '../src/lib/api/students.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- list + numeric sort ---------------------------------------------------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      students: [
        { id: 's1', admission_no: '23', full_name: 'Jane', gender: 'Female', class_id: 'c1', status: 'active' },
        { id: 's2', admission_no: '5', full_name: 'Amos', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's3', admission_no: '100', full_name: 'Zed', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's4', admission_no: '1', full_name: 'Inactive Kid', gender: 'Male', class_id: 'c1', status: 'inactive' }
      ]
    });
    const api = createStudentsApi(sb);
    const res = await api.list({ class_id: 'c1' });
    check('list() only returns active students by default', res.data.length === 3);
    check('list() sorts numerically (5, 23, 100), not alphabetically', res.data.map((s) => s.admission_no).join(',') === '5,23,100');
    check('list() joins class_name', res.data[0].class_name === 'Grade 7');
  }

  // ---- save validation --------------------------------------------------------
  {
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7' }] });
    const api = createStudentsApi(sb);
    check('save rejects missing admission number', (await api.save({ full_name: 'X', gender: 'Male', class_id: 'c1' })).ok === false);
    check('save rejects missing name', (await api.save({ admission_no: '1', gender: 'Male', class_id: 'c1' })).ok === false);
    check('save rejects an invalid gender', (await api.save({ admission_no: '1', full_name: 'X', gender: 'Other', class_id: 'c1' })).ok === false);
    check('save rejects a missing class', (await api.save({ admission_no: '1', full_name: 'X', gender: 'Male' })).ok === false);
    const good = await api.save({ admission_no: '1', full_name: 'Amos', gender: 'Male', class_id: 'c1' });
    check('save accepts a valid student', good.ok === true);
  }
  {
    const sb = createMockSupabase({ students: [{ id: 's1', admission_no: '23', full_name: 'Jane', gender: 'Female', class_id: 'c1' }] });
    const api = createStudentsApi(sb);
    const dup = await api.save({ admission_no: '23', full_name: 'Someone Else', gender: 'Male', class_id: 'c1' });
    check('save rejects a duplicate admission number', dup.ok === false);
    // Editing the SAME student with their own admission number must be allowed.
    const selfEdit = await api.save({ id: 's1', admission_no: '23', full_name: 'Jane Updated', gender: 'Female', class_id: 'c1' });
    check('save allows re-saving the same student with their own admission number', selfEdit.ok === true);
  }

  // ---- bulkCreate --------------------------------------------------------------
  {
    const sb = createMockSupabase({ students: [{ id: 's1', admission_no: '10', full_name: 'Existing Kid' }] });
    const api = createStudentsApi(sb);
    const res = await api.bulkCreate({
      class_id: 'c1',
      rows: [
        { admission_no: '11', full_name: 'New Kid A', gender: 'Male' },
        { admission_no: '12', full_name: 'New Kid B', gender: 'Female' },
        { admission_no: '10', full_name: 'Clashes With Existing', gender: 'Male' }, // dup vs existing
        { admission_no: '13', full_name: '', gender: 'Male' }, // missing name
        { admission_no: '', full_name: 'No Admission No', gender: 'Male' }, // missing admission no
        { admission_no: '14', full_name: 'Bad Gender', gender: 'Other' }, // bad gender
        { admission_no: '11', full_name: 'Duplicate In File', gender: 'Male' } // dup within the same batch
      ]
    });
    check('bulkCreate succeeds', res.ok === true);
    check('bulkCreate creates exactly the 2 valid, non-duplicate rows', res.created === 2);
    check('bulkCreate reports 5 skipped rows with reasons', res.skipped.length === 5);
    check('bulkCreate reports the correct total', res.total === 7);
    const listed = await api.list({ class_id: 'c1' });
    check('bulkCreate actually inserted the accepted rows', listed.data.some((s) => s.admission_no === '11') && listed.data.some((s) => s.admission_no === '12'));
    check('bulkCreate returns the created rows (with ids) for login provisioning', res.createdRows.length === 2 && res.createdRows.every((r) => r.id));
  }
  {
    const sb = createMockSupabase({});
    const api = createStudentsApi(sb);
    const res = await api.bulkCreate({ rows: [{ admission_no: '1', full_name: 'X', gender: 'Male' }] });
    check('bulkCreate requires a class to be chosen', res.ok === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
