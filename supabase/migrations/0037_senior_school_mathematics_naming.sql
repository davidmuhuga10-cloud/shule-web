-- ============================================================================
-- 0037_senior_school_mathematics_naming.sql
-- ----------------------------------------------------------------------------
-- SignUp_Fixes §3 (CORRECTION): there is no single generic "Mathematics" (or
-- "Advanced Mathematics") subject at Senior School level. Per KICD guidance,
-- Mathematics splits into two distinct, correctly-named subjects by pathway:
--   - "Core Mathematics"      — STEM pathway
--   - "Essential Mathematics" — Social Sciences AND Arts and Sports Science
-- These are two separate subjects, not one subject with a difficulty label.
--
-- This migration does three things:
--   1. Widens subjects' uniqueness so the same subject NAME can exist twice
--      at the same level under two different pathways — needed because
--      "Essential Mathematics" is one name shared by two different pathways.
--      The old unique index was (school_id, name, level); this replaces it
--      with (school_id, name, level, pathway).
--   2. Replaces seed_school_defaults() so every NEW senior school gets the
--      correct subject names from day one (see also cbcDefaults.mjs, which
--      got the equivalent frontend-side correction in this same fix).
--   3. Fixes any senior school that was already seeded under the old,
--      incorrect naming — renames the STEM "Advanced Mathematics" subject to
--      "Core Mathematics" in place (same id, so existing class/teacher
--      assignments and any recorded results stay attached to it), creates
--      the missing pathway-specific subjects, and re-homes anything still
--      pointing at the old generic "Mathematics" row onto the correct
--      pathway-specific replacement before removing that row. Entirely
--      idempotent — safe to run more than once / against a school that
--      already looks correct.
-- ============================================================================

begin;

-- 1) Widen the uniqueness constraint. -----------------------------------------
drop index if exists public.subjects_school_name_level_key;
create unique index if not exists subjects_school_name_level_pathway_key
  on public.subjects (school_id, name, level, pathway);

-- 2) Rename any existing "Advanced Mathematics" (STEM) -> "Core Mathematics".
update public.subjects
set name = 'Core Mathematics'
where level = 'Senior Secondary' and pathway = 'STEM' and name = 'Advanced Mathematics';

-- 3) Make sure every school that has (or had) a generic Senior Secondary
--    "Mathematics" subject also has the three pathway-specific subjects it
--    should have had all along.
insert into public.subjects (school_id, name, level, pathway, code, description)
select distinct sub.school_id, names.name, 'Senior Secondary', names.pathway, '', ''
from public.subjects sub
cross join (values
  ('Core Mathematics', 'STEM'),
  ('Essential Mathematics', 'Social Sciences'),
  ('Essential Mathematics', 'Arts and Sports Science')
) as names(name, pathway)
where sub.level = 'Senior Secondary' and sub.pathway is null and sub.name = 'Mathematics'
on conflict (school_id, name, level, pathway) do nothing;

-- 4) Re-home subject_class_assignments off the old generic "Mathematics"
--    subject onto the correct pathway-specific one (a class-wide / no-stream
--    row, with no pathway to go on, falls back to Essential Mathematics /
--    Social Sciences — the more common small-school shape this whole brief
--    is about). Where the target subject is ALREADY assigned to that same
--    class/stream (e.g. a STEM stream that had both the generic subject and
--    its own "Advanced Mathematics"/now "Core Mathematics"), drop the
--    now-duplicate generic-subject row instead of colliding with it.
with generic_math as (
  select id, school_id from public.subjects
  where level = 'Senior Secondary' and pathway is null and name = 'Mathematics'
),
targets as (
  select sca.id as sca_id, sca.class_id, sca.stream_id, sca.school_id,
         coalesce(st.pathway, 'Social Sciences') as target_pathway
  from public.subject_class_assignments sca
  join generic_math g on g.id = sca.subject_id
  left join public.streams st on st.id = sca.stream_id
),
resolved as (
  select t.sca_id, t.class_id, t.stream_id,
         (select sub.id from public.subjects sub
          where sub.school_id = t.school_id and sub.level = 'Senior Secondary'
            and sub.pathway = t.target_pathway
            and sub.name = case when t.target_pathway = 'STEM' then 'Core Mathematics' else 'Essential Mathematics' end
         ) as new_subject_id
  from targets t
)
delete from public.subject_class_assignments sca
using resolved r
where sca.id = r.sca_id
  and exists (
    select 1 from public.subject_class_assignments dup
    where dup.subject_id = r.new_subject_id and dup.class_id = r.class_id
      and dup.stream_id is not distinct from r.stream_id
  );

with generic_math as (
  select id, school_id from public.subjects
  where level = 'Senior Secondary' and pathway is null and name = 'Mathematics'
),
targets as (
  select sca.id as sca_id, sca.class_id, sca.stream_id, sca.school_id,
         coalesce(st.pathway, 'Social Sciences') as target_pathway
  from public.subject_class_assignments sca
  join generic_math g on g.id = sca.subject_id
  left join public.streams st on st.id = sca.stream_id
)
update public.subject_class_assignments sca
set subject_id = (
  select sub.id from public.subjects sub
  where sub.school_id = t.school_id and sub.level = 'Senior Secondary'
    and sub.pathway = t.target_pathway
    and sub.name = case when t.target_pathway = 'STEM' then 'Core Mathematics' else 'Essential Mathematics' end
)
from targets t
where sca.id = t.sca_id;

-- 5) Same re-homing for subject_teacher_assignments, if any exist.
with generic_math as (
  select id, school_id from public.subjects
  where level = 'Senior Secondary' and pathway is null and name = 'Mathematics'
),
targets as (
  select sta.id as sta_id, sta.class_id, sta.stream_id, sta.school_id,
         coalesce(st.pathway, 'Social Sciences') as target_pathway
  from public.subject_teacher_assignments sta
  join generic_math g on g.id = sta.subject_id
  left join public.streams st on st.id = sta.stream_id
),
resolved as (
  select t.sta_id, t.class_id, t.stream_id, t.school_id,
         (select sub.id from public.subjects sub
          where sub.school_id = t.school_id and sub.level = 'Senior Secondary'
            and sub.pathway = t.target_pathway
            and sub.name = case when t.target_pathway = 'STEM' then 'Core Mathematics' else 'Essential Mathematics' end
         ) as new_subject_id
  from targets t
)
delete from public.subject_teacher_assignments sta
using resolved r
where sta.id = r.sta_id
  and exists (
    select 1 from public.subject_teacher_assignments dup
    where dup.subject_id = r.new_subject_id and dup.staff_id = (select staff_id from public.subject_teacher_assignments where id = r.sta_id)
      and dup.class_id = r.class_id and dup.stream_id is not distinct from r.stream_id
  );

with generic_math as (
  select id, school_id from public.subjects
  where level = 'Senior Secondary' and pathway is null and name = 'Mathematics'
),
targets as (
  select sta.id as sta_id, sta.class_id, sta.stream_id, sta.school_id,
         coalesce(st.pathway, 'Social Sciences') as target_pathway
  from public.subject_teacher_assignments sta
  join generic_math g on g.id = sta.subject_id
  left join public.streams st on st.id = sta.stream_id
)
update public.subject_teacher_assignments sta
set subject_id = (
  select sub.id from public.subjects sub
  where sub.school_id = t.school_id and sub.level = 'Senior Secondary'
    and sub.pathway = t.target_pathway
    and sub.name = case when t.target_pathway = 'STEM' then 'Core Mathematics' else 'Essential Mathematics' end
)
from targets t
where sta.id = t.sta_id;

-- 6) Any straggling references in tables with no per-class/stream shape of
--    their own (a specific exam paper, a submitted result, a timetable slot,
--    a subject-combination row) simply follow the subject to its new home —
--    default to Essential Mathematics / Social Sciences, same rule as above.
update public.results r
set subject_id = (
  select sub.id from public.subjects sub
  where sub.school_id = g.school_id and sub.level = 'Senior Secondary'
    and sub.pathway = 'Social Sciences' and sub.name = 'Essential Mathematics'
)
from public.subjects g
where r.subject_id = g.id and g.level = 'Senior Secondary' and g.pathway is null and g.name = 'Mathematics';

update public.subject_papers sp
set subject_id = (
  select sub.id from public.subjects sub
  where sub.school_id = g.school_id and sub.level = 'Senior Secondary'
    and sub.pathway = 'Social Sciences' and sub.name = 'Essential Mathematics'
)
from public.subjects g
where sp.subject_id = g.id and g.level = 'Senior Secondary' and g.pathway is null and g.name = 'Mathematics';

update public.result_submissions rs
set subject_id = (
  select sub.id from public.subjects sub
  where sub.school_id = g.school_id and sub.level = 'Senior Secondary'
    and sub.pathway = 'Social Sciences' and sub.name = 'Essential Mathematics'
)
from public.subjects g
where rs.subject_id = g.id and g.level = 'Senior Secondary' and g.pathway is null and g.name = 'Mathematics';

update public.timetable_entries te
set subject_id = (
  select sub.id from public.subjects sub
  where sub.school_id = g.school_id and sub.level = 'Senior Secondary'
    and sub.pathway = 'Social Sciences' and sub.name = 'Essential Mathematics'
)
from public.subjects g
where te.subject_id = g.id and g.level = 'Senior Secondary' and g.pathway is null and g.name = 'Mathematics';

update public.subject_combination_members scm
set subject_id = (
  select sub.id from public.subjects sub
  where sub.school_id = g.school_id and sub.level = 'Senior Secondary'
    and sub.pathway = 'Social Sciences' and sub.name = 'Essential Mathematics'
)
from public.subjects g
where scm.subject_id = g.id and g.level = 'Senior Secondary' and g.pathway is null and g.name = 'Mathematics';

-- 7) The old generic "Mathematics" row has nothing left pointing at it now
--    — safe to remove.
delete from public.subjects
where level = 'Senior Secondary' and pathway is null and name = 'Mathematics';

-- 8) Replace seed_school_defaults() with the corrected Senior Secondary
--    subject list (Core Mathematics under STEM, Essential Mathematics under
--    both Social Sciences and Arts and Sports Science, no generic
--    Mathematics at Senior Secondary level). The Pri&JSS branch, grading
--    scale, settings, terms, and timetable-constraint seeding are unchanged
--    from 0036_senior_school.sql.
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

  if not exists (select 1 from public.timetable_constraints where school_id = p_school_id and type = 'distribute_doubles') then
    insert into public.timetable_constraints (school_id, type, enabled, config)
    values (p_school_id, 'distribute_doubles', true, '{}'::jsonb);
  end if;
end;
$$;

commit;
