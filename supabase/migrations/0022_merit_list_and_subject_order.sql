-- ============================================================================
-- 0022_merit_list_and_subject_order.sql — Round 2 §1/§2:
--
--   §1 "Merit List — Toggle for Showing Papers Separately": a checkbox under
--   Settings/Permissions, "Show subject papers separately on Merit List",
--   defaulting to TICKED (on) for every newly created school. When off, a
--   subject's papers combine into a single column on the Mark List instead
--   of showing each paper separately.
--
--   §2 "Custom Subject Ordering on Mark List": a setting that lets a school
--   choose the order subjects appear in on the Mark List, instead of a
--   fixed system order.
--
-- Both are plain `settings` key/value rows (public.settings already exists,
-- 0001-era) — no new tables needed. This migration only needs to:
--   1. Re-create seed_school_defaults() so it seeds 'show_papers_separately'
--      = 'true' for every NEW school going forward (the settings.mjs
--      comment on this key explains why 'true', not the usual 'false',
--      is the default here).
--   2. Backfill 'show_papers_separately' = 'true' for every EXISTING
--      school, so the setting is explicitly present rather than relying on
--      "missing key treated as true" in application code indefinitely.
--
-- use_custom_subject_order and subject_order are NOT backfilled/seeded —
-- both are meant to start absent/off (a school opts in explicitly and picks
-- its own order when it does), exactly like every other off-by-default
-- Permissions toggle already in this app.
--
-- Safe to paste as a single script. Idempotent — re-running this after it
-- already applied is a no-op (CREATE OR REPLACE FUNCTION, and the backfill
-- insert is ON CONFLICT DO NOTHING).
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
    -- Round 2 §1: unlike every other toggle here, this one defaults ON for
    -- a brand-new school — see the comment on this key in settings.mjs.
    (p_school_id, 'show_papers_separately', 'true')
  on conflict (school_id, key) do nothing;

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

-- Backfill for schools that already existed before this migration ran —
-- explicitly ON, matching the intended default, rather than leaving it to
-- "a missing key means true" logic in the app forever.
insert into public.settings (school_id, key, value)
select id, 'show_papers_separately', 'true' from public.schools
on conflict (school_id, key) do nothing;
