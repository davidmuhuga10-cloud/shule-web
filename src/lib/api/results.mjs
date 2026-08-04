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
import { getEffectiveClassSubjectIds, getEffectiveClassSubjectIdsBatch } from './assignments.mjs';

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
      let saved;
      if (payload.id) {
        const { data, error } = await supabase.from('exams').update(rec).eq('id', payload.id).select().single();
        if (error) return err(error.message);
        saved = data;
      } else {
        const { data, error } = await supabase.from('exams').insert(rec).select().single();
        if (error) return err(error.message);
        saved = data;
      }

      // Phase 2h (brief §7.1): sync which classes sit this exam — a full
      // replace-the-set like every other assignment-style save() in this
      // app, EXCEPT a class already carrying recorded marks is never
      // silently dropped from the board just because it got unticked here
      // (that would hide results an admin already has, which the class
      // picker isn't meant to do — remove the marks first if that's really
      // the intent).
      if (Array.isArray(payload.class_ids)) {
        const wanted = payload.class_ids.map(String);
        const { data: existing } = await supabase.from('exam_classes').select('id, class_id').eq('exam_id', saved.id);
        const existingIds = (existing || []).map((a) => String(a.class_id));
        const toAdd = wanted.filter((cid) => existingIds.indexOf(cid) === -1);
        const toRemove = (existing || []).filter((a) => wanted.indexOf(String(a.class_id)) === -1);

        if (toAdd.length) {
          const { error } = await supabase.from('exam_classes').insert(toAdd.map((class_id) => ({ exam_id: saved.id, class_id })));
          if (error) return err(error.message);
        }
        for (const a of toRemove) {
          const { count } = await supabase.from('results').select('id', { count: 'exact', head: true }).eq('exam_id', saved.id).eq('class_id', a.class_id);
          if (count > 0) continue;
          await supabase.from('exam_classes').delete().eq('id', a.id);
        }
      }
      return ok(saved);
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
     *  subject score, computed at read time by get_report_card()/getBroadsheet().
     *
     *  Phase 2f: this used to loop client-side, awaiting one select-then-
     *  insert-or-update round trip PER STUDENT — fine for a handful of
     *  scores, but a full class (or the Bulk Upload Marks flow calling this
     *  once per subject/paper column) turned into hundreds of sequential
     *  network round trips, which is what made marks import take minutes
     *  instead of seconds. The per-row logic (exists-check, range
     *  validation, default-scale grading, blank-clears-the-row) is now done
     *  in ONE round trip via the save_results_batch() RPC (see
     *  migrations/0008_bulk_marks_rpc.sql) — same behaviour, just one
     *  request regardless of how many students are in the grid. */
    async saveResultsEntry(payload) {
      payload = payload || {};
      if (!payload.exam_id) return err('Missing exam.');
      if (!payload.subject_id) return err('Missing subject.');
      if (!payload.class_id) return err('Missing class.');

      const scores = (payload.scores || []).map((s) => ({
        student_id: s.student_id,
        score: s.score === null || s.score === undefined ? '' : String(s.score)
      }));

      const { data, error } = await supabase.rpc('save_results_batch', {
        p_exam_id: payload.exam_id, p_class_id: payload.class_id, p_subject_id: payload.subject_id,
        p_paper_id: payload.paper_id || null, p_scores: scores
      });
      if (error) return err(error.message || 'Could not save marks.');
      const row = Array.isArray(data) ? data[0] : data;
      return ok(null, { saved: (row && row.saved) || 0, cleared: (row && row.cleared) || 0 });
    },

    /** Wipe every recorded mark for one (exam, class, subject) in one click —
     *  brief §7.2's "Delete All Results" (the real gap left after Add/Edit,
     *  which the existing shared entry grid already covers by just typing
     *  over or blanking a cell). Only sensible for a subject that hasn't
     *  been published yet — deleting marks a parent can already see would
     *  need its own "unpublish" story, not this. */
    async deleteAllResults(examId, classId, subjectId) {
      if (!examId) return err('Missing exam.');
      if (!classId) return err('Missing class.');
      if (!subjectId) return err('Missing subject.');
      const { data: submission } = await supabase.from('result_submissions').select('status')
        .eq('exam_id', examId).eq('class_id', classId).eq('subject_id', subjectId).maybeSingle();
      if (submission && submission.status === 'published') {
        return err('These results are already published — reopen the subject first (in Publish Results) before deleting.');
      }
      const { error, count } = await supabase.from('results').delete({ count: 'exact' })
        .eq('exam_id', examId).eq('class_id', classId).eq('subject_id', subjectId);
      if (error) return err(error.message);
      return ok(null, { deleted: count || 0 });
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

      let subjectIds = await getEffectiveClassSubjectIds(supabase, q.class_id);
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

      // Zeraki-style Mark List (Phase 2i / feature-brief "Merit List Design"):
      // each cell also carries a grade label + points (same default grading
      // scale get_report_card() uses), and each student gets a total/mean
      // points, an overall performance-level grade, a stream position
      // alongside the class-wide one, and a deviation from the class mean —
      // all computed here in JS since getBroadsheet has always been a plain
      // aggregation over already-fetched rows, not a database RPC.
      const bands = gradingApi && gradingApi.defaultScaleBands ? await gradingApi.defaultScaleBands() : [];
      const grade = (score) => (gradingApi && gradingApi.gradeScore ? gradingApi.gradeScore(score, bands) : { grade_label: '', points: '' });

      const rows = (students || []).map((s) => {
        const scores = {};
        const grades = {};
        let total = 0, counted = 0, pointsTotal = 0, pointsCounted = 0;
        subjects.forEach((sub) => {
          const map = bySubjectStudent[sub.id];
          const v = map && map[s.id] !== undefined ? Math.round(map[s.id] * 100) / 100 : null;
          scores[sub.id] = v;
          if (v !== null && !isNaN(v)) {
            total += v; counted++;
            const g = grade(v);
            grades[sub.id] = { grade_label: g.grade_label || '', points: g.points === '' || g.points === null || g.points === undefined ? null : Number(g.points) };
            if (grades[sub.id].points !== null) { pointsTotal += grades[sub.id].points; pointsCounted++; }
          } else {
            grades[sub.id] = { grade_label: '', points: null };
          }
        });
        const average = counted ? Math.round((total / counted) * 100) / 100 : 0;
        const overallGrade = counted ? grade(average) : { grade_label: '', points: '' };
        return {
          student_id: s.id, admission_no: s.admission_no, full_name: s.full_name,
          stream_id: s.stream_id || '', stream_name: streamMap[s.stream_id] || '',
          scores, grades, total: Math.round(total * 100) / 100, counted, subject_count: counted,
          average,
          total_points: pointsCounted ? Math.round(pointsTotal * 100) / 100 : null,
          mean_points: pointsCounted ? Math.round((pointsTotal / pointsCounted) * 100) / 100 : null,
          overall_grade: overallGrade.grade_label || ''
        };
      });

      /** Ranks `list` by total desc, sharing a rank across ties, and leaving
       *  a student unranked ('') once they fall short of counted/minSubjects
       *  — same rule for both the class-wide and the per-stream ranking. */
      function rankByTotal(list, field) {
        const ranked = list.slice().sort((a, b) => b.total - a.total);
        let lastTotal = null, lastPos = 0;
        ranked.forEach((r, i) => {
          if (r.counted === 0 || r.counted < minSubjects) { r[field] = ''; return; }
          if (r.total === lastTotal) { r[field] = lastPos; }
          else { r[field] = i + 1; lastPos = i + 1; lastTotal = r.total; }
        });
      }

      rankByTotal(rows, 'position');
      const byStream = {};
      rows.forEach((r) => { (byStream[r.stream_id] = byStream[r.stream_id] || []).push(r); });
      Object.values(byStream).forEach((group) => rankByTotal(group, 'stream_position'));

      const classAverage = rows.length ? Math.round((rows.reduce((a, r) => a + r.average, 0) / rows.length) * 100) / 100 : 0;
      rows.forEach((r) => { r.deviation = Math.round((r.average - classAverage) * 100) / 100; });

      rows.sort((a, b) => b.total - a.total);

      return ok(null, {
        exam: { id: exam.id, name: exam.name, out_of: exam.out_of, exam_type: exam.exam_type },
        subjects: subjects.map((s) => ({ id: s.id, name: s.name, code: s.code, submission_status: statusBySubject[s.id] || 'draft' })),
        students: rows,
        class_average: classAverage
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

    /** Every subject ASSIGNED to this class (brief §7.3: a subject with
     *  literally zero marks entered still needs to show up here as an
     *  obvious gap — "missing marks or incomplete subject entries" — not be
     *  silently absent just because nothing's been typed yet), with its
     *  current publishing status — the list the "Publish Results" screen
     *  works from (Subject Teacher -> Class Teacher -> Supervisor -> Admin;
     *  "Supervisor" here is any teacher granted the publish_results
     *  capability, or an admin). Also reports who's assigned to teach it and
     *  how many of the class's active students actually have a mark yet, so
     *  an admin reviewing before publish can see at a glance who has and
     *  hasn't submitted, and whether any student is still missing a score.
     *  A subject that has results but is no longer in the assigned set
     *  (e.g. unassigned after marks were entered) is still included, so
     *  recorded marks are never silently dropped from the review. */
    async listSubmissions(examId, classId) {
      if (!examId) return err('Please choose an exam.');
      if (!classId) return err('Please choose a class.');
      const [assignedIds, { data: examResults }] = await Promise.all([
        getEffectiveClassSubjectIds(supabase, classId),
        supabase.from('results').select('subject_id, student_id').eq('exam_id', examId).eq('class_id', classId)
      ]);
      const resultSubjectIds = [...new Set((examResults || []).map((r) => r.subject_id))];
      const subjectIds = [...new Set([...assignedIds, ...resultSubjectIds])];
      if (!subjectIds.length) return ok([]);
      const { data: subjects } = await supabase.from('subjects').select('id, name, code').in('id', subjectIds);
      const subjectMap = indexById(subjects || []);
      const { data: submissions } = await supabase.from('result_submissions').select('*')
        .eq('exam_id', examId).eq('class_id', classId).in('subject_id', subjectIds);
      const subMap = {};
      (submissions || []).forEach((s) => { subMap[s.subject_id] = s; });

      const { count: expectedCount } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('class_id', classId).eq('status', 'active');

      const { data: teacherRows } = await supabase.from('subject_teacher_assignments').select('subject_id, staff_id').eq('class_id', classId).in('subject_id', subjectIds);
      const staffIds = [...new Set((teacherRows || []).map((r) => r.staff_id).filter(Boolean))];
      const { data: staffRows } = staffIds.length ? await supabase.from('staff').select('id, full_name').in('id', staffIds) : { data: [] };
      const staffMap = indexById(staffRows || []);
      const teacherBySubject = {};
      (teacherRows || []).forEach((r) => { if (!teacherBySubject[r.subject_id]) teacherBySubject[r.subject_id] = (staffMap[r.staff_id] || {}).full_name || ''; });

      const enteredBySubject = {};
      (examResults || []).forEach((r) => { enteredBySubject[r.subject_id] = (enteredBySubject[r.subject_id] || 0) + 1; });

      const rows = subjectIds.map((sid) => {
        const sub = subjectMap[sid] || { name: '(deleted subject)', code: '' };
        const row = subMap[sid];
        const entered = enteredBySubject[sid] || 0;
        const expected = expectedCount || 0;
        return {
          subject_id: sid, subject_name: sub.name, subject_code: sub.code || '',
          status: row ? row.status : 'draft',
          submitted_at: row ? row.submitted_at : null,
          approved_at: row ? row.approved_at : null,
          published_at: row ? row.published_at : null,
          teacher_name: teacherBySubject[sid] || '',
          entered_count: entered, expected_count: expected,
          complete: expected > 0 && entered >= expected
        };
      });
      rows.sort((a, b) => String(a.subject_name).localeCompare(String(b.subject_name)));
      return ok(rows);
    },

    /** The "Manage Exams" board's data source (brief §7.1) — every class
     *  EXPLICITLY selected to sit this exam (exam_classes, set via
     *  saveExam's class_ids), regardless of whether any marks exist for it
     *  yet — so a brand-new exam shows every one of its classes up front
     *  (Zeraki-style "Results Not Uploaded") instead of only appearing once
     *  someone starts entering marks. Each row's status is derived from how
     *  many of the class's actually-ASSIGNED subjects (per-stream union —
     *  see getEffectiveClassSubjectIds) have marks vs have been published,
     *  plus who last published and when, so the UI can show one obvious
     *  next action per class instead of making an admin dig into each
     *  subject one by one. */
    async listExamClasses(examId) {
      if (!examId) return err('Please choose an exam.');
      const { data: examClassRows } = await supabase.from('exam_classes').select('class_id').eq('exam_id', examId);
      const classIds = [...new Set((examClassRows || []).map((r) => r.class_id).filter(Boolean))];
      if (!classIds.length) return ok([]);

      const { data: classes } = await supabase.from('classes').select('id, name').in('id', classIds);
      const classMap = indexById(classes || []);

      const { data: examResults } = await supabase.from('results').select('class_id, subject_id').eq('exam_id', examId).in('class_id', classIds);
      const withMarksByClass = {};
      (examResults || []).forEach((r) => {
        (withMarksByClass[r.class_id] = withMarksByClass[r.class_id] || new Set()).add(r.subject_id);
      });

      const { data: submissions } = await supabase.from('result_submissions')
        .select('class_id, subject_id, status, published_at, published_by').eq('exam_id', examId).in('class_id', classIds);
      const publishedByClass = {};
      const lastPublishByClass = {};
      (submissions || []).forEach((s) => {
        if (s.status !== 'published') return;
        (publishedByClass[s.class_id] = publishedByClass[s.class_id] || new Set()).add(s.subject_id);
        const cur = lastPublishByClass[s.class_id];
        if (!cur || String(s.published_at || '') > String(cur.published_at || '')) {
          lastPublishByClass[s.class_id] = { published_at: s.published_at, published_by: s.published_by };
        }
      });
      const publisherIds = [...new Set(Object.values(lastPublishByClass).map((v) => v.published_by).filter(Boolean))];
      const { data: publisherRows } = publisherIds.length
        ? await supabase.from('staff').select('id, full_name').in('id', publisherIds) : { data: [] };
      const publisherMap = indexById(publisherRows || []);

      const assignedIdsByClass = await getEffectiveClassSubjectIdsBatch(supabase, classIds);
      const rows = [];
      for (const cid of classIds) {
        const assignedIds = assignedIdsByClass[cid] || [];
        const withMarks = withMarksByClass[cid] || new Set();
        const published = publishedByClass[cid] || new Set();
        const subjectsTotal = assignedIds.length;
        const subjectsWithMarks = assignedIds.filter((sid) => withMarks.has(sid)).length;
        const subjectsPublished = assignedIds.filter((sid) => published.has(sid)).length;

        let status;
        if (subjectsTotal === 0) status = 'no_subjects';
        else if (subjectsPublished >= subjectsTotal) status = 'published';
        else if (subjectsWithMarks >= subjectsTotal) status = 'ready_to_publish';
        else if (subjectsWithMarks > 0) status = 'in_progress';
        else status = 'not_started';

        const lastPub = lastPublishByClass[cid];
        rows.push({
          class_id: cid, class_name: (classMap[cid] || {}).name || '(deleted class)',
          subjects_total: subjectsTotal, subjects_with_marks: subjectsWithMarks, subjects_published: subjectsPublished,
          status,
          last_published_at: lastPub ? lastPub.published_at : null,
          last_published_by: lastPub && lastPub.published_by ? ((publisherMap[lastPub.published_by] || {}).full_name || '') : ''
        });
      }
      rows.sort((a, b) => String(a.class_name).localeCompare(String(b.class_name)));
      return ok(rows);
    },

    /** Every class NOT yet added to this exam — the exam-edit modal's "add
     *  more classes later" picker (brief §7.1 also implies classes can be
     *  added to an exam after the fact, e.g. a late-enrolling stream). */
    async listExamClassChoices(examId) {
      const [{ data: allClasses }, { data: examClassRows }] = await Promise.all([
        supabase.from('classes').select('id, name'),
        examId ? supabase.from('exam_classes').select('class_id').eq('exam_id', examId) : Promise.resolve({ data: [] })
      ]);
      const already = new Set((examClassRows || []).map((r) => r.class_id));
      const rows = (allClasses || []).filter((c) => !already.has(c.id))
        .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
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
