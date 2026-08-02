-- ============================================================================
-- Shule — Postgres schema for Supabase
-- ============================================================================
-- Mirrors the proven data model from the Apps Script version (Schema.gs),
-- adapted to Postgres with real foreign keys and Row-Level Security instead
-- of app-level role checks.
--
-- Run this once in the Supabase SQL editor (or via `supabase db push`) on a
-- brand-new project, BEFORE seed.sql.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
create type user_role as enum ('admin', 'teacher', 'student');
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
-- staff
-- ----------------------------------------------------------------------------
create table public.staff (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text unique,
  phone text,
  role text not null default 'teacher',        -- e.g. teacher, admin-staff
  gender gender_t,
  qualifications text,
  employment_start_date date,
  status row_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_staff_updated_at before update on public.staff
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- academic_years (was "sessions")  +  terms
-- ----------------------------------------------------------------------------
create table public.academic_years (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,                   -- e.g. '2026'
  start_date date,
  end_date date,
  status lifecycle_status not null default 'upcoming',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_academic_years_updated_at before update on public.academic_years
  for each row execute function public.set_updated_at();

create table public.terms (
  id uuid primary key default gen_random_uuid(),
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

-- ----------------------------------------------------------------------------
-- classes + streams
-- ----------------------------------------------------------------------------
create table public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,                   -- e.g. 'Grade 7'
  level_order int not null default 0,          -- controls display/sort order
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_classes_updated_at before update on public.classes
  for each row execute function public.set_updated_at();

create table public.streams (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  name text not null,                          -- e.g. 'North'
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, name)
);
create trigger trg_streams_updated_at before update on public.streams
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- subjects (CBC-aware)
-- ----------------------------------------------------------------------------
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  level text,                                  -- 'Pre-Primary' | 'Lower Primary' | 'Upper Primary' | 'Junior Secondary' | null (custom)
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, level)
);
create trigger trg_subjects_updated_at before update on public.subjects
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- students
-- ----------------------------------------------------------------------------
create table public.students (
  id uuid primary key default gen_random_uuid(),
  admission_no text not null unique,
  full_name text not null,
  gender gender_t not null,
  class_id uuid references public.classes(id) on delete set null,
  stream_id uuid references public.streams(id) on delete set null,
  guardian_name text,
  guardian_contact text,
  status row_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_students_updated_at before update on public.students
  for each row execute function public.set_updated_at();

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
create index idx_students_admission_numeric on public.students (public.admission_no_numeric(admission_no));

-- ----------------------------------------------------------------------------
-- profiles — 1:1 with auth.users, carries the app role
-- ----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text,
  role user_role not null default 'student',
  staff_id uuid references public.staff(id) on delete set null,
  student_id uuid references public.students(id) on delete set null,
  status row_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- role/scope helpers — security definer so they can read profiles regardless
-- of the calling row's RLS (avoids recursive-policy problems on profiles itself)
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

create or replace function public.is_admin()
returns boolean language sql stable as $$ select public.current_role() = 'admin' $$;

create or replace function public.is_staff()
returns boolean language sql stable as $$ select public.current_role() in ('admin','teacher') $$;

-- ----------------------------------------------------------------------------
-- subject <-> class assignment (subjects a class offers; streams inherit)
-- ----------------------------------------------------------------------------
create table public.subject_class_assignments (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject_id, class_id)
);
create trigger trg_sca_updated_at before update on public.subject_class_assignments
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- teacher <-> subject/class/stream assignment
-- ----------------------------------------------------------------------------
create table public.subject_teacher_assignments (
  id uuid primary key default gen_random_uuid(),
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

-- ----------------------------------------------------------------------------
-- grading
-- ----------------------------------------------------------------------------
create table public.grading_scales (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_grading_scales_updated_at before update on public.grading_scales
  for each row execute function public.set_updated_at();

create table public.grade_ranges (
  id uuid primary key default gen_random_uuid(),
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

-- ----------------------------------------------------------------------------
-- exams + results
-- ----------------------------------------------------------------------------
create table public.exams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  out_of numeric not null default 100,
  status text not null default 'open',         -- informational only (e.g. 'open'/'closed'); no fixed enum, no logic branches on it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_exams_updated_at before update on public.exams
  for each row execute function public.set_updated_at();

create table public.results (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  academic_year_id uuid references public.academic_years(id) on delete set null,
  term_id uuid references public.terms(id) on delete set null,
  score numeric,
  grade_label text,
  points numeric,
  remark text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exam_id, student_id, subject_id)
);
create trigger trg_results_updated_at before update on public.results
  for each row execute function public.set_updated_at();
create index idx_results_student on public.results(student_id);
create index idx_results_exam on public.results(exam_id);

-- ----------------------------------------------------------------------------
-- settings (key/value, same shape as the Apps Script version)
-- ----------------------------------------------------------------------------
create table public.settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
create trigger trg_settings_updated_at before update on public.settings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row-Level Security
-- ============================================================================
-- Model: admin = full read/write everywhere. teacher = read everything needed
-- to teach (classes/streams/subjects/students/exams), can enter & edit results
-- (no delete). student = read-only, and only their OWN student record + their
-- OWN results; can read classes/subjects/exams metadata needed to render a
-- report card. Nobody but admin touches staff, settings, or structural
-- (classes/subjects/assignments) tables.

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
alter table public.results enable row level security;
alter table public.settings enable row level security;

-- profiles: everyone can read their own; admin can read/manage all
create policy profiles_self_read on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy profiles_admin_write on public.profiles for insert
  with check (public.is_admin());
create policy profiles_admin_update on public.profiles for update
  using (public.is_admin());
create policy profiles_admin_delete on public.profiles for delete
  using (public.is_admin());

-- staff: admin full; teacher can read (for assignment pickers); student none
create policy staff_read on public.staff for select
  using (public.is_staff());
create policy staff_admin_write on public.staff for insert with check (public.is_admin());
create policy staff_admin_update on public.staff for update using (public.is_admin());
create policy staff_admin_delete on public.staff for delete using (public.is_admin());

-- reference/structural data: readable by any authenticated user (students need
-- class/subject names for report cards), writable by admin only
create policy academic_years_read on public.academic_years for select using (auth.uid() is not null);
create policy academic_years_admin_write on public.academic_years for insert with check (public.is_admin());
create policy academic_years_admin_update on public.academic_years for update using (public.is_admin());
create policy academic_years_admin_delete on public.academic_years for delete using (public.is_admin());

create policy terms_read on public.terms for select using (auth.uid() is not null);
create policy terms_admin_write on public.terms for insert with check (public.is_admin());
create policy terms_admin_update on public.terms for update using (public.is_admin());
create policy terms_admin_delete on public.terms for delete using (public.is_admin());

create policy classes_read on public.classes for select using (auth.uid() is not null);
create policy classes_admin_write on public.classes for insert with check (public.is_admin());
create policy classes_admin_update on public.classes for update using (public.is_admin());
create policy classes_admin_delete on public.classes for delete using (public.is_admin());

create policy streams_read on public.streams for select using (auth.uid() is not null);
create policy streams_admin_write on public.streams for insert with check (public.is_admin());
create policy streams_admin_update on public.streams for update using (public.is_admin());
create policy streams_admin_delete on public.streams for delete using (public.is_admin());

create policy subjects_read on public.subjects for select using (auth.uid() is not null);
create policy subjects_admin_write on public.subjects for insert with check (public.is_admin());
create policy subjects_admin_update on public.subjects for update using (public.is_admin());
create policy subjects_admin_delete on public.subjects for delete using (public.is_admin());

create policy sca_read on public.subject_class_assignments for select using (auth.uid() is not null);
create policy sca_admin_write on public.subject_class_assignments for insert with check (public.is_admin());
create policy sca_admin_update on public.subject_class_assignments for update using (public.is_admin());
create policy sca_admin_delete on public.subject_class_assignments for delete using (public.is_admin());

create policy sta_read on public.subject_teacher_assignments for select
  using (public.is_staff());
create policy sta_admin_write on public.subject_teacher_assignments for insert with check (public.is_admin());
create policy sta_admin_update on public.subject_teacher_assignments for update using (public.is_admin());
create policy sta_admin_delete on public.subject_teacher_assignments for delete using (public.is_admin());

create policy grading_scales_read on public.grading_scales for select using (auth.uid() is not null);
create policy grading_scales_admin_write on public.grading_scales for insert with check (public.is_admin());
create policy grading_scales_admin_update on public.grading_scales for update using (public.is_admin());
create policy grading_scales_admin_delete on public.grading_scales for delete using (public.is_admin());

create policy grade_ranges_read on public.grade_ranges for select using (auth.uid() is not null);
create policy grade_ranges_admin_write on public.grade_ranges for insert with check (public.is_admin());
create policy grade_ranges_admin_update on public.grade_ranges for update using (public.is_admin());
create policy grade_ranges_admin_delete on public.grade_ranges for delete using (public.is_admin());

-- Public (even logged-out) read: the login screen shows the school name/logo
-- before anyone signs in. Nothing stored here is sensitive (name, motto,
-- P.O. Box, phone, email, logo) — the same information that would appear on
-- the school's own letterhead or public website.
create policy settings_read on public.settings for select using (true);
create policy settings_admin_write on public.settings for insert with check (public.is_admin());
create policy settings_admin_update on public.settings for update using (public.is_admin());
create policy settings_admin_delete on public.settings for delete using (public.is_admin());

-- students: admin full; teacher read all (+ write, since teachers register
-- students in the original system); student may read only their own row
create policy students_staff_read on public.students for select
  using (public.is_staff() or id = public.current_student_id());
create policy students_staff_write on public.students for insert with check (public.is_staff());
create policy students_staff_update on public.students for update using (public.is_staff());
create policy students_admin_delete on public.students for delete using (public.is_admin());

-- exams: staff read/write; students read (needed to know which exams exist
-- for their report card / mark list views)
create policy exams_read on public.exams for select using (auth.uid() is not null);
create policy exams_staff_write on public.exams for insert with check (public.is_staff());
create policy exams_staff_update on public.exams for update using (public.is_staff());
create policy exams_admin_delete on public.exams for delete using (public.is_admin());

-- results: staff (admin+teacher) can enter/edit; nobody but admin deletes;
-- a student can read only rows that are their own
create policy results_read on public.results for select
  using (public.is_staff() or student_id = public.current_student_id());
create policy results_staff_write on public.results for insert with check (public.is_staff());
create policy results_staff_update on public.results for update using (public.is_staff());
create policy results_admin_delete on public.results for delete using (public.is_admin());

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
-- viewing their own card, nobody else) before doing anything, and only ever
-- returns computed, single-student output — the caller never receives
-- another student's raw score.
create or replace function public.get_report_card(p_exam_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_own_student_id uuid;
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

  if v_role is null then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;
  if v_role not in ('admin', 'teacher') and (v_role <> 'student' or v_own_student_id is distinct from p_student_id) then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;

  select * into v_student from public.students where id = p_student_id;
  if not found then raise exception 'Student not found'; end if;

  select * into v_exam from public.exams where id = p_exam_id;
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
    where r.exam_id = p_exam_id and r.student_id = p_student_id;

  v_average := case when v_count > 0 then round(v_total / v_count, 2) else 0 end;

  select grade_label into v_overall_grade
    from public.grade_ranges gr
    join public.grading_scales gs on gs.id = gr.grading_scale_id and gs.is_default = true
    where v_average >= gr.min_score and v_average <= gr.max_score
    limit 1;

  -- Class-wide ranking by exam total, ties share a rank (same as the ranking
  -- logic teachers see on the broadsheet) — computed here, server-side, so
  -- the caller never sees classmates' individual rows.
  with cohort as (
    select st.id,
           coalesce((select sum(r2.score) from public.results r2
                     where r2.exam_id = p_exam_id and r2.student_id = st.id), 0) as total
    from public.students st
    where st.class_id = v_student.class_id and st.status = 'active'
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
