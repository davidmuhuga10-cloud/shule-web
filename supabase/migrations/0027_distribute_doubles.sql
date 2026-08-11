-- 0027_distribute_doubles.sql
-- Round 6 §4 (new Timetable constraint): "double lessons should be
-- distributed across the week and should not directly follow one another
-- where it can be avoided" — reported bug: a school's Wednesday ended up
-- almost entirely double lessons back-to-back, all day.
--
-- Unlike the 6 existing constraint types (opt-in — a school must open the
-- Constraints screen and turn one on), this one is seeded ENABLED for
-- every existing school here, and seed_school_defaults() (this migration's
-- companion change, applied directly on schema.sql for fresh installs) now
-- seeds it for every new school too. The clustering it prevents is never
-- something a school actually wants, so there's no reason to make anyone
-- discover and turn it on themselves.

-- Allow the new type through the same check constraint every other
-- constraint type is validated against.
alter table public.timetable_constraints drop constraint if exists timetable_constraints_type_check;
alter table public.timetable_constraints add constraint timetable_constraints_type_check check (type in (
  'subject_pair_not_consecutive', 'avoid_consecutive_intensive', 'teacher_no_immediate_after_out',
  'pe_before_break', 'max_consecutive_periods_class', 'max_consecutive_periods_teacher',
  'distribute_doubles'
));

-- Backfill: every existing school gets this enabled by default, unless it
-- already somehow has a row for this type (safe to re-run this migration).
insert into public.timetable_constraints (school_id, type, enabled, config)
select s.id, 'distribute_doubles', true, '{}'::jsonb
from public.schools s
where not exists (
  select 1 from public.timetable_constraints tc
  where tc.school_id = s.id and tc.type = 'distribute_doubles'
);
