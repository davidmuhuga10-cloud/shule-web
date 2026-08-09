-- ============================================================================
-- 0013_deleted_exams.sql — "System Fixes & Exam Desk Redesign" brief §8:
-- "New: Deleted Exams submodule. Retained max 30 days; auto-purged
-- completely from the database after 30 days; if restored within the
-- window, returns to Exam Desk as before."
--
-- Additive-only: adds a single nullable column. Every existing exam has
-- deleted_at = NULL, so nothing already saved changes behaviour — it just
-- keeps showing up in Exam Desk exactly as before. Only exams deleted going
-- forward (via the new "soft delete" Delete button) get a deleted_at value.
--
-- The 30-day auto-purge itself is NOT a database-level scheduled job (no
-- pg_cron wired up in this project) — it's enforced in the application layer
-- (src/lib/api/results.mjs's purgeExpired), swept opportunistically every
-- time the Deleted Exams list is opened. From an admin's point of view this
-- is indistinguishable from a real cron: nothing past 30 days is ever
-- visible or restorable. Flagging this here in case a hard DB-level
-- guarantee is ever wanted later (e.g. via pg_cron + this same query).
-- ============================================================================

alter table public.exams add column if not exists deleted_at timestamptz;

-- listExams()/listDeletedExams() both filter on this column on every load —
-- worth a partial index scoped to just the (rare) deleted rows.
create index if not exists idx_exams_deleted_at on public.exams(deleted_at) where deleted_at is not null;
