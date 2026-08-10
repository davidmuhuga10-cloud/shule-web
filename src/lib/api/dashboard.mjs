/**
 * dashboard.mjs — Supabase equivalent of Dashboard.gs's getDashboard/getActiveContext_.
 * (Settings live in settings.mjs; user/login management lives in users.mjs.)
 */
import { ok } from './_util.mjs';

export function createDashboardApi(supabase) {
  async function getActiveContext() {
    const [{ data: year }, { data: term }] = await Promise.all([
      supabase.from('academic_years').select('id, name').eq('status', 'active').maybeSingle(),
      supabase.from('terms').select('id, name').eq('status', 'active').maybeSingle()
    ]);
    return {
      academic_year_id: year ? year.id : '',
      academic_year_name: year ? year.name : '',
      term_id: term ? term.id : '',
      term_name: term ? term.name : ''
    };
  }

  return {
    getActiveContext,
    // Perf: this used to be ~6 sequential network "waves" — a Promise.all,
    // then an awaited students query, then an awaited classes query, then
    // getActiveContext() (its own Promise.all), then TWO MORE sequential
    // awaited count queries inside the checklist array literal. Each wave is
    // a full round trip, so dashboard load time was roughly 6x one query's
    // latency. Every one of these queries is actually independent, so they
    // now all fire together in ONE Promise.all — one round trip (modulo
    // connection multiplexing), not six. The gender/per-class breakdown also
    // no longer needs its own students query — it reuses the same students
    // rows already fetched for the count.
    async get() {
      const [
        { data: students }, { data: staffAll }, { data: classes },
        { count: streamCount }, { count: subjectCount }, { count: examCount },
        { data: settingsRows }, { data: yearRow }, { data: termRow },
        { count: yearCount }, { count: termCount }
      ] = await Promise.all([
        supabase.from('students').select('id, gender, class_id').eq('status', 'active'),
        supabase.from('staff').select('status, role'),
        supabase.from('classes').select('id, name'),
        supabase.from('streams').select('id', { count: 'exact', head: true }),
        supabase.from('subjects').select('id', { count: 'exact', head: true }),
        supabase.from('exams').select('id', { count: 'exact', head: true }),
        supabase.from('settings').select('key, value'),
        supabase.from('academic_years').select('id, name').eq('status', 'active').maybeSingle(),
        supabase.from('terms').select('id, name').eq('status', 'active').maybeSingle(),
        supabase.from('academic_years').select('id', { count: 'exact', head: true }),
        supabase.from('terms').select('id', { count: 'exact', head: true })
      ]);

      const studentCount = (students || []).length;
      const classCount = (classes || []).length;
      const staffActive = (staffAll || []).filter((s) => s.status !== 'inactive').length;
      // Teachers count (Phase 2f, brief §3/§2): staff.role is a free-text column
      // (default 'teacher', no enum) — treat a blank/missing role as 'teacher' too,
      // since that's the save()-time default in staff.mjs.
      const teacherCount = (staffAll || []).filter((s) => s.status !== 'inactive' && String(s.role || 'teacher').toLowerCase() === 'teacher').length;

      const settingsMap = {};
      (settingsRows || []).forEach((r) => { settingsMap[r.key] = r.value; });
      const smsBalance = (settingsMap.sms_credit_balance === undefined || settingsMap.sms_credit_balance === null || settingsMap.sms_credit_balance === '')
        ? null : settingsMap.sms_credit_balance;

      const gender = { M: 0, F: 0 };
      (students || []).forEach((s) => {
        const g = String(s.gender || '').toUpperCase();
        if (g === 'MALE' || g === 'M') gender.M++;
        else if (g === 'FEMALE' || g === 'F') gender.F++;
      });

      const perClass = (classes || []).map((c) => ({
        name: c.name,
        count: (students || []).filter((s) => String(s.class_id) === String(c.id)).length
      })).sort((a, b) => b.count - a.count);

      const active = {
        academic_year_id: yearRow ? yearRow.id : '',
        academic_year_name: yearRow ? yearRow.name : '',
        term_id: termRow ? termRow.id : '',
        term_name: termRow ? termRow.name : ''
      };

      const checklist = [
        { key: 'academic_year', label: 'Create an academic year', done: (yearCount || 0) > 0, route: '#/settings' },
        { key: 'term', label: 'Add terms to the academic year', done: (termCount || 0) > 0, route: '#/settings' },
        { key: 'classes', label: 'Set up classes', done: classCount > 0, route: '#/classes' },
        { key: 'streams', label: 'Add arms to classes', done: (streamCount || 0) > 0, route: '#/classes' },
        { key: 'subjects', label: 'Assign subjects to an arm', done: (subjectCount || 0) > 0, route: '#/classes' },
        { key: 'students', label: 'Enroll students', done: studentCount > 0, route: '#/students' },
        { key: 'staff', label: 'Add teachers / staff', done: staffActive > 0, route: '#/staff-teachers' }
      ];

      return ok(null, {
        counts: { students: studentCount || 0, staff: staffActive, teachers: teacherCount, classes: classCount || 0, streams: streamCount || 0, subjects: subjectCount || 0, exams: examCount || 0 },
        smsBalance,
        gender,
        perClass,
        active,
        checklist,
        setupComplete: checklist.every((c) => c.done)
      });
    }
  };
}
