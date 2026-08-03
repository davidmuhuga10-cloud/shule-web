-- ============================================================================
-- 0010_exam_classes.sql — Phase 2h: explicit per-exam class selection
-- (brief §7.1 — "creating an exam, admin should be prompted to select which
-- classes are sitting it").
--
-- Before this migration, "which classes belong to an exam" was purely
-- implicit — derived from whichever classes happened to have marks entered
-- for it (see the old listExamClasses()). That meant a freshly-created exam
-- showed no classes at all until someone started entering marks, instead of
-- Zeraki-style upfront visibility of every selected class with a status like
-- "Results Not Uploaded".
--
-- exam_classes is a simple join table: which classes were chosen to sit a
-- given exam. Nothing about marks entry or publishing keys off this table —
-- those still work exactly as before via `results`/`result_submissions`,
-- scoped by (exam_id, class_id) — this table only answers "should this class
-- show up on the exam's board at all, even with zero marks yet."
--
-- Safe to paste as a single script. Idempotent: guarded the same way as
-- every other migration in this repo (IF NOT EXISTS / IF EXISTS / drop+
-- create for triggers and policies) so re-running this file is a no-op.
-- ============================================================================

create table if not exists public.exam_classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (exam_id, class_id)
);
create index if not exists idx_exam_classes_school on public.exam_classes(school_id);
create index if not exists idx_exam_classes_exam on public.exam_classes(exam_id);

drop trigger if exists trg_exam_classes_school_id on public.exam_classes;
create trigger trg_exam_classes_school_id before insert on public.exam_classes
  for each row execute function public.set_school_id();

alter table public.exam_classes enable row level security;

drop policy if exists exam_classes_read on public.exam_classes;
create policy exam_classes_read on public.exam_classes for select
  using (school_id = public.current_school_id());
drop policy if exists exam_classes_admin_write on public.exam_classes;
create policy exam_classes_admin_write on public.exam_classes for insert
  with check (public.is_admin() and school_id = public.current_school_id());
drop policy if exists exam_classes_admin_delete on public.exam_classes;
create policy exam_classes_admin_delete on public.exam_classes for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- Backfill: every exam that already has marks recorded for a class gets that
-- class auto-added here, so existing exams don't suddenly show zero classes
-- the moment this migration runs.
insert into public.exam_classes (school_id, exam_id, class_id)
select distinct r.school_id, r.exam_id, r.class_id
from public.results r
where r.class_id is not null
on conflict (exam_id, class_id) do nothing;
