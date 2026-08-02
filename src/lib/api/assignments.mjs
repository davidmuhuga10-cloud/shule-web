/**
 * assignments.mjs — Supabase equivalent of Assignments.gs.
 * Two kinds: Subject -> Class (which subjects a class offers, streams
 * inherit automatically), and Teacher -> Subject in a Stream (who teaches
 * what, where).
 */
import { ok, err } from './_util.mjs';

export function createAssignmentsApi(supabase) {
  return {
    async getClassSubjects(classId) {
      const { data, error } = await supabase.from('subject_class_assignments').select('subject_id').eq('class_id', classId);
      if (error) return err(error.message);
      return ok((data || []).map((a) => ({ subject_id: a.subject_id })));
    },

    /** Replace the full set of subjects for a class in one call. */
    async setClassSubjects(classId, subjectIds) {
      if (!classId) return err('Please choose a class.');
      subjectIds = subjectIds || [];
      const { data: existing } = await supabase.from('subject_class_assignments').select('id, subject_id').eq('class_id', classId);
      const existingIds = (existing || []).map((a) => String(a.subject_id));

      const toAdd = subjectIds.filter((sid) => existingIds.indexOf(String(sid)) === -1);
      const toRemove = (existing || []).filter((a) => subjectIds.map(String).indexOf(String(a.subject_id)) === -1);

      if (toAdd.length) {
        const { error } = await supabase.from('subject_class_assignments').insert(toAdd.map((sid) => ({ subject_id: sid, class_id: classId })));
        if (error) return err(error.message);
      }
      for (const a of toRemove) {
        await supabase.from('subject_class_assignments').delete().eq('id', a.id);
      }

      // Subjects are stored at the CLASS level, so every stream of this class
      // automatically shares them. Report how many streams inherit, for the UI msg.
      const [{ data: cls }, { count: streamCount }] = await Promise.all([
        supabase.from('classes').select('name').eq('id', classId).maybeSingle(),
        supabase.from('streams').select('id', { count: 'exact', head: true }).eq('class_id', classId)
      ]);
      return ok(null, { count: subjectIds.length, streamCount: streamCount || 0, className: cls ? cls.name : '' });
    },

    async listTeacherAssignments(filters) {
      filters = filters || {};
      let q = supabase.from('subject_teacher_assignments').select('*');
      if (filters.staff_id) q = q.eq('staff_id', filters.staff_id);
      if (filters.class_id) q = q.eq('class_id', filters.class_id);
      if (filters.stream_id) q = q.eq('stream_id', filters.stream_id);
      const { data, error } = await q;
      if (error) return err(error.message);
      const rows = data || [];

      const subjectIds = [...new Set(rows.map((r) => r.subject_id).filter(Boolean))];
      const staffIds = [...new Set(rows.map((r) => r.staff_id).filter(Boolean))];
      const classIds = [...new Set(rows.map((r) => r.class_id).filter(Boolean))];
      const streamIds = [...new Set(rows.map((r) => r.stream_id).filter(Boolean))];
      const [{ data: subjects }, { data: staff }, { data: classes }, { data: streams }] = await Promise.all([
        subjectIds.length ? supabase.from('subjects').select('id, name').in('id', subjectIds) : Promise.resolve({ data: [] }),
        staffIds.length ? supabase.from('staff').select('id, full_name').in('id', staffIds) : Promise.resolve({ data: [] }),
        classIds.length ? supabase.from('classes').select('id, name').in('id', classIds) : Promise.resolve({ data: [] }),
        streamIds.length ? supabase.from('streams').select('id, name').in('id', streamIds) : Promise.resolve({ data: [] })
      ]);
      const subMap = {}; (subjects || []).forEach((s) => { subMap[s.id] = s.name; });
      const staffMap = {}; (staff || []).forEach((s) => { staffMap[s.id] = s.full_name; });
      const classMap = {}; (classes || []).forEach((c) => { classMap[c.id] = c.name; });
      const streamMap = {}; (streams || []).forEach((s) => { streamMap[s.id] = s.name; });

      rows.forEach((a) => {
        a.subject_name = subMap[a.subject_id] || '(deleted)';
        a.staff_name = staffMap[a.staff_id] || '(deleted)';
        a.class_name = classMap[a.class_id] || '';
        a.stream_name = streamMap[a.stream_id] || '';
      });
      rows.sort((a, b) => String(a.class_name + a.stream_name + a.subject_name).localeCompare(String(b.class_name + b.stream_name + b.subject_name)));
      return ok(rows);
    },

    async saveTeacherAssignment(payload) {
      payload = payload || {};
      if (!payload.staff_id) return err('Please choose a teacher.');
      if (!payload.subject_id) return err('Please choose a subject.');
      if (!payload.class_id) return err('Please choose a class.');

      const { data: existing } = await supabase.from('subject_teacher_assignments').select('*')
        .eq('subject_id', payload.subject_id).eq('class_id', payload.class_id).eq('staff_id', payload.staff_id);
      const dup = (existing || []).find((a) => String(a.stream_id || '') === String(payload.stream_id || ''));
      if (dup) return err('That teacher is already assigned to this subject and stream.');

      const { data, error } = await supabase.from('subject_teacher_assignments').insert({
        subject_id: payload.subject_id,
        staff_id: payload.staff_id,
        class_id: payload.class_id,
        stream_id: payload.stream_id || null,
        academic_year_id: payload.academic_year_id || null,
        term_id: payload.term_id || null
      }).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    async deleteTeacherAssignment(id) {
      const { error } = await supabase.from('subject_teacher_assignments').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    }
  };
}
