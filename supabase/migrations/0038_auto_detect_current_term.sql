-- ============================================================================
-- 0038_auto_detect_current_term.sql
-- ----------------------------------------------------------------------------
-- SignUp_Fixes §4 (BUG): creating a new school always assumed Term 1 was
-- current, regardless of the actual date — a school signed up in November
-- still got "Term 1: active, Term 2/3: upcoming". This adds a small, easily
-- updatable reference table of real term date ranges per calendar year, and
-- makes seed_school_defaults() consult it (via current_date) to set each new
-- term's status correctly (active / upcoming / archived) from day one.
--
-- term_date_reference deliberately holds ONLY the current known year's dates
-- (2026) — adding a future year is a plain INSERT, never a function/schema
-- change, e.g.:
--   insert into public.term_date_reference (year, term_name, start_date, end_date) values
--     (2027, 'Term 1', '2027-01-01', '2027-04-25'),
--     (2027, 'Term 2', '2027-04-26', '2027-08-22'),
--     (2027, 'Term 3', '2027-08-23', '2027-12-28');
-- If a school is created for a year with no reference row yet (nobody has
-- added next year's dates), term_status_for() falls back to the original
-- behaviour (Term 1 active, others upcoming) rather than failing.
-- ============================================================================

begin;

create table if not exists public.term_date_reference (
  year int not null,
  term_name text not null check (term_name in ('Term 1', 'Term 2', 'Term 3')),
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  primary key (year, term_name)
);

alter table public.term_date_reference enable row level security;

-- Read-only for any signed-in user (it's just calendar reference data, not
-- school-specific); only migrations/service_role ever write to it.
drop policy if exists term_date_reference_read on public.term_date_reference;
create policy term_date_reference_read on public.term_date_reference
  for select to authenticated using (true);

insert into public.term_date_reference (year, term_name, start_date, end_date) values
  (2026, 'Term 1', '2026-01-01', '2026-04-26'),
  (2026, 'Term 2', '2026-04-27', '2026-08-23'),
  (2026, 'Term 3', '2026-08-24', '2026-12-29')
on conflict (year, term_name) do nothing;

-- Given a year + term name, returns whether that term is 'upcoming' (starts
-- after p_date), 'active' (p_date falls inside its range), or 'archived'
-- (ended before p_date) — with a sensible fallback for a year nobody has
-- configured reference dates for yet.
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

-- Replace seed_school_defaults() to use term_status_for() instead of
-- hardcoding Term 1 as active. Everything else in the function (subjects,
-- grading scale, settings, timetable constraint) is unchanged from
-- 0037_senior_school_mathematics_naming.sql.
create or replace function public.seed_school_defaults(p_school_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scale_id uuid;
  v_year_id uuid;
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
    (p_school_id, 'min_subjects_for_ranking', '0'),
    (p_school_id, 'show_papers_separately', 'true')
  on conflict (school_id, key) do nothing;

  insert into public.academic_years (id, school_id, name, status)
  values (gen_random_uuid(), p_school_id, v_year::text, 'active')
  on conflict (school_id, name) do nothing
  returning id into v_year_id;

  if v_year_id is not null then
    -- SignUp_Fixes §4 (BUG FIX): a new school no longer always gets "Term 1
    -- active" regardless of the real date — each term's status is now
    -- derived from today's date against term_date_reference.
    insert into public.terms (school_id, academic_year_id, name, status) values
      (p_school_id, v_year_id, 'Term 1', public.term_status_for(v_year, 'Term 1')),
      (p_school_id, v_year_id, 'Term 2', public.term_status_for(v_year, 'Term 2')),
      (p_school_id, v_year_id, 'Term 3', public.term_status_for(v_year, 'Term 3'))
    on conflict (academic_year_id, name) do nothing;
  end if;

  if not exists (select 1 from public.timetable_constraints where school_id = p_school_id and type = 'distribute_doubles') then
    insert into public.timetable_constraints (school_id, type, enabled, config)
    values (p_school_id, 'distribute_doubles', true, '{}'::jsonb);
  end if;
end;
$$;

commit;
