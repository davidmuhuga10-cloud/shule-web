-- ============================================================================
-- 0024_timetable_constraints.sql — Round 2 §7 (Timetable redesign): a new
-- Constraints module for the Timetable generator, per the brief's explicit
-- instruction to "research real scheduling practices used by schools before
-- finalizing the constraint set" (see generate.mjs's header comment for the
-- research sources — FET's manual and a published school-timetabling
-- consultancy's hard/soft constraint list).
--
-- One table, `timetable_constraints`, holding every constraint a school has
-- configured — `type` picks which of 6 supported constraint kinds a row is,
-- `config` (jsonb) holds that type's own parameters, `enabled` lets a school
-- turn one off without losing its configuration. A school can have several
-- rows of the same type (e.g. more than one "these two subjects should
-- never be back-to-back" pair); the four types that are naturally singleton
-- school-wide settings (avoid_consecutive_intensive, pe_before_break,
-- max_consecutive_periods_class, max_consecutive_periods_teacher) are just
-- managed as one row each by the application layer (Db.timetable.
-- constraints.save upserts by type for those) rather than a DB-level
-- uniqueness constraint, since "exactly one row" isn't true for every type.
--
-- The 6 constraint types (brief's own 4 examples, plus 2 more identified
-- during the research the brief asked for — see generate.mjs):
--   1. subject_pair_not_consecutive     — config: {subject_a, subject_b}
--   2. avoid_consecutive_intensive      — config: {subject_ids: [...]}
--   3. teacher_no_immediate_after_out   — config: {} (just enabled/off)
--   4. pe_before_break                  — config: {subject_ids: [...]}
--   5. max_consecutive_periods_class    — config: {max: <int>}
--   6. max_consecutive_periods_teacher  — config: {max: <int>}
--
-- All 6 are treated as SOFT constraints by the placement engine (see
-- generate.mjs) — tried first, relaxed one group at a time only if that's
-- the sole way to fit everything the school has configured into the week,
-- exactly the same "never silently drop a hard requirement, but don't let
-- a preference block an otherwise-fittable timetable either" philosophy the
-- engine already used for its one pre-existing soft constraint (no same
-- subject twice a day for the same stream).
--
-- Safe to paste as a single script. Idempotent — re-running this after it
-- already applied is a no-op.
-- ============================================================================

create table if not exists public.timetable_constraints (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  type text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timetable_constraints_type_check check (type in (
    'subject_pair_not_consecutive', 'avoid_consecutive_intensive', 'teacher_no_immediate_after_out',
    'pe_before_break', 'max_consecutive_periods_class', 'max_consecutive_periods_teacher'
  ))
);
create index if not exists idx_timetable_constraints_school on public.timetable_constraints(school_id);
create index if not exists idx_timetable_constraints_type on public.timetable_constraints(school_id, type);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_timetable_constraints_updated_at') then
    create trigger trg_timetable_constraints_updated_at before update on public.timetable_constraints
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_timetable_constraints_school_id') then
    create trigger trg_timetable_constraints_school_id before insert on public.timetable_constraints
      for each row execute function public.set_school_id();
  end if;
end $$;

alter table public.timetable_constraints enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'timetable_constraints_read') then
    create policy timetable_constraints_read on public.timetable_constraints for select
      using (school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'timetable_constraints_admin_write') then
    create policy timetable_constraints_admin_write on public.timetable_constraints for insert
      with check (public.is_admin() and school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'timetable_constraints_admin_update') then
    create policy timetable_constraints_admin_update on public.timetable_constraints for update
      using (public.is_admin() and school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'timetable_constraints_admin_delete') then
    create policy timetable_constraints_admin_delete on public.timetable_constraints for delete
      using (public.is_admin() and school_id = public.current_school_id());
  end if;
end $$;
