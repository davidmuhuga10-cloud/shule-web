-- ============================================================================
-- Shule — Migration 0003b: Attendance, Messaging log, Parent Portal
-- ============================================================================
-- RUN THIS SECOND, as its own separate query, AFTER 0003a_add_parent_role.sql
-- has already run successfully. (If you run this before 0003a, or paste both
-- files together into one query, you'll hit "ERROR: 55P04: unsafe use of new
-- value 'parent'" — Postgres requires the new enum value from 0003a to be
-- committed on its own before anything can reference it, and the Supabase
-- SQL Editor treats everything pasted into one "Run" as a single transaction.)
--
-- Purely additive — new tables and a couple of extra read-only policies on
-- existing tables. Nothing existing is altered or removed, and every
-- statement here is safe to re-run if it's interrupted partway through.
--
-- Adds:
--   - student_attendance / staff_attendance — daily marking + history
--   - message_logs — a messaging history table, ready for a real SMS
--     provider (see netlify/functions/send-message.js) — logs every send
--     even before a provider is configured, so nothing about the UI/workflow
--     is blocked on getting an SMS account first
--   - parent_links table — a parent account (added by 0003a) can read
--     ONLY their own linked children's student record, results, and
--     attendance; nothing else changes for admin/teacher/student
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. student_attendance
-- ----------------------------------------------------------------------------
create table if not exists public.student_attendance (
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
do $$ begin
  create trigger trg_student_attendance_updated_at before update on public.student_attendance
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_student_attendance_school_id before insert on public.student_attendance
    for each row execute function public.set_school_id();
exception when duplicate_object then null; end $$;
create index if not exists idx_student_attendance_school on public.student_attendance(school_id);
create index if not exists idx_student_attendance_class_date on public.student_attendance(class_id, date);
create index if not exists idx_student_attendance_student on public.student_attendance(student_id);

-- ----------------------------------------------------------------------------
-- 2. staff_attendance
-- ----------------------------------------------------------------------------
create table if not exists public.staff_attendance (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  date date not null,
  status text not null default 'present',
  marked_by uuid references public.staff(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, date),
  constraint staff_attendance_status_check check (status in ('present', 'absent', 'late', 'excused'))
);
do $$ begin
  create trigger trg_staff_attendance_updated_at before update on public.staff_attendance
    for each row execute function public.set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger trg_staff_attendance_school_id before insert on public.staff_attendance
    for each row execute function public.set_school_id();
exception when duplicate_object then null; end $$;
create index if not exists idx_staff_attendance_school on public.staff_attendance(school_id);
create index if not exists idx_staff_attendance_date on public.staff_attendance(date);

-- ----------------------------------------------------------------------------
-- 3. parent_links + current_parent_student_ids()
-- ----------------------------------------------------------------------------
create table if not exists public.parent_links (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  parent_profile_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  relationship text,
  created_at timestamptz not null default now(),
  unique (parent_profile_id, student_id)
);
do $$ begin
  create trigger trg_parent_links_school_id before insert on public.parent_links
    for each row execute function public.set_school_id();
exception when duplicate_object then null; end $$;
create index if not exists idx_parent_links_school on public.parent_links(school_id);
create index if not exists idx_parent_links_parent on public.parent_links(parent_profile_id);
create index if not exists idx_parent_links_student on public.parent_links(student_id);

create or replace function public.current_parent_student_ids()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(student_id), '{}') from public.parent_links where parent_profile_id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- 4. message_logs
-- ----------------------------------------------------------------------------
create table if not exists public.message_logs (
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
do $$ begin
  create trigger trg_message_logs_school_id before insert on public.message_logs
    for each row execute function public.set_school_id();
exception when duplicate_object then null; end $$;
create index if not exists idx_message_logs_school on public.message_logs(school_id);
create index if not exists idx_message_logs_batch on public.message_logs(batch_id);

-- ----------------------------------------------------------------------------
-- 5. Row-Level Security on the four new tables + two extra parent-read
--    policies bolted onto the existing students/results tables (additional
--    PERMISSIVE policies — Postgres OR's these with what's already there
--    from migration 0002, so nothing already granted is narrowed).
-- ----------------------------------------------------------------------------
alter table public.student_attendance enable row level security;
alter table public.staff_attendance enable row level security;
alter table public.parent_links enable row level security;
alter table public.message_logs enable row level security;

drop policy if exists student_attendance_staff_read on public.student_attendance;
drop policy if exists student_attendance_own_read on public.student_attendance;
drop policy if exists student_attendance_parent_read on public.student_attendance;
drop policy if exists student_attendance_staff_write on public.student_attendance;
drop policy if exists student_attendance_staff_update on public.student_attendance;
drop policy if exists student_attendance_admin_delete on public.student_attendance;
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

drop policy if exists staff_attendance_staff_read on public.staff_attendance;
drop policy if exists staff_attendance_staff_write on public.staff_attendance;
drop policy if exists staff_attendance_staff_update on public.staff_attendance;
drop policy if exists staff_attendance_admin_delete on public.staff_attendance;
create policy staff_attendance_staff_read on public.staff_attendance for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy staff_attendance_staff_write on public.staff_attendance for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy staff_attendance_staff_update on public.staff_attendance for update
  using (public.is_staff() and school_id = public.current_school_id());
create policy staff_attendance_admin_delete on public.staff_attendance for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists parent_links_self_read on public.parent_links;
drop policy if exists parent_links_admin_write on public.parent_links;
drop policy if exists parent_links_admin_update on public.parent_links;
drop policy if exists parent_links_admin_delete on public.parent_links;
create policy parent_links_self_read on public.parent_links for select
  using (parent_profile_id = auth.uid() or (public.is_admin() and school_id = public.current_school_id()));
create policy parent_links_admin_write on public.parent_links for insert
  with check (public.is_admin() and school_id = public.current_school_id());
create policy parent_links_admin_update on public.parent_links for update
  using (public.is_admin() and school_id = public.current_school_id());
create policy parent_links_admin_delete on public.parent_links for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists message_logs_staff_read on public.message_logs;
drop policy if exists message_logs_staff_write on public.message_logs;
drop policy if exists message_logs_admin_delete on public.message_logs;
create policy message_logs_staff_read on public.message_logs for select
  using (public.is_staff() and school_id = public.current_school_id());
create policy message_logs_staff_write on public.message_logs for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy message_logs_admin_delete on public.message_logs for delete
  using (public.is_admin() and school_id = public.current_school_id());

drop policy if exists students_parent_read on public.students;
create policy students_parent_read on public.students for select
  using (public.current_role() = 'parent' and id = any(public.current_parent_student_ids()) and school_id = public.current_school_id());

drop policy if exists results_parent_read on public.results;
create policy results_parent_read on public.results for select
  using (public.current_role() = 'parent' and student_id = any(public.current_parent_student_ids()) and school_id = public.current_school_id());

-- ----------------------------------------------------------------------------
-- 6. get_report_card(): extend authorization to a parent viewing their own
--    linked child's card. Identical logic otherwise.
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

do $$ begin
  raise notice '=====================================================================';
  raise notice 'Migration 0003 complete: attendance, messaging log, and parent portal';
  raise notice 'are live. Use "Provision Parent Login" in the admin app to create your';
  raise notice 'first parent account and link it to a student.';
  raise notice '=====================================================================';
end $$;
