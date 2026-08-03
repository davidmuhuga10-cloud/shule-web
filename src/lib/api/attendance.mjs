/**
 * attendance.mjs — daily student + staff attendance marking, history, and a
 * simple per-class summary. RLS (see supabase/schema.sql) already scopes
 * every query to the caller's own school and, for a student/parent, to
 * their own/linked record — none of that filtering has to happen here.
 */
import { ok, err, byAdmissionNo } from './_util.mjs';

const VALID_STATUSES = ['present', 'absent', 'late', 'excused'];

export function createAttendanceApi(supabase) {
  return {
    /** Roster for the marking screen: active students in a class/stream,
     *  merged with any attendance already recorded for that date. */
    async getRosterForDate({ class_id, stream_id, date }) {
      if (!class_id || !date) return err('Choose a class and a date.');
      let q = supabase.from('students').select('id, admission_no, full_name, class_id, stream_id').eq('class_id', class_id).eq('status', 'active');
      if (stream_id) q = q.eq('stream_id', stream_id);
      const { data: students, error } = await q;
      if (error) return err(error.message);

      const { data: marks, error: marksErr } = await supabase
        .from('student_attendance').select('student_id, status, notes')
        .eq('class_id', class_id).eq('date', date);
      if (marksErr) return err(marksErr.message);
      const markMap = {}; (marks || []).forEach((m) => { markMap[m.student_id] = m; });

      const rows = (students || []).map((s) => ({
        student_id: s.id, admission_no: s.admission_no, full_name: s.full_name,
        status: markMap[s.id] ? markMap[s.id].status : '', notes: markMap[s.id] ? (markMap[s.id].notes || '') : ''
      }));
      rows.sort(byAdmissionNo);
      return ok(rows);
    },

    /** records: [{ student_id, status, notes? }] — upserts one row per
     *  student for (student_id, date), same call whether marking for the
     *  first time or correcting an earlier mark. */
    async saveStudentAttendance({ date, class_id, records, marked_by }) {
      if (!date || !class_id) return err('Missing date or class.');
      const rows = (Array.isArray(records) ? records : []).filter((r) => r.student_id && VALID_STATUSES.includes(r.status));
      if (!rows.length) return err('No valid attendance marks to save.');
      const payload = rows.map((r) => ({
        student_id: r.student_id, class_id, date, status: r.status,
        notes: r.notes || null, marked_by: marked_by || null
      }));
      const { error } = await supabase.from('student_attendance').upsert(payload, { onConflict: 'student_id,date' });
      if (error) return err(error.message);
      return ok(null, { saved: payload.length });
    },

    async studentHistory({ student_id, from, to }) {
      if (!student_id) return err('Missing student.');
      let q = supabase.from('student_attendance').select('date, status, notes').eq('student_id', student_id).order('date', { ascending: false });
      if (from) q = q.gte('date', from);
      if (to) q = q.lte('date', to);
      const { data, error } = await q;
      if (error) return err(error.message);
      return ok(data || []);
    },

    /** Per-student attendance-rate summary for a class over a date range —
     *  the "simple report" the roadmap called for, without a full
     *  attendance-vs-exam-performance correlation view (deferred). */
    async classSummary({ class_id, from, to }) {
      if (!class_id) return err('Choose a class.');
      const [{ data: students, error: sErr }, { data: marks, error: mErr }] = await Promise.all([
        supabase.from('students').select('id, admission_no, full_name').eq('class_id', class_id).eq('status', 'active'),
        (() => {
          let q = supabase.from('student_attendance').select('student_id, status, date').eq('class_id', class_id);
          if (from) q = q.gte('date', from);
          if (to) q = q.lte('date', to);
          return q;
        })()
      ]);
      if (sErr) return err(sErr.message);
      if (mErr) return err(mErr.message);

      const byStudent = {};
      (students || []).forEach((s) => { byStudent[s.id] = { student_id: s.id, admission_no: s.admission_no, full_name: s.full_name, present: 0, absent: 0, late: 0, excused: 0, total: 0 }; });
      (marks || []).forEach((m) => {
        const row = byStudent[m.student_id];
        if (!row) return;
        row.total++;
        if (row[m.status] !== undefined) row[m.status]++;
      });
      const rows = Object.values(byStudent).map((r) => ({ ...r, rate: r.total ? Math.round((r.present / r.total) * 100) : null }));
      rows.sort(byAdmissionNo);
      return ok(rows);
    },

    async getStaffRosterForDate({ date }) {
      if (!date) return err('Choose a date.');
      const { data: staffList, error } = await supabase.from('staff').select('id, full_name, role').eq('status', 'active').order('full_name');
      if (error) return err(error.message);
      const { data: marks, error: mErr } = await supabase.from('staff_attendance').select('staff_id, status, notes').eq('date', date);
      if (mErr) return err(mErr.message);
      const markMap = {}; (marks || []).forEach((m) => { markMap[m.staff_id] = m; });
      return ok((staffList || []).map((s) => ({
        staff_id: s.id, full_name: s.full_name, role: s.role,
        status: markMap[s.id] ? markMap[s.id].status : '', notes: markMap[s.id] ? (markMap[s.id].notes || '') : ''
      })));
    },

    async saveStaffAttendance({ date, records, marked_by }) {
      if (!date) return err('Missing date.');
      const rows = (Array.isArray(records) ? records : []).filter((r) => r.staff_id && VALID_STATUSES.includes(r.status));
      if (!rows.length) return err('No valid attendance marks to save.');
      const payload = rows.map((r) => ({ staff_id: r.staff_id, date, status: r.status, notes: r.notes || null, marked_by: marked_by || null }));
      const { error } = await supabase.from('staff_attendance').upsert(payload, { onConflict: 'staff_id,date' });
      if (error) return err(error.message);
      return ok(null, { saved: payload.length });
    }
  };
}
