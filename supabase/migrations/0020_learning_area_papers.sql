-- ============================================================================
-- 0020_learning_area_papers.sql — "Learning Area Papers" feature.
--
-- subject_papers (0005_exam_workflow.sql) already lets a subject be scored
-- as multiple weighted papers instead of one combined mark — but it was
-- built as a PERMANENT, global-per-subject setting (unique on subject_id +
-- paper_no), with no admin screen that ever actually wrote rows to it.
--
-- The Learning Area Papers brief is explicit that paper setup is NOT a
-- permanent property of a subject: "the same subject might use papers in
-- one exam and revert to a single combined score in the next — the setup
-- must be decided fresh for each exam, not remembered or assumed from a
-- previous one." That requires scoping subject_papers to a specific EXAM,
-- not just a subject.
--
-- What this does:
--   1. Adds exam_id to subject_papers, scoping every paper to one specific
--      exam. Nullable at the database level (a hard NOT NULL would risk
--      breaking on any pre-existing row from earlier experimentation — see
--      note below) but the application layer (academics.mjs's
--      subjectPapers API) always sets it from here on; every read used by
--      the Learning Area Papers screen, Marks Entry, Mark List, and Bulk
--      Upload filters by exam_id.
--   2. Replaces the old unique(subject_id, paper_no) with unique(exam_id,
--      subject_id, paper_no) — the same subject can now have completely
--      independent paper setups (or none at all) in different exams.
--
-- Nothing here touches `results.paper_id` or the scoring math in
-- get_report_card()/save_results_batch() — a result row already points at
-- one specific subject_papers row via paper_id, which was always created
-- for one specific exam's marks entry, so the combination formula (score /
-- paper.out_of * paper.weight, scaled to the exam's out_of) is unaffected.
--
-- EXISTING DATA: since no screen has ever written to subject_papers before
-- this feature, this is expected to be a no-op for every real school —
-- there's nothing to backfill. Any row that somehow exists already keeps
-- working (exam_id null just means "not tied to a specific exam" — it
-- simply won't show up on the new per-exam Learning Area Papers screen or
-- be selectable from Marks Entry, since every read from here on filters by
-- exam_id).
--
-- Safe to paste as a single script. Idempotent — re-running this after it
-- already applied is a no-op.
-- ============================================================================

alter table public.subject_papers
  add column if not exists exam_id uuid references public.exams(id) on delete cascade;

create index if not exists idx_subject_papers_exam on public.subject_papers(exam_id);

alter table public.subject_papers drop constraint if exists subject_papers_subject_id_paper_no_key;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'subject_papers_exam_subject_paperno_key'
  ) then
    alter table public.subject_papers
      add constraint subject_papers_exam_subject_paperno_key unique (exam_id, subject_id, paper_no);
  end if;
end $$;
