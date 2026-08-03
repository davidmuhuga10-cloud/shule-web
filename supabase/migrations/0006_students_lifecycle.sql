-- ============================================================================
-- 0006_students_lifecycle.sql — Phase 2b (school side): archive instead of
-- hard-delete, plus a bulk "move students" helper.
--
-- Today, removing a student from the roster is a hard DELETE — it cascades
-- away their results, attendance, and parent links permanently. That's the
-- wrong default for the single most common real-world case: a student
-- transferred, graduated, or withdrew, and the school still wants their
-- historical records intact for reference, just off the active roster.
--
-- This migration widens `students.status` from the shared 'active'/
-- 'inactive' row_status enum (also used, with different meaning, by staff
-- and parent accounts) into its own plain text column with a dedicated
-- check constraint, adding a third value — 'left' — plus a reason/date/
-- notes for it. A genuine "permanently delete" path still exists
-- (students.mjs's remove(), unchanged) for actual mistakes (e.g. a
-- duplicate/test record); archive() is the new default for every real
-- "this student left" case.
--
-- Plain text + check constraint, not `alter type ... add value` on an
-- existing enum — no transaction-hazard splitting needed here (that hazard
-- is specific to adding a value to an ALREADY-EXISTING enum type; this
-- migration doesn't touch the row_status enum at all, it moves this one
-- column off it entirely). Safe to run as a single paste in the SQL Editor.
-- ============================================================================

alter table public.students alter column status type text using status::text;
alter table public.students alter column status set default 'active';

-- Defensive normalization before the new constraint goes on: nothing in the
-- app has ever set a student's status to 'inactive' (that's only ever been
-- used for staff/parent login accounts), so in practice every existing
-- student row is already 'active' — this just guarantees the constraint
-- below can never fail on real data, without assuming that.
update public.students set status = 'active' where status not in ('active', 'left');

do $$ begin
  alter table public.students add constraint students_status_check check (status in ('active', 'left'));
exception when duplicate_object then null;
end $$;

alter table public.students add column if not exists left_reason text;
do $$ begin
  alter table public.students add constraint students_left_reason_check
    check (left_reason is null or left_reason in ('transferred', 'graduated', 'withdrawn', 'other'));
exception when duplicate_object then null;
end $$;
alter table public.students add column if not exists left_date date;
alter table public.students add column if not exists left_notes text;

-- Nothing else to backfill — an archived student automatically drops out of
-- students.list()'s default ('active'-only) view and out of
-- get_report_card()'s ranking cohort (which already filters on
-- st.status = 'active'), with zero further schema changes needed.
