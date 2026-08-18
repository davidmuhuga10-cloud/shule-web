/**
 * attendance.mjs — daily student + staff attendance marking, history, and a
 * simple per-class summary. RLS (see supabase/schema.sql) already scopes
 * every query to the caller's own school and, for a student/parent, to
 * their own/linked record — none of that filtering has to happen here.
 */
import { ok, err, byAdmissionNo, createMemoCache, clearAllCaches } from './_util.mjs';

const VALID_STATUSES = ['present', 'absent', 'late', 'excused'];

export function createAttendanceApi(supabase) {
  // Same short-window in-memory memoization pattern as the rest of the app
  // (see _util.mjs's createMemoCache header comment for the app-wide
  // invalidation bus this shares). Scoped per createAttendanceApi() CALL,
  // not module-level — see the same note in academics.mjs/students.mjs.
  const { cached } = createMemoCache(20000);
  function clearCache() { clearAllCaches(); }
  return {
    /** Roster for the marking screen: active students in a class/stream,
     *  merged with any attendance already recorded for that date. */
    async getRosterForDate({ class_id, stream_id, date }) {
      if (!class_id || !date) return err('Choose a class and a date.');
      return cached('getRosterForDate', [class_id, stream_id, date], async () => {
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
      });
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
      clearCache();
      return ok(null, { saved: payload.length });
    },

    async studentHistory({ student_id, from, to }) {
      if (!student_id) return err('Missing student.');
      return cached('studentHistory', [student_id, from, to], async () => {
        let q = supabase.from('student_attendance').select('date, status, notes').eq('student_id', student_id).order('date', { ascending: false });
        if (from) q = q.gte('date', from);
        if (to) q = q.lte('date', to);
        const { data, error } = await q;
        if (error) return err(error.message);
        return ok(data || []);
      });
    },

    /** Per-student attendance-rate summary for a class over a date range —
     *  the "simple report" the roadmap called for, without a full
     *  attendance-vs-exam-performance correlation view (deferred). */
    async classSummary({ class_id, from, to }) {
      if (!class_id) return err('Choose a class.');
      return cached('classSummary', [class_id, from, to], async () => {
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
      });
    },

    async getStaffRosterForDate({ date }) {
      if (!date) return err('Choose a date.');
      return cached('getStaffRosterForDate', date, async () => {
        const { data: staffList, error } = await supabase.from('staff').select('id, full_name, role').eq('status', 'active').order('full_name');
        if (error) return err(error.message);
        // Round 3 §19: sign_in_time/sign_out_time are read alongside the
        // existing status/notes — same row, one query, no separate fetch.
        const { data: marks, error: mErr } = await supabase.from('staff_attendance').select('staff_id, status, notes, sign_in_time, sign_out_time').eq('date', date);
        if (mErr) return err(mErr.message);
        const markMap = {}; (marks || []).forEach((m) => { markMap[m.staff_id] = m; });
        return ok((staffList || []).map((s) => ({
          staff_id: s.id, full_name: s.full_name, role: s.role,
          status: markMap[s.id] ? markMap[s.id].status : '', notes: markMap[s.id] ? (markMap[s.id].notes || '') : '',
          sign_in_time: markMap[s.id] ? (markMap[s.id].sign_in_time || '') : '',
          sign_out_time: markMap[s.id] ? (markMap[s.id].sign_out_time || '') : ''
        })));
      });
    },

    async saveStaffAttendance({ date, records, marked_by }) {
      if (!date) return err('Missing date.');
      const rows = (Array.isArray(records) ? records : []).filter((r) => r.staff_id && VALID_STATUSES.includes(r.status));
      if (!rows.length) return err('No valid attendance marks to save.');
      const payload = rows.map((r) => ({ staff_id: r.staff_id, date, status: r.status, notes: r.notes || null, marked_by: marked_by || null }));
      const { error } = await supabase.from('staff_attendance').upsert(payload, { onConflict: 'staff_id,date' });
      if (error) return err(error.message);
      clearCache();
      return ok(null, { saved: payload.length });
    },

    /** Round 3 §19: "Add a new feature under the Attendance module for
     *  staff sign-in and sign-out, capturing the actual time of each."
     *  records: [{ staff_id, sign_in_time, sign_out_time }] — every row
     *  MUST carry both fields (blank means "not recorded", saved as null),
     *  same consistent-columns-across-the-whole-batch upsert every other
     *  attendance save() here already does — PostgREST's bulk upsert
     *  requires every object in the array to have the same key set, so
     *  callers can't send a partial {sign_in_time only} row for one staff
     *  member and a partial {sign_out_time only} row for another in the
     *  SAME call. The screen that calls this (attendance.mjs) always
     *  re-sends both values sourced from whatever's currently in each time
     *  input (pre-filled from the last saved roster on load), so an untouched
     *  field naturally carries its existing value forward rather than being
     *  blanked — the same "resend the whole current state" pattern the
     *  Mark Staff status buttons above already rely on. A staff member with
     *  neither time given is skipped entirely (nothing to save for them).
     *  This leaves status (set via the separate "Mark Staff" screen)
     *  untouched on an existing row — Supabase upsert only overwrites
     *  columns actually present in the payload — and defaults it to
     *  'present' via the table's own default for a brand-new row. */
    async saveStaffSignInOut({ date, records, marked_by }) {
      if (!date) return err('Missing date.');
      const rows = (Array.isArray(records) ? records : []).filter((r) => r.staff_id && (r.sign_in_time || r.sign_out_time));
      if (!rows.length) return err('Record at least one sign-in or sign-out time first.');
      const payload = rows.map((r) => ({
        staff_id: r.staff_id, date,
        sign_in_time: r.sign_in_time || null, sign_out_time: r.sign_out_time || null,
        marked_by: marked_by || null
      }));
      const { error } = await supabase.from('staff_attendance').upsert(payload, { onConflict: 'staff_id,date' });
      if (error) return err(error.message);
      clearCache();
      return ok(null, { saved: payload.length });
    }
  };
}
