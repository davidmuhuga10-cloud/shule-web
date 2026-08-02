-- ============================================================================
-- Shule — Migration 0002: single-tenant → multi-tenant
-- ============================================================================
-- Run this ONCE, in the Supabase SQL editor, against the project you already
-- deployed (the one with your existing admin login and any data you've
-- already entered). It upgrades your live schema to match the new
-- supabase/schema.sql in place — nothing is deleted, every existing row is
-- kept and assigned to a new "first school" record.
--
-- Safe to run even with zero real data in the tables yet — that IS the
-- situation this migration was written for (per the roadmap's "straightforward
-- case": no school was live on the single-tenant setup at the time this was
-- written, so there's exactly one school to create and one existing admin
-- login to reattach to it).
--
-- BEFORE YOU RUN THIS: take a Supabase dashboard snapshot/backup first
-- (Database -> Backups), the same good habit as before any schema change.
--
-- WHAT TO DO AFTER IT FINISHES: the very last statement below prints the
-- School Code your existing school was given (derived from your school
-- name in Settings, or "myschool" if none was set). Use that exact code in
-- the "School Code" field on the login screen from now on.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. schools table + helpers (safe to run even if a previous partial attempt
--    already created some of these — every create is guarded)
-- ----------------------------------------------------------------------------
create table if not exists public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schools_code_format check (code ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$')
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$ begin
  create trigger trg_schools_updated_at before update on public.schools
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;

create or replace function public.normalize_school_code()
returns trigger language plpgsql as $$
begin new.code := lower(trim(new.code)); return new; end;
$$;

do $$ begin
  create trigger trg_schools_normalize_code before insert or update on public.schools
    for each row execute function public.normalize_school_code();
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 2. Create "the existing school" from whatever is already in `settings`,
--    and remember its id for every backfill step below.
-- ----------------------------------------------------------------------------
do $$
declare
  v_name text;
  v_code text;
  v_school_id uuid;
  v_suffix int := 0;
begin
  -- Only do this once — if a schools row already exists, skip creating another.
  if exists (select 1 from public.schools) then
    raise notice 'schools table already has % row(s) — skipping "first school" creation.', (select count(*) from public.schools);
    return;
  end if;

  select value into v_name from public.settings where key = 'school_name';
  v_name := coalesce(nullif(trim(v_name), ''), 'My School');

  v_code := lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g'));
  v_code := trim(both '-' from v_code);
  if v_code = '' or length(v_code) < 3 then v_code := 'myschool'; end if;
  if length(v_code) > 30 then v_code := substring(v_code from 1 for 30); end if;

  -- Guarantee uniqueness even if, implausibly, that code is already taken.
  while exists (select 1 from public.schools where code = v_code || case when v_suffix = 0 then '' else v_suffix::text end) loop
    v_suffix := v_suffix + 1;
  end loop;
  if v_suffix > 0 then v_code := v_code || v_suffix::text; end if;

  insert into public.schools (name, code) values (v_name, v_code) returning id into v_school_id;
  raise notice 'Created first school: name=%, code=%, id=%', v_name, v_code, v_school_id;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Add school_id (nullable for now) to every tenant table, backfill it to
--    the one school created above (there is only one, so this is safe),
--    then lock it down to NOT NULL + FK.
-- ----------------------------------------------------------------------------
do $$
declare
  v_school_id uuid;
  t text;
  tenant_tables text[] := array[
    'staff', 'academic_years', 'terms', 'classes', 'streams', 'subjects',
    'students', 'profiles', 'subject_class_assignments', 'subject_teacher_assignments',
    'grading_scales', 'grade_ranges', 'exams', 'results', 'settings'
  ];
begin
  select id into v_school_id from public.schools order by created_at asc limit 1;
  if v_school_id is null then
    raise exception 'No school row found — step 2 above must run first.';
  end if;

  foreach t in array tenant_tables loop
    execute format('alter table public.%I add column if not exists school_id uuid', t);
    execute format('update public.%I set school_id = %L where school_id is null', t, v_school_id);
    execute format('alter table public.%I alter column school_id set not null', t);
    -- Add the FK only if it doesn't already exist (re-run safety).
    if not exists (
      select 1 from pg_constraint where conname = t || '_school_id_fkey'
    ) then
      execute format('alter table public.%I add constraint %I foreign key (school_id) references public.schools(id) on delete cascade', t, t || '_school_id_fkey');
    end if;
    execute format('create index if not exists %I on public.%I(school_id)', 'idx_' || t || '_school', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Re-scope uniqueness constraints that used to be global to be per-school.
-- ----------------------------------------------------------------------------
alter table public.classes drop constraint if exists classes_name_key;
create unique index if not exists classes_school_name_key on public.classes(school_id, name);

alter table public.subjects drop constraint if exists subjects_name_level_key;
create unique index if not exists subjects_school_name_level_key on public.subjects(school_id, name, level);

alter table public.academic_years drop constraint if exists academic_years_name_key;
create unique index if not exists academic_years_school_name_key on public.academic_years(school_id, name);

alter table public.students drop constraint if exists students_admission_no_key;
create unique index if not exists students_school_admission_no_key on public.students(school_id, admission_no);

alter table public.staff drop constraint if exists staff_email_key;
create unique index if not exists staff_school_email_key on public.staff(school_id, email);

-- The admission-number sort index needs to be rebuilt scoped by school too.
drop index if exists idx_students_admission_numeric;
create index if not exists idx_students_admission_numeric on public.students (school_id, public.admission_no_numeric(admission_no));

-- ----------------------------------------------------------------------------
-- 5. settings' primary key needs to become (school_id, key) instead of (key)
--    alone, now that every school gets its own settings rows.
-- ----------------------------------------------------------------------------
alter table public.settings drop constraint if exists settings_pkey;
alter table public.settings add primary key (school_id, key);

-- ----------------------------------------------------------------------------
-- 6. Auto-stamp trigger — fills in school_id from the caller's own profile
--    whenever an insert doesn't set it explicitly (which is every existing
--    call site in the frontend, so no application code had to change).
-- ----------------------------------------------------------------------------
create or replace function public.current_school_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select school_id from public.profiles where id = auth.uid();
$$;

create or replace function public.set_school_id()
returns trigger
language plpgsql security definer set search_path = public
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

do $$
declare
  t text;
  tenant_tables text[] := array[
    'staff', 'academic_years', 'terms', 'classes', 'streams', 'subjects',
    'students', 'profiles', 'subject_class_assignments', 'subject_teacher_assignments',
    'grading_scales', 'grade_ranges', 'exams', 'results', 'settings'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_school_id', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.set_school_id()', 'trg_' || t || '_school_id', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Rewrite every RLS policy to add the school_id = current_school_id()
--    boundary. Old policies are dropped first (each drop is a no-op if that
--    policy name doesn't exist), then the full new set from schema.sql is
--    (re)created.
-- ----------------------------------------------------------------------------
alter table public.schools enable row level security;

drop policy if exists schools_self_read on public.schools;
create policy schools_self_read on public.schools for select
  using (id = public.current_school_id());

drop policy if exists profiles_self_read on public.profiles;
drop policy if exists profiles_admin_write on public.profiles;
drop policy if exists profiles_admin_update on public.profiles;
drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_self_read on public.profiles for select
  using (id = auth.uid() or (public.is_admin() and school_id = public.current_school_id()));
create policy profiles_admin_write on public.profiles for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy profiles_admin_update on public.profiles for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy profiles_admin_delete on public.profiles for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists staff_read on public.staff;
drop policy if exists staff_admin_write on public.staff;
drop policy if exists staff_admin_update on public.staff;
drop policy if exists staff_admin_delete on public.staff;
create policy staff_read on public.staff for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy staff_admin_write on public.staff for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy staff_admin_update on public.staff for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy staff_admin_delete on public.staff for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists academic_years_read on public.academic_years;
drop policy if exists academic_years_admin_write on public.academic_years;
drop policy if exists academic_years_admin_update on public.academic_years;
drop policy if exists academic_years_admin_delete on public.academic_years;
create policy academic_years_read on public.academic_years for select
  using (school_id = public.current_school_id());
create policy academic_years_admin_write on public.academic_years for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy academic_years_admin_update on public.academic_years for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy academic_years_admin_delete on public.academic_years for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists terms_read on public.terms;
drop policy if exists terms_admin_write on public.terms;
drop policy if exists terms_admin_update on public.terms;
drop policy if exists terms_admin_delete on public.terms;
create policy terms_read on public.terms for select
  using (school_id = public.current_school_id());
create policy terms_admin_write on public.terms for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy terms_admin_update on public.terms for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy terms_admin_delete on public.terms for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists classes_read on public.classes;
drop policy if exists classes_admin_write on public.classes;
drop policy if exists classes_admin_update on public.classes;
drop policy if exists classes_admin_delete on public.classes;
create policy classes_read on public.classes for select
  using (school_id = public.current_school_id());
create policy classes_admin_write on public.classes for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy classes_admin_update on public.classes for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy classes_admin_delete on public.classes for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists streams_read on public.streams;
drop policy if exists streams_admin_write on public.streams;
drop policy if exists streams_admin_update on public.streams;
drop policy if exists streams_admin_delete on public.streams;
create policy streams_read on public.streams for select
  using (school_id = public.current_school_id());
create policy streams_admin_write on public.streams for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy streams_admin_update on public.streams for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy streams_admin_delete on public.streams for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists subjects_read on public.subjects;
drop policy if exists subjects_admin_write on public.subjects;
drop policy if exists subjects_admin_update on public.subjects;
drop policy if exists subjects_admin_delete on public.subjects;
create policy subjects_read on public.subjects for select
  using (school_id = public.current_school_id());
create policy subjects_admin_write on public.subjects for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy subjects_admin_update on public.subjects for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy subjects_admin_delete on public.subjects for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists sca_read on public.subject_class_assignments;
drop policy if exists sca_admin_write on public.subject_class_assignments;
drop policy if exists sca_admin_update on public.subject_class_assignments;
drop policy if exists sca_admin_delete on public.subject_class_assignments;
create policy sca_read on public.subject_class_assignments for select
  using (school_id = public.current_school_id());
create policy sca_admin_write on public.subject_class_assignments for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy sca_admin_update on public.subject_class_assignments for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy sca_admin_delete on public.subject_class_assignments for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists sta_read on public.subject_teacher_assignments;
drop policy if exists sta_admin_write on public.subject_teacher_assignments;
drop policy if exists sta_admin_update on public.subject_teacher_assignments;
drop policy if exists sta_admin_delete on public.subject_teacher_assignments;
create policy sta_read on public.subject_teacher_assignments for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy sta_admin_write on public.subject_teacher_assignments for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy sta_admin_update on public.subject_teacher_assignments for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy sta_admin_delete on public.subject_teacher_assignments for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists grading_scales_read on public.grading_scales;
drop policy if exists grading_scales_admin_write on public.grading_scales;
drop policy if exists grading_scales_admin_update on public.grading_scales;
drop policy if exists grading_scales_admin_delete on public.grading_scales;
create policy grading_scales_read on public.grading_scales for select
  using (school_id = public.current_school_id());
create policy grading_scales_admin_write on public.grading_scales for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy grading_scales_admin_update on public.grading_scales for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy grading_scales_admin_delete on public.grading_scales for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists grade_ranges_read on public.grade_ranges;
drop policy if exists grade_ranges_admin_write on public.grade_ranges;
drop policy if exists grade_ranges_admin_update on public.grade_ranges;
drop policy if exists grade_ranges_admin_delete on public.grade_ranges;
create policy grade_ranges_read on public.grade_ranges for select
  using (school_id = public.current_school_id());
create policy grade_ranges_admin_write on public.grade_ranges for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy grade_ranges_admin_update on public.grade_ranges for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy grade_ranges_admin_delete on public.grade_ranges for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists settings_read on public.settings;
drop policy if exists settings_admin_write on public.settings;
drop policy if exists settings_admin_update on public.settings;
drop policy if exists settings_admin_delete on public.settings;
create policy settings_read on public.settings for select
  using (school_id = public.current_school_id());
create policy settings_admin_write on public.settings for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy settings_admin_update on public.settings for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy settings_admin_delete on public.settings for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists students_staff_read on public.students;
drop policy if exists students_staff_write on public.students;
drop policy if exists students_staff_update on public.students;
drop policy if exists students_admin_delete on public.students;
create policy students_staff_read on public.students for select
  using ((public.is_staff() or id = public.current_student_id()) and school_id = public.current_school_id());
create policy students_staff_write on public.students for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy students_staff_update on public.students for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy students_admin_delete on public.students for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists exams_read on public.exams;
drop policy if exists exams_staff_write on public.exams;
drop policy if exists exams_staff_update on public.exams;
drop policy if exists exams_admin_delete on public.exams;
create policy exams_read on public.exams for select
  using (school_id = public.current_school_id());
create policy exams_staff_write on public.exams for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy exams_staff_update on public.exams for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy exams_admin_delete on public.exams for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists results_read on public.results;
drop policy if exists results_staff_write on public.results;
drop policy if exists results_staff_update on public.results;
drop policy if exists results_admin_delete on public.results;
create policy results_read on public.results for select
  using ((public.is_staff() or student_id = public.current_student_id()) and school_id = public.current_school_id());
create policy results_staff_write on public.results for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy results_staff_update on public.results for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy results_admin_delete on public.results for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- ----------------------------------------------------------------------------
-- 8. New RPCs: pre-login school lookup, and new-school default seeding.
-- ----------------------------------------------------------------------------
create or replace function public.get_school_public_info(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = public
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
    'found', true, 'school_id', v_school.id, 'school_code', v_school.code,
    'school_name', v_school.name, 'settings', v_settings
  );
end;
$$;
grant execute on function public.get_school_public_info(text) to anon, authenticated;

create or replace function public.seed_school_defaults(p_school_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_scale_id uuid;
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

  insert into public.grading_scales (id, school_id, name, description, is_default)
  values (gen_random_uuid(), p_school_id, 'Default Grading Scale',
          'Standard scale — edit the bands to match your school.', true)
  returning id into v_scale_id;

  insert into public.grade_ranges (school_id, grading_scale_id, min_score, max_score, grade_label, points, remark)
  select p_school_id, v_scale_id, b.min_score, b.max_score, b.grade_label, b.points, b.remark
  from (values
    (80, 100, 'A',  12, 'Excellent'), (75, 79,  'A-', 11, 'Excellent'),
    (70, 74,  'B+', 10, 'Very Good'), (65, 69,  'B',   9, 'Very Good'),
    (60, 64,  'B-',  8, 'Good'),      (55, 59,  'C+',  7, 'Good'),
    (50, 54,  'C',   6, 'Credit'),    (45, 49,  'C-',  5, 'Credit'),
    (40, 44,  'D+',  4, 'Pass'),      (35, 39,  'D',   3, 'Pass'),
    (30, 34,  'D-',  2, 'Weak'),      (0,  29,  'E',   1, 'Fail')
  ) as b(min_score, max_score, grade_label, points, remark);

  insert into public.settings (school_id, key, value) values
    (p_school_id, 'school_name', (select name from public.schools where id = p_school_id)),
    (p_school_id, 'school_motto', ''), (p_school_id, 'po_box', ''),
    (p_school_id, 'phone', ''), (p_school_id, 'email', ''), (p_school_id, 'logo', '')
  on conflict (school_id, key) do nothing;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. get_report_card(): same logic, now with an explicit school boundary.
-- ----------------------------------------------------------------------------
create or replace function public.get_report_card(p_exam_id uuid, p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
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

-- ----------------------------------------------------------------------------
-- 10. Done — print the School Code so you know what to type on the login
--     screen from now on.
-- ----------------------------------------------------------------------------
do $$
declare v_rec record;
begin
  for v_rec in select name, code from public.schools order by created_at asc limit 1 loop
    raise notice '=====================================================================';
    raise notice 'Migration complete. Your School Code is: %  (school name: %)', v_rec.code, v_rec.name;
    raise notice 'Use this code in the "School Code" field on the Shule login screen.';
    raise notice '=====================================================================';
  end loop;
end $$;
