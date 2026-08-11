-- ============================================================================
-- 0023_subject_combination.sql — Round 2 §3: "Subject Combination Module".
--
--   "Add a new module under Exams module, working similarly to Learning
--   Area Papers but in the opposite direction: instead of splitting one
--   subject into papers, this combines two or more separate subjects into
--   a single result. Example: Social Studies and CRE combined and returned
--   as one combined result and the school decide the name of it. Support
--   ratio/weighting between the combined subjects, the same way papers use
--   ratios. Let the school build this combination from subjects that
--   already exist in the system, rather than creating new subject
--   entries."
--
-- Two new tables, same conventions as subject_papers/exam_classes (a
-- denormalized school_id on every table, RLS admin-write/staff-read):
--
--   subject_combinations         — one row per combo: which exam, its
--                                   school-chosen name (e.g. "SST/CRE
--                                   Combined").
--   subject_combination_members  — which underlying subjects belong to a
--                                   combo, and each one's weight (0-1
--                                   fraction, same convention as
--                                   subject_papers.weight — the setup
--                                   screen collects/shows this as a 0-100
--                                   Ratio and converts it, exactly like
--                                   Learning Area Papers).
--
-- Scoped to ONE exam (not permanent/school-wide) for the same reason
-- Learning Area Papers is: a combination a school wants this term may not
-- make sense next term. A subject can only belong to ONE active
-- combination per exam — enforced in the application layer (academics.mjs)
-- since "not already used elsewhere in this exam" isn't expressible as a
-- single-table SQL constraint.
--
-- Marks are still entered per underlying subject exactly as before —
-- nothing about Marks Entry changes. Only the Mark List (getBroadsheet in
-- results.mjs) folds a combo's member subjects into one combined column
-- when building what's shown/exported, the same way it already folds a
-- subject's papers into one column.
--
-- Safe to paste as a single script. Idempotent — re-running this after it
-- already applied is a no-op.
-- ============================================================================

create table if not exists public.subject_combinations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_subject_combinations_exam on public.subject_combinations(exam_id);
create index if not exists idx_subject_combinations_school on public.subject_combinations(school_id);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_subject_combinations_updated_at') then
    create trigger trg_subject_combinations_updated_at before update on public.subject_combinations
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_subject_combinations_school_id') then
    create trigger trg_subject_combinations_school_id before insert on public.subject_combinations
      for each row execute function public.set_school_id();
  end if;
end $$;

create table if not exists public.subject_combination_members (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  combination_id uuid not null references public.subject_combinations(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  weight numeric not null default 1,
  created_at timestamptz not null default now(),
  unique (combination_id, subject_id)
);
create index if not exists idx_subject_combination_members_combo on public.subject_combination_members(combination_id);
create index if not exists idx_subject_combination_members_subject on public.subject_combination_members(subject_id);
create index if not exists idx_subject_combination_members_school on public.subject_combination_members(school_id);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_subject_combination_members_school_id') then
    create trigger trg_subject_combination_members_school_id before insert on public.subject_combination_members
      for each row execute function public.set_school_id();
  end if;
end $$;

alter table public.subject_combinations enable row level security;
alter table public.subject_combination_members enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'subject_combinations_read') then
    create policy subject_combinations_read on public.subject_combinations for select
      using (school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'subject_combinations_admin_write') then
    create policy subject_combinations_admin_write on public.subject_combinations for insert
      with check (public.is_admin() and school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'subject_combinations_admin_update') then
    create policy subject_combinations_admin_update on public.subject_combinations for update
      using (public.is_admin() and school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'subject_combinations_admin_delete') then
    create policy subject_combinations_admin_delete on public.subject_combinations for delete
      using (public.is_admin() and school_id = public.current_school_id());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'subject_combination_members_read') then
    create policy subject_combination_members_read on public.subject_combination_members for select
      using (school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'subject_combination_members_admin_write') then
    create policy subject_combination_members_admin_write on public.subject_combination_members for insert
      with check (public.is_admin() and school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'subject_combination_members_admin_update') then
    create policy subject_combination_members_admin_update on public.subject_combination_members for update
      using (public.is_admin() and school_id = public.current_school_id());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'subject_combination_members_admin_delete') then
    create policy subject_combination_members_admin_delete on public.subject_combination_members for delete
      using (public.is_admin() and school_id = public.current_school_id());
  end if;
end $$;
