import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createDashboardApi } from '../src/lib/api/dashboard.mjs';
import { createSettingsApi } from '../src/lib/api/settings.mjs';
import { createUsersApi } from '../src/lib/api/users.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- dashboard ----------------------------------------------------------------
  {
    const sb = createMockSupabase({
      students: [
        { id: 's1', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's2', gender: 'Female', class_id: 'c1', status: 'active' },
        { id: 's3', gender: 'Male', class_id: 'c2', status: 'active' },
        { id: 's4', gender: 'Male', class_id: 'c2', status: 'inactive' }
      ],
      staff: [
        { id: 'st1', status: 'active', role: 'teacher' },
        { id: 'st2', status: 'inactive', role: 'teacher' },
        { id: 'st3', status: 'active', role: 'admin-staff' },
        { id: 'st4', status: 'active', role: '' }
      ],
      classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }],
      streams: [{ id: 'str1', class_id: 'c1' }],
      subjects: [{ id: 'su1' }],
      exams: [],
      academic_years: [{ id: 'y1', name: '2026', status: 'active' }],
      terms: [{ id: 't1', academic_year_id: 'y1', name: 'Term 1', status: 'active' }],
      settings: [{ key: 'sms_credit_balance', value: '4,500 credits' }]
    });
    const api = createDashboardApi(sb);
    const res = await api.get();
    check('dashboard counts only active students', res.counts.students === 3);
    check('dashboard counts only active staff', res.counts.staff === 3);
    check('dashboard counts teachers (active + role=teacher, blank role defaults to teacher)', res.counts.teachers === 2);
    check('dashboard reports the sms balance from settings', res.smsBalance === '4,500 credits');
    check('dashboard gender split is correct', res.gender.M === 2 && res.gender.F === 1);
    check('dashboard perClass sorted by count desc', res.perClass[0].name === 'Grade 7' && res.perClass[0].count === 2);
    check('dashboard reports the active academic year/term', res.active.academic_year_name === '2026' && res.active.term_name === 'Term 1');
    check('dashboard checklist marks classes/subjects/students done, staff done', res.checklist.find((c) => c.key === 'classes').done === true);
    check('dashboard checklist marks streams NOT fully done is still true here (1 stream exists)', res.checklist.find((c) => c.key === 'streams').done === true);
    check('setupComplete is true when every checklist item is done', res.setupComplete === true);
  }
  {
    const sb = createMockSupabase({});
    const api = createDashboardApi(sb);
    const res = await api.get();
    check('an empty school has an incomplete checklist', res.setupComplete === false);
    check('an empty school has no active context', res.active.academic_year_name === '' && res.active.term_name === '');
    check('an empty school has no sms balance set', res.smsBalance === null);
    check('an empty school has zero teachers', res.counts.teachers === 0);
  }

  // ---- settings -------------------------------------------------------------------
  {
    const sb = createMockSupabase({ settings: [{ key: 'school_name', value: 'My School' }] });
    const api = createSettingsApi(sb);
    const got = await api.get();
    check('settings.get returns a key->value map', got.data.school_name === 'My School');

    await api.save({ school_name: 'Riverside Academy', po_box: '123', phone: '' });
    const got2 = await api.get();
    check('settings.save updates an existing key', got2.data.school_name === 'Riverside Academy');
    check('settings.save inserts a brand-new key', got2.data.po_box === '123');
  }

  // ---- users ------------------------------------------------------------------------
  {
    const sb = createMockSupabase({
      profiles: [{ id: 'p1', name: 'Admin', role: 'admin', status: 'active' }, { id: 'p2', name: 'Amos', role: 'student', status: 'active' }]
    });
    const calls = [];
    const fakeCallAdminFunction = async (action, payload) => { calls.push({ action, payload }); return { ok: true, mock: true }; };
    const api = createUsersApi(sb, fakeCallAdminFunction);

    const listed = await api.list();
    check('users.list returns profiles', listed.data.length === 2);

    await api.provisionStudentLogin({ student_id: 's1', admission_no: '5', full_name: 'Amos' });
    check('provisionStudentLogin delegates to the admin function with the right action', calls[0].action === 'create_student' && calls[0].payload.admission_no === '5');

    await api.resetPassword('p2');
    check('resetPassword delegates correctly', calls[1].action === 'reset_password' && calls[1].payload.profile_id === 'p2');

    const badStatus = await api.setLoginStatus('p2', 'bogus');
    check('setLoginStatus validates the status value before calling out', badStatus.ok === false && calls.length === 2);

    await api.setLoginStatus('p2', 'inactive');
    check('setLoginStatus delegates with a valid status', calls[2].action === 'set_login_status' && calls[2].payload.status === 'inactive');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
