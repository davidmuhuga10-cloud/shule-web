-- ============================================================================
-- 0009_stream_subjects.sql — Phase 2g: per-STREAM subject assignment
-- (brief §4.2 — "the most significant change").
--
-- Problem: subjects were assigned per CLASS only. Today every class ends up
-- attached to 30+ subjects regardless of what it actually studies, which is
-- exactly the pain point the brief calls out — teachers download a marks
-- template listing 40+ subjects when their class only studies 5.
--
-- Fix: subject_class_assignments gains a nullable stream_id. A row with
-- stream_id = NULL is a legacy/class-wide row (pre-existing data, or a class
-- with no streams yet) and keeps applying to every stream of that class,
-- unchanged. A row with stream_id SET is that specific stream's own,
-- authoritative subject list — once a stream has any stream-specific rows,
-- those are used exclusively for it (see getStreamSubjects() in
-- assignments.mjs for the exact "inherited vs customized" logic).
--
-- getClassSubjects(classId) — used everywhere else in the app (marks entry,
-- results, broadsheets, the exam-classes board) and keyed by class_id only,
-- with no stream concept — is NOT touched by this migration at the SQL
-- level; the app computes it as the union of the class's streams' effective
-- subjects. No column on that read path needed to change.
--
-- The old `unique (subject_id, class_id)` constraint is replaced with two
-- PARTIAL unique indexes (same pattern already used on public.results —
-- see migration 0005) so a subject can be assigned once per class-wide row
-- AND once per stream, without colliding.
--
-- Safe to paste as a single script. Idempotent: every statement below is
-- guarded (IF NOT EXISTS / IF EXISTS / DROP+CREATE) so re-running this file
-- against a database that already has it applied is a no-op.
-- ============================================================================

alter table public.subject_class_assignments
  add column if not exists stream_id uuid references public.streams(id) on delete cascade;

create index if not exists idx_sca_stream on public.subject_class_assignments(stream_id);

-- Drop the old single-column-pair unique constraint (auto-named by Postgres)
-- if it's still there — it would otherwise block a stream-specific row from
-- coexisting with a class-wide row for the same subject.
alter table public.subject_class_assignments
  drop constraint if exists subject_class_assignments_subject_id_class_id_key;

drop index if exists idx_sca_unique_classwide;
drop index if exists idx_sca_unique_stream;
create unique index idx_sca_unique_classwide on public.subject_class_assignments(subject_id, class_id) where stream_id is null;
create unique index idx_sca_unique_stream on public.subject_class_assignments(subject_id, class_id, stream_id) where stream_id is not null;
