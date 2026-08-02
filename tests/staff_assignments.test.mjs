import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createStaffApi } from '../src/lib/api/staff.mjs';
import { createAssignmentsApi } from '../src/lib/api/assignments.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- staff ------------------------------------------------------------------
  {
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    check('save rejects missing name', (await api.save({ email: 'a@b.com' })).ok === false);
    check('save rejects missing email', (await api.save({ full_name: 'Mr Teacher' })).ok === false);
    const created = await api.save({ full_name: 'Mr Teacher', email: 'Teacher@Test.School' });
    check('save succeeds and lowercases the email', created.ok === true && created.data.email === 'teacher@test.school');
  }
  {
    const sb = createMockSupabase({ staff: [{ id: 'st1', full_name: 'Existing', email: 'existing@test.school' }] });
    const api = createStaffApi(sb);
    const dup = await api.save({ full_name: 'Someone Else', email: 'existing@test.school' });
    check('save rejects a duplicate email', dup.ok === false);
    const selfEdit = await api.save({ id: 'st1', full_name: 'Existing Renamed', email: 'existing@test.school' });
    check('save allows re-saving the same staff member with their own email', selfEdit.ok === true);
  }

  // ---- setClassSubjects (with stream-inheritance reporting) --------------------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      streams: [{ id: 'str1', class_id: 'c1', name: 'North' }, { id: 'str2', class_id: 'c1', name: 'South' }],
      subjects: [{ id: 'su1', name: 'Mathematics' }, { id: 'su2', name: 'English' }, { id: 'su3', name: 'Kiswahili' }]
    });
    const api = createAssignmentsApi(sb);
    const res = await api.setClassSubjects('c1', ['su1', 'su2']);
    check('setClassSubjects succeeds', res.ok === true);
    check('setClassSubjects reports the class name', res.className === 'Grade 7');
    check('setClassSubjects reports how many streams inherit', res.streamCount === 2);
    check('setClassSubjects reports the subject count', res.count === 2);

    const got = await api.getClassSubjects('c1');
    check('getClassSubjects reflects the saved subjects', got.data.length === 2);

    // Replace the set: drop su1, add su3 -> only su2 and su3 remain.
    await api.setClassSubjects('c1', ['su2', 'su3']);
    const got2 = await api.getClassSubjects('c1');
    const ids = got2.data.map((r) => r.subject_id).sort();
    check('setClassSubjects replaces the full set (adds new, removes unchecked)', JSON.stringify(ids) === JSON.stringify(['su2', 'su3'].sort()));
  }

  // ---- teacher assignments ------------------------------------------------------
  {
    const sb = createMockSupabase({
      staff: [{ id: 'stf1', full_name: 'Mr Teacher' }],
      subjects: [{ id: 'su1', name: 'Mathematics' }],
      classes: [{ id: 'c1', name: 'Grade 7' }]
    });
    const api = createAssignmentsApi(sb);
    check('saveTeacherAssignment requires a teacher', (await api.saveTeacherAssignment({ subject_id: 'su1', class_id: 'c1' })).ok === false);
    const saved = await api.saveTeacherAssignment({ staff_id: 'stf1', subject_id: 'su1', class_id: 'c1' });
    check('saveTeacherAssignment succeeds', saved.ok === true);
    const dup = await api.saveTeacherAssignment({ staff_id: 'stf1', subject_id: 'su1', class_id: 'c1' });
    check('saveTeacherAssignment rejects an exact duplicate (same subject/class/stream/teacher)', dup.ok === false);

    const listed = await api.listTeacherAssignments({});
    check('listTeacherAssignments joins readable names', listed.data[0].staff_name === 'Mr Teacher' && listed.data[0].subject_name === 'Mathematics');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
