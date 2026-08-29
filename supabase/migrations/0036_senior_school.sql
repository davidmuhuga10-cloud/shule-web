-- ============================================================================
-- 0036_senior_school.sql
-- ----------------------------------------------------------------------------
-- Next Sprint 3 §1: Senior School (Grade 10-12, CBC, pathway-based: STEM /
-- Social Sciences / Arts and Sports Science) + Form 3/4 (8-4-4 legacy, no
-- pathways) support, alongside the existing Pre-Primary..Junior Secondary
-- (Pri & Jss) structure — chosen once at sign-up via schools.category and
-- never switched afterward. See schema.sql's comments on schools.category,
-- streams.pathway and subjects.pathway for the full reasoning; this
-- migration only needs to ADD those three nullable/defaulted columns (every
-- existing school keeps working exactly as it does today, unaffected) and
-- replace seed_school_defaults() so future signups branch on category.
-- ============================================================================

alter table public.schools
  add column if not exists category text not null default 'pri_jss' check (category in ('pri_jss', 'senior'));

alter table public.streams
  add column if not exists pathway text check (pathway is null or pathway in ('STEM', 'Social Sciences', 'Arts and Sports Science'));

alter table public.subjects
  add column if not exists pathway text check (pathway is null or pathway in ('STEM', 'Social Sciences', 'Arts and Sports Science'));

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
    on conflict (school_id, name, level) do nothing;
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
      (p_school_id, 'Mathematics', 'Senior Secondary', null, '', ''),
      (p_school_id, 'Community Service Learning', 'Senior Secondary', null, '', ''),
      (p_school_id, 'Physics', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Chemistry', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Biology', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Advanced Mathematics', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Computer Studies', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Agriculture', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'Home Science', 'Senior Secondary', 'STEM', '', ''),
      (p_school_id, 'History and Citizenship', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Geography', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Christian Religious Education', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Business Studies', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Literature in English', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Fasihi ya Kiswahili', 'Senior Secondary', 'Social Sciences', '', ''),
      (p_school_id, 'Music and Dance', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Fine Arts', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Theatre and Film', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Sports and Recreation', 'Senior Secondary', 'Arts and Sports Science', '', ''),
      (p_school_id, 'Physical Education', 'Senior Secondary', 'Arts and Sports Science', '', ''),
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
    on conflict (school_id, name, level) do nothing;
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
