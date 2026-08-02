-- ============================================================================
-- Shule — reference/seed data
-- ============================================================================
-- Run this AFTER schema.sql. Safe to re-run (every insert is guarded).
-- Contains: CBC subject master list, default grading scale + bands, default
-- school settings rows. Does NOT create your admin login — see the bottom of
-- this file for that one manual step (Supabase Auth owns user creation, so it
-- can't be done with a plain INSERT).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- CBC subjects (KICD learning areas, incl. the 2024 Junior Secondary
-- rationalisation to 9 core subjects) — identical list to the Apps Script
-- version's CBC_SUBJECTS, so nothing changes for end users.
-- ----------------------------------------------------------------------------
insert into public.subjects (name, level, code, description) values
  -- Pre-Primary (PP1-PP2)
  ('Language Activities', 'Pre-Primary', '', ''),
  ('Mathematical Activities', 'Pre-Primary', '', ''),
  ('Environmental Activities', 'Pre-Primary', '', ''),
  ('Psychomotor and Creative Activities', 'Pre-Primary', '', ''),
  ('Religious Education Activities', 'Pre-Primary', '', ''),
  -- Lower Primary (Grade 1-3)
  ('Literacy Activities', 'Lower Primary', '', ''),
  ('English Language Activities', 'Lower Primary', '', ''),
  ('Kiswahili Language Activities', 'Lower Primary', '', ''),
  ('Indigenous Language Activities', 'Lower Primary', '', ''),
  ('Mathematical Activities', 'Lower Primary', '', ''),
  ('Environmental Activities', 'Lower Primary', '', ''),
  ('Hygiene and Nutrition Activities', 'Lower Primary', '', ''),
  ('Religious Education', 'Lower Primary', '', ''),
  ('Movement and Creative Activities', 'Lower Primary', '', ''),
  -- Upper Primary (Grade 4-6)
  ('English', 'Upper Primary', '', ''),
  ('Kiswahili', 'Upper Primary', '', ''),
  ('Mathematics', 'Upper Primary', '', ''),
  ('Science and Technology', 'Upper Primary', '', ''),
  ('Social Studies', 'Upper Primary', '', ''),
  ('Religious Education', 'Upper Primary', '', ''),
  ('Agriculture', 'Upper Primary', '', ''),
  ('Home Science', 'Upper Primary', '', ''),
  ('Creative Arts', 'Upper Primary', '', ''),
  ('Physical and Health Education', 'Upper Primary', '', ''),
  -- Junior Secondary (Grade 7-9) — rationalised 2024, 9 core subjects
  ('English', 'Junior Secondary', '', ''),
  ('Kiswahili', 'Junior Secondary', '', ''),
  ('Mathematics', 'Junior Secondary', '', ''),
  ('Integrated Science', 'Junior Secondary', '', ''),
  ('Pre-Technical Studies', 'Junior Secondary', '', ''),
  ('Social Studies', 'Junior Secondary', '', ''),
  ('Agriculture', 'Junior Secondary', '', ''),
  ('Religious Education', 'Junior Secondary', '', ''),
  ('Creative Arts and Sports', 'Junior Secondary', '', '')
on conflict (name, level) do nothing;

-- ----------------------------------------------------------------------------
-- Default grading scale (KCSE-style 12 bands, A-E) — identical to the Apps
-- Script default, editable afterwards in Grading Scales.
-- ----------------------------------------------------------------------------
insert into public.grading_scales (id, name, description, is_default)
select gen_random_uuid(), 'Default Grading Scale',
       'Standard scale — edit the bands to match your school.', true
where not exists (select 1 from public.grading_scales);

insert into public.grade_ranges (grading_scale_id, min_score, max_score, grade_label, points, remark)
select gs.id, b.min_score, b.max_score, b.grade_label, b.points, b.remark
from public.grading_scales gs
cross join (values
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
) as b(min_score, max_score, grade_label, points, remark)
where gs.is_default = true
  and not exists (select 1 from public.grade_ranges where grading_scale_id = gs.id);

-- ----------------------------------------------------------------------------
-- Default school settings rows (same keys the frontend/printouts expect)
-- ----------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('school_name', 'My School'),
  ('school_motto', ''),
  ('po_box', ''),
  ('phone', ''),
  ('email', ''),
  ('logo', '')
on conflict (key) do nothing;

-- ============================================================================
-- Creating your first admin login (one manual step — do this after
-- schema.sql + seed.sql have run):
--
--   1. In the Supabase dashboard: Authentication -> Users -> Add user
--      (email: e.g. admin@yourschool.ac.ke, set a password, "Auto Confirm
--      User" = on). Copy the generated User UID.
--   2. Run this, swapping in that UID and the school admin's name/email:
--
--      insert into public.profiles (id, name, email, role, status)
--      values ('<paste-user-uid-here>', 'Administrator',
--              'admin@yourschool.ac.ke', 'admin', 'active');
--
-- After that you can log in as admin and everything else (staff, teacher and
-- student accounts) is created from inside the app itself, the same as the
-- Apps Script version — see SETUP_GUIDE.md for how student/teacher login
-- provisioning works under Supabase Auth.
-- ============================================================================
