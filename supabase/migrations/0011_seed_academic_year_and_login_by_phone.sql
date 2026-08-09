-- ============================================================================
-- Migration 0011 — landing-redesign brief (04 Aug 2026):
--
--  * C2: seed_school_defaults now also creates a default academic year +
--    3 terms for a brand-new school (previously this step was silently
--    missing — admins had to create it by hand every time).
--  * B1: find_login_accounts_by_phone RPC — narrow, anonymous-safe lookup
--    that lets the login screen accept just a phone number and figure out
--    which school(s)/role(s) it belongs to, instead of requiring the School
--    Code to be typed first.
--
-- Safe to re-run: both functions are `create or replace`, and the backfill
-- for existing schools only inserts where a school has zero academic years.
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

-- Backfill: any existing school that has zero academic years (created before
-- this fix existed) gets the same default year + terms retroactively, so
-- admins on already-live schools aren't left stuck on the old broken path.
do $$
declare
  v_school record;
  v_year_id uuid;
begin
  for v_school in
    select s.id from public.schools s
    where not exists (select 1 from public.academic_years y where y.school_id = s.id)
  loop
    insert into public.academic_years (id, school_id, name, status)
    values (gen_random_uuid(), v_school.id, extract(year from now())::text, 'active')
    returning id into v_year_id;

    insert into public.terms (school_id, academic_year_id, name, status) values
      (v_school.id, v_year_id, 'Term 1', 'active'),
      (v_school.id, v_year_id, 'Term 2', 'upcoming'),
      (v_school.id, v_year_id, 'Term 3', 'upcoming');
  end loop;
end;
$$;

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
