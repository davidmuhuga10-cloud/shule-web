-- ============================================================================
-- 0040_consolidated_exams.sql — the "Consolidated Exam" feature that was
-- explicitly put on hold when the Zeraki-style exam_type vocabulary was
-- introduced (0012_exam_workflow_v2): "'consolidated' is a real exam type an
-- admin can pick, but its actual merge-logic is out of scope... a separate
-- feature to be scoped in detail later." This is that feature.
--
-- What it does, in one sentence: a Consolidated Exam has no marks entered
-- against it directly — instead an admin names 2+ existing exams (e.g.
-- Opener, Midterm, Endterm) as its "components", each with an optional
-- weight, and a "Recompute" action (src/lib/api/results.mjs's
-- recomputeConsolidated()) averages every student's per-subject score
-- across those components and writes the result into this exam's own
-- `results` rows via the EXISTING save_results_batch() RPC — the exact same
-- path Marks Entry and Bulk Upload already use. Deliberately not a new RPC
-- function: once `results` rows exist for the consolidated exam, Review &
-- Publish, report cards, broadsheets, and exam analysis all work completely
-- unchanged, because none of them care HOW a result row was produced.
--
-- What this migration adds:
--   1. exam_components — one row per (consolidated exam, component exam),
--      carrying that component's weight in the average.
--   2. A guard trigger blocking the two ways this table could otherwise be
--      misused: nesting a consolidated exam inside another one, and
--      attaching a component to something that isn't actually a
--      consolidated exam in the first place.
--   3. RLS: identical shape to exam_classes/subject_combinations — anyone in
--      the school can read, only an admin can write.
-- ============================================================================

begin;

create table if not exists public.exam_components (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,           -- the consolidated exam
  component_exam_id uuid not null references public.exams(id) on delete cascade, -- one exam being folded into it
  weight numeric not null default 1,
  created_at timestamptz not null default now(),
  unique (exam_id, component_exam_id),
  check (exam_id <> component_exam_id),
  check (weight > 0)
);
create index if not exists idx_exam_components_exam on public.exam_components(exam_id);
create index if not exists idx_exam_components_component on public.exam_components(component_exam_id);
create index if not exists idx_exam_components_school on public.exam_components(school_id);

-- Guard rail: a component must be a real, non-consolidated exam in the same
-- school, and the exam it's being attached to must actually BE a
-- consolidated exam — otherwise "component exams" could silently attach to
-- a normal exam, or a consolidated exam could nest another one (which would
-- make recomputeConsolidated()'s averaging ambiguous about which layer's
-- weights apply, so it's simplest to just disallow it outright, matching
-- the original brief's "combine two or more exams" — plural EXISTING
-- (i.e. non-consolidated) exams, not a tree of them).
create or replace function public.check_exam_component()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_component_type text;
  v_component_school uuid;
  v_exam_type text;
  v_exam_school uuid;
begin
  select exam_type, school_id into v_exam_type, v_exam_school from public.exams where id = new.exam_id;
  if v_exam_type is null then
    raise exception 'Exam not found.';
  end if;
  if v_exam_type is distinct from 'consolidated' then
    raise exception 'Only a Consolidated Exam can have component exams.';
  end if;

  select exam_type, school_id into v_component_type, v_component_school from public.exams where id = new.component_exam_id;
  if v_component_type is null then
    raise exception 'Component exam not found.';
  end if;
  if v_component_type = 'consolidated' then
    raise exception 'A consolidated exam cannot combine another consolidated exam.';
  end if;
  if v_component_school is distinct from v_exam_school then
    raise exception 'Component exam must belong to the same school.';
  end if;
  if new.school_id is distinct from v_exam_school then
    raise exception 'Component exam must belong to the same school.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_check_exam_component on public.exam_components;
create trigger trg_check_exam_component before insert or update on public.exam_components
  for each row execute function public.check_exam_component();

alter table public.exam_components enable row level security;

drop policy if exists exam_components_read on public.exam_components;
create policy exam_components_read on public.exam_components for select
  using (school_id = public.current_school_id());

drop policy if exists exam_components_admin_write on public.exam_components;
create policy exam_components_admin_write on public.exam_components for insert
  with check (public.is_admin() and school_id = public.current_school_id());

drop policy if exists exam_components_admin_delete on public.exam_components;
create policy exam_components_admin_delete on public.exam_components for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists exam_components_admin_update on public.exam_components;
create policy exam_components_admin_update on public.exam_components for update
  using (public.is_admin() and school_id = public.current_school_id())
  with check (public.is_admin() and school_id = public.current_school_id());

commit;
