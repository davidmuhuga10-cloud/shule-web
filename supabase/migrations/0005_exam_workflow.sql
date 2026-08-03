-- ============================================================================
-- Shule — Migration 0005: Exam Workflow Maturity (Phase 2a)
-- ============================================================================
-- Safe to run as ONE query in the Supabase SQL Editor — nothing here adds a
-- new value to an EXISTING enum type (the one thing that forces a migration
-- to be split into separate transactions — see 0003a/0003b's header comment
-- for why), so there's no "unsafe use of new value" hazard to work around.
--
-- What this adds:
--   1. Exam types (Summative / Formative / CAT / Mock).
--   2. Subject papers (e.g. English Paper 1 + Paper 2, weighted into one
--      combined subject score) — opt-in per subject; a subject with no
--      papers configured behaves exactly as before.
--   3. A minimum-subjects-for-ranking rule (a school setting) — a student
--      isn't given a class position until they have a published result in
--      at least that many subjects for the exam.
--   4. The publishing workflow itself: Subject Teacher enters marks (draft)
--      -> submits for approval -> the Class Teacher approves -> someone with
--      the new 'publish_results' capability (or an admin) publishes. Only
--      PUBLISHED results become visible to the student/parent who owns
--      them — staff can always see everything in their own school, exactly
--      as before, so this is purely a new gate on the student/parent side.
--
-- A lightweight capability model is introduced for step 4 (a
-- `staff_capabilities` table + a `class_teacher_staff_id` on `classes`)
-- rather than the fuller generic scoped-grants system PRODUCT_ROADMAP.md's
-- Section 6 originally sketched — see this migration's delivery notes for
-- why: it's the smallest concrete mechanism that actually satisfies "Subject
-- Teacher -> Class Teacher -> Supervisor -> Admin" given this product's real
-- account kinds (admin/teacher/student/parent — there is no separate
-- "Supervisor" login, so that step is filled by an admin or by any teacher
-- explicitly granted the 'publish_results' capability).
--
-- EXISTING DATA: every (exam, class, subject) combination that ALREADY has
-- marks recorded is auto-published by this migration (see step 7) — nothing
-- a student/parent could already see disappears the moment this runs. Only
-- marks entered AFTER today go through the new draft -> ... -> published
-- pipeline.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Exam types
-- ----------------------------------------------------------------------------
alter table public.exams add column if not exists exam_type text not null default 'summative';
do $$ begin
  alter table public.exams add constraint exams_exam_type_check check (exam_type in ('summative', 'formative', 'cat', 'mock'));
exception when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Subject papers (Paper 1 / Paper 2 weighting) — admin-configured per
--    subject; a subject with zero rows here is "single-paper" and works
--    exactly as it always has.
-- ----------------------------------------------------------------------------
create table if not exists public.subject_papers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  name text not null,                          -- e.g. 'Paper 1'
  paper_no int not null default 1,
  weight numeric not null default 1,           -- this paper's share of the combined subject score (papers for one subject should sum to 1)
  out_of numeric not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subject_id, paper_no)
);
create trigger trg_subject_papers_updated_at before update on public.subject_papers
  for each row execute function public.set_updated_at();
create trigger trg_subject_papers_school_id before insert on public.subject_papers
  for each row execute function public.set_school_id();
create index if not exists idx_subject_papers_school on public.subject_papers(school_id);
create index if not exists idx_subject_papers_subject on public.subject_papers(subject_id);

alter table public.subject_papers enable row level security;
drop policy if exists subject_papers_read on public.subject_papers;
create policy subject_papers_read on public.subject_papers for select
  using (school_id = public.current_school_id());
drop policy if exists subject_papers_admin_write on public.subject_papers;
create policy subject_papers_admin_write on public.subject_papers for insert
  with check (public.is_admin() and school_id = public.current_school_id());
drop policy if exists subject_papers_admin_update on public.subject_papers;
create policy subject_papers_admin_update on public.subject_papers for update
  using (public.is_admin() and school_id = public.current_school_id());
drop policy if exists subject_papers_admin_delete on public.subject_papers;
create policy subject_papers_admin_delete on public.subject_papers for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- ----------------------------------------------------------------------------
-- 3. results: add paper_id (which paper this row is, if the subject has any)
--    and class_id (a snapshot of the student's class AT ENTRY TIME — needed
--    so the publish gate below can key off (exam, class, subject) the same
--    way marks are actually entered, and so a student moving classes later
--    doesn't retroactively change what an already-published result belongs
--    to). Replaces the old single unique constraint with two partial ones,
--    since a subject can have some students on a whole-subject mark
--    (paper_id null) and others on a per-paper mark, and either way exactly
--    one row per student per subject per paper (or per subject, if no
--    paper) must exist.
-- ----------------------------------------------------------------------------
alter table public.results add column if not exists paper_id uuid references public.subject_papers(id) on delete set null;
alter table public.results add column if not exists class_id uuid references public.classes(id) on delete set null;

alter table public.results drop constraint if exists results_exam_id_student_id_subject_id_key;
create unique index if not exists idx_results_unique_no_paper on public.results(exam_id, student_id, subject_id) where paper_id is null;
create unique index if not exists idx_results_unique_with_paper on public.results(exam_id, student_id, subject_id, paper_id) where paper_id is not null;

-- ----------------------------------------------------------------------------
-- 4. Capability model (minimal, purpose-built for this phase) + class
--    teacher designation.
-- ----------------------------------------------------------------------------
alter table public.classes add column if not exists class_teacher_staff_id uuid references public.staff(id) on delete set null;

create table if not exists public.staff_capabilities (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  capability text not null,
  created_at timestamptz not null default now(),
  unique (staff_id, capability),
  -- Only one capability is actually wired up to anything yet
  -- ('publish_results' — see the publishing workflow below). Add more
  -- values here as later phases give staff more granular grants (this is
  -- the "capabilities model" PRODUCT_ROADMAP.md Section 6 called for,
  -- deliberately started small and real rather than speculative).
  constraint staff_capabilities_capability_check check (capability in ('publish_results'))
);
create trigger trg_staff_capabilities_school_id before insert on public.staff_capabilities
  for each row execute function public.set_school_id();
create index if not exists idx_staff_capabilities_school on public.staff_capabilities(school_id);
create index if not exists idx_staff_capabilities_staff on public.staff_capabilities(staff_id);

alter table public.staff_capabilities enable row level security;
drop policy if exists staff_capabilities_read on public.staff_capabilities;
create policy staff_capabilities_read on public.staff_capabilities for select
  using (public.is_staff() and school_id = public.current_school_id());
drop policy if exists staff_capabilities_admin_write on public.staff_capabilities;
create policy staff_capabilities_admin_write on public.staff_capabilities for insert
  with check (public.is_admin() and school_id = public.current_school_id());
drop policy if exists staff_capabilities_admin_delete on public.staff_capabilities;
create policy staff_capabilities_admin_delete on public.staff_capabilities for delete
  using (public.is_admin() and school_id = public.current_school_id());

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

-- ----------------------------------------------------------------------------
-- 5. result_submissions — one row per (exam, class, subject); its `status`
--    is the single source of truth for whether a student/parent may see the
--    matching `results` rows. A trigger (not a plain RLS clause) enforces
--    who may move it to each next stage, because the correct check depends
--    on BOTH the old and new status, not just the new row in isolation.
-- ----------------------------------------------------------------------------
create table if not exists public.result_submissions (
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exam_id, class_id, subject_id),
  constraint result_submissions_status_check check (status in ('draft', 'submitted', 'approved', 'published'))
);
create trigger trg_result_submissions_updated_at before update on public.result_submissions
  for each row execute function public.set_updated_at();
create trigger trg_result_submissions_school_id before insert on public.result_submissions
  for each row execute function public.set_school_id();
create index if not exists idx_result_submissions_school on public.result_submissions(school_id);
create index if not exists idx_result_submissions_exam on public.result_submissions(exam_id);

create or replace function public.check_result_submission_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_status text;
begin
  -- No signed-in session (auth.uid() is null) means this write is coming
  -- from a raw SQL Editor/service-role context — e.g. this very migration's
  -- own backfill in step 7 below — not a real user request. Trust it
  -- unconditionally: an anon/authenticated caller always has a resolvable
  -- auth.uid() once signed in, and RLS already blocks a not-signed-in caller
  -- from reaching this trigger in the first place (its INSERT/UPDATE policy
  -- requires is_staff()), so this branch can only ever be hit by a
  -- superuser/service-role connection.
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
      -- Reopening clears the downstream audit trail — a fresh approval and
      -- publish are required again after whatever gets fixed.
      new.approved_by := null; new.approved_at := null;
      new.published_by := null; new.published_at := null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_result_submissions_transition on public.result_submissions;
create trigger trg_result_submissions_transition before insert or update on public.result_submissions
  for each row execute function public.check_result_submission_transition();

-- SECURITY DEFINER so a plain RLS policy on `results` can check publish
-- status without needing the CALLING role (a student/parent) to also have
-- read access to result_submissions itself — same reasoning as
-- current_parent_student_ids() (schema.sql) applies here: a policy's EXISTS
-- subquery against another table is still subject to THAT table's own RLS
-- for the caller, so without this wrapper a student could never satisfy the
-- check at all (result_submissions' own policy only lets staff read it
-- directly).
create or replace function public.is_result_published(p_exam_id uuid, p_class_id uuid, p_subject_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.result_submissions
    where exam_id = p_exam_id and class_id = p_class_id and subject_id = p_subject_id and status = 'published'
  );
$$;

alter table public.result_submissions enable row level security;
drop policy if exists result_submissions_read on public.result_submissions;
create policy result_submissions_read on public.result_submissions for select
  using (public.is_staff() and school_id = public.current_school_id());
drop policy if exists result_submissions_staff_write on public.result_submissions;
create policy result_submissions_staff_write on public.result_submissions for insert
  with check (public.is_staff() and school_id = public.current_school_id());
drop policy if exists result_submissions_staff_update on public.result_submissions;
create policy result_submissions_staff_update on public.result_submissions for update
  using (public.is_staff() and school_id = public.current_school_id());
drop policy if exists result_submissions_admin_delete on public.result_submissions;
create policy result_submissions_admin_delete on public.result_submissions for delete
  using (public.is_admin() and school_id = public.current_school_id());

-- ----------------------------------------------------------------------------
-- 6. The publish gate itself: a student/parent may only read a `results` row
--    once its (exam, class, subject) submission has been published. Staff
--    are completely unaffected — they still see everything in their school,
--    published or not, exactly as before.
-- ----------------------------------------------------------------------------
drop policy if exists results_read on public.results;
create policy results_read on public.results for select
  using (
    (public.is_staff() and school_id = public.current_school_id())
    or (
      student_id = public.current_student_id()
      and school_id = public.current_school_id()
      and public.is_result_published(exam_id, class_id, subject_id)
    )
  );

drop policy if exists results_parent_read on public.results;
create policy results_parent_read on public.results for select
  using (
    public.current_role() = 'parent'
    and student_id = any(public.current_parent_student_ids())
    and school_id = public.current_school_id()
    and public.is_result_published(exam_id, class_id, subject_id)
  );

-- ----------------------------------------------------------------------------
-- 7. Backfill EXISTING data so nothing a student/parent could already see
--    disappears the moment this migration runs.
-- ----------------------------------------------------------------------------
-- Best-effort class_id snapshot: the student's CURRENT class. We have no
-- historical record of what class a student was in when older marks were
-- entered — for every school on this platform so far, no student has
-- changed classes since results were recorded, so this is exact today; a
-- school with genuinely stale historical data could see an old exam's
-- results misattributed to a student's new class after a "move student"
-- action (Phase 2b) — noted here as a known, low-risk limitation.
update public.results r
set class_id = s.class_id
from public.students s
where r.student_id = s.id and r.class_id is null and s.class_id is not null;

insert into public.result_submissions (school_id, exam_id, class_id, subject_id, status, published_at)
select distinct r.school_id, r.exam_id, r.class_id, r.subject_id, 'published', now()
from public.results r
where r.class_id is not null
on conflict (exam_id, class_id, subject_id) do nothing;

-- ----------------------------------------------------------------------------
-- 8. Minimum-subjects-for-ranking setting. Missing/blank/non-numeric reads
--    as 0 ("no rule — rank everyone with a total > 0"), so schools that
--    never touch this keep today's exact ranking behaviour.
-- ----------------------------------------------------------------------------
insert into public.settings (school_id, key, value)
select id, 'min_subjects_for_ranking', '0' from public.schools
on conflict (school_id, key) do nothing;

create or replace function public.seed_school_defaults(p_school_id uuid)
returns void
language plpgsql
security definer
set search_path = public
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
    (80, 100, 'A',  12, 'Excellent'),
    (75, 79,  'A-', 11, 'Excellent'),
    (70, 74,  'B+', 10, 'Very Good'),
    (65, 69,  'B',   9, 'Very Good'),
    (60, 64,  'B-',  8, 'Good'),
    (55, 59,  'C+',  7, 'Good'),
    (50, 54,  'C',   6, 'Credit'),
    (45, 49,  'C-',  5, 'Credit'),
    (40, 44,  'D+',  4, 'Pass'),
    (35, 39,  'D',   3, 'Pass'),
    (30, 34,  'D-',  2, 'Weak'),
    (0,  29,  'E',   1, 'Fail')
  ) as b(min_score, max_score, grade_label, points, remark);

  insert into public.settings (school_id, key, value) values
    (p_school_id, 'school_name', (select name from public.schools where id = p_school_id)),
    (p_school_id, 'school_motto', ''),
    (p_school_id, 'po_box', ''),
    (p_school_id, 'phone', ''),
    (p_school_id, 'email', ''),
    (p_school_id, 'logo', ''),
    (p_school_id, 'min_subjects_for_ranking', '0')
  on conflict (school_id, key) do nothing;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. get_report_card RPC — re-implemented on top of the publish gate + paper
--    weighting + min-subjects-for-ranking rule. Staff (admin/teacher) still
--    see every entered mark when previewing (published or not — useful to
--    check work before publishing); a student/parent only ever sees
--    published subjects. Class ranking is ALWAYS computed from published
--    results only, for every student in the cohort, regardless of who's
--    asking — so a position never depends on what a staff member happens to
--    be mid-editing, and is always a fair, stable, apples-to-apples number.
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
  v_staff_view boolean;
  v_min_subjects int := 0;
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

  select coalesce(nullif(value, '')::int, 0) into v_min_subjects
    from public.settings where school_id = v_caller_school and key = 'min_subjects_for_ranking';
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

  -- Class-wide ranking: always published-only, always subject to the
  -- minimum-subjects-for-ranking rule, regardless of who's asking.
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
    'class_size', coalesce(v_class_size, 0)
  );
end;
$$;

grant execute on function public.get_report_card(uuid, uuid) to authenticated;
grant execute on function public.has_capability(text) to authenticated;
grant execute on function public.is_class_teacher_of(uuid) to authenticated;
grant execute on function public.is_result_published(uuid, uuid, uuid) to authenticated;
