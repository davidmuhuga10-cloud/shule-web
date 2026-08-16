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

// "Target Exam Analysis Workflow, Benchmarked Against Zeraki" brief, Step 1:
// Zeraki's own exam-type vocabulary, replacing the old generic Summative/
// Formative/CAT/Mock in the UI (still valid at the DB level for anything
// already saved under them — see migrations/0012_exam_workflow_v2.sql).
// 'consolidated' (combining two or more exams together) is intentionally
// listed here — it's a real Zeraki exam type an admin can pick — but its
// actual merge-logic is explicitly out of scope for this brief ("a separate
// feature to be scoped in detail later"); selecting it today just creates a
// normal single exam shell, same as every other type.
const EXAM_TYPES = ['written', 'consolidated', 'supplementary', 'kpsea_kjsea', 'year_average'];
// System Fixes brief §6: renamed labels only — the stored exam_type values
// ('written'/'supplementary') are unchanged, so nothing already saved needs
// migrating, existing filters/branches elsewhere keyed on these values keep
// working exactly as before.
export const EXAM_TYPE_LABELS = {
  written: 'Normal Exam', consolidated: 'Consolidated Exam', supplementary: 'CAT',
  kpsea_kjsea: 'KPSEA/KJSEA', year_average: 'Year Average'
};
export const RANKING_CRITERIA_LABELS = { mean_marks: 'Mean marks', mean_points: 'Mean points' };

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

/** Shared by listDeletedExams()/purgeExpiredDeletedExams() below — a plain
 *  module-level helper (not `this.`) so it works the same whether called as
 *  a method or destructured, matching every other cross-method helper in
 *  this file (setSubmissionStatus, computeClassAverage). */
async function purgeExpired(supabase) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expired } = await supabase.from('exams').select('id').not('deleted_at', 'is', null).lt('deleted_at', cutoff);
  const ids = (expired || []).map((e) => e.id);
  if (!ids.length) return ok(null, { purged: 0 });
  const { error } = await supabase.from('exams').delete().in('id', ids);
  if (error) return err(error.message);
  return ok(null, { purged: ids.length });
}

/** Step 10's "Deviation Exam" — a raw class average (unweighted paper-
 *  normalized totals, same normalization getBroadsheet uses, but no
 *  grading/ranking pass) for ONE other exam + the same class, used purely as
 *  a comparison point ("this class averaged X in the deviation exam, Y this
 *  time"). Deliberately a small, self-contained query rather than reusing
 *  getBroadsheet's full pipeline (grading bands, publish-status filtering,
 *  stream positions, etc. are all irrelevant to a single comparison number,
 *  and calling getBroadsheet recursively here would also re-trigger its own
 *  deviation-exam lookup if that other exam happens to have one configured
 *  too). */
async function computeClassAverage(supabase, examId, classId) {
  const subjectIds = await getEffectiveClassSubjectIds(supabase, classId);
  if (!subjectIds.length) return { average: 0, students_sat: 0 };
  const { data: exam } = await supabase.from('exams').select('out_of').eq('id', examId).maybeSingle();
  const examOutOf = Number(exam && exam.out_of) || 100;
  // Learning Area Papers are scoped to THIS exam AND this class
  // (0020_learning_area_papers.sql, 0021_learning_area_papers_per_class.sql)
  // — a subject's paper setup for a different exam, or for a different
  // class within this same exam, is irrelevant here.
  const { data: papers } = await supabase.from('subject_papers').select('*').eq('exam_id', examId).eq('class_id', classId).in('subject_id', subjectIds);
  const paperById = indexById(papers || []);
  const { data: results } = await supabase.from('results').select('*').eq('exam_id', examId).eq('class_id', classId);
  const byStudent = {};
  (results || []).forEach((r) => {
    if (r.score === null || r.score === undefined) return;
    const paper = r.paper_id ? paperById[r.paper_id] : null;
    const weight = paper ? (Number(paper.weight) || 1) : 1;
    const rowOutOf = paper ? (Number(paper.out_of) || 100) : examOutOf;
    const effective = (Number(r.score) * weight / rowOutOf) * examOutOf;
    byStudent[r.student_id] = byStudent[r.student_id] || { total: 0, counted: 0 };
    byStudent[r.student_id].total += effective;
    byStudent[r.student_id].counted++;
  });
  const students = Object.values(byStudent).filter((s) => s.counted > 0);
  if (!students.length) return { average: 0, students_sat: 0 };
  const avg = students.reduce((a, s) => a + (s.total / s.counted), 0) / students.length;
  return { average: Math.round(avg * 100) / 100, students_sat: students.length };
}

/** Round 2 §10 — shared min-subjects resolver for callers (publishExam)
 *  that don't already have an `exam_classes` row in scope the way
 *  getBroadsheet() does. Same precedence getBroadsheet has always used
 *  inline: the per-(exam,class) override (exam_classes.min_subjects) wins
 *  when set, else fall back to the school-wide `min_subjects_for_ranking`
 *  setting. Kept as its own small fetch rather than folding into
 *  getBroadsheet's own inline block, since that block already has its
 *  `examClass` row fetched for other fields (ranking_criteria,
 *  deviation_exam_id, grading_scale_id) and re-deriving it here would just
 *  be a second, redundant read for that call site. */
async function resolveMinSubjects(supabase, examId, classId) {
  const { data: examClass } = await supabase.from('exam_classes').select('min_subjects').eq('exam_id', examId).eq('class_id', classId).maybeSingle();
  if (examClass && examClass.min_subjects !== null && examClass.min_subjects !== undefined) {
    return Number(examClass.min_subjects) || 0;
  }
  const { data: minSetting } = await supabase.from('settings').select('value').eq('key', 'min_subjects_for_ranking').maybeSingle();
  return Number((minSetting || {}).value) || 0;
}

export function createResultsApi(supabase, gradingApi) {
  return {
    // System Fixes brief §8: a soft-deleted exam (exams.deleted_at set) is
    // never returned by the normal exam list — it only shows up in Deleted
    // Exams (listDeletedExams below) until it's restored or auto-purged.
    async listExams() {
      const { data, error } = await supabase.from('exams').select('*, academic_years(name), terms(name)').is('deleted_at', null);
      if (error) return err(error.message);
      const rows = (data || []).map((e) => ({
        ...e,
        academic_year_name: e.academic_years ? e.academic_years.name : '',
        term_name: e.terms ? e.terms.name : ''
      }));
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return ok(rows);
    },

    /** Round 4 §4 ("change the flow to ask for Class first, then Exam — if
     *  the selected class has no exams, show 'no exams found' and disable
     *  the print button entirely, nothing should generate"): Report Forms
     *  used to offer every exam in the school regardless of whether it was
     *  ever assigned to the chosen class, so a class with zero exams still
     *  let you pick one and only failed later, deep in generation.
     *  exam_classes is the same source of truth getBroadsheet()/
     *  listSubmissions() already treat as "this class actually sits this
     *  exam" — scoping the Exam dropdown to it up front means a class with
     *  no exams shows that immediately, before an Exam is even chosen. */
    async listExamsForClass(classId) {
      if (!classId) return ok([]);
      const { data: examClassRows, error: ecErr } = await supabase.from('exam_classes').select('exam_id').eq('class_id', classId);
      if (ecErr) return err(ecErr.message);
      const examIds = [...new Set((examClassRows || []).map((r) => r.exam_id).filter(Boolean))];
      if (!examIds.length) return ok([]);
      const { data, error } = await supabase.from('exams').select('*, academic_years(name), terms(name)').is('deleted_at', null).in('id', examIds);
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
      const examType = EXAM_TYPES.indexOf(payload.exam_type) !== -1 ? payload.exam_type : 'written';
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
        // Step 1: "set a minimum learning areas value per grade" — an
        // optional { class_id: number|null } map alongside class_ids. Only
        // classes actually present here get their min_subjects touched;
        // omitting the map (or a class from it) leaves whatever's already
        // saved untouched, so callers that don't care about this (e.g. the
        // "+ Add classes" picker) don't need to know about it at all.
        const minByClass = payload.min_subjects_by_class || {};
        const wantedMin = (cid) => {
          const v = minByClass[cid];
          return v === undefined ? undefined : (v === '' || v === null ? null : Number(v));
        };
        const { data: existing } = await supabase.from('exam_classes').select('id, class_id, min_subjects').eq('exam_id', saved.id);
        const existingIds = (existing || []).map((a) => String(a.class_id));
        const toAdd = wanted.filter((cid) => existingIds.indexOf(cid) === -1);
        const toRemove = (existing || []).filter((a) => wanted.indexOf(String(a.class_id)) === -1);
        const toKeep = (existing || []).filter((a) => wanted.indexOf(String(a.class_id)) !== -1);

        if (toAdd.length) {
          const { error } = await supabase.from('exam_classes').insert(toAdd.map((class_id) => {
            const m = wantedMin(class_id);
            return m === undefined ? { exam_id: saved.id, class_id } : { exam_id: saved.id, class_id, min_subjects: m };
          }));
          if (error) return err(error.message);
        }
        for (const a of toKeep) {
          const m = wantedMin(String(a.class_id));
          if (m === undefined || m === a.min_subjects) continue;
          await supabase.from('exam_classes').update({ min_subjects: m }).eq('id', a.id);
        }
        for (const a of toRemove) {
          const { count } = await supabase.from('results').select('id', { count: 'exact', head: true }).eq('exam_id', saved.id).eq('class_id', a.class_id);
          if (count > 0) continue;
          await supabase.from('exam_classes').delete().eq('id', a.id);
        }
      }
      return ok(saved);
    },

    // System Fixes brief §8: hard-delete, kept only for purgeExpiredDeletedExams()
    // (and the mock-supabase test path where an unmigrated/no-column call
    // still needs to work) — day-to-day "Delete" on an exam card now goes
    // through softDeleteExam() below instead, so an admin gets a 30-day
    // undo window rather than instant, unrecoverable loss (results
    // cascade-delete automatically once this actually runs — ON DELETE
    // CASCADE in schema.sql).
    async deleteExam(id) {
      const { error } = await supabase.from('exams').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    },

    /** Soft-delete: the exam disappears from listExams()/the Exam Desk
     *  board immediately, but stays fully intact in the database — Deleted
     *  Exams (below) is where it lives for up to 30 days, restorable at
     *  any point in that window. */
    async softDeleteExam(id) {
      if (!id) return err('Missing exam.');
      const { data, error } = await supabase.from('exams').update({ deleted_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    /** Deleted Exams submodule's list — every soft-deleted exam still
     *  within its 30-day window, newest-deleted first, each with
     *  days_remaining so the UI can show "purges in N days". Opportunistically
     *  sweeps anything that's already past 30 days first (purgeExpiredDeletedExams)
     *  since this app has no background cron — a school that never opens
     *  Deleted Exams simply keeps old entries a little longer than 30 days,
     *  which is harmless (they're already invisible everywhere else), and
     *  the moment anyone does open it, the sweep catches up instantly. */
    async listDeletedExams() {
      await purgeExpired(supabase);
      const { data, error } = await supabase.from('exams').select('*, academic_years(name), terms(name)').not('deleted_at', 'is', null);
      if (error) return err(error.message);
      const now = Date.now();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const rows = (data || []).map((e) => {
        const deletedAt = new Date(e.deleted_at).getTime();
        const daysRemaining = isNaN(deletedAt) ? null : Math.max(0, Math.ceil((deletedAt + THIRTY_DAYS_MS - now) / (24 * 60 * 60 * 1000)));
        return {
          ...e,
          academic_year_name: e.academic_years ? e.academic_years.name : '',
          term_name: e.terms ? e.terms.name : '',
          days_remaining: daysRemaining
        };
      });
      rows.sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
      return ok(rows);
    },

    /** Undo — clears deleted_at so the exam reappears on the Exam Desk
     *  board exactly as it was (nothing about it was ever touched other
     *  than the timestamp). */
    async restoreExam(id) {
      if (!id) return err('Missing exam.');
      const { data, error } = await supabase.from('exams').update({ deleted_at: null }).eq('id', id).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    /** Section 8: "After 30 days, [deleted exams] should be automatically
     *  and completely purged from the database." No server-side cron exists
     *  in this app today, so this runs as a lazy sweep (see listDeletedExams
     *  above) rather than a true background job — functionally equivalent
     *  from an admin's point of view (nothing past 30 days is ever visible
     *  or restorable again), just not driven by a clock running with nobody
     *  watching. Exposed standalone too, in case a real scheduled task is
     *  wired up later (e.g. a Supabase pg_cron job calling this same logic
     *  in SQL, or a scheduled Netlify function). */
    async purgeExpiredDeletedExams() {
      return purgeExpired(supabase);
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
      let maxMarksSet = false;
      if (q.paper_id) {
        // Defense in depth: a paper_id must actually belong to this exam
        // AND this class, not just exist somewhere — same "never trust the
        // client alone" convention as everywhere else in this codebase (a
        // stale paper_id left over from switching exams/classes should
        // error, not silently apply the wrong paper's out_of).
        const { data: paper } = await supabase.from('subject_papers').select('*').eq('id', q.paper_id).eq('exam_id', q.exam_id).eq('class_id', q.class_id).maybeSingle();
        if (!paper) return err('Paper not found.');
        outOf = Number(paper.out_of) || 100;
      } else {
        // Step 5: a subject-level "Maximum Marks" override, set by the
        // teacher before entering scores — see setMaxMarks() below. Takes
        // precedence over the exam's own out_of (but not a paper's, since a
        // subject with configured papers is scored per-paper, not whole).
        const { data: submission } = await supabase.from('result_submissions').select('max_marks')
          .eq('exam_id', q.exam_id).eq('class_id', q.class_id).eq('subject_id', q.subject_id).maybeSingle();
        if (submission && submission.max_marks !== null && submission.max_marks !== undefined) {
          outOf = Number(submission.max_marks) || outOf;
          maxMarksSet = true;
        }
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
      // max_marks_set tells marksEntry.mjs whether a subject-level Maximum
      // Marks has actually been confirmed yet (vs just quietly defaulting to
      // the exam's out_of) — see brief Step 5's "the teacher must set the
      // Maximum Marks before entering scores".
      return ok(rows, { out_of: outOf, student_count: rows.length, max_marks_set: q.paper_id ? true : maxMarksSet });
    },

    /** Step 5: set (or clear) a subject's own "Maximum Marks" for one
     *  (exam, class) — must happen before that subject's scores are entered,
     *  since every existing score is implicitly "out of" whatever this is at
     *  save/read time (see getResultsEntry/getBroadsheet). Changing it after
     *  marks already exist does NOT retroactively rescale them — same
     *  "teacher's responsibility, not silently reinterpreted" stance as
     *  changing an exam's out_of already has today. */
    async setMaxMarks(examId, classId, subjectId, maxMarks) {
      if (!examId || !classId || !subjectId) return err('Missing exam, class or subject.');
      const mm = maxMarks === '' || maxMarks === null || maxMarks === undefined ? null : Number(maxMarks);
      if (mm !== null && (!isFinite(mm) || mm <= 0)) return err('Maximum Marks must be a positive number.');
      const { data: existing } = await supabase.from('result_submissions').select('id')
        .eq('exam_id', examId).eq('class_id', classId).eq('subject_id', subjectId).maybeSingle();
      if (existing) {
        const { data, error } = await supabase.from('result_submissions').update({ max_marks: mm }).eq('id', existing.id).select().single();
        if (error) return err(error.message);
        return ok(data);
      }
      const { data, error } = await supabase.from('result_submissions')
        .insert({ exam_id: examId, class_id: classId, subject_id: subjectId, max_marks: mm }).select().single();
      if (error) return err(error.message);
      return ok(data);
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

      // System Fixes brief §12/§13: these three don't depend on each other
      // — used to be three sequential round trips before anything else
      // could start, now one wave.
      const [{ data: exam }, { data: examClass }, subjectIdsFromAssignments] = await Promise.all([
        supabase.from('exams').select('*').eq('id', q.exam_id).maybeSingle(),
        // Step 10: publish-time settings for this (exam, class) — ranking
        // criteria, deviation exam, overall grading system, minimum learning
        // areas — chosen via savePublishSettings()/the Publish Results
        // screen. All optional; a class that's never been through that
        // step falls back to exactly today's single global behaviour below.
        supabase.from('exam_classes').select('*').eq('exam_id', q.exam_id).eq('class_id', q.class_id).maybeSingle(),
        getEffectiveClassSubjectIds(supabase, q.class_id)
      ]);
      if (!exam) return err('Exam not found.');
      // Round 3 §12: an admin picking a class/exam combo that was never
      // actually assigned together (exam_classes is the source of truth for
      // "which classes sit this exam" — see save()'s class_ids sync above)
      // used to just fall through into an empty, marks-less Mark
      // List/Report Form instead of saying so. exam_classes rows are never
      // deleted while results exist for that pairing (see the toRemove
      // guard in save()), so "no exam_classes row" reliably means this
      // class genuinely never sat this exam, not just "hasn't published
      // yet" (which already has its own "No published subjects yet"
      // message further down).
      if (!examClass) return err('No exams found — this class was not selected to sit this exam.');
      const examOutOf = Number(exam.out_of) || 100;

      let subjectIds = subjectIdsFromAssignments;
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
      const maxMarksBySubject = {};
      (submissions || []).forEach((s) => {
        statusBySubject[s.subject_id] = s.status;
        if (s.max_marks !== null && s.max_marks !== undefined) maxMarksBySubject[s.subject_id] = Number(s.max_marks);
      });

      // Feature brief §5: the Mark List should only ever show a subject once
      // its results are actually published — a subject still in
      // draft/submitted/approved isn't shown at all (not as a "Draft"
      // column), rather than surfacing work that hasn't cleared the
      // approval workflow yet. staff previewing progress still see
      // everything unfiltered on the Publish Results screen
      // (listSubmissions() above is untouched) — this filter is specific to
      // the printable Mark List/broadsheet.
      if (!q.includeUnpublished) {
        subjects = subjects.filter((s) => statusBySubject[s.id] === 'published');
      }

      // Learning Area Papers: scoped to THIS exam AND this class
      // (0020_learning_area_papers.sql, 0021_learning_area_papers_per_class.sql)
      // — a subject's paper setup from a different exam, OR from a
      // different class sitting the same exam, is never relevant to THIS
      // Mark List (Grade 1 may be single-mark while Grade 8 is 3 papers,
      // same subject, same exam). A subject with zero rows here (for this
      // class) is shown as a single combined column, exactly as before this
      // feature existed.
      const { data: papers } = subjects.length
        ? await supabase.from('subject_papers').select('*').eq('exam_id', q.exam_id).eq('class_id', q.class_id).in('subject_id', subjects.map((s) => s.id))
        : { data: [] };
      const paperById = indexById(papers || []);
      const papersBySubject = {};
      (papers || []).forEach((p) => { (papersBySubject[p.subject_id] = papersBySubject[p.subject_id] || []).push(p); });
      Object.values(papersBySubject).forEach((list) => list.sort((a, b) => a.paper_no - b.paper_no));

      let studentQuery = supabase.from('students').select('*').eq('class_id', q.class_id).eq('status', 'active');
      if (q.stream_id) studentQuery = studentQuery.eq('stream_id', q.stream_id);
      // System Fixes brief §12/§13: `students` and `results` don't depend on
      // each other (or on subjects/submissions/papers above) — fired
      // together instead of `results` waiting its turn after streamMap is
      // built below, even though nothing in between actually needs it yet.
      const [{ data: students }, { data: results }] = await Promise.all([
        studentQuery,
        supabase.from('results').select('*').eq('exam_id', q.exam_id).eq('class_id', q.class_id)
      ]);

      const streamIds = [...new Set((students || []).map((s) => s.stream_id).filter(Boolean))];
      const { data: streamRows } = streamIds.length
        ? await supabase.from('streams').select('id, name').in('id', streamIds)
        : { data: [] };
      const streamMap = {}; (streamRows || []).forEach((s) => { streamMap[s.id] = s.name; });

      // Combine per-paper rows into one effective score per (student, subject) —
      // normalize each paper's own out_of, apply its weight, scale to the
      // exam's out_of. A whole-subject row (no paper_id) behaves exactly as
      // before: weight 1, already in the exam's out_of. This effective score
      // is what EVERY total/mean/ranking/"subjects done" figure is built
      // from below — per the brief, individual paper scores never feed
      // those directly, only this combined value (and the raw per-paper
      // scores kept alongside it purely for display — see paperScoresBySubjectStudent).
      const bySubjectStudent = {};
      const paperScoresBySubjectStudent = {}; // { subject_id: { student_id: { paper_id: rawScore } } }
      (results || []).forEach((r) => {
        if (r.score === null || r.score === undefined) return;
        const paper = r.paper_id ? paperById[r.paper_id] : null;
        const weight = paper ? (Number(paper.weight) || 1) : 1;
        // Step 5: a paper-less subject normalizes against its own
        // Maximum Marks override when one's been set, same as a paper
        // already normalizes against its own out_of — falls back to the
        // exam's out_of exactly as before when no override exists.
        const rowOutOf = paper ? (Number(paper.out_of) || 100) : (maxMarksBySubject[r.subject_id] || examOutOf);
        const effective = (Number(r.score) * weight / rowOutOf) * examOutOf;
        if (!bySubjectStudent[r.subject_id]) bySubjectStudent[r.subject_id] = {};
        bySubjectStudent[r.subject_id][r.student_id] = (bySubjectStudent[r.subject_id][r.student_id] || 0) + effective;
        if (paper) {
          if (!paperScoresBySubjectStudent[r.subject_id]) paperScoresBySubjectStudent[r.subject_id] = {};
          if (!paperScoresBySubjectStudent[r.subject_id][r.student_id]) paperScoresBySubjectStudent[r.subject_id][r.student_id] = {};
          paperScoresBySubjectStudent[r.subject_id][r.student_id][r.paper_id] = Number(r.score);
        }
      });

      // Subject Combination (Round 2 §3) — the opposite direction from
      // Learning Area Papers: fold 2+ member subjects into ONE combined
      // "subject" entry, BEFORE the totals loop below ever runs. This is
      // the exact same trick papers use above (bySubjectStudent already
      // holds one combined score per real subject before this point,
      // regardless of whether that subject itself has papers) — a combo's
      // combined score is just a further weighted sum of its members'
      // ALREADY-papers-combined scores, written into bySubjectStudent under
      // a synthetic id, with the member subjects then removed from
      // `subjects`. Every downstream total/mean/ranking/"subjects done"
      // count only ever iterates over `subjects`, so this one substitution
      // is all that's needed — nothing below has to know combos exist.
      const { data: combos } = await supabase.from('subject_combinations').select('*').eq('exam_id', q.exam_id);
      if ((combos || []).length) {
        const { data: comboMembers } = await supabase.from('subject_combination_members').select('*').in('combination_id', combos.map((c) => c.id));
        const membersByCombo = {};
        (comboMembers || []).forEach((m) => { (membersByCombo[m.combination_id] = membersByCombo[m.combination_id] || []).push(m); });

        combos.forEach((combo) => {
          const members = membersByCombo[combo.id] || [];
          // Indices are recomputed fresh every iteration (cheap — this list
          // is always small) rather than once up front, since a PRIOR
          // combo in this same loop may already have spliced `subjects`,
          // which would otherwise leave stale indices for this one.
          const subjectIndexById = {}; subjects.forEach((s, i) => { subjectIndexById[s.id] = i; });
          // Only "activate" a combo on THIS Mark List if every one of its
          // member subjects is actually showing here (published, or
          // includeUnpublished:true) — a combo with a still-draft member
          // falls back to showing nothing special for it rather than
          // presenting an incomplete combined score as if it were final.
          if (members.length < 2 || !members.every((m) => subjectIndexById[m.subject_id] !== undefined)) return;

          const comboSubjectId = `combo:${combo.id}`;
          bySubjectStudent[comboSubjectId] = {};
          (students || []).forEach((s) => {
            let sum = 0, any = false;
            members.forEach((m) => {
              const v = bySubjectStudent[m.subject_id] && bySubjectStudent[m.subject_id][s.id];
              if (v !== undefined) { sum += v * (Number(m.weight) || 0); any = true; }
            });
            if (any) bySubjectStudent[comboSubjectId][s.id] = sum;
          });

          // Replace the members with ONE entry, positioned where the first
          // member used to be (keeps column order predictable rather than
          // always jumping to the end).
          const insertAt = Math.min(...members.map((m) => subjectIndexById[m.subject_id]));
          const memberIds = new Set(members.map((m) => m.subject_id));
          subjects = subjects.filter((s) => !memberIds.has(s.id));
          subjects.splice(Math.min(insertAt, subjects.length), 0, { id: comboSubjectId, name: combo.name, code: combo.name, papers: [], is_combination: true });
        });
      }

      // Step 1: per-(exam,class) "minimum learning areas" (exam_classes.
      // min_subjects) takes precedence when set; falls back to the existing
      // school-wide `min_subjects_for_ranking` setting exactly as before.
      let minSubjects = 0;
      if (examClass && examClass.min_subjects !== null && examClass.min_subjects !== undefined) {
        minSubjects = Number(examClass.min_subjects) || 0;
      } else {
        const { data: minSetting } = await supabase.from('settings').select('value').eq('key', 'min_subjects_for_ranking').maybeSingle();
        minSubjects = Number((minSetting || {}).value) || 0;
      }

      // Zeraki-style Mark List (Phase 2i / feature-brief "Merit List Design"):
      // each cell also carries a grade label + points (same default grading
      // scale get_report_card() uses), and each student gets a total/mean
      // points, an overall performance-level grade, a stream position
      // alongside the class-wide one, and a deviation from the class mean —
      // all computed here in JS since getBroadsheet has always been a plain
      // aggregation over already-fetched rows, not a database RPC.
      // Step 10: an Overall Grading System chosen at publish time
      // (exam_classes.grading_scale_id) overrides the school's single
      // is_default scale for this exam+class only — scaleBands() falls back
      // to the default scale when it's unset, so this is a no-op change of
      // behaviour for any class that's never been through publish settings.
      const bands = gradingApi && gradingApi.scaleBands ? await gradingApi.scaleBands(examClass && examClass.grading_scale_id) : [];
      const grade = (score) => (gradingApi && gradingApi.gradeScore ? gradingApi.gradeScore(score, bands) : { grade_label: '', points: '' });

      const rows = (students || []).map((s) => {
        const scores = {};
        const grades = {};
        // Learning Area Papers display-only data (never fed into
        // total/average/ranking below — those all read `scores`/`grades`
        // exactly as before): each paper-enabled subject's raw per-paper
        // marks, plus that subject's combined score expressed as a % of
        // the exam's out_of — what the Mark List's extra columns render.
        const paperScores = {};
        const subjectPct = {};
        let total = 0, counted = 0, pointsTotal = 0, pointsCounted = 0;
        subjects.forEach((sub) => {
          const map = bySubjectStudent[sub.id];
          const v = map && map[s.id] !== undefined ? Math.round(map[s.id] * 100) / 100 : null;
          scores[sub.id] = v;
          if (papersBySubject[sub.id]) {
            paperScores[sub.id] = (paperScoresBySubjectStudent[sub.id] && paperScoresBySubjectStudent[sub.id][s.id]) || {};
            // Round 5 §2: this % is display-only (never feeds
            // total/average/ranking — see the comment on `paperScores`
            // above), so rounding it to a whole number here is purely a
            // "how it's shown" change, not a data-precision one. Was
            // rounded to 1 decimal place before; the brief asked for whole
            // numbers on every Learning Area Papers % and combined-subject
            // figure the Mark List (and its Excel export, which reads this
            // same field — see broadsheetXlsx.mjs) shows.
            subjectPct[sub.id] = (v !== null && examOutOf > 0) ? Math.round((v / examOutOf) * 100) : null;
          }
          if (v !== null && !isNaN(v)) {
            total += v; counted++;
            // Sprint Review bug: a Subject Combination's score is a
            // weighted sum and very often lands on a fraction (e.g.
            // 84.6) — grading off that raw fraction against integer
            // grade-range bands (…73-84, 85-100…) leaves genuinely
            // ungraded gaps between adjacent bands' boundaries, so some
            // students silently got no Performance Level letter while
            // classmates whose combo score happened to round to a whole
            // number were fine. Grade off the same whole number the
            // Mark List/Report Form actually display (Math.round(v)) —
            // `total`/`scores` above keep the exact, unrounded v for
            // ranking, unaffected by this.
            const g = grade(Math.round(v));
            grades[sub.id] = { grade_label: g.grade_label || '', points: g.points === '' || g.points === null || g.points === undefined ? null : Number(g.points) };
            if (grades[sub.id].points !== null) { pointsTotal += grades[sub.id].points; pointsCounted++; }
          } else {
            grades[sub.id] = { grade_label: '', points: null };
          }
        });
        const average = counted ? Math.round((total / counted) * 100) / 100 : 0;
        // Round 2 §10: "students who sat fewer subjects than the set
        // minimum should automatically receive an 'X' grade for that exam"
        // — distinct from (and in addition to) the existing ranking
        // exclusion below (rankByTotal already blanks position/
        // stream_position for the same counted < minSubjects students; this
        // is the first time their own overall_grade reflects it too, rather
        // than showing a computed grade as if they'd sat a full set).
        const belowMinimum = minSubjects > 0 && counted < minSubjects;
        // Same boundary-gap fix as the per-subject grade above — grade the
        // overall average off its rounded whole number, not the raw
        // fractional average.
        const overallGrade = belowMinimum ? { grade_label: 'X', points: null } : (counted ? grade(Math.round(average)) : { grade_label: '', points: '' });
        return {
          student_id: s.id, admission_no: s.admission_no, full_name: s.full_name, gender: s.gender || '',
          stream_id: s.stream_id || '', stream_name: streamMap[s.stream_id] || '',
          scores, grades, paperScores, subjectPct, total: Math.round(total * 100) / 100, counted, subject_count: counted,
          average,
          total_points: pointsCounted ? Math.round(pointsTotal * 100) / 100 : null,
          mean_points: pointsCounted ? Math.round((pointsTotal / pointsCounted) * 100) / 100 : null,
          overall_grade: overallGrade.grade_label || '',
          below_minimum: belowMinimum
        };
      });

      // Step 10: "Ranking Criteria" (mean marks or mean points) — chosen at
      // publish time (exam_classes.ranking_criteria). Ranking by TOTAL marks
      // is today's default and stays the default here too ('mean_marks' is
      // proportional to total when every student sits the same subject
      // count, which is the normal case; only a genuinely mixed subject
      // count needs the distinction, and it's exactly what minSubjects/X
      // already exists to police). 'mean_points' ranks by each student's
      // mean_points instead — the only criteria that actually changes the
      // sort field.
      const rankCriteria = examClass && examClass.ranking_criteria === 'mean_points' ? 'mean_points' : 'mean_marks';
      const rankValue = (r) => (rankCriteria === 'mean_points' ? (r.mean_points === null ? null : r.mean_points) : r.total);

      /** Ranks `list` by rankValue() desc, sharing a rank across ties, and
       *  leaving a student unranked ('') once they fall short of counted/
       *  minSubjects — same rule for both the class-wide and the per-stream
       *  ranking. */
      function rankByTotal(list, field) {
        const ranked = list.slice().sort((a, b) => (rankValue(b) || 0) - (rankValue(a) || 0));
        let lastVal = null, lastPos = 0;
        ranked.forEach((r, i) => {
          if (r.counted === 0 || r.counted < minSubjects) { r[field] = ''; return; }
          const v = rankValue(r);
          if (v === lastVal) { r[field] = lastPos; }
          else { r[field] = i + 1; lastPos = i + 1; lastVal = v; }
        });
      }

      rankByTotal(rows, 'position');
      const byStream = {};
      rows.forEach((r) => { (byStream[r.stream_id] = byStream[r.stream_id] || []).push(r); });
      Object.values(byStream).forEach((group) => rankByTotal(group, 'stream_position'));

      const classAverage = rows.length ? Math.round((rows.reduce((a, r) => a + r.average, 0) / rows.length) * 100) / 100 : 0;
      rows.forEach((r) => { r.deviation = Math.round((r.average - classAverage) * 100) / 100; });

      rows.sort((a, b) => (rankValue(b) || 0) - (rankValue(a) || 0));

      // Step 10: "Deviation Exam" — only computed when one's actually been
      // configured (listDeviationExamChoices() below is what keeps this
      // field only ever offering exams that qualify: a different, already-
      // published exam for the same class).
      let deviationExam = null;
      if (examClass && examClass.deviation_exam_id) {
        const [{ data: devExam }, comparison] = await Promise.all([
          supabase.from('exams').select('id, name').eq('id', examClass.deviation_exam_id).maybeSingle(),
          computeClassAverage(supabase, examClass.deviation_exam_id, q.class_id)
        ]);
        if (devExam) {
          deviationExam = {
            exam_id: devExam.id, exam_name: devExam.name,
            class_average: comparison.average, students_sat: comparison.students_sat,
            delta: Math.round((classAverage - comparison.average) * 100) / 100
          };
        }
      }

      return ok(null, {
        exam: { id: exam.id, name: exam.name, out_of: exam.out_of, exam_type: exam.exam_type },
        subjects: subjects.map((s) => ({
          id: s.id, name: s.name, code: s.code, submission_status: statusBySubject[s.id] || 'draft',
          // Learning Area Papers (0020_learning_area_papers.sql): [] for a
          // subject scored as one combined mark this exam (the common
          // case) — non-empty means the Mark List should render one raw
          // column per paper plus a combined % column instead of a single
          // score column for this subject.
          papers: (papersBySubject[s.id] || []).map((p) => ({ id: p.id, name: p.name, out_of: p.out_of }))
        })),
        students: rows,
        class_average: classAverage,
        ranking_criteria: rankCriteria,
        min_subjects: minSubjects,
        deviation_exam: deviationExam
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
      const teacherIdBySubject = {};
      (teacherRows || []).forEach((r) => {
        if (teacherBySubject[r.subject_id]) return;
        teacherBySubject[r.subject_id] = (staffMap[r.staff_id] || {}).full_name || '';
        teacherIdBySubject[r.subject_id] = r.staff_id || '';
      });

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
          max_marks: row && row.max_marks !== undefined ? row.max_marks : null,
          teacher_name: teacherBySubject[sid] || '',
          teacher_staff_id: teacherIdBySubject[sid] || '',
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
      const { data: examClassRows } = await supabase.from('exam_classes').select('*').eq('exam_id', examId);
      let classIds = [...new Set((examClassRows || []).map((r) => r.class_id).filter(Boolean))];
      if (!classIds.length) return ok([]);
      const examClassByClassId = {};
      (examClassRows || []).forEach((r) => { examClassByClassId[r.class_id] = r; });

      // A class explicitly added to an exam but with zero enrolled students
      // has nothing to enter — the marks-entry screen for it already
      // correctly says "No students found". An earlier version of this
      // fix dropped such a class from the board ENTIRELY, but that reads
      // exactly like "my selected class vanished / wasn't saved" (System
      // Fixes brief §7's bug report) even though exam_classes still has the
      // row — saveExam never actually loses anything. Fixed properly now:
      // keep the class on the board with its own honest 'no_students'
      // status (see below) instead of a misleading "pending marks" status
      // OR silently disappearing.
      const { data: activeStudentRows } = await supabase.from('students').select('class_id').eq('status', 'active').in('class_id', classIds);
      const classIdsWithStudents = new Set((activeStudentRows || []).map((r) => r.class_id));

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

        const ec = examClassByClassId[cid] || {};

        // Step 3/13: a 5th, Zeraki-style "Released" status once every
        // subject is published AND the admin has actually used "Send
        // Results" (exam_classes.released_at — see releaseExam() below) —
        // distinct from "Published" (visible on request) since parents
        // haven't necessarily been proactively notified yet.
        // Round 3 §9 bug fix: this used to require EVERY currently-assigned
        // subject to be published (subjectsPublished >= subjectsTotal)
        // before showing 'published' at all — but publishExam() only ever
        // publishes the subjects that actually HAVE marks (Round 2 §10's
        // min-subjects gate deliberately allows publishing without every
        // subject covered), and subjectsTotal can also grow afterwards if a
        // new subject gets assigned to the class later. Either case left a
        // genuinely-published class stuck showing "Marks incomplete"
        // forever, even though publishing was a deliberate, completed admin
        // action (e.g. the brief's own example: 8/9 subjects published,
        // permanently amber). A class counts as published as soon as it has
        // AT LEAST ONE published subject — publishExam() is one atomic
        // "Publish" action, so any publish at all reflects that decision;
        // getting it back to "in progress" now requires an explicit
        // Withdraw, never an implicit recomputation.
        let status;
        if (!classIdsWithStudents.has(cid)) status = 'no_students';
        else if (subjectsTotal === 0) status = 'no_subjects';
        else if (subjectsPublished > 0) status = ec.released_at ? 'released' : 'published';
        else if (subjectsWithMarks >= subjectsTotal) status = 'ready_to_publish';
        else if (subjectsWithMarks > 0) status = 'in_progress';
        else status = 'not_started';

        const lastPub = lastPublishByClass[cid];
        rows.push({
          class_id: cid, class_name: (classMap[cid] || {}).name || '(deleted class)',
          subjects_total: subjectsTotal, subjects_with_marks: subjectsWithMarks, subjects_published: subjectsPublished,
          status,
          last_published_at: lastPub ? lastPub.published_at : null,
          last_published_by: lastPub && lastPub.published_by ? ((publisherMap[lastPub.published_by] || {}).full_name || '') : '',
          // Step 1/10: prefill values for the exam modal's per-class
          // "Minimum learning areas" field and the Publish-Settings modal.
          min_subjects: ec.min_subjects === undefined ? null : ec.min_subjects,
          ranking_criteria: ec.ranking_criteria || null,
          deviation_exam_id: ec.deviation_exam_id || null,
          grading_scale_id: ec.grading_scale_id || null,
          released_at: ec.released_at || null
        });
      }
      rows.sort((a, b) => String(a.class_name).localeCompare(String(b.class_name)));
      return ok(rows);
    },

    /** Every subject actually being examined in this exam — the union of
     *  every subject assigned (per-stream, class-wide fallback) to any of
     *  the classes sitting this exam — what the Learning Area Papers setup
     *  screen lists. Scoping to the exam's own classes (rather than every
     *  subject in the school) keeps the screen relevant: a Grade 9 exam
     *  only shows Grade 9-ish subjects, not the whole school's catalogue. */
    async listExamSubjects(examId) {
      if (!examId) return err('Please choose an exam.');
      const { data: examClassRows } = await supabase.from('exam_classes').select('class_id').eq('exam_id', examId);
      const classIds = [...new Set((examClassRows || []).map((r) => r.class_id).filter(Boolean))];
      if (!classIds.length) return ok([]);
      const idsByClass = await getEffectiveClassSubjectIdsBatch(supabase, classIds);
      const subjectIds = [...new Set(Object.values(idsByClass).flat())];
      if (!subjectIds.length) return ok([]);
      const { data: subjects, error } = await supabase.from('subjects').select('id, name, code').in('id', subjectIds);
      if (error) return err(error.message);
      return ok((subjects || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))));
    },

    /** Every class ALREADY assigned to this exam, just id+name (the
     *  opposite of listExamClassChoices below) — what the Learning Area
     *  Papers screen's class picker offers, since a paper setup can only
     *  ever apply to a class that's actually sitting this exam in the first
     *  place. Deliberately a different name from listExamClasses() above
     *  (the Manage Exams board's per-class publishing-status rows) — same
     *  underlying exam_classes source, completely different shape/purpose. */
    async listExamClassNames(examId) {
      if (!examId) return err('Please choose an exam.');
      const { data: examClassRows } = await supabase.from('exam_classes').select('class_id').eq('exam_id', examId);
      const classIds = [...new Set((examClassRows || []).map((r) => r.class_id).filter(Boolean))];
      if (!classIds.length) return ok([]);
      const { data: classes, error } = await supabase.from('classes').select('id, name').in('id', classIds);
      if (error) return err(error.message);
      return ok((classes || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))));
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

      // Round 3 §8: never publish results that can't actually be graded.
      // A per-(exam,class) "Overall Grading System" override (Step 10, set
      // via Publish Settings) counts as having one; otherwise the school
      // needs an active (is_default) grading scale — no grading scale is
      // ever auto-selected for a school, so without an explicit admin
      // choice here there is nothing to grade against at all.
      const { data: examClassRow } = await supabase.from('exam_classes').select('grading_scale_id').eq('exam_id', examId).eq('class_id', classId).maybeSingle();
      if (!(examClassRow && examClassRow.grading_scale_id)) {
        const { data: defaultScale } = await supabase.from('grading_scales').select('id').eq('is_default', true).maybeSingle();
        if (!defaultScale) {
          return err('No grading scale is active yet — add or activate one under Grading Scales before you can publish results.');
        }
      }

      const { data: examResults } = await supabase.from('results').select('subject_id').eq('exam_id', examId).eq('class_id', classId);
      const subjectIds = [...new Set((examResults || []).map((r) => r.subject_id))];
      if (!subjectIds.length) return err('No marks have been entered for this class yet.');

      // Round 2 §10 — new publish gate: at least `min_subjects` DISTINCT
      // subjects must each have at least one student's results uploaded
      // before this class can be published at all. Reuses the exact same
      // "distinct subject_ids present in `results`" count already computed
      // above for this call (matches what the Exam Desk board already shows
      // as "subjects with marks" for a class), just now actually enforced
      // instead of only informational. A min_subjects of 0/unset (the
      // default) keeps today's behaviour — any marks at all is enough.
      const minSubjects = await resolveMinSubjects(supabase, examId, classId);
      if (minSubjects > 0 && subjectIds.length < minSubjects) {
        return err(`At least ${minSubjects} subject(s) need results uploaded before this class can be published — only ${subjectIds.length} so far.`);
      }

      // System Fixes brief §12/§13: each subject's publish is fully
      // independent (its own result_submissions row, no cross-subject
      // read/write) — used to be awaited one at a time in a for-loop, which
      // for a class with a dozen-plus subjects meant that many sequential
      // round trips just to click "Publish Results." Firing them all at
      // once and waiting on the whole batch cuts that to the time of the
      // single slowest one.
      const outcomes = await Promise.all(subjectIds.map((subjectId) => setSubmissionStatus(supabase, examId, classId, subjectId, 'published')));
      let published = 0;
      const failures = [];
      outcomes.forEach((r, i) => { if (r.ok) published++; else failures.push({ subject_id: subjectIds[i], message: r.message }); });
      return ok(null, { published, total: subjectIds.length, failures });
    },

    /** Step 10: the settings an admin chooses on the "Publish Results
     *  Settings" step — Ranking Criteria, Deviation Exam, Minimum learning
     *  areas, and the Overall Grading System — saved onto exam_classes
     *  BEFORE publishExam() runs, so getBroadsheet()/examAnalysis pick them
     *  up for this exam+class from then on. Deliberately exam+class scoped
     *  only, never per-subject (the brief's one explicit exception). Pass
     *  `undefined` for any field to leave it exactly as-is (so a caller can
     *  update just one field without having to re-send the others). */
    async savePublishSettings(examId, classId, settings) {
      if (!examId) return err('Please choose an exam.');
      if (!classId) return err('Please choose a class.');
      settings = settings || {};
      const rec = {};
      if (settings.min_subjects !== undefined) rec.min_subjects = settings.min_subjects === '' || settings.min_subjects === null ? null : Number(settings.min_subjects);
      if (settings.ranking_criteria !== undefined) rec.ranking_criteria = settings.ranking_criteria || null;
      if (settings.deviation_exam_id !== undefined) rec.deviation_exam_id = settings.deviation_exam_id || null;
      if (settings.grading_scale_id !== undefined) rec.grading_scale_id = settings.grading_scale_id || null;
      const { data: existing } = await supabase.from('exam_classes').select('id').eq('exam_id', examId).eq('class_id', classId).maybeSingle();
      if (!existing) return err('This class is not on this exam yet.');
      const { data, error } = await supabase.from('exam_classes').update(rec).eq('id', existing.id).select().single();
      if (error) return err(error.message || 'You do not have permission to change publish settings.');
      return ok(data);
    },

    /** Step 10: "a Deviation Exam (only shown if a qualifying previous exam
     *  actually exists to compare against)" — a qualifying exam is any OTHER
     *  exam that has at least one published subject for this same class
     *  (comparing against an exam with no results yet, or this exam itself,
     *  wouldn't mean anything). */
    async listDeviationExamChoices(examId, classId) {
      if (!classId) return ok([]);
      const { data: ecRows } = await supabase.from('exam_classes').select('exam_id').eq('class_id', classId);
      const examIds = [...new Set((ecRows || []).map((r) => r.exam_id))].filter((id) => String(id) !== String(examId));
      if (!examIds.length) return ok([]);
      const { data: subs } = await supabase.from('result_submissions').select('exam_id')
        .eq('class_id', classId).eq('status', 'published').in('exam_id', examIds);
      const qualifying = [...new Set((subs || []).map((s) => s.exam_id))];
      if (!qualifying.length) return ok([]);
      const { data: exams } = await supabase.from('exams').select('id, name').in('id', qualifying);
      return ok((exams || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))));
    },

    /** Step 13's "Withdraw Results" — the reverse of publishExam(): reopens
     *  every currently-published subject for this class back to draft (same
     *  admin-only trigger rule as reopenSubmission), and clears any
     *  "released" mark since results are no longer live for parents to see.
     *  A genuine bulk undo, not a soft hide — the class teacher/admin will
     *  need to re-approve and re-publish afterwards, same as reopening one
     *  subject at a time already requires. */
    async withdrawExam(examId, classId) {
      if (!examId) return err('Please choose an exam.');
      if (!classId) return err('Please choose a class.');
      const { data: submissions } = await supabase.from('result_submissions').select('subject_id, status').eq('exam_id', examId).eq('class_id', classId);
      const toReopen = (submissions || []).filter((s) => s.status === 'published').map((s) => s.subject_id);
      if (!toReopen.length) return err('Nothing published yet for this class.');
      // Same fix as publishExam() above — independent per-subject writes,
      // fired together instead of one at a time.
      const outcomes = await Promise.all(toReopen.map((subjectId) => setSubmissionStatus(supabase, examId, classId, subjectId, 'draft')));
      let reopened = 0;
      const failures = [];
      outcomes.forEach((r, i) => { if (r.ok) reopened++; else failures.push({ subject_id: toReopen[i], message: r.message }); });
      const { data: ec } = await supabase.from('exam_classes').select('id').eq('exam_id', examId).eq('class_id', classId).maybeSingle();
      if (ec) await supabase.from('exam_classes').update({ released_at: null, released_by: null }).eq('id', ec.id);
      return ok(null, { reopened, total: toReopen.length, failures });
    },

    /** Step 13's "Send Results" — marks this (exam, class) as released
     *  (Zeraki's 4th board status) at the moment the admin actually sends,
     *  matching the fact that nothing here has a real SMS provider wired up
     *  yet (see send-message.js — every send is logged, not actually
     *  dispatched) — this call and the messaging send it accompanies happen
     *  together from the Manage Exams board's "📨 Send Results" action. */
    async markReleased(examId, classId, staffId) {
      if (!examId || !classId) return err('Missing exam or class.');
      const { data: ec } = await supabase.from('exam_classes').select('id').eq('exam_id', examId).eq('class_id', classId).maybeSingle();
      if (!ec) return err('This class is not on this exam.');
      const { data, error } = await supabase.from('exam_classes')
        .update({ released_at: new Date().toISOString(), released_by: staffId || null }).eq('id', ec.id).select().single();
      if (error) return err(error.message);
      return ok(data);
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
