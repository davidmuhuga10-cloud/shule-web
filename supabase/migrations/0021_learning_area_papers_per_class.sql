-- ============================================================================
-- 0021_learning_area_papers_per_class.sql — correction to
-- 0020_learning_area_papers.sql, per explicit product feedback:
--
--   "Papers set up for a subject should apply to specific classes, not be
--   assumed to apply across the whole school. For example, Grade 1 might
--   sit English as a single paper, while Grade 8 sits it as 3 separate
--   papers, within the same exam. Fix: when configuring papers for a
--   subject, ask which classes this specific paper setup applies to —
--   don't assume it's school-wide."
--
-- 0020 scoped subject_papers to (exam, subject) — a correct fix for "not a
-- permanent property of the subject", but still implicitly school-wide
-- WITHIN one exam: every class sitting that exam and that subject shared
-- the exact same paper structure. This adds class_id, so the same subject
-- in the same exam can be single-mark for one class and multi-paper for
-- another.
--
-- What this does:
--   1. Adds class_id to subject_papers, scoping every paper row to one
--      specific class within one specific exam. Nullable at the database
--      level for the same reason exam_id was in 0020 (defensive — a hard
--      NOT NULL risks breaking on any row written before this migration
--      ran), but the application layer (academics.mjs's subjectPapers API,
--      the Learning Area Papers setup screen) always sets it from here on;
--      every read used by Marks Entry, the Mark List/Broadsheet, and Bulk
--      Upload now filters by class_id too, not just exam_id.
--   2. Replaces unique(exam_id, subject_id, paper_no) with unique(exam_id,
--      subject_id, class_id, paper_no) — the same subject, in the same
--      exam, can now have a completely independent paper setup (or none at
--      all) per class.
--
-- Nothing here touches `results.paper_id` or the combination math — a
-- result row already points at one specific subject_papers row via
-- paper_id, chosen by whichever paper the class-scoped Marks Entry screen
-- offered at the time, so the formula (score / paper.out_of * paper.weight,
-- scaled to the exam's out_of) is unaffected.
--
-- EXISTING DATA: 0020 has not been deployed to any school running this
-- migration set before 0021, so there is no real subject_papers data to
-- migrate — this is expected to be a no-op in practice. Any row that
-- somehow exists already keeps working (class_id null just means "not tied
-- to a specific class" — it simply won't show up on the per-class Learning
-- Area Papers screen or be selectable from Marks Entry, since every read
-- from here on filters by class_id).
--
-- Safe to paste as a single script. Idempotent — re-running this after it
-- already applied is a no-op.
-- ============================================================================

alter table public.subject_papers
  add column if not exists class_id uuid references public.classes(id) on delete cascade;

create index if not exists idx_subject_papers_class on public.subject_papers(class_id);

alter table public.subject_papers drop constraint if exists subject_papers_exam_subject_paperno_key;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'subject_papers_exam_subject_class_paperno_key'
  ) then
    alter table public.subject_papers
      add constraint subject_papers_exam_subject_class_paperno_key unique (exam_id, subject_id, class_id, paper_no);
  end if;
end $$;
