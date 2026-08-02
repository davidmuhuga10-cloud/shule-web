-- ============================================================================
-- HISTORICAL — this migration predates multi-tenancy and has already been
-- applied to the one live Shule project. If you're upgrading that project
-- to the current multi-tenant schema, use migrations/0002_multi_tenant.sql
-- instead (it assumes everything below is already in place). Kept here only
-- as a record of what changed between the very first schema.sql and the
-- single-tenant version that was live just before the multi-tenant move.
-- ============================================================================
--
-- ONLY run this if you already executed the Phase 1 schema.sql on a live
-- Supabase project before this update. If you haven't run schema.sql yet (or
-- are starting on a fresh project), ignore this file — just run the current
-- schema.sql + seed.sql as normal; they already include everything below.
-- ============================================================================
-- What changed since Phase 1, and why:
--   1. academic_years.status and terms.status were 'active'/'inactive' only,
--      but the app needs a 3-state lifecycle (upcoming/active/archived) to
--      support "mark one active, the rest auto-archive" — same behaviour the
--      Apps Script version had. New type: lifecycle_status.
--   2. exams.status doesn't have fixed states in the app logic, so it's now
--      plain text (default 'open') instead of being forced into the same
--      2-state enum.
--   3. settings is now readable by anyone, even logged out — the login
--      screen shows your school name/logo before sign-in.
--   4. Added get_report_card(): a security-definer function so a student can
--      see their own class position without Row-Level Security exposing
--      classmates' scores to them.
-- ============================================================================

do $$ begin
  create type lifecycle_status as enum ('upcoming', 'active', 'archived');
exception when duplicate_object then null;
end $$;

alter table public.academic_years alter column status drop default;
alter table public.academic_years alter column status type lifecycle_status using (
  case when status::text = 'active' then 'active' else 'upcoming' end
)::lifecycle_status;
alter table public.academic_years alter column status set default 'upcoming';

alter table public.terms alter column status drop default;
alter table public.terms alter column status type lifecycle_status using (
  case when status::text = 'active' then 'active' else 'upcoming' end
)::lifecycle_status;
alter table public.terms alter column status set default 'upcoming';

alter table public.exams alter column status drop default;
alter table public.exams alter column status type text using status::text;
alter table public.exams alter column status set default 'open';

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select using (true);

-- Re-run just the get_report_card() function + grant from the bottom of the
-- current schema.sql (search for "get_report_card RPC") — copy that whole
-- section here, it's safe to `create or replace` on top of nothing.
