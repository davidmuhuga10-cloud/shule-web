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
    async get() {
      const [
        { count: studentCount }, { data: staffAll }, { count: classCount },
        { count: streamCount }, { count: subjectCount }, { count: examCount },
        { data: settingsRows }
      ] = await Promise.all([
        supabase.from('students').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('staff').select('status, role'),
        supabase.from('classes').select('id', { count: 'exact', head: true }),
        supabase.from('streams').select('id', { count: 'exact', head: true }),
        supabase.from('subjects').select('id', { count: 'exact', head: true }),
        supabase.from('exams').select('id', { count: 'exact', head: true }),
        supabase.from('settings').select('key, value')
      ]);
      const staffActive = (staffAll || []).filter((s) => s.status !== 'inactive').length;
      // Teachers count (Phase 2f, brief §3/§2): staff.role is a free-text column
      // (default 'teacher', no enum) — treat a blank/missing role as 'teacher' too,
      // since that's the save()-time default in staff.mjs.
      const teacherCount = (staffAll || []).filter((s) => s.status !== 'inactive' && String(s.role || 'teacher').toLowerCase() === 'teacher').length;

      const settingsMap = {};
      (settingsRows || []).forEach((r) => { settingsMap[r.key] = r.value; });
      const smsBalance = (settingsMap.sms_credit_balance === undefined || settingsMap.sms_credit_balance === null || settingsMap.sms_credit_balance === '')
        ? null : settingsMap.sms_credit_balance;

      const { data: students } = await supabase.from('students').select('gender, class_id').eq('status', 'active');
      const gender = { M: 0, F: 0 };
      (students || []).forEach((s) => {
        const g = String(s.gender || '').toUpperCase();
        if (g === 'MALE' || g === 'M') gender.M++;
        else if (g === 'FEMALE' || g === 'F') gender.F++;
      });

      const { data: classes } = await supabase.from('classes').select('id, name');
      const perClass = (classes || []).map((c) => ({
        name: c.name,
        count: (students || []).filter((s) => String(s.class_id) === String(c.id)).length
      })).sort((a, b) => b.count - a.count);

      const active = await getActiveContext();

      const checklist = [
        { key: 'academic_year', label: 'Create an academic year', done: (await supabase.from('academic_years').select('id', { count: 'exact', head: true })).count > 0, route: '#/settings' },
        { key: 'term', label: 'Add terms to the academic year', done: (await supabase.from('terms').select('id', { count: 'exact', head: true })).count > 0, route: '#/settings' },
        { key: 'classes', label: 'Set up classes', done: classCount > 0, route: '#/classes' },
        { key: 'streams', label: 'Add streams to classes', done: streamCount > 0, route: '#/classes' },
        { key: 'subjects', label: 'Assign subjects to a stream', done: subjectCount > 0, route: '#/classes' },
        { key: 'students', label: 'Enroll students', done: studentCount > 0, route: '#/students' },
        { key: 'staff', label: 'Add teachers / staff', done: staffActive > 0, route: '#/staff' }
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
