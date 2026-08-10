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

  // ---- Round 3 §19: staff sign-in / sign-out --------------------------------------
  {
    const sb = createMockSupabase({
      staff: [{ id: 'st1', full_name: 'Mr Teacher', role: 'teacher', status: 'active' }]
    });
    const api = createAttendanceApi(sb);

    const empty = await api.saveStaffSignInOut({ date: '2026-08-01', records: [] });
    check('saveStaffSignInOut rejects an empty record list', empty.ok === false);

    const nothingToSave = await api.saveStaffSignInOut({ date: '2026-08-01', records: [{ staff_id: 'st1' }] });
    check('saveStaffSignInOut skips a staff member with neither time given', nothingToSave.ok === false);

    const saved = await api.saveStaffSignInOut({ date: '2026-08-01', records: [{ staff_id: 'st1', sign_in_time: '08:10', sign_out_time: '16:05' }] });
    check('saveStaffSignInOut saves sign-in/out times', saved.ok === true && saved.saved === 1);

    const roster = await api.getStaffRosterForDate({ date: '2026-08-01' });
    const row = roster.data.find((r) => r.staff_id === 'st1');
    check('getStaffRosterForDate returns the saved sign-in time', row.sign_in_time === '08:10');
    check('getStaffRosterForDate returns the saved sign-out time', row.sign_out_time === '16:05');

    // The screen re-sends BOTH fields every save, pre-filled from whatever
    // was last loaded (see saveStaffSignInOut's doc comment — PostgREST's
    // bulk upsert requires a consistent key set across the whole batch, so
    // the caller carries an untouched field forward rather than omitting
    // it) — correcting just the sign-in time still includes the
    // already-known sign-out time and doesn't lose it.
    await api.saveStaffSignInOut({ date: '2026-08-01', records: [{ staff_id: 'st1', sign_in_time: '08:20', sign_out_time: '16:05' }] });
    const rosterAfter = await api.getStaffRosterForDate({ date: '2026-08-01' });
    const rowAfter = rosterAfter.data.find((r) => r.staff_id === 'st1');
    check('saveStaffSignInOut updates sign-in while the caller carries the sign-out value forward unchanged', rowAfter.sign_in_time === '08:20' && rowAfter.sign_out_time === '16:05');
  }
  {
    // A staff member with no attendance row yet for this date should show
    // blank times, not crash or show undefined.
    const sb = createMockSupabase({ staff: [{ id: 'st1', full_name: 'New Teacher', role: 'teacher', status: 'active' }] });
    const api = createAttendanceApi(sb);
    const roster = await api.getStaffRosterForDate({ date: '2026-08-02' });
    check('a staff member with no attendance row yet shows blank sign-in/out, not undefined', roster.data[0].sign_in_time === '' && roster.data[0].sign_out_time === '');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
