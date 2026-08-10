-- ============================================================================
-- 0019_timetable_fixes.sql — fixes to the Timetable module (0018_timetable.sql)
-- based on real usage feedback:
--
--   1. "Double lessons?" was a plain yes/no per subject, which auto-doubled
--      every possible pair of periods. A school might want e.g. Math to
--      have exactly 3 double lessons a week and the rest as singles, not
--      "as many doubles as will fit." subject_class_assignments.is_double
--      (boolean) is replaced with double_periods_per_week (integer count).
--      Existing is_double=true rows are migrated to a sensible starting
--      count (as many doubles as their periods_per_week could hold) rather
--      than silently losing that setting — a school can then adjust the
--      exact number in Setup > Subject Periods & Double Lessons.
--   2. Some schools teach on Sunday too. day_of_week was constrained to
--      1-6 (Mon-Sat) on teacher_unavailability and timetable_entries;
--      widened to 1-7 (Mon-Sun) so Sunday can be picked as a teaching day
--      (Setup > Teaching Days & Periods) and used everywhere else that
--      already depends on day_of_week.
--
-- Safe to paste as a single script. Idempotent — re-running this after it
-- already applied is a no-op (the column-add/constraint-drop steps all
-- check for existing state first).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Double lessons: yes/no -> a count
-- ----------------------------------------------------------------------------
alter table public.subject_class_assignments
  add column if not exists double_periods_per_week integer not null default 0;

do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subject_class_assignments' and column_name = 'is_double') then
    update public.subject_class_assignments
      set double_periods_per_week = greatest(0, floor(coalesce(periods_per_week, 5) / 2)::integer)
      where is_double = true and double_periods_per_week = 0;
    alter table public.subject_class_assignments drop column is_double;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Widen day_of_week to include Sunday (1=Mon .. 7=Sun)
-- ----------------------------------------------------------------------------
alter table public.teacher_unavailability drop constraint if exists teacher_unavailability_day_check;
alter table public.teacher_unavailability add constraint teacher_unavailability_day_check check (day_of_week between 1 and 7);

alter table public.timetable_entries drop constraint if exists timetable_entries_day_check;
alter table public.timetable_entries add constraint timetable_entries_day_check check (day_of_week between 1 and 7);
