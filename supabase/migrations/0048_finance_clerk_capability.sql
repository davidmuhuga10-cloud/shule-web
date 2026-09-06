-- ============================================================================
-- 0048_finance_clerk_capability.sql
-- ----------------------------------------------------------------------------
-- Kodi-comparison follow-up: "Finance Clerk" — a teacher whose ENTIRE
-- sidebar becomes Finance's own sections (Dashboard/Collections/Invoicing/
-- Reports/Transport), with nothing else reachable — no general school
-- Dashboard, no Exams, no Students. Widens the same staff_capabilities
-- check constraint 0039_module_access_control.sql widened, same
-- grant/revoke mechanism as every other capability here (see
-- src/lib/api/capabilities.mjs, src/views/staff.mjs's staff-edit modal,
-- src/app.js's NAV.financeOnly/buildNav()/allowedRoutes()/defaultRoute()).
--
-- Deliberately its own single capability rather than requiring an admin to
-- tick all six deny_* boxes from 0039 by hand — see capabilities.mjs's
-- header comment for why that would silently leak a newly-added module
-- into a clerk's nav until someone remembered to also deny it there.
--
-- Independent of finance_manage_fees/finance_record_collections: this flag
-- only shapes what the SIDEBAR looks like. Those two still gate what the
-- clerk can actually do once inside Finance — same as for any bursar today.
-- ============================================================================

begin;

alter table public.staff_capabilities drop constraint staff_capabilities_capability_check;
alter table public.staff_capabilities add constraint staff_capabilities_capability_check
  check (capability in (
    'publish_results', 'finance_manage_fees', 'finance_record_collections', 'finance_clerk',
    'deny_students', 'deny_attendance', 'deny_messaging', 'deny_exams', 'deny_reports', 'deny_timetable'
  ));

commit;
