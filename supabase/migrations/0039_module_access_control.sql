-- ============================================================================
-- 0039_module_access_control.sql
-- ----------------------------------------------------------------------------
-- SignUp_Fixes §5 (REDO — "Module Access Should Use Existing Access Control,
-- With Sensible Defaults"): Finance already worked exactly the way the brief
-- asks — hidden from a teacher's sidebar/routes until they're granted
-- 'finance_manage_fees' or 'finance_record_collections' via the existing
-- staff_capabilities grant/revoke mechanism, admin always sees it. That was
-- never a separate toggle, so there was nothing to "redo" there.
--
-- What was missing: a way to go the OTHER direction and explicitly BLOCK a
-- staff member from a module they'd otherwise see by default — e.g. a
-- bursar who should see Finance but nothing else. This widens the SAME
-- staff_capabilities check constraint to accept 'deny_<module>' rows for
-- every module a teacher gets by default (Students, Attendance, Messaging,
-- Exams, Reports, My Timetable — Dashboard and My Profile are never
-- deniable). Presence of a deny_* row for a staff member hides that module's
-- nav entry and blocks the route client-side (see app.js's buildNav()/
-- allowedRoutes() and capabilities.mjs's DENIABLE_MODULES).
-- ============================================================================

begin;

alter table public.staff_capabilities drop constraint staff_capabilities_capability_check;
alter table public.staff_capabilities add constraint staff_capabilities_capability_check
  check (capability in (
    'publish_results', 'finance_manage_fees', 'finance_record_collections',
    'deny_students', 'deny_attendance', 'deny_messaging', 'deny_exams', 'deny_reports', 'deny_timetable'
  ));

commit;
