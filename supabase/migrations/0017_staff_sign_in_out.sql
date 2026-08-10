-- ============================================================================
-- 0017_staff_sign_in_out.sql — Round 3 §19: "Add a new feature under the
-- Attendance module for staff sign-in and sign-out, capturing the actual
-- time of each... The system should automatically flag staff who signed in
-- late or left early, based on [admin-]set [expected] times."
--
-- Adds two nullable `time` columns to the existing public.staff_attendance
-- table (already keyed one row per staff member per day) — no new table,
-- since a day's sign-in/out times are just more facts about that same
-- (staff_id, date) row the present/absent/late/excused status already
-- lives on.
--
-- The "expected arrival/departure time" the admin sets, and the late/early
-- flag derived from it, are deliberately NOT part of this migration:
--   - Expected times are two more rows in the existing `settings`
--     key/value table (staff_expected_arrival_time / staff_expected_
--     departure_time) — no schema change needed for that at all.
--   - The late/early flag is computed at READ time (see
--     src/lib/staffAttendance.mjs) against whatever the expected times
--     currently are, not stored — so changing the expected times later
--     reclassifies every already-recorded day consistently, rather than
--     leaving old rows stamped against a since-changed cutoff.
--
-- Safe to paste as a single script. Idempotent: `add column if not exists`
-- makes re-running this file against a database that already has it applied
-- a no-op.
-- ============================================================================

alter table public.staff_attendance
  add column if not exists sign_in_time time,
  add column if not exists sign_out_time time;
