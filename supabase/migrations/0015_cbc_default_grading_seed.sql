-- ============================================================================
-- 0015_cbc_default_grading_seed.sql — Round 3 §8: "Do not auto-set a grading
-- scale for a school... The default grading scale should be CBC, not the
-- current 8-4-4 default... The CBC scale should already exist in the
-- system, ready to use — replace the current 'Add' button with 'Activate'."
--
-- Re-defines seed_school_defaults() — the RPC school-seed.js calls right
-- after a new school signs up — so it no longer creates an 8-4-4
-- letter-grade scale (A/A-/B+/.../E) and immediately marks it as_default
-- with nobody having chosen it. It now seeds the CBC competency scale
-- instead (present, ready to use), but leaves it NOT default — an admin
-- must explicitly click "Activate" (src/lib/api/grading.mjs's
-- loadCbcCompetencyScale(), also updated this round to promote the scale to
-- default in that same click) before it actually governs grading. A
-- companion change to publishExam() (src/lib/api/results.mjs) separately
-- refuses to publish a class's results at all until some grading scale is
-- active, so a new school can never silently publish un-graded reports.
--
-- IMPORTANT — this is NOT retroactive: it only changes what a BRAND-NEW
-- school gets from this point on. Every school that already exists keeps
-- whatever grading scale(s) it already has, completely untouched — nothing
-- here deletes, renames, or demotes an existing school's current default
-- scale, even if it happens to still be named "Default Grading Scale".
--
-- Safe to re-run.
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
