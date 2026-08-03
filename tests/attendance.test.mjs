import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createAttendanceApi } from '../src/lib/api/attendance.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- getRosterForDate: merges active students with any existing marks ------
  {
    const sb = createMockSupabase({
      students: [
        { id: 's1', admission_no: '5', full_name: 'Amos', class_id: 'c1', status: 'active' },
        { id: 's2', admission_no: '23', full_name: 'Jane', class_id: 'c1', status: 'active' },
        { id: 's3', admission_no: '1', full_name: 'Inactive Kid', class_id: 'c1', status: 'inactive' }
      ],
      student_attendance: [{ id: 'a1', student_id: 's1', class_id: 'c1', date: '2026-08-01', status: 'present', notes: '' }]
    });
    const api = createAttendanceApi(sb);
    const res = await api.getRosterForDate({ class_id: 'c1', date: '2026-08-01' });
    check('getRosterForDate succeeds', res.ok === true);
    check('getRosterForDate excludes inactive students', res.data.length === 2);
    check('getRosterForDate sorts by admission number', res.data.map((r) => r.admission_no).join(',') === '5,23');
    check('getRosterForDate merges an existing mark', res.data.find((r) => r.student_id === 's1').status === 'present');
    check('getRosterForDate leaves unmarked students blank', res.data.find((r) => r.student_id === 's2').status === '');
  }
  {
    const sb = createMockSupabase({});
    const api = createAttendanceApi(sb);
    check('getRosterForDate requires a class and date', (await api.getRosterForDate({})).ok === false);
  }

  // ---- saveStudentAttendance: upsert + validation -----------------------------
  {
    const sb = createMockSupabase({});
    const api = createAttendanceApi(sb);
    const res = await api.saveStudentAttendance({
      date: '2026-08-01', class_id: 'c1', marked_by: 'staff-1',
      records: [{ student_id: 's1', status: 'present' }, { student_id: 's2', status: 'bogus' }]
    });
    check('saveStudentAttendance filters out invalid statuses', res.ok === true && res.saved === 1);
    check('saveStudentAttendance actually wrote the row', sb._tables.student_attendance.length === 1);
  }
  {
    const sb = createMockSupabase({
      student_attendance: [{ id: 'a1', student_id: 's1', date: '2026-08-01', class_id: 'c1', status: 'absent' }]
    });
    const api = createAttendanceApi(sb);
    const res = await api.saveStudentAttendance({
      date: '2026-08-01', class_id: 'c1', records: [{ student_id: 's1', status: 'present' }]
    });
    check('saveStudentAttendance upserts (corrects) an existing mark rather than duplicating', res.ok === true);
    check('re-marking the same student/date updates in place, not a second row', sb._tables.student_attendance.length === 1);
    check('the corrected status was actually applied', sb._tables.student_attendance[0].status === 'present');
  }
  {
    const sb = createMockSupabase({});
    const api = createAttendanceApi(sb);
    check('saveStudentAttendance requires date and class', (await api.saveStudentAttendance({ records: [] })).ok === false);
    check('saveStudentAttendance rejects an empty record set', (await api.saveStudentAttendance({ date: '2026-08-01', class_id: 'c1', records: [] })).ok === false);
  }

  // ---- studentHistory: date-range filtering -----------------------------------
  {
    const sb = createMockSupabase({
      student_attendance: [
        { id: 'a1', student_id: 's1', date: '2026-07-01', status: 'present' },
        { id: 'a2', student_id: 's1', date: '2026-07-15', status: 'absent' },
        { id: 'a3', student_id: 's1', date: '2026-08-05', status: 'present' },
        { id: 'a4', student_id: 's2', date: '2026-07-15', status: 'present' }
      ]
    });
    const api = createAttendanceApi(sb);
    const res = await api.studentHistory({ student_id: 's1', from: '2026-07-01', to: '2026-07-31' });
    check('studentHistory scopes to the requested student', res.data.every((r) => true) && res.data.length === 2);
    check('studentHistory respects the date range (excludes the August row)', !res.data.some((r) => r.date === '2026-08-05'));
  }

  // ---- classSummary: per-student rates -----------------------------------------
  {
    const sb = createMockSupabase({
      students: [
        { id: 's1', admission_no: '5', full_name: 'Amos', class_id: 'c1', status: 'active' },
        { id: 's2', admission_no: '23', full_name: 'Jane', class_id: 'c1', status: 'active' }
      ],
      student_attendance: [
        { id: 'a1', student_id: 's1', class_id: 'c1', date: '2026-07-01', status: 'present' },
        { id: 'a2', student_id: 's1', class_id: 'c1', date: '2026-07-02', status: 'present' },
        { id: 'a3', student_id: 's1', class_id: 'c1', date: '2026-07-03', status: 'absent' },
        { id: 'a4', student_id: 's1', class_id: 'c1', date: '2026-07-04', status: 'present' }
      ]
    });
    const api = createAttendanceApi(sb);
    const res = await api.classSummary({ class_id: 'c1' });
    check('classSummary succeeds', res.ok === true);
    const amos = res.data.find((r) => r.student_id === 's1');
    check('classSummary counts present/absent correctly', amos.present === 3 && amos.absent === 1);
    check('classSummary computes a rounded attendance rate', amos.rate === 75);
    const jane = res.data.find((r) => r.student_id === 's2');
    check('classSummary reports null rate for a student with zero marks', jane.rate === null);
  }

  // ---- staff attendance mirrors student attendance ----------------------------
  {
    const sb = createMockSupabase({
      staff: [{ id: 'st1', full_name: 'Mr Teacher', role: 'teacher', status: 'active' }]
    });
    const api = createAttendanceApi(sb);
    const rosterRes = await api.getStaffRosterForDate({ date: '2026-08-01' });
    check('getStaffRosterForDate returns active staff', rosterRes.ok === true && rosterRes.data.length === 1);

    const saveRes = await api.saveStaffAttendance({ date: '2026-08-01', records: [{ staff_id: 'st1', status: 'present' }] });
    check('saveStaffAttendance saves a valid record', saveRes.ok === true && saveRes.saved === 1);
    check('saveStaffAttendance wrote to staff_attendance, not student_attendance', sb._tables.staff_attendance.length === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
