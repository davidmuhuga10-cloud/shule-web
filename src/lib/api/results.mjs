/**
 * results.mjs — Supabase equivalent of Results.gs.
 * Exams, marks entry, broadsheets, report cards, and (Phase 2a) the
 * publishing workflow + subject-paper weighting.
 *
 *   Exam            = one assessment event in a term (e.g. "End Term 1 2026"),
 *                      tagged with an exam_type (Summative/Formative/CAT/Mock).
 *   Results entry   = enter marks for one subject, for one stream, per exam —
 *                      per-PAPER if the subject has papers configured (see
 *                      subject_papers in academics.mjs), otherwise a single
 *                      whole-subject mark exactly as before.
 *   Broadsheet      = students x subjects matrix with totals & class position.
 *   Report card     = one student's per-subject breakdown + summary + position
 *                      — computed server-side via the get_report_card() RPC
 *                      (see schema.sql) because a student's own RLS session
 *                      cannot read classmates' results to rank themselves.
 *   Publishing      = a result only becomes visible to the student/parent who
 *                      owns it once its (exam, class, subject) submission has
 *                      gone draft -> submitted -> approved -> published — see
 *                      result_submissions in schema.sql. Staff always see
 *                      everything in their own school regardless of status.
 */
import { ok, err, byAdmissionNo, admissionNumberValue, indexById } from './_util.mjs';

const EXAM_TYPES = ['summative', 'formative', 'cat', 'mock'];
export const EXAM_TYPE_LABELS = {
  summative: 'Summative', formative: 'Formative', cat: 'CAT', mock: 'Mock'
};

export const SUBMISSION_STATUS_LABELS = {
  draft: 'Not submitted', submitted: 'Submitted — awaiting approval',
  approved: 'Approved — awaiting publish', published: 'Published'
};

/** Shared by submitForApproval/approveSubmission/publishSubmission/
 *  reopenSubmission/publishExam below — creates the result_submissions row
 *  if none exists yet (first-ever submit), otherwise updates it. Whether
 *  this particular transition is actually allowed is enforced entirely by
 *  the check_result_submission_transition() trigger in the database; a
 *  disallowed move comes back here as a normal Postgres error. */
async function setSubmissionStatus(supabase, examId, classId, subjectId, nextStatus) {
  if (!examId || !classId || !subjectId) return err('Missing exam, class or subject.');
  const { data: existing } = await supabase.from('result_submissions').select('*')
    .eq('exam_id', examId).eq('class_id', classId).eq('subject_id', subjectId).maybeSingle();
  if (existing) {
    const { data, error } = await supabase.from('result_submissions').update({ status: nextStatus }).eq('id', existing.id).select().single();
    if (error) return err(error.message || 'You do not have permission to do that.');
    return ok(data);
  }
  const { data, error } = await supabase.from('result_submissions')
    .insert({ exam_id: examId, class_id: classId, subject_id: subjectId, status: nextStatus }).select().single();
  if (error) return err(error.message || 'You do not have permission to do that.');
  return ok(data);
}

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
      const examType = EXAM_TYPES.indexOf(payload.exam_type) !== -1 ? payload.exam_type : 'summative';
      const rec = {
        name,
        academic_year_id: payload.academic_year_id,
        term_id: payload.term_id,
        out_of: Number(payload.out_of) || 100,
        status: payload.status || 'open',
        exam_type: examType
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

    /** Load the entry grid: every student in the chosen class(+stream), with
     *  any existing score. Pass paper_id when the subject has papers
     *  configured (see subject_papers in academics.mjs) to load/save that
     *  one paper's marks specifically — omit it for a whole-subject mark,
     *  exactly as before. */
    async getResultsEntry(q) {
      q = q || {};
      if (!q.exam_id) return err('Please choose an exam.');
      if (!q.class_id) return err('Please choose a class.');
      if (!q.subject_id) return err('Please choose a subject.');

      const { data: exam } = await supabase.from('exams').select('*').eq('id', q.exam_id).maybeSingle();
      if (!exam) return err('Exam not found.');

      let outOf = Number(exam.out_of) || 100;
      if (q.paper_id) {
        const { data: paper } = await supabase.from('subject_papers').select('*').eq('id', q.paper_id).maybeSingle();
        if (!paper) return err('Paper not found.');
        outOf = Number(paper.out_of) || 100;
      }

      let studentQuery = supabase.from('students').select('*').eq('class_id', q.class_id).eq('status', 'active');
      if (q.stream_id) studentQuery = studentQuery.eq('stream_id', q.stream_id);
      const { data: students } = await studentQuery;
      const sorted = (students || []).slice().sort(byAdmissionNo);

      let existingQuery = supabase.from('results').select('*').eq('exam_id', q.exam_id).eq('subject_id', q.subject_id);
      existingQuery = q.paper_id ? existingQuery.eq('paper_id', q.paper_id) : existingQuery.is('paper_id', null);
      const { data: existing } = await existingQuery;
      const byStudent = {};
      (existing || []).forEach((r) => { byStudent[r.student_id] = r; });

      const rows = sorted.map((s) => {
        const r = byStudent[s.id];
        return { student_id: s.id, admission_no: s.admission_no, full_name: s.full_name, score: r ? r.score : '', grade_label: r ? r.grade_label : '' };
      });
      return ok(rows, { out_of: outOf, student_count: rows.length });
    },

    /** Save the whole grid at once. scores = [{student_id, score}] ('' clears).
     *  class_id is required (Phase 2a — every result row now snapshots the
     *  class it was entered against, so the publishing workflow can key off
     *  exactly the (exam, class, subject) grouping marks are actually
     *  entered by). paper_id is optional — see getResultsEntry above.
     *  Per-paper rows are NOT graded individually (grade_label/points/remark
     *  stay blank on them); the meaningful grade is the combined, weighted
     *  subject score, computed at read time by get_report_card()/getBroadsheet(). */
    async saveResultsEntry(payload) {
      payload = payload || {};
      const { data: exam } = await supabase.from('exams').select('*').eq('id', payload.exam_id).maybeSingle();
      if (!exam) return err('Exam not found.');
      if (!payload.subject_id) return err('Missing subject.');
      if (!payload.class_id) return err('Missing class.');
      const paperId = payload.paper_id || null;

      let outOf = Number(exam.out_of) || 100;
      let paper = null;
      if (paperId) {
        const { data } = await supabase.from('subject_papers').select('*').eq('id', paperId).maybeSingle();
        if (!data) return err('Paper not found.');
        paper = data;
        outOf = Number(paper.out_of) || 100;
      }
      const bands = await gradingApi.defaultScaleBands();

      let existingQuery = supabase.from('results').select('*').eq('exam_id', payload.exam_id).eq('subject_id', payload.subject_id);
      existingQuery = paperId ? existingQuery.eq('paper_id', paperId) : existingQuery.is('paper_id', null);
      const { data: existing } = await existingQuery;
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
        const g = paperId ? { grade_label: null, points: null, remark: null } : gradingApi.gradeScore(score, bands);
        const rec = {
          exam_id: payload.exam_id, student_id: entry.student_id, subject_id: payload.subject_id,
          academic_year_id: exam.academic_year_id, term_id: exam.term_id,
          class_id: payload.class_id, paper_id: paperId,
          score, grade_label: g.grade_label, points: g.points, remark: g.remark
        };
        if (current) await supabase.from('results').update(rec).eq('id', current.id);
        else await supabase.from('results').insert(rec);
        saved++;
      }
      return ok(null, { saved, cleared });
    },

    /** Broadsheet for an exam within a class (optionally a single stream).
     *  Phase 2a: combines per-paper marks into one weighted effective score
     *  per subject (same formula as get_report_card()'s per_subject CTE —
     *  staff previewing here always see every entered mark regardless of
     *  publish status, since RLS already only ever hands staff their own
     *  school's rows), respects the min-subjects-for-ranking setting, and
     *  surfaces each subject's publishing-workflow status so staff can see
     *  at a glance what's still draft/submitted/approved vs published. */
    async getBroadsheet(q) {
      q = q || {};
      if (!q.exam_id) return err('Please choose an exam.');
      if (!q.class_id) return err('Please choose a class.');

      const { data: exam } = await supabase.from('exams').select('*').eq('id', q.exam_id).maybeSingle();
      if (!exam) return err('Exam not found.');
      const examOutOf = Number(exam.out_of) || 100;

      const { data: assigned } = await supabase.from('subject_class_assignments').select('subject_id').eq('class_id', q.class_id);
      let subjectIds = (assigned || []).map((a) => a.subject_id);
      if (!subjectIds.length) {
        const { data: examResults } = await supabase.from('results').select('subject_id').eq('exam_id', q.exam_id).eq('class_id', q.class_id);
        subjectIds = [...new Set((examResults || []).map((r) => r.subject_id))];
      }
      let subjects = [];
      if (subjectIds.length) {
        const { data } = await supabase.from('subjects').select('*').in('id', subjectIds);
        subjects = (data || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
      }

      const { data: submissions } = subjects.length
        ? await supabase.from('result_submissions').select('*').eq('exam_id', q.exam_id).eq('class_id', q.class_id).in('subject_id', subjects.map((s) => s.id))
        : { data: [] };
      const statusBySubject = {};
      (submissions || []).forEach((s) => { statusBySubject[s.subject_id] = s.status; });

      const { data: papers } = subjects.length
        ? await supabase.from('subject_papers').select('*').in('subject_id', subjects.map((s) => s.id))
        : { data: [] };
      const paperById = indexById(papers || []);

      let studentQuery = supabase.from('students').select('*').eq('class_id', q.class_id).eq('status', 'active');
      if (q.stream_id) studentQuery = studentQuery.eq('stream_id', q.stream_id);
      const { data: students } = await studentQuery;

      const streamIds = [...new Set((students || []).map((s) => s.stream_id).filter(Boolean))];
      const { data: streamRows } = streamIds.length
        ? await supabase.from('streams').select('id, name').in('id', streamIds)
        : { data: [] };
      const streamMap = {}; (streamRows || []).forEach((s) => { streamMap[s.id] = s.name; });

      const { data: results } = await supabase.from('results').select('*').eq('exam_id', q.exam_id).eq('class_id', q.class_id);

      // Combine per-paper rows into one effective score per (student, subject) —
      // normalize each paper's own out_of, apply its weight, scale to the
      // exam's out_of. A whole-subject row (no paper_id) behaves exactly as
      // before: weight 1, already in the exam's out_of.
      const bySubjectStudent = {};
      (results || []).forEach((r) => {
        if (r.score === null || r.score === undefined) return;
        const paper = r.paper_id ? paperById[r.paper_id] : null;
        const weight = paper ? (Number(paper.weight) || 1) : 1;
        const rowOutOf = paper ? (Number(paper.out_of) || 100) : examOutOf;
        const effective = (Number(r.score) * weight / rowOutOf) * examOutOf;
        if (!bySubjectStudent[r.subject_id]) bySubjectStudent[r.subject_id] = {};
        bySubjectStudent[r.subject_id][r.student_id] = (bySubjectStudent[r.subject_id][r.student_id] || 0) + effective;
      });

      const { data: minSetting } = await supabase.from('settings').select('value').eq('key', 'min_subjects_for_ranking').maybeSingle();
      const minSubjects = Number((minSetting || {}).value) || 0;

      const rows = (students || []).map((s) => {
        const scores = {};
        let total = 0, counted = 0;
        subjects.forEach((sub) => {
          const map = bySubjectStudent[sub.id];
          const v = map && map[s.id] !== undefined ? Math.round(map[s.id] * 100) / 100 : null;
          scores[sub.id] = v;
          if (v !== null && !isNaN(v)) { total += v; counted++; }
        });
        return {
          student_id: s.id, admission_no: s.admission_no, full_name: s.full_name,
          stream_name: streamMap[s.stream_id] || '',
          scores, total: Math.round(total * 100) / 100, counted,
          average: counted ? Math.round((total / counted) * 100) / 100 : 0
        };
      });

      const ranked = rows.slice().sort((a, b) => b.total - a.total);
      let lastTotal = null, lastPos = 0;
      ranked.forEach((r, i) => {
        if (r.counted === 0 || r.counted < minSubjects) { r.position = ''; return; }
        if (r.total === lastTotal) { r.position = lastPos; }
        else { r.position = i + 1; lastPos = i + 1; lastTotal = r.total; }
      });
      rows.sort((a, b) => b.total - a.total);

      return ok(null, {
        exam: { id: exam.id, name: exam.name, out_of: exam.out_of, exam_type: exam.exam_type },
        subjects: subjects.map((s) => ({ id: s.id, name: s.name, code: s.code, submission_status: statusBySubject[s.id] || 'draft' })),
        students: rows,
        class_average: rows.length ? Math.round((rows.reduce((a, r) => a + r.average, 0) / rows.length) * 100) / 100 : 0
      });
    },

    /** Current publishing-workflow status for one (exam, class, subject) —
     *  defaults to 'draft' when no submission row exists yet (nothing has
     *  been submitted for approval). */
    async getSubmissionStatus(examId, classId, subjectId) {
      if (!examId || !classId || !subjectId) return ok({ status: 'draft' });
      const { data } = await supabase.from('result_submissions').select('*')
        .eq('exam_id', examId).eq('class_id', classId).eq('subject_id', subjectId).maybeSingle();
      return ok(data || { status: 'draft' });
    },

    /** Every subject that has marks entered for this exam+class, with its
     *  current publishing status — the list the "Publish Results" screen
     *  works from (Subject Teacher -> Class Teacher -> Supervisor -> Admin;
     *  "Supervisor" here is any teacher granted the publish_results
     *  capability, or an admin). */
    async listSubmissions(examId, classId) {
      if (!examId) return err('Please choose an exam.');
      if (!classId) return err('Please choose a class.');
      const { data: examResults } = await supabase.from('results').select('subject_id').eq('exam_id', examId).eq('class_id', classId);
      const subjectIds = [...new Set((examResults || []).map((r) => r.subject_id))];
      if (!subjectIds.length) return ok([]);
      const { data: subjects } = await supabase.from('subjects').select('id, name, code').in('id', subjectIds);
      const subjectMap = indexById(subjects || []);
      const { data: submissions } = await supabase.from('result_submissions').select('*')
        .eq('exam_id', examId).eq('class_id', classId).in('subject_id', subjectIds);
      const subMap = {};
      (submissions || []).forEach((s) => { subMap[s.subject_id] = s; });
      const rows = subjectIds.map((sid) => {
        const sub = subjectMap[sid] || { name: '(deleted subject)', code: '' };
        const row = subMap[sid];
        return {
          subject_id: sid, subject_name: sub.name, subject_code: sub.code || '',
          status: row ? row.status : 'draft',
          submitted_at: row ? row.submitted_at : null,
          approved_at: row ? row.approved_at : null,
          published_at: row ? row.published_at : null
        };
      });
      rows.sort((a, b) => String(a.subject_name).localeCompare(String(b.subject_name)));
      return ok(rows);
    },

    /** Move one (exam, class, subject) forward in the publishing workflow.
     *  The database trigger (check_result_submission_transition() in
     *  0005_exam_workflow.sql) is what actually enforces who may do this and
     *  in what order — these four just create/update the row; a rejected
     *  transition comes back as a normal err() with the trigger's message. */
    async submitForApproval(examId, classId, subjectId) {
      return setSubmissionStatus(supabase, examId, classId, subjectId, 'submitted');
    },
    async approveSubmission(examId, classId, subjectId) {
      return setSubmissionStatus(supabase, examId, classId, subjectId, 'approved');
    },
    async publishSubmission(examId, classId, subjectId) {
      return setSubmissionStatus(supabase, examId, classId, subjectId, 'published');
    },
    async reopenSubmission(examId, classId, subjectId) {
      return setSubmissionStatus(supabase, examId, classId, subjectId, 'draft');
    },

    /** Bulk shortcut for an admin (or anyone with publish_results) to publish
     *  every subject in one class at once, instead of one at a time — the
     *  trigger still enforces the rules per subject, so any subject that
     *  isn't eligible yet (and the caller isn't an admin) is reported back
     *  in `failures` rather than silently skipped. */
    async publishExam(examId, classId) {
      if (!examId) return err('Please choose an exam.');
      if (!classId) return err('Please choose a class.');
      const { data: examResults } = await supabase.from('results').select('subject_id').eq('exam_id', examId).eq('class_id', classId);
      const subjectIds = [...new Set((examResults || []).map((r) => r.subject_id))];
      if (!subjectIds.length) return err('No marks have been entered for this class yet.');
      let published = 0;
      const failures = [];
      for (const subjectId of subjectIds) {
        const r = await setSubmissionStatus(supabase, examId, classId, subjectId, 'published');
        if (r.ok) published++; else failures.push({ subject_id: subjectId, message: r.message });
      }
      return ok(null, { published, total: subjectIds.length, failures });
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
