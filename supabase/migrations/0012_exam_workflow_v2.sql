-- ============================================================================
-- 0012_exam_workflow_v2.sql — "Target Exam Analysis Workflow, Benchmarked
-- Against Zeraki" brief. Additive-only (no destructive drops, no narrowed
-- constraints on existing values) so it's safe to run against a school that
-- already has exams/results recorded under the old shape.
--
-- What this adds, mapped to the brief's step numbers:
--   Step 1  — wider exam_type vocabulary (Written Test/Consolidated/
--             Supplementary/KPSEA-KJSEA/Year Average), replacing the old
--             generic Summative/Formative/CAT/Mock as the types offered in
--             the UI going forward. Old values stay valid at the DB level
--             (nothing already saved breaks) and every existing exam is
--             backfilled to 'written' ("Written Test = our normal exam
--             type" per the brief) so the UI has one consistent vocabulary
--             to show from day one.
--   Step 1  — per-(exam,class) "minimum learning areas" (exam_classes.
--             min_subjects) — a student who sat fewer subjects than this is
--             excluded from ranking (shown as X) instead of skewing the
--             mean. Nullable: falls back to the existing global
--             `min_subjects_for_ranking` setting when not set for a
--             particular class, so nothing already relying on that global
--             changes behaviour until an admin actually sets a per-class
--             value.
--   Step 3/13 — "released" tracking (exam_classes.released_at/released_by)
--             so the Manage Exams board can show Zeraki's 4th status
--             ("Released", i.e. results have actually been sent to
--             parents) once the new "Send Results" action has been used —
--             distinct from "Published" (visible to parents on request)
--             per the brief's Zeraki-status vocabulary.
--   Step 5  — per-(exam,class,subject) "Maximum Marks" override
--             (result_submissions.max_marks) — today out_of only lives on
--             the exam itself (or a subject_paper) so every subject
--             implicitly shares the exam's out_of; this lets a teacher set
--             their own subject's actual max before entering scores,
--             without forcing a papers setup just to do that. Nullable:
--             falls back to the exam's out_of when unset, exactly today's
--             behaviour.
--   Step 10 — per-(exam,class) publish settings an admin chooses at publish
--             time (ranking_criteria, deviation_exam_id, grading_scale_id)
--             — explicitly NOT per-subject (the brief's one stated
--             exception: "do NOT build... a separate grading system
--             selector per individual learning area/subject"). All three
--             are nullable and only ever read as an override of today's
--             single global default (mean-marks ranking, the one
--             is_default grading scale) — an exam/class that never goes
--             through the new publish-settings step behaves exactly as
--             before.
-- ============================================================================

-- ---- Step 1: wider exam_type vocabulary -----------------------------------
alter table public.exams drop constraint if exists exams_exam_type_check;
alter table public.exams add constraint exams_exam_type_check check (
  exam_type in (
    'summative', 'formative', 'cat', 'mock',                                 -- kept valid, no longer offered in the UI
    'written', 'consolidated', 'supplementary', 'kpsea_kjsea', 'year_average' -- Zeraki-style types (brief Step 1)
  )
);
update public.exams set exam_type = 'written' where exam_type in ('summative', 'formative', 'cat', 'mock');
alter table public.exams alter column exam_type set default 'written';

-- ---- Step 1/3/10/13: per-(exam,class) fields on exam_classes --------------
alter table public.exam_classes add column if not exists min_subjects integer;
alter table public.exam_classes add column if not exists ranking_criteria text;
alter table public.exam_classes add constraint exam_classes_ranking_criteria_check
  check (ranking_criteria is null or ranking_criteria in ('mean_marks', 'mean_points'));
alter table public.exam_classes add column if not exists deviation_exam_id uuid references public.exams(id) on delete set null;
alter table public.exam_classes add column if not exists grading_scale_id uuid references public.grading_scales(id) on delete set null;
alter table public.exam_classes add column if not exists released_at timestamptz;
alter table public.exam_classes add column if not exists released_by uuid references public.staff(id) on delete set null;

-- exam_classes previously had no UPDATE policy at all (only read/insert/
-- delete), because nothing needed to update a row in place before now — the
-- publish-settings step and "Withdraw Results"/"Send Results" actions all
-- update an existing exam_classes row rather than re-inserting it. Same
-- admin-only rule as the existing insert/delete policies on this table.
drop policy if exists exam_classes_admin_update on public.exam_classes;
create policy exam_classes_admin_update on public.exam_classes for update
  using (public.is_admin() and school_id = public.current_school_id())
  with check (public.is_admin() and school_id = public.current_school_id());

-- ---- Step 5: per-(exam,class,subject) Maximum Marks override --------------
alter table public.result_submissions add column if not exists max_marks numeric;
