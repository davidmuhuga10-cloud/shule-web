/**
 * results.mjs — Supabase equivalent of Results.gs.
 * Exams, marks entry, broadsheets and report cards.
 *
 *   Exam            = one assessment event in a term (e.g. "End Term 1 2026").
 *   Results entry   = enter marks for one subject, for one stream, per exam.
 *   Broadsheet      = students x subjects matrix with totals & class position.
 *   Report card     = one student's per-subject breakdown + summary + position
 *                      — computed server-side via the get_report_card() RPC
 *                      (see schema.sql) because a student's own RLS session
 *                      cannot read classmates' results to rank themselves.
 */
import { ok, err, byAdmissionNo, admissionNumberValue } from './_util.mjs';

export function createResultsApi(supabase, gradingApi) {
  return {
    async listExams() {
      const { data, error } = await supabase.from('exams').select('*, academic_years(name), terms(name)');
      if (error) return err(error.message);
      const rows = (data || []).map((e) => ({
        ...e,
        academic_year_name: e.academic_years ? e.academic_years.name : '',
        term_name: e.terms ? e.terms.name : ''
      }));
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return ok(rows);
    },

    async saveExam(payload) {
      payload = payload || {};
      const name = String(payload.name || '').trim();
      if (!name) return err('Exam name is required (e.g. "End of Term 1 Exam").');
      if (!payload.academic_year_id) return err('Please choose an academic year.');
      if (!payload.term_id) return err('Please choose a term.');
      const rec = {
        name,
        academic_year_id: payload.academic_year_id,
        term_id: payload.term_id,
        out_of: Number(payload.out_of) || 100,
        status: payload.status || 'open'
      };
      if (payload.id) {
        const { data, error } = await supabase.from('exams').update(rec).eq('id', payload.id).select().single();
        if (error) return err(error.message);
        return ok(data);
      }
      const { data, error } = await supabase.from('exams').insert(rec).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    async deleteExam(id) {
      // results cascade-delete automatically (ON DELETE CASCADE in schema.sql).
      const { error } = await supabase.from('exams').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    },

    /** Load the entry grid: every student in the chosen class(+stream), with any existing score. */
    async getResultsEntry(q) {
      q = q || {};
      if (!q.exam_id) return err('Please choose an exam.');
      if (!q.class_id) return err('Please choose a class.');
      if (!q.subject_id) return err('Please choose a subject.');

      const { data: exam } = await supabase.from('exams').select('*').eq('id', q.exam_id).maybeSingle();
      if (!exam) return err('Exam not found.');

      let studentQuery = supabase.from('students').select('*').eq('class_id', q.class_id).eq('status', 'active');
      if (q.stream_id) studentQuery = studentQuery.eq('stream_id', q.stream_id);
      const { data: students } = await studentQuery;
      const sorted = (students || []).slice().sort(byAdmissionNo);

      const { data: existing } = await supabase.from('results').select('*').eq('exam_id', q.exam_id).eq('subject_id', q.subject_id);
      const byStudent = {};
      (existing || []).forEach((r) => { byStudent[r.student_id] = r; });

      const rows = sorted.map((s) => {
        const r = byStudent[s.id];
        return { student_id: s.id, admission_no: s.admission_no, full_name: s.full_name, score: r ? r.score : '', grade_label: r ? r.grade_label : '' };
      });
      return ok(rows, { out_of: Number(exam.out_of) || 100, student_count: rows.length });
    },

    /** Save the whole grid at once. scores = [{student_id, score}] ('' clears). */
    async saveResultsEntry(payload) {
      payload = payload || {};
      const { data: exam } = await supabase.from('exams').select('*').eq('id', payload.exam_id).maybeSingle();
      if (!exam) return err('Exam not found.');
      if (!payload.subject_id) return err('Missing subject.');
      const outOf = Number(exam.out_of) || 100;
      const bands = await gradingApi.defaultScaleBands();

      const { data: existing } = await supabase.from('results').select('*').eq('exam_id', payload.exam_id).eq('subject_id', payload.subject_id);
      const byStudent = {};
      (existing || []).forEach((r) => { byStudent[r.student_id] = r; });

      let saved = 0, cleared = 0;
      for (const entry of (payload.scores || [])) {
        const raw = String(entry.score).trim();
        const current = byStudent[entry.student_id];

        if (raw === '') {
          if (current) { await supabase.from('results').delete().eq('id', current.id); cleared++; }
          continue;
        }
        const score = Number(raw);
        if (isNaN(score) || score < 0 || score > outOf) continue; // skip invalid silently; UI validates too
        const g = gradingApi.gradeScore(score, bands);
        const rec = {
          exam_id: payload.exam_id, student_id: entry.student_id, subject_id: payload.subject_id,
          academic_year_id: exam.academic_year_id, term_id: exam.term_id,
          score, grade_label: g.grade_label, points: g.points, remark: g.remark
        };
        if (current) await supabase.from('results').update(rec).eq('id', current.id);
        else await supabase.from('results').insert(rec);
        saved++;
      }
      return ok(null, { saved, cleared });
    },

    /** Broadsheet for an exam within a class (optionally a single stream). */
    async getBroadsheet(q) {
      q = q || {};
      if (!q.exam_id) return err('Please choose an exam.');
      if (!q.class_id) return err('Please choose a class.');

      const { data: exam } = await supabase.from('exams').select('*').eq('id', q.exam_id).maybeSingle();
      if (!exam) return err('Exam not found.');

      const { data: assigned } = await supabase.from('subject_class_assignments').select('subject_id').eq('class_id', q.class_id);
      let subjectIds = (assigned || []).map((a) => a.subject_id);
      if (!subjectIds.length) {
        const { data: examResults } = await supabase.from('results').select('subject_id').eq('exam_id', q.exam_id);
        subjectIds = [...new Set((examResults || []).map((r) => r.subject_id))];
      }
      let subjects = [];
      if (subjectIds.length) {
        const { data } = await supabase.from('subjects').select('*').in('id', subjectIds);
        subjects = (data || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }

      let studentQuery = supabase.from('students').select('*').eq('class_id', q.class_id).eq('status', 'active');
      if (q.stream_id) studentQuery = studentQuery.eq('stream_id', q.stream_id);
      const { data: students } = await studentQuery;

      const streamIds = [...new Set((students || []).map((s) => s.stream_id).filter(Boolean))];
      const { data: streamRows } = streamIds.length
        ? await supabase.from('streams').select('id, name').in('id', streamIds)
        : { data: [] };
      const streamMap = {}; (streamRows || []).forEach((s) => { streamMap[s.id] = s.name; });

      const { data: results } = await supabase.from('results').select('*').eq('exam_id', q.exam_id);
      const resultMap = {};
      (results || []).forEach((r) => {
        if (!resultMap[r.student_id]) resultMap[r.student_id] = {};
        resultMap[r.student_id][r.subject_id] = r.score;
      });

      const rows = (students || []).map((s) => {
        const scores = {};
        let total = 0, counted = 0;
        subjects.forEach((sub) => {
          const v = resultMap[s.id] && resultMap[s.id][sub.id] !== undefined ? Number(resultMap[s.id][sub.id]) : null;
          scores[sub.id] = v;
          if (v !== null && !isNaN(v)) { total += v; counted++; }
        });
        return {
          student_id: s.id, admission_no: s.admission_no, full_name: s.full_name,
          stream_name: streamMap[s.stream_id] || '',
          scores, total, counted, average: counted ? Math.round((total / counted) * 100) / 100 : 0
        };
      });

      const ranked = rows.slice().sort((a, b) => b.total - a.total);
      let lastTotal = null, lastPos = 0;
      ranked.forEach((r, i) => {
        if (r.counted === 0) { r.position = ''; return; }
        if (r.total === lastTotal) { r.position = lastPos; }
        else { r.position = i + 1; lastPos = i + 1; lastTotal = r.total; }
      });
      rows.sort((a, b) => b.total - a.total);

      return ok(null, {
        exam: { id: exam.id, name: exam.name, out_of: exam.out_of },
        subjects: subjects.map((s) => ({ id: s.id, name: s.name, code: s.code })),
        students: rows,
        class_average: rows.length ? Math.round((rows.reduce((a, r) => a + r.average, 0) / rows.length) * 100) / 100 : 0
      });
    },

    /** Computed server-side (SECURITY DEFINER RPC) — see the big comment at the top of this file. */
    async getReportCard(examId, studentId) {
      if (!examId || !studentId) return err('Missing exam or student.');
      const { data, error } = await supabase.rpc('get_report_card', { p_exam_id: examId, p_student_id: studentId });
      if (error) return err(error.message || 'You are not authorized to view this report card.');
      return ok(data);
    },

    /** Student portal: list exams the student has any results for. */
    async getStudentExams(studentId) {
      if (!studentId) return ok([]);
      const { data: mine } = await supabase.from('results').select('exam_id').eq('student_id', studentId);
      const examIds = [...new Set((mine || []).map((r) => r.exam_id))];
      if (!examIds.length) return ok([], { student_id: studentId });
      const { data: exams } = await supabase.from('exams').select('*, academic_years(name), terms(name)').in('id', examIds);
      const rows = (exams || []).map((e) => ({
        ...e, academic_year_name: e.academic_years ? e.academic_years.name : '', term_name: e.terms ? e.terms.name : ''
      }));
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return ok(rows, { student_id: studentId });
    }
  };
}
