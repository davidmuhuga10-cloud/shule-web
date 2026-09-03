-- ============================================================================
-- Shule — Postgres schema for Supabase (multi-tenant)
-- ============================================================================
-- One Supabase project now serves EVERY school on the platform. Every table
-- that holds a school's own data carries a `school_id`, every Row-Level
-- Security policy is scoped by it, and a BEFORE INSERT trigger stamps it on
-- automatically from the signed-in user's own profile — so the application
-- code that reads/writes students, exams, results etc. did not have to
-- change at all; Postgres does the tenant isolation.
--
-- Run this once in the Supabase SQL editor (or via `supabase db push`) on a
-- brand-new project, BEFORE seed.sql. If you already ran an earlier
-- single-tenant version of this file against a live project, do NOT re-run
-- this file — use supabase/migrations/0002_multi_tenant.sql instead, which
-- upgrades an existing installation in place without losing data.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
-- 'parent' is included from the start here (unlike migration 0003a, which adds
-- it to an already-live database with ALTER TYPE ... ADD VALUE) because a
-- brand-new enum can just declare every value it will ever need up front —
-- there's no existing data or committed transaction to work around.
create type user_role as enum ('admin', 'teacher', 'student', 'parent');
create type row_status as enum ('active', 'inactive');
create type gender_t as enum ('Male', 'Female');
-- Academic years & terms have a 3-state lifecycle (only one row of each may
-- be 'active' at a time — enforced in the app layer, same as the Apps Script
-- version): a new one starts 'upcoming', is promoted to 'active', and moves
-- to 'archived' once superseded.
create type lifecycle_status as enum ('upcoming', 'active', 'archived');

-- ----------------------------------------------------------------------------
-- Generic updated_at trigger
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- schools — the tenant table. Every other table below belongs to exactly one
-- row here. `code` is the short, url/email-safe slug a user types on the
-- login screen ("School Code") and that student synthetic logins are scoped
-- by (see get_school_public_info() and studentEmail.shared.js) — it is
-- always stored lowercase so lookups are case-insensitive without needing
-- the citext extension.
-- ----------------------------------------------------------------------------
create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  status text not null default 'active',       -- active | suspended | trial — informational, no fixed enum
  -- Next Sprint 3 §1.2: asked once at sign-up ("Senior School" or "Pri &
  -- Jss") and never surfaced for editing afterward — it's not a runtime
  -- permission check, just which class-level list (see
  -- cbcDefaults.mjs's classLevelsForCategory()) and which subjects
  -- seed_school_defaults() below seeds for this school. Defaults to
  -- 'pri_jss' so every school that existed before this column did is
  -- unaffected.
  category text not null default 'pri_jss' check (category in ('pri_jss', 'senior')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schools_code_format check (code ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$')
);
create trigger trg_schools_updated_at before update on public.schools
  for each row execute function public.set_updated_at();

create or replace function public.normalize_school_code()
returns trigger
language plpgsql
as $$
begin
  new.code := lower(trim(new.code));
  return new;
end;
$$;
create trigger trg_schools_normalize_code before insert or update on public.schools
  for each row execute function public.normalize_school_code();

-- ----------------------------------------------------------------------------
-- staff
-- ----------------------------------------------------------------------------
create table public.staff (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  role text not null default 'teacher',        -- e.g. teacher, admin-staff
  gender gender_t,
  qualifications text,
  employment_start_date date,
  status row_status not null default 'active',
  -- Richer HR bio-data (Phase 2c) — all optional, filled in as convenient.
  date_of_birth date,
  national_id text,
  tsc_number text,
  next_of_kin_name text,
  next_of_kin_contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, email)
);
create trigger trg_staff_updated_at before update on public.staff
  for each row execute function public.set_updated_at();
create index idx_staff_school on public.staff(school_id);

-- ----------------------------------------------------------------------------
-- academic_years (was "sessions")  +  terms
-- ----------------------------------------------------------------------------
create table public.academic_years (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,                          -- e.g. '2026'
  start_date date,
  end_date date,
  status lifecycle_status not null default 'upcoming',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_academic_years_updated_at before update on public.academic_years
  for each row execute function public.set_updated_at();
create index idx_academic_years_school on public.academic_years(school_id);

create table public.terms (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  name text not null,                          -- 'Term 1' / 'Term 2' / 'Term 3'
  start_date date,
  end_date date,
  status lifecycle_status not null default 'upcoming',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (academic_year_id, name)
);
create trigger trg_terms_updated_at before update on public.terms
  for each row execute function public.set_updated_at();
create index idx_terms_school on public.terms(school_id);

-- 0038_auto_detect_current_term.sql (SignUp_Fixes §4): a small, easily
-- updatable reference table of real term date ranges per calendar year, so
-- seed_school_defaults() can work out which term is ACTUALLY current on the
-- day a new school signs up, instead of always assuming Term 1. Adding a
-- future year is a plain INSERT here — never a function/schema change.
create table public.term_date_reference (
  year int not null,
  term_name text not null check (term_name in ('Term 1', 'Term 2', 'Term 3')),
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  primary key (year, term_name)
);
alter table public.term_date_reference enable row level security;
create policy term_date_reference_read on public.term_date_reference
  for select to authenticated using (true);
insert into public.term_date_reference (year, term_name, start_date, end_date) values
  (2026, 'Term 1', '2026-01-01', '2026-04-26'),
  (2026, 'Term 2', '2026-04-27', '2026-08-23'),
  (2026, 'Term 3', '2026-08-24', '2026-12-29');

-- Given a year + term name, returns whether that term is 'upcoming', 'active',
-- or 'archived' relative to p_date — with a Term-1-active fallback for a year
-- nobody has added reference dates for yet.
create or replace function public.term_status_for(p_year int, p_term_name text, p_date date default current_date)
returns lifecycle_status
language plpgsql
stable
as $$
declare
  v_start date;
  v_end date;
begin
  select start_date, end_date into v_start, v_end
  from public.term_date_reference
  where year = p_year and term_name = p_term_name;

  if v_start is null then
    return case when p_term_name = 'Term 1' then 'active'::lifecycle_status else 'upcoming'::lifecycle_status end;
  end if;

  if p_date < v_start then return 'upcoming'::lifecycle_status;
  elsif p_date > v_end then return 'archived'::lifecycle_status;
  else return 'active'::lifecycle_status;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- classes + streams
-- ----------------------------------------------------------------------------
create table public.classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,                          -- e.g. 'Grade 7'
  level_order int not null default 0,          -- controls display/sort order
  description text,
  -- The "Class Teacher" step of the exam-publishing workflow (Phase 2) —
  -- nullable; a class with none set can only be approved by an admin (see
  -- is_class_teacher_of() below).
  class_teacher_staff_id uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_classes_updated_at before update on public.classes
  for each row execute function public.set_updated_at();
create index idx_classes_school on public.classes(school_id);

create table public.streams (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  name text not null,                          -- e.g. 'North'
  description text,
  -- Next Sprint 3 §1.3: "each Senior School student selects one of three
  -- pathways" — modelled here at the ARM/stream level (e.g. "Grade 11
  -- STEM"), consistent with how this app already assigns subjects per
  -- stream rather than per student (see assignments.mjs's header comment).
  -- Null for every non-Grade-10-12 stream (Pri/Jss, Form 3-4 have no
  -- pathway concept) and for a Grade 10-12 stream that hasn't been
  -- assigned one yet.
  pathway text check (pathway is null or pathway in ('STEM', 'Social Sciences', 'Arts and Sports Science')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, name)
);
create trigger trg_streams_updated_at before update on public.streams
  for each row execute function public.set_updated_at();
create index idx_streams_school on public.streams(school_id);

-- ----------------------------------------------------------------------------
-- subjects (CBC-aware)
-- ----------------------------------------------------------------------------
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  code text,
  level text,                                  -- 'Pre-Primary' | 'Lower Primary' | 'Upper Primary' | 'Junior Secondary' | 'Senior Secondary' | 'Form 3-4' | null (custom)
  -- Next Sprint 3 §1.3: only meaningful at level = 'Senior Secondary' — a
  -- specialised subject that belongs to one of the three pathways (e.g.
  -- Physics under STEM). Null for every core subject (taken by all
  -- pathways) and for every subject at any other level, including Form 3-4
  -- (8-4-4 has no pathway concept at all).
  pathway text check (pathway is null or pathway in ('STEM', 'Social Sciences', 'Arts and Sports Science')),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 0037_senior_school_mathematics_naming.sql: pathway is part of the
  -- uniqueness, not just (school_id, name, level) — "Essential Mathematics"
  -- is one name that legitimately exists twice at Senior Secondary level,
  -- once under Social Sciences and once under Arts and Sports Science.
  unique (school_id, name, level, pathway)
);
create trigger trg_subjects_updated_at before update on public.subjects
  for each row execute function public.set_updated_at();
create index idx_subjects_school on public.subjects(school_id);

-- Subject papers (e.g. English Paper 1 + Paper 2) — opt-in per subject, and
-- (0020_learning_area_papers.sql) scoped to one specific EXAM, not a
-- permanent property of the subject: a subject with zero rows here for a
-- given exam is scored as one combined mark, exactly as if this table
-- didn't exist for it. `weight` is this paper's share of the combined
-- subject score (a subject's papers for one exam should have weights
-- summing to 1) — the Learning Area Papers screen shows/collects this as a
-- 0-100 Ratio and converts it. The `exam_id` column itself is added further
-- down (see the note right after the `exams` table below) since it
-- references a table that doesn't exist yet at this point in the script.
create table public.subject_papers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  name text not null,
  paper_no int not null default 1,
  weight numeric not null default 1,
  out_of numeric not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_subject_papers_updated_at before update on public.subject_papers
  for each row execute function public.set_updated_at();
create index idx_subject_papers_school on public.subject_papers(school_id);
create index idx_subject_papers_subject on public.subject_papers(subject_id);

-- ----------------------------------------------------------------------------
-- students
-- ----------------------------------------------------------------------------
create table public.students (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  admission_no text not null,
  full_name text not null,
  gender gender_t not null,
  class_id uuid references public.classes(id) on delete set null,
  stream_id uuid references public.streams(id) on delete set null,
  guardian_name text,
  guardian_contact text,
  -- Deliberately plain text + its own check constraint, not row_status —
  -- students have a third lifecycle value ('left') that the shared
  -- active/inactive enum (used differently by staff/parent logins) doesn't
  -- carry. See migrations/0006_students_lifecycle.sql for the full reasoning.
  status text not null default 'active' check (status in ('active', 'left')),
  left_reason text check (left_reason is null or left_reason in ('transferred', 'graduated', 'withdrawn', 'other')),
  left_date date,
  left_notes text,
  -- Richer bio-data (Phase 2c) — all optional, filled in as convenient.
  date_of_birth date,
  admission_date date,
  upi_number text,
  assessment_number text,
  previous_school text,
  guardian_relationship text,
  guardian_id_number text,
  medical_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, admission_no)
);
create trigger trg_students_updated_at before update on public.students
  for each row execute function public.set_updated_at();
create index idx_students_school on public.students(school_id);

-- numeric-aware admission-number sort helper (mirrors admissionNumber_() in Academics.gs)
create or replace function public.admission_no_numeric(v text)
returns numeric
language sql
immutable
as $$
  select case
    when regexp_replace(coalesce(v, ''), '\D', '', 'g') = '' then 9007199254740991::numeric
    else regexp_replace(coalesce(v, ''), '\D', '', 'g')::numeric
  end;
$$;
create index idx_students_admission_numeric on public.students (school_id, public.admission_no_numeric(admission_no));

-- ----------------------------------------------------------------------------
-- profiles — 1:1 with auth.users, carries the app role + which school this
-- login belongs to. One auth user belongs to exactly one school.
-- ----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  email text,
  -- 'username' (first-name-based, e.g. "mercy") and 'phone' are the two
  -- alternate sign-in handles for admin/teacher accounts — see
  -- resolve_staff_login_email() below and studentEmail.shared.js's
  -- staffUsernameFor(). Both nullable (students/parents don't use them —
  -- students are frozen on admission-number login, parents sign in with
  -- their phone folded directly into their synthetic email instead).
  username text,
  phone text,
  role user_role not null default 'student',
  staff_id uuid references public.staff(id) on delete set null,
  student_id uuid references public.students(id) on delete set null,
  status row_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create index idx_profiles_school on public.profiles(school_id);
-- Partial (WHERE ... IS NOT NULL) so students/parents, which never set these,
-- don't collide with each other on a shared "null = null" uniqueness check.
create unique index idx_profiles_username_per_school on public.profiles(school_id, username) where username is not null;
create unique index idx_profiles_phone_per_school on public.profiles(school_id, phone) where phone is not null;

-- role/scope/tenant helpers — security definer so they can read profiles
-- regardless of the calling row's RLS (avoids recursive-policy problems on
-- profiles itself). These are the single source of truth every RLS policy
-- and trigger below is built on.
create or replace function public.current_role()
returns user_role
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_staff_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select staff_id from public.profiles where id = auth.uid();
$$;

create or replace function public.current_student_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select student_id from public.profiles where id = auth.uid();
$$;

create or replace function public.current_school_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select school_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable as $$ select public.current_role() = 'admin' $$;

create or replace function public.is_staff()
returns boolean language sql stable as $$ select public.current_role() in ('admin','teacher') $$;

-- ----------------------------------------------------------------------------
-- staff_capabilities — a small, purpose-built capability grant (started
-- minimal and real rather than speculative — see result_submissions below,
-- the one thing this currently gates). Only 'publish_results' exists today;
-- add more values to the check constraint as later phases give staff more
-- granular grants.
-- ----------------------------------------------------------------------------
create table public.staff_capabilities (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  capability text not null,
  created_at timestamptz not null default now(),
  unique (staff_id, capability),
  constraint staff_capabilities_capability_check check (capability in ('publish_results'))
);
create index idx_staff_capabilities_school on public.staff_capabilities(school_id);
create index idx_staff_capabilities_staff on public.staff_capabilities(staff_id);

create or replace function public.has_capability(p_capability text)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.staff_capabilities
    where staff_id = public.current_staff_id() and capability = p_capability
  );
$$;

create or replace function public.is_class_teacher_of(p_class_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.classes
    where id = p_class_id and class_teacher_staff_id is not null and class_teacher_staff_id = public.current_staff_id()
  );
$$;

-- Auto-stamp: every tenant table's BEFORE INSERT trigger fills in school_id
-- from the signed-in user's own profile whenever the caller didn't set it
-- explicitly — which is every call site in the existing frontend, by design.
-- This is what let the application code stay untouched by the multi-tenant
-- migration: an `insert({...})` that never mentioned school_id still lands
-- in the right tenant.
create or replace function public.set_school_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.school_id is null then
    new.school_id := public.current_school_id();
  end if;
  if new.school_id is null then
    raise exception 'Could not determine which school this record belongs to (no school_id on your profile).' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- subject <-> class assignment (subjects a class offers; streams inherit)
-- ----------------------------------------------------------------------------
create table public.subject_class_assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  -- Phase 2g (brief §4.2): nullable — null means this row is a legacy/
  -- class-wide assignment (applies to every stream of the class); set means
  -- it's specific to that one stream. See migrations/0009_stream_subjects.sql
  -- for the full rationale and assignments.mjs for how "effective subjects"
  -- is computed from this.
  stream_id uuid references public.streams(id) on delete cascade,
  -- Round 4 §7 (0018_timetable.sql): how many periods a week this subject
  -- needs for this class/stream, and how many of those should be scheduled
  -- as double lessons (0019_timetable_fixes.sql — a count, not a yes/no, so
  -- e.g. Math can get exactly 3 doubles a week and the rest as singles) —
  -- read by the Timetable module's generator. Null periods_per_week means
  -- "not configured yet"; the generator falls back to a default rather than
  -- requiring every subject to be set up before anything works.
  periods_per_week integer,
  double_periods_per_week integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_sca_updated_at before update on public.subject_class_assignments
  for each row execute function public.set_updated_at();
create index idx_sca_school on public.subject_class_assignments(school_id);
create index idx_sca_stream on public.subject_class_assignments(stream_id);
-- Partial unique indexes (not a plain table-level unique()) so a subject can
-- be assigned once as a class-wide default AND once per stream without
-- colliding — same pattern as public.results' paper/no-paper indexes.
create unique index idx_sca_unique_classwide on public.subject_class_assignments(subject_id, class_id) where stream_id is null;
create unique index idx_sca_unique_stream on public.subject_class_assignments(subject_id, class_id, stream_id) where stream_id is not null;

-- ----------------------------------------------------------------------------
-- teacher <-> subject/class/stream assignment
-- ----------------------------------------------------------------------------
create table public.subject_teacher_assignments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  stream_id uuid references public.streams(id) on delete cascade,
  academic_year_id uuid references public.academic_years(id) on delete set null,
  term_id uuid references public.terms(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_sta_updated_at before update on public.subject_teacher_assignments
  for each row execute function public.set_updated_at();
create index idx_sta_staff on public.subject_teacher_assignments(staff_id);
create index idx_sta_school on public.subject_teacher_assignments(school_id);

-- ----------------------------------------------------------------------------
-- grading
-- ----------------------------------------------------------------------------
create table public.grading_scales (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  description text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_grading_scales_updated_at before update on public.grading_scales
  for each row execute function public.set_updated_at();
create index idx_grading_scales_school on public.grading_scales(school_id);

create table public.grade_ranges (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  grading_scale_id uuid not null references public.grading_scales(id) on delete cascade,
  min_score numeric not null,
  max_score numeric not null,
  grade_label text not null,
  points numeric,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_grade_ranges_updated_at before update on public.grade_ranges
  for each row execute function public.set_updated_at();
create index idx_grade_ranges_school on public.grade_ranges(school_id);

-- ----------------------------------------------------------------------------
-- exams + results
-- ----------------------------------------------------------------------------
create table public.exams (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  out_of numeric not null default 100,
  status text not null default 'open',         -- informational only (e.g. 'open'/'closed'); no fixed enum, no logic branches on it
  exam_type text not null default 'written',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- System Fixes brief §8: soft-delete instead of an immediate hard delete —
  -- a deleted exam moves to the Deleted Exams submodule for 30 days (still
  -- restorable), then gets permanently purged. NULL = not deleted, still
  -- shown normally in Exam Desk (0013_deleted_exams).
  deleted_at timestamptz,
  -- 'summative'/'formative'/'cat'/'mock' are the pre-0012 types, kept valid
  -- (nothing already saved under them breaks) but no longer offered in the
  -- UI, which now offers Zeraki-style types instead (0012_exam_workflow_v2).
  constraint exams_exam_type_check check (exam_type in (
    'summative', 'formative', 'cat', 'mock',
    'written', 'consolidated', 'supplementary', 'kpsea_kjsea', 'year_average'
  ))
);
create trigger trg_exams_updated_at before update on public.exams
  for each row execute function public.set_updated_at();
create index idx_exams_school on public.exams(school_id);
create index idx_exams_deleted_at on public.exams(deleted_at) where deleted_at is not null;

-- 0020_learning_area_papers.sql: subject_papers.exam_id, added here (not in
-- that table's own create table above) purely because it references this
-- table, which doesn't exist yet at that earlier point in the script — see
-- the note above subject_papers' create table. Scopes every paper to one
-- specific exam so the same subject can have a completely different (or no)
-- paper setup in a different exam, per the Learning Area Papers brief.
--
-- 0021_learning_area_papers_per_class.sql: also add class_id (same reason —
-- classes exists by this point too) — a paper setup is scoped to one
-- specific CLASS within that exam as well, not assumed school-wide: Grade 1
-- can sit English as a single paper while Grade 8 sits it as 3 separate
-- papers, within the very same exam. The unique constraint below reflects
-- both migrations' end state directly (exam_id, subject_id, class_id,
-- paper_no) since a fresh install goes straight there.
alter table public.subject_papers add column exam_id uuid references public.exams(id) on delete cascade;
create index idx_subject_papers_exam on public.subject_papers(exam_id);
alter table public.subject_papers add column class_id uuid references public.classes(id) on delete cascade;
create index idx_subject_papers_class on public.subject_papers(class_id);
alter table public.subject_papers add constraint subject_papers_exam_subject_class_paperno_key unique (exam_id, subject_id, class_id, paper_no);

-- 0023_subject_combination.sql (Round 2 §3): the opposite direction from
-- Learning Area Papers — combine two or more EXISTING subjects into one
-- named, weighted result for one exam (e.g. Social Studies + CRE ->
-- "SST/CRE Combined"), instead of splitting one subject into papers. Scoped
-- to one exam for the same reason subject_papers is; a subject may only
-- belong to one active combination per exam, enforced in academics.mjs
-- (not expressible as a single-table constraint).
create table public.subject_combinations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_subject_combinations_exam on public.subject_combinations(exam_id);
create index idx_subject_combinations_school on public.subject_combinations(school_id);
create trigger trg_subject_combinations_updated_at before update on public.subject_combinations
  for each row execute function public.set_updated_at();

create table public.subject_combination_members (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  combination_id uuid not null references public.subject_combinations(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  weight numeric not null default 1,
  created_at timestamptz not null default now(),
  unique (combination_id, subject_id)
);
create index idx_subject_combination_members_combo on public.subject_combination_members(combination_id);
create index idx_subject_combination_members_subject on public.subject_combination_members(subject_id);
create index idx_subject_combination_members_school on public.subject_combination_members(school_id);

-- Phase 2h (brief §7.1): which classes were explicitly chosen to sit a given
-- exam — purely a "should this class show on the exam's board at all"
-- record. Marks entry/publishing still key off (exam_id, class_id) on
-- results/result_submissions exactly as before; nothing here gates that.
create table public.exam_classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- 0012_exam_workflow_v2 (brief Steps 1/3/10/13) — per-(exam,class) fields,
  -- all nullable so an exam/class that never goes through the new
  -- publish-settings step behaves exactly as before (falls back to the
  -- existing global settings / single default grading scale / mean-marks
  -- ranking respectively):
  min_subjects integer,                              -- Step 1: "minimum learning areas" — below this, a student is excluded from ranking (shown as X)
  ranking_criteria text,                              -- Step 10: 'mean_marks' | 'mean_points', chosen at publish time
  deviation_exam_id uuid references public.exams(id) on delete set null, -- Step 10: prior exam to compare this class's performance against
  grading_scale_id uuid references public.grading_scales(id) on delete set null, -- Step 10: Overall Grading System (exam+class level only — see the brief's explicit exception against a per-subject selector)
  released_at timestamptz,                            -- Step 3/13: results actually sent to parents ("Send Results") -> Zeraki's "Released" status
  released_by uuid references public.staff(id) on delete set null,
  unique (exam_id, class_id),
  constraint exam_classes_ranking_criteria_check check (ranking_criteria is null or ranking_criteria in ('mean_marks', 'mean_points'))
);
create index idx_exam_classes_school on public.exam_classes(school_id);
create index idx_exam_classes_exam on public.exam_classes(exam_id);

create table public.results (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  academic_year_id uuid references public.academic_years(id) on delete set null,
  term_id uuid references public.terms(id) on delete set null,
  -- Which paper this row is (null = whole-subject mark, the common case —
  -- see subject_papers above), and a SNAPSHOT of the student's class at the
  -- time marks were entered (needed for the publish gate below to key off
  -- exactly the (exam, class, subject) grouping marks are actually entered
  -- by, regardless of a student moving classes afterwards).
  paper_id uuid references public.subject_papers(id) on delete set null,
  class_id uuid references public.classes(id) on delete set null,
  score numeric,
  grade_label text,
  points numeric,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_results_updated_at before update on public.results
  for each row execute function public.set_updated_at();
create index idx_results_student on public.results(student_id);
create index idx_results_exam on public.results(exam_id);
create index idx_results_school on public.results(school_id);
-- Partial (not a single plain UNIQUE) because a subject can have some
-- students on a whole-subject mark (paper_id null) and others on a
-- per-paper mark — exactly one row per student per subject per paper (or
-- per subject, if none) either way.
create unique index idx_results_unique_no_paper on public.results(exam_id, student_id, subject_id) where paper_id is null;
create unique index idx_results_unique_with_paper on public.results(exam_id, student_id, subject_id, paper_id) where paper_id is not null;

-- ----------------------------------------------------------------------------
-- result_submissions — one row per (exam, class, subject); its `status` is
-- the single source of truth for whether a student/parent may see the
-- matching `results` rows (see the publish-gated RLS policies further
-- below). A trigger (not a plain RLS clause) enforces who may move it to
-- each next stage of Subject Teacher -> Class Teacher -> [capability
-- holder/Admin], because the correct check depends on BOTH the old and new
-- status, not just the new row in isolation.
-- ----------------------------------------------------------------------------
create table public.result_submissions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  status text not null default 'draft',
  submitted_by uuid references public.staff(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references public.staff(id) on delete set null,
  approved_at timestamptz,
  published_by uuid references public.staff(id) on delete set null,
  published_at timestamptz,
  max_marks numeric,  -- 0012_exam_workflow_v2 (brief Step 5): per-subject "Maximum Marks" override, set by the teacher before entering scores; falls back to the exam's out_of when null
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exam_id, class_id, subject_id),
  constraint result_submissions_status_check check (status in ('draft', 'submitted', 'approved', 'published'))
);
create trigger trg_result_submissions_updated_at before update on public.result_submissions
  for each row execute function public.set_updated_at();
create index idx_result_submissions_school on public.result_submissions(school_id);
create index idx_result_submissions_exam on public.result_submissions(exam_id);

create or replace function public.check_result_submission_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_status text;
begin
  -- No signed-in session means this write is coming from a raw SQL
  -- Editor/service-role context, not a real user request — trust it
  -- unconditionally. RLS already requires is_staff() to reach this trigger
  -- at all, and an anon/authenticated caller always has a resolvable
  -- auth.uid() once signed in, so this branch can only be hit by a
  -- superuser/service-role connection (e.g. a migration's own backfill).
  if auth.uid() is null then
    return new;
  end if;

  v_old_status := case when TG_OP = 'INSERT' then 'draft' else old.status end;

  if new.status is distinct from v_old_status then
    if new.status = 'submitted' then
      if not public.is_staff() then
        raise exception 'Only staff can submit results for approval' using errcode = '42501';
      end if;
      new.submitted_by := public.current_staff_id();
      new.submitted_at := now();
    elsif new.status = 'approved' then
      if not public.is_class_teacher_of(new.class_id) then
        raise exception 'Only this class''s class teacher (or an admin) can approve its results' using errcode = '42501';
      end if;
      if v_old_status <> 'submitted' and not public.is_admin() then
        raise exception 'Results must be submitted by the subject teacher before they can be approved' using errcode = '42501';
      end if;
      new.approved_by := public.current_staff_id();
      new.approved_at := now();
    elsif new.status = 'published' then
      if not public.has_capability('publish_results') then
        raise exception 'You do not have permission to publish results' using errcode = '42501';
      end if;
      if v_old_status <> 'approved' and not public.is_admin() then
        raise exception 'Results must be approved by the class teacher before they can be published' using errcode = '42501';
      end if;
      new.published_by := public.current_staff_id();
      new.published_at := now();
    elsif new.status = 'draft' then
      if v_old_status <> 'draft' and not public.is_admin() then
        raise exception 'Only an admin can reopen a submitted/approved/published result set' using errcode = '42501';
      end if;
      new.approved_by := null; new.approved_at := null;
      new.published_by := null; new.published_at := null;
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_result_submissions_transition before insert or update on public.result_submissions
  for each row execute function public.check_result_submission_transition();

-- SECURITY DEFINER so a plain RLS policy on `results` can check publish
-- status without needing the CALLING role (a student/parent) to also have
-- read access to result_submissions itself — same reasoning as
-- current_parent_student_ids() further below: a policy's EXISTS subquery
-- against another table is still subject to THAT table's own RLS for the
-- caller, so without this wrapper a student could never satisfy the check
-- at all (result_submissions' own policy only lets staff read it directly).
create or replace function public.is_result_published(p_exam_id uuid, p_class_id uuid, p_subject_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.result_submissions
    where exam_id = p_exam_id and class_id = p_class_id and subject_id = p_subject_id and status = 'published'
  );
$$;

-- ----------------------------------------------------------------------------
-- settings (key/value, same shape as the Apps Script version, now one row
-- set per school — the primary key includes school_id so every school gets
-- its own school_name/motto/logo/etc.)
-- ----------------------------------------------------------------------------
create table public.settings (
  school_id uuid not null references public.schools(id) on delete cascade,
  key text not null,
  value text,
  updated_at timestamptz not null default now(),
  primary key (school_id, key)
);
create trigger trg_settings_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

-- Every tenant table above gets the same auto-stamp trigger.
create trigger trg_staff_school_id before insert on public.staff
  for each row execute function public.set_school_id();
create trigger trg_academic_years_school_id before insert on public.academic_years
  for each row execute function public.set_school_id();
create trigger trg_terms_school_id before insert on public.terms
  for each row execute function public.set_school_id();
create trigger trg_classes_school_id before insert on public.classes
  for each row execute function public.set_school_id();
create trigger trg_streams_school_id before insert on public.streams
  for each row execute function public.set_school_id();
create trigger trg_subjects_school_id before insert on public.subjects
  for each row execute function public.set_school_id();
create trigger trg_students_school_id before insert on public.students
  for each row execute function public.set_school_id();
create trigger trg_profiles_school_id before insert on public.profiles
  for each row execute function public.set_school_id();
create trigger trg_sca_school_id before insert on public.subject_class_assignments
  for each row execute function public.set_school_id();
create trigger trg_sta_school_id before insert on public.subject_teacher_assignments
  for each row execute function public.set_school_id();
create trigger trg_grading_scales_school_id before insert on public.grading_scales
  for each row execute function public.set_school_id();
create trigger trg_grade_ranges_school_id before insert on public.grade_ranges
  for each row execute function public.set_school_id();
create trigger trg_exams_school_id before insert on public.exams
  for each row execute function public.set_school_id();
create trigger trg_exam_classes_school_id before insert on public.exam_classes
  for each row execute function public.set_school_id();
create trigger trg_results_school_id before insert on public.results
  for each row execute function public.set_school_id();
create trigger trg_settings_school_id before insert on public.settings
  for each row execute function public.set_school_id();
create trigger trg_subject_papers_school_id before insert on public.subject_papers
  for each row execute function public.set_school_id();
create trigger trg_staff_capabilities_school_id before insert on public.staff_capabilities
  for each row execute function public.set_school_id();
create trigger trg_result_submissions_school_id before insert on public.result_submissions
  for each row execute function public.set_school_id();
create trigger trg_subject_combinations_school_id before insert on public.subject_combinations
  for each row execute function public.set_school_id();
create trigger trg_subject_combination_members_school_id before insert on public.subject_combination_members
  for each row execute function public.set_school_id();

-- ============================================================================
-- Row-Level Security
-- ============================================================================
-- Model: admin = full read/write everywhere IN THEIR OWN SCHOOL. teacher =
-- read everything needed to teach (classes/streams/subjects/students/exams)
-- in their own school, can enter & edit results (no delete). student =
-- read-only, and only their OWN student record + their OWN results, still
-- scoped to their own school. Nobody but admin touches staff, settings, or
-- structural (classes/subjects/assignments) tables. Every single policy
-- below adds "school_id = public.current_school_id()" on top of the Phase 1
-- role checks — that one clause is the entire tenant-isolation boundary.

alter table public.schools enable row level security;
alter table public.staff enable row level security;
alter table public.academic_years enable row level security;
alter table public.terms enable row level security;
alter table public.classes enable row level security;
alter table public.streams enable row level security;
alter table public.subjects enable row level security;
alter table public.students enable row level security;
alter table public.profiles enable row level security;
alter table public.subject_class_assignments enable row level security;
alter table public.subject_teacher_assignments enable row level security;
alter table public.grading_scales enable row level security;
alter table public.grade_ranges enable row level security;
alter table public.exams enable row level security;
alter table public.exam_classes enable row level security;
alter table public.results enable row level security;
alter table public.settings enable row level security;
alter table public.subject_papers enable row level security;
alter table public.staff_capabilities enable row level security;
alter table public.result_submissions enable row level security;
alter table public.subject_combinations enable row level security;
alter table public.subject_combination_members enable row level security;

-- schools: a signed-in user may read their OWN school's row (for branding /
-- account screens). Creating, renaming, suspending a school is a service-role
-- (Netlify function) operation only in this phase — no client write policy.
create policy schools_self_read on public.schools for select
  using (id = public.current_school_id());

-- profiles: everyone can read their own; admin can read/manage everyone
-- WITHIN THEIR OWN SCHOOL only
create policy profiles_self_read on public.profiles for select
  using (id = auth.uid() or (public.is_admin() and school_id = public.current_school_id()));
create policy profiles_admin_write on public.profiles for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy profiles_admin_update on public.profiles for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy profiles_admin_delete on public.profiles for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- staff: admin full; teacher can read (for assignment pickers); student none
create policy staff_read on public.staff for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy staff_admin_write on public.staff for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy staff_admin_update on public.staff for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy staff_admin_delete on public.staff for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- reference/structural data: readable by any authenticated user in the same
-- school (students need class/subject names for report cards), writable by
-- admin only
create policy academic_years_read on public.academic_years for select
  using (school_id = public.current_school_id());
create policy academic_years_admin_write on public.academic_years for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy academic_years_admin_update on public.academic_years for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy academic_years_admin_delete on public.academic_years for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy terms_read on public.terms for select
  using (school_id = public.current_school_id());
create policy terms_admin_write on public.terms for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy terms_admin_update on public.terms for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy terms_admin_delete on public.terms for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy classes_read on public.classes for select
  using (school_id = public.current_school_id());
create policy classes_admin_write on public.classes for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy classes_admin_update on public.classes for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy classes_admin_delete on public.classes for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy streams_read on public.streams for select
  using (school_id = public.current_school_id());
create policy streams_admin_write on public.streams for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy streams_admin_update on public.streams for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy streams_admin_delete on public.streams for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy subjects_read on public.subjects for select
  using (school_id = public.current_school_id());
create policy subjects_admin_write on public.subjects for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy subjects_admin_update on public.subjects for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy subjects_admin_delete on public.subjects for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy sca_read on public.subject_class_assignments for select
  using (school_id = public.current_school_id());
create policy sca_admin_write on public.subject_class_assignments for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy sca_admin_update on public.subject_class_assignments for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy sca_admin_delete on public.subject_class_assignments for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy sta_read on public.subject_teacher_assignments for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy sta_admin_write on public.subject_teacher_assignments for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy sta_admin_update on public.subject_teacher_assignments for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy sta_admin_delete on public.subject_teacher_assignments for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy grading_scales_read on public.grading_scales for select
  using (school_id = public.current_school_id());
create policy grading_scales_admin_write on public.grading_scales for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy grading_scales_admin_update on public.grading_scales for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy grading_scales_admin_delete on public.grading_scales for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy grade_ranges_read on public.grade_ranges for select
  using (school_id = public.current_school_id());
create policy grade_ranges_admin_write on public.grade_ranges for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy grade_ranges_admin_update on public.grade_ranges for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy grade_ranges_admin_delete on public.grade_ranges for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- settings: readable by any authenticated member of the school; the
-- pre-login screen no longer reads this table directly (it can't — there's
-- no session yet) and instead calls get_school_public_info() below, which is
-- the one deliberate, narrow, anonymous-safe exception.
create policy settings_read on public.settings for select
  using (school_id = public.current_school_id());
create policy settings_admin_write on public.settings for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy settings_admin_update on public.settings for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy settings_admin_delete on public.settings for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- students: admin full; teacher read all (+ write, since teachers register
-- students in the original system); student may read only their own row —
-- all scoped to one school
create policy students_staff_read on public.students for select
  using ((public.is_staff() or id = public.current_student_id()) and school_id = public.current_school_id());
create policy students_staff_write on public.students for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy students_staff_update on public.students for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy students_admin_delete on public.students for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- exams: staff read/write; students read (needed to know which exams exist
-- for their report card / mark list views)
create policy exams_read on public.exams for select
  using (school_id = public.current_school_id());
create policy exams_staff_write on public.exams for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy exams_staff_update on public.exams for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy exams_admin_delete on public.exams for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- exam_classes: same read access as exams (students/staff both need to know
-- which classes sit an exam); only an admin picks/changes the class list.
create policy exam_classes_read on public.exam_classes for select
  using (school_id = public.current_school_id());
create policy exam_classes_admin_write on public.exam_classes for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy exam_classes_admin_delete on public.exam_classes for delete
  using (public.is_admin() and school_id = public.current_school_id());
-- 0012_exam_workflow_v2: publish-settings/Withdraw Results/Send Results all
-- update an existing exam_classes row in place (min_subjects, ranking
-- criteria, deviation exam, grading scale, released_at/by) — same admin-only
-- rule as the insert/delete policies above.
create policy exam_classes_admin_update on public.exam_classes for update
  using (public.is_admin() and school_id = public.current_school_id())
  with check (public.is_admin() and school_id = public.current_school_id());

-- 0040_consolidated_exams.sql — "Consolidated Exam" (combine 2+ existing
-- exams, e.g. Opener/Midterm/Endterm, into one weighted-average result). No
-- new marks-entry path or RPC: an admin names this exam's component exams
-- here, and recomputeConsolidated() (src/lib/api/results.mjs) averages each
-- student's per-subject score across them and writes it into THIS exam's
-- own `results` rows via the existing save_results_batch() RPC — so Review
-- & Publish, report cards, broadsheets and exam analysis all work exactly
-- as they already do, with zero changes, once those rows exist.
create table public.exam_components (
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
create index idx_exam_components_exam on public.exam_components(exam_id);
create index idx_exam_components_component on public.exam_components(component_exam_id);
create index idx_exam_components_school on public.exam_components(school_id);

-- Guard rail: the exam being attached to must actually be a consolidated
-- exam, and a component must be a real, non-consolidated exam in the same
-- school — disallowing nesting keeps recomputeConsolidated()'s weighted
-- average unambiguous (no tree of consolidations to flatten).
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
create trigger trg_check_exam_component before insert or update on public.exam_components
  for each row execute function public.check_exam_component();

alter table public.exam_components enable row level security;
create policy exam_components_read on public.exam_components for select
  using (school_id = public.current_school_id());
create policy exam_components_admin_write on public.exam_components for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy exam_components_admin_delete on public.exam_components for delete
  using (public.is_admin() and school_id = public.current_school_id());
create policy exam_components_admin_update on public.exam_components for update
  using (public.is_admin() and school_id = public.current_school_id())
  with check (public.is_admin() and school_id = public.current_school_id());

-- results: staff (admin+teacher) can enter/edit and always read everything
-- in their own school (published or not — they need to review before
-- publishing); a student can read only their OWN rows, and only once the
-- matching (exam, class, subject) result_submissions row is 'published' —
-- see Phase 2's publishing workflow further below. Nobody but admin deletes.
create policy results_read on public.results for select
  using (
    (public.is_staff() and school_id = public.current_school_id())
    or (
      student_id = public.current_student_id()
      and school_id = public.current_school_id()
      and public.is_result_published(exam_id, class_id, subject_id)
    )
  );
create policy results_staff_write on public.results for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy results_staff_update on public.results for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy results_admin_delete on public.results for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy subject_papers_read on public.subject_papers for select
  using (school_id = public.current_school_id());
create policy subject_papers_admin_write on public.subject_papers for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy subject_papers_admin_update on public.subject_papers for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy subject_papers_admin_delete on public.subject_papers for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy subject_combinations_read on public.subject_combinations for select
  using (school_id = public.current_school_id());
create policy subject_combinations_admin_write on public.subject_combinations for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy subject_combinations_admin_update on public.subject_combinations for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy subject_combinations_admin_delete on public.subject_combinations for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy subject_combination_members_read on public.subject_combination_members for select
  using (school_id = public.current_school_id());
create policy subject_combination_members_admin_write on public.subject_combination_members for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy subject_combination_members_admin_update on public.subject_combination_members for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy subject_combination_members_admin_delete on public.subject_combination_members for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy staff_capabilities_read on public.staff_capabilities for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy staff_capabilities_admin_write on public.staff_capabilities for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy staff_capabilities_admin_delete on public.staff_capabilities for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- result_submissions: broad RLS gate is just "any staff member in this
-- school" — the SPECIFIC per-stage authorization (only the class teacher
-- may approve, only a capability holder may publish, etc.) is enforced by
-- the check_result_submission_transition() trigger above, not here, because
-- it depends on both the old and new status together.
create policy result_submissions_read on public.result_submissions for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy result_submissions_staff_write on public.result_submissions for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy result_submissions_staff_update on public.result_submissions for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy result_submissions_admin_delete on public.result_submissions for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- ============================================================================
-- get_school_public_info RPC — the ONE anonymous-safe read in the whole
-- schema. The login screen needs to show a school's name/logo (and the
-- student-login flow needs the school's code to build the right synthetic
-- email) before anyone is signed in, so there is no auth.uid() / school_id
-- to filter by yet. This function takes the place of the old, fully-public
-- `settings_read using (true)` policy — it deliberately returns nothing but
-- a name/logo/motto for an ACTIVE school looked up by its public code, never
-- anything else.
-- ============================================================================
create or replace function public.get_school_public_info(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_school public.schools%rowtype;
  v_settings jsonb;
begin
  select * into v_school from public.schools
    where code = lower(trim(coalesce(p_code, ''))) and status = 'active';
  if not found then
    return jsonb_build_object('found', false);
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_settings
    from public.settings where school_id = v_school.id;

  return jsonb_build_object(
    'found', true,
    'school_id', v_school.id,
    'school_code', v_school.code,
    'school_name', v_school.name,
    'settings', v_settings
  );
end;
$$;
grant execute on function public.get_school_public_info(text) to anon, authenticated;

-- ============================================================================
-- resolve_staff_login_email RPC — the second anonymous-safe read. An admin or
-- teacher signs in with EITHER their assigned username ("mercy") or their
-- phone number, folded with their School Code into one field at the login
-- screen (e.g. "mercy@tumaini" or "0712345678@tumaini") — see
-- studentEmail.shared.js's splitLoginUsername(). Since the actual Supabase
-- Auth email is a server-generated synthetic address the person never sees
-- (built from their assigned username, not necessarily what they just
-- typed), the frontend has no way to construct it itself the way it can for
-- students/parents — it has to ask. This function is deliberately narrow:
-- given an identifier + school code, it returns ONLY the matching synthetic
-- email (or null), for an active admin/teacher account, and nothing else —
-- no name, no role, no way to enumerate who exists at a school.
-- ============================================================================
create or replace function public.resolve_staff_login_email(p_school_code text, p_identifier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  join public.schools s on s.id = p.school_id
  where s.code = lower(trim(coalesce(p_school_code, '')))
    and s.status = 'active'
    and p.role in ('admin', 'teacher')
    and p.status = 'active'
    and (p.username = lower(trim(coalesce(p_identifier, ''))) or p.phone = trim(coalesce(p_identifier, '')))
  limit 1;
$$;
grant execute on function public.resolve_staff_login_email(text, text) to anon, authenticated;

-- ============================================================================
-- Next Sprint 2 §11 (0034_staff_self_service_profile.sql): "Teachers
-- currently have no way to update their own profile (phone number, gender,
-- other personal details) — this is only editable from the admin side."
--
-- The `staff` table only has staff_admin_update (public.is_admin()) — no
-- teacher-write policy exists at all today. Rather than adding a broad
-- "teacher can update their own staff row" RLS policy (Postgres RLS is
-- row-level, not column-level — that would also let a teacher change their
-- own role, employment_start_date, status, or email via a raw REST call,
-- even if the UI form never shows those fields), this is a narrow
-- SECURITY DEFINER RPC — the same pattern this schema already uses for
-- every other "only THIS specific, safe thing" write (finance_reverse_
-- collection, resolve_staff_login_email, etc). It only ever touches the
-- caller's OWN linked staff row (via profiles.staff_id = auth.uid()'s
-- profile), and only ever writes the personal-detail columns explicitly
-- listed below — role/status/employment_start_date/email/tsc_number are
-- untouched no matter what's passed in, because they're simply not
-- parameters this function accepts.
-- ============================================================================
create or replace function public.staff_update_own_profile(
  p_phone text, p_gender text, p_date_of_birth date,
  p_national_id text, p_next_of_kin_name text, p_next_of_kin_contact text
)
returns public.staff
language plpgsql security definer set search_path = public
as $$
declare
  v_staff_id uuid;
  v_school uuid := public.current_school_id();
  v_row public.staff%rowtype;
begin
  select staff_id into v_staff_id from public.profiles where id = auth.uid();
  if v_staff_id is null then raise exception 'This account is not linked to a staff record'; end if;
  if p_gender is not null and p_gender not in ('Male', 'Female') then
    raise exception 'Invalid gender';
  end if;

  update public.staff set
    phone = p_phone,
    gender = p_gender::gender_t,
    date_of_birth = p_date_of_birth,
    national_id = p_national_id,
    next_of_kin_name = p_next_of_kin_name,
    next_of_kin_contact = p_next_of_kin_contact
  where id = v_staff_id and school_id = v_school
  returning * into v_row;

  if v_row.id is null then raise exception 'Staff record not found'; end if;
  return v_row;
end;
$$;

grant execute on function public.staff_update_own_profile(text, text, date, text, text, text) to authenticated;

-- ============================================================================
-- find_login_accounts_by_phone RPC — landing-redesign brief B1 ("System
-- should auto-identify whether a user is a parent, teacher, or admin based
-- on their phone number... If the phone number exists in TWO OR MORE
-- schools... prompt the user to select the correct account").
--
-- Deliberately narrow, same spirit as resolve_staff_login_email above: given
-- ONLY a phone number, across ALL schools (security definer bypasses RLS,
-- same justification as get_school_public_info/resolve_staff_login_email —
-- this has to run before the caller is authenticated into any one school),
-- return just enough for the login screen to build a picker and then
-- proceed through the EXISTING per-role login functions — never a password,
-- never anything beyond what's needed to pick the right account:
--   school_code, school_name, role, display_name
-- Only active profiles at active schools are considered. Students are
-- intentionally excluded — they sign in with an admission number, not a
-- phone (frozen/unchanged by this brief).
-- ============================================================================
create or replace function public.find_login_accounts_by_phone(p_phone text)
returns table (school_code text, school_name text, role user_role, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select s.code, s.name, p.role, p.name
  from public.profiles p
  join public.schools s on s.id = p.school_id
  where p.phone = trim(coalesce(p_phone, ''))
    and p.status = 'active'
    and s.status = 'active'
    and p.role in ('admin', 'teacher', 'parent')
  order by s.name, p.role;
$$;
grant execute on function public.find_login_accounts_by_phone(text) to anon, authenticated;

-- ============================================================================
-- seed_school_defaults RPC — populates a brand-new school with the same CBC
-- subject list, default grading scale/bands and default settings keys every
-- school used to get from seed.sql when there was only ever one tenant.
-- SECURITY DEFINER + a hard school_id parameter (not current_school_id())
-- because this runs from the school-signup Netlify function via the
-- service_role key, before the new admin's profile even exists yet.
-- ============================================================================
create or replace function public.seed_school_defaults(p_school_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scale_id uuid;
  v_year_id uuid;
  -- Next Sprint 3 §1.2: sign-up asks for a category ('pri_jss' — the
  -- existing default — or 'senior'), which now decides which of the two
  -- entirely separate subject lists below gets seeded. A 'senior' school
  -- gets NEITHER the Pre-Primary..Junior Secondary list (it doesn't run
  -- those grades) nor a runtime toggle between the two later — category is
  -- a sign-up-time choice only (see schools.category's comment in
  -- schema.sql), so this reads it once, here.
  v_category text;
  v_year int := extract(year from current_date)::int;
begin
  select category into v_category from public.schools where id = p_school_id;

  if coalesce(v_category, 'pri_jss') = 'pri_jss' then
    insert into public.subjects (school_id, name, level, code, description) values
      (p_school_id, 'Language Activities', 'Pre-Primary', '', ''),
      (p_school_id, 'Mathematical Activities', 'Pre-Primary', '', ''),
      (p_school_id, 'Environmental Activities', 'Pre-Primary', '', ''),
      (p_school_id, 'Psychomotor and Creative Activities', 'Pre-Primary', '', ''),
      (p_school_id, 'Religious Education Activities', 'Pre-Primary', '', ''),
      (p_school_id, 'Literacy Activities', 'Lower Primary', '', ''),
      (p_school_id, 'English Language Activities', 'Lower Primary', '', ''),
      (p_school_id, 'Kiswahili Language Activities', 'Lower Primary', '', ''),
      (p_school_id, 'Indigenous Language Activities', 'Lower Primary', '', ''),
      (p_school_id, 'Mathematical Activities', 'Lower Primary', '', ''),
      (p_school_id, 'Environmental Activities', 'Lower Primary', '', ''),
      (p_school_id, 'Hygiene and Nutrition Activities', 'Lower Primary', '', ''),
      (p_school_id, 'Religious Education', 'Lower Primary', '', ''),
      (p_school_id, 'Movement and Creative Activities', 'Lower Primary', '', ''),
      (p_school_id, 'English', 'Upper Primary', '', ''),
      (p_school_id, 'Kiswahili', 'Upper Primary', '', ''),
      (p_school_id, 'Mathematics', 'Upper Primary', '', ''),
      (p_school_id, 'Science and Technology', 'Upper Primary', '', ''),
      (p_school_id, 'Social Studies', 'Upper Primary', '', ''),
      (p_school_id, 'Religious Education', 'Upper Primary', '', ''),
      (p_school_id, 'Agriculture', 'Upper Primary', '', ''),
      (p_school_id, 'Home Science', 'Upper Primary', '', ''),
      (p_school_id, 'Creative Arts', 'Upper Primary', '', ''),
      (p_school_id, 'Physical and Health Education', 'Upper Primary', '', ''),
      (p_school_id, 'English', 'Junior Secondary', '', ''),
      (p_school_id, 'Kiswahili', 'Junior Secondary', '', ''),
      (p_school_id, 'Mathematics', 'Junior Secondary', '', ''),
      (p_school_id, 'Integrated Science', 'Junior Secondary', '', ''),
      (p_school_id, 'Pre-Technical Studies', 'Junior Secondary', '', ''),
      (p_school_id, 'Social Studies', 'Junior Secondary', '', ''),
      (p_school_id, 'Agriculture', 'Junior Secondary', '', ''),
      (p_school_id, 'Religious Education', 'Junior Secondary', '', ''),
      (p_school_id, 'Creative Arts and Sports', 'Junior Secondary', '', '')
    on conflict (school_id, name, level, pathway) do nothing;
  else
    -- Senior School category (Next Sprint 3 §1.3/§1.4): core subjects every
    -- Grade 10-12 student takes regardless of pathway (pathway = null),
    -- each pathway's own specialised subjects on top (pathway set — see
    -- streams.pathway/subjects.pathway comments), and the separate Form 3/4
    -- (8-4-4 legacy) full subject list with no pathway concept at all.
    -- Standard KICD-aligned lists — editable per school afterward from the
    -- Classes screen's "+ Add subject" picker, same as every other subject.
    insert into public.subjects (school_id, name, level, pathway, code, description) values
      (p_school_id, 'English', 'Senior Secondary', null, '', ''),
      (p_school_id, 'Kiswahili (or Kenyan Sign Language)', 'Senior Secondary', null, '', ''),
      (p_school_id, 'Community Service Learning', 'Senior Secondary', null, '', ''),
      (p_school_id, 'Physics', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Chemistry', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Biology', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Core Mathematics', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Computer Studies', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Agriculture', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Home Science', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'History and Citizenship', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Geography', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Christian Religious Education', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Business Studies', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Literature in English', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Fasihi ya Kiswahili', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Essential Mathematics', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Music and Dance', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Fine Arts', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Theatre and Film', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Sports and Recreation', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Physical Education', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Essential Mathematics', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'English', 'Form 3-4', null, '', ''),
      (p_school_id, 'Kiswahili', 'Form 3-4', null, '', ''),
      (p_school_id, 'Mathematics', 'Form 3-4', null, '', ''),
      (p_school_id, 'Biology', 'Form 3-4', null, '', ''),
      (p_school_id, 'Chemistry', 'Form 3-4', null, '', ''),
      (p_school_id, 'Physics', 'Form 3-4', null, '', ''),
      (p_school_id, 'History and Government', 'Form 3-4', null, '', ''),
      (p_school_id, 'Geography', 'Form 3-4', null, '', ''),
      (p_school_id, 'Christian Religious Education', 'Form 3-4', null, '', ''),
      (p_school_id, 'Agriculture', 'Form 3-4', null, '', ''),
      (p_school_id, 'Business Studies', 'Form 3-4', null, '', ''),
      (p_school_id, 'Computer Studies', 'Form 3-4', null, '', ''),
      (p_school_id, 'Home Science', 'Form 3-4', null, '', '')
    on conflict (school_id, name, level, pathway) do nothing;
  end if;

  -- Round 3 §8: "Do not auto-set a grading scale for a school... the
  -- default grading scale should be CBC, not the current 8-4-4 default...
  -- the CBC scale should already exist in the system, ready to use." The
  -- old 8-4-4 letter-grade scale (A/A-/B+/.../E) used to be created here AND
  -- immediately marked is_default — i.e. a school got a scale nobody chose,
  -- silently governing every report card until someone noticed and changed
  -- it. The CBC competency scale is now seeded instead, PRESENT but
  -- deliberately NOT default — an admin must explicitly click "Activate"
  -- (loadCbcCompetencyScale() in src/lib/api/grading.mjs, which now also
  -- promotes it to default in that same click) before it's actually used.
  -- publishExam() separately refuses to publish at all until some scale is
  -- active, so a new school can't silently publish results with no real
  -- grading behind them.
  --
  -- Guarded by an explicit existence check (grading_scales has no unique
  -- constraint to hang an ON CONFLICT off) — school-seed.js's own doc
  -- comment promises this whole function is safe to call more than once for
  -- the same school (a legitimate retry after a timeout), and a duplicate
  -- "CBC Competency Scale" would actively confuse the new one-click
  -- Activate flow (two same-named scales, one arbitrarily becoming
  -- default). Every other insert in this function already had this
  -- protection (on conflict do nothing); this one just never did.
  if not exists (select 1 from public.grading_scales where school_id = p_school_id and name = 'CBC Competency Scale') then
    insert into public.grading_scales (id, school_id, name, description, is_default)
    values (gen_random_uuid(), p_school_id, 'CBC Competency Scale',
            'The 8-band CBC competency-based scale (Below/Approaching/Meeting/Exceeding Expectation).', false)
    returning id into v_scale_id;

    insert into public.grade_ranges (school_id, grading_scale_id, min_score, max_score, grade_label, points, remark)
    select p_school_id, v_scale_id, b.min_score, b.max_score, b.grade_label, b.points, b.remark
    from (values
      (0,  12,  'BE2', 1, 'Below Expectation'),
      (13, 24,  'BE1', 2, 'Below Expectation'),
      (25, 36,  'AE2', 3, 'Approaching Expectation'),
      (37, 49,  'AE1', 4, 'Approaching Expectation'),
      (50, 60,  'ME2', 5, 'Meeting Expectation'),
      (61, 72,  'ME1', 6, 'Meeting Expectation'),
      (73, 84,  'EE2', 7, 'Exceeding Expectation'),
      (85, 100, 'EE1', 8, 'Exceeding Expectation')
    ) as b(min_score, max_score, grade_label, points, remark);
  end if;

  insert into public.settings (school_id, key, value) values
    (p_school_id, 'school_name', (select name from public.schools where id = p_school_id)),
    (p_school_id, 'school_motto', ''),
    (p_school_id, 'po_box', ''),
    (p_school_id, 'phone', ''),
    (p_school_id, 'email', ''),
    (p_school_id, 'logo', ''),
    -- Minimum-subjects-for-ranking rule (Phase 2a) — '0' means "no rule, rank
    -- everyone with a total > 0", the same behaviour every school already had.
    (p_school_id, 'min_subjects_for_ranking', '0'),
    -- 0022_merit_list_and_subject_order.sql (Round 2 §1): unlike every other
    -- toggle here, this one defaults ON for a brand-new school — see the
    -- comment on this key in settings.mjs.
    (p_school_id, 'show_papers_separately', 'true')
  on conflict (school_id, key) do nothing;

  -- Landing-redesign brief C2: "Academic year and terms should be
  -- automatically created when a new school is created" — previously the
  -- admin had to do this by hand on day one via the Dashboard's "Getting set
  -- up" checklist. Dates are left null (the admin can fill them in later
  -- under Settings > Academic Years & Terms); what matters here is that an
  -- active year with 3 terms already exists so exams/results aren't blocked
  -- on a manual setup step. on conflict is a no-op guard for re-running this
  -- function against a school that already has a year (e.g. a retried call).
  insert into public.academic_years (id, school_id, name, status)
  values (gen_random_uuid(), p_school_id, v_year::text, 'active')
  on conflict (school_id, name) do nothing
  returning id into v_year_id;

  if v_year_id is not null then
    -- SignUp_Fixes §4 (BUG FIX): a new school no longer always gets "Term 1
    -- active" regardless of the real date — each term's status is derived
    -- from today's date against term_date_reference (see term_status_for()).
    insert into public.terms (school_id, academic_year_id, name, status) values
      (p_school_id, v_year_id, 'Term 1', public.term_status_for(v_year, 'Term 1')),
      (p_school_id, v_year_id, 'Term 2', public.term_status_for(v_year, 'Term 2')),
      (p_school_id, v_year_id, 'Term 3', public.term_status_for(v_year, 'Term 3'))
    on conflict (academic_year_id, name) do nothing;
  end if;

  -- Round 6 §4: distribute_doubles is the one Timetable Constraint that's
  -- ON by default for every school (see 0027_distribute_doubles.sql's
  -- header comment for why) — no unique constraint to hang an ON CONFLICT
  -- off (same situation as the grading_scales guard above), so an explicit
  -- existence check instead.
  if not exists (select 1 from public.timetable_constraints where school_id = p_school_id and type = 'distribute_doubles') then
    insert into public.timetable_constraints (school_id, type, enabled, config)
    values (p_school_id, 'distribute_doubles', true, '{}'::jsonb);
  end if;
end;
$$;

-- ============================================================================
-- get_report_card RPC
-- ============================================================================
-- A student's own report card needs their CLASS POSITION, which requires
-- comparing their total against every classmate's total. The results_read
-- RLS policy above deliberately does NOT let a student read classmates'
-- results (that would leak everyone's marks to everyone) — so that ranking
-- can't be computed with a plain client-side query the way a teacher's can.
--
-- This function is the one narrow exception: SECURITY DEFINER lets it read
-- across all students' results internally, but it re-implements the exact
-- same authorization rule RLS would apply (admin/teacher, or the student
-- viewing their own card, nobody else, and always within one school) before
-- doing anything, and only ever returns computed, single-student output —
-- the caller never receives another student's raw score, and never anything
-- from a different school even if a stale/foreign id were passed in.
create or replace function public.get_report_card(p_exam_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_own_student_id uuid;
  v_caller_school uuid;
  v_student public.students%rowtype;
  v_exam public.exams%rowtype;
  v_class public.classes%rowtype;
  v_stream public.streams%rowtype;
  v_year public.academic_years%rowtype;
  v_term public.terms%rowtype;
  v_subjects jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_average numeric := 0;
  v_overall_grade text;
  v_position int;
  v_class_size int;
  v_authorized boolean := false;
  v_staff_view boolean;
  v_min_subjects int := 0;
  v_below_minimum boolean := false;
begin
  v_role := public.current_role();
  v_own_student_id := public.current_student_id();
  v_caller_school := public.current_school_id();

  if v_role is null or v_caller_school is null then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;

  if v_role in ('admin', 'teacher') then
    v_authorized := true;
  elsif v_role = 'student' and v_own_student_id is not distinct from p_student_id then
    v_authorized := true;
  elsif v_role = 'parent' and p_student_id = any(public.current_parent_student_ids()) then
    v_authorized := true;
  end if;
  if not v_authorized then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;
  v_staff_view := v_role in ('admin', 'teacher');

  select * into v_student from public.students where id = p_student_id and school_id = v_caller_school;
  if not found then raise exception 'Student not found'; end if;

  select * into v_exam from public.exams where id = p_exam_id and school_id = v_caller_school;
  if not found then raise exception 'Exam not found'; end if;

  select * into v_class from public.classes where id = v_student.class_id;
  select * into v_stream from public.streams where id = v_student.stream_id;
  select * into v_year from public.academic_years where id = v_exam.academic_year_id;
  select * into v_term from public.terms where id = v_exam.term_id;

  -- Resolve the minimum-subjects rule with the same precedence the JS
  -- broadsheet/publish-gate uses: a per-(exam,class) override on
  -- exam_classes.min_subjects wins when set; otherwise fall back to the
  -- school-wide settings row. Keeps this RPC's report card consistent with
  -- getBroadsheet()/resolveMinSubjects() in src/lib/api/results.mjs.
  select ec.min_subjects into v_min_subjects
    from public.exam_classes ec
    where ec.exam_id = p_exam_id and ec.class_id = v_student.class_id;

  if v_min_subjects is null then
    select coalesce(nullif(value, '')::int, 0) into v_min_subjects
      from public.settings where school_id = v_caller_school and key = 'min_subjects_for_ranking';
  end if;
  if v_min_subjects is null then v_min_subjects := 0; end if;

  with per_row as (
    select
      r.subject_id,
      coalesce(s.name, '(deleted)') as subject_name,
      r.score,
      coalesce(sp.weight, 1) as weight,
      coalesce(sp.out_of, v_exam.out_of, 100) as row_out_of
    from public.results r
    left join public.subjects s on s.id = r.subject_id
    left join public.subject_papers sp on sp.id = r.paper_id
    where r.exam_id = p_exam_id and r.student_id = p_student_id and r.school_id = v_caller_school
      and r.score is not null
      and (v_staff_view or exists (
        select 1 from public.result_submissions rs2
        where rs2.exam_id = r.exam_id and rs2.class_id = r.class_id and rs2.subject_id = r.subject_id
          and rs2.status = 'published'
      ))
  ),
  per_subject as (
    select subject_id, subject_name, sum(score * weight / row_out_of * v_exam.out_of) as effective_score
    from per_row
    group by subject_id, subject_name
  ),
  graded as (
    select ps.subject_id, ps.subject_name, ps.effective_score, gr.grade_label, gr.points, gr.remark
    from per_subject ps
    left join lateral (
      select gr.grade_label, gr.points, gr.remark
      from public.grade_ranges gr
      join public.grading_scales gs on gs.id = gr.grading_scale_id
      where gs.is_default = true and gs.school_id = v_caller_school
        and ps.effective_score >= gr.min_score and ps.effective_score <= gr.max_score
      limit 1
    ) gr on true
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'subject_id', subject_id, 'subject_name', subject_name,
      'score', round(effective_score, 2), 'grade_label', coalesce(grade_label, ''),
      'points', points, 'remark', coalesce(remark, '')
    ) order by subject_name), '[]'::jsonb),
    coalesce(sum(effective_score), 0),
    count(*)
  into v_subjects, v_total, v_count
  from graded;

  v_average := case when v_count > 0 then round(v_total / v_count, 2) else 0 end;

  select grade_label into v_overall_grade
    from public.grade_ranges gr
    join public.grading_scales gs on gs.id = gr.grading_scale_id and gs.is_default = true and gs.school_id = v_caller_school
    where v_average >= gr.min_score and v_average <= gr.max_score
    limit 1;


  -- Round 2 §10: a student who sat fewer subjects than the required minimum
  -- automatically gets an "X" overall grade for this exam, mirroring
  -- getBroadsheet()'s belowMinimum logic in src/lib/api/results.mjs.
  v_below_minimum := v_min_subjects > 0 and v_count < v_min_subjects;
  if v_below_minimum then
    v_overall_grade := 'X';
  end if;

  with cohort as (
    select
      st.id,
      coalesce((
        select sum(r2.score * coalesce(sp2.weight, 1) / coalesce(sp2.out_of, v_exam.out_of, 100) * v_exam.out_of)
        from public.results r2
        left join public.subject_papers sp2 on sp2.id = r2.paper_id
        where r2.exam_id = p_exam_id and r2.student_id = st.id and r2.school_id = v_caller_school
          and r2.score is not null
          and exists (
            select 1 from public.result_submissions rs3
            where rs3.exam_id = r2.exam_id and rs3.class_id = r2.class_id and rs3.subject_id = r2.subject_id
              and rs3.status = 'published'
          )
      ), 0) as total,
      (
        select count(distinct r3.subject_id)
        from public.results r3
        where r3.exam_id = p_exam_id and r3.student_id = st.id and r3.school_id = v_caller_school
          and r3.score is not null
          and exists (
            select 1 from public.result_submissions rs4
            where rs4.exam_id = r3.exam_id and rs4.class_id = r3.class_id and rs4.subject_id = r3.subject_id
              and rs4.status = 'published'
          )
      ) as subject_count
    from public.students st
    where st.class_id = v_student.class_id and st.status = 'active' and st.school_id = v_caller_school
  ),
  ranked as (
    select id, total, rank() over (order by total desc) as pos
    from cohort
    where total > 0 and subject_count >= v_min_subjects
  )
  select (select pos from ranked where id = p_student_id),
         (select count(*) from ranked)
    into v_position, v_class_size;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'full_name', v_student.full_name, 'admission_no', v_student.admission_no,
      'class_name', coalesce(v_class.name, ''), 'stream_name', coalesce(v_stream.name, ''),
      'gender', v_student.gender
    ),
    'exam', jsonb_build_object('name', v_exam.name, 'out_of', v_exam.out_of, 'exam_type', v_exam.exam_type),
    'session_name', coalesce(v_year.name, ''), 'term_name', coalesce(v_term.name, ''),
    'subjects', v_subjects, 'total', v_total, 'average', v_average,
    'overall_grade', coalesce(v_overall_grade, ''), 'position', v_position,
    'class_size', coalesce(v_class_size, 0), 'below_minimum', v_below_minimum
  );
end;
$$;
grant execute on function public.get_report_card(uuid, uuid) to authenticated;


-- ============================================================================
-- Phase 1 — Attendance, Messaging log, Parent Portal
-- ============================================================================
-- Adds: daily student/staff attendance, a message log (ready to plug a real
-- SMS provider into — see netlify/functions/send-message.js), and a Parent
-- account kind that can see its own linked children's results/attendance and
-- nothing else. None of this touches the Phase 0 multi-tenancy boundary —
-- every new table carries the same school_id + auto-stamp trigger pattern.

-- ('parent' is already part of user_role — see the enum declaration near the
-- top of this file. A fresh install doesn't need the ALTER TYPE ... ADD VALUE
-- step that live databases do via migration 0003a; that statement used to
-- live here too, but running this whole file as one pasted block — which is
-- exactly how the Supabase SQL Editor executes it — hit "ERROR 55P04: unsafe
-- use of new value" the moment a policy below it referenced 'parent', since
-- Postgres won't let a brand-new enum value be used in the same transaction
-- that added it. Declaring it up front, as part of a type that doesn't exist
-- yet, sidesteps the problem entirely for a fresh install.)

-- ----------------------------------------------------------------------------
-- student_attendance
-- ----------------------------------------------------------------------------
create table public.student_attendance (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  date date not null,
  status text not null default 'present',
  marked_by uuid references public.staff(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, date),
  constraint student_attendance_status_check check (status in ('present', 'absent', 'late', 'excused'))
);
create trigger trg_student_attendance_updated_at before update on public.student_attendance
  for each row execute function public.set_updated_at();
create trigger trg_student_attendance_school_id before insert on public.student_attendance
  for each row execute function public.set_school_id();
create index idx_student_attendance_school on public.student_attendance(school_id);
create index idx_student_attendance_class_date on public.student_attendance(class_id, date);
create index idx_student_attendance_student on public.student_attendance(student_id);

-- ----------------------------------------------------------------------------
-- staff_attendance
-- ----------------------------------------------------------------------------
-- Round 3 §19: "Add a new feature under the Attendance module for staff
-- sign-in and sign-out, capturing the actual time of each." sign_in_time/
-- sign_out_time are plain nullable `time` columns on the SAME row this
-- table already keyed by (staff_id, date) for present/absent/late/excused
-- marking — a day's sign-in/out times and its coarse status are properties
-- of the same "this staff member, this day" fact, not two separate
-- concepts, so one row covers both rather than a new table. Whether a
-- sign-in/out counts as "late"/"left early" is deliberately NOT stored here
-- (no is_late/left_early column) — it's computed at read time in
-- src/lib/staffAttendance.mjs against the school's CURRENT expected
-- arrival/departure times (settings keys staff_expected_arrival_time/
-- staff_expected_departure_time), so changing the expected times later
-- reclassifies every past day consistently instead of leaving old rows
-- stamped against a since-changed cutoff.
create table public.staff_attendance (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  date date not null,
  status text not null default 'present',
  sign_in_time time,
  sign_out_time time,
  marked_by uuid references public.staff(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, date),
  constraint staff_attendance_status_check check (status in ('present', 'absent', 'late', 'excused'))
);
create trigger trg_staff_attendance_updated_at before update on public.staff_attendance
  for each row execute function public.set_updated_at();
create trigger trg_staff_attendance_school_id before insert on public.staff_attendance
  for each row execute function public.set_school_id();
create index idx_staff_attendance_school on public.staff_attendance(school_id);
create index idx_staff_attendance_date on public.staff_attendance(date);

-- ----------------------------------------------------------------------------
-- parent_links — which parent profile can see which student(s)
-- ----------------------------------------------------------------------------
create table public.parent_links (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  parent_profile_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  relationship text,
  created_at timestamptz not null default now(),
  unique (parent_profile_id, student_id)
);
create trigger trg_parent_links_school_id before insert on public.parent_links
  for each row execute function public.set_school_id();
create index idx_parent_links_school on public.parent_links(school_id);
create index idx_parent_links_parent on public.parent_links(parent_profile_id);
create index idx_parent_links_student on public.parent_links(student_id);

-- Every child a signed-in parent is linked to — SECURITY DEFINER so it can
-- be used freely inside RLS policies on students/results/attendance without
-- those policies needing to know about parent_links directly.
create or replace function public.current_parent_student_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(student_id), '{}') from public.parent_links where parent_profile_id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- message_logs — one row per actual recipient of a send (a "message a whole
-- class" action fans out into one row per guardian phone, sharing a
-- batch_id), so delivery status is trackable per-recipient like a real SMS
-- gateway reports it, and the history view can group by batch.
-- ----------------------------------------------------------------------------
create table public.message_logs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  batch_id uuid not null default gen_random_uuid(),
  sent_by uuid references public.staff(id) on delete set null,
  recipient_scope text not null,
  scope_label text,
  student_id uuid references public.students(id) on delete set null,
  staff_id uuid references public.staff(id) on delete set null,
  phone text,
  body text not null,
  channel text not null default 'sms',
  status text not null default 'logged',
  provider_response text,
  created_at timestamptz not null default now(),
  constraint message_logs_scope_check check (recipient_scope in ('class', 'individual_student', 'individual_staff', 'broadcast')),
  constraint message_logs_status_check check (status in ('logged', 'queued', 'sent', 'failed'))
);
create trigger trg_message_logs_school_id before insert on public.message_logs
  for each row execute function public.set_school_id();
create index idx_message_logs_school on public.message_logs(school_id);
create index idx_message_logs_batch on public.message_logs(batch_id);

-- ----------------------------------------------------------------------------
-- Row-Level Security — same school_id boundary as every Phase 0 table, plus
-- narrow parent-specific read access to their own children's records.
-- ----------------------------------------------------------------------------
alter table public.student_attendance enable row level security;
alter table public.staff_attendance enable row level security;
alter table public.parent_links enable row level security;
alter table public.message_logs enable row level security;

create policy student_attendance_staff_read on public.student_attendance for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy student_attendance_own_read on public.student_attendance for select
  using (student_id = public.current_student_id() and school_id = public.current_school_id());
create policy student_attendance_parent_read on public.student_attendance for select
  using (public.current_role() = 'parent' and student_id = any(public.current_parent_student_ids()) and school_id = public.current_school_id());
create policy student_attendance_staff_write on public.student_attendance for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy student_attendance_staff_update on public.student_attendance for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy student_attendance_admin_delete on public.student_attendance for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy staff_attendance_staff_read on public.staff_attendance for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy staff_attendance_staff_write on public.staff_attendance for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy staff_attendance_staff_update on public.staff_attendance for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy staff_attendance_admin_delete on public.staff_attendance for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy parent_links_self_read on public.parent_links for select
  using (parent_profile_id = auth.uid() or (public.is_admin() and school_id = public.current_school_id()));
create policy parent_links_admin_write on public.parent_links for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy parent_links_admin_update on public.parent_links for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy parent_links_admin_delete on public.parent_links for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy message_logs_staff_read on public.message_logs for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy message_logs_staff_write on public.message_logs for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy message_logs_admin_delete on public.message_logs for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- ----------------------------------------------------------------------------
-- Round 4 §7 — Timetable module (see migrations/0018_timetable.sql for the
-- full design rationale in comment form; this is the same DDL, just without
-- the `if not exists`/idempotency guards a migration needs against an
-- already-upgraded live database).
-- ----------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  capacity integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_rooms_updated_at before update on public.rooms
  for each row execute function public.set_updated_at();
create trigger trg_rooms_school_id before insert on public.rooms
  for each row execute function public.set_school_id();
create index idx_rooms_school on public.rooms(school_id);
create unique index idx_rooms_unique_name on public.rooms(school_id, name);

-- One school-wide daily period template (which days it repeats across lives
-- in `settings.timetable_days`, e.g. "Mon,Tue,Wed,Thu,Fri" — no schema
-- change needed for that).
create table public.timetable_periods (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  period_index integer not null,
  start_time text not null,
  end_time text not null,
  is_break boolean not null default false,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_timetable_periods_updated_at before update on public.timetable_periods
  for each row execute function public.set_updated_at();
create trigger trg_timetable_periods_school_id before insert on public.timetable_periods
  for each row execute function public.set_school_id();
create index idx_tt_periods_school on public.timetable_periods(school_id);
create unique index idx_tt_periods_unique_index on public.timetable_periods(school_id, period_index);

create table public.teacher_unavailability (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  day_of_week smallint not null,   -- 1=Mon .. 7=Sun (0019_timetable_fixes.sql widened this from 1-6 so Sunday teaching is supported)
  period_index integer not null,
  created_at timestamptz not null default now(),
  constraint teacher_unavailability_day_check check (day_of_week between 1 and 7)
);
create trigger trg_teacher_unavailability_school_id before insert on public.teacher_unavailability
  for each row execute function public.set_school_id();
create index idx_tt_unavail_school on public.teacher_unavailability(school_id);
create index idx_tt_unavail_staff on public.teacher_unavailability(staff_id);
create unique index idx_tt_unavail_unique on public.teacher_unavailability(staff_id, day_of_week, period_index);

-- Always scoped to a specific stream, never "whole class" — every class
-- already has at least one arm/stream (Round 3 §17), so there's no
-- genuinely streamless case to model.
-- version_number/is_active (0026_timetable_versions.sql, Round 5 §10): a
-- regenerate no longer hard-deletes the previous timetable — it deactivates
-- it and inserts the new placement as the next version_number, keeping the
-- last 3 versions per (academic_year_id, term_id) so a school can reactivate
-- an older one if a fresh regenerate turns out worse. Every row already IS
-- one version's data, so this partitions a scope's rows by generation
-- instead of needing a separate versions table.
create table public.timetable_entries (
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
  version_number integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timetable_entries_day_check check (day_of_week between 1 and 7)
);
create trigger trg_timetable_entries_updated_at before update on public.timetable_entries
  for each row execute function public.set_updated_at();
create trigger trg_timetable_entries_school_id before insert on public.timetable_entries
  for each row execute function public.set_school_id();
create index idx_tt_entries_school on public.timetable_entries(school_id);
create index idx_tt_entries_scope on public.timetable_entries(academic_year_id, term_id);
create index idx_tt_entries_class on public.timetable_entries(class_id);
create index idx_tt_entries_stream on public.timetable_entries(stream_id);
create index idx_tt_entries_staff on public.timetable_entries(staff_id);
create index idx_tt_entries_version_scope on public.timetable_entries(academic_year_id, term_id, version_number);
-- Slot-uniqueness is scoped PER VERSION, not per whole scope — two
-- different versions may legitimately place the same stream/staff/room in
-- the same slot (that's the point of a regenerate); only within one
-- version does a slot need to stay unique.
create unique index idx_tt_entries_unique_stream_slot
  on public.timetable_entries(academic_year_id, term_id, version_number, day_of_week, period_index, stream_id);
create unique index idx_tt_entries_unique_staff_slot
  on public.timetable_entries(academic_year_id, term_id, version_number, day_of_week, period_index, staff_id) where staff_id is not null;
create unique index idx_tt_entries_unique_room_slot
  on public.timetable_entries(academic_year_id, term_id, version_number, day_of_week, period_index, room_id) where room_id is not null;

-- 0024_timetable_constraints.sql (Round 2 §7): school-configured scheduling
-- preferences fed into the placement engine (generate.mjs) as soft
-- constraints — see that migration's header comment for the full design
-- rationale and the 6 supported constraint types.
create table public.timetable_constraints (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  type text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Round 6 §4 adds distribute_doubles — see 0027_distribute_doubles.sql.
  constraint timetable_constraints_type_check check (type in (
    'subject_pair_not_consecutive', 'avoid_consecutive_intensive', 'teacher_no_immediate_after_out',
    'pe_before_break', 'max_consecutive_periods_class', 'max_consecutive_periods_teacher',
    'distribute_doubles'
  ))
);
create trigger trg_timetable_constraints_updated_at before update on public.timetable_constraints
  for each row execute function public.set_updated_at();
create trigger trg_timetable_constraints_school_id before insert on public.timetable_constraints
  for each row execute function public.set_school_id();
create index idx_timetable_constraints_school on public.timetable_constraints(school_id);
create index idx_timetable_constraints_type on public.timetable_constraints(school_id, type);

alter table public.rooms enable row level security;
alter table public.timetable_periods enable row level security;
alter table public.teacher_unavailability enable row level security;
alter table public.timetable_entries enable row level security;
alter table public.timetable_constraints enable row level security;

create policy rooms_read on public.rooms for select
  using (school_id = public.current_school_id());
create policy rooms_admin_write on public.rooms for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy rooms_admin_update on public.rooms for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy rooms_admin_delete on public.rooms for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy timetable_periods_read on public.timetable_periods for select
  using (school_id = public.current_school_id());
create policy timetable_periods_admin_write on public.timetable_periods for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy timetable_periods_admin_update on public.timetable_periods for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy timetable_periods_admin_delete on public.timetable_periods for delete
  using (public.is_admin() and school_id = public.current_school_id());

create policy teacher_unavailability_read on public.teacher_unavailability for select
  using (school_id = public.current_school_id());
create policy teacher_unavailability_staff_write on public.teacher_unavailability for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy teacher_unavailability_staff_delete on public.teacher_unavailability for delete
  using (public.is_staff() and school_id = public.current_school_id());

create policy timetable_entries_read on public.timetable_entries for select
  using (school_id = public.current_school_id());
create policy timetable_entries_staff_write on public.timetable_entries for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy timetable_entries_staff_update on public.timetable_entries for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy timetable_entries_staff_delete on public.timetable_entries for delete
  using (public.is_staff() and school_id = public.current_school_id());

create policy timetable_constraints_read on public.timetable_constraints for select
  using (school_id = public.current_school_id());
create policy timetable_constraints_admin_write on public.timetable_constraints for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy timetable_constraints_admin_update on public.timetable_constraints for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy timetable_constraints_admin_delete on public.timetable_constraints for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- Additional, narrow parent read access bolted onto existing tables — these
-- are extra PERMISSIVE policies (Postgres OR's them with the ones already on
-- these tables from Phase 0), so nothing already granted to admin/teacher/
-- student is changed or narrowed by adding these.
create policy students_parent_read on public.students for select
  using (public.current_role() = 'parent' and id = any(public.current_parent_student_ids()) and school_id = public.current_school_id());
create policy results_parent_read on public.results for select
  using (public.current_role() = 'parent' and student_id = any(public.current_parent_student_ids()) and school_id = public.current_school_id());

-- ----------------------------------------------------------------------------
-- get_report_card(): extend authorization to a parent viewing their own
-- linked child's card, everything else identical to Phase 0.
-- ----------------------------------------------------------------------------
create or replace function public.get_report_card(p_exam_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_own_student_id uuid;
  v_caller_school uuid;
  v_student public.students%rowtype;
  v_exam public.exams%rowtype;
  v_class public.classes%rowtype;
  v_stream public.streams%rowtype;
  v_year public.academic_years%rowtype;
  v_term public.terms%rowtype;
  v_subjects jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_average numeric := 0;
  v_overall_grade text;
  v_position int;
  v_class_size int;
  v_authorized boolean := false;
begin
  v_role := public.current_role();
  v_own_student_id := public.current_student_id();
  v_caller_school := public.current_school_id();

  if v_role is null or v_caller_school is null then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;

  if v_role in ('admin', 'teacher') then
    v_authorized := true;
  elsif v_role = 'student' and v_own_student_id is not distinct from p_student_id then
    v_authorized := true;
  elsif v_role = 'parent' and p_student_id = any(public.current_parent_student_ids()) then
    v_authorized := true;
  end if;
  if not v_authorized then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;

  select * into v_student from public.students where id = p_student_id and school_id = v_caller_school;
  if not found then raise exception 'Student not found'; end if;

  select * into v_exam from public.exams where id = p_exam_id and school_id = v_caller_school;
  if not found then raise exception 'Exam not found'; end if;

  select * into v_class from public.classes where id = v_student.class_id;
  select * into v_stream from public.streams where id = v_student.stream_id;
  select * into v_year from public.academic_years where id = v_exam.academic_year_id;
  select * into v_term from public.terms where id = v_exam.term_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'subject_id', r.subject_id, 'subject_name', coalesce(s.name, '(deleted)'),
           'score', r.score, 'grade_label', r.grade_label, 'points', r.points, 'remark', r.remark
         ) order by s.name), '[]'::jsonb),
         coalesce(sum(r.score), 0), count(r.score)
    into v_subjects, v_total, v_count
    from public.results r
    left join public.subjects s on s.id = r.subject_id
    where r.exam_id = p_exam_id and r.student_id = p_student_id and r.school_id = v_caller_school;

  v_average := case when v_count > 0 then round(v_total / v_count, 2) else 0 end;

  select grade_label into v_overall_grade
    from public.grade_ranges gr
    join public.grading_scales gs on gs.id = gr.grading_scale_id and gs.is_default = true and gs.school_id = v_caller_school
    where v_average >= gr.min_score and v_average <= gr.max_score
    limit 1;

  with cohort as (
    select st.id,
           coalesce((select sum(r2.score) from public.results r2
                     where r2.exam_id = p_exam_id and r2.student_id = st.id and r2.school_id = v_caller_school), 0) as total
    from public.students st
    where st.class_id = v_student.class_id and st.status = 'active' and st.school_id = v_caller_school
  ),
  ranked as (
    select id, total, rank() over (order by total desc) as pos from cohort where total > 0
  )
  select (select pos from ranked where id = p_student_id), (select count(*) from ranked)
    into v_position, v_class_size;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'full_name', v_student.full_name, 'admission_no', v_student.admission_no,
      'class_name', coalesce(v_class.name, ''), 'stream_name', coalesce(v_stream.name, ''),
      'gender', v_student.gender
    ),
    'exam', jsonb_build_object('name', v_exam.name, 'out_of', v_exam.out_of),
    'session_name', coalesce(v_year.name, ''), 'term_name', coalesce(v_term.name, ''),
    'subjects', v_subjects, 'total', v_total, 'average', v_average,
    'overall_grade', coalesce(v_overall_grade, ''), 'position', v_position,
    'class_size', coalesce(v_class_size, 0)
  );
end;
$$;
grant execute on function public.get_report_card(uuid, uuid) to authenticated;

-- ============================================================================
-- Phase 2a — Exam Workflow Maturity
-- ============================================================================
-- results_parent_read (Phase 1, above) now also needs the publish gate —
-- create-or-replace-ing it here rather than editing the Phase 1 block keeps
-- this file's own history readable phase-by-phase, same convention
-- get_report_card already uses.
drop policy if exists results_parent_read on public.results;
create policy results_parent_read on public.results for select
  using (
    public.current_role() = 'parent'
    and student_id = any(public.current_parent_student_ids())
    and school_id = public.current_school_id()
    and public.is_result_published(exam_id, class_id, subject_id)
  );

-- get_report_card(): re-implemented on top of the publish gate + subject
-- paper weighting + minimum-subjects-for-ranking rule. Staff (admin/teacher)
-- still see every entered mark when previewing (published or not — useful
-- to check work before publishing); a student/parent only ever sees
-- published subjects. Class ranking is ALWAYS computed from published
-- results only, for every student in the cohort, regardless of who's
-- asking — so a position never depends on what a staff member happens to
-- be mid-editing, and is always a fair, stable, apples-to-apples number.
--
-- Round 6 §1 (BUG, see migrations/0028_round_report_card.sql): every
-- subject's `score`, `total` and `average` here are now rounded to a WHOLE
-- number (was 2 decimal places) — a combined subject (Subject Combination,
-- e.g. SST/CRE) or a plain subject's own raw mark was still displaying a
-- decimal on the Report Form. Purely a display change: nothing here fed
-- into ranking even before this (the `cohort`/`ranked` CTEs below compute
-- their own independent, unrounded totals for that).
create or replace function public.get_report_card(p_exam_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_own_student_id uuid;
  v_caller_school uuid;
  v_student public.students%rowtype;
  v_exam public.exams%rowtype;
  v_class public.classes%rowtype;
  v_stream public.streams%rowtype;
  v_year public.academic_years%rowtype;
  v_term public.terms%rowtype;
  v_subjects jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_average numeric := 0;
  v_overall_grade text;
  v_position int;
  v_class_size int;
  v_authorized boolean := false;
  v_staff_view boolean;
  v_min_subjects int := 0;
  v_below_minimum boolean := false;
begin
  v_role := public.current_role();
  v_own_student_id := public.current_student_id();
  v_caller_school := public.current_school_id();

  if v_role is null or v_caller_school is null then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;

  if v_role in ('admin', 'teacher') then
    v_authorized := true;
  elsif v_role = 'student' and v_own_student_id is not distinct from p_student_id then
    v_authorized := true;
  elsif v_role = 'parent' and p_student_id = any(public.current_parent_student_ids()) then
    v_authorized := true;
  end if;
  if not v_authorized then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;
  v_staff_view := v_role in ('admin', 'teacher');

  select * into v_student from public.students where id = p_student_id and school_id = v_caller_school;
  if not found then raise exception 'Student not found'; end if;

  select * into v_exam from public.exams where id = p_exam_id and school_id = v_caller_school;
  if not found then raise exception 'Exam not found'; end if;

  select * into v_class from public.classes where id = v_student.class_id;
  select * into v_stream from public.streams where id = v_student.stream_id;
  select * into v_year from public.academic_years where id = v_exam.academic_year_id;
  select * into v_term from public.terms where id = v_exam.term_id;

  -- Resolve the minimum-subjects rule with the same precedence the JS
  -- broadsheet/publish-gate uses: a per-(exam,class) override on
  -- exam_classes.min_subjects wins when set; otherwise fall back to the
  -- school-wide settings row. Keeps this RPC's report card consistent with
  -- getBroadsheet()/resolveMinSubjects() in src/lib/api/results.mjs.
  select ec.min_subjects into v_min_subjects
    from public.exam_classes ec
    where ec.exam_id = p_exam_id and ec.class_id = v_student.class_id;

  if v_min_subjects is null then
    select coalesce(nullif(value, '')::int, 0) into v_min_subjects
      from public.settings where school_id = v_caller_school and key = 'min_subjects_for_ranking';
  end if;
  if v_min_subjects is null then v_min_subjects := 0; end if;

  with per_row as (
    select
      r.subject_id,
      coalesce(s.name, '(deleted)') as subject_name,
      r.score,
      coalesce(sp.weight, 1) as weight,
      coalesce(sp.out_of, v_exam.out_of, 100) as row_out_of
    from public.results r
    left join public.subjects s on s.id = r.subject_id
    left join public.subject_papers sp on sp.id = r.paper_id
    where r.exam_id = p_exam_id and r.student_id = p_student_id and r.school_id = v_caller_school
      and r.score is not null
      and (v_staff_view or exists (
        select 1 from public.result_submissions rs2
        where rs2.exam_id = r.exam_id and rs2.class_id = r.class_id and rs2.subject_id = r.subject_id
          and rs2.status = 'published'
      ))
  ),
  per_subject as (
    select subject_id, subject_name, sum(score * weight / row_out_of * v_exam.out_of) as effective_score
    from per_row
    group by subject_id, subject_name
  ),
  -- Round 5 §3: Subject Combination — fold 2+ member subjects' effective
  -- scores into ONE combined entry, exactly like getBroadsheet() does.
  combo_defs as (
    select sc.id as combo_id, sc.name as combo_name, scm.subject_id, scm.weight
    from public.subject_combinations sc
    join public.subject_combination_members scm on scm.combination_id = sc.id
    where sc.exam_id = p_exam_id
  ),
  combo_member_count as (
    select combo_id, count(*) as n_members from combo_defs group by combo_id
  ),
  -- A combo only activates here when EVERY one of its members is present in
  -- per_subject (i.e. actually visible to this caller — see the comment at
  -- the top of this migration) AND it has at least 2 members configured.
  combo_active as (
    select cd.combo_id, min(cd.combo_name) as combo_name
    from combo_defs cd
    join combo_member_count cmc on cmc.combo_id = cd.combo_id
    join per_subject ps on ps.subject_id = cd.subject_id
    group by cd.combo_id
    having count(*) = min(cmc.n_members) and min(cmc.n_members) >= 2
  ),
  combo_scores as (
    select ca.combo_id, ca.combo_name, sum(ps.effective_score * coalesce(cd.weight, 0)) as effective_score
    from combo_active ca
    join combo_defs cd on cd.combo_id = ca.combo_id
    join per_subject ps on ps.subject_id = cd.subject_id
    group by ca.combo_id, ca.combo_name
  ),
  combo_member_ids as (
    select distinct cd.subject_id
    from combo_defs cd
    join combo_active ca on ca.combo_id = cd.combo_id
  ),
  final_subjects as (
    select ps.subject_id::text as subject_id, ps.subject_name, ps.effective_score
    from per_subject ps
    where not exists (select 1 from combo_member_ids cmi where cmi.subject_id = ps.subject_id)
    union all
    select 'combo:' || cs.combo_id::text, cs.combo_name, cs.effective_score
    from combo_scores cs
  ),
  graded as (
    select fs.subject_id, fs.subject_name, fs.effective_score, gr.grade_label, gr.points, gr.remark
    from final_subjects fs
    left join lateral (
      -- Sprint Review bug fix: grade off round(fs.effective_score), not the
      -- raw fraction — a Subject Combination's weighted-sum score very
      -- often lands on a decimal (e.g. 84.6), and integer grade-range
      -- bands (…73-84, 85-100…) have no band covering that fraction, so
      -- some students silently got no Performance Level at all while a
      -- classmate whose combo score happened to round to a whole number
      -- was fine. Grading off the same whole number this function already
      -- displays ('score', round(effective_score) below) closes the gap.
      select gr.grade_label, gr.points, gr.remark
      from public.grade_ranges gr
      join public.grading_scales gs on gs.id = gr.grading_scale_id
      where gs.is_default = true and gs.school_id = v_caller_school
        and round(fs.effective_score) >= gr.min_score and round(fs.effective_score) <= gr.max_score
      limit 1
    ) gr on true
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'subject_id', subject_id, 'subject_name', subject_name,
      'score', round(effective_score), 'grade_label', coalesce(grade_label, ''),
      'points', points, 'remark', coalesce(remark, '')
    ) order by subject_name), '[]'::jsonb),
    coalesce(sum(effective_score), 0),
    count(*)
  into v_subjects, v_total, v_count
  from graded;

  -- Sprint Review correction (final): the AVERAGE returned to callers is an
  -- aggregate figure and keeps 2 decimal places (round(x, 2)) instead of
  -- being rounded away to a whole number — same rule as _reportCard.mjs's
  -- summary boxes. The overall-grade band lookup below still compares
  -- round(v_average) (whole number) against the integer grade bands, same
  -- fix as the per-subject lateral join above, so a fractional average
  -- can't fall through a gap between bands — only the DISPLAYED value stays
  -- 2dp, the grade lookup still needs a whole number to match the bands.
  v_average := case when v_count > 0 then round(v_total / v_count, 2) else 0 end;

  select grade_label into v_overall_grade
    from public.grade_ranges gr
    join public.grading_scales gs on gs.id = gr.grading_scale_id and gs.is_default = true and gs.school_id = v_caller_school
    where round(v_average) >= gr.min_score and round(v_average) <= gr.max_score
    limit 1;


  -- Round 2 §10: a student who sat fewer subjects than the required minimum
  -- automatically gets an "X" overall grade for this exam, mirroring
  -- getBroadsheet()'s belowMinimum logic in src/lib/api/results.mjs.
  v_below_minimum := v_min_subjects > 0 and v_count < v_min_subjects;
  if v_below_minimum then
    v_overall_grade := 'X';
  end if;

  -- Round 5 §3: ranking totals must fold Subject Combinations exactly the
  -- same way the viewed student's own subject list was folded above —
  -- otherwise a classmate's ranking total would count a combo's member
  -- subjects individually (unweighted) while the viewed student's own
  -- total/average uses the weighted combined figure, producing a position
  -- that doesn't actually match either number shown on screen. Re-derives
  -- the same combo_defs/combo_active/combo_member_ids sets used above (a
  -- separate `with` statement can't see the earlier one's CTEs) — combo
  -- activation is evaluated against the VIEWED student's own subjects
  -- (matches "this combo is configured and showing for this class/exam" in
  -- the overwhelmingly common case where every student in a class sits the
  -- same subjects) and applied uniformly to every classmate's total below.
  with combo_defs as (
    select sc.id as combo_id, scm.subject_id, scm.weight
    from public.subject_combinations sc
    join public.subject_combination_members scm on scm.combination_id = sc.id
    where sc.exam_id = p_exam_id
  ),
  combo_member_count as (
    select combo_id, count(*) as n_members from combo_defs group by combo_id
  ),
  combo_active as (
    select cd.combo_id
    from combo_defs cd
    join combo_member_count cmc on cmc.combo_id = cd.combo_id
    join public.results vr on vr.subject_id = cd.subject_id and vr.exam_id = p_exam_id and vr.student_id = p_student_id
      and vr.school_id = v_caller_school and vr.score is not null
      and exists (
        select 1 from public.result_submissions vrs
        where vrs.exam_id = vr.exam_id and vrs.class_id = vr.class_id and vrs.subject_id = vr.subject_id and vrs.status = 'published'
      )
    group by cd.combo_id
    having count(*) = min(cmc.n_members) and min(cmc.n_members) >= 2
  ),
  combo_member_ids as (
    select distinct cd.subject_id
    from combo_defs cd
    join combo_active ca on ca.combo_id = cd.combo_id
  ),
  cohort as (
    select st.id, coalesce(agg.total, 0) as total, coalesce(agg.subject_count, 0) as subject_count
    from public.students st
    left join lateral (
      with per_row2 as (
        select r2.subject_id,
               sum(r2.score * coalesce(sp2.weight, 1) / coalesce(sp2.out_of, v_exam.out_of, 100) * v_exam.out_of) as effective_score
        from public.results r2
        left join public.subject_papers sp2 on sp2.id = r2.paper_id
        where r2.exam_id = p_exam_id and r2.student_id = st.id and r2.school_id = v_caller_school
          and r2.score is not null
          and exists (
            select 1 from public.result_submissions rs3
            where rs3.exam_id = r2.exam_id and rs3.class_id = r2.class_id and rs3.subject_id = r2.subject_id
              and rs3.status = 'published'
          )
        group by r2.subject_id
      ),
      folded as (
        select subject_id, effective_score from per_row2
        where subject_id not in (select subject_id from combo_member_ids)
        union all
        select ca.combo_id, sum(pr.effective_score * coalesce(cd.weight, 0))
        from combo_active ca
        join combo_defs cd on cd.combo_id = ca.combo_id
        join per_row2 pr on pr.subject_id = cd.subject_id
        group by ca.combo_id
      )
      select coalesce(sum(effective_score), 0) as total, count(*) as subject_count from folded
    ) agg on true
    where st.class_id = v_student.class_id and st.status = 'active' and st.school_id = v_caller_school
  ),
  ranked as (
    select id, total, rank() over (order by total desc) as pos
    from cohort
    where total > 0 and subject_count >= v_min_subjects
  )
  select (select pos from ranked where id = p_student_id),
         (select count(*) from ranked)
    into v_position, v_class_size;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'full_name', v_student.full_name, 'admission_no', v_student.admission_no,
      'class_name', coalesce(v_class.name, ''), 'stream_name', coalesce(v_stream.name, ''),
      'gender', v_student.gender
    ),
    'exam', jsonb_build_object('name', v_exam.name, 'out_of', v_exam.out_of, 'exam_type', v_exam.exam_type),
    'session_name', coalesce(v_year.name, ''), 'term_name', coalesce(v_term.name, ''),
    'subjects', v_subjects, 'total', round(v_total, 2), 'average', v_average,
    'overall_grade', coalesce(v_overall_grade, ''), 'position', v_position,
    'class_size', coalesce(v_class_size, 0), 'below_minimum', v_below_minimum
  );
end;
$$;
grant execute on function public.get_report_card(uuid, uuid) to authenticated;

grant execute on function public.has_capability(text) to authenticated;
grant execute on function public.is_class_teacher_of(uuid) to authenticated;

-- ============================================================================
-- save_results_batch — Phase 2f bulk-marks-save RPC (see
-- migrations/0008_bulk_marks_rpc.sql for full rationale). Folded in here for
-- fresh-install parity.
-- ============================================================================
create or replace function public.save_results_batch(
  p_exam_id uuid, p_class_id uuid, p_subject_id uuid, p_paper_id uuid, p_scores jsonb
)
returns table(saved int, cleared int)
language plpgsql
as $$
declare
  v_exam public.exams%rowtype;
  v_paper public.subject_papers%rowtype;
  v_out_of numeric;
  v_row jsonb;
  v_student_id uuid;
  v_raw text;
  v_score numeric;
  v_existing_id uuid;
  v_saved int := 0;
  v_cleared int := 0;
  v_grade_label text;
  v_points numeric;
  v_remark text;
begin
  if p_exam_id is null then raise exception 'Missing exam.'; end if;
  if p_subject_id is null then raise exception 'Missing subject.'; end if;
  if p_class_id is null then raise exception 'Missing class.'; end if;

  select * into v_exam from public.exams where id = p_exam_id;
  if v_exam.id is null then raise exception 'Exam not found.'; end if;
  v_out_of := coalesce(v_exam.out_of, 100);

  if p_paper_id is not null then
    select * into v_paper from public.subject_papers where id = p_paper_id;
    if v_paper.id is null then raise exception 'Paper not found.'; end if;
    v_out_of := coalesce(v_paper.out_of, 100);
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb))
  loop
    v_student_id := nullif(v_row->>'student_id', '')::uuid;
    if v_student_id is null then continue; end if;
    v_raw := trim(both from coalesce(v_row->>'score', ''));

    select id into v_existing_id from public.results
      where exam_id = p_exam_id and subject_id = p_subject_id and student_id = v_student_id
        and ((p_paper_id is null and paper_id is null) or paper_id = p_paper_id)
      limit 1;

    if v_raw = '' then
      if v_existing_id is not null then
        delete from public.results where id = v_existing_id;
        v_cleared := v_cleared + 1;
      end if;
      continue;
    end if;

    -- Same "skip invalid silently" behaviour as the client-side version —
    -- the UI already validates before calling this, this is just the
    -- server-side backstop against a malformed row slipping through.
    begin
      v_score := v_raw::numeric;
    exception when others then
      continue;
    end;
    if v_score < 0 or v_score > v_out_of then continue; end if;

    v_grade_label := null; v_points := null; v_remark := null;
    if p_paper_id is null then
      select gr.grade_label, gr.points, gr.remark into v_grade_label, v_points, v_remark
      from public.grade_ranges gr
      join public.grading_scales gs on gs.id = gr.grading_scale_id
      where gs.is_default = true and gs.school_id = public.current_school_id()
        and v_score >= gr.min_score and v_score <= gr.max_score
      limit 1;
    end if;

    if v_existing_id is not null then
      update public.results set
        score = v_score, grade_label = v_grade_label, points = v_points, remark = v_remark,
        class_id = p_class_id, academic_year_id = v_exam.academic_year_id, term_id = v_exam.term_id
      where id = v_existing_id;
    else
      insert into public.results
        (exam_id, student_id, subject_id, academic_year_id, term_id, class_id, paper_id, score, grade_label, points, remark)
      values
        (p_exam_id, v_student_id, p_subject_id, v_exam.academic_year_id, v_exam.term_id, p_class_id, p_paper_id, v_score, v_grade_label, v_points, v_remark);
    end if;
    v_saved := v_saved + 1;
  end loop;

  return query select v_saved, v_cleared;
end;
$$;

grant execute on function public.save_results_batch(uuid, uuid, uuid, uuid, jsonb) to authenticated;

-- ============================================================================
-- FINANCE MODULE (Finance_Module_Brief.docx) — fees, invoicing, collections,
-- transport billing, and basic bookkeeping reports. Deliberately scoped down
-- from the brief's own reference point (Zeraki Finance) per its explicit
-- instruction: "keep the build simple and useful over comprehensive and
-- complex" and "optimize for low infrastructure/server cost and reliability".
--
-- Design notes (read before touching this block):
--   - One invoice per (student, academic_year, term) — every charge for that
--     term (fee-structure items, transport, ad-hoc debit notes) is a line on
--     that ONE invoice, not a separate document per charge. This is what lets
--     brief scenario #4 ("correct a wrong transport line on her EXISTING
--     invoice") be a plain update to one invoice_items row (done via
--     finance_assign_route() below, which keeps the route assignment and the
--     invoice line in lockstep so they can never drift apart).
--   - Vote heads carry a `priority` (lower clears first) — brief scenario #6
--     ("change the configured priority so fees are cleared before transport
--     instead") is just re-numbering these; finance_allocate_collection()
--     below reads them in that order every time a payment is recorded.
--   - A payment that exceeds everything owed doesn't error or vanish — the
--     leftover becomes a `vote_head_id is null` allocation row, which every
--     balance query below treats as a credit (reduces the total balance) —
--     the brief's explicit overpayment requirement.
--   - Reverse/Transfer never delete a collection row — Reverse flips its
--     status (every balance query only sums status='active' rows, so a
--     reversed payment stops counting immediately) and Transfer creates a
--     NEW collection for the correct student while flipping the original to
--     status='transferred', linked both ways — full history stays intact for
--     the audit-trail scenario (#14) and for reprinting an old receipt
--     exactly as issued (#15).
--   - created_by/updated_by everywhere money moves — profiles.id (not
--     staff_id), so it reads as a name via a simple join, same convention as
--     every other "who did this" field in this codebase.
--   - Two capabilities gate everything (see has_capability() further up in
--     this file): 'finance_manage_fees' (vote heads, fee structures,
--     invoicing, routes, debit/credit notes) and
--     'finance_record_collections' (record/reverse/transfer collections,
--     view balances/statements/reports) — an admin always has both. Brief
--     scenario #20 ("grant a bursar collections + statements only, not fee
--     structures/notes") is exactly one capability grant, nothing more.
--   - "Balance B/F" and "Transport" are ordinary finance_vote_heads rows,
--     lazily created (finance_bootstrap(), idempotent) the first time a
--     school opens the Finance module — not hardcoded specials — so a school
--     can rename or re-prioritize either one exactly like any other vote
--     head.
-- ============================================================================

alter table public.staff_capabilities drop constraint staff_capabilities_capability_check;
alter table public.staff_capabilities add constraint staff_capabilities_capability_check
  check (capability in ('publish_results', 'finance_manage_fees', 'finance_record_collections'));

-- 0039_module_access_control.sql (SignUp_Fixes §5): 'deny_<module>' rows —
-- same table, same grant/revoke mechanism, opposite polarity from every
-- other capability here. Presence of one of these means "this staff member
-- does NOT see <module>", checked in app.js's buildNav()/allowedRoutes()
-- (see capabilities.mjs's DENIABLE_MODULES for the full list + labels).
alter table public.staff_capabilities drop constraint staff_capabilities_capability_check;
alter table public.staff_capabilities add constraint staff_capabilities_capability_check
  check (capability in (
    'publish_results', 'finance_manage_fees', 'finance_record_collections',
    'deny_students', 'deny_attendance', 'deny_messaging', 'deny_exams', 'deny_reports', 'deny_timetable'
  ));

create or replace function public.finance_can_manage()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_capability('finance_manage_fees') $$;

create or replace function public.finance_can_collect()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_capability('finance_manage_fees') or public.has_capability('finance_record_collections') $$;

grant execute on function public.finance_can_manage() to authenticated;
grant execute on function public.finance_can_collect() to authenticated;

-- ----------------------------------------------------------------------------
-- finance_vote_heads — the chart of "what fees are for" (Tuition, Transport,
-- Activity, Lunch, Balance B/F, ...). `priority` controls clearing order
-- when a payment is recorded (brief scenario #6); `is_transport` flags the
-- ONE vote head finance_assign_route() below charges transport against.
-- ----------------------------------------------------------------------------
create table public.finance_vote_heads (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  code text,
  priority int not null default 100,
  is_transport boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_finance_vote_heads_updated_at before update on public.finance_vote_heads
  for each row execute function public.set_updated_at();
create trigger trg_finance_vote_heads_school_id before insert on public.finance_vote_heads
  for each row execute function public.set_school_id();
create index idx_finance_vote_heads_school on public.finance_vote_heads(school_id);

-- ----------------------------------------------------------------------------
-- finance_routes / finance_student_routes — transport as its own vote head
-- (brief §Transport). Defined before finance_invoices below since invoice
-- line items reference a route directly.
-- ----------------------------------------------------------------------------
create table public.finance_routes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  pickup_point text,
  one_way_amount numeric not null default 0 check (one_way_amount >= 0),
  two_way_amount numeric not null default 0 check (two_way_amount >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_finance_routes_updated_at before update on public.finance_routes
  for each row execute function public.set_updated_at();
create trigger trg_finance_routes_school_id before insert on public.finance_routes
  for each row execute function public.set_school_id();
create index idx_finance_routes_school on public.finance_routes(school_id);

create table public.finance_student_routes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  route_id uuid not null references public.finance_routes(id) on delete restrict,
  direction text not null check (direction in ('one_way', 'two_way')),
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, academic_year_id, term_id)
);
create trigger trg_finance_student_routes_updated_at before update on public.finance_student_routes
  for each row execute function public.set_updated_at();
create trigger trg_finance_student_routes_school_id before insert on public.finance_student_routes
  for each row execute function public.set_school_id();
create index idx_finance_student_routes_school on public.finance_student_routes(school_id);
create index idx_finance_student_routes_student on public.finance_student_routes(student_id);

-- ----------------------------------------------------------------------------
-- finance_fee_structures — set up per (academic_year, term), tagged to one
-- or more classes (finance_fee_structure_classes) so a school can invoice
-- Grade 1/2 now and set up other grades' different amounts later (brief
-- scenario #5), each carrying a flat amount per vote head
-- (finance_fee_structure_items) applied uniformly to every targeted class.
-- ----------------------------------------------------------------------------
create table public.finance_fee_structures (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create trigger trg_finance_fee_structures_updated_at before update on public.finance_fee_structures
  for each row execute function public.set_updated_at();
create trigger trg_finance_fee_structures_school_id before insert on public.finance_fee_structures
  for each row execute function public.set_school_id();
create index idx_finance_fee_structures_school on public.finance_fee_structures(school_id);
create index idx_finance_fee_structures_term on public.finance_fee_structures(academic_year_id, term_id);

create table public.finance_fee_structure_classes (
  id uuid primary key default gen_random_uuid(),
  fee_structure_id uuid not null references public.finance_fee_structures(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  unique (fee_structure_id, class_id)
);
create index idx_finance_fsc_structure on public.finance_fee_structure_classes(fee_structure_id);
create index idx_finance_fsc_class on public.finance_fee_structure_classes(class_id);

create table public.finance_fee_structure_items (
  id uuid primary key default gen_random_uuid(),
  fee_structure_id uuid not null references public.finance_fee_structures(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete cascade,
  amount numeric not null check (amount >= 0),
  unique (fee_structure_id, vote_head_id)
);
create index idx_finance_fsi_structure on public.finance_fee_structure_items(fee_structure_id);

-- ----------------------------------------------------------------------------
-- finance_invoices / finance_invoice_items — ONE invoice per student per
-- term (see header note), line items broken down by vote head. Transport
-- lines additionally carry route_id/direction so finance_assign_route()
-- (below) can correct them in place (brief scenario #4).
-- ----------------------------------------------------------------------------
create table public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  invoice_no text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  unique (school_id, student_id, academic_year_id, term_id),
  unique (school_id, invoice_no)
);
create trigger trg_finance_invoices_updated_at before update on public.finance_invoices
  for each row execute function public.set_updated_at();
create trigger trg_finance_invoices_school_id before insert on public.finance_invoices
  for each row execute function public.set_school_id();
create index idx_finance_invoices_school on public.finance_invoices(school_id);
create index idx_finance_invoices_student on public.finance_invoices(student_id);
create index idx_finance_invoices_term on public.finance_invoices(academic_year_id, term_id);

create table public.finance_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.finance_invoices(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete restrict,
  fee_structure_id uuid references public.finance_fee_structures(id) on delete set null,
  amount numeric not null check (amount >= 0),
  description text,
  route_id uuid references public.finance_routes(id) on delete set null,
  direction text check (direction is null or direction in ('one_way', 'two_way')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_finance_invoice_items_updated_at before update on public.finance_invoice_items
  for each row execute function public.set_updated_at();
create index idx_finance_invoice_items_invoice on public.finance_invoice_items(invoice_id);
create index idx_finance_invoice_items_vote_head on public.finance_invoice_items(vote_head_id);

-- ----------------------------------------------------------------------------
-- finance_debit_notes / finance_credit_notes — brief §Invoicing: increase or
-- reduce a STUDENT'S OWN fees without touching the shared fee structure
-- (scenario #17's sibling discount must not affect the rest of the class).
-- Tracked as their own ledger, not folded into invoice_items, because the
-- Balances report explicitly wants a separate "credit note" column (brief
-- §Reports).
-- ----------------------------------------------------------------------------
create table public.finance_debit_notes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete restrict,
  amount numeric not null check (amount > 0),
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create trigger trg_finance_debit_notes_school_id before insert on public.finance_debit_notes
  for each row execute function public.set_school_id();
create index idx_finance_debit_notes_student on public.finance_debit_notes(student_id);
create index idx_finance_debit_notes_term on public.finance_debit_notes(academic_year_id, term_id);

create table public.finance_credit_notes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete restrict,
  amount numeric not null check (amount > 0),
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create trigger trg_finance_credit_notes_school_id before insert on public.finance_credit_notes
  for each row execute function public.set_school_id();
create index idx_finance_credit_notes_student on public.finance_credit_notes(student_id);
create index idx_finance_credit_notes_term on public.finance_credit_notes(academic_year_id, term_id);

-- ============================================================================
-- Next Sprint 2 §12 (0033_finance_note_reversal.sql) — reversal support. See
-- that migration's header comment for the full rationale: a wrongly-entered
-- debit/credit note is reversed by inserting a NEW, opposite-type note
-- (never deleted, never edited in place) so both the mistake and its
-- correction stay on permanent, dated, attributed record — and so every one
-- of the ~8 existing balance/report/statement queries that sum these two
-- tables keeps working completely unchanged (a reversed note still counts
-- normally; its opposite note is what brings the balance back to where it
-- should be).
-- ============================================================================
alter table public.finance_debit_notes add column reversed_at timestamptz;
alter table public.finance_debit_notes add column reversed_by uuid references public.profiles(id) on delete set null;
alter table public.finance_debit_notes add column reverses_credit_note_id uuid references public.finance_credit_notes(id) on delete set null;
alter table public.finance_credit_notes add column reversed_at timestamptz;
alter table public.finance_credit_notes add column reversed_by uuid references public.profiles(id) on delete set null;
alter table public.finance_credit_notes add column reverses_debit_note_id uuid references public.finance_debit_notes(id) on delete set null;

-- ----------------------------------------------------------------------------
-- finance_opening_balances — arrears a student already carried BEFORE this
-- system tracked them (brief scenario #9: bulk-uploaded for a newly set-up
-- class) or carried forward automatically from the previous academic year's
-- closing balance (scenario #12, via finance_carry_forward_balances()
-- below). One row per (student, academic_year) — a re-upload/re-run
-- overwrites it, so there's one source of truth per year, not an
-- accumulating history.
-- ----------------------------------------------------------------------------
create table public.finance_opening_balances (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  amount numeric not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  unique (student_id, academic_year_id)
);
create trigger trg_finance_opening_balances_updated_at before update on public.finance_opening_balances
  for each row execute function public.set_updated_at();
create trigger trg_finance_opening_balances_school_id before insert on public.finance_opening_balances
  for each row execute function public.set_school_id();
create index idx_finance_opening_balances_school on public.finance_opening_balances(school_id);
create index idx_finance_opening_balances_year on public.finance_opening_balances(academic_year_id);

-- ----------------------------------------------------------------------------
-- finance_counters — atomic per-school receipt/invoice numbering. A plain
-- "select max(...)+1" races under concurrent bursars; the upsert below plus
-- ON CONFLICT DO UPDATE serializes just the number assignment.
-- ----------------------------------------------------------------------------
create table public.finance_counters (
  school_id uuid not null references public.schools(id) on delete cascade,
  kind text not null check (kind in ('receipt', 'invoice')),
  next_no int not null default 1,
  primary key (school_id, kind)
);

-- ----------------------------------------------------------------------------
-- finance_collections / finance_collection_allocations — where money is
-- actually recorded (brief §Collections). See header note for how
-- Reverse/Transfer work.
-- ----------------------------------------------------------------------------
create table public.finance_collections (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  amount numeric not null check (amount > 0),
  mode text not null check (mode in ('cash', 'paybill', 'bank', 'other')),
  reference text,
  receipt_no text not null,
  status text not null default 'active' check (status in ('active', 'reversed', 'transferred')),
  notes text,
  reversed_reason text,
  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,
  transferred_from_collection_id uuid references public.finance_collections(id) on delete set null,
  transferred_to_collection_id uuid references public.finance_collections(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  unique (school_id, receipt_no)
);
create trigger trg_finance_collections_updated_at before update on public.finance_collections
  for each row execute function public.set_updated_at();
create trigger trg_finance_collections_school_id before insert on public.finance_collections
  for each row execute function public.set_school_id();
create index idx_finance_collections_school on public.finance_collections(school_id);
create index idx_finance_collections_student on public.finance_collections(student_id, status);
create index idx_finance_collections_term on public.finance_collections(academic_year_id, term_id, status);

create table public.finance_collection_allocations (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.finance_collections(id) on delete cascade,
  -- null vote_head_id = the overpayment/credit portion of this collection
  -- (brief: "the excess should carry forward as a credit balance ... not
  -- just sit as an error or get lost").
  vote_head_id uuid references public.finance_vote_heads(id) on delete set null,
  amount numeric not null check (amount > 0)
);
create index idx_finance_collection_allocations_collection on public.finance_collection_allocations(collection_id);
create index idx_finance_collection_allocations_vote_head on public.finance_collection_allocations(vote_head_id);

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.finance_vote_heads enable row level security;
alter table public.finance_routes enable row level security;
alter table public.finance_student_routes enable row level security;
alter table public.finance_fee_structures enable row level security;
alter table public.finance_fee_structure_classes enable row level security;
alter table public.finance_fee_structure_items enable row level security;
alter table public.finance_invoices enable row level security;
alter table public.finance_invoice_items enable row level security;
alter table public.finance_debit_notes enable row level security;
alter table public.finance_credit_notes enable row level security;
alter table public.finance_opening_balances enable row level security;
alter table public.finance_collections enable row level security;
alter table public.finance_collection_allocations enable row level security;

create policy finance_vote_heads_read on public.finance_vote_heads for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_vote_heads_write on public.finance_vote_heads for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_vote_heads_update on public.finance_vote_heads for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_vote_heads_delete on public.finance_vote_heads for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_routes_read on public.finance_routes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_routes_write on public.finance_routes for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_routes_update on public.finance_routes for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_routes_delete on public.finance_routes for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

-- finance_student_routes has no insert/update policy — every write goes
-- through finance_assign_route() below (security definer), which keeps the
-- assignment and its matching invoice line in lockstep.
create policy finance_student_routes_read on public.finance_student_routes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());

create policy finance_fee_structures_read on public.finance_fee_structures for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_fee_structures_write on public.finance_fee_structures for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_fee_structures_update on public.finance_fee_structures for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_fee_structures_delete on public.finance_fee_structures for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_fsc_read on public.finance_fee_structure_classes for select
  using (exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()) and public.finance_can_collect());
create policy finance_fsc_write on public.finance_fee_structure_classes for insert
  with check (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));
create policy finance_fsc_delete on public.finance_fee_structure_classes for delete
  using (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));

create policy finance_fsi_read on public.finance_fee_structure_items for select
  using (exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()) and public.finance_can_collect());
create policy finance_fsi_write on public.finance_fee_structure_items for insert
  with check (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));
create policy finance_fsi_update on public.finance_fee_structure_items for update
  using (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));
create policy finance_fsi_delete on public.finance_fee_structure_items for delete
  using (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));

create policy finance_invoices_read on public.finance_invoices for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_invoices_write on public.finance_invoices for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_invoices_update on public.finance_invoices for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_invoice_items_read on public.finance_invoice_items for select
  using (exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()) and public.finance_can_collect());
create policy finance_invoice_items_write on public.finance_invoice_items for insert
  with check (public.finance_can_manage() and exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()));
create policy finance_invoice_items_update on public.finance_invoice_items for update
  using (public.finance_can_manage() and exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()));
create policy finance_invoice_items_delete on public.finance_invoice_items for delete
  using (public.finance_can_manage() and exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()));

create policy finance_debit_notes_read on public.finance_debit_notes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_debit_notes_write on public.finance_debit_notes for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_credit_notes_read on public.finance_credit_notes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_credit_notes_write on public.finance_credit_notes for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_opening_balances_read on public.finance_opening_balances for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_opening_balances_write on public.finance_opening_balances for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_opening_balances_update on public.finance_opening_balances for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

-- finance_collections/finance_collection_allocations have NO insert/update
-- policy — every write goes through finance_record_collection/
-- finance_reverse_collection/finance_transfer_collection below (security
-- definer, own explicit finance_can_collect() checks), which is what keeps
-- "pay" and "allocate across vote heads by priority, overpayment as credit"
-- atomic and impossible to do halfway from the client (same pattern as
-- save_results_batch/get_report_card above).
create policy finance_collections_read on public.finance_collections for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_collection_allocations_read on public.finance_collection_allocations for select
  using (exists (select 1 from public.finance_collections c where c.id = collection_id and c.school_id = public.current_school_id()) and public.finance_can_collect());

-- ============================================================================
-- RPCs
-- ============================================================================

-- Idempotent bootstrap: called once from the Finance Hub's first load per
-- school session — creates the two vote heads every other RPC here assumes
-- exist ('Balance B/F' for opening-balance carry, and the one flagged
-- is_transport for finance_assign_route()) without ever duplicating them.
create or replace function public.finance_bootstrap()
returns void
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.finance_vote_heads (school_id, name, code, priority, is_transport)
    select v_school, 'Balance B/F', 'BALANCE_BF', 1, false
    where not exists (select 1 from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF');
  insert into public.finance_vote_heads (school_id, name, code, priority, is_transport)
    select v_school, 'Transport', 'TRANSPORT', 200, true
    where not exists (select 1 from public.finance_vote_heads where school_id = v_school and is_transport = true);
end;
$$;

create or replace function public.finance_next_no(p_kind text)
returns int
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id(); v_no int;
begin
  insert into public.finance_counters (school_id, kind, next_no) values (v_school, p_kind, 2)
  on conflict (school_id, kind) do update set next_no = public.finance_counters.next_no + 1
  returning next_no - 1 into v_no;
  return v_no;
end;
$$;

-- Assigns (or re-assigns/corrects — brief scenario #4) a student's transport
-- route for one term, and keeps the matching invoice line item in lockstep:
-- creates the invoice if the student doesn't have one yet for that term,
-- updates the existing Transport line if there is one, else adds it.
create or replace function public.finance_assign_route(
  p_student_id uuid, p_route_id uuid, p_direction text,
  p_academic_year_id uuid, p_term_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_route public.finance_routes%rowtype;
  v_vote_head_id uuid;
  v_amount numeric;
  v_invoice_id uuid;
  v_item_id uuid;
  v_invoice_no text;
  v_desc text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage transport/fees' using errcode = '42501'; end if;
  if p_direction not in ('one_way', 'two_way') then raise exception 'Invalid direction'; end if;

  select * into v_route from public.finance_routes where id = p_route_id and school_id = v_school;
  if not found then raise exception 'Route not found'; end if;

  select id into v_vote_head_id from public.finance_vote_heads where school_id = v_school and is_transport = true limit 1;
  if v_vote_head_id is null then
    insert into public.finance_vote_heads (school_id, name, code, is_transport, priority)
      values (v_school, 'Transport', 'TRANSPORT', true, 200) returning id into v_vote_head_id;
  end if;

  v_amount := case when p_direction = 'two_way' then v_route.two_way_amount else v_route.one_way_amount end;
  v_desc := v_route.name || ' — ' || initcap(replace(p_direction, '_', ' '));

  insert into public.finance_student_routes (student_id, route_id, direction, academic_year_id, term_id)
  values (p_student_id, p_route_id, p_direction, p_academic_year_id, p_term_id)
  on conflict (student_id, academic_year_id, term_id)
  do update set route_id = excluded.route_id, direction = excluded.direction, updated_at = now();

  select id into v_invoice_id from public.finance_invoices
    where student_id = p_student_id and academic_year_id = p_academic_year_id and term_id = p_term_id;
  if v_invoice_id is null then
    v_invoice_no := 'INV-' || lpad(public.finance_next_no('invoice')::text, 6, '0');
    insert into public.finance_invoices (school_id, student_id, academic_year_id, term_id, invoice_no, created_by)
      values (v_school, p_student_id, p_academic_year_id, p_term_id, v_invoice_no, auth.uid())
      returning id into v_invoice_id;
  end if;

  select id into v_item_id from public.finance_invoice_items
    where invoice_id = v_invoice_id and vote_head_id = v_vote_head_id and route_id is not null;
  if v_item_id is not null then
    update public.finance_invoice_items set route_id = p_route_id, direction = p_direction, amount = v_amount, description = v_desc, updated_at = now()
      where id = v_item_id;
  else
    insert into public.finance_invoice_items (invoice_id, vote_head_id, amount, description, route_id, direction)
      values (v_invoice_id, v_vote_head_id, v_amount, v_desc, p_route_id, p_direction);
  end if;

  update public.finance_invoices set updated_at = now(), updated_by = auth.uid() where id = v_invoice_id;
  return jsonb_build_object('invoice_id', v_invoice_id, 'amount', v_amount);
end;
$$;

-- Bulk-invoices a fee structure into its tagged classes (brief scenario #5),
-- or just the given students (scenario #8: a new mid-term joiner) when
-- p_student_ids is passed — same code path either way, so the two never
-- drift apart. Creates each student's term invoice if missing, then
-- upserts one line item per vote head in the structure (re-running it after
-- editing the structure's amounts updates every already-invoiced student).
create or replace function public.finance_generate_invoices(p_fee_structure_id uuid, p_student_ids uuid[] default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_fs public.finance_fee_structures%rowtype;
  v_student record;
  v_invoice_id uuid;
  v_invoice_no text;
  v_item record;
  v_count int := 0;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage fees' using errcode = '42501'; end if;
  select * into v_fs from public.finance_fee_structures where id = p_fee_structure_id and school_id = v_school;
  if not found then raise exception 'Fee structure not found'; end if;

  for v_student in
    select distinct s.id from public.students s
    join public.finance_fee_structure_classes fsc on fsc.class_id = s.class_id and fsc.fee_structure_id = p_fee_structure_id
    where s.school_id = v_school and s.status = 'active'
      and (p_student_ids is null or s.id = any(p_student_ids))
  loop
    select id into v_invoice_id from public.finance_invoices
      where student_id = v_student.id and academic_year_id = v_fs.academic_year_id and term_id = v_fs.term_id;
    if v_invoice_id is null then
      v_invoice_no := 'INV-' || lpad(public.finance_next_no('invoice')::text, 6, '0');
      insert into public.finance_invoices (school_id, student_id, academic_year_id, term_id, invoice_no, created_by)
        values (v_school, v_student.id, v_fs.academic_year_id, v_fs.term_id, v_invoice_no, auth.uid())
        returning id into v_invoice_id;
    end if;

    for v_item in select vote_head_id, amount from public.finance_fee_structure_items where fee_structure_id = p_fee_structure_id
    loop
      if exists (select 1 from public.finance_invoice_items where invoice_id = v_invoice_id and vote_head_id = v_item.vote_head_id and fee_structure_id = p_fee_structure_id) then
        update public.finance_invoice_items set amount = v_item.amount, updated_at = now()
          where invoice_id = v_invoice_id and vote_head_id = v_item.vote_head_id and fee_structure_id = p_fee_structure_id;
      else
        insert into public.finance_invoice_items (invoice_id, vote_head_id, fee_structure_id, amount)
          values (v_invoice_id, v_item.vote_head_id, p_fee_structure_id, v_item.amount);
      end if;
    end loop;

    update public.finance_invoices set updated_at = now(), updated_by = auth.uid() where id = v_invoice_id;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('invoiced_count', v_count);
end;
$$;

create or replace function public.finance_issue_debit_note(
  p_student_id uuid, p_vote_head_id uuid, p_amount numeric, p_reason text, p_academic_year_id uuid, p_term_id uuid
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_school uuid := public.current_school_id();
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  insert into public.finance_debit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_student_id, p_academic_year_id, p_term_id, p_vote_head_id, p_amount, p_reason, auth.uid())
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.finance_issue_credit_note(
  p_student_id uuid, p_vote_head_id uuid, p_amount numeric, p_reason text, p_academic_year_id uuid, p_term_id uuid
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_school uuid := public.current_school_id();
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  insert into public.finance_credit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_student_id, p_academic_year_id, p_term_id, p_vote_head_id, p_amount, p_reason, auth.uid())
    returning id into v_id;
  return v_id;
end;
$$;

-- Next Sprint 2 §12: reverse a wrongly-entered debit or credit note. Inserts
-- the opposite-type note (same student/vote head/year/term) and flags the
-- ORIGINAL as reversed — never deletes or edits the original in place. See
-- the header comment above finance_debit_notes/finance_credit_notes'
-- reversal columns for the full rationale.
create or replace function public.finance_reverse_debit_note(p_note_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_note public.finance_debit_notes%rowtype;
  v_credit_id uuid;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_note from public.finance_debit_notes where id = p_note_id and school_id = v_school;
  if not found then raise exception 'Debit note not found'; end if;
  if v_note.reversed_at is not null then raise exception 'This note has already been reversed'; end if;

  insert into public.finance_credit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by, reverses_debit_note_id)
    values (v_school, v_note.student_id, v_note.academic_year_id, v_note.term_id, v_note.vote_head_id, v_note.amount,
      trim('Reversal of debit note' || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid(), v_note.id)
    returning id into v_credit_id;

  update public.finance_debit_notes set reversed_at = now(), reversed_by = auth.uid() where id = p_note_id;
  return v_credit_id;
end;
$$;

create or replace function public.finance_reverse_credit_note(p_note_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_note public.finance_credit_notes%rowtype;
  v_debit_id uuid;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_note from public.finance_credit_notes where id = p_note_id and school_id = v_school;
  if not found then raise exception 'Credit note not found'; end if;
  if v_note.reversed_at is not null then raise exception 'This note has already been reversed'; end if;

  insert into public.finance_debit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by, reverses_credit_note_id)
    values (v_school, v_note.student_id, v_note.academic_year_id, v_note.term_id, v_note.vote_head_id, v_note.amount,
      trim('Reversal of credit note' || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid(), v_note.id)
    returning id into v_debit_id;

  update public.finance_credit_notes set reversed_at = now(), reversed_by = auth.uid() where id = p_note_id;
  return v_debit_id;
end;
$$;

-- Shared allocation walk used by both finance_record_collection (a brand
-- new payment) and finance_transfer_collection (re-allocating a moved
-- payment against its NEW student's own balances) — one implementation, so
-- the two can never compute a payment split differently. Walks every active
-- vote head in priority order, clearing each one's outstanding balance
-- (expected - credit notes - already paid) until the amount runs out;
-- whatever's left becomes an unallocated credit (brief's overpayment rule).
create or replace function public.finance_allocate_collection(p_collection_id uuid, p_student_id uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_remaining numeric := p_amount;
  v_vh record;
  v_alloc numeric;
  v_bf_id uuid;
begin
  select id into v_bf_id from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF';

  for v_vh in
    select vh.id as vote_head_id,
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = p_student_id and ii.vote_head_id = vh.id), 0)
        + coalesce((select sum(amount) from public.finance_debit_notes where student_id = p_student_id and vote_head_id = vh.id), 0)
        + case when vh.id = v_bf_id then coalesce((select sum(amount) from public.finance_opening_balances where student_id = p_student_id), 0) else 0 end
        - coalesce((select sum(amount) from public.finance_credit_notes where student_id = p_student_id and vote_head_id = vh.id), 0)
        - coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
            where c.student_id = p_student_id and c.status = 'active' and a.vote_head_id = vh.id), 0) as outstanding
    from public.finance_vote_heads vh
    where vh.school_id = v_school and vh.active = true
    order by vh.priority asc, vh.name asc
  loop
    exit when v_remaining <= 0;
    if v_vh.outstanding > 0 then
      v_alloc := least(v_remaining, v_vh.outstanding);
      insert into public.finance_collection_allocations (collection_id, vote_head_id, amount) values (p_collection_id, v_vh.vote_head_id, v_alloc);
      v_remaining := v_remaining - v_alloc;
    end if;
  end loop;

  if v_remaining > 0 then
    insert into public.finance_collection_allocations (collection_id, vote_head_id, amount) values (p_collection_id, null, v_remaining);
  end if;
end;
$$;

create or replace function public.finance_record_collection(
  p_student_id uuid, p_amount numeric, p_mode text, p_reference text, p_notes text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_year_id uuid; v_term_id uuid;
  v_collection_id uuid;
  v_receipt_no text;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized to record collections' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_mode not in ('cash', 'paybill', 'bank', 'other') then raise exception 'Invalid payment mode'; end if;
  if not exists (select 1 from public.students where id = p_student_id and school_id = v_school) then raise exception 'Student not found'; end if;

  select id into v_year_id from public.academic_years where school_id = v_school and status = 'active' limit 1;
  select id into v_term_id from public.terms where school_id = v_school and status = 'active' limit 1;
  if v_year_id is null or v_term_id is null then raise exception 'No active academic year/term configured — set one in Settings first.'; end if;

  v_receipt_no := 'RCT-' || lpad(public.finance_next_no('receipt')::text, 6, '0');

  insert into public.finance_collections (school_id, student_id, academic_year_id, term_id, amount, mode, reference, receipt_no, notes, created_by, updated_by)
    values (v_school, p_student_id, v_year_id, v_term_id, p_amount, p_mode, nullif(p_reference, ''), v_receipt_no, nullif(p_notes, ''), auth.uid(), auth.uid())
    returning id into v_collection_id;

  perform public.finance_allocate_collection(v_collection_id, p_student_id, p_amount);

  return jsonb_build_object('collection_id', v_collection_id, 'receipt_no', v_receipt_no);
end;
$$;

create or replace function public.finance_reverse_collection(p_collection_id uuid, p_reason text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id(); v_status text;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select status into v_status from public.finance_collections where id = p_collection_id and school_id = v_school;
  if v_status is null then raise exception 'Collection not found'; end if;
  if v_status <> 'active' then raise exception 'Only an active collection can be reversed'; end if;
  update public.finance_collections set status = 'reversed', reversed_reason = p_reason, reversed_at = now(), reversed_by = auth.uid(), updated_by = auth.uid(), updated_at = now()
    where id = p_collection_id;
  return true;
end;
$$;

create or replace function public.finance_transfer_collection(p_collection_id uuid, p_to_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_orig public.finance_collections%rowtype;
  v_new_id uuid;
  v_receipt_no text;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_orig from public.finance_collections where id = p_collection_id and school_id = v_school;
  if not found then raise exception 'Collection not found'; end if;
  if v_orig.status <> 'active' then raise exception 'Only an active collection can be transferred'; end if;
  if not exists (select 1 from public.students where id = p_to_student_id and school_id = v_school) then raise exception 'Destination student not found'; end if;
  if p_to_student_id = v_orig.student_id then raise exception 'Already recorded against this student'; end if;

  v_receipt_no := 'RCT-' || lpad(public.finance_next_no('receipt')::text, 6, '0');

  insert into public.finance_collections
    (school_id, student_id, academic_year_id, term_id, amount, mode, reference, receipt_no, notes, transferred_from_collection_id, created_by, updated_by)
    values (v_school, p_to_student_id, v_orig.academic_year_id, v_orig.term_id, v_orig.amount, v_orig.mode, v_orig.reference, v_receipt_no,
      trim(coalesce(v_orig.notes, '') || ' (transferred from receipt ' || v_orig.receipt_no || ')'), p_collection_id, auth.uid(), auth.uid())
    returning id into v_new_id;

  update public.finance_collections set status = 'transferred', transferred_to_collection_id = v_new_id, updated_at = now(), updated_by = auth.uid()
    where id = p_collection_id;

  perform public.finance_allocate_collection(v_new_id, p_to_student_id, v_orig.amount);

  return jsonb_build_object('new_collection_id', v_new_id, 'receipt_no', v_receipt_no);
end;
$$;

-- One student's full balance: per-vote-head breakdown (expected/paid/
-- credit_note/balance) plus totals — feeds the Student Profile, Statement,
-- and the pre-collection "what do they owe" check (brief scenario #1).
create or replace function public.finance_student_balance(p_student_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_bf_id uuid;
  v_result jsonb;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.students where id = p_student_id and school_id = v_school) then raise exception 'Student not found'; end if;
  select id into v_bf_id from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF';

  with expected_by_vh as (
    select vh.id as vote_head_id, vh.name, vh.priority,
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = p_student_id and ii.vote_head_id = vh.id), 0)
        + coalesce((select sum(amount) from public.finance_debit_notes where student_id = p_student_id and vote_head_id = vh.id), 0)
        + case when vh.id = v_bf_id then coalesce((select sum(amount) from public.finance_opening_balances where student_id = p_student_id), 0) else 0 end
        as expected,
      coalesce((select sum(amount) from public.finance_credit_notes where student_id = p_student_id and vote_head_id = vh.id), 0) as credit_note
    from public.finance_vote_heads vh
    where vh.school_id = v_school
  ),
  paid_by_vh as (
    select e.vote_head_id,
      coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
        where c.student_id = p_student_id and c.status = 'active' and a.vote_head_id = e.vote_head_id), 0) as paid
    from expected_by_vh e
  ),
  unallocated as (
    select coalesce(sum(a.amount), 0) as amount
    from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
    where c.student_id = p_student_id and c.status = 'active' and a.vote_head_id is null
  ),
  rows as (
    select e.vote_head_id, e.name, e.priority, e.expected, e.credit_note, p.paid, (e.expected - e.credit_note - p.paid) as balance
    from expected_by_vh e join paid_by_vh p on p.vote_head_id = e.vote_head_id
    where e.expected <> 0 or e.credit_note <> 0 or p.paid <> 0
  )
  select jsonb_build_object(
    'vote_heads', coalesce((select jsonb_agg(jsonb_build_object(
        'vote_head_id', vote_head_id, 'name', name, 'expected', expected, 'paid', paid, 'credit_note', credit_note, 'balance', balance
      ) order by priority asc, name asc) from rows), '[]'::jsonb),
    'expected', coalesce((select sum(expected) from rows), 0),
    'paid', coalesce((select sum(paid) from rows), 0) + (select amount from unallocated),
    'credit_note', coalesce((select sum(credit_note) from rows), 0),
    'credit_balance', (select amount from unallocated),
    'balance', coalesce((select sum(balance) from rows), 0) - (select amount from unallocated)
  ) into v_result;

  return v_result;
end;
$$;

-- ============================================================================
-- Next Sprint 2 §13 (0034_staff_self_service_profile.sql) — fee transfer
-- between students, restricted to an existing overpayment on the source
-- student. Distinct from finance_transfer_collection() (moves one whole
-- payment to a different student, no overpayment check) — this moves a
-- chosen AMOUNT of a student's CURRENT credit/overpayment to another
-- student, and refuses if the source student doesn't actually have that
-- much overpayment. Implemented as a debit note on the source (consumes the
-- credit) plus a credit note on the destination (reduces what they owe),
-- both against the school's 'Balance B/F' vote head (finance_bootstrap()
-- always seeds one) — the same vote head opening-balance carry-forward
-- already uses for this kind of cross-cutting adjustment. The balance is
-- re-derived from finance_student_balance() SERVER-SIDE rather than trusting
-- whatever the client last saw, since it can be stale by submit time.
-- ============================================================================
create or replace function public.finance_transfer_overpayment(
  p_from_student_id uuid, p_to_student_id uuid, p_amount numeric,
  p_academic_year_id uuid, p_term_id uuid, p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_bf_id uuid;
  v_balance numeric;
  v_debit_id uuid;
  v_credit_id uuid;
  v_from_name text;
  v_to_name text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_from_student_id = p_to_student_id then raise exception 'Choose two different students'; end if;

  select full_name into v_from_name from public.students where id = p_from_student_id and school_id = v_school;
  if v_from_name is null then raise exception 'Source student not found'; end if;
  select full_name into v_to_name from public.students where id = p_to_student_id and school_id = v_school;
  if v_to_name is null then raise exception 'Destination student not found'; end if;

  select (public.finance_student_balance(p_from_student_id) ->> 'balance')::numeric into v_balance;
  if v_balance >= 0 then
    raise exception '% has no overpayment to transfer (current balance: KES %).', v_from_name, v_balance;
  end if;
  if p_amount > (-1 * v_balance) then
    raise exception '% only has an overpayment of KES % — cannot transfer KES %.', v_from_name, (-1 * v_balance), p_amount;
  end if;

  select id into v_bf_id from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF';
  if v_bf_id is null then raise exception 'Balance B/F vote head not found — open Finance once to run initial setup, then try again.'; end if;

  insert into public.finance_debit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_from_student_id, p_academic_year_id, p_term_id, v_bf_id, p_amount,
      trim('Fee transfer to ' || v_to_name || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid())
    returning id into v_debit_id;

  insert into public.finance_credit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_to_student_id, p_academic_year_id, p_term_id, v_bf_id, p_amount,
      trim('Fee transfer from ' || v_from_name || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid())
    returning id into v_credit_id;

  return jsonb_build_object('debit_note_id', v_debit_id, 'credit_note_id', v_credit_id);
end;
$$;

-- Balances report (brief §Reports): a flat per-student list, optionally
-- scoped to one class and/or filtered to a minimum balance — brief scenario
-- #2 ("every student above a KES 400 balance ... across every class and
-- stream") is p_class_id null, p_min_balance 400.
create or replace function public.finance_class_balances(p_class_id uuid default null, p_min_balance numeric default null)
returns table (
  student_id uuid, admission_no text, full_name text, class_name text, stream_name text,
  expected numeric, paid numeric, credit_note numeric, balance numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  -- Note: every subquery below qualifies its student_id/amount columns with
  -- a table alias (dn.student_id, not bare student_id) — this function's
  -- own OUT parameters are named student_id/expected/paid/credit_note/
  -- balance (so the JS API layer gets natural column names back), and an
  -- unqualified reference inside plpgsql resolves to the OUT parameter
  -- first, silently matching every row instead of correlating to `s.id`.
  return query
  with per_student as (
    select
      s.id as sid,
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = s.id), 0)
        + coalesce((select sum(dn.amount) from public.finance_debit_notes dn where dn.student_id = s.id), 0)
        + coalesce((select sum(ob.amount) from public.finance_opening_balances ob where ob.student_id = s.id), 0) as expected,
      coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id where c.student_id = s.id and c.status = 'active'), 0) as paid,
      coalesce((select sum(cn.amount) from public.finance_credit_notes cn where cn.student_id = s.id), 0) as credit_note
    from public.students s
    where s.school_id = v_school and s.status = 'active'
      and (p_class_id is null or s.class_id = p_class_id)
  )
  select ps.sid, s.admission_no, s.full_name, c.name, st.name,
    ps.expected, ps.paid, ps.credit_note, (ps.expected - ps.paid - ps.credit_note) as balance
  from per_student ps
  join public.students s on s.id = ps.sid
  left join public.classes c on c.id = s.class_id
  left join public.streams st on st.id = s.stream_id
  where (p_min_balance is null or (ps.expected - ps.paid - ps.credit_note) > p_min_balance)
  order by c.level_order asc nulls last, c.name asc, st.name asc, s.full_name asc;
end;
$$;

-- Brief scenario #3: how much has been collected per vote head so far
-- (optionally scoped to a term/year) — includes an "Unallocated" row for
-- any overpayment credit not yet tied to a specific vote head.
create or replace function public.finance_vote_head_collections(p_academic_year_id uuid default null, p_term_id uuid default null)
returns table (vote_head_id uuid, vote_head_name text, collected numeric)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select vh.id, vh.name,
    coalesce(sum(a.amount) filter (where c.status = 'active'
      and (p_academic_year_id is null or c.academic_year_id = p_academic_year_id)
      and (p_term_id is null or c.term_id = p_term_id)), 0) as collected
  from public.finance_vote_heads vh
  left join public.finance_collection_allocations a on a.vote_head_id = vh.id
  left join public.finance_collections c on c.id = a.collection_id
  where vh.school_id = v_school
  group by vh.id, vh.name, vh.priority
  order by vh.priority asc, vh.name asc;

  return query
  select null::uuid, 'Unallocated (Overpayment Credit)',
    coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
      where a.vote_head_id is null and c.status = 'active' and c.school_id = v_school
      and (p_academic_year_id is null or c.academic_year_id = p_academic_year_id)
      and (p_term_id is null or c.term_id = p_term_id)), 0);
end;
$$;

-- Dashboard tiles (brief §Dashboard): headline totals plus a per-class %
-- collected breakdown, both filterable by term/year (null = all time).
create or replace function public.finance_dashboard(p_academic_year_id uuid default null, p_term_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_total_students int;
  v_total_collected numeric;
  v_total_payments int;
  v_total_expected numeric;
  v_per_class jsonb;
  v_result jsonb;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;

  select count(*) into v_total_students from public.students where school_id = v_school and status = 'active';

  select coalesce(sum(amount), 0), count(*) into v_total_collected, v_total_payments
  from public.finance_collections
  where school_id = v_school and status = 'active'
    and (p_academic_year_id is null or academic_year_id = p_academic_year_id)
    and (p_term_id is null or term_id = p_term_id);

  select coalesce(sum(ii.amount), 0) into v_total_expected
  from public.finance_invoice_items ii
  join public.finance_invoices inv on inv.id = ii.invoice_id
  where inv.school_id = v_school
    and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id)
    and (p_term_id is null or inv.term_id = p_term_id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'class_id', c.id, 'class_name', c.name, 'expected', pc.expected, 'collected', pc.collected,
      'pct', case when pc.expected > 0 then round((pc.collected / pc.expected) * 100) else 0 end
    ) order by c.level_order, c.name), '[]'::jsonb)
  into v_per_class
  from public.classes c
  join lateral (
    select
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
        join public.students s on s.id = inv.student_id
        where s.class_id = c.id and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id) and (p_term_id is null or inv.term_id = p_term_id)), 0) as expected,
      coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections col on col.id = a.collection_id
        join public.students s2 on s2.id = col.student_id
        where s2.class_id = c.id and col.status = 'active' and (p_academic_year_id is null or col.academic_year_id = p_academic_year_id) and (p_term_id is null or col.term_id = p_term_id)), 0) as collected
  ) pc on true
  where c.school_id = v_school;

  v_result := jsonb_build_object(
    'total_students', v_total_students, 'total_collected', v_total_collected, 'total_payments', v_total_payments,
    'total_expected', v_total_expected,
    'pct_collected', case when v_total_expected > 0 then round((v_total_collected / v_total_expected) * 100) else 0 end,
    'per_class', v_per_class
  );
  return v_result;
end;
$$;

-- Cashbook (brief §Reports, scenario #7): every active collection in a date
-- range, in date order — the print/export layer totals it by mode.
create or replace function public.finance_cashbook(p_from date, p_to date)
returns table (collection_date date, receipt_no text, student_name text, admission_no text, mode text, amount numeric)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select c.created_at::date, c.receipt_no, s.full_name, s.admission_no, c.mode, c.amount
  from public.finance_collections c
  join public.students s on s.id = c.student_id
  where c.school_id = v_school and c.status = 'active' and c.created_at::date >= p_from and c.created_at::date <= p_to
  order by c.created_at asc;
end;
$$;

-- Trial balance (brief §Reports, scenario #18) — deliberately simple (per
-- the brief: "the core reports a school actually needs for bookkeeping, not
-- a full accounting suite"), NOT a GAAP double-entry ledger: one row per
-- vote head with what was invoiced (Dr) vs. collected (Cr), for handing
-- straight to the school's accountant.
create or replace function public.finance_trial_balance(p_academic_year_id uuid default null, p_term_id uuid default null)
returns table (vote_head_name text, invoiced numeric, collected numeric)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select vh.name,
    coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
      where ii.vote_head_id = vh.id and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id) and (p_term_id is null or inv.term_id = p_term_id)), 0)
      + coalesce((select sum(dn.amount) from public.finance_debit_notes dn where dn.vote_head_id = vh.id
          and (p_academic_year_id is null or dn.academic_year_id = p_academic_year_id) and (p_term_id is null or dn.term_id = p_term_id)), 0) as invoiced,
    coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
      where a.vote_head_id = vh.id and c.status = 'active'
      and (p_academic_year_id is null or c.academic_year_id = p_academic_year_id) and (p_term_id is null or c.term_id = p_term_id)), 0) as collected
  from public.finance_vote_heads vh
  where vh.school_id = v_school
  order by vh.priority asc, vh.name asc;
end;
$$;

-- Brief scenario #12: at the start of a new academic year, every student's
-- CLOSING balance from the source year becomes their opening balance
-- (finance_opening_balances) for the destination year — admin-initiated
-- (not an automatic trigger on year creation, so it's a deliberate,
-- reviewable action, not a surprise silent recalculation).
create or replace function public.finance_carry_forward_balances(p_from_year_id uuid, p_to_year_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_count int := 0;
  v_student record;
  v_closing numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.academic_years where id = p_from_year_id and school_id = v_school) then raise exception 'Source year not found'; end if;
  if not exists (select 1 from public.academic_years where id = p_to_year_id and school_id = v_school) then raise exception 'Destination year not found'; end if;

  for v_student in select id from public.students where school_id = v_school and status = 'active'
  loop
    select
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = v_student.id and inv.academic_year_id = p_from_year_id), 0)
        + coalesce((select sum(amount) from public.finance_debit_notes where student_id = v_student.id and academic_year_id = p_from_year_id), 0)
        + coalesce((select amount from public.finance_opening_balances where student_id = v_student.id and academic_year_id = p_from_year_id), 0)
        - coalesce((select sum(amount) from public.finance_credit_notes where student_id = v_student.id and academic_year_id = p_from_year_id), 0)
        - coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id where c.student_id = v_student.id and c.status = 'active' and c.academic_year_id = p_from_year_id), 0)
      into v_closing;

    if v_closing is distinct from 0 then
      insert into public.finance_opening_balances (school_id, student_id, academic_year_id, amount, notes, created_by)
        values (v_school, v_student.id, p_to_year_id, v_closing, 'Carried forward automatically', auth.uid())
      on conflict (student_id, academic_year_id) do update set amount = excluded.amount, notes = excluded.notes, updated_at = now();
      v_count := v_count + 1;
    end if;
  end loop;

  return jsonb_build_object('carried_count', v_count);
end;
$$;

grant execute on function public.finance_bootstrap() to authenticated;
grant execute on function public.finance_next_no(text) to authenticated;
grant execute on function public.finance_assign_route(uuid, uuid, text, uuid, uuid) to authenticated;
grant execute on function public.finance_generate_invoices(uuid, uuid[]) to authenticated;
grant execute on function public.finance_issue_debit_note(uuid, uuid, numeric, text, uuid, uuid) to authenticated;
grant execute on function public.finance_issue_credit_note(uuid, uuid, numeric, text, uuid, uuid) to authenticated;
grant execute on function public.finance_reverse_debit_note(uuid, text) to authenticated;
grant execute on function public.finance_reverse_credit_note(uuid, text) to authenticated;
grant execute on function public.finance_allocate_collection(uuid, uuid, numeric) to authenticated;
grant execute on function public.finance_record_collection(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.finance_reverse_collection(uuid, text) to authenticated;
grant execute on function public.finance_transfer_collection(uuid, uuid) to authenticated;
grant execute on function public.finance_student_balance(uuid) to authenticated;
grant execute on function public.finance_class_balances(uuid, numeric) to authenticated;
grant execute on function public.finance_vote_head_collections(uuid, uuid) to authenticated;
grant execute on function public.finance_dashboard(uuid, uuid) to authenticated;
grant execute on function public.finance_cashbook(date, date) to authenticated;
grant execute on function public.finance_trial_balance(uuid, uuid) to authenticated;
grant execute on function public.finance_carry_forward_balances(uuid, uuid) to authenticated;
grant execute on function public.finance_transfer_overpayment(uuid, uuid, numeric, uuid, uuid, text) to authenticated;

-- ============================== 0032_finance_round2.sql ==============================
-- ============================================================================
-- 0032_finance_round2.sql — Finance_Module_Round2.docx backend changes.
--
-- Covers:
--   §2  Dashboard: finance_dashboard() gains `total_balance` (what's still
--       owed overall — expected + debit notes - credit notes - collected)
--       so the UI can swap the "Total Payments" tile for "Total Balances".
--   §2  Automatic carry-forward: previously an admin had to remember to
--       call finance_carry_forward_balances() by hand. Now a trigger on
--       academic_years fires it automatically the moment a new year is
--       activated — see finance_auto_carry_forward_trigger() below for why
--       a DB trigger (not a UI hook) is the right place for a "shouldn't be
--       a manual step someone has to remember" requirement: it fires no
--       matter which screen flips a year to active, today or in five years.
--       (Terms don't need an equivalent — balances already run continuously
--       across a year's terms via one opening_balances row per (student,
--       year), not one per term, so there's no term-boundary reset to
--       automate in the first place.)
--   §8  Transport: finance_invoice_route() — bulk-invoices every student
--       assigned to a route for a given term, skipping anyone who already
--       has a transport line item on that route (no double-invoicing, per
--       the brief's explicit bug callout).
--   §9  Invoicing sub-reports: finance_vote_head_student_balances() — the
--       same "who hasn't cleared X" shape as finance_class_balances but
--       scoped to one vote head (used for "who hasn't cleared Transport").
--   §10 finance_uninvoice_structure() — removes a fee structure's line
--       items from every invoice they're on. Safe to run even after
--       payments were recorded against that vote head: collections/
--       allocations are a separate ledger untouched by this (see the
--       function's own comment for why that's fine, not a bug).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §2 — finance_dashboard(): add total_balance (and the debit/credit note
-- totals it's built from) alongside the existing fields. Nothing existing
-- is removed, so nothing already relying on this RPC's other fields breaks.
-- ----------------------------------------------------------------------------
create or replace function public.finance_dashboard(p_academic_year_id uuid default null, p_term_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_total_students int;
  v_total_collected numeric;
  v_total_payments int;
  v_total_expected numeric;
  v_total_debit numeric;
  v_total_credit numeric;
  v_total_balance numeric;
  v_per_class jsonb;
  v_result jsonb;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;

  select count(*) into v_total_students from public.students where school_id = v_school and status = 'active';

  select coalesce(sum(amount), 0), count(*) into v_total_collected, v_total_payments
  from public.finance_collections
  where school_id = v_school and status = 'active'
    and (p_academic_year_id is null or academic_year_id = p_academic_year_id)
    and (p_term_id is null or term_id = p_term_id);

  select coalesce(sum(ii.amount), 0) into v_total_expected
  from public.finance_invoice_items ii
  join public.finance_invoices inv on inv.id = ii.invoice_id
  where inv.school_id = v_school
    and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id)
    and (p_term_id is null or inv.term_id = p_term_id);

  select coalesce(sum(amount), 0) into v_total_debit
  from public.finance_debit_notes
  where school_id = v_school
    and (p_academic_year_id is null or academic_year_id = p_academic_year_id)
    and (p_term_id is null or term_id = p_term_id);

  select coalesce(sum(amount), 0) into v_total_credit
  from public.finance_credit_notes
  where school_id = v_school
    and (p_academic_year_id is null or academic_year_id = p_academic_year_id)
    and (p_term_id is null or term_id = p_term_id);

  v_total_balance := v_total_expected + v_total_debit - v_total_credit - v_total_collected;

  select coalesce(jsonb_agg(jsonb_build_object(
      'class_id', c.id, 'class_name', c.name, 'expected', pc.expected, 'collected', pc.collected,
      'pct', case when pc.expected > 0 then round((pc.collected / pc.expected) * 100) else 0 end
    ) order by c.level_order, c.name), '[]'::jsonb)
  into v_per_class
  from public.classes c
  join lateral (
    select
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
        join public.students s on s.id = inv.student_id
        where s.class_id = c.id and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id) and (p_term_id is null or inv.term_id = p_term_id)), 0) as expected,
      coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections col on col.id = a.collection_id
        join public.students s2 on s2.id = col.student_id
        where s2.class_id = c.id and col.status = 'active' and (p_academic_year_id is null or col.academic_year_id = p_academic_year_id) and (p_term_id is null or col.term_id = p_term_id)), 0) as collected
  ) pc on true
  where c.school_id = v_school;

  v_result := jsonb_build_object(
    'total_students', v_total_students, 'total_collected', v_total_collected, 'total_payments', v_total_payments,
    'total_expected', v_total_expected, 'total_debit_notes', v_total_debit, 'total_credit_notes', v_total_credit,
    'total_balance', v_total_balance,
    'pct_collected', case when v_total_expected > 0 then round((v_total_collected / v_total_expected) * 100) else 0 end,
    'per_class', v_per_class
  );
  return v_result;
end;
$$;

-- ----------------------------------------------------------------------------
-- §2 — automatic carry-forward. Fires right after an academic_years row
-- flips to 'active'. academic_years.save() (src/lib/api/academics.mjs)
-- updates the newly-active row FIRST, then archives every other active row
-- in a second statement — so at the moment this trigger runs, the
-- previously-active year is still status='active' in the table, which is
-- exactly what the lookup below depends on. Re-activating a year twice is
-- harmless: finance_carry_forward_balances() itself upserts on
-- (student_id, academic_year_id), so re-running it just resyncs figures
-- rather than duplicating anything.
-- ----------------------------------------------------------------------------
create or replace function public.finance_auto_carry_forward_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_prev_year_id uuid;
begin
  if new.status = 'active' and (old.status is distinct from 'active') then
    select id into v_prev_year_id from public.academic_years
      where school_id = new.school_id and status = 'active' and id <> new.id
      order by coalesce(start_date, '1900-01-01'::date) desc limit 1;
    if v_prev_year_id is not null then
      perform public.finance_carry_forward_balances(v_prev_year_id, new.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_finance_auto_carry_forward on public.academic_years;
create trigger trg_finance_auto_carry_forward
  after update on public.academic_years
  for each row execute function public.finance_auto_carry_forward_trigger();

-- ----------------------------------------------------------------------------
-- §8 — bulk-invoice every student assigned to one route, for one term,
-- skipping anyone who already has a transport line item for that route (the
-- brief's explicit "must reject double-invoicing" bug callout). Mirrors
-- finance_assign_route()'s own invoice-line logic exactly, just walked over
-- every student on the route instead of one at a time.
-- ----------------------------------------------------------------------------
create or replace function public.finance_invoice_route(p_route_id uuid, p_academic_year_id uuid, p_term_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_route public.finance_routes%rowtype;
  v_vote_head_id uuid;
  v_student record;
  v_invoiced int := 0;
  v_skipped int := 0;
  v_amount numeric;
  v_desc text;
  v_invoice_id uuid;
  v_invoice_no text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_route from public.finance_routes where id = p_route_id and school_id = v_school;
  if not found then raise exception 'Route not found'; end if;

  select id into v_vote_head_id from public.finance_vote_heads where school_id = v_school and is_transport = true limit 1;
  if v_vote_head_id is null then
    insert into public.finance_vote_heads (school_id, name, code, is_transport, priority)
      values (v_school, 'Transport', 'TRANSPORT', true, 200) returning id into v_vote_head_id;
  end if;

  for v_student in
    select sr.student_id, sr.direction
    from public.finance_student_routes sr
    where sr.route_id = p_route_id and sr.academic_year_id = p_academic_year_id and sr.term_id = p_term_id
  loop
    select id into v_invoice_id from public.finance_invoices
      where student_id = v_student.student_id and academic_year_id = p_academic_year_id and term_id = p_term_id;

    if v_invoice_id is not null and exists (
      select 1 from public.finance_invoice_items
      where invoice_id = v_invoice_id and vote_head_id = v_vote_head_id and route_id = p_route_id
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_amount := case when v_student.direction = 'two_way' then v_route.two_way_amount else v_route.one_way_amount end;
    v_desc := v_route.name || ' — ' || initcap(replace(v_student.direction, '_', ' '));

    if v_invoice_id is null then
      v_invoice_no := 'INV-' || lpad(public.finance_next_no('invoice')::text, 6, '0');
      insert into public.finance_invoices (school_id, student_id, academic_year_id, term_id, invoice_no, created_by)
        values (v_school, v_student.student_id, p_academic_year_id, p_term_id, v_invoice_no, auth.uid())
        returning id into v_invoice_id;
    end if;

    insert into public.finance_invoice_items (invoice_id, vote_head_id, amount, description, route_id, direction)
      values (v_invoice_id, v_vote_head_id, v_amount, v_desc, p_route_id, v_student.direction);

    update public.finance_invoices set updated_at = now(), updated_by = auth.uid() where id = v_invoice_id;
    v_invoiced := v_invoiced + 1;
  end loop;

  return jsonb_build_object('invoiced_count', v_invoiced, 'skipped_count', v_skipped);
end;
$$;

-- ----------------------------------------------------------------------------
-- §9 — one vote head's balance per student (used for "students who haven't
-- cleared Transport specifically", but generic — works for any vote head).
-- Every subquery column is alias-qualified throughout (see finance_
-- class_balances' own comment in 0031 for why: this function's OUT
-- parameters share names with real columns, and an unqualified reference
-- resolves to the OUT parameter first, silently matching every row).
-- ----------------------------------------------------------------------------
create or replace function public.finance_vote_head_student_balances(
  p_vote_head_id uuid, p_academic_year_id uuid default null, p_term_id uuid default null
)
returns table (
  student_id uuid, admission_no text, full_name text, class_name text, stream_name text,
  expected numeric, paid numeric, balance numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select s.id, s.admission_no, s.full_name, c.name, st.name,
    coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
      where inv.student_id = s.id and ii.vote_head_id = p_vote_head_id
        and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id)
        and (p_term_id is null or inv.term_id = p_term_id)), 0) as expected,
    coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections col on col.id = a.collection_id
      where col.student_id = s.id and a.vote_head_id = p_vote_head_id and col.status = 'active'
        and (p_academic_year_id is null or col.academic_year_id = p_academic_year_id)
        and (p_term_id is null or col.term_id = p_term_id)), 0) as paid,
    (coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
      where inv.student_id = s.id and ii.vote_head_id = p_vote_head_id
        and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id)
        and (p_term_id is null or inv.term_id = p_term_id)), 0)
     - coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections col on col.id = a.collection_id
      where col.student_id = s.id and a.vote_head_id = p_vote_head_id and col.status = 'active'
        and (p_academic_year_id is null or col.academic_year_id = p_academic_year_id)
        and (p_term_id is null or col.term_id = p_term_id)), 0)) as balance
  from public.students s
  join public.classes c on c.id = s.class_id
  left join public.streams st on st.id = s.stream_id
  where s.school_id = v_school and s.status = 'active'
  order by c.level_order, c.name, s.full_name;
end;
$$;

-- ----------------------------------------------------------------------------
-- §10 — un-invoice: removes a fee structure's own line items from whatever
-- invoices they're on. This is safe even if a parent already paid toward
-- that vote head: finance_collections/finance_collection_allocations are a
-- completely separate ledger (a receipt already issued), so removing the
-- charge doesn't touch or reverse any payment — it just means that vote
-- head's "expected" drops, and the balance query naturally reflects the
-- student now being paid-ahead/credited on it, exactly like any other
-- overpayment. Nothing needs to "undo" a receipt for this to be safe.
-- ----------------------------------------------------------------------------
create or replace function public.finance_uninvoice_structure(p_fee_structure_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_removed int := 0;
  v_students int := 0;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.finance_fee_structures where id = p_fee_structure_id and school_id = v_school) then
    raise exception 'Fee structure not found';
  end if;

  select count(distinct inv.student_id) into v_students
  from public.finance_invoice_items ii
  join public.finance_invoices inv on inv.id = ii.invoice_id
  where ii.fee_structure_id = p_fee_structure_id and inv.school_id = v_school;

  with deleted as (
    delete from public.finance_invoice_items ii
    using public.finance_invoices inv
    where ii.invoice_id = inv.id and ii.fee_structure_id = p_fee_structure_id and inv.school_id = v_school
    returning ii.id
  )
  select count(*) into v_removed from deleted;

  return jsonb_build_object('removed_items', v_removed, 'affected_students', v_students);
end;
$$;

grant execute on function public.finance_invoice_route(uuid, uuid, uuid) to authenticated;
grant execute on function public.finance_vote_head_student_balances(uuid, uuid, uuid) to authenticated;
grant execute on function public.finance_uninvoice_structure(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Next Sprint 3 (0035_admin_dashboard.sql) — Super Admin dashboard. Folded in
-- here so a brand-new install gets it too; see the migration file itself for
-- the full section-by-section reasoning.
-- ----------------------------------------------------------------------------
-- 0035_admin_dashboard.sql
-- ----------------------------------------------------------------------------
-- Super Admin / platform-management dashboard (Admin_Dashboard_Architecture3
-- .docx). This is a second, small mini-app living alongside the main school
-- system, at its own /admin route, using the SAME Supabase project/session —
-- there is no separate login system.
--
-- "Super Admin" is a regular profile with is_super_admin = true, NOT a
-- hardcoded email check. Only one account will ever carry that flag in
-- practice, which satisfies "only one designated account" while keeping the
-- check a real, revocable, auditable database flag rather than a string
-- comparison baked into application code.
--
-- Every other table in this schema is RLS-locked to exactly one school
-- (current_school_id()). Cross-school reads/writes needed by the Super
-- Admin dashboard are the one deliberate, narrow exception to that rule —
-- centralized in a handful of admin_* SECURITY DEFINER functions below,
-- each of which re-checks public.is_super_admin() itself, rather than
-- loosening row-level security broadly. The app must never query school
-- tables directly for cross-school numbers.
-- ----------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The Super Admin flag itself.
-- ---------------------------------------------------------------------------
alter table public.profiles add column is_super_admin boolean not null default false;

-- A Super Admin account is not really "of" any one school. school_id was
-- NOT NULL; relax that just for this one case (every ordinary profile still
-- requires a school_id — the check constraint below enforces that a NULL
-- school_id is only ever allowed together with is_super_admin = true).
alter table public.profiles alter column school_id drop not null;
alter table public.profiles add constraint chk_profiles_school_or_super_admin
  check (school_id is not null or is_super_admin = true);

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_super_admin from public.profiles where id = auth.uid()), false);
$$;

-- set_school_id() (defined earlier in schema.sql) auto-fills school_id on
-- every tenant-table insert from the caller's own profile, and raises if it
-- can't determine one — which a Super Admin profile insert legitimately
-- can't, since it has no school. Carve out that one exception.
create or replace function public.set_school_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.school_id is null then
    new.school_id := public.current_school_id();
  end if;
  if new.school_id is null then
    if TG_TABLE_NAME = 'profiles' and coalesce(new.is_super_admin, false) then
      return new;
    end if;
    raise exception 'Could not determine which school this record belongs to (no school_id on your profile).' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Trials, locking, and soft-delete on schools.
-- ---------------------------------------------------------------------------
alter table public.schools add column trial_ends_at timestamptz;
alter table public.schools add column locked_at timestamptz;
alter table public.schools add column locked_reason text;
alter table public.schools add column deleted_at timestamptz;
alter table public.schools add column deleted_by uuid references public.profiles(id) on delete set null;

-- Every new school gets a 3-month trial automatically, from whatever inserts
-- the row (currently netlify/functions/school-signup.js) — a DB default
-- keeps that true even if another code path ever creates a school row.
alter table public.schools alter column trial_ends_at set default (now() + interval '3 months');
update public.schools set trial_ends_at = created_at + interval '3 months' where trial_ends_at is null;

-- A locked or soft-deleted school blocks every one of its users immediately,
-- with a clear message (not a silent failure / generic error) — enforced
-- centrally here rather than in every RLS policy, since current_school_id()
-- is the one choke point every policy already runs through.
create or replace function public.current_school_id()
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school_id uuid;
  v_locked_at timestamptz;
  v_locked_reason text;
  v_deleted_at timestamptz;
  v_name text;
begin
  select school_id into v_school_id from public.profiles where id = auth.uid();
  if v_school_id is null then return null; end if;

  select locked_at, locked_reason, deleted_at, name
    into v_locked_at, v_locked_reason, v_deleted_at, v_name
    from public.schools where id = v_school_id;

  if v_deleted_at is not null then
    raise exception 'This school account is no longer active. Please contact support.' using errcode = '42501';
  end if;
  if v_locked_at is not null then
    raise exception '%', coalesce(nullif(v_locked_reason, ''), 'This school''s access has been locked by the platform administrator. Please contact support to resolve this.')
      using errcode = '42501';
  end if;

  return v_school_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. SMS wallet per school, purchase-request queue, and permanent ledger.
-- ---------------------------------------------------------------------------
create table public.sms_wallets (
  school_id uuid primary key references public.schools(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);
create trigger trg_sms_wallets_updated_at before update on public.sms_wallets
  for each row execute function public.set_updated_at();

create table public.sms_credit_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  requested_credits integer not null check (requested_credits > 0),
  amount_paid numeric(12,2),
  payment_message text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by uuid references public.profiles(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);
create index idx_sms_credit_requests_school on public.sms_credit_requests(school_id);
create index idx_sms_credit_requests_status on public.sms_credit_requests(status);
-- Every other multi-tenant table's insert() relies on this trigger to stamp
-- school_id from the caller's own profile (see public.set_school_id()) —
-- this table was originally missing it (migrations/0044), which silently
-- left school_id NULL and made every school-side insert fail RLS.
create trigger trg_sms_credit_requests_school_id before insert on public.sms_credit_requests
  for each row execute function public.set_school_id();

-- Permanent record of every approved credit — amount, school, date,
-- reference — kept even if the originating request row is ever removed, as
-- a dispute paper trail (docx: "Added, not originally requested, but still
-- applies").
create table public.sms_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  credits integer not null,
  amount_paid numeric(12,2),
  reference text,
  request_id uuid references public.sms_credit_requests(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_sms_credit_ledger_school on public.sms_credit_ledger(school_id);

-- Atomic wallet debit for an actual send (see
-- netlify/functions/_lib/smsProvider.js + migrations/0041_sms_wallet_debit_rpc.sql
-- for the full rationale) — a single conditional UPDATE so two simultaneous
-- sends for the same school can never both succeed off the same balance.
create or replace function public.debit_sms_wallet(p_school_id uuid, p_credits integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_school_id is null then
    raise exception 'Missing school.';
  end if;
  if p_credits is null or p_credits <= 0 then
    raise exception 'Invalid credit amount.';
  end if;

  update public.sms_wallets
    set balance = balance - p_credits, updated_at = now()
    where school_id = p_school_id and balance >= p_credits
    returning balance into v_balance;

  if v_balance is null then
    raise exception 'Not enough SMS credit — top up before sending.';
  end if;

  return v_balance;
end;
$$;
grant execute on function public.debit_sms_wallet(uuid, integer) to authenticated, service_role;

-- A school's own admin/teacher may submit a request and see their own
-- wallet/requests — ordinary RLS, scoped by current_school_id() same as
-- every other table. The Super Admin reaches ALL schools' rows only through
-- the admin_* functions below (security definer), never through these
-- policies directly.
alter table public.sms_wallets enable row level security;
alter table public.sms_credit_requests enable row level security;
alter table public.sms_credit_ledger enable row level security;

create policy sms_wallets_select on public.sms_wallets for select
  using (school_id = public.current_school_id());
create policy sms_credit_requests_select on public.sms_credit_requests for select
  using (school_id = public.current_school_id());
create policy sms_credit_requests_insert on public.sms_credit_requests for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy sms_credit_ledger_select on public.sms_credit_ledger for select
  using (school_id = public.current_school_id());

-- ---------------------------------------------------------------------------
-- 4. Impersonation sessions and the admin audit log.
-- ---------------------------------------------------------------------------
create table public.admin_impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete cascade,
  target_profile_id uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  target_school_id uuid references public.schools(id) on delete set null,
  details jsonb,
  created_at timestamptz not null default now()
);
create index idx_admin_audit_log_school on public.admin_audit_log(target_school_id);
create index idx_admin_audit_log_created on public.admin_audit_log(created_at desc);

alter table public.admin_impersonation_sessions enable row level security;
alter table public.admin_audit_log enable row level security;
-- No direct-select policies: both tables are only ever read/written through
-- the security-definer admin_* functions below (Super-Admin-only, checked
-- inside each function) or the impersonation Netlify functions using the
-- service_role key. Ordinary staff have no policy granting them access, so
-- RLS denies everything by default.

-- ---------------------------------------------------------------------------
-- 5. Admin-only SECURITY DEFINER RPCs. Every one starts by re-checking
--    is_super_admin() itself — never trust that only the /admin front-end
--    calls these.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_total_schools integer;
  v_total_students integer;
  v_total_teachers integer;
  v_pending_sms integer;
  v_total_sms_revenue numeric;
  v_new_this_week integer;
  v_new_this_month integer;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;

  select count(*) into v_total_schools from public.schools where deleted_at is null;
  select count(*) into v_total_students from public.students where status = 'active';
  select count(*) into v_total_teachers from public.staff where status = 'active' and lower(role) = 'teacher';
  select count(*) into v_pending_sms from public.sms_credit_requests where status = 'pending';
  select coalesce(sum(amount_paid), 0) into v_total_sms_revenue from public.sms_credit_ledger;
  select count(*) into v_new_this_week from public.schools where created_at >= now() - interval '7 days' and deleted_at is null;
  select count(*) into v_new_this_month from public.schools where created_at >= now() - interval '30 days' and deleted_at is null;

  return jsonb_build_object(
    'total_schools', v_total_schools,
    'total_students', v_total_students,
    'total_teachers', v_total_teachers,
    'pending_sms_confirmations', v_pending_sms,
    'total_sms_revenue', v_total_sms_revenue,
    'new_schools_this_week', v_new_this_week,
    'new_schools_this_month', v_new_this_month
  );
end;
$$;

create or replace function public.admin_list_expiring_trials(p_within_days integer default 14)
returns table (id uuid, name text, code text, trial_ends_at timestamptz, days_left integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select s.id, s.name, s.code, s.trial_ends_at,
      greatest(0, ceil(extract(epoch from (s.trial_ends_at - now())) / 86400))::integer as days_left
    from public.schools s
    where s.deleted_at is null and s.trial_ends_at is not null
      and s.trial_ends_at <= now() + (p_within_days || ' days')::interval
    order by s.trial_ends_at asc;
end;
$$;

create or replace function public.admin_list_recent_schools(p_limit integer default 10)
returns table (id uuid, name text, code text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select s.id, s.name, s.code, s.created_at
    from public.schools s
    where s.deleted_at is null
    order by s.created_at desc
    limit coalesce(p_limit, 10);
end;
$$;

create or replace function public.admin_registration_trend(p_weeks integer default 12)
returns table (week_start date, new_schools integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select date_trunc('week', s.created_at)::date as week_start, count(*)::integer as new_schools
    from public.schools s
    where s.created_at >= now() - (p_weeks || ' weeks')::interval
    group by 1 order by 1;
end;
$$;

create or replace function public.admin_list_schools(p_search text default null)
returns table (
  id uuid, name text, code text, status text, created_at timestamptz,
  trial_ends_at timestamptz, locked_at timestamptz, deleted_at timestamptz,
  student_count integer, teacher_count integer, sms_balance integer,
  last_activity timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select s.id, s.name, s.code, s.status, s.created_at, s.trial_ends_at, s.locked_at, s.deleted_at,
      (select count(*)::integer from public.students st where st.school_id = s.id and st.status = 'active'),
      (select count(*)::integer from public.staff sf where sf.school_id = s.id and sf.status = 'active' and lower(sf.role) = 'teacher'),
      coalesce((select w.balance from public.sms_wallets w where w.school_id = s.id), 0),
      (select max(p.updated_at) from public.profiles p where p.school_id = s.id)
    from public.schools s
    where (p_search is null or p_search = '' or s.name ilike '%' || p_search || '%' or s.code ilike '%' || p_search || '%')
    order by s.created_at desc;
end;
$$;

create or replace function public.admin_school_detail(p_school_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school public.schools%rowtype;
  v_result jsonb;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_school from public.schools where id = p_school_id;
  if not found then raise exception 'School not found'; end if;

  select jsonb_build_object(
    'id', v_school.id, 'name', v_school.name, 'code', v_school.code, 'status', v_school.status,
    'created_at', v_school.created_at, 'trial_ends_at', v_school.trial_ends_at,
    'locked_at', v_school.locked_at, 'locked_reason', v_school.locked_reason,
    'deleted_at', v_school.deleted_at,
    'student_count', (select count(*) from public.students where school_id = v_school.id and status = 'active'),
    'teacher_count', (select count(*) from public.staff where school_id = v_school.id and status = 'active' and lower(role) = 'teacher'),
    'sms_balance', coalesce((select balance from public.sms_wallets where school_id = v_school.id), 0),
    'last_activity', (select max(updated_at) from public.profiles where school_id = v_school.id),
    'admin_profile', (select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email)
      from public.profiles p where p.school_id = v_school.id and p.role = 'admin' order by p.created_at asc limit 1)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.admin_set_school_lock(p_school_id uuid, p_locked boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  update public.schools
    set locked_at = case when p_locked then now() else null end,
        locked_reason = case when p_locked then p_reason else null end
    where id = p_school_id;
  if not found then raise exception 'School not found'; end if;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), case when p_locked then 'lock_school' else 'unlock_school' end, p_school_id,
      jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.admin_extend_trial(p_school_id uuid, p_extra_days integer)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_new_date timestamptz;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_extra_days is null or p_extra_days <= 0 then raise exception 'Extra days must be a positive number'; end if;

  update public.schools
    set trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + (p_extra_days || ' days')::interval
    where id = p_school_id
    returning trial_ends_at into v_new_date;
  if not found then raise exception 'School not found'; end if;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'extend_trial', p_school_id, jsonb_build_object('extra_days', p_extra_days, 'new_trial_ends_at', v_new_date));
  return v_new_date;
end;
$$;

-- Soft-delete: 30-day recovery window, same pattern as the existing
-- soft-deleted-exam purge (results.mjs's softDeleteExam/purgeExpiredDeletedExams).
create or replace function public.admin_delete_school(p_school_id uuid, p_confirm_name text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select name into v_name from public.schools where id = p_school_id and deleted_at is null;
  if not found then raise exception 'School not found (or already deleted)'; end if;
  if trim(p_confirm_name) <> trim(v_name) then
    raise exception 'Typed name does not match the school name exactly — nothing was deleted.';
  end if;

  update public.schools set deleted_at = now(), deleted_by = auth.uid() where id = p_school_id;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'delete_school', p_school_id, jsonb_build_object('name', v_name, 'recoverable_until', now() + interval '30 days'));
end;
$$;

create or replace function public.admin_restore_school(p_school_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  update public.schools set deleted_at = null, deleted_by = null where id = p_school_id and deleted_at is not null;
  if not found then raise exception 'School not found (or not deleted)'; end if;
  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'restore_school', p_school_id, '{}'::jsonb);
end;
$$;

-- Permanently purges any school whose 30-day recovery window has lapsed —
-- same "sweep" shape as purgeExpiredDeletedExams. Call periodically (or on
-- dashboard load) rather than via a Postgres cron, to match how this
-- codebase already handles this pattern.
create or replace function public.admin_purge_expired_deleted_schools()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  with purged as (
    delete from public.schools
    where deleted_at is not null and deleted_at < now() - interval '30 days'
    returning id
  )
  select count(*) into v_count from purged;
  return v_count;
end;
$$;

-- SMS wallet: manual adjustment (top-up from the school detail screen) and
-- request approve/reject.
create or replace function public.admin_adjust_sms_wallet(p_school_id uuid, p_delta integer, p_note text default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_new_balance integer;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.sms_wallets (school_id, balance) values (p_school_id, greatest(0, p_delta))
    on conflict (school_id) do update set balance = greatest(0, public.sms_wallets.balance + p_delta)
    returning balance into v_new_balance;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'adjust_sms_wallet', p_school_id, jsonb_build_object('delta', p_delta, 'note', p_note, 'new_balance', v_new_balance));
  return v_new_balance;
end;
$$;

create or replace function public.admin_list_sms_requests(p_status text default null)
returns table (
  id uuid, school_id uuid, school_name text, requested_credits integer, amount_paid numeric,
  payment_message text, status text, submitted_by_name text, reviewed_at timestamptz, created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select r.id, r.school_id, s.name, r.requested_credits, r.amount_paid, r.payment_message, r.status,
      p.name, r.reviewed_at, r.created_at
    from public.sms_credit_requests r
    join public.schools s on s.id = r.school_id
    left join public.profiles p on p.id = r.submitted_by
    where p_status is null or p_status = '' or r.status = p_status
    order by r.created_at desc;
end;
$$;

create or replace function public.admin_review_sms_request(p_request_id uuid, p_approve boolean, p_reference text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req public.sms_credit_requests%rowtype;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_req from public.sms_credit_requests where id = p_request_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'This request has already been reviewed.'; end if;

  update public.sms_credit_requests
    set status = case when p_approve then 'approved' else 'rejected' end,
        reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
    where id = p_request_id;

  if p_approve then
    insert into public.sms_wallets (school_id, balance) values (v_req.school_id, v_req.requested_credits)
      on conflict (school_id) do update set balance = public.sms_wallets.balance + v_req.requested_credits;
    insert into public.sms_credit_ledger (school_id, credits, amount_paid, reference, request_id, created_by)
      values (v_req.school_id, v_req.requested_credits, v_req.amount_paid, p_reference, v_req.id, auth.uid());
  end if;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), case when p_approve then 'approve_sms_request' else 'reject_sms_request' end, v_req.school_id,
      jsonb_build_object('request_id', p_request_id, 'credits', v_req.requested_credits, 'note', p_note));
end;
$$;

create or replace function public.admin_list_audit_log(p_limit integer default 200)
returns table (
  id uuid, actor_name text, action text, target_school_name text, details jsonb, created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select a.id, p.name, a.action, s.name, a.details, a.created_at
    from public.admin_audit_log a
    left join public.profiles p on p.id = a.actor
    left join public.schools s on s.id = a.target_school_id
    order by a.created_at desc
    limit coalesce(p_limit, 200);
end;
$$;

-- Called by the admin-impersonate-* Netlify functions (which use the
-- service_role key, so they call this as a normal insert/update — these
-- two are exposed as SQL helpers mainly so the "who/which school/when
-- started/ended" shape stays consistent and is written in one place).
create or replace function public.admin_record_impersonation_start(p_school_id uuid, p_target_profile_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.admin_impersonation_sessions (admin_id, school_id, target_profile_id)
    values (auth.uid(), p_school_id, p_target_profile_id) returning id into v_id;
  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'impersonation_start', p_school_id, jsonb_build_object('session_id', v_id));
  return v_id;
end;
$$;

create or replace function public.admin_record_impersonation_end(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_school_id uuid;
begin
  update public.admin_impersonation_sessions set ended_at = now()
    where id = p_session_id and ended_at is null
    returning school_id into v_school_id;
  if v_school_id is not null then
    insert into public.admin_audit_log (actor, action, target_school_id, details)
      values ((select admin_id from public.admin_impersonation_sessions where id = p_session_id), 'impersonation_end', v_school_id, jsonb_build_object('session_id', p_session_id));
  end if;
end;
$$;

grant execute on function public.admin_dashboard_summary() to authenticated;
grant execute on function public.admin_list_expiring_trials(integer) to authenticated;
grant execute on function public.admin_list_recent_schools(integer) to authenticated;
grant execute on function public.admin_registration_trend(integer) to authenticated;
grant execute on function public.admin_list_schools(text) to authenticated;
grant execute on function public.admin_school_detail(uuid) to authenticated;
grant execute on function public.admin_set_school_lock(uuid, boolean, text) to authenticated;
grant execute on function public.admin_extend_trial(uuid, integer) to authenticated;
grant execute on function public.admin_delete_school(uuid, text) to authenticated;
grant execute on function public.admin_restore_school(uuid) to authenticated;
grant execute on function public.admin_purge_expired_deleted_schools() to authenticated;
grant execute on function public.admin_adjust_sms_wallet(uuid, integer, text) to authenticated;
grant execute on function public.admin_list_sms_requests(text) to authenticated;
grant execute on function public.admin_review_sms_request(uuid, boolean, text, text) to authenticated;
grant execute on function public.admin_list_audit_log(integer) to authenticated;
grant execute on function public.admin_record_impersonation_start(uuid, uuid) to authenticated;
grant execute on function public.admin_record_impersonation_end(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Phone OTP verification (signup + password reset) — see
--    migrations/0042_phone_otps.sql for the full rationale. Server-only
--    table: touched exclusively by send-otp.js/verify-otp.js via the
--    service_role key, so RLS is enabled with zero policies (deny-all).
-- ---------------------------------------------------------------------------
create table public.phone_otps (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  purpose text not null check (purpose in ('signup', 'password_reset')),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_phone_otps_lookup on public.phone_otps(phone, purpose, created_at desc);
alter table public.phone_otps enable row level security;

-- ---------------------------------------------------------------------------
-- 5b. SMS provider credentials (see migrations/0043_sms_platform_config.sql)
--     — moved off Netlify env vars so this app's SMS sending isn't coupled
--     to whichever host happens to run its server code. Single row (id=1),
--     server-only (RLS enabled, zero policies) same as phone_otps above.
-- ---------------------------------------------------------------------------
create table public.sms_platform_config (
  id integer primary key default 1,
  provider text not null default 'africas_talking',
  api_key text,
  username text,
  sender_id text,
  cost_per_sms numeric not null default 0,
  price_per_sms numeric not null default 0,
  updated_at timestamptz not null default now(),
  constraint sms_platform_config_single_row check (id = 1)
);
insert into public.sms_platform_config (id) values (1) on conflict (id) do nothing;

create or replace function public.set_sms_platform_config_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger trg_sms_platform_config_updated_at before update on public.sms_platform_config
  for each row execute function public.set_sms_platform_config_updated_at();

alter table public.sms_platform_config enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Bootstrap the one designated Super Admin account
--    (kinyuadavid2003@gmail.com — created here if it doesn't already exist
--    as an auth user; password intentionally NOT set by SQL — Supabase Auth
--    users must be created via the Auth API/admin client, so this only
--    flips the flag on the profile if that auth user already exists. The
--    accompanying Netlify-side bootstrap, if the user doesn't exist yet, is
--    handled separately — see DEPLOYMENT note in the delivery zip.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where email = 'kinyuadavid2003@gmail.com';
  if v_user_id is not null then
    if exists (select 1 from public.profiles where id = v_user_id) then
      update public.profiles set is_super_admin = true, school_id = null where id = v_user_id;
    else
      insert into public.profiles (id, school_id, name, email, role, is_super_admin, status)
        values (v_user_id, null, 'Super Admin', 'kinyuadavid2003@gmail.com', 'admin', true, 'active');
    end if;
  end if;
end $$;
