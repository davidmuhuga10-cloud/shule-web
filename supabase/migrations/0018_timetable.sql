-- ============================================================================
-- 0018_timetable.sql — Round 4 §7: the Timetable module (built per the
-- research/design proposal delivered separately — Timetable_Module_
-- Research_and_Design_Proposal.docx). Adds everything the module needs:
--
--   - Two nullable columns on the EXISTING subject_class_assignments table
--     (periods_per_week, is_double) instead of a new "requirements" table —
--     that table is already the per-class/per-stream "which subjects does
--     this group study" record (see assignments.mjs), so how many periods a
--     week each one needs is just more facts about the same row, not a new
--     concept. A null periods_per_week means "not configured" — the
--     generator falls back to a sensible default (see generate.mjs) rather
--     than requiring every subject to be configured before anything works.
--   - public.rooms — a school's physical teaching spaces. Entirely optional
--     to use: a school that never adds a room just never gets room-clash
--     checking, everything else works the same.
--   - public.timetable_periods — the school's own daily period structure
--     (Period 1 08:00-08:40, Break, Period 2 ..., Lunch, ...). Deliberately
--     ONE template that repeats across every teaching day the school runs
--     (which days those are lives in the existing `settings` key/value
--     table as `timetable_days`, e.g. "Mon,Tue,Wed,Thu,Fri" — no schema
--     change needed for that), not a separate grid per day — the vast
--     majority of schools run the same period times every day, and forcing
--     a from-scratch grid per day would make setup far more tedious for no
--     real benefit. A school with a genuinely different Friday schedule is
--     a documented, deliberate v1 limitation, not an oversight.
--   - public.teacher_unavailability — specific (day, period) slots a
--     teacher can't be scheduled in (part-time hours, other commitments).
--     Empty by default = fully available, so most teachers need zero setup.
--   - public.timetable_entries — the actual generated/edited lesson
--     placements, scoped by (academic_year_id, term_id). Always tied to a
--     specific STREAM, never "whole class" — every class already has at
--     least one arm/stream (Round 3 §17 made that a hard invariant), so
--     there is no genuinely streamless case left to model, and skipping it
--     avoids an entire class of nullable-stream ambiguity the rest of the
--     schema (e.g. subject_class_assignments) has to carry for legacy
--     reasons. Regenerating a timetable for the same (year, term) replaces
--     its rows rather than versioning them — one live timetable per term is
--     what a school actually needs day to day, not a version history.
--
-- Hard scheduling constraints (a stream/teacher/room in one slot at once)
-- are enforced by BOTH the application (generate.mjs / the manual editor)
-- AND partial unique indexes here, the same defense-in-depth convention
-- every other "never trust the client alone" rule in this schema follows.
--
-- Safe to paste as a single script. Idempotent: `create table if not
-- exists` / `add column if not exists` make re-running this file against a
-- database that already has it applied a no-op.
-- ============================================================================

alter table public.subject_class_assignments
  add column if not exists periods_per_week integer,
  add column if not exists is_double boolean not null default false;

-- ----------------------------------------------------------------------------
-- rooms
-- ----------------------------------------------------------------------------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  capacity integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_rooms_updated_at') then
    create trigger trg_rooms_updated_at before update on public.rooms
      for each row execute function public.set_updated_at();
  end if;
end $$;
create index if not exists idx_rooms_school on public.rooms(school_id);
create unique index if not exists idx_rooms_unique_name on public.rooms(school_id, name);

-- ----------------------------------------------------------------------------
-- timetable_periods — one school-wide daily template
-- ----------------------------------------------------------------------------
create table if not exists public.timetable_periods (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  period_index integer not null,
  start_time text not null,   -- 'HH:MM', plain text like every other time-of-day value in this schema (see printHeader.mjs's addressLines convention of keeping display-only values as text)
  end_time text not null,
  is_break boolean not null default false,
  label text,                 -- optional override, e.g. "Break" / "Lunch" / "Period 1" — blank falls back to "Period <n>" in the UI
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_timetable_periods_updated_at') then
    create trigger trg_timetable_periods_updated_at before update on public.timetable_periods
      for each row execute function public.set_updated_at();
  end if;
end $$;
create index if not exists idx_tt_periods_school on public.timetable_periods(school_id);
create unique index if not exists idx_tt_periods_unique_index on public.timetable_periods(school_id, period_index);

-- ----------------------------------------------------------------------------
-- teacher_unavailability
-- ----------------------------------------------------------------------------
create table if not exists public.teacher_unavailability (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  day_of_week smallint not null,   -- 1=Mon .. 6=Sat
  period_index integer not null,
  created_at timestamptz not null default now(),
  constraint teacher_unavailability_day_check check (day_of_week between 1 and 6)
);
create index if not exists idx_tt_unavail_school on public.teacher_unavailability(school_id);
create index if not exists idx_tt_unavail_staff on public.teacher_unavailability(staff_id);
create unique index if not exists idx_tt_unavail_unique on public.teacher_unavailability(staff_id, day_of_week, period_index);

-- ----------------------------------------------------------------------------
-- timetable_entries — the actual placed lessons
-- ----------------------------------------------------------------------------
create table if not exists public.timetable_entries (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  day_of_week smallint not null,
  period_index integer not null,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  stream_id uuid not null references public.streams(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  room_id uuid references public.rooms(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timetable_entries_day_check check (day_of_week between 1 and 6)
);
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_timetable_entries_updated_at') then
    create trigger trg_timetable_entries_updated_at before update on public.timetable_entries
      for each row execute function public.set_updated_at();
  end if;
end $$;
create index if not exists idx_tt_entries_school on public.timetable_entries(school_id);
create index if not exists idx_tt_entries_scope on public.timetable_entries(academic_year_id, term_id);
create index if not exists idx_tt_entries_class on public.timetable_entries(class_id);
create index if not exists idx_tt_entries_stream on public.timetable_entries(stream_id);
create index if not exists idx_tt_entries_staff on public.timetable_entries(staff_id);
-- One lesson per stream per slot — always (every timetable_entries row is
-- stream-specific, see the header note above).
create unique index if not exists idx_tt_entries_unique_stream_slot
  on public.timetable_entries(academic_year_id, term_id, day_of_week, period_index, stream_id);
-- A teacher can't teach two lessons in the same slot — only enforced when a
-- teacher is actually set (a lesson can be entered with staff_id null, e.g.
-- a placeholder to fill in later).
create unique index if not exists idx_tt_entries_unique_staff_slot
  on public.timetable_entries(academic_year_id, term_id, day_of_week, period_index, staff_id) where staff_id is not null;
-- Same idea for rooms, only enforced when a room is actually set.
create unique index if not exists idx_tt_entries_unique_room_slot
  on public.timetable_entries(academic_year_id, term_id, day_of_week, period_index, room_id) where room_id is not null;

-- ----------------------------------------------------------------------------
-- auto-stamp school_id (same convention as every other tenant table)
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_rooms_school_id') then
    create trigger trg_rooms_school_id before insert on public.rooms
      for each row execute function public.set_school_id();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_timetable_periods_school_id') then
    create trigger trg_timetable_periods_school_id before insert on public.timetable_periods
      for each row execute function public.set_school_id();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_teacher_unavailability_school_id') then
    create trigger trg_teacher_unavailability_school_id before insert on public.teacher_unavailability
      for each row execute function public.set_school_id();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_timetable_entries_school_id') then
    create trigger trg_timetable_entries_school_id before insert on public.timetable_entries
      for each row execute function public.set_school_id();
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- RLS — same shape as every other module: everyone signed in at the school
-- can read (a teacher needs to see the whole school's timetable, not just
-- their own lessons, to know who's free to cover/swap); only staff can
-- write; only an admin can delete. Same as exams_read/exams_staff_write.
-- ----------------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.timetable_periods enable row level security;
alter table public.teacher_unavailability enable row level security;
alter table public.timetable_entries enable row level security;

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms for select
  using (school_id = public.current_school_id());
drop policy if exists rooms_admin_write on public.rooms;
create policy rooms_admin_write on public.rooms for insert
  with check (public.is_admin() and school_id = public.current_school_id());
drop policy if exists rooms_admin_update on public.rooms;
create policy rooms_admin_update on public.rooms for update
  using (public.is_admin() and school_id = public.current_school_id());
drop policy if exists rooms_admin_delete on public.rooms;
create policy rooms_admin_delete on public.rooms for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists timetable_periods_read on public.timetable_periods;
create policy timetable_periods_read on public.timetable_periods for select
  using (school_id = public.current_school_id());
drop policy if exists timetable_periods_admin_write on public.timetable_periods;
create policy timetable_periods_admin_write on public.timetable_periods for insert
  with check (public.is_admin() and school_id = public.current_school_id());
drop policy if exists timetable_periods_admin_update on public.timetable_periods;
create policy timetable_periods_admin_update on public.timetable_periods for update
  using (public.is_admin() and school_id = public.current_school_id());
drop policy if exists timetable_periods_admin_delete on public.timetable_periods;
create policy timetable_periods_admin_delete on public.timetable_periods for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists teacher_unavailability_read on public.teacher_unavailability;
create policy teacher_unavailability_read on public.teacher_unavailability for select
  using (school_id = public.current_school_id());
drop policy if exists teacher_unavailability_staff_write on public.teacher_unavailability;
create policy teacher_unavailability_staff_write on public.teacher_unavailability for insert
  with check (public.is_staff() and school_id = public.current_school_id());
drop policy if exists teacher_unavailability_staff_delete on public.teacher_unavailability;
create policy teacher_unavailability_staff_delete on public.teacher_unavailability for delete
  using (public.is_staff() and school_id = public.current_school_id());

drop policy if exists timetable_entries_read on public.timetable_entries;
create policy timetable_entries_read on public.timetable_entries for select
  using (school_id = public.current_school_id());
drop policy if exists timetable_entries_staff_write on public.timetable_entries;
create policy timetable_entries_staff_write on public.timetable_entries for insert
  with check (public.is_staff() and school_id = public.current_school_id());
drop policy if exists timetable_entries_staff_update on public.timetable_entries;
create policy timetable_entries_staff_update on public.timetable_entries for update
  using (public.is_staff() and school_id = public.current_school_id());
drop policy if exists timetable_entries_staff_delete on public.timetable_entries;
create policy timetable_entries_staff_delete on public.timetable_entries for delete
  using (public.is_staff() and school_id = public.current_school_id());
