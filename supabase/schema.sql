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
  level text,                                  -- 'Pre-Primary' | 'Lower Primary' | 'Upper Primary' | 'Junior Secondary' | null (custom)
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name, level)
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
alter table public.subject_papers add column exam_id uuid references public.exams(id) on delete cascade;
create index idx_subject_papers_exam on public.subject_papers(exam_id);
alter table public.subject_papers add constraint subject_papers_exam_subject_paperno_key unique (exam_id, subject_id, paper_no);

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
begin
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
  on conflict (school_id, name, level) do nothing;

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
    (p_school_id, 'min_subjects_for_ranking', '0')
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
  values (gen_random_uuid(), p_school_id, extract(year from now())::text, 'active')
  on conflict (school_id, name) do nothing
  returning id into v_year_id;

  if v_year_id is not null then
    insert into public.terms (school_id, academic_year_id, name, status) values
      (p_school_id, v_year_id, 'Term 1', 'active'),
      (p_school_id, v_year_id, 'Term 2', 'upcoming'),
      (p_school_id, v_year_id, 'Term 3', 'upcoming')
    on conflict (academic_year_id, name) do nothing;
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
begin
  v_role := public.current_role();
  v_own_student_id := public.current_student_id();
  v_caller_school := public.current_school_id();

  if v_role is null or v_caller_school is null then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;
  if v_role not in ('admin', 'teacher') and (v_role <> 'student' or v_own_student_id is distinct from p_student_id) then
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
           'subject_id', r.subject_id,
           'subject_name', coalesce(s.name, '(deleted)'),
           'score', r.score,
           'grade_label', r.grade_label,
           'points', r.points,
           'remark', r.remark
         ) order by s.name), '[]'::jsonb),
         coalesce(sum(r.score), 0),
         count(r.score)
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

  -- Class-wide ranking by exam total, ties share a rank (same as the ranking
  -- logic teachers see on the broadsheet) — computed here, server-side, so
  -- the caller never sees classmates' individual rows.
  with cohort as (
    select st.id,
           coalesce((select sum(r2.score) from public.results r2
                     where r2.exam_id = p_exam_id and r2.student_id = st.id and r2.school_id = v_caller_school), 0) as total
    from public.students st
    where st.class_id = v_student.class_id and st.status = 'active' and st.school_id = v_caller_school
  ),
  ranked as (
    select id, total, rank() over (order by total desc) as pos
    from cohort
    where total > 0
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
    'exam', jsonb_build_object('name', v_exam.name, 'out_of', v_exam.out_of),
    'session_name', coalesce(v_year.name, ''),
    'term_name', coalesce(v_term.name, ''),
    'subjects', v_subjects,
    'total', v_total,
    'average', v_average,
    'overall_grade', coalesce(v_overall_grade, ''),
    'position', v_position,
    'class_size', coalesce(v_class_size, 0)
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
create unique index idx_tt_entries_unique_stream_slot
  on public.timetable_entries(academic_year_id, term_id, day_of_week, period_index, stream_id);
create unique index idx_tt_entries_unique_staff_slot
  on public.timetable_entries(academic_year_id, term_id, day_of_week, period_index, staff_id) where staff_id is not null;
create unique index idx_tt_entries_unique_room_slot
  on public.timetable_entries(academic_year_id, term_id, day_of_week, period_index, room_id) where room_id is not null;

alter table public.rooms enable row level security;
alter table public.timetable_periods enable row level security;
alter table public.teacher_unavailability enable row level security;
alter table public.timetable_entries enable row level security;

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
